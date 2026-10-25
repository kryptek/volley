import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { parseArgs } from "node:util";
import type { VolleyBroker } from "volley-mcp/broker";
import { type BrokerAuth, authFromEnv, loadConfig, readCoordinatorAuth } from "volley-mcp/config";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { VolleyError } from "volley-mcp/errors";
import { isValidAgentId } from "volley-mcp/topics";
import { randomSuffix } from "volley-mcp/util";
import { parsePositiveInt, resolveAuth, resolveBrokerUrl } from "../args";
import { connectAsClient, connectToSupervisor, openClient, reportConnectError } from "../connect";
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

/**
 * SPEC §4.6.5: re-send `acquire` when the lease is in neither `held` nor `queue` after 30 s.
 * Every such interval the waiter also checks that a volleyd is still live and the pool still
 * configured. `VOLLEY_LEASE_RESEND_MS` overrides it (tests).
 */
const RESEND_MS = 30_000;
/** Re-sends with no sign of the request in the pool state before giving up (fail open). */
const MAX_UNANSWERED = 3;
/** How long retained supervisor state (config, status) may take to arrive. */
const PROBE_MS = 500;
/** How long `release` waits to see the lease leave the pool state. */
const RELEASE_CONFIRM_MS = 5_000;

const LEASE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

interface PoolState {
  pool: string;
  capacity: number;
  per_machine?: number;
  /** The per-machine cap in force on a named machine in place of `per_machine`. */
  per_machine_overrides?: Record<string, number>;
  /** `host`: the holder's machine; null or absent when the supervisor does not know it. */
  held: { lease_id: string; holder: string; host?: string | null; since: string; ttl_s: number }[];
  queue: { lease_id: string; holder: string; host?: string | null; since: string }[];
  reasons: string[];
}

const UNKNOWN_HOST = "(unknown host)";

const HELP = `Usage:
  volley lease run --pool <pool> [options] -- <command> [args...]
  volley lease acquire --pool <pool> [options]
  volley lease release --pool <pool> --lease-id <id> [--holder <id>]  (holder default: the id's prefix)
  volley lease status [--pool <pool>] [--json]

run      Wait for a lease, run the command, release the lease when it exits (or on
         SIGINT/SIGTERM/SIGHUP, which are forwarded to the command's process group). Prints
         "lease granted after N s" to stderr; exits with the command's exit code. It never waits
         on a supervisor that is gone: if no volleyd is live (now, or at any 30 s check while
         queued), the pool is not or no longer configured, or the request goes unanswered, it
         warns and runs the command unleased. A broker that refuses the credentials is an error
         (exit 1, the command does not run). If this process dies, the broker releases the lease.
acquire  Wait for a lease and print {"pool","lease_id","holder","waited_s"}; release it later.
release  Release a held lease, or cancel a queued request.
status   Print every pool's holders, queue and reasons, grouped by the holders' machine.

Options:
  --pool <pool>          Lease pool name (from volleyd's lease_pools config)
  --ttl <seconds>        Lease TTL (default: the pool's ttl_s); run renews it while the command runs
  --holder <agent-id>    Who holds the lease (default: .volley/agent.json's agent_id, else a random id)
  --lease-id <id>        Lease id (default: <holder>.<random>)
  --timeout <seconds>    Give up waiting after N seconds (exit 124); default: wait as long as it takes
  --project-dir <dir>    Where .volley/agent.json is (identity + broker credentials); default: cwd
  --coordinator          Connect with the coordinator's credentials: VOLLEY_AUTH_*, else
                         $VOLLEY_AUTH_DIR/coordinator.json (never .volley/agent.json). The
                         coordinator hooks pass it.
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
  coordinator: { type: "boolean" },
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
  /** --holder was given (not derived from identity or random). */
  holderGiven: boolean;
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

  const resendMs = parsePositiveInt(env.VOLLEY_LEASE_RESEND_MS ?? String(RESEND_MS), "resend");
  if (action === "run") return run(r as Resolved & { pool: string }, command, io, resendMs);
  if (action === "release" && !r.holderGiven) {
    // A lease id defaults to `<holder>.<random>`, so it names its holder.
    const prefix = r.leaseId?.split(".")[0] ?? "";
    if (r.leaseId?.includes(".") === true && isValidAgentId(prefix)) r.holder = prefix;
  }
  const leaseId = action === "acquire" ? (r.leaseId ?? `${r.holder}.${randomSuffix(8)}`) : "";
  const broker = await connectToSupervisor(
    r.brokerUrl,
    io,
    r.auth,
    { command: `volley lease ${action}`, json: r.json === true, env },
    action === "acquire" ? releaseWill(r.pool as string, leaseId, r.holder) : undefined,
  );
  if (typeof broker === "number") return broker;
  try {
    if (action === "status") return await status(broker, r, io);
    if (action === "release") {
      return await releaseCmd(broker, r as Resolved & { pool: string; leaseId: string }, io);
    }
    return await acquireCmd(
      broker,
      { ...r, leaseId } as Resolved & { pool: string; leaseId: string },
      io,
      resendMs,
    );
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
  const holderGiven = holder !== undefined;
  if (holder === undefined) {
    try {
      // Only a supervisor-assigned identity is stable enough to hold a lease; otherwise use a
      // fresh id (acquire prints it, so a later release can name it). --coordinator never reads
      // the identity file: it speaks for the coordinator, not for an agent in that worktree.
      const assigned = values.coordinator === true ? undefined : identityAgentId(env, dir);
      holder = assigned ?? `lease-${randomSuffix(6)}`;
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
    holderGiven,
    leaseId,
    timeoutMs: timeout !== undefined ? parsePositiveInt(timeout, "--timeout") * 1000 : undefined,
    brokerUrl: resolveBrokerUrl(str(values["broker-url"]), env),
    auth:
      values.coordinator === true && values.username === undefined
        ? coordinatorAuth(values.password, env)
        : resolveAuth(
            { username: str(values.username), password: str(values.password) },
            env,
            dir,
            resolveBrokerUrl(str(values["broker-url"]), env),
          ),
    json: values.json === true,
  };
}

/**
 * `--coordinator` credentials, resolved as the coordinator hooks resolve theirs: `VOLLEY_AUTH_*`,
 * else `coordinator.json`. A malformed file throws (a usage error) instead of going anonymous.
 */
function coordinatorAuth(
  password: string | boolean | undefined,
  env: Record<string, string | undefined>,
): BrokerAuth | null {
  if (password !== undefined) throw new Error("--password requires --username");
  return authFromEnv(env) ?? readCoordinatorAuth(env);
}

/** The agent id from `<dir>/.volley/agent.json`, or undefined when there is no such file. */
function identityAgentId(env: Record<string, string | undefined>, dir: string): string | undefined {
  if (!existsSync(join(dir, ".volley", "agent.json"))) return undefined;
  return loadConfig(env, dir, () => {}).agentId;
}

/**
 * The MQTT will for a lease client: a `release` of its lease, published (not retained) by the
 * broker if the connection drops without a clean DISCONNECT — the process was killed, or lost
 * its network — so the slot is freed now instead of at TTL expiry. A clean disconnect (after
 * the explicit release, or after `acquire` printed its lease) suppresses it.
 */
function releaseWill(pool: string, leaseId: string, holder: string) {
  return {
    topic: `${poolTopic(pool)}/requests`,
    payload: JSON.stringify(requestEnvelope({ op: "release", lease_id: leaseId, holder })),
  };
}

function parsePool(raw: string): PoolState | null {
  const env = parseEnvelope(raw);
  if (env === null || env.type !== "lease_pool") return null;
  const p = env.payload as PoolState;
  return Array.isArray(p?.held) && Array.isArray(p.queue) ? p : null;
}

interface RequestPayload {
  op: "acquire" | "release" | "renew";
  lease_id: string;
  holder: string;
  ttl_s?: number;
}

const requestEnvelope = (payload: RequestPayload) =>
  buildEnvelope({
    agentId: payload.holder,
    parentId: null,
    channel: "_system/leases/requests",
    type: "lease_request",
    payload,
  });

async function sendRequest(
  broker: VolleyBroker,
  pool: string,
  payload: RequestPayload,
): Promise<void> {
  await broker.publish(`${poolTopic(pool)}/requests`, JSON.stringify(requestEnvelope(payload)), {
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
  /** No supervisor to wait for (gone, unreachable, or never answering): fail open. */
  | { kind: "gone"; reason: string };

/**
 * Send `acquire` and wait until the lease is held. Prints the queue reasons once when queued.
 * Every `resendMs` it checks the supervisor: none live → gone; the pool no longer configured
 * → rejected; the lease still in neither `held` nor `queue` → re-send `acquire`, giving up
 * (gone) after MAX_UNANSWERED re-sends. A queued lease that leaves the pool state without a
 * grant (or whose pool state is cleared) was dropped by the supervisor → rejected. So no wait
 * outlives the supervisor that would end it.
 */
async function waitForGrant(
  broker: VolleyBroker,
  opts: { pool: string; leaseId: string; holder: string; ttl?: number | undefined },
  io: IO,
  limits: { timeoutMs?: number | undefined; signal: AbortSignal; resendMs: number },
): Promise<WaitResult> {
  const { pool, leaseId, holder } = opts;
  let seen = false;
  let toldQueued = false;
  let unanswered = 0;
  let settle!: (r: WaitResult) => void;
  const done = new Promise<WaitResult>((r) => {
    settle = r;
  });
  const unsubscribe = await broker.subscribeStream(poolTopic(pool), ({ payload }) => {
    if (payload === "") {
      // volleyd clears the topic of a pool that left its config and its book.
      if (seen) settle({ kind: "rejected", reason: `pool ${pool} removed from config` });
      return;
    }
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
    else if (seen)
      settle({ kind: "rejected", reason: `${leaseId} was dropped from ${pool} without a grant` });
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
  const check = async () => {
    const s = await probeSupervisor(broker);
    if (!s.live) return settle({ kind: "gone", reason: "volleyd went away" });
    if (s.pools !== null && !s.pools.includes(pool))
      return settle({ kind: "rejected", reason: `pool ${pool} removed from config` });
    if (seen) return;
    if (++unanswered > MAX_UNANSWERED) {
      return settle({
        kind: "gone",
        reason: `volleyd never queued ${leaseId} after ${MAX_UNANSWERED} re-sends`,
      });
    }
    await acquire();
  };
  const resend = setInterval(() => {
    check().catch((e: unknown) =>
      settle({
        kind: "gone",
        reason: `lost the broker (${e instanceof Error ? e.message : String(e)})`,
      }),
    );
  }, limits.resendMs);
  try {
    if (limits.signal.aborted) return { kind: "aborted" };
    await acquire();
    return await done;
  } finally {
    clearTimeout(timer);
    clearInterval(resend);
    limits.signal.removeEventListener("abort", onAbort);
    await unsubscribe().catch(() => {});
  }
}

/** Abort on SIGINT/SIGTERM/SIGHUP while installed; `remove()` uninstalls. Remembers the signal. */
const TRAPPED: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

type Traps = ReturnType<typeof trapSignals>;

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
  const handlers = TRAPPED.map((sig) => [sig, on(sig)] as const);
  for (const [sig, h] of handlers) process.on(sig, h);
  return {
    signal: ac.signal,
    caught: () => caught,
    remove: () => {
      for (const [sig, h] of handlers) process.off(sig, h);
    },
  };
}

const signalExit = (sig: NodeJS.Signals | null): ExitCode =>
  (128 + (sig !== null ? (constants.signals[sig] ?? 15) : 15)) as ExitCode;

async function run(
  r: Resolved & { pool: string },
  command: string[],
  io: IO,
  resendMs: number,
): Promise<ExitCode> {
  const leaseId = r.leaseId ?? `${r.holder}.${randomSuffix(8)}`;
  const will = releaseWill(r.pool, leaseId, r.holder);
  // Installed for the whole run: an unleased command is forwarded our signals too.
  const traps = trapSignals();
  let first: VolleyBroker | null = null;
  try {
    first = await openClient(r.brokerUrl, r.auth, will);
  } catch (e) {
    reportConnectError(io, e);
    if (e instanceof VolleyError && e.code === "AUTH_FAILED") {
      // Fail closed: a refused login is a setup error, not an outage. Running unleased would
      // hide it and defeat the pool.
      io.stderr("volley lease: not running the command without a lease; fix the credentials\n");
      traps.remove();
      return EXIT.ERROR;
    }
  }
  if (first === null) {
    io.stderr("volley lease: broker unreachable; running without a lease\n");
    try {
      return await exec(command, traps);
    } finally {
      traps.remove();
    }
  }
  let broker = first;
  let granted = false;
  /** A fresh connection (with the will) when the current one dropped; null if that fails too. */
  const reconnect = async (): Promise<VolleyBroker | null> => {
    if (broker.connected) return broker;
    io.stderr("volley lease: lost the broker connection; reconnecting\n");
    const b = await connectAsClient(r.brokerUrl, io, r.auth, will);
    if (b !== null) broker = b;
    return b;
  };
  try {
    const sup = await probeSupervisor(broker);
    if (!sup.live || sup.pools === null || !sup.pools.includes(r.pool)) {
      io.stderr(
        !sup.live
          ? "volley lease: no live volleyd; running without a lease\n"
          : `volley lease: no lease pool '${r.pool}' configured; running without a lease\n`,
      );
      await broker.disconnect();
      return await exec(command, traps);
    }
    const started = io.now().getTime();
    const res = await waitForGrant(
      broker,
      { pool: r.pool, leaseId, holder: r.holder, ttl: r.ttl },
      io,
      { timeoutMs: r.timeoutMs, signal: traps.signal, resendMs },
    );
    if (res.kind !== "granted") {
      await cancel(broker, r.pool, leaseId, r.holder);
      if (res.kind === "aborted") return signalExit(traps.caught());
      if (res.kind === "timeout") {
        io.stderr(`volley lease: no ${r.pool} lease within ${(r.timeoutMs ?? 0) / 1000} s\n`);
        return EXIT.TIMEOUT;
      }
      io.stderr(`volley lease: WARNING: ${res.reason}; running without a lease\n`);
      return await exec(command, traps);
    }
    granted = true;
    const waited = Math.round((io.now().getTime() - started) / 1000);
    io.stderr(`volley lease: ${r.pool} lease granted after ${waited} s\n`);
    // Renew at half the TTL so a long command keeps its lease. After a dropped connection the
    // will has released the lease, so the fresh connection asks for it again instead.
    let renewing = false;
    const renew = setInterval(
      () => {
        if (renewing) return;
        renewing = true;
        void (async () => {
          const wasConnected = broker.connected;
          const b = await reconnect();
          if (b === null) return;
          await sendRequest(b, r.pool, {
            op: wasConnected ? "renew" : "acquire",
            lease_id: leaseId,
            holder: r.holder,
            ...(!wasConnected && r.ttl !== undefined ? { ttl_s: r.ttl } : {}),
          });
        })()
          .catch(() => {})
          .finally(() => {
            renewing = false;
          });
      },
      Math.max(1, res.ttlS / 2) * 1000,
    );
    try {
      return await exec(command, traps);
    } finally {
      clearInterval(renew);
    }
  } finally {
    traps.remove();
    const b = granted ? await reconnect().catch(() => null) : broker;
    if (b?.connected === true) {
      if (granted) await cancel(b, r.pool, leaseId, r.holder);
      await b.disconnect();
    }
  }
}

/** Release (or cancel a queued request); errors are swallowed — the will, then TTL, are the fallback. */
async function cancel(broker: VolleyBroker, pool: string, leaseId: string, holder: string) {
  try {
    await sendRequest(broker, pool, { op: "release", lease_id: leaseId, holder });
  } catch {
    // the lease expires on its TTL
  }
}

/**
 * Run the command with inherited stdio and resolve with its exit code (128 + n when killed by a
 * signal). It runs in its own process group, and a signal delivered to us (`traps` aborts) is
 * forwarded to that whole group, so `sh -c 'cd x && mvn verify'` stops `mvn` too, not just the
 * shell. If we die without cleaning up (SIGKILL), `guardGroup` stops the group: the will has
 * already released the lease, so the command must not keep running unleased.
 *
 * The guard needs the group's id, so it can only start after the group exists. A shell gate
 * leads the group and execs the command only once the guard is armed (a line on fd 3); dying
 * before that closes fd 3 and the gate exits without running it. Otherwise a SIGKILL right
 * after the spawn would leave the command running with no guard.
 */
function exec(command: string[], traps: Traps): Promise<ExitCode> {
  // Signalled before the command started: do not start it.
  if (traps.signal.aborted) return Promise.resolve(signalExit(traps.caught()));
  return new Promise((resolveExit) => {
    const child = spawn("sh", ["-c", 'read -r _ <&3 || exit 1; exec "$@" 3<&-', "sh", ...command], {
      stdio: ["inherit", "inherit", "inherit", "pipe"],
      detached: true,
    });
    const gate = child.stdio[3] as Writable | null | undefined;
    gate?.on("error", () => {});
    const unguard = child.pid !== undefined ? guardGroup(child.pid) : () => {};
    gate?.end("\n");
    const forward = () => {
      const sig = traps.caught() ?? "SIGTERM";
      try {
        if (child.pid !== undefined) process.kill(-child.pid, sig);
      } catch {
        child.kill(sig);
      }
    };
    traps.signal.addEventListener("abort", forward, { once: true });
    child.on("error", (e) => {
      unguard();
      process.stderr.write(`volley lease: ${e.message}\n`);
      resolveExit(127 as ExitCode);
    });
    child.on("close", (code, sig) => {
      unguard();
      traps.signal.removeEventListener("abort", forward);
      resolveExit((code ?? signalExit(sig)) as ExitCode);
    });
  });
}

/**
 * Stop process group `pgid` (SIGTERM) once we are gone. A detached `sh` blocks reading a pipe
 * from us; our death closes its write end — even under SIGKILL, which no handler sees — and the
 * read returns. It is detached too, so a kill of our own process group spares it. Returns the
 * disarm function for a normal exit.
 */
function guardGroup(pgid: number): () => void {
  const guard = spawn("sh", ["-c", 'read -r _; kill -TERM -"$1" 2>/dev/null', "sh", String(pgid)], {
    stdio: ["pipe", "ignore", "ignore"],
    detached: true,
  });
  guard.on("error", () => {});
  guard.stdin?.on("error", () => {});
  guard.unref();
  return () => {
    guard.kill("SIGKILL");
    guard.stdin?.destroy();
  };
}

async function acquireCmd(
  broker: VolleyBroker,
  r: Resolved & { pool: string; leaseId: string },
  io: IO,
  resendMs: number,
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
  const leaseId = r.leaseId;
  const started = io.now().getTime();
  try {
    const res = await waitForGrant(
      broker,
      { pool: r.pool, leaseId, holder: r.holder, ttl: r.ttl },
      io,
      { timeoutMs: r.timeoutMs, signal: traps.signal, resendMs },
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
    io.stderr(`volley lease acquire: ${res.reason}\n`);
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
      // An empty retained payload: the pool left config and its last lease is gone.
      if (payload === "") return true;
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
    io.stdout(
      `${p.pool}  ${p.held.length}/${p.capacity} held${capSummary(p)}  ${p.queue.length} queued${why}\n`,
    );
    for (const [host, g] of byHost(p)) {
      // A per-machine cap applies to a known machine only: its override, else `per_machine`.
      const inForce = host === UNKNOWN_HOST ? undefined : capInForce(p, host);
      const n = inForce !== undefined ? `/${inForce}` : "";
      io.stdout(`  ${host}  ${g.held.length}${n} held\n`);
      for (const h of g.held)
        io.stdout(`    held    ${h.lease_id}  ${h.holder}  since ${h.since}\n`);
      for (const q of g.queue)
        io.stdout(`    queued  ${q.lease_id}  ${q.holder}  since ${q.since}\n`);
    }
  }
  return EXIT.OK;
}

/** The per-machine cap in force on `host`: its override, else the pool's `per_machine`. */
function capInForce(p: PoolState, host: string): number | undefined {
  return p.per_machine_overrides?.[host] ?? p.per_machine;
}

/** The header's cap segment: `  max 2 per machine (box-a 3, laptop 1)`, or `""` with no cap. */
function capSummary(p: PoolState): string {
  const overrides = Object.entries(p.per_machine_overrides ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([host, n]) => `${host} ${n}`)
    .join(", ");
  if (p.per_machine !== undefined)
    return `  max ${p.per_machine} per machine${overrides !== "" ? ` (${overrides})` : ""}`;
  return overrides !== "" ? `  max per machine: ${overrides}` : "";
}

/**
 * A pool's held and queued leases by the holder's machine, plus every machine with a cap override
 * (so a machine's cap shows before it holds anything): hosts by name, unknown host last.
 */
function byHost(p: PoolState): [string, Pick<PoolState, "held" | "queue">][] {
  const groups = new Map<string, Pick<PoolState, "held" | "queue">>();
  for (const host of Object.keys(p.per_machine_overrides ?? {}))
    groups.set(host, { held: [], queue: [] });
  const group = (host: string | null | undefined) => {
    const key = host ?? UNKNOWN_HOST;
    let g = groups.get(key);
    if (g === undefined) {
      g = { held: [], queue: [] };
      groups.set(key, g);
    }
    return g;
  };
  for (const h of p.held) group(h.host).held.push(h);
  for (const q of p.queue) group(q.host).queue.push(q);
  const rank = (host: string) => (host === UNKNOWN_HOST ? 1 : 0);
  return [...groups].sort(([a], [b]) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}
