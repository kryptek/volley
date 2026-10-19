import { spawn } from "node:child_process";
import {
  constants,
  type KeyObject,
  generateKeyPairSync,
  privateDecrypt,
  randomUUID,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { VolleyBroker } from "volley-mcp/broker";
import { type BrokerAuth, readCoordinatorAuth } from "volley-mcp/config";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { VolleyError } from "volley-mcp/errors";
import { buildTopic } from "volley-mcp/topics";
import { randomSuffix } from "volley-mcp/util";
import pkg from "../../package.json";
import { parsePositiveInt, resolveAuth, resolveBrokerUrl, resolveNamespace } from "../args";
import { openClient, reportConnectError } from "../connect";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";
import { isRepoTrusted } from "../peer/checks/claude";
import { diskOf, memoryOf, worktreeRoot } from "../peer/checks/machine";
import {
  type DoctorDeps,
  type DoctorOptions,
  type DoctorReport,
  blocking,
  doctor,
  looksSecret,
  recordChecks,
  renderHuman,
  runDoctor,
} from "../peer/doctor";
import { authOpsTopic } from "./auth-roles";

export { isRepoTrusted };

/**
 * `volley peer`: pair a second machine with the supervisor's (SPEC §4.6.14).
 *
 * On the supervisor's machine (the host): `invite` asks volleyd for a one-time pairing code,
 * `remove` unpairs a machine (both admin ops: sent on the admin's account-op topic, SPEC
 * §4.6.10), `list` shows the paired machines' health. `redeem` is what `join` runs on the host
 * over ssh: it checks the host can ssh back, hands the code to volleyd and prints the new peer
 * account.
 *
 * On the new machine: `join <code> --to <host>` checks ssh to the host, redeems the code there
 * (every remote step is a script on stdin to `ssh <host> bash -s`), writes `~/.volley/peer.json`,
 * installs `volley peer run` as a user service (systemd on Linux, launchd on macOS), checks
 * Claude Code's folder trust for the repo, and registers the machine. `run` is that service: it
 * keeps `ssh -N -L 127.0.0.1:<port>:<broker>` up and publishes the machine's health record
 * through it every heartbeat, until the broker refuses the peer account (`remove` revoked it).
 *
 * `doctor` (src/peer/doctor.ts) checks everything an agent on this machine needs and applies the
 * safe fixes with `--fix`; `join` runs it before redeeming (a `block` check stops it while the code
 * is still usable), and `run` embeds its last result in every heartbeat (SPEC §4.6.15).
 * `invite --for <name>` mints a code that re-pairs an already paired machine (`join --replace`).
 */

const HELP = `Usage:
  On the supervisor's machine:
    volley peer invite [--ttl <seconds>] [--for <name>]
                                               A one-time pairing code (XXXX-XXXX, 10 min);
                                               --for: re-pair the paired machine <name>
    volley peer list [--json]                  Paired machines and their health
    volley peer remove <name>                  Unpair: revoke its account, drop hosts.<name>
  On the machine to pair:
    volley peer join <code> --to <host> [--name <name>] [--target <user@this-machine>]
                     [--repo <path>] [--volley-dir <path>] [--port <port>]
                     [--remote-volley <command>] [--no-service] [--replace]
    volley peer doctor [--fix] [--yes] [--json] [--repo <path>] [--clone]
                       [--origin <url>] [--release <branch>] [--volley-dir <path>]
                                               Check this machine; --fix applies the safe fixes
    volley peer run                            The tunnel + heartbeat service (installed by join)
  Internal:
    volley peer redeem                         Run by join on the host over ssh (JSON on stdin)

join options:
  --to <host>              ssh destination of the supervisor's machine (key-based login)
  --name <name>            This machine's name (default: its short hostname, lower-cased)
  --target <user@host>     How the supervisor's machine reaches this one over ssh
                           (default: $USER@<hostname>)
  --repo <path>            This machine's clone of the wave repository
  --volley-dir <path>      This machine's volley checkout (default: the one running this command)
  --port <port>            Port on this machine's 127.0.0.1 that reaches the broker (default 21883)
  --remote-volley <cmd>    How to run volley on the supervisor's machine (default: volley)
  --no-service             Do not install the service (run \`volley peer run\` yourself)
  --replace                Re-pair: replace this machine's account and hosts entry (a code
                           from \`volley peer invite --for <name>\`, with --name <name>)
  join runs \`volley peer doctor\` first and stops before using the code if a check blocks.

doctor options:
  --fix                    Apply the safe fixes (the volley checkout's install and version, a
                           clone with --clone); print the rest as commands to run yourself
  --yes                    Do not ask before applying them
  --json                   The report as JSON (the machine record's doctor fields)
  --repo <path>            This machine's clone of the wave repo (default: peer.json's)
  --clone                  With --fix: clone the wave repo at --repo when nothing is there
  --origin <url>           The wave repo's URL: compared with the clone's origin, cloned by --clone
  --release <branch>       Check this branch is fetchable from origin

Host options (invite, list, remove, redeem):
  --broker-url <url>   MQTT broker URL (env: VOLLEY_BROKER_URL; default: mqtt://localhost:1883)
  --namespace <ns>     volleyd's namespace (env: VOLLEY_NAMESPACE; default: default)
  --username <user>    Broker username (env: VOLLEY_AUTH_USERNAME; list and redeem: else
                       coordinator.json). invite and remove need an admin account.
  --password <pw>      Broker password (env: VOLLEY_AUTH_PASSWORD)
  --timeout <seconds>  How long to wait for volleyd's answer (default 30)
`;

const OPTIONS = {
  to: { type: "string" },
  name: { type: "string" },
  target: { type: "string" },
  repo: { type: "string" },
  "volley-dir": { type: "string" },
  port: { type: "string" },
  "remote-volley": { type: "string" },
  "no-service": { type: "boolean" },
  replace: { type: "boolean" },
  for: { type: "string" },
  fix: { type: "boolean" },
  yes: { type: "boolean" },
  clone: { type: "boolean" },
  origin: { type: "string" },
  release: { type: "string" },
  ttl: { type: "string" },
  json: { type: "boolean" },
  timeout: { type: "string" },
  "broker-url": { type: "string" },
  namespace: { type: "string" },
  username: { type: "string" },
  password: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

/** Flags only some verbs take. */
const OWNED_BY: Partial<Record<keyof typeof OPTIONS, string[]>> = {
  fix: ["doctor"],
  yes: ["doctor"],
  clone: ["doctor"],
  origin: ["doctor"],
  release: ["doctor"],
  for: ["invite"],
  replace: ["join"],
};

/** Mirrors volleyd's config-defaults (separate package: no import across the boundary). */
export const PEER_DEFAULTS = {
  remote_port: 21883,
  heartbeat_ms: 30_000,
  ssh_connect_timeout_s: 10,
  ssh_alive_interval_s: 15,
  answer_timeout_s: 30,
  /** How long join waits for the fresh service's tunnel before leaving registration to it. */
  register_attempts: 10,
  register_wait_ms: 2_000,
  tunnel_restart_ms: 2_000,
  tunnel_restart_max_ms: 60_000,
  remote_exec_timeout_ms: 60_000,
  /** `run` re-runs the doctor this often; heartbeats in between repeat its last result. */
  doctor_interval_s: 600,
  /**
   * `run`'s doctor runs beside the heartbeat, never in its way; a run that takes longer than this
   * is given up (the last result stays) so the next interval can start a fresh one.
   */
  doctor_timeout_ms: 300_000,
  /** How long the doctor waits for the supervisor's retained readiness verdict (its requirements). */
  readiness_wait_ms: 1_000,
} as const;

export const SYSTEMD_UNIT = "volley-peer.service";
export const LAUNCHD_LABEL = "systems.volley.peer";
const LIVE = new Set(["spawning", "registered", "working"]);
const PROBE_MS = 1_000;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type PeerExec = (
  argv: string[],
  opts?: { input?: string; timeoutMs?: number; signal?: AbortSignal },
) => Promise<ExecResult>;

/**
 * Everything `volley peer` touches outside the broker, injectable for tests. A superset of what
 * the doctor needs (`DoctorDeps`: memory, disk, uptime, the login shell, this CLI's version).
 */
export interface PeerDeps extends DoctorDeps {
  exec: PeerExec;
  home: string;
  platform: NodeJS.Platform;
  hostname: () => string;
  user: () => string;
  uid: () => number;
  arch: string;
  cpus: () => number;
  loadavg: () => [number, number, number];
  now: () => Date;
  /** A monotonic clock in ms (the doctor's interval: a wall-clock step never stalls it). */
  monotonic: () => number;
  /** This process's PATH: the service gets the one `join` ran with (launchd's own is bare). */
  envPath: () => string | undefined;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readStdin: () => Promise<string>;
  /** argv that runs this volley CLI (the service's ExecStart / ProgramArguments). */
  volleyArgv: string[];
  /** This machine's volley checkout (`--volley-dir` default). */
  volleyDir: string;
  connect: (
    url: string,
    auth: BrokerAuth | null,
    will?: { topic: string; payload: string; retain: boolean },
  ) => Promise<VolleyBroker>;
}

/** `~/.volley/peer.json`: what `run` needs (mode 0600: it holds the peer's password). */
export interface PeerConfig {
  name: string;
  host: string;
  target: string;
  namespace: string;
  broker: { host: string; port: number };
  remote_port: number;
  username: string;
  password: string;
  repo?: string;
  joined_at: string;
}

export const peerFile = (home: string) => join(home, ".volley", "peer.json");

export interface PeerArgs {
  argv: string[];
  env: Record<string, string | undefined>;
  io: IO;
}

export function peer(args: PeerArgs): Promise<ExitCode> {
  return runPeer(args, realDeps());
}

type Values = ReturnType<
  typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>
>["values"];

export async function runPeer({ argv, env, io }: PeerArgs, deps: PeerDeps): Promise<ExitCode> {
  const [verb, ...rest] = argv;
  if (verb === undefined || verb === "--help" || verb === "-h") {
    io.stdout(HELP);
    return verb === undefined ? EXIT.USAGE : EXIT.OK;
  }
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    io.stderr(`volley peer: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.USAGE;
  }
  const v = parsed.values;
  if (v.help === true) {
    io.stdout(HELP);
    return EXIT.OK;
  }
  const pos = parsed.positionals;
  const usage = (msg: string) => {
    io.stderr(`volley peer ${verb}: ${msg}\n`);
    return EXIT.USAGE;
  };
  // The one options table is shared: a flag another verb owns is refused, never ignored.
  for (const [flag, owner] of Object.entries(OWNED_BY)) {
    if (v[flag as keyof Values] !== undefined && !owner.includes(verb)) {
      return usage(`--${flag} is an option of volley peer ${owner.join(", ")} only`);
    }
  }
  switch (verb) {
    case "invite":
      if (pos.length !== 0) return usage("takes no arguments");
      if (v.for !== undefined && !NAME_RE.test(v.for)) {
        return usage(`--for "${v.for}" must be a machine name ([a-z0-9][a-z0-9_-]{0,62})`);
      }
      return invite(v, env, io, deps);
    case "list":
      if (pos.length !== 0) return usage("takes no arguments");
      return list(v, env, io);
    case "remove":
      if (pos.length !== 1) return usage("needs exactly one <name>");
      return remove(pos[0] as string, v, env, io);
    case "redeem":
      if (pos.length !== 0) return usage("takes no arguments (the request is JSON on stdin)");
      return redeem(v, env, io, deps);
    case "join":
      if (pos.length !== 1) return usage("needs exactly one <code>");
      if (v.to === undefined || v.to === "") return usage("needs --to <host>");
      return join_(pos[0] as string, v, io, deps);
    case "run":
      if (pos.length !== 0) return usage("takes no arguments");
      return runService(io, deps);
    case "doctor":
      if (pos.length !== 0) return usage("takes no arguments");
      return doctorVerb(v, io, deps);
    default:
      io.stderr(`volley peer: unknown verb '${verb}'\n\n${HELP}`);
      return EXIT.USAGE;
  }
}

// ---------------------------------------------------------------------------------------------
// Host side: control queries to volleyd
// ---------------------------------------------------------------------------------------------

interface Answer {
  ok: boolean;
  error?: string;
  result?: unknown;
  sealed?: string;
}

/** A throwaway RSA key the answer's secret is sealed to (volleyd refuses a secret without one). */
function replyKeyPair(): { jwk: unknown; privateKey: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { jwk: publicKey.export({ format: "jwk" }), privateKey };
}

function unseal(key: KeyObject, sealed: string | undefined): Record<string, unknown> | null {
  if (sealed === undefined) return null;
  try {
    return JSON.parse(
      privateDecrypt(
        { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        Buffer.from(sealed, "base64url"),
      ).toString(),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Where volleyd answers an account-op request (accounts.ts in volleyd). */
const authReplyTopic = (correlationId: string) => `volley/_system/auth/replies/${correlationId}`;

/**
 * One control query to volleyd: connect (the caller's credentials, else the coordinator's file),
 * check volleyd is live, send, wait. Prints its own errors; null when there is no answer.
 * `admin`: an admin op, sent on the caller's own account-op topic (only an admin login may
 * publish there, so the coordinator's file never serves).
 */
async function ask(
  verb: string,
  op: string,
  fields: Record<string, unknown>,
  v: Values,
  env: Record<string, string | undefined>,
  io: IO,
  admin = false,
): Promise<Answer | ExitCode> {
  let timeoutMs: number;
  let namespace: string;
  let auth: BrokerAuth | null;
  try {
    timeoutMs =
      parsePositiveInt(v.timeout ?? String(PEER_DEFAULTS.answer_timeout_s), "--timeout") * 1000;
    namespace = resolveNamespace(v.namespace, env);
  } catch (e) {
    io.stderr(`volley peer ${verb}: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.USAGE;
  }
  try {
    // Over ssh (redeem) there is rarely a VOLLEY_AUTH_* env: the coordinator's file serves.
    auth = resolveAuth({ username: v.username, password: v.password }, env);
    if (!admin) auth ??= readCoordinatorAuth(env);
  } catch (e) {
    io.stderr(`volley peer ${verb}: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.ERROR;
  }
  if (admin && auth === null) {
    io.stderr(
      `volley peer ${verb}: ${ADMIN_ONLY}: pass --username <admin> (password in VOLLEY_AUTH_PASSWORD) or set VOLLEY_AUTH_USERNAME and VOLLEY_AUTH_PASSWORD\n`,
    );
    return EXIT.USAGE;
  }
  let broker: VolleyBroker;
  try {
    broker = await openClient(resolveBrokerUrl(v["broker-url"], env), auth);
  } catch (e) {
    reportConnectError(io, e);
    return EXIT.ERROR;
  }
  try {
    const status = await broker.queryRetained(buildTopic(namespace, "volleyd", "status"), PROBE_MS);
    if (status === null || !LIVE.has(parseEnvelope(status)?.type ?? "")) {
      io.stderr(`volley peer ${verb}: volleyd is not running in namespace '${namespace}'\n`);
      return EXIT.ERROR;
    }
    const answer =
      admin && auth !== null
        ? await adminRequest(broker, auth.username, op, fields, timeoutMs)
        : await request(broker, namespace, op, fields, timeoutMs);
    if (answer === null) {
      // The broker drops an account-op request from any login but an admin's, silently.
      const why = admin ? ` (${ADMIN_ONLY}; is ${auth?.username} one?)` : "";
      io.stderr(`volley peer ${verb}: volleyd did not answer within ${timeoutMs / 1000} s${why}\n`);
      return EXIT.TIMEOUT;
    }
    if (!answer.ok) {
      io.stderr(`volley peer ${verb}: ${answer.error ?? "refused"}\n`);
      return EXIT.ERROR;
    }
    return answer;
  } finally {
    await broker.disconnect();
  }
}

async function request(
  broker: VolleyBroker,
  namespace: string,
  op: string,
  fields: Record<string, unknown>,
  timeoutMs: number,
): Promise<Answer | null> {
  const me = `volley-cli-${randomSuffix(6)}`;
  const correlationId = randomUUID();
  let done!: (a: Answer | null) => void;
  const answered = new Promise<Answer | null>((r) => {
    done = r;
  });
  const unsubscribe = await broker.subscribeStream(
    buildTopic(namespace, me, "mailbox"),
    ({ payload }) => {
      const e = parseEnvelope(payload);
      // Only volleyd may answer (SPEC §4.4: anyone can write our mailbox).
      if (e?.type === "ack" && e.correlation_id === correlationId && e.agent_id === "volleyd")
        done(e.payload as Answer);
    },
  );
  const timer = setTimeout(() => done(null), timeoutMs);
  try {
    const query = buildEnvelope({
      agentId: me,
      parentId: null,
      channel: "mailbox",
      type: "query",
      correlationId,
      payload: { op, text: `volley peer: ${op}`, ...fields },
    });
    await broker.publish(buildTopic(namespace, "volleyd", "mailbox"), JSON.stringify(query), {
      qos: 1,
      retain: false,
    });
    return await answered;
  } finally {
    clearTimeout(timer);
    await unsubscribe();
  }
}

const ADMIN_ONLY = "pairing codes and unpairing are admin ops (an admin account's login)";

/** An admin op on `username`'s account-op topic, answered on its correlation id's reply topic. */
async function adminRequest(
  broker: VolleyBroker,
  username: string,
  op: string,
  fields: Record<string, unknown>,
  timeoutMs: number,
): Promise<Answer | null> {
  const correlationId = randomUUID();
  let done!: (a: Answer | null) => void;
  const answered = new Promise<Answer | null>((r) => {
    done = r;
  });
  const unsubscribe = await broker.subscribeStream(authReplyTopic(correlationId), ({ payload }) => {
    const e = parseEnvelope(payload);
    // Only volleyd may answer (SPEC §4.6.10).
    if (e?.type === "ack" && e.correlation_id === correlationId && e.agent_id === "volleyd")
      done(e.payload as Answer);
  });
  const timer = setTimeout(() => done(null), timeoutMs);
  try {
    const query = buildEnvelope({
      agentId: `volley-cli-${randomSuffix(6)}`,
      parentId: null,
      channel: "_system/auth",
      type: "query",
      correlationId,
      payload: { op, ...fields },
    });
    // Not awaited: a broker that refuses the publish (not an admin) never acknowledges it.
    void broker
      .publish(authOpsTopic(username), JSON.stringify(query), { qos: 1, retain: false })
      .catch(() => {});
    return await answered;
  } finally {
    clearTimeout(timer);
    await unsubscribe();
  }
}

async function invite(
  v: Values,
  env: Record<string, string | undefined>,
  io: IO,
  deps: PeerDeps,
): Promise<ExitCode> {
  const fields: Record<string, unknown> = {};
  if (v.ttl !== undefined) {
    try {
      fields.ttl_s = parsePositiveInt(v.ttl, "--ttl");
    } catch (e) {
      io.stderr(`volley peer invite: ${e instanceof Error ? e.message : String(e)}\n`);
      return EXIT.USAGE;
    }
  }
  if (v.for !== undefined) fields.for = v.for;
  const key = replyKeyPair();
  const a = await ask("invite", "peer_invite", { ...fields, reply_key: key.jwk }, v, env, io, true);
  if (typeof a === "number") return a;
  const code = unseal(key.privateKey, a.sealed)?.code;
  if (typeof code !== "string") {
    io.stderr("volley peer invite: volleyd's answer carried no code\n");
    return EXIT.ERROR;
  }
  const r = (a.result ?? {}) as { expires_at?: string };
  // join needs --repo (the doctor blocks without a clone of the wave repo there).
  const join = `volley peer join ${code} --to ${deps.user()}@${deps.hostname()} --repo <path to its clone of the wave repo>`;
  io.stdout(
    v.for !== undefined
      ? `Pairing code: ${code} (single use, valid until ${r.expires_at ?? "it expires"}); it re-pairs ${v.for} only.\n\nOn ${v.for}, run:\n  ${join} --name ${v.for} --replace\n`
      : `Pairing code: ${code} (single use, valid until ${r.expires_at ?? "it expires"})\n\nOn the machine to pair, run:\n  ${join}\n`,
  );
  return EXIT.OK;
}

async function remove(
  name: string,
  v: Values,
  env: Record<string, string | undefined>,
  io: IO,
): Promise<ExitCode> {
  const a = await ask("remove", "peer_remove", { name }, v, env, io, true);
  if (typeof a === "number") return a;
  const r = (a.result ?? {}) as { revoked?: boolean; host_removed?: boolean };
  io.stdout(
    `removed ${name}: ${r.revoked === true ? "account revoked" : "no account"}, ${r.host_removed === true ? `hosts.${name} removed` : `no hosts.${name}`}, machine record cleared\nIts tunnel service stops at its next check.\n`,
  );
  return EXIT.OK;
}

interface MachineRow {
  name: string;
  os: string;
  cores: number;
  tunnel: string;
  reason?: string;
  load: number[];
  agents: number;
  last_seen: string;
}

async function list(v: Values, env: Record<string, string | undefined>, io: IO): Promise<ExitCode> {
  const a = await ask("list", "peers", {}, v, env, io);
  if (typeof a === "number") return a;
  if (v.json === true) {
    io.stdout(`${JSON.stringify(a.result, null, 2)}\n`);
    return EXIT.OK;
  }
  const r = a.result as { machines: MachineRow[]; hosts: string[] };
  if (r.machines.length === 0 && r.hosts.length === 0) io.stdout("no paired machines\n");
  for (const m of r.machines) {
    const why = m.reason !== undefined ? ` (${m.reason})` : "";
    io.stdout(
      `${m.name}\ttunnel ${m.tunnel}${why}\t${m.os} ${m.cores} cores\tload ${m.load.map((l) => l.toFixed(2)).join(" ")}\t${m.agents} agents\tlast seen ${m.last_seen}\n`,
    );
  }
  for (const h of r.hosts.filter((h) => !r.machines.some((m) => m.name === h))) {
    io.stdout(`${h}\tno heartbeat yet\n`);
  }
  return EXIT.OK;
}

/** `join`'s request, as `redeem` reads it on stdin. */
interface RedeemRequest {
  code: string;
  name: string;
  target: string;
  volley_dir: string;
  repo?: string;
  port?: number;
  os?: string;
  cores?: number;
  /** Re-pairing with a code from `invite --for <name>`: replace the account and hosts entry. */
  replace?: true;
}

async function redeem(
  v: Values,
  env: Record<string, string | undefined>,
  io: IO,
  deps: PeerDeps,
): Promise<ExitCode> {
  let req: RedeemRequest;
  try {
    req = JSON.parse(await deps.readStdin()) as RedeemRequest;
  } catch (e) {
    io.stderr(`volley peer redeem: stdin is not JSON: ${(e as Error).message}\n`);
    return EXIT.USAGE;
  }
  const key = replyKeyPair();
  const a = await ask("redeem", "peer_join", { ...req, reply_key: key.jwk }, v, env, io);
  if (typeof a === "number") return a;
  const creds = unseal(key.privateKey, a.sealed);
  if (typeof creds?.username !== "string" || typeof creds.password !== "string") {
    io.stderr("volley peer redeem: volleyd's answer carried no credentials\n");
    return EXIT.ERROR;
  }
  io.stdout(
    `${JSON.stringify({ ...(a.result as object), username: creds.username, password: creds.password })}\n`,
  );
  return EXIT.OK;
}

// ---------------------------------------------------------------------------------------------
// The machine to pair: join
// ---------------------------------------------------------------------------------------------

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");

/** `ssh -T <host> bash -s` with `script` on stdin: a remote step, never a command string. */
function remote(deps: PeerDeps, host: string, script: string): Promise<ExecResult> {
  return deps.exec(
    [
      "ssh",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      `ConnectTimeout=${PEER_DEFAULTS.ssh_connect_timeout_s}`,
      host,
      "bash",
      "-s",
    ],
    { input: script, timeoutMs: PEER_DEFAULTS.remote_exec_timeout_ms },
  );
}

/** A single-quoted shell word. */
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

async function join_(code: string, v: Values, io: IO, deps: PeerDeps): Promise<ExitCode> {
  const fail = (msg: string, exit: ExitCode = EXIT.ERROR) => {
    io.stderr(`volley peer join: ${msg}\n`);
    return exit;
  };
  const host = v.to as string;
  if (host.startsWith("-")) return fail("--to must be an ssh destination", EXIT.USAGE);
  const name = v.name ?? defaultName(deps.hostname());
  if (!NAME_RE.test(name)) {
    return fail(`name "${name}" must match [a-z0-9][a-z0-9_-]{0,62} (pass --name)`, EXIT.USAGE);
  }
  let port: number = PEER_DEFAULTS.remote_port;
  if (v.port !== undefined) {
    try {
      port = parsePositiveInt(v.port, "--port");
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e), EXIT.USAGE);
    }
  }
  const volleyDir = resolve(v["volley-dir"] ?? deps.volleyDir);
  const repo = v.repo !== undefined ? resolve(v.repo) : undefined;
  const target = v.target ?? `${deps.user()}@${deps.hostname()}`;
  if (target === "" || target.startsWith("-") || /\s/.test(target)) {
    return fail("--target must be an ssh destination (user@host)", EXIT.USAGE);
  }

  // 0. The doctor: a block check stops the join before the code is used, so it stays valid.
  io.stdout("Checking this machine (volley peer doctor)...\n");
  const checked = await runDoctor(
    { ...deps, volleyDir },
    { ...(repo !== undefined ? { repo } : {}) },
  );
  const blocked = blocking(checked.report);
  // Trust is reported after pairing (step 5), with what to do about it.
  const failing = checked.report.checks.filter((c) => !c.ok && c.id !== "claude.trust");
  if (blocked.length > 0) {
    io.stdout(renderHuman(failing));
    const doctorCmd = [
      "volley peer doctor --fix",
      `--repo ${repo !== undefined ? sq(repo) : "<path>"}`,
      ...(v["volley-dir"] !== undefined ? [`--volley-dir ${sq(volleyDir)}`] : []),
    ].join(" ");
    return fail(
      `${blocked.length} check(s) above keep this machine from running agents: fix them (\`${doctorCmd}\` applies the safe ones) and run join again. Nothing was redeemed: the code is still valid.`,
    );
  }
  io.stdout(failing.length > 0 ? renderHuman(failing) : "All checks passed.\n");

  // 1. ssh reachability.
  io.stdout(`Checking ssh to ${host}...\n`);
  const probe = await remote(deps, host, "echo volley-peer-ok\n");
  if (probe.code !== 0 || !probe.stdout.includes("volley-peer-ok")) {
    return fail(
      `cannot reach ${host} over ssh (${probe.stderr.trim() || `exit ${probe.code}`}); set up key-based ssh to it first`,
    );
  }

  // 2. On the host: check it can ssh back here (every spawn on this machine needs it), then
  // redeem the code (its volleyd creates the peer account and hosts.<name>).
  const request: RedeemRequest = {
    code,
    name,
    target,
    volley_dir: volleyDir,
    ...(repo !== undefined ? { repo } : {}),
    port,
    os: deps.platform,
    cores: deps.cpus(),
    ...(v.replace === true ? { replace: true as const } : {}),
  };
  const remoteVolley = v["remote-volley"] ?? "volley";
  const redeemed = await remote(deps, host, redeemScript(request, remoteVolley));
  if (redeemed.code === NO_SSH_BACK) {
    return fail(
      `${host} cannot ssh to ${target}: authorise its key here, or pass --target with an address it can reach. Nothing was redeemed: the code is still valid.\n${redeemed.stderr.trim()}`,
    );
  }
  if (redeemed.code !== 0) {
    return fail(`pairing refused on ${host}: ${redeemed.stderr.trim() || `exit ${redeemed.code}`}`);
  }
  let joined: {
    name: string;
    namespace: string;
    broker: { host: string; port: number };
    remote_port: number;
    username: string;
    password: string;
  };
  try {
    joined = JSON.parse(redeemed.stdout.trim().split("\n").pop() ?? "");
  } catch {
    return fail(`${host} printed no pairing answer`);
  }

  // 3. ~/.volley/peer.json (the service's whole configuration).
  const cfg: PeerConfig = {
    name: joined.name,
    host,
    target,
    namespace: joined.namespace,
    broker: joined.broker,
    remote_port: joined.remote_port,
    username: joined.username,
    password: joined.password,
    ...(repo !== undefined ? { repo } : {}),
    joined_at: deps.now().toISOString(),
  };
  const file = peerFile(deps.home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  io.stdout(`Paired as ${cfg.name}: account and hosts.${cfg.name} created on ${host}.\n`);
  io.stdout(`Wrote ${file}.\n`);

  // 4. The tunnel + heartbeat service.
  let serviceError: string | undefined;
  if (v["no-service"] === true) {
    io.stdout(
      "Service not installed (--no-service): run `volley peer run` to keep the tunnel up.\n",
    );
  } else {
    const installed = await installService(deps);
    if (!installed.ok) serviceError = installed.error;
    else if (installed.warning !== undefined) {
      io.stdout(`Installed the tunnel service: ${installed.what}, but:\n`);
      io.stderr(`volley peer join: ${installed.warning}\n`);
    } else io.stdout(`Installed the tunnel service: ${installed.what}.\n`);
  }

  // 5. Claude Code's folder trust for the repo (T4: an untrusted repo opens repo_untrusted).
  printTrust(io, deps, repo, cfg.name);

  // The pairing is done on the host either way: say how to finish, or how to start over.
  if (serviceError !== undefined) {
    return fail(
      `the tunnel service was not installed: ${serviceError}\nThis machine is paired as ${cfg.name} (${file}). Keep the tunnel up with \`volley peer run\` (or fix the error and install it yourself), or start over: \`volley peer remove ${cfg.name}\` on ${host}, then join again with a new code.`,
    );
  }

  // 6. Register the machine (the service re-publishes every heartbeat).
  const registered = await register(deps, cfg, checked.report);
  io.stdout(
    registered
      ? `Registered: volley/_system/machines/${cfg.name} (tunnel up).\n`
      : `The tunnel is not up yet; the service registers ${cfg.name} once it is (\`volley peer list\` on ${host}).\n`,
  );
  return EXIT.OK;
}

/** The short hostname, lower-cased, as a valid name. */
export function defaultName(hostname: string): string {
  return (hostname.split(".")[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 63);
}

/** Exit status of the redeem script when the host cannot ssh to this machine. */
const NO_SSH_BACK = 3;

/**
 * The script `join` runs on the host: check that the host reaches this machine over ssh, as
 * volleyd will for every spawn here (before the code is used up), then redeem the code.
 * `ssh -n`: the inner ssh must not read the rest of this script from bash's stdin.
 */
export function redeemScript(request: RedeemRequest, remoteVolley: string): string {
  const t = sq(request.target);
  return [
    "set -o pipefail",
    `if ! ssh -n -o BatchMode=yes -o ConnectTimeout=${PEER_DEFAULTS.ssh_connect_timeout_s} ${t} true; then`,
    `  echo "the supervisor's machine cannot ssh to "${t} >&2`,
    `  exit ${NO_SSH_BACK}`,
    "fi",
    `printf '%s' ${sq(b64(JSON.stringify(request)))} | base64 -d | ${remoteVolley} peer redeem`,
    "",
  ].join("\n");
}

function printTrust(io: IO, deps: PeerDeps, repo: string | undefined, name: string): void {
  if (repo === undefined) {
    io.stdout(
      `No --repo given: wave files that target host ${name} must name its repo (host: { repo: ... }).\n`,
    );
    return;
  }
  let trusted = false;
  try {
    trusted = isRepoTrusted(
      JSON.parse(readFileSync(join(deps.home, ".claude.json"), "utf-8")),
      repo,
    );
  } catch {}
  io.stdout(
    trusted
      ? `Claude Code trusts ${repo} on this machine.\n`
      : `Claude Code does not trust ${repo} on this machine yet. Accept it now: run \`claude\` in ${repo} once and answer the trust dialog. Otherwise the first spawn here opens a repo_untrusted decision (answer \`trust\` to record it).\n`,
  );
}

/** Install and (re)start the service: what was installed, or why it could not be. */
async function installService(
  deps: PeerDeps,
): Promise<{ ok: true; what: string; warning?: string } | { ok: false; error: string }> {
  const argv = [...deps.volleyArgv, "peer", "run"];
  if (deps.platform === "linux") {
    const unit = join(deps.home, ".config", "systemd", "user", SYSTEMD_UNIT);
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, systemdUnit(argv, deps.envPath()));
    // Without lingering, systemd stops a user's services when their last session ends (the ssh
    // session this join runs in) and starts them only at their next login.
    const user = deps.user();
    const linger = await deps.exec(["loginctl", "enable-linger", user]);
    const warning =
      linger.code === 0
        ? undefined
        : `lingering is off for ${user} (${linger.stderr.trim() || `loginctl exit ${linger.code}`}): the service stops when you log out and starts only at your next login. Run \`sudo loginctl enable-linger ${user}\`.`;
    // restart, not enable --now: a re-join must replace a running service's old peer.json.
    for (const step of [
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", SYSTEMD_UNIT],
      ["systemctl", "--user", "restart", SYSTEMD_UNIT],
    ]) {
      const r = await deps.exec(step);
      if (r.code !== 0) {
        return {
          ok: false,
          error: `${step.join(" ")} failed: ${r.stderr.trim() || `exit ${r.code}`}`,
        };
      }
    }
    return {
      ok: true,
      what: `systemd user unit ${unit}`,
      ...(warning !== undefined ? { warning } : {}),
    };
  }
  if (deps.platform === "darwin") {
    const plist = join(deps.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(
      plist,
      launchdPlist(argv, join(deps.home, ".volley", "peer.log"), deps.envPath()),
    );
    // gui/<uid> needs a console login; a Mac paired over ssh with nobody at the console has only
    // user/<uid>. A service from an earlier join is replaced (bootout fails harmlessly).
    const domains = [`gui/${deps.uid()}`, `user/${deps.uid()}`];
    for (const d of domains) await deps.exec(["launchctl", "bootout", `${d}/${LAUNCHD_LABEL}`]);
    const errors: string[] = [];
    for (const domain of domains) {
      const r = await deps.exec(["launchctl", "bootstrap", domain, plist]);
      if (r.code === 0) return { ok: true, what: `launchd agent ${plist} (domain ${domain})` };
      errors.push(`${domain}: ${r.stderr.trim() || `exit ${r.code}`}`);
    }
    return { ok: false, error: `launchctl bootstrap failed (${errors.join("; ")})` };
  }
  return {
    ok: false,
    error: `no service manager for ${deps.platform}: pass --no-service and run \`volley peer run\``,
  };
}

/**
 * The service files carry `join`'s PATH: the doctor in every heartbeat must find the tools the
 * person's own terminal finds (a user service's default PATH, launchd's above all, is bare).
 */
export function systemdUnit(argv: string[], path?: string): string {
  const quote = (a: string) =>
    /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/(["\\])/g, "\\$1")}"`;
  return `[Unit]
Description=Volley peer: broker tunnel and machine heartbeat (volley peer run)

[Service]
ExecStart=${argv.map(quote).join(" ")}
${path !== undefined && path !== "" ? `Environment=${quote(`PATH=${path.replace(/%/g, "%%")}`)}\n` : ""}# Exit 0 means the peer account was revoked (volley peer remove): stay stopped.
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

export function launchdPlist(argv: string[], log: string, path?: string): string {
  const x = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    <string>${x(a)}</string>`).join("\n")}
  </array>
${path !== undefined && path !== "" ? `  <key>EnvironmentVariables</key>\n  <dict><key>PATH</key><string>${x(path)}</string></dict>\n` : ""}  <key>RunAtLoad</key><true/>
  <!-- Exit 0 means the peer account was revoked (volley peer remove): stay stopped. -->
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${x(log)}</string>
  <key>StandardErrorPath</key><string>${x(log)}</string>
</dict>
</plist>
`;
}

// ---------------------------------------------------------------------------------------------
// The machine record and the service
// ---------------------------------------------------------------------------------------------

export const machineTopic = (name: string) => `volley/_system/machines/${name}`;

/** Agent sessions on this machine: its tmux sessions (0 when no tmux server runs). */
async function agentCount(deps: PeerDeps): Promise<number> {
  const r = await deps.exec(["tmux", "list-sessions", "-F", "#{session_name}"]).catch(() => null);
  if (r === null || r.code !== 0) return 0;
  return r.stdout.split("\n").filter((l) => l.trim() !== "").length;
}

/**
 * The Fleet fields of the record (SPEC §4.6.15): `kind`, `memory`, `disk` and `uptime_s` every
 * heartbeat (no command runs), and the last doctor run's `versions`, `auth`, `repo`, `checks`
 * (without fix text) and `doctor_at`.
 */
function fleetFields(deps: PeerDeps, cfg: PeerConfig, d: DoctorReport | null) {
  const root = worktreeRoot(cfg.repo ?? null, deps.home);
  let st: ReturnType<PeerDeps["statfs"]> = null;
  for (let p = root; st === null; p = dirname(p)) {
    if (existsSync(p)) st = deps.statfs(p);
    if (dirname(p) === p) break;
  }
  // macOS counts reclaimable memory as used: keep the doctor's memory_pressure reading there.
  const memory =
    deps.platform === "darwin" && d !== null
      ? memoryOf(deps.totalmem(), deps.freemem(), d.memory.available_pct)
      : memoryOf(deps.totalmem(), deps.freemem());
  return {
    kind: "peer" as const,
    memory,
    ...(st !== null ? { disk: diskOf(root, st) } : {}),
    uptime_s: Math.max(0, Math.floor(deps.uptime())),
    ...(d !== null
      ? {
          versions: d.versions,
          auth: d.auth,
          ...(d.repo !== undefined ? { repo: d.repo } : {}),
          checks: recordChecks(d),
          doctor_at: d.doctor_at,
        }
      : {}),
  };
}

/** The `machine.schema.json` envelope for this machine, with the last doctor run's result. */
export async function machineEnvelope(
  deps: PeerDeps,
  cfg: PeerConfig,
  tunnel: "up" | "down",
  doctorReport: DoctorReport | null = null,
): Promise<string> {
  return JSON.stringify(
    buildEnvelope({
      agentId: cfg.name,
      parentId: null,
      channel: "_system/machines",
      type: "machine",
      payload: {
        name: cfg.name,
        os: deps.platform,
        arch: deps.arch,
        cores: deps.cpus(),
        tunnel,
        ...(tunnel === "down" ? { reason: "disconnect" } : {}),
        load: deps.loadavg().map((l) => Math.max(0, Math.round(l * 100) / 100)),
        agents: await agentCount(deps),
        remote_port: cfg.remote_port,
        ...fleetFields(deps, cfg, doctorReport),
        last_seen: deps.now().toISOString(),
      },
    }),
  );
}

const brokerThroughTunnel = (cfg: PeerConfig) => `mqtt://127.0.0.1:${cfg.remote_port}`;
const peerAuth = (cfg: PeerConfig): BrokerAuth => ({
  username: cfg.username,
  password: cfg.password,
});

/** Connect through the tunnel as the peer, its LWT the record with `tunnel: down`. */
async function connectPeer(
  deps: PeerDeps,
  cfg: PeerConfig,
  d: DoctorReport | null,
): Promise<VolleyBroker> {
  return deps.connect(brokerThroughTunnel(cfg), peerAuth(cfg), {
    topic: machineTopic(cfg.name),
    payload: await machineEnvelope(deps, cfg, "down", d),
    retain: true,
  });
}

/**
 * The volley version the supervisor requires of this machine: its retained readiness verdict's
 * `requirements.volley`, believed only from the supervisor's own identities (SPEC §4.6.15).
 */
async function requiredVolley(broker: VolleyBroker, name: string): Promise<string | null> {
  const raw = await broker
    .queryRetained(`${machineTopic(name)}/readiness`, PEER_DEFAULTS.readiness_wait_ms)
    .catch(() => null);
  const e = raw !== null ? parseEnvelope(raw) : null;
  if (e === null || !["volleyd", "supervisor"].includes(e.agent_id)) return null;
  const v = (e.payload as { requirements?: { volley?: unknown } } | null)?.requirements?.volley;
  // Never one that starts with "-": it ends up in a git argv.
  return typeof v === "string" && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(v) ? v : null;
}

/** The doctor as `run` and the `doctor` verb run it for a paired machine. */
async function peerDoctor(
  deps: PeerDeps,
  cfg: PeerConfig,
  broker: VolleyBroker | null,
): Promise<DoctorReport> {
  const required = broker !== null ? await requiredVolley(broker, cfg.name) : null;
  const { report } = await runDoctor(deps, {
    ...(cfg.repo !== undefined ? { repo: cfg.repo } : {}),
    requiredVolley: required,
  });
  return report;
}

/** Publish the record once (join's registration), waiting a little for the fresh tunnel. */
async function register(deps: PeerDeps, cfg: PeerConfig, d: DoctorReport): Promise<boolean> {
  for (let i = 0; i < PEER_DEFAULTS.register_attempts; i++) {
    try {
      const b = await deps.connect(brokerThroughTunnel(cfg), peerAuth(cfg));
      try {
        await b.publish(machineTopic(cfg.name), await machineEnvelope(deps, cfg, "up", d), {
          qos: 1,
          retain: true,
        });
      } finally {
        await b.disconnect();
      }
      return true;
    } catch (e) {
      if (e instanceof VolleyError && e.code === "AUTH_FAILED") return false;
      await deps.sleep(PEER_DEFAULTS.register_wait_ms);
    }
  }
  return false;
}

/** `ssh -N -L 127.0.0.1:<port>:<broker>`: this machine's port reaches the host's broker. */
export function tunnelArgv(cfg: PeerConfig): string[] {
  return [
    "ssh",
    "-N",
    "-L",
    `127.0.0.1:${cfg.remote_port}:${cfg.broker.host}:${cfg.broker.port}`,
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    `ServerAliveInterval=${PEER_DEFAULTS.ssh_alive_interval_s}`,
    "-o",
    `ConnectTimeout=${PEER_DEFAULTS.ssh_connect_timeout_s}`,
    cfg.host,
  ];
}

export function readPeerConfig(home: string): PeerConfig {
  const file = peerFile(home);
  if (!existsSync(file))
    throw new Error(`${file} not found: pair this machine with \`volley peer join\``);
  const cfg = JSON.parse(readFileSync(file, "utf-8")) as PeerConfig;
  for (const k of ["name", "host", "username", "password"] as const) {
    if (typeof cfg[k] !== "string") throw new Error(`${file}: no ${k}`);
  }
  return cfg;
}

/**
 * The service: keep the tunnel up (restarting ssh with backoff) and publish the machine record
 * every heartbeat through it. Ends with exit 0 when the broker refuses the peer account (it was
 * revoked: the service manager leaves it stopped), or when `signal` aborts (tests).
 */
export async function runService(io: IO, deps: PeerDeps, signal?: AbortSignal): Promise<ExitCode> {
  let cfg: PeerConfig;
  try {
    cfg = readPeerConfig(deps.home);
  } catch (e) {
    io.stderr(`volley peer run: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.ERROR;
  }
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  signal?.addEventListener("abort", onAbort);
  const tunnel = (async () => {
    let backoff: number = PEER_DEFAULTS.tunnel_restart_ms;
    while (!stop.signal.aborted) {
      const started = deps.now().getTime();
      const r = await deps.exec(tunnelArgv(cfg), { signal: stop.signal }).catch((e: unknown) => ({
        code: -1,
        stdout: "",
        stderr: e instanceof Error ? e.message : String(e),
      }));
      if (stop.signal.aborted) break;
      io.stderr(`volley peer run: tunnel exited ${r.code}: ${r.stderr.trim()}\n`);
      if (deps.now().getTime() - started > PEER_DEFAULTS.tunnel_restart_max_ms) {
        backoff = PEER_DEFAULTS.tunnel_restart_ms;
      }
      await deps.sleep(backoff, stop.signal);
      backoff = Math.min(backoff * 2, PEER_DEFAULTS.tunnel_restart_max_ms);
    }
  })();
  let broker: VolleyBroker | null = null;
  let exit: ExitCode = EXIT.OK;
  // The last finished doctor run. The doctor runs beside the heartbeat (every doctor_interval_s,
  // bounded by doctor_timeout_ms): its probes reach the network, and a beat that waited on them
  // could miss the supervisor's machine_down_after_ms. Beats in between repeat its last result;
  // the beat after a run finishes is published at once.
  let report: DoctorReport | null = null;
  let doctorAt = Number.NEGATIVE_INFINITY;
  let doctoring = false;
  const startDoctor = (b: VolleyBroker) => {
    doctoring = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`gave up after ${PEER_DEFAULTS.doctor_timeout_ms} ms`)),
        PEER_DEFAULTS.doctor_timeout_ms,
      );
      // Never what keeps the process alive after the service stops.
      timer.unref?.();
    });
    void Promise.race([peerDoctor(deps, cfg, b), timeout])
      .then(async (r) => {
        report = r;
        if (stop.signal.aborted || broker === null) return;
        await broker
          .publish(machineTopic(cfg.name), await machineEnvelope(deps, cfg, "up", r), {
            qos: 1,
            retain: true,
          })
          .catch(() => {});
      })
      .catch((e: unknown) => {
        io.stderr(`volley peer run: doctor: ${e instanceof Error ? e.message : String(e)}\n`);
      })
      .finally(() => {
        clearTimeout(timer);
        doctoring = false;
      });
  };
  try {
    while (!stop.signal.aborted) {
      try {
        broker ??= await connectPeer(deps, cfg, report);
        const now = deps.monotonic();
        if (!doctoring && now - doctorAt >= PEER_DEFAULTS.doctor_interval_s * 1000) {
          doctorAt = now;
          startDoctor(broker);
        }
        await broker.publish(
          machineTopic(cfg.name),
          await machineEnvelope(deps, cfg, "up", report),
          { qos: 1, retain: true },
        );
      } catch (e) {
        if (e instanceof VolleyError && e.code === "AUTH_FAILED") {
          io.stderr(
            `volley peer run: the broker refused ${cfg.username}: this machine was unpaired (volley peer remove); stopping the tunnel\n`,
          );
          break;
        }
        // The tunnel is down or restarting: the next heartbeat tries again.
        await broker?.disconnect().catch(() => {});
        broker = null;
      }
      await deps.sleep(PEER_DEFAULTS.heartbeat_ms, stop.signal);
    }
  } catch (e) {
    io.stderr(`volley peer run: ${e instanceof Error ? e.message : String(e)}\n`);
    exit = EXIT.ERROR;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    stop.abort();
    await tunnel;
    // A clean disconnect suppresses the LWT: say the tunnel is down ourselves.
    if (broker !== null) {
      await broker
        .publish(machineTopic(cfg.name), await machineEnvelope(deps, cfg, "down", report), {
          qos: 1,
          retain: true,
        })
        .catch(() => {});
      await broker.disconnect().catch(() => {});
    }
  }
  return exit;
}

// ---------------------------------------------------------------------------------------------
// The doctor verb
// ---------------------------------------------------------------------------------------------

/** A URL with a password or a token in it: never cloned from, never printed. */
const hasCredential = (url: string) =>
  looksSecret(url) || /^[a-z][a-z0-9+.-]*:\/\/[^/@]*:[^/@]*@/i.test(url);

/**
 * `volley peer doctor`: the repo defaults to peer.json's, and on a paired machine the supervisor's
 * version requirement is read from its readiness verdict through the tunnel (when it is up).
 */
async function doctorVerb(v: Values, io: IO, deps: PeerDeps): Promise<ExitCode> {
  if (v.origin !== undefined && hasCredential(v.origin)) {
    io.stderr(
      "volley peer doctor: --origin must not carry a password or token (gh auth setup-git signs git in)\n",
    );
    return EXIT.USAGE;
  }
  if (v.origin?.startsWith("-")) {
    io.stderr("volley peer doctor: --origin must be the wave repo's URL\n");
    return EXIT.USAGE;
  }
  if (v.clone === true && v.fix !== true) {
    io.stderr("volley peer doctor: --clone needs --fix\n");
    return EXIT.USAGE;
  }
  let cfg: PeerConfig | null = null;
  try {
    if (existsSync(peerFile(deps.home))) cfg = readPeerConfig(deps.home);
  } catch {}
  let required: string | null = null;
  if (cfg !== null) {
    const b = await deps.connect(brokerThroughTunnel(cfg), peerAuth(cfg)).catch(() => null);
    if (b !== null) {
      required = await requiredVolley(b, cfg.name);
      await b.disconnect().catch(() => {});
    }
  }
  const repo = v.repo ?? cfg?.repo;
  const opts: DoctorOptions = {
    ...(repo !== undefined ? { repo: resolve(repo) } : {}),
    ...(v.origin !== undefined ? { origin: v.origin } : {}),
    ...(v.release !== undefined ? { release: v.release } : {}),
    requiredVolley: required,
    json: v.json === true,
    fix: v.fix === true,
    yes: v.yes === true,
    clone: v.clone === true,
  };
  return doctor(io, { ...deps, volleyDir: resolve(v["volley-dir"] ?? deps.volleyDir) }, opts);
}

// ---------------------------------------------------------------------------------------------
// Real dependencies
// ---------------------------------------------------------------------------------------------

const realExec: PeerExec = (argv, opts = {}) =>
  new Promise((resolveExec) => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd as string, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (e) => resolveExec({ code: -1, stdout, stderr: stderr + e.message }));
    child.on("close", (code) => resolveExec({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(opts.input ?? "");
  });

function realDeps(): PeerDeps {
  const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
  return {
    exec: realExec,
    home: os.homedir(),
    platform: process.platform,
    hostname: () => os.hostname(),
    user: () => os.userInfo().username,
    uid: () => os.userInfo().uid,
    arch: process.arch,
    cpus: () => Math.max(1, os.cpus().length),
    loadavg: () => os.loadavg() as [number, number, number],
    now: () => new Date(),
    monotonic: () => performance.now(),
    envPath: () => process.env.PATH,
    sleep: (ms, signal) =>
      new Promise((r) => {
        const t = setTimeout(r, ms);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          r();
        });
      }),
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(c as Buffer);
      return Buffer.concat(chunks).toString("utf-8");
    },
    volleyArgv: [process.execPath, cli],
    // packages/volley-cli/src/commands → the checkout root.
    volleyDir: resolve(dirname(cli), "..", "..", ".."),
    shell: () => os.userInfo().shell ?? process.env.SHELL ?? "/bin/sh",
    version: pkg.version,
    totalmem: () => os.totalmem(),
    freemem: () => os.freemem(),
    uptime: () => os.uptime(),
    statfs: (path) => {
      try {
        const s = statfsSync(path);
        return { bsize: Number(s.bsize), blocks: Number(s.blocks), bavail: Number(s.bavail) };
      } catch {
        return null;
      }
    },
    confirm: async (question) => {
      if (process.stdin.isTTY !== true) return false;
      // stderr: under --fix --json, stdout is the report alone.
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
      } finally {
        rl.close();
      }
    },
    connect: async (url, auth, will) => {
      const { VolleyBroker } = await import("volley-mcp/broker");
      const b = new VolleyBroker();
      await b.connect({
        url,
        agentId: `peer-${randomSuffix(8)}`,
        ...(will !== undefined
          ? { willTopic: will.topic, willPayload: will.payload, willRetain: will.retain }
          : {}),
        ...(auth ?? {}),
      });
      return b;
    },
  };
}
