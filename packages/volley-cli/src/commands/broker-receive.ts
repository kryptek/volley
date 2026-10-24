import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { LAYOUTS, type Layout, type LayoutName } from "../auth/config";
import {
  ADMIN_FILE,
  type AuthContext,
  binaryOf,
  openAdmin,
  realAuthDeps,
  volleydHome,
  writeSecret,
} from "../auth/context";
import { INSTALL_INSTRUCTIONS, checkBrokerVersion, requireBrokerVersion } from "../auth/version";
import { EXIT, type ExitCode } from "../exit-codes";
import { type IO, realIO } from "../io";
import { planSecurity } from "../setup/broker";
import {
  type ExecResult,
  type SetupContext,
  type SetupDeps,
  fencedExec,
  listenerUrls,
  setupFence,
} from "../setup/step";
import { defaultAuthDir } from "./auth";
import { LAUNCHD_LABEL, SYSTEMD_UNIT, peerFile } from "./peer";

/**
 * `volley broker`: the target's half of a broker move (SPEC §4.6.24), which volleyd runs over
 * ssh on the broker's new machine (or the owner runs with sudo, on a root-owned install), and the
 * supervisor machine's own tunnel to the moved broker.
 *
 *   receive <bundle> [--lan|--no-lan] [--layout <name>]
 *       The bundle (volleyd's roles/bundle.ts, a broker move's) holds the old broker's Dynamic
 *       Security state file, its admin login and the move's choices (`lan`). Checked first (its
 *       manifest, every sha256, the state file is Dynamic Security JSON): a refusal writes
 *       nothing. Then the state file is placed at the layout's path and the admin login in the
 *       auth dir (each file it replaces kept beside it), and `volley setup`'s Security step runs
 *       on them, never a second implementation: the config as `volley auth init` writes it
 *       (`--lan`: the WebSocket listener on every interface), the layout's restart, both
 *       listeners checked to refuse anonymous clients. Prints `mosquitto <v>: <n> logins` and
 *       leaves a marker beside the bundle, which `--check` reads (the move waits on it when the
 *       receive is the owner's terminal step). A root-owned layout (`snap`, `etc`) without root
 *       exits 2 with the `sudo` line.
 *   receive <bundle> --check
 *       Exit 0 when this bundle was received here, else 1.
 *   probe [--layout <name>]
 *       One JSON line: this machine's mosquitto layout, whether it needs root, its version.
 *   tunnel --to <ssh destination> --port <n> --name <machine> [--broker-port <n>]
 *       This machine's tunnel to the broker's new machine (the supervisor's own, which publishes
 *       its own record: `heartbeat: false`): peer.json gets the destination (one is written,
 *       tunnel-only, when there is none), and `volley peer retarget` restarts the service and
 *       waits for the port. What it replaced is kept for `--off`.
 *   tunnel --off       Put back what `--to` replaced (a tunnel-only peer.json: removed, its
 *                      service stopped).
 *   tunnel --show      peer.json's tunnel as one JSON line (`host`, `remote_port`, `tunnel`).
 */

const HELP = `Usage:
  volley broker receive <bundle> [--lan | --no-lan] [--layout <name>]
  volley broker receive <bundle> --check
  volley broker probe [--layout <name>]
  volley broker tunnel --to <ssh destination> --port <port> --name <machine> [--broker-port <port>]
  volley broker tunnel --off | --show

A broker move's commands (SPEC §4.6.24): volleyd runs them over ssh, or you run the receive with
sudo on a root-owned install when the move's sheet says so.

  receive   Set up this machine's mosquitto with the moved broker's logins: the state file
            placed first, then the config, restart and anonymous check \`volley setup\` does;
            prints the version line. --check: exit 0 once this bundle was received here.
  probe     This machine's mosquitto layout and version, as one JSON line.
  tunnel    This machine's tunnel to the broker's new machine (the supervisor's own);
            --off puts back what --to replaced; --show prints the tunnel.

Options:
  --lan / --no-lan        The WebSocket listener (9001) on every interface, or on loopback only
                          (default: the bundle's choice)
  --layout <name>         The mosquitto install: ${Object.keys(LAYOUTS).join(", ")} (default: detected)

Exit codes: 0 done; 1 failed (a refused bundle changes nothing); 2 usage, or root needed.
`;

/** What `volley broker` touches outside its files, injectable for tests. */
export interface BrokerReceiveDeps {
  /** `volley setup`'s deps: its exec runs the layout's restart, its probes check the listeners. */
  setup: SetupDeps;
  layouts: Record<LayoutName, Layout>;
  uid: () => number;
  platform: NodeJS.Platform;
  /** The user's home (peer.json); under sudo, the invoking user's. */
  home: string;
  /** The auth dir the admin login goes to (default: VOLLEY_AUTH_DIR, else the layout's). */
  authDir: (layout: Layout) => string;
  /** tar and the peer service's manager: argv only. */
  exec: (argv: string[]) => Promise<ExecResult>;
  /** `volley peer <argv>` (the tunnel's retarget). */
  peer: (argv: string[]) => Promise<ExitCode>;
  now: () => Date;
}

export interface BrokerArgs {
  argv: string[];
  env: Record<string, string | undefined>;
  io: IO;
}

export async function broker(args: BrokerArgs): Promise<ExitCode> {
  return runBroker(args, await realBrokerDeps(args.env));
}

/** The bundle's manifest (volleyd's roles/bundle.ts). */
interface Manifest {
  version: 1;
  move_id: string;
  role: string;
  files: { path: string; sha256: string }[];
}

/** The marker a finished receive leaves beside its bundle (what `--check` reads). */
export const receivedMarker = (bundle: string) => join(dirname(resolve(bundle)), "received.json");

/** Where `tunnel --to` keeps what it replaced, for `--off`. */
const tunnelKept = (home: string) => join(home, ".volley", "broker-tunnel.json");

const ROOT_LAYOUTS: readonly LayoutName[] = ["snap", "etc"];
const MOVE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const DEST = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(@[A-Za-z0-9_][A-Za-z0-9_.-]*)?$/;

class Failed extends Error {}

export async function runBroker({ argv, env, io }: BrokerArgs, deps: BrokerReceiveDeps) {
  let parsed: ReturnType<typeof parseOptions>;
  try {
    parsed = parseOptions(argv);
  } catch (e) {
    io.stderr(`volley broker: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.USAGE;
  }
  const v = parsed.values;
  const [verb, ...pos] = parsed.positionals;
  if (v.help === true || verb === undefined || verb === "help") {
    (verb === undefined && v.help !== true ? io.stderr : io.stdout)(HELP);
    return verb === undefined && v.help !== true ? EXIT.USAGE : EXIT.OK;
  }
  const usage = (msg: string) => {
    io.stderr(`volley broker ${verb}: ${msg}\n`);
    return EXIT.USAGE;
  };
  let layout: Layout;
  if (v.layout !== undefined) {
    if (!Object.hasOwn(LAYOUTS, v.layout))
      return usage(`--layout must be one of ${Object.keys(LAYOUTS).join(", ")}`);
    layout = deps.layouts[v.layout as LayoutName];
  } else layout = deps.setup.auth.layout();
  switch (verb) {
    case "receive": {
      if (pos.length !== 1) return usage("needs exactly one <bundle>");
      if (v.lan === true && v["no-lan"] === true)
        return usage("--lan and --no-lan contradict each other");
      const bundle = pos[0] as string;
      if (v.check === true) return check(bundle, io);
      return receive(bundle, v, layout, env, io, deps);
    }
    case "probe":
      if (pos.length !== 0) return usage("takes no arguments");
      return probe(layout, io, deps);
    case "tunnel":
      if (pos.length !== 0) return usage("takes no arguments");
      if (v.show === true) return showTunnel(io, deps);
      if (v.off === true) return tunnelOff(io, deps);
      return tunnelOn(v, io, deps, usage);
    default:
      io.stderr(`volley broker: unknown verb '${verb}'\n\n${HELP}`);
      return EXIT.USAGE;
  }
}

function parseOptions(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      lan: { type: "boolean" },
      "no-lan": { type: "boolean" },
      layout: { type: "string" },
      check: { type: "boolean" },
      to: { type: "string" },
      port: { type: "string" },
      name: { type: "string" },
      "broker-port": { type: "string" },
      off: { type: "boolean" },
      show: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });
}

type Values = ReturnType<typeof parseOptions>["values"];

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** `receive <bundle> --check`: this bundle's marker is here. */
function check(bundle: string, io: IO): ExitCode {
  try {
    const m = JSON.parse(readFileSync(receivedMarker(bundle), "utf-8")) as { sha256?: unknown };
    if (m.sha256 === sha256(readFileSync(bundle))) {
      io.stdout(`${bundle} was received here.\n`);
      return EXIT.OK;
    }
  } catch {}
  io.stderr(`volley broker receive: ${bundle} was not received here yet\n`);
  return EXIT.ERROR;
}

/** The checked bundle: its state file's text, the admin login's, the choices. */
interface Received {
  moveId: string;
  state: string;
  logins: number;
  admin: string;
  lan: boolean | undefined;
}

/** Extract and check a broker bundle into `stage`; or why it is refused. */
async function readBundle(
  bundle: string,
  stage: string,
  deps: BrokerReceiveDeps,
): Promise<Received | string> {
  const x = await deps.exec(["tar", "-xzf", resolve(bundle), "-C", stage]);
  if (x.code !== 0) return `cannot extract ${bundle}: ${x.stderr.trim()}`;
  let m: Manifest;
  try {
    m = JSON.parse(readFileSync(join(stage, "manifest.json"), "utf-8")) as Manifest;
  } catch (e) {
    return `the bundle has no readable manifest.json (${e instanceof Error ? e.message : String(e)})`;
  }
  if (m.version !== 1) return `manifest version ${String(m.version)} is not 1`;
  if (m.role !== "broker") return `the bundle moves ${String(m.role)}, not the broker`;
  if (typeof m.move_id !== "string" || !MOVE_ID.test(m.move_id))
    return "the manifest's move_id is not a move id";
  if (!Array.isArray(m.files)) return "the manifest lists no files";
  let state: string | null = null;
  let admin: string | null = null;
  let choices: string | null = null;
  for (const f of m.files) {
    const p = typeof f?.path === "string" ? f.path : "";
    const ok = p === "auth/admin.json" || /^broker\/[A-Za-z0-9_.-]+\.json$/.test(p);
    if (!ok || p.includes(".."))
      return `the manifest lists ${JSON.stringify(f?.path)}: a broker bundle holds broker/*.json and auth/admin.json only`;
    const file = join(stage, p);
    if (!existsSync(file)) return `${p} is in the manifest but not in the bundle`;
    const text = readFileSync(file, "utf-8");
    if (sha256(text) !== f.sha256) return `${p}: its sha256 is not the manifest's`;
    if (p === "auth/admin.json") admin = text;
    else if (p === "broker/choices.json") choices = text;
    else if (state === null) state = text;
    else return "the bundle holds more than one state file";
  }
  if (state === null) return "the bundle holds no state file";
  if (admin === null) return "the bundle holds no admin login (auth/admin.json)";
  let logins: number;
  try {
    const s = JSON.parse(state) as { clients?: unknown; roles?: unknown };
    if (!Array.isArray(s.clients) || !Array.isArray(s.roles)) throw new Error("no clients/roles");
    logins = s.clients.length;
  } catch {
    return "the bundle's state file is not a Dynamic Security state file (no clients and roles)";
  }
  try {
    const a = JSON.parse(admin) as { username?: unknown; password?: unknown };
    if (typeof a.username !== "string" || typeof a.password !== "string") throw new Error();
  } catch {
    return "the bundle's auth/admin.json holds no admin login";
  }
  let lan: boolean | undefined;
  if (choices !== null) {
    try {
      const c = JSON.parse(choices) as { lan?: unknown };
      if (typeof c.lan === "boolean") lan = c.lan;
    } catch {}
  }
  return { moveId: m.move_id, state, logins, admin, lan };
}

async function receive(
  bundle: string,
  v: Values,
  layout: Layout,
  env: Record<string, string | undefined>,
  io: IO,
  deps: BrokerReceiveDeps,
): Promise<ExitCode> {
  const fail = (msg: string, code: ExitCode = EXIT.ERROR) => {
    io.stderr(`volley broker receive: ${msg}\n`);
    return code;
  };
  if (layout.name === "container")
    return fail(
      "a container's broker is set up from its host: run `volley setup` there (not supported by a broker move)",
    );
  const stage = mkdtempSync(join(os.tmpdir(), "volley-broker-receive-"));
  try {
    // 1. Check: nothing outside the temp dir changes until every check passed.
    const r = await readBundle(bundle, stage, deps);
    if (typeof r === "string") return fail(`${r}; nothing changed`);
    const lan = v.lan === true ? true : v["no-lan"] === true ? false : r.lan;
    if (ROOT_LAYOUTS.includes(layout.name) && deps.uid() !== 0) {
      const flag = lan === true ? " --lan" : lan === false ? " --no-lan" : "";
      return fail(
        `this install (${layout.name}) keeps the broker's config and state file as root's: run \`sudo volley broker receive ${bundle}${flag}\``,
        EXIT.USAGE,
      );
    }
    const authDir = deps.authDir(layout);
    const backups: (() => void)[] = [];
    /**
     * Write `text` to `path` (0600), an existing file first kept as `<path>.before-<move id>`,
     * then hand it to `owner` (under sudo: the broker's user, or the invoking one).
     */
    const place = (path: string, text: string, owner: { uid: number; gid: number } | null) => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (existsSync(path)) {
        const kept = `${path}.before-${r.moveId}`;
        copyFileSync(path, kept);
        backups.push(() => copyFileSync(kept, path));
      } else backups.push(() => rmSync(path, { force: true }));
      writeSecret(path, text);
      if (owner !== null) deps.setup.auth.chown(path, owner.uid, owner.gid);
    };
    const invoker = deps.setup.auth.invokingUser(env);
    try {
      // 2. The state file first, then the admin login it holds.
      place(layout.stateFile, r.state, deps.setup.auth.brokerOwner());
      place(
        join(authDir, ADMIN_FILE),
        r.admin,
        typeof invoker === "object" && invoker !== null ? invoker : null,
      );
      io.stdout(
        `Placed the broker's state file at ${layout.stateFile} (${r.logins} logins) and its admin login in ${join(authDir, ADMIN_FILE)}.\n`,
      );

      // 3. `volley setup`'s Security step on them: config, restart, the anonymous check.
      const ctx = setupContext(layout, authDir, lan, env, io, deps);
      const plan = await planSecurity(ctx);
      if (plan.blocked !== undefined) throw new Failed(plan.blocked);
      for (const c of plan.changes) {
        for (const line of await c.apply()) io.stdout(`${line}\n`);
      }
      const problems = (await plan.verify?.()) ?? [];
      for (const line of plan.verified ?? []) io.stdout(`${line}\n`);
      if (problems.length > 0) throw new Failed(problems.join("; "));

      // 4. The version line.
      let version: string;
      const link = await openAdmin(ctx.auth);
      try {
        version = await requireBrokerVersion({
          sys: link.sysVersion,
          binary: () => deps.setup.auth.mosquittoVersion(binaryOf(layout)),
        });
      } finally {
        await link.close().catch(() => {});
      }
      writeFileSync(
        receivedMarker(bundle),
        `${JSON.stringify({ move_id: r.moveId, sha256: sha256(readFileSync(bundle)) })}\n`,
        { mode: 0o644 },
      );
      io.stdout(`mosquitto ${version}: ${r.logins} logins\n`);
      return EXIT.OK;
    } catch (e) {
      const stuck: string[] = [];
      for (const b of backups.reverse()) {
        try {
          b();
        } catch (err) {
          stuck.push(err instanceof Error ? err.message : String(err));
        }
      }
      const msg = e instanceof Error ? e.message : String(e);
      return fail(
        `${msg}; the state file and admin login were put back${stuck.length > 0 ? ` (not all: ${stuck.join("; ")})` : ""}; restart the broker (\`${layout.restart}\`) if it was restarted`,
      );
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** `volley setup`'s context for its Security step on this machine's broker. */
function setupContext(
  layout: Layout,
  authDir: string,
  lan: boolean | undefined,
  env: Record<string, string | undefined>,
  io: IO,
  deps: BrokerReceiveDeps,
): SetupContext {
  const url = "mqtt://127.0.0.1:1883";
  const listeners = listenerUrls(url) as { tcpUrl: string; wsUrl: string };
  const fence = setupFence({
    restart: layout.restart,
    repoRoot: deps.setup.repoRoot,
    bun: deps.setup.bun,
  });
  const setup: SetupDeps = { ...deps.setup, exec: fencedExec(deps.setup.exec, fence) };
  const auth: AuthContext = { dir: authDir, layout, url, io, env, deps: setup.auth };
  return {
    auth,
    deps: setup,
    config: layout.config,
    stateFile: layout.stateFile,
    ...listeners,
    home: deps.home,
    volleydHome: volleydHome(env),
    repair: false,
    yes: true,
    ...(lan !== undefined ? { lan } : {}),
    deskHost: setup.lanHost(),
    deskPort: 0,
  };
}

/** `probe`: the layout, whether it needs root, mosquitto's version (exit 1 without a usable one). */
async function probe(layout: Layout, io: IO, deps: BrokerReceiveDeps): Promise<ExitCode> {
  const text = await deps.setup.auth.mosquittoVersion(binaryOf(layout)).catch(() => null);
  const base = { layout: layout.name, needs_root: ROOT_LAYOUTS.includes(layout.name) };
  if (text === null) {
    io.stdout(
      `${JSON.stringify({ ...base, mosquitto: null, error: `no mosquitto (${binaryOf(layout)} -h printed no version). ${INSTALL_INSTRUCTIONS.split("\n").slice(0, 3).join(" ")}` })}\n`,
    );
    return EXIT.ERROR;
  }
  const c = checkBrokerVersion(text);
  if (!c.ok) {
    io.stdout(`${JSON.stringify({ ...base, mosquitto: null, error: c.message })}\n`);
    return EXIT.ERROR;
  }
  io.stdout(`${JSON.stringify({ ...base, mosquitto: c.version })}\n`);
  return EXIT.OK;
}

/** `tunnel --show`: peer.json's tunnel. */
function showTunnel(io: IO, deps: BrokerReceiveDeps): ExitCode {
  try {
    const c = JSON.parse(readFileSync(peerFile(deps.home), "utf-8")) as Record<string, unknown>;
    io.stdout(
      `${JSON.stringify({ host: c.host, remote_port: c.remote_port, tunnel: c.tunnel === "none" ? "none" : "ssh" })}\n`,
    );
    return EXIT.OK;
  } catch (e) {
    io.stderr(
      `volley broker tunnel: no tunnel here (${peerFile(deps.home)}: ${e instanceof Error ? e.message : String(e)})\n`,
    );
    return EXIT.ERROR;
  }
}

const portOf = (s: string | undefined): number | null =>
  s !== undefined && /^[1-9][0-9]{0,4}$/.test(s) && Number(s) <= 65535 ? Number(s) : null;

/** `tunnel --to <dest> --port <n> --name <machine> [--broker-port <n>]`. */
async function tunnelOn(
  v: Values,
  io: IO,
  deps: BrokerReceiveDeps,
  usage: (msg: string) => ExitCode,
): Promise<ExitCode> {
  const to = v.to;
  if (to === undefined || !DEST.test(to)) return usage("needs --to <ssh destination>");
  const port = portOf(v.port);
  if (port === null) return usage("needs --port <port> (1..65535)");
  if (v.name === undefined || !NAME.test(v.name)) return usage("needs --name <this machine>");
  const brokerPort = v["broker-port"] === undefined ? 1883 : portOf(v["broker-port"]);
  if (brokerPort === null) return usage("--broker-port must be a port (1..65535)");
  const file = peerFile(deps.home);
  const previous = existsSync(file) ? readFileSync(file, "utf-8") : null;
  let kept: Record<string, unknown> | null = null;
  if (previous !== null) {
    try {
      kept = JSON.parse(previous) as Record<string, unknown>;
    } catch (e) {
      io.stderr(
        `volley broker tunnel: ${file} is not JSON (${e instanceof Error ? e.message : String(e)}); fix or remove it, then run this again\n`,
      );
      return EXIT.ERROR;
    }
  }
  const base: Record<string, unknown> =
    kept !== null
      ? kept
      : {
          name: v.name,
          target: v.name,
          namespace: "default",
          username: "",
          password: "",
          joined_at: deps.now().toISOString(),
          tunnel_only: true,
        };
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // What --off puts back: kept once, so a second --to keeps the first one's.
  if (!existsSync(tunnelKept(deps.home)))
    writeSecret(tunnelKept(deps.home), `${JSON.stringify({ previous })}\n`);
  writeSecret(
    file,
    `${JSON.stringify(
      {
        ...base,
        host: to,
        broker: { host: "127.0.0.1", port: brokerPort },
        remote_port: port,
        tunnel: "ssh",
        heartbeat: false,
      },
      null,
      2,
    )}\n`,
  );
  const code = await deps.peer(["retarget", "--to", to, "--port", String(port), "--tunnel", "ssh"]);
  if (code !== EXIT.OK) {
    io.stderr(
      "volley broker tunnel: the tunnel did not come up; `volley broker tunnel --off` puts back what was here\n",
    );
    return EXIT.ERROR;
  }
  io.stdout(`This machine reaches the broker at 127.0.0.1:${port} through ssh to ${to}.\n`);
  return EXIT.OK;
}

/** `tunnel --off`: put back what `--to` replaced. */
async function tunnelOff(io: IO, deps: BrokerReceiveDeps): Promise<ExitCode> {
  const fail = (msg: string) => {
    io.stderr(`volley broker tunnel: ${msg}\n`);
    return EXIT.ERROR;
  };
  let previous: string | null;
  try {
    const k = JSON.parse(readFileSync(tunnelKept(deps.home), "utf-8")) as { previous?: unknown };
    previous = typeof k.previous === "string" ? k.previous : null;
  } catch {
    return fail(`nothing to put back (${tunnelKept(deps.home)})`);
  }
  const file = peerFile(deps.home);
  try {
    if (previous === null) {
      await stopService(deps);
      rmSync(file, { force: true });
      io.stdout(`Stopped this machine's tunnel and removed ${file}.\n`);
    } else {
      writeSecret(file, previous);
      await restartService(deps);
      io.stdout(`Put ${file} back and restarted its service.\n`);
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  rmSync(tunnelKept(deps.home), { force: true });
  return EXIT.OK;
}

async function must(deps: BrokerReceiveDeps, argv: string[]): Promise<void> {
  const r = await deps.exec(argv);
  if (r.code !== 0)
    throw new Error(
      `\`${argv.join(" ")}\` failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`,
    );
}

/** The peer service stopped for good (a tunnel-only one `--to` installed). */
async function stopService(deps: BrokerReceiveDeps): Promise<void> {
  if (deps.platform === "darwin") {
    // gui/<uid>, or user/<uid> when it was installed over ssh: one of them holds it.
    for (const d of [`gui/${deps.uid()}`, `user/${deps.uid()}`])
      await deps.exec(["launchctl", "bootout", `${d}/${LAUNCHD_LABEL}`]);
    rmSync(join(deps.home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`), { force: true });
    return;
  }
  await must(deps, ["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT]);
  rmSync(join(deps.home, ".config", "systemd", "user", SYSTEMD_UNIT), { force: true });
}

/** The peer service restarted on the peer.json put back. */
async function restartService(deps: BrokerReceiveDeps): Promise<void> {
  if (deps.platform === "darwin") {
    const errors: string[] = [];
    for (const d of [`gui/${deps.uid()}`, `user/${deps.uid()}`]) {
      const r = await deps.exec(["launchctl", "kickstart", "-k", `${d}/${LAUNCHD_LABEL}`]);
      if (r.code === 0) return;
      errors.push(r.stderr.trim());
    }
    throw new Error(`launchctl kickstart ${LAUNCHD_LABEL}: ${errors.join("; ")}`);
  }
  await must(deps, ["systemctl", "--user", "restart", SYSTEMD_UNIT]);
}

/** The real machine: setup's deps, the detected layouts, the invoking user's home under sudo. */
async function realBrokerDeps(env: Record<string, string | undefined>): Promise<BrokerReceiveDeps> {
  const { realSetupDeps } = await import("./setup");
  const { peer } = await import("./peer");
  const setup = realSetupDeps(env);
  const invoker = realAuthDeps.invokingUser(env);
  const home =
    typeof invoker === "object" && invoker !== null ? invoker.home : (env.HOME ?? os.homedir());
  return {
    setup,
    layouts: LAYOUTS,
    uid: () => os.userInfo().uid,
    platform: process.platform,
    home,
    authDir: (layout) => env.VOLLEY_AUTH_DIR ?? defaultAuthDir(layout),
    exec: (argv) => setup.exec(argv, { input: "" }),
    peer: (argv) => peer({ argv, env, io: realIO }),
    now: () => new Date(),
  };
}
