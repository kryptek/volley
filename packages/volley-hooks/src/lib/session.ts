import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { BrokerConnectOptions, VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import { type ConnectTarget, clearHooksError, connectOpts } from "./auth";
import type { Env } from "./hook-io";
import {
  type HookIdentity,
  type RegistryCandidate,
  coordinatorStateDir,
  registryCandidates,
} from "./identity";
import { nextSeq, writeFileAtomic } from "./seq";

// volley-mcp/broker pulls in mqtt; it is imported lazily so a hook with no identity
// never pays for loading it.
const loadBroker = () => import("volley-mcp/broker");

export const CONFIG_TOPIC = "volley/_waves/_config";
const CONFIG_TTL_MS = 60_000;

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

/**
 * Every broker connection the hooks open goes through here: credentials resolved for `target`
 * (auth.ts), and a successful connect clears `<stateDir>/hooks-error.json`. A refused CONNACK
 * rejects with `VolleyError` `AUTH_FAILED` (runHook makes it loud).
 */
export async function connectBroker(
  target: ConnectTarget,
  env: Env,
  extra: Partial<BrokerConnectOptions> = {},
  broker?: VolleyBroker,
): Promise<VolleyBroker> {
  const b = broker ?? new (await loadBroker()).VolleyBroker();
  await b.connect(connectOpts(target, env, extra));
  clearHooksError(target.stateDir);
  return b;
}

/**
 * Coordinator identity lookup: the retained registry entries whose cwd is `dir`, newest
 * first, each with its retained status type. The registry is read until it goes quiet
 * (not for a fixed total), so a large or remote registry is read in full.
 */
export async function lookupRegistry(
  brokerUrl: string,
  dir: string,
  env: Env,
): Promise<RegistryCandidate[]> {
  const target = {
    mode: "coordinator" as const,
    projectDir: dir,
    brokerUrl,
    agentId: "volley-hooks",
    stateDir: coordinatorStateDir(dir, env),
  };
  const broker = await connectBroker(target, env);
  try {
    const records = await broker.drainQueued("volley/_system/registry/+", {
      idleMs: 150,
      maxWaitMs: 3000,
    });
    const candidates = registryCandidates(records, dir);
    await Promise.all(
      candidates.map(async (c) => {
        const raw = await broker.queryRetained(buildTopic(c.namespace, c.agentId, "status"), 300);
        c.status = raw === null ? null : (parseEnvelope(raw)?.type ?? null);
      }),
    );
    return candidates;
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
    const broker = await connectBroker(identity, env);
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
  return connectBroker(
    identity,
    env,
    {
      clientId: hooksClientId(identity.agentId),
      cleanSession: false,
      sessionExpirySeconds,
      protocolVersion: mqttVersion(env),
    },
    deps.createBroker?.(),
  );
}

export type ActivityState = "working" | "idle" | "awaiting_input";

/** `.volley/activity.json`: what the last hook saw, so the next one knows to publish `resumed`. */
export interface Activity {
  state: ActivityState;
  at: string;
  hook_event: string;
  /** The question the last Stop ended on (a later idle notification asks the same one). */
  question?: string;
  /**
   * The last Stop ended the turn with a background task still running (Stop's
   * `background_tasks`): the session idles waiting on that task's events, not on a person.
   * Cleared when the session works again.
   */
  background_wait?: boolean;
}

/** Background task states that are over; anything else (or no status) is still running. */
const FINISHED_TASK =
  /^(completed|complete|done|finished|failed|killed|cancell?ed|exited|stopped)$/i;

/**
 * Whether Stop's `background_tasks` input lists a task still running: the list of task
 * objects (`{ id, command, status }`, as `test/fixtures/stop-background-tasks.json`
 * records it), where one whose `status` is over does not count. Any other shape is no wait.
 */
export function hasLiveBackgroundTask(tasks: unknown): boolean {
  if (!Array.isArray(tasks)) return false;
  return tasks.some((t) => {
    if (t === null || typeof t !== "object") return false;
    const status = (t as Record<string, unknown>).status;
    return typeof status !== "string" || !FINISHED_TASK.test(status);
  });
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

/** How often a drain hook checks that the registry still carries the harness model. */
const MODEL_CHECK_MS = 30_000;

interface HarnessModel {
  model: string;
  checked_at?: number;
}

const modelPath = (stateDir: string) => join(stateDir, "model.json");

/** Remember the harness-reported model (SessionStart / PostModelSwitch), or forget it. */
export function writeHarnessModel(stateDir: string, model: string | undefined): void {
  if (model === undefined) {
    rmSync(modelPath(stateDir), { force: true });
    return;
  }
  writeFileAtomic(modelPath(stateDir), `${JSON.stringify({ model } satisfies HarnessModel)}\n`);
}

function readHarnessModel(stateDir: string): HarnessModel | null {
  try {
    const m = JSON.parse(readFileSync(modelPath(stateDir), "utf-8")) as HarnessModel;
    return typeof m.model === "string" && m.model !== "" ? m : null;
  } catch {
    return null;
  }
}

/**
 * The MCP server's own register (its startup auto-register, or the agent's `vol_register`)
 * replaces the whole registry entry and drops the harness model. At most every 30 s, put it
 * back when the retained entry no longer carries it.
 */
export async function ensureHarnessModel(
  session: HookSession,
  now: () => number = Date.now,
): Promise<void> {
  const { stateDir } = session.identity;
  const known = readHarnessModel(stateDir);
  if (known === null) return;
  if (known.checked_at !== undefined && now() - known.checked_at < MODEL_CHECK_MS) return;
  const raw = await session.broker.queryRetained(registryTopic(session.identity.agentId), 300);
  const p = (raw === null ? null : parseEnvelope(raw)?.payload) as Record<string, unknown> | null;
  if (p?.model !== known.model || p?.model_source !== "harness-hook") {
    await session.republishRegistry(known.model);
  }
  writeFileAtomic(
    modelPath(stateDir),
    `${JSON.stringify({ model: known.model, checked_at: now() } satisfies HarnessModel)}\n`,
  );
}

/**
 * The cmux workspace ref of the pane this hook runs in (`cmux identify`), if any.
 *
 * The one child process the hooks start. It runs outside volleyd's authority fence on purpose:
 * the hooks are the agent's own harness (not the supervisor), the call is read-only, and its
 * binary is cmux's own CMUX_BUNDLED_CLI_PATH (set by cmux in the pane's environment) or `cmux`
 * on PATH. Bounded by a 1 s timeout; any failure just leaves the workspace unknown.
 */
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

  close(): Promise<void> {
    return this.broker.disconnect();
  }
}

/** A clean (non-persistent) session for hooks that do not drain. */
export async function openSession(
  identity: HookIdentity,
  hookEvent: string,
  env: Env,
): Promise<HookSession> {
  return new HookSession(identity, await connectBroker(identity, env), hookEvent);
}
