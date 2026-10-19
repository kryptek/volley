import { spawn } from "node:child_process";
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
import { openClient, reportConnectError } from "../connect";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";

/**
 * `volley peer`: pair a second machine with the supervisor's (SPEC §4.6.14).
 *
 * On the supervisor's machine (the host): `invite` asks volleyd for a one-time pairing code,
 * `remove` unpairs a machine, `list` shows the paired machines' health. `redeem` is what `join`
 * runs on the host over ssh: it hands the code to volleyd and prints the new peer account.
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
  --username <user>    Broker username (env: VOLLEY_AUTH_USERNAME; else coordinator.json)
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

/**
 * One control query to volleyd: connect (the caller's credentials, else the coordinator's file),
 * check volleyd is live, send, wait. Prints its own errors; null when there is no answer.
 */
async function ask(
  verb: string,
  op: string,
  fields: Record<string, unknown>,
  v: Values,
  env: Record<string, string | undefined>,
  io: IO,
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
    auth =
      resolveAuth({ username: v.username, password: v.password }, env) ?? readCoordinatorAuth(env);
  } catch (e) {
    io.stderr(`volley peer ${verb}: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.ERROR;
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
    const answer = await request(broker, namespace, op, fields, timeoutMs);
    if (answer === null) {
      io.stderr(`volley peer ${verb}: volleyd did not answer within ${timeoutMs / 1000} s\n`);
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
  const a = await ask("invite", "peer_invite", { ...fields, reply_key: key.jwk }, v, env, io);
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
  const a = await ask("remove", "peer_remove", { name }, v, env, io);
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

  // 1. ssh reachability.
  io.stdout(`Checking ssh to ${host}...\n`);
  const probe = await remote(deps, host, "echo volley-peer-ok\n");
  if (probe.code !== 0 || !probe.stdout.includes("volley-peer-ok")) {
    return fail(
      `cannot reach ${host} over ssh (${probe.stderr.trim() || `exit ${probe.code}`}); set up key-based ssh to it first`,
    );
  }

  // 2. Redeem the code on the host (its volleyd creates the peer account and hosts.<name>).
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
  const redeemed = await remote(
    deps,
    host,
    `set -o pipefail\nprintf '%s' ${sq(b64(JSON.stringify(request)))} | base64 -d | ${remoteVolley} peer redeem\n`,
  );
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
  if (v["no-service"] === true) {
    io.stdout(
      "Service not installed (--no-service): run `volley peer run` to keep the tunnel up.\n",
    );
  } else {
    const installed = await installService(deps);
    if (!installed.ok) return fail(installed.error);
    io.stdout(`Installed the tunnel service: ${installed.what}.\n`);
  }

  // 5. Claude Code's folder trust for the repo (T4: an untrusted repo opens repo_untrusted).
  printTrust(io, deps, repo, cfg.name);

  // 6. Register the machine (the service re-publishes every heartbeat).
  const registered = await register(deps, cfg);
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

function printTrust(io: IO, deps: PeerDeps, repo: string | undefined, name: string): void {
  if (repo === undefined) {
    io.stdout(
      `No --repo given: wave files that target host ${name} must name its repo (host: { repo: ... }).\n`,
    );
    return;
  }
  let trusted = false;
  try {
    const cfg = JSON.parse(readFileSync(join(deps.home, ".claude.json"), "utf-8")) as {
      projects?: Record<string, { hasTrustDialogAccepted?: unknown }>;
    };
    trusted = cfg.projects?.[repo]?.hasTrustDialogAccepted === true;
  } catch {}
  io.stdout(
    trusted
      ? `Claude Code trusts ${repo} on this machine.\n`
      : `Claude Code does not trust ${repo} on this machine yet. Accept it now: run \`claude\` in ${repo} once and answer the trust dialog. Otherwise the first spawn here opens a repo_untrusted decision (answer \`trust\` to record it).\n`,
  );
}

/** Install and start the service: what was installed, or why it could not be. */
async function installService(
  deps: PeerDeps,
): Promise<{ ok: true; what: string } | { ok: false; error: string }> {
  const argv = [...deps.volleyArgv, "peer", "run"];
  if (deps.platform === "linux") {
    const unit = join(deps.home, ".config", "systemd", "user", SYSTEMD_UNIT);
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, systemdUnit(argv));
    for (const step of [
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT],
    ]) {
      const r = await deps.exec(step);
      if (r.code !== 0) {
        return {
          ok: false,
          error: `${step.join(" ")} failed: ${r.stderr.trim() || `exit ${r.code}`}`,
        };
      }
    }
    return { ok: true, what: `systemd user unit ${unit}` };
  }
  if (deps.platform === "darwin") {
    const plist = join(deps.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, launchdPlist(argv, join(deps.home, ".volley", "peer.log")));
    const domain = `gui/${deps.uid()}`;
    // A service from an earlier join is replaced (bootout fails harmlessly when there is none).
    await deps.exec(["launchctl", "bootout", `${domain}/${LAUNCHD_LABEL}`]);
    const r = await deps.exec(["launchctl", "bootstrap", domain, plist]);
    if (r.code !== 0) {
      return {
        ok: false,
        error: `launchctl bootstrap failed: ${r.stderr.trim() || `exit ${r.code}`}`,
      };
    }
    return { ok: true, what: `launchd agent ${plist}` };
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
After=network-online.target
Wants=network-online.target

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
