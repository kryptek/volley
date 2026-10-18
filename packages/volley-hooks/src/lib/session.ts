import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import type { Env } from "./hook-io";
import type { HookIdentity, RegistryRecord } from "./identity";
import { nextSeq, writeFileAtomic } from "./seq";

// volley-mcp/broker pulls in mqtt; it is imported lazily so a hook with no identity
// never pays for loading it.
const loadBroker = () => import("volley-mcp/broker");

export const CONFIG_TOPIC = "volley/_waves/_config";
const CONFIG_TTL_MS = 60_000;
const CONNECT_TIMEOUT_MS = 3000;

export interface SessionDeps {
  /** Injectable for tests. */
  createBroker?: () => VolleyBroker;
}

/** The hooks' persistent-session clientId — distinct from the MCP server's (SPEC §4.4). */
export function hooksClientId(agentId: string): string {
  return `volley-${agentId}-hooks`;
}

/** MQTT 5 by default (session expiry is v5-only); `VOLLEY_HOOKS_MQTT_VERSION=4` for v3.1.1 brokers. */
export function mqttVersion(env: Env): 4 | 5 {
  return env.VOLLEY_HOOKS_MQTT_VERSION === "4" ? 4 : 5;
}

async function connectClean(url: string, agentId: string): Promise<VolleyBroker> {
  const broker = new (await loadBroker()).VolleyBroker();
  await broker.connect({ url, agentId, connectTimeoutMs: CONNECT_TIMEOUT_MS });
  return broker;
}

/** Every retained registry entry (coordinator identity lookup). */
export async function listRegistry(brokerUrl: string): Promise<RegistryRecord[]> {
  const broker = await connectClean(brokerUrl, "volley-hooks");
  try {
    return await broker.subscribeCollect("volley/_system/registry/+", 10_000, 300);
  } finally {
    await broker.disconnect();
  }
}

function positiveInt(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Session expiry for the drain session: `mailbox.session_expiry_s` from the retained
 * supervisor config (one read, cached in `<stateDir>/config.json` for 60 s), else
 * `VOLLEY_SESSION_EXPIRY_S`, else 7 days. Applies to new connections only (SPEC §4.4).
 */
export async function resolveSessionExpiry(
  identity: HookIdentity,
  env: Env,
  opts: { now?: () => number } = {},
): Promise<number> {
  const now = opts.now ?? Date.now;
  const cachePath = join(identity.stateDir, "config.json");
  let fromConfig: number | null = null;
  let cached = false;
  if (existsSync(cachePath)) {
    try {
      const c = JSON.parse(readFileSync(cachePath, "utf-8")) as {
        session_expiry_s: unknown;
        fetched_at: number;
      };
      if (now() - c.fetched_at < CONFIG_TTL_MS) {
        fromConfig = positiveInt(c.session_expiry_s);
        cached = true;
      }
    } catch {
      // unreadable cache: refetch
    }
  }
  if (!cached) {
    const broker = await connectClean(identity.brokerUrl, identity.agentId);
    try {
      const raw = await broker.queryRetained(CONFIG_TOPIC, 300);
      const payload = raw === null ? null : parseEnvelope(raw)?.payload;
      const mailbox = (payload as { mailbox?: { session_expiry_s?: unknown } } | null)?.mailbox;
      fromConfig = positiveInt(mailbox?.session_expiry_s);
    } finally {
      await broker.disconnect();
    }
    writeFileAtomic(
      cachePath,
      `${JSON.stringify({ session_expiry_s: fromConfig, fetched_at: now() })}\n`,
    );
  }
  return (
    fromConfig ??
    positiveInt(env.VOLLEY_SESSION_EXPIRY_S) ??
    (await loadBroker()).DEFAULT_SESSION_EXPIRY_S
  );
}

/**
 * Connect the persistent drain session: clientId `volley-<id>-hooks`, `cleanSession: false`,
 * so the broker queues mailbox messages while no hook is running. The caller MUST hold the
 * drain lock: a second connect with the same clientId would kick this one off.
 */
export async function connectDrain(
  identity: HookIdentity,
  env: Env,
  deps: SessionDeps = {},
): Promise<VolleyBroker> {
  const sessionExpirySeconds = await resolveSessionExpiry(identity, env);
  const broker = deps.createBroker?.() ?? new (await loadBroker()).VolleyBroker();
  await broker.connect({
    url: identity.brokerUrl,
    agentId: identity.agentId,
    clientId: hooksClientId(identity.agentId),
    cleanSession: false,
    sessionExpirySeconds,
    protocolVersion: mqttVersion(env),
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
  });
  return broker;
}

export type ActivityState = "working" | "idle" | "awaiting_input";

/** `.volley/activity.json`: what the last hook saw, so the next one knows to publish `resumed`. */
export interface Activity {
  state: ActivityState;
  at: string;
  hook_event: string;
  /** The last Stop's assistant text (a later idle notification asks the same question). */
  text?: string;
}

export function readActivity(stateDir: string): Activity | null {
  try {
    return JSON.parse(readFileSync(join(stateDir, "activity.json"), "utf-8")) as Activity;
  } catch {
    return null;
  }
}

export function writeActivity(stateDir: string, activity: Activity): void {
  writeFileAtomic(join(stateDir, "activity.json"), `${JSON.stringify(activity)}\n`);
}

/** The cmux workspace ref of the pane this hook runs in (`cmux identify`), if any. */
function cmuxWorkspace(env: Env): string | undefined {
  if (env.CMUX_WORKSPACE_ID === undefined) return undefined;
  try {
    const out = execFileSync(env.CMUX_BUNDLED_CLI_PATH ?? "cmux", ["identify"], {
      encoding: "utf-8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const ref = (JSON.parse(out) as { caller?: { workspace_ref?: unknown } }).caller?.workspace_ref;
    return typeof ref === "string" ? ref : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Coordinator attention fields (SPEC §4.3): `session_url` from `VOLLEY_SESSION_URL` (a hook
 * cannot derive it), `workspace` from `VOLLEY_WORKSPACE` or `cmux identify`. Empty in agent mode.
 */
export function coordinatorFields(
  identity: HookIdentity,
  env: Env,
): { session_url?: string; workspace?: string } {
  if (identity.mode !== "coordinator") return {};
  const fields: { session_url?: string; workspace?: string } = {};
  const url = env.VOLLEY_SESSION_URL;
  if (url !== undefined && URL.canParse(url)) fields.session_url = url;
  const workspace = env.VOLLEY_WORKSPACE ?? cmuxWorkspace(env);
  if (workspace !== undefined && workspace !== "") fields.workspace = workspace;
  return fields;
}

/** One hook invocation's broker connection, speaking as `identity`. */
export class HookSession {
  constructor(
    readonly identity: HookIdentity,
    readonly broker: VolleyBroker,
    readonly hookEvent: string,
    private readonly onClose: () => void = () => {},
  ) {}

  topic(channel: string, agentId = this.identity.agentId): string {
    return buildTopic(this.identity.namespace, agentId, channel);
  }

  async publish(
    topic: string,
    channel: string,
    type: string,
    payload: unknown,
    opts: {
      qos: 0 | 1;
      retain: boolean;
      correlationId?: string;
      namespace?: string;
      parentId?: string | null;
    },
  ): Promise<void> {
    const envelope = {
      ...buildEnvelope({
        agentId: this.identity.agentId,
        parentId: opts.parentId !== undefined ? opts.parentId : this.identity.parentId,
        channel,
        type,
        payload,
        correlationId: opts.correlationId ?? null,
      }),
      ...(opts.namespace !== undefined ? { namespace: opts.namespace } : {}),
    };
    await this.broker.publish(topic, JSON.stringify(envelope), {
      qos: opts.qos,
      retain: opts.retain,
    });
  }

  /** A hook activity event (SPEC §4.3): `source`, a fresh `seq` and `hook_event` added. */
  async progress(type: string, payload: Record<string, unknown> = {}): Promise<void> {
    const seq = await nextSeq(this.identity.stateDir);
    await this.publish(
      this.topic("progress"),
      "progress",
      type,
      { ...payload, source: "harness-hook", seq, hook_event: this.hookEvent },
      { qos: 0, retain: false },
    );
  }

  /**
   * Re-publish the retained registry entry (SPEC §6) with the harness-reported model. Keeps
   * every field of the current entry; `model` undefined keeps the last known model and marks
   * the source `unknown`. Creates the entry when the MCP server has not registered yet.
   */
  async republishRegistry(model: string | undefined, extra: Record<string, unknown> = {}) {
    const topic = registryTopic(this.identity.agentId);
    const raw = await this.broker.queryRetained(topic, 300);
    const prev = raw === null ? null : parseEnvelope(raw);
    const p = (prev?.payload ?? {}) as Record<string, unknown>;
    const payload: Record<string, unknown> = {
      ...p,
      capabilities: Array.isArray(p.capabilities) ? p.capabilities : [],
      cwd: typeof p.cwd === "string" ? p.cwd : this.identity.projectDir,
      started_at: typeof p.started_at === "string" ? p.started_at : new Date().toISOString(),
      ...(model !== undefined ? { model } : {}),
      model_source: model !== undefined ? "harness-hook" : "unknown",
      ...extra,
    };
    await this.publish(topic, "_system/registry", "registered", payload, {
      qos: 1,
      retain: true,
      namespace: this.identity.namespace,
      parentId: prev !== null ? prev.parent_id : this.identity.parentId,
    });
  }

  heartbeat(): Promise<void> {
    return this.progress("heartbeat");
  }

  async close(): Promise<void> {
    try {
      await this.broker.disconnect();
    } finally {
      this.onClose();
    }
  }
}

/** A clean (non-persistent) session for hooks that do not drain. */
export async function openSession(identity: HookIdentity, hookEvent: string): Promise<HookSession> {
  return new HookSession(
    identity,
    await connectClean(identity.brokerUrl, identity.agentId),
    hookEvent,
  );
}
