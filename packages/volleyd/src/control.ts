import { randomUUID } from "node:crypto";
import { VolleyBroker } from "volley-mcp/broker";
import type { BrokerAuth } from "volley-mcp/config";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { buildTopic, isValidNamespace } from "volley-mcp/topics";
import { randomSuffix } from "volley-mcp/util";
import { authFields, controlAuth } from "./broker-auth";
import { type TimerHandle, systemClock } from "./clock";
import { DAEMON_DEFAULTS } from "./config-defaults";
import type { DecisionPayload } from "./decisions";
import { EXIT, type ExitCode, type IO } from "./io";
import type { PlanDiff } from "./plan-diff";
import type { PathError } from "./schemas";

/**
 * The volleyd control channel. A client sends a mailbox `query` to the daemon
 * (`volley/<ns>/volleyd/mailbox`) with `payload: { op, text, ... }` and a fresh
 * `correlation_id`; the daemon answers on the client's own mailbox with a `type: "ack"`
 * envelope carrying the same `correlation_id` and `payload: { text, acked_type, op, ok, ... }`.
 */

/** The daemon's literal agent id — it is a supervisor, not an MCP session, so no suffix. */
export const DAEMON_AGENT_ID = "volleyd";

export const CONFIG_TOPIC = "volley/_waves/_config";
export const waveStateTopic = (wave: string) => `volley/_waves/${wave}/state`;
export const waveEventsTopic = (wave: string) => `volley/_waves/${wave}/events`;
export const ADMISSION_TOPIC = "volley/_system/admission";
export const leasePoolTopic = (pool: string) => `volley/_system/leases/${pool}`;
export const LEASE_REQUESTS_FILTER = "volley/_system/leases/+/requests";

/** Control ops the daemon answers. */
export type ControlOp =
  | "run"
  | "diff"
  | "status"
  | "config_get"
  | "config_set"
  // Decisions, ownership and operator controls (decisions.ts, ownership.ts, controls.ts).
  | "decisions"
  | "resolve"
  | "claim"
  | "pause"
  | "resume"
  | "stop"
  | "steer"
  // The owner's merge outside GitHub's merge button, verified (pipeline.ts verifyMerge).
  | "merged"
  // Heavy-operation leases and spawn admission (leases.ts, admission.ts).
  | "admission"
  // Spawn one task's agent now (spawn.ts).
  | "spawn"
  // Claude account profiles (claude/service.ts, claude/move.ts).
  | "claude_accounts"
  | "claude_account_add"
  | "claude_signin"
  | "claude_sync"
  | "agent_move_account"
  // Machines + pairing (peers.ts).
  | "peer_invite"
  | "peer_join"
  | "peer_remove"
  | "peers"
  // Fleet (F2): the doctor on a paired machine, for an admin (peers.ts doctor).
  | "peer_doctor";

export interface ControlResponse {
  text: string;
  acked_type: "query";
  op: string;
  ok: boolean;
  error?: string;
  /** Path-qualified validation errors (a rejected wave file). */
  errors?: PathError[];
  result?: unknown;
  /** config_set only (SPEC §4.6.4). */
  applied?: boolean;
  rejected?: PathError[];
  /** Advisory lines for the caller to print (e.g. `run`'s overlap warnings). */
  warnings?: string[];
  /** run (a new version of a submitted wave) and diff: the structural plan change. */
  plan?: { version: number; diff: PlanDiff; unchanged: boolean; decisions?: DecisionPayload[] };
  /** peer_invite / peer_join: the secret, sealed to the request's `reply_key` (peers.ts). */
  sealed?: string;
}

const LIVE_STATUS = new Set(["spawning", "registered", "working"]);

export class NotRunningError extends Error {
  constructor(namespace: string) {
    super(
      `volleyd not running (no live status at ${buildTopic(namespace, DAEMON_AGENT_ID, "status")}); start it with \`volleyd daemon\` or \`volleyd install\``,
    );
    this.name = "NotRunningError";
  }
}

export class ControlTimeoutError extends Error {
  constructor(op: string, ms: number) {
    super(`volleyd did not answer '${op}' within ${ms}ms`);
    this.name = "ControlTimeoutError";
  }
}

/** A transient control client: its own agent id (for the reply mailbox), no LWT, no registry. */
export class ControlClient {
  readonly agentId: string;
  private constructor(
    private readonly broker: VolleyBroker,
    readonly namespace: string,
    agentId: string,
  ) {
    this.agentId = agentId;
  }

  static async connect(
    brokerUrl: string,
    namespace: string,
    auth?: BrokerAuth | null,
  ): Promise<ControlClient> {
    if (!isValidNamespace(namespace)) {
      throw new Error(`namespace "${namespace}" does not match [a-z0-9][a-z0-9_-]{0,62}`);
    }
    const agentId = `volleyd-cli-${randomSuffix(6)}`;
    const broker = new VolleyBroker();
    await broker.connect({ url: brokerUrl, agentId, ...authFields(auth) });
    return new ControlClient(broker, namespace, agentId);
  }

  /** True when the daemon's retained status is live (spawning/registered/working). */
  async daemonRunning(timeoutMs: number = DAEMON_DEFAULTS.probe_ms): Promise<boolean> {
    const raw = await this.broker.queryRetained(
      buildTopic(this.namespace, DAEMON_AGENT_ID, "status"),
      timeoutMs,
    );
    const env = raw === null ? null : parseEnvelope(raw);
    return env !== null && LIVE_STATUS.has(env.type);
  }

  /**
   * Send one control request and wait for the correlated answer. Throws NotRunningError when the
   * daemon has no live status (fast — no request is sent) and ControlTimeoutError on no answer.
   */
  async request(
    op: ControlOp,
    fields: Record<string, unknown>,
    opts: { text?: string; timeoutMs?: number } = {},
  ): Promise<ControlResponse> {
    if (!(await this.daemonRunning())) throw new NotRunningError(this.namespace);
    const timeoutMs = opts.timeoutMs ?? DAEMON_DEFAULTS.request_timeout_ms;
    const correlationId = randomUUID();
    let resolveReply!: (r: ControlResponse) => void;
    const reply = new Promise<ControlResponse>((r) => {
      resolveReply = r;
    });
    const unsubscribe = await this.broker.subscribeStream(
      buildTopic(this.namespace, this.agentId, "mailbox"),
      ({ payload }) => {
        const env = parseEnvelope(payload);
        // SPEC §4.4: only the recipient (the daemon) may ack; anyone can write our mailbox.
        if (
          env?.type === "ack" &&
          env.correlation_id === correlationId &&
          env.agent_id === DAEMON_AGENT_ID
        ) {
          resolveReply(env.payload as ControlResponse);
        }
      },
    );
    let timer: TimerHandle | undefined;
    try {
      const request = buildEnvelope({
        agentId: this.agentId,
        parentId: null,
        channel: "mailbox",
        type: "query",
        correlationId,
        payload: { op, text: opts.text ?? `volleyd ${op}`, ...fields },
      });
      await this.broker.publish(
        buildTopic(this.namespace, DAEMON_AGENT_ID, "mailbox"),
        JSON.stringify(request),
        { qos: 1, retain: false },
      );
      return await Promise.race([
        reply,
        new Promise<never>((_, reject) => {
          // real clock: the CLI's own request timeout, in the CLI process
          timer = systemClock.setTimeout(
            () => reject(new ControlTimeoutError(op, timeoutMs)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      // real clock: the CLI's own request timeout, in the CLI process
      systemClock.clearTimeout(timer);
      await unsubscribe();
    }
  }

  /** Every retained registry entry (raw payloads), for caller auto-detection. */
  async readRegistry(timeoutMs: number = DAEMON_DEFAULTS.registry_scan_ms): Promise<string[]> {
    const msgs = await this.broker.subscribeCollect(
      "volley/_system/registry/+",
      Number.POSITIVE_INFINITY,
      timeoutMs,
    );
    return msgs.map((m) => m.payload).filter((p) => p !== "");
  }

  /** The type of every retained `status` in this namespace, by agent id (owner auto-detection). */
  async readStatuses(
    timeoutMs: number = DAEMON_DEFAULTS.registry_scan_ms,
  ): Promise<Map<string, string>> {
    const msgs = await this.broker.subscribeCollect(
      buildTopic(this.namespace, "+", "status"),
      Number.POSITIVE_INFINITY,
      timeoutMs,
    );
    const out = new Map<string, string>();
    for (const m of msgs) {
      const env = m.payload === "" ? null : parseEnvelope(m.payload);
      if (env !== null) out.set(env.agent_id, env.type);
    }
    return out;
  }

  async close(): Promise<void> {
    await this.broker.disconnect();
  }
}

const DEFAULT_BROKER_URL = "mqtt://localhost:1883";

/** Broker URL and namespace: flag > env (VOLLEY_BROKER_URL / VOLLEY_NAMESPACE) > default. */
export function resolveTarget(
  values: { "broker-url"?: string | boolean | undefined; namespace?: string | boolean | undefined },
  env: Record<string, string | undefined>,
): { brokerUrl: string; namespace: string } {
  const flag = (v: string | boolean | undefined) => (typeof v === "string" ? v : undefined);
  const namespace = flag(values.namespace) ?? env.VOLLEY_NAMESPACE ?? "default";
  if (!isValidNamespace(namespace)) {
    throw new Error(`namespace "${namespace}" does not match [a-z0-9][a-z0-9_-]{0,62}`);
  }
  return {
    brokerUrl: flag(values["broker-url"]) ?? env.VOLLEY_BROKER_URL ?? DEFAULT_BROKER_URL,
    namespace,
  };
}

/** Where a control client connects, and as whom. */
export interface ControlTarget {
  brokerUrl: string;
  namespace: string;
  /** The caller's credentials (`controlAuth`); null connects anonymously. */
  auth: BrokerAuth | null;
}

/** `resolveTarget` plus the caller's broker credentials (`controlAuth`), for control commands. */
export function resolveControlTarget(
  values: { "broker-url"?: string | boolean | undefined; namespace?: string | boolean | undefined },
  env: Record<string, string | undefined>,
  cwd: string = process.cwd(),
): ControlTarget {
  return { ...resolveTarget(values, env), auth: controlAuth(env, cwd) };
}

/**
 * Connect a control client, run `fn`, always disconnect. Maps the failure modes to the CLI exit
 * table: broker down / daemon not running → 1, no answer → 124. `prefix` is e.g. `volleyd status`.
 */
export async function withClient(
  target: ControlTarget,
  io: IO,
  prefix: string,
  fn: (client: ControlClient) => Promise<ExitCode>,
): Promise<ExitCode> {
  let client: ControlClient;
  try {
    client = await ControlClient.connect(target.brokerUrl, target.namespace, target.auth);
  } catch (e) {
    io.stderr(`${prefix}: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.ERROR;
  }
  try {
    return await fn(client);
  } catch (e) {
    io.stderr(`${prefix}: ${e instanceof Error ? e.message : String(e)}\n`);
    return e instanceof ControlTimeoutError ? EXIT.TIMEOUT : EXIT.ERROR;
  } finally {
    await client.close();
  }
}
