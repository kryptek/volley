import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { VolleyBroker } from "volley-mcp/broker";
import { type BrokerAuth, loadConfig } from "volley-mcp/config";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { isValidAgentId } from "volley-mcp/topics";
import { randomSuffix } from "volley-mcp/util";
import { parsePositiveInt, resolveAuth, resolveBrokerUrl } from "../args";
import { connectAsClient } from "../connect";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";

export interface LeaseArgs {
  argv: string[];
  env: Record<string, string | undefined>;
  io: IO;
}

/**
 * `volley lease`: heavy-operation leases from the volleyd supervisor (SPEC §4.6.5). An agent asks
 * on `volley/_system/leases/<pool>/requests` and watches the retained pool state at
 * `volley/_system/leases/<pool>` until its `lease_id` is in `held`.
 */

const CONFIG_TOPIC = "volley/_waves/_config";
const LIVE = new Set(["spawning", "registered", "working"]);
const poolTopic = (pool: string) => `volley/_system/leases/${pool}`;

/** SPEC §4.6.5: re-send `acquire` when the lease is in neither `held` nor `queue` after 30 s. */
const RESEND_MS = 30_000;
/** How long retained supervisor state (config, status) may take to arrive. */
const PROBE_MS = 500;
/** How long `release` waits to see the lease leave the pool state. */
const RELEASE_CONFIRM_MS = 5_000;

const LEASE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

interface PoolState {
  pool: string;
  capacity: number;
  held: { lease_id: string; holder: string; since: string; ttl_s: number }[];
  queue: { lease_id: string; holder: string; since: string }[];
  reasons: string[];
}

const HELP = `Usage:
  volley lease run --pool <pool> [options] -- <command> [args...]
  volley lease acquire --pool <pool> [options]
  volley lease release --pool <pool> --lease-id <id> [--holder <id>]
  volley lease status [--pool <pool>] [--json]

run      Wait for a lease, run the command, release the lease when it exits (or on SIGINT/SIGTERM).
         Prints "lease granted after N s" to stderr; exits with the command's exit code. If no
         volleyd is live, or the pool is not configured, it warns and runs the command unleased.
acquire  Wait for a lease and print {"pool","lease_id","holder","waited_s"}; release it later.
release  Release a held lease, or cancel a queued request.
status   Print every pool's holders, queue and reasons.

Options:
  --pool <pool>          Lease pool name (from volleyd's lease_pools config)
  --ttl <seconds>        Lease TTL (default: the pool's ttl_s); run renews it while the command runs
  --holder <agent-id>    Who holds the lease (default: .volley/agent.json's agent_id, else a random id)
  --lease-id <id>        Lease id (default: <holder>.<random>)
  --timeout <seconds>    Give up waiting after N seconds (exit 124); default: wait as long as it takes
  --project-dir <dir>    Where .volley/agent.json is (identity + broker credentials); default: cwd
  --broker-url <url>     MQTT broker URL (env: VOLLEY_BROKER_URL; default: mqtt://localhost:1883)
  --username <user>      Broker username (env: VOLLEY_AUTH_USERNAME)
  --password <pw>        Broker password (env: VOLLEY_AUTH_PASSWORD)
  --json                 status: print the retained pool payloads as JSON
`;

const OPTIONS = {
  pool: { type: "string" },
  ttl: { type: "string" },
  holder: { type: "string" },
  "lease-id": { type: "string" },
  timeout: { type: "string" },
  "project-dir": { type: "string" },
  "broker-url": { type: "string" },
  username: { type: "string" },
  password: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

interface Resolved {
  pool: string | undefined;
  ttl: number | undefined;
  holder: string;
  leaseId: string | undefined;
  timeoutMs: number | undefined;
  brokerUrl: string;
  auth: BrokerAuth | null;
  json: boolean;
}

export async function lease({ argv, env, io }: LeaseArgs): Promise<ExitCode> {
  const [action, ...rest] = argv;
  if (action === undefined || action === "--help" || action === "-h") {
    (action === undefined ? io.stderr : io.stdout)(HELP);
    return action === undefined ? EXIT.USAGE : EXIT.OK;
  }
  if (!["run", "acquire", "release", "status"].includes(action)) {
    io.stderr(`volley lease: unknown action: ${action}\n${HELP}`);
    return EXIT.USAGE;
  }

  const sep = rest.indexOf("--");
  const flags = sep === -1 ? rest : rest.slice(0, sep);
  const command = sep === -1 ? [] : rest.slice(sep + 1);
  let r: Resolved;
  try {
    const { values } = parseArgs({ args: flags, options: OPTIONS, strict: true });
    if (values.help === true) {
      io.stdout(HELP);
      return EXIT.OK;
    }
    r = resolve(values, env);
  } catch (e) {
    io.stderr(`volley lease ${action}: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.USAGE;
  }
  if (action !== "status" && r.pool === undefined) {
    io.stderr(`volley lease ${action}: --pool is required\n`);
    return EXIT.USAGE;
  }
  if (action === "run" && command.length === 0) {
    io.stderr("volley lease run: missing command after --\n");
    return EXIT.USAGE;
  }
  if (action === "release" && r.leaseId === undefined) {
    io.stderr("volley lease release: --lease-id is required\n");
    return EXIT.USAGE;
  }
  if (action !== "run" && sep !== -1) {
    io.stderr(`volley lease ${action}: unexpected arguments after --\n`);
    return EXIT.USAGE;
  }

  if (action === "run") return run(r as Resolved & { pool: string }, command, io);
  const broker = await connectAsClient(r.brokerUrl, io, r.auth);
  if (broker === null) return EXIT.ERROR;
  try {
    if (action === "status") return await status(broker, r, io);
    if (action === "release") {
      return await releaseCmd(broker, r as Resolved & { pool: string; leaseId: string }, io);
    }
    return await acquireCmd(broker, r as Resolved & { pool: string }, io);
  } finally {
    await broker.disconnect();
  }
}

function resolve(
  values: { [K in keyof typeof OPTIONS]?: string | boolean | undefined },
  env: Record<string, string | undefined>,
): Resolved {
  const str = (v: string | boolean | undefined) => (typeof v === "string" ? v : undefined);
  const pool = str(values.pool);
  if (pool !== undefined && !isValidAgentId(pool)) {
    throw new Error(`--pool "${pool}" does not match [a-z0-9][a-z0-9_-]{0,62}`);
  }
  const dir = str(values["project-dir"]) ?? process.cwd();
  let holder = str(values.holder);
  if (holder === undefined) {
    try {
      // Only a supervisor-assigned identity is stable enough to hold a lease; otherwise use a
      // fresh id (acquire prints it, so a later release can name it).
      holder = identityAgentId(env, dir) ?? `lease-${randomSuffix(6)}`;
    } catch {
      holder = `lease-${randomSuffix(6)}`;
    }
  }
  if (!isValidAgentId(holder)) {
    throw new Error(`--holder "${holder}" does not match [a-z0-9][a-z0-9_-]{0,62}`);
  }
  const leaseId = str(values["lease-id"]);
  if (leaseId !== undefined && !LEASE_ID.test(leaseId)) {
    throw new Error(`--lease-id "${leaseId}" does not match [A-Za-z0-9][A-Za-z0-9_.-]{0,127}`);
  }
  const ttl = str(values.ttl);
  const timeout = str(values.timeout);
  const ttlS = ttl !== undefined ? parsePositiveInt(ttl, "--ttl") : undefined;
  if (ttlS !== undefined && ttlS > 86400) throw new Error("--ttl must be <= 86400");
  return {
    pool,
    ttl: ttlS,
    holder,
    leaseId,
    timeoutMs: timeout !== undefined ? parsePositiveInt(timeout, "--timeout") * 1000 : undefined,
    brokerUrl: resolveBrokerUrl(str(values["broker-url"]), env),
    auth: resolveAuth({ username: str(values.username), password: str(values.password) }, env, dir),
    json: values.json === true,
  };
}

/** The agent id from `<dir>/.volley/agent.json`, or undefined when there is no such file. */
function identityAgentId(env: Record<string, string | undefined>, dir: string): string | undefined {
  if (!existsSync(join(dir, ".volley", "agent.json"))) return undefined;
  return loadConfig(env, dir).agentId;
}

function parsePool(raw: string): PoolState | null {
  const env = parseEnvelope(raw);
  if (env === null || env.type !== "lease_pool") return null;
  const p = env.payload as PoolState;
  return Array.isArray(p?.held) && Array.isArray(p.queue) ? p : null;
}

async function sendRequest(
  broker: VolleyBroker,
  pool: string,
  payload: {
    op: "acquire" | "release" | "renew";
    lease_id: string;
    holder: string;
    ttl_s?: number;
  },
): Promise<void> {
  const env = buildEnvelope({
    agentId: payload.holder,
    parentId: null,
    channel: "_system/leases/requests",
    type: "lease_request",
    payload,
  });
  await broker.publish(`${poolTopic(pool)}/requests`, JSON.stringify(env), {
    qos: 1,
    retain: false,
  });
}

interface Supervisor {
  live: boolean;
  pools: string[] | null;
}

/** Is a volleyd live in any namespace, and which pools does its retained config define? */
async function probeSupervisor(broker: VolleyBroker): Promise<Supervisor> {
  const [statuses, config] = await Promise.all([
    broker.subscribeCollect("volley/+/volleyd/status", 64, PROBE_MS),
    broker.queryRetained(CONFIG_TOPIC, PROBE_MS),
  ]);
  const live = statuses.some((m) => {
    const env = parseEnvelope(m.payload);
    return env !== null && LIVE.has(env.type);
  });
  const env = config === null ? null : parseEnvelope(config);
  const pools = (env?.payload as { lease_pools?: Record<string, unknown> } | undefined)
    ?.lease_pools;
  return { live, pools: pools !== undefined && pools !== null ? Object.keys(pools) : null };
}

type WaitResult =
  | { kind: "granted"; ttlS: number }
  | { kind: "rejected"; reason: string }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "supervisor-gone" };

/**
 * Send `acquire` and wait until the lease is held. Prints the queue reasons once when queued.
 * Re-sends every 30 s while the lease is in neither `held` nor `queue`; gives up (supervisor
 * gone) if, at a re-send, no volleyd is live.
 */
async function waitForGrant(
  broker: VolleyBroker,
  opts: { pool: string; leaseId: string; holder: string; ttl?: number | undefined },
  io: IO,
  limits: { timeoutMs?: number | undefined; signal: AbortSignal },
): Promise<WaitResult> {
  const { pool, leaseId, holder } = opts;
  let seen = false;
  let toldQueued = false;
  let settle!: (r: WaitResult) => void;
  const done = new Promise<WaitResult>((r) => {
    settle = r;
  });
  const unsubscribe = await broker.subscribeStream(poolTopic(pool), ({ payload }) => {
    const p = parsePool(payload);
    if (p === null) return;
    const held = p.held.find((h) => h.lease_id === leaseId);
    if (held !== undefined) {
      settle({ kind: "granted", ttlS: held.ttl_s });
      return;
    }
    if (p.queue.some((q) => q.lease_id === leaseId)) {
      seen = true;
      if (!toldQueued) {
        toldQueued = true;
        const why = p.reasons.length > 0 ? ` (${p.reasons.join("; ")})` : "";
        io.stderr(`volley lease: queued for a ${pool} lease${why}\n`);
      }
      return;
    }
    const rejected = p.reasons.find((r) => r.startsWith(`rejected ${leaseId}:`));
    if (rejected !== undefined) settle({ kind: "rejected", reason: rejected });
  });
  const acquire = () =>
    sendRequest(broker, pool, {
      op: "acquire",
      lease_id: leaseId,
      holder,
      ...(opts.ttl !== undefined ? { ttl_s: opts.ttl } : {}),
    });
  const onAbort = () => settle({ kind: "aborted" });
  limits.signal.addEventListener("abort", onAbort, { once: true });
  const timer =
    limits.timeoutMs !== undefined
      ? setTimeout(() => settle({ kind: "timeout" }), limits.timeoutMs)
      : undefined;
  const resend = setInterval(() => {
    if (seen) return;
    void probeSupervisor(broker)
      .then((s) => (s.live ? acquire() : settle({ kind: "supervisor-gone" })))
      .catch(() => {});
  }, RESEND_MS);
  try {
    if (limits.signal.aborted) return { kind: "aborted" };
    await acquire();
    return await done;
  } finally {
    clearTimeout(timer);
    clearInterval(resend);
    limits.signal.removeEventListener("abort", onAbort);
    await unsubscribe();
  }
}

/** Abort on SIGINT/SIGTERM while installed; `remove()` uninstalls. Remembers the signal. */
function trapSignals(): {
  signal: AbortSignal;
  caught: () => NodeJS.Signals | null;
  remove: () => void;
} {
  const ac = new AbortController();
  let caught: NodeJS.Signals | null = null;
  const on = (sig: NodeJS.Signals) => () => {
    caught = sig;
    ac.abort();
  };
  const int = on("SIGINT");
  const term = on("SIGTERM");
  process.on("SIGINT", int);
  process.on("SIGTERM", term);
  return {
    signal: ac.signal,
    caught: () => caught,
    remove: () => {
      process.off("SIGINT", int);
      process.off("SIGTERM", term);
    },
  };
}

const signalExit = (sig: NodeJS.Signals | null): ExitCode =>
  (128 + (sig !== null ? (constants.signals[sig] ?? 15) : 15)) as ExitCode;

async function run(r: Resolved & { pool: string }, command: string[], io: IO): Promise<ExitCode> {
  const broker = await connectAsClient(r.brokerUrl, io, r.auth);
  if (broker === null) {
    io.stderr("volley lease: broker unreachable; running without a lease\n");
    return exec(command, null);
  }
  const traps = trapSignals();
  const leaseId = r.leaseId ?? `${r.holder}.${randomSuffix(8)}`;
  let granted = false;
  try {
    const sup = await probeSupervisor(broker);
    if (!sup.live || sup.pools === null || !sup.pools.includes(r.pool)) {
      io.stderr(
        !sup.live
          ? "volley lease: no live volleyd; running without a lease\n"
          : `volley lease: no lease pool '${r.pool}' configured; running without a lease\n`,
      );
      await broker.disconnect();
      traps.remove();
      return exec(command, null);
    }
    const started = io.now().getTime();
    const res = await waitForGrant(
      broker,
      { pool: r.pool, leaseId, holder: r.holder, ttl: r.ttl },
      io,
      { timeoutMs: r.timeoutMs, signal: traps.signal },
    );
    if (res.kind !== "granted") {
      await cancel(broker, r.pool, leaseId, r.holder);
      if (res.kind === "aborted") return signalExit(traps.caught());
      if (res.kind === "timeout") {
        io.stderr(`volley lease: no ${r.pool} lease within ${(r.timeoutMs ?? 0) / 1000} s\n`);
        return EXIT.TIMEOUT;
      }
      io.stderr(
        res.kind === "rejected"
          ? `volley lease: ${res.reason}; running without a lease\n`
          : "volley lease: volleyd went away; running without a lease\n",
      );
      traps.remove();
      return exec(command, null);
    }
    granted = true;
    const waited = Math.round((io.now().getTime() - started) / 1000);
    io.stderr(`volley lease: ${r.pool} lease granted after ${waited} s\n`);
    // Renew at half the TTL so a long command keeps its lease.
    const renew = setInterval(
      () =>
        void sendRequest(broker, r.pool, {
          op: "renew",
          lease_id: leaseId,
          holder: r.holder,
        }).catch(() => {}),
      Math.max(1, res.ttlS / 2) * 1000,
    );
    try {
      return await exec(command, traps.signal);
    } finally {
      clearInterval(renew);
    }
  } finally {
    traps.remove();
    if (broker.connected) {
      if (granted) await cancel(broker, r.pool, leaseId, r.holder);
      await broker.disconnect();
    }
  }
}

/** Release (or cancel a queued request); errors are swallowed — TTL is the fallback. */
async function cancel(broker: VolleyBroker, pool: string, leaseId: string, holder: string) {
  try {
    await sendRequest(broker, pool, { op: "release", lease_id: leaseId, holder });
  } catch {
    // the lease expires on its TTL
  }
}

/**
 * Run the command with inherited stdio and resolve with its exit code (128 + n when killed by a
 * signal). SIGINT/SIGTERM delivered to us (`signal` aborts) are forwarded to the child.
 */
function exec(command: string[], signal: AbortSignal | null): Promise<ExitCode> {
  const [cmd, ...args] = command as [string, ...string[]];
  return new Promise((resolveExit) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    const forward = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", forward, { once: true });
    child.on("error", (e) => {
      process.stderr.write(`volley lease: ${e.message}\n`);
      resolveExit(127 as ExitCode);
    });
    child.on("close", (code, sig) => {
      signal?.removeEventListener("abort", forward);
      resolveExit((code ?? signalExit(sig)) as ExitCode);
    });
  });
}

async function acquireCmd(
  broker: VolleyBroker,
  r: Resolved & { pool: string },
  io: IO,
): Promise<ExitCode> {
  const sup = await probeSupervisor(broker);
  if (sup.pools === null || !sup.pools.includes(r.pool)) {
    io.stderr(
      sup.pools === null
        ? "volley lease acquire: no volleyd config on the broker (is volleyd running?)\n"
        : `volley lease acquire: no lease pool '${r.pool}' configured (pools: ${sup.pools.join(", ") || "none"})\n`,
    );
    return EXIT.ERROR;
  }
  const traps = trapSignals();
  const leaseId = r.leaseId ?? `${r.holder}.${randomSuffix(8)}`;
  const started = io.now().getTime();
  try {
    const res = await waitForGrant(
      broker,
      { pool: r.pool, leaseId, holder: r.holder, ttl: r.ttl },
      io,
      { timeoutMs: r.timeoutMs, signal: traps.signal },
    );
    if (res.kind === "granted") {
      const waited_s = Math.round((io.now().getTime() - started) / 1000);
      io.stdout(
        `${JSON.stringify({ pool: r.pool, lease_id: leaseId, holder: r.holder, waited_s })}\n`,
      );
      return EXIT.OK;
    }
    await cancel(broker, r.pool, leaseId, r.holder);
    if (res.kind === "aborted") return signalExit(traps.caught());
    if (res.kind === "timeout") {
      io.stderr(`volley lease acquire: no ${r.pool} lease within ${(r.timeoutMs ?? 0) / 1000} s\n`);
      return EXIT.TIMEOUT;
    }
    io.stderr(
      `volley lease acquire: ${res.kind === "rejected" ? res.reason : "volleyd went away"}\n`,
    );
    return EXIT.ERROR;
  } finally {
    traps.remove();
  }
}

async function releaseCmd(
  broker: VolleyBroker,
  r: Resolved & { pool: string; leaseId: string },
  io: IO,
): Promise<ExitCode> {
  const gone = broker.subscribeUntil(
    poolTopic(r.pool),
    (payload) => {
      const p = parsePool(payload);
      return (
        p !== null &&
        !p.held.some((h) => h.lease_id === r.leaseId) &&
        !p.queue.some((q) => q.lease_id === r.leaseId)
      );
    },
    RELEASE_CONFIRM_MS,
  );
  await sendRequest(broker, r.pool, { op: "release", lease_id: r.leaseId, holder: r.holder });
  if ((await gone) === null) {
    io.stderr(`volley lease release: ${r.leaseId} still listed in ${r.pool} after 5 s\n`);
    return EXIT.ERROR;
  }
  return EXIT.OK;
}

async function status(broker: VolleyBroker, r: Resolved, io: IO): Promise<ExitCode> {
  const msgs = await broker.subscribeCollect(
    r.pool !== undefined ? poolTopic(r.pool) : "volley/_system/leases/+",
    256,
    PROBE_MS,
  );
  const pools = msgs
    .map((m) => parsePool(m.payload))
    .filter((p): p is PoolState => p !== null)
    .sort((a, b) => (a.pool < b.pool ? -1 : 1));
  if (r.json) {
    io.stdout(`${JSON.stringify(pools, null, 2)}\n`);
    return EXIT.OK;
  }
  if (pools.length === 0) {
    io.stdout("no lease pools\n");
    return EXIT.OK;
  }
  for (const p of pools) {
    const why = p.reasons.length > 0 ? `  ${p.reasons.join("; ")}` : "";
    io.stdout(`${p.pool}  ${p.held.length}/${p.capacity} held  ${p.queue.length} queued${why}\n`);
    for (const h of p.held) io.stdout(`  held    ${h.lease_id}  ${h.holder}  since ${h.since}\n`);
    for (const q of p.queue) io.stdout(`  queued  ${q.lease_id}  ${q.holder}  since ${q.since}\n`);
  }
  return EXIT.OK;
}
