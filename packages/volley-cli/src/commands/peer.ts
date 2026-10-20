import { spawn, spawnSync } from "node:child_process";
import {
  constants,
  type KeyObject,
  generateKeyPairSync,
  privateDecrypt,
  randomUUID,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { VolleyBroker } from "volley-mcp/broker";
import { type BrokerAuth, readCoordinatorAuth } from "volley-mcp/config";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { VolleyError } from "volley-mcp/errors";
import { buildTopic } from "volley-mcp/topics";
import { randomSuffix } from "volley-mcp/util";
import { parsePositiveInt, resolveAuth, resolveBrokerUrl, resolveNamespace } from "../args";
import { withSetupAuthDir } from "../auth/coordinator-login";
import { DYNSEC_ADMIN_USER, FIXED_IDENTITIES } from "../auth/roles";
import { openClient, reportConnectError } from "../connect";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";
import { isLoaded, reloadLaunchd, unloadLaunchd } from "../setup/launchd";
import { readAccounts } from "./auth-accounts";
import { authOpsTopic } from "./auth-roles";

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
 */

const HELP = `Usage:
  On the supervisor's machine:
    volley peer invite [--ttl <seconds>]       A one-time pairing code (XXXX-XXXX, 10 min)
    volley peer list [--json]                  Paired machines and their health
    volley peer remove <name>                  Unpair: revoke its account, drop hosts.<name>
  On the machine to pair:
    volley peer join <code> --to <host> [--name <name>] [--target <user@this-machine>]
                     [--repo <path>] [--volley-dir <path>] [--port <port>]
                     [--remote-volley <command>] [--no-service]
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

Host options (invite, list, remove, redeem):
  --broker-url <url>   MQTT broker URL (env: VOLLEY_BROKER_URL; default: mqtt://localhost:1883)
  --namespace <ns>     volleyd's namespace (env: VOLLEY_NAMESPACE; default: default)
  --username <user>    Broker username (env: VOLLEY_AUTH_USERNAME; list and redeem: else
                       coordinator.json in VOLLEY_AUTH_DIR or the auth dir \`volley setup\`
                       recorded). invite and remove need an admin account.
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
  ttl: { type: "string" },
  json: { type: "boolean" },
  timeout: { type: "string" },
  "broker-url": { type: "string" },
  namespace: { type: "string" },
  username: { type: "string" },
  password: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

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

/** Everything `volley peer` touches outside the broker, injectable for tests. */
export interface PeerDeps {
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
  /** Where `cmd` is on this shell's PATH (for the fix join prints), or null. */
  which?: (cmd: string) => string | null;
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
  switch (verb) {
    case "invite":
      if (pos.length !== 0) return usage("takes no arguments");
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
    // Over ssh (redeem) there is rarely a VOLLEY_AUTH_* env: the coordinator's file serves, from
    // the auth dir `volley setup` recorded when VOLLEY_AUTH_DIR does not name one.
    auth = resolveAuth({ username: v.username, password: v.password }, env);
    if (!admin) auth ??= readCoordinatorAuth(withSetupAuthDir(env));
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
  // The broker drops a non-admin's op without a word: refuse at once when this machine's
  // account registry already says the login is not an admin, instead of waiting out the timeout.
  const notAdmin = admin && auth !== null ? localNotAdmin(auth.username, env) : null;
  if (notAdmin !== null) {
    io.stderr(
      `volley peer ${verb}: ${notAdmin}; ${ADMIN_ONLY}: pass --username <admin> (password in VOLLEY_AUTH_PASSWORD), e.g. the admin account \`volley setup\` created\n`,
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

/**
 * Why `username` is not an admin account by this machine's own records (a fixed identity, or an
 * account of another role in the auth dir's accounts.json), or null when they do not say.
 */
export function localNotAdmin(
  username: string,
  env: Record<string, string | undefined>,
): string | null {
  if (
    (FIXED_IDENTITIES as readonly string[]).includes(username) ||
    username === DYNSEC_ADMIN_USER
  ) {
    return `${username} is a fixed identity, not an admin account`;
  }
  const dir = withSetupAuthDir(env).VOLLEY_AUTH_DIR;
  if (dir === undefined || dir === "") return null;
  try {
    const account = readAccounts(dir).find((a) => a.name === username);
    return account !== undefined && account.role !== "admin"
      ? `${username} is a ${account.role} account, not an admin one (${join(dir, "accounts.json")})`
      : null;
  } catch {
    return null;
  }
}

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
  const key = replyKeyPair();
  const a = await ask("invite", "peer_invite", { ...fields, reply_key: key.jwk }, v, env, io, true);
  if (typeof a === "number") return a;
  const code = unseal(key.privateKey, a.sealed)?.code;
  if (typeof code !== "string") {
    io.stderr("volley peer invite: volleyd's answer carried no code\n");
    return EXIT.ERROR;
  }
  const r = (a.result ?? {}) as { expires_at?: string };
  io.stdout(
    `Pairing code: ${code} (single use, valid until ${r.expires_at ?? "it expires"})\n\nOn the machine to pair, run:\n  volley peer join ${code} --to ${deps.user()}@${deps.hostname()}\n`,
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

  // 1. ssh reachability.
  io.stdout(`Checking ssh to ${host}...\n`);
  const probe = await remote(deps, host, "echo volley-peer-ok\n");
  if (probe.code !== 0 || !probe.stdout.includes("volley-peer-ok")) {
    const key = hostKeyHint(probe.stderr, host);
    return fail(
      key !== null
        ? `${key} Nothing was redeemed: the code is still valid.`
        : `cannot reach ${host} over ssh (${probe.stderr.trim() || `exit ${probe.code}`}); set up key-based ssh to it first`,
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
  };
  const remoteVolley = v["remote-volley"] ?? "volley";
  const redeemed = await remote(deps, host, redeemScript(request, remoteVolley));
  if (redeemed.code === NO_SSH_BACK) {
    const key = hostKeyHint(redeemed.stderr, target, host);
    return fail(
      key !== null
        ? `${key} Nothing was redeemed: the code is still valid.\n${redeemed.stderr.trim()}`
        : `${host} cannot ssh to ${target}: authorise its key here, or pass --target with an address it can reach. Nothing was redeemed: the code is still valid.\n${redeemed.stderr.trim()}`,
    );
  }
  if (redeemed.code === NO_TOOLS) {
    return fail(
      `${missingToolsFix(redeemed.stderr, target, deps)} Nothing was redeemed: the code is still valid.`,
    );
  }
  if (redeemed.code === NO_PROBE) {
    return fail(
      `${host} could not check ${AGENT_TOOLS.join(", ").replace(/, ([^,]*)$/, " and $1")} on ${target}'s ssh PATH: ${redeemed.stderr.trim()}. Nothing was redeemed: the code is still valid.`,
    );
  }
  if (redeemed.code === 127) {
    // The shell found no such command: nothing ran on the host, so the code was not used.
    return fail(
      `pairing refused on ${host}: ${redeemed.stderr.trim() || "command not found"}\n${missingCommandHint(redeemed.stderr, host, remoteVolley)} Nothing was redeemed: the code is still valid.`,
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
  const registered = await register(deps, cfg);
  io.stdout(
    registered
      ? `Registered: volley/_system/machines/${cfg.name} (tunnel up).\n`
      : `The tunnel is not up yet; the service registers ${cfg.name} once it is (\`volley peer list\` on ${host}).\n`,
  );
  return EXIT.OK;
}

/**
 * ssh refusing a host key, in plain words with the one-time fix; null when that is not the
 * failure. `from`: where the failing ssh ran (unset: this machine).
 */
export function hostKeyHint(stderr: string, to: string, from?: string): string | null {
  const where = from === undefined ? "this machine" : from;
  const run = from === undefined ? "run" : `on ${from}, run`;
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .* has changed/i.test(stderr)) {
    return `${to}'s host key has changed since ${where} last saw it (a reinstall, or someone in between). If you expect the change, ${run} once: ssh-keygen -R ${to}, then ssh ${to} true (check the fingerprint, answer yes), and join again.`;
  }
  if (/Host key verification failed|No .*host key is known|host key is not known/i.test(stderr)) {
    return `${where === "this machine" ? "This machine" : where} does not trust ${to}'s host key yet (ssh has never connected there). ${from === undefined ? "Run" : `On ${from}, run`} once: ssh ${to} true (check the fingerprint, answer yes), then join again.`;
  }
  return null;
}

/**
 * The fix when this machine's non-interactive ssh PATH lacks what agents run (the redeem
 * script's NO_TOOLS answer): which file the login shell reads there, and the exact line, with the
 * directories this shell finds the tools in.
 */
export function missingToolsFix(stderr: string, target: string, deps: PeerDeps): string {
  const missing = (/volley-peer-missing:(.*)$/m.exec(stderr)?.[1] ?? "").trim().split(/\s+/);
  const shell = (/volley-peer-shell: *(\S*)$/m.exec(stderr)?.[1] ?? "").trim();
  const found = missing.map((c) => [c, deps.which?.(c) ?? null] as const);
  const dirs = [...new Set(found.flatMap(([, p]) => (p === null ? [] : [dirname(p)])))];
  const absent = found.filter(([, p]) => p === null).map(([c]) => c);
  const file =
    shell === "zsh"
      ? "~/.zshenv (zsh reads it for every shell; ~/.zshrc is for interactive ones only)"
      : shell === "bash"
        ? "the top of ~/.bashrc (above any line that returns early when the shell is not interactive)"
        : `the file your login shell (${shell || "unknown"}) reads for non-interactive commands`;
  return [
    `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not on the PATH of a non-interactive ssh session on ${target}, which is how volleyd starts agents here: the first spawn would die with "${missing[0]}: not found".`,
    ...(dirs.length > 0
      ? [`Add this line to ${file} on this machine:`, `  export PATH="${dirs.join(":")}:$PATH"`]
      : []),
    ...(absent.length > 0
      ? [
          `Install ${absent.join(", ")} on this machine${dirs.length > 0 ? " too" : ""}, and put ${absent.length === 1 ? "its directory" : "their directories"} on that PATH (${file}).`,
        ]
      : []),
    `Check with: ssh ${target} 'command -v ${missing.join(" ")}'. Then join again.`,
  ].join("\n");
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
/** Exit status of the redeem script when this machine's ssh PATH lacks what agents need. */
const NO_TOOLS = 4;
/** Exit status of the redeem script when the PATH check itself failed (ssh worked). */
const NO_PROBE = 5;

/** What an agent session on this machine runs: Claude Code, bun (its MCP server, hooks), tmux. */
export const AGENT_TOOLS = ["claude", "bun", "tmux"] as const;

/**
 * Run over the host's ssh to this machine, as volleyd's spawns run: from the login shell, not
 * interactive, so only its non-interactive startup file sets PATH. Run through `sh -c` (as
 * volleyd runs its steps through bash), so a login shell that is not POSIX (fish) still runs it
 * with its own PATH. Prints the missing tools and the login shell's name.
 */
const TOOLS_PROBE = `missing=; for c in ${AGENT_TOOLS.join(" ")}; do command -v "$c" >/dev/null 2>&1 || missing="$missing $c"; done; echo "volley-peer-missing:$missing"; echo "volley-peer-shell: \${SHELL##*/}"`;

/**
 * The script `join` runs on the host: check that the host reaches this machine over ssh, as
 * volleyd will for every spawn here, and that what an agent runs is on that ssh session's PATH
 * (before the code is used up), then redeem the code. `ssh -n`: the inner ssh must not read the
 * rest of this script from bash's stdin.
 */
export function redeemScript(request: RedeemRequest, remoteVolley: string): string {
  const t = sq(request.target);
  const ssh = `ssh -n -o BatchMode=yes -o ConnectTimeout=${PEER_DEFAULTS.ssh_connect_timeout_s} ${t}`;
  return [
    "set -o pipefail",
    `if ! ${ssh} true; then`,
    `  echo "the supervisor's machine cannot ssh to "${t} >&2`,
    `  exit ${NO_SSH_BACK}`,
    "fi",
    `tools=$(${ssh} ${sq(`sh -c ${sq(TOOLS_PROBE)}`)}); rc=$?`,
    // 255: ssh's own failure. Anything else: ssh worked and the check did not.
    `if [ "$rc" -eq 255 ]; then echo "the supervisor's machine cannot ssh to "${t} >&2; exit ${NO_SSH_BACK}; fi`,
    `if [ "$rc" -ne 0 ]; then echo "the PATH check exited $rc" >&2; exit ${NO_PROBE}; fi`,
    `case "$tools" in *"volley-peer-missing: "*) printf '%s\\n' "$tools" >&2; exit ${NO_TOOLS};; esac`,
    `printf '%s' ${sq(b64(JSON.stringify(request)))} | base64 -d | ${remoteVolley} peer redeem`,
    "",
  ].join("\n");
}

/**
 * True when `repo` or one of its parent directories has an accepted trust dialog: T4's rule
 * (volleyd's trust.ts `isRepoTrusted`, which this package cannot import).
 */
export function isRepoTrusted(claudeJson: unknown, repo: string): boolean {
  const projects = (claudeJson as { projects?: unknown } | null)?.projects;
  if (typeof projects !== "object" || projects === null) return false;
  const table = projects as Record<string, unknown>;
  for (let dir = resolve(repo); ; dir = dirname(dir)) {
    const entry = Object.hasOwn(table, dir) ? table[dir] : undefined;
    if (
      typeof entry === "object" &&
      entry !== null &&
      (entry as Record<string, unknown>).hasTrustDialogAccepted === true
    ) {
      return true;
    }
    if (dirname(dir) === dir) return false;
  }
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
    writeFileSync(unit, systemdUnit(argv));
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
    // gui/<uid> needs a console login; a Mac paired over ssh with nobody at the console has only
    // user/<uid>. A service from an earlier join is replaced, and put back when the new plist
    // will not load, so a failed re-join never leaves this machine without its tunnel.
    // Each bootout is waited out (setup/launchd.ts): a bootstrap while launchd is still letting
    // the old job go fails with EIO.
    const domains = [`gui/${deps.uid()}`, `user/${deps.uid()}`];
    const ld = { exec: (argv: string[]) => deps.exec(argv), sleep: (ms: number) => deps.sleep(ms) };
    const previous = existsSync(plist) ? readFileSync(plist, "utf-8") : null;
    let wasIn: string | undefined;
    for (const d of domains) {
      if (wasIn === undefined && (await isLoaded(ld, `${d}/${LAUNCHD_LABEL}`))) wasIn = d;
    }
    writeFileSync(plist, launchdPlist(argv, join(deps.home, ".volley", "peer.log")));
    for (const d of domains) await unloadLaunchd(ld, d, LAUNCHD_LABEL);
    const errors: string[] = [];
    for (const domain of domains) {
      const r = await reloadLaunchd(ld, domain, LAUNCHD_LABEL, plist);
      if (r.ok) return { ok: true, what: `launchd agent ${plist} (domain ${domain})` };
      errors.push(`${domain}: ${r.error}`);
    }
    const failed = `launchctl bootstrap failed (${errors.join("; ")})`;
    if (previous === null || wasIn === undefined) return { ok: false, error: failed };
    writeFileSync(plist, previous);
    const back = await reloadLaunchd(ld, wasIn, LAUNCHD_LABEL, plist);
    return {
      ok: false,
      error: back.ok
        ? `${failed}. Restored the previous ${plist} and loaded it again (domain ${wasIn}), so the tunnel service is up.`
        : `${failed}. Restored the previous ${plist}, but it did not load either (${back.error}): the tunnel is down until \`launchctl bootstrap ${wasIn} ${plist}\` succeeds.`,
    };
  }
  return {
    ok: false,
    error: `no service manager for ${deps.platform}: pass --no-service and run \`volley peer run\``,
  };
}

export function systemdUnit(argv: string[]): string {
  const quote = (a: string) =>
    /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/(["\\])/g, "\\$1")}"`;
  return `[Unit]
Description=Volley peer: broker tunnel and machine heartbeat (volley peer run)

[Service]
ExecStart=${argv.map(quote).join(" ")}
# Exit 0 means the peer account was revoked (volley peer remove): stay stopped.
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

export function launchdPlist(argv: string[], log: string): string {
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
  <key>RunAtLoad</key><true/>
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

/** The `machine.schema.json` envelope for this machine. */
export async function machineEnvelope(
  deps: PeerDeps,
  cfg: PeerConfig,
  tunnel: "up" | "down",
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
async function connectPeer(deps: PeerDeps, cfg: PeerConfig): Promise<VolleyBroker> {
  return deps.connect(brokerThroughTunnel(cfg), peerAuth(cfg), {
    topic: machineTopic(cfg.name),
    payload: await machineEnvelope(deps, cfg, "down"),
    retain: true,
  });
}

/** Publish the record once (join's registration), waiting a little for the fresh tunnel. */
async function register(deps: PeerDeps, cfg: PeerConfig): Promise<boolean> {
  for (let i = 0; i < PEER_DEFAULTS.register_attempts; i++) {
    try {
      const b = await deps.connect(brokerThroughTunnel(cfg), peerAuth(cfg));
      try {
        await b.publish(machineTopic(cfg.name), await machineEnvelope(deps, cfg, "up"), {
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
  try {
    while (!stop.signal.aborted) {
      try {
        broker ??= await connectPeer(deps, cfg);
        await broker.publish(machineTopic(cfg.name), await machineEnvelope(deps, cfg, "up"), {
          qos: 1,
          retain: true,
        });
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
        .publish(machineTopic(cfg.name), await machineEnvelope(deps, cfg, "down"), {
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

/** Where `volley setup` installs volley, written for the host's shell to expand. */
const SETUP_VOLLEY = "~/.volley/bin/volley";

/**
 * What to do when the redeem command on the host exited 127, from the shell's own words:
 * `bun` missing (the `#!/usr/bin/env bun` of a volley that is not setup's script), a bare
 * command not on the PATH, or a path that does not exist. Never suggests what was just passed.
 */
export function missingCommandHint(stderr: string, host: string, remoteVolley: string): string {
  const passedSetups = remoteVolley.split(/\s+/).includes(SETUP_VOLLEY);
  const onPath = (cmd: string) =>
    `\`${cmd}\` is not on ${host}'s PATH for a non-interactive ssh command.`;
  if (
    /(^|\s|\/)env: ['"]?bun['"]?: No such file/m.test(stderr) ||
    /\bbun: command not found/.test(stderr)
  ) {
    return `${onPath("bun")} Volley needs it: rerun \`volley setup\` on ${host} (its ${SETUP_VOLLEY} runs bun by its full path) and pass --remote-volley '${SETUP_VOLLEY}', or pass bun's full path there: --remote-volley '<full path of bun there> ${passedSetups ? SETUP_VOLLEY : remoteVolley}' (e.g. ~/.bun/bin/bun or /opt/homebrew/bin/bun).`;
  }
  const named = /([^\s:]+): (command not found|No such file or directory)/.exec(stderr)?.[1];
  const suggest = passedSetups
    ? `Run \`volley setup\` on ${host} (it installs ${SETUP_VOLLEY}), or pass the full path to volley there with --remote-volley.`
    : `Pass the full path to volley there, quoted so ${host}'s shell expands ~: --remote-volley '${SETUP_VOLLEY}' (where \`volley setup\` installs it).`;
  if (named?.includes("/")) return `\`${named}\` does not exist on ${host}. ${suggest}`;
  return `${onPath(named ?? remoteVolley)} ${suggest}`;
}

/**
 * This user's login name. Bun's `os.userInfo().username` is only `$USER` (or "unknown" without
 * it, as in a container or a service), so `id -un` answers then.
 */
export function currentUser(
  info: () => string = () => os.userInfo().username,
  idUn: () => string | null = () => {
    const r = spawnSync("id", ["-un"], { encoding: "utf-8" });
    return r.status === 0 ? r.stdout : null;
  },
): string {
  const name = info();
  if (name !== "" && name !== "unknown") return name;
  return idUn()?.trim() || "unknown";
}

function realDeps(): PeerDeps {
  const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
  return {
    exec: realExec,
    home: os.homedir(),
    platform: process.platform,
    hostname: () => os.hostname(),
    user: () => currentUser(),
    uid: () => os.userInfo().uid,
    arch: process.arch,
    cpus: () => Math.max(1, os.cpus().length),
    loadavg: () => os.loadavg() as [number, number, number],
    now: () => new Date(),
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
    which: (cmd) => Bun.which(cmd),
    // packages/volley-cli/src/commands → the checkout root.
    volleyDir: resolve(dirname(cli), "..", "..", ".."),
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
