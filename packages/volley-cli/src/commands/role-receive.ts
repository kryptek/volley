import { spawn } from "node:child_process";
import { createHash, randomBytes, randomInt, scryptSync } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isMap, parseDocument } from "yaml";
import { realAuthDeps, volleydHome } from "../auth/context";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";
import { stableServicePath } from "../setup/service-path";
import { renderSystemd, volleydUnitSpec } from "../setup/services";
import { defaultAuthDir } from "./auth";
import { LAUNCHD_LABEL, SYSTEMD_UNIT, peerFile } from "./peer";

/**
 * `volley role receive supervisor <bundle> --from <old>`: the target's half of a supervisor move
 * (SPEC §4.6.24). The old supervisor copies its bundle (volleyd's roles/bundle.ts) here over ssh
 * and runs this; it:
 *
 *   1. extracts the bundle and checks its manifest (version, role, the old machine, this one,
 *      every file's sha256, every path under `volleyd/`, `auth/`, `claude/` or `broker/`): a
 *      failure changes nothing;
 *   2. restores each file (`volleyd/` into `$VOLLEYD_HOME`, `auth/` into the auth dir, `claude/`
 *      into the Claude profiles root; `broker/` is a broker move's, not read here), an existing
 *      file first moved to `$VOLLEYD_HOME/roles/<move_id>/replaced/`;
 *   3. rewrites `config.yaml` for this machine: `hosts.<this>` deleted, `fleet.local_name`, and
 *      `fleet.local_terminal` / `fleet.local_agents` when given;
 *   4. stops this machine's own heartbeat (`peer.json` `heartbeat: false`; the tunnel stays) and
 *      restarts the peer service;
 *   5. records in the move's `handover.json` how this machine reaches the old one (`old_target`,
 *      peer.json's `host`), for the new supervisor to re-pair it;
 *   6. rotates the `volleyd` login with the restored admin login and writes `broker.json` and
 *      `dynsec-admin.json` (0600): the old process can never reconnect;
 *   7. installs and starts volleyd (`volleyd install` on macOS, a systemd user unit on Linux);
 *   8. mints a pairing code for the old machine and prints it, last.
 *
 * A failure from step 2 on puts every file back and stops the unit it started. Exit 1: nothing
 * changed; exit 3: it failed after the rotation, so the `volleyd` login has a password no file
 * on the old machine knows (the old supervisor rotates it again). No password is ever printed.
 */

const HELP = `Usage:
  volley role receive supervisor <bundle> --from <old machine>
                      [--local-terminal cmux|tmux] [--local-agents never] [--broker-url <url>]

Run by volleyd over ssh on the supervisor's new machine (a supervisor move): restores the
bundle's journals, config and account registry, makes this machine the supervisor's own in
config.yaml, stops this machine's own heartbeat (its tunnel stays), rotates volleyd's broker
login, installs and starts volleyd, and prints a pairing code for the old machine last.

Options:
  --from <name>            The machine the supervisor moves from (the bundle's)
  --local-terminal <t>     fleet.local_terminal here: cmux or tmux
  --local-agents never     fleet.local_agents here: no agents on this machine
  --broker-url <url>       The broker as volleyd here reaches it (default: this machine's
                           tunnel, mqtt://127.0.0.1:<peer.json remote_port>)

Exit codes: 0 received; 1 nothing changed (a bad bundle, or a step failed and was undone);
2 usage; 3 a step after the rotation failed: undone, but volleyd's login has a new password
the old machine does not know (its supervisor rotates it again).
`;

/** The bundle's manifest (volleyd's roles/bundle.ts writes it). */
interface Manifest {
  version: 1;
  move_id: string;
  role: "supervisor";
  from: string;
  to: string;
  with_broker: boolean;
  files: { path: string; sha256: string }[];
}

const PREFIXES = ["volleyd", "auth", "claude", "broker"] as const;
const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const MOVE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Exit 3: failed after the rotation (see the header). */
const ROTATED: ExitCode = 3;

export type ReceiveExec = (
  argv: string[],
  opts?: { env?: Record<string, string | undefined> },
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Everything receive touches outside its files, injectable for tests. */
export interface ReceiveDeps {
  exec: ReceiveExec;
  home: string;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  uid: () => number;
  now: () => Date;
  /** argv that runs this volley CLI (`volley auth rotate`). */
  volleyArgv: string[];
  /** The bun the services run. */
  bun: string;
  /** This machine's volley checkout (volleyd's cli.ts is under it). */
  volleyDir: string;
  /** The auth dir when VOLLEY_AUTH_DIR is unset (default: the detected layout's). */
  authDir?: () => string;
}

export interface ReceiveArgs {
  argv: string[];
  env: Record<string, string | undefined>;
  io: IO;
}

export function receive(args: ReceiveArgs): Promise<ExitCode> {
  return runReceive(args, realReceiveDeps());
}

class Failed extends Error {}

export async function runReceive(
  { argv, env, io }: ReceiveArgs,
  deps: ReceiveDeps,
): Promise<ExitCode> {
  let parsed: ReturnType<typeof parseOptions>;
  try {
    parsed = parseOptions(argv);
  } catch (e) {
    io.stderr(`volley role receive: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.USAGE;
  }
  const v = parsed.values;
  if (v.help === true) {
    io.stdout(HELP);
    return EXIT.OK;
  }
  const usage = (msg: string) => {
    io.stderr(`volley role receive: ${msg}\n`);
    return EXIT.USAGE;
  };
  const [role, bundlePath, ...extra] = parsed.positionals;
  if (role !== "supervisor") {
    return usage(
      `only the supervisor is received (a Desk move runs \`volley desk install\`), got ${role ?? "nothing"}`,
    );
  }
  if (bundlePath === undefined || extra.length > 0) return usage("needs exactly one <bundle>");
  if (v.from === undefined || !NAME.test(v.from)) return usage("needs --from <old machine>");
  if (v["local-terminal"] !== undefined && !["cmux", "tmux"].includes(v["local-terminal"])) {
    return usage("--local-terminal must be cmux or tmux");
  }
  if (v["local-agents"] !== undefined && v["local-agents"] !== "never") {
    return usage("--local-agents takes only never");
  }
  const fail = (msg: string, code: ExitCode = EXIT.ERROR) => {
    io.stderr(`volley role receive: ${msg}\n`);
    return code;
  };

  const e = { ...deps.env, ...env };
  let peerRaw: Record<string, unknown>;
  try {
    peerRaw = JSON.parse(readFileSync(peerFile(deps.home), "utf-8")) as Record<string, unknown>;
  } catch (err) {
    return fail(
      `this machine is not paired (${peerFile(deps.home)}: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const self = peerRaw.name;
  if (typeof self !== "string" || typeof peerRaw.host !== "string") {
    return fail(`${peerFile(deps.home)}: no name or host`);
  }
  const brokerUrl = v["broker-url"] ?? `mqtt://127.0.0.1:${String(peerRaw.remote_port)}`;
  const vhome = volleydHome(e);
  const authDir =
    e.VOLLEY_AUTH_DIR ?? (deps.authDir ?? (() => defaultAuthDir(realAuthDeps.layout())))();
  const claudeDir = e.VOLLEY_CLAUDE_DIR ?? join(deps.home, ".volley", "claude");
  const dest: Record<(typeof PREFIXES)[number], string | null> = {
    volleyd: vhome,
    auth: authDir,
    claude: claudeDir,
    broker: null,
  };

  const stage = mkdtempSync(join(os.tmpdir(), "volley-receive-"));
  try {
    // 1. Extract and check: nothing outside the temp dir changes until every check passed.
    const x = await deps.exec(["tar", "-xzf", resolve(bundlePath), "-C", stage]);
    if (x.code !== 0) return fail(`cannot extract ${bundlePath}: ${x.stderr.trim()}`);
    const m = checkManifest(stage, v.from, self);
    if (typeof m === "string") return fail(m);

    const undo: (() => void)[] = [];
    const written = new Set<string>();
    const replacedDir = join(vhome, "roles", m.move_id, "replaced");
    /** Write `text` (or copy `from`) to `to`, 0600, the old copy kept under replaced/<key>. */
    const put = (to: string, key: string, data: { from: string } | { text: string }) => {
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      // A file this run wrote already (config.yaml, handover.json) is rewritten: its undo stands.
      if (!written.has(to)) {
        if (existsSync(to)) {
          const keep = join(replacedDir, key);
          mkdirSync(dirname(keep), { recursive: true, mode: 0o700 });
          move(to, keep);
          undo.push(() => move(keep, to));
        } else undo.push(() => rmSync(to, { force: true }));
        written.add(to);
      }
      if ("from" in data) copyFileSync(data.from, to);
      else writeFileSync(to, data.text);
      chmodSync(to, 0o600);
    };
    let rotated = false;
    let started = false;
    try {
      // 2. Restore.
      for (const f of m.files) {
        const [prefix, ...rest] = f.path.split("/");
        const base = dest[prefix as keyof typeof dest];
        if (base === null || base === undefined) continue;
        put(join(base, ...rest), f.path, { from: join(stage, f.path) });
      }

      // 3. config.yaml: this machine is the supervisor's own now.
      const configFile = join(vhome, "config.yaml");
      const doc = parseDocument(existsSync(configFile) ? readFileSync(configFile, "utf-8") : "");
      const hosts = doc.get("hosts");
      if (isMap(hosts)) hosts.delete(self);
      doc.setIn(["fleet", "local_name"], self);
      if (v["local-terminal"] !== undefined)
        doc.setIn(["fleet", "local_terminal"], v["local-terminal"]);
      if (v["local-agents"] !== undefined) doc.setIn(["fleet", "local_agents"], v["local-agents"]);
      put(configFile, "volleyd/config.yaml", { text: doc.toString() });
      io.stdout(`Restored ${m.files.length} files from ${v.from}; ${configFile} names ${self}.\n`);

      // 4. This machine's own heartbeat stops (the supervisor publishes its record); the tunnel stays.
      const peerText = readFileSync(peerFile(deps.home), "utf-8");
      writeSecret(
        peerFile(deps.home),
        `${JSON.stringify({ ...peerRaw, heartbeat: false }, null, 2)}\n`,
      );
      undo.push(() => writeSecret(peerFile(deps.home), peerText));
      await restartPeer(deps);
      undo.push(() => void restartPeer(deps).catch(() => {}));
      io.stdout(
        "Stopped this machine's own heartbeat (peer.json heartbeat: false); its tunnel stays.\n",
      );

      // 5. How the new supervisor reaches the old machine to re-pair it.
      const handoverFile = join(vhome, "roles", m.move_id, "handover.json");
      const handover = existsSync(handoverFile)
        ? (JSON.parse(readFileSync(handoverFile, "utf-8")) as Record<string, unknown>)
        : { move_id: m.move_id };
      put(handoverFile, `volleyd/roles/${m.move_id}/handover.json`, {
        text: `${JSON.stringify({ ...handover, old_target: peerRaw.host }, null, 2)}\n`,
      });

      // 6. Rotate volleyd's login: from here on, the old process can never reconnect.
      const admin = readLogin(join(authDir, "admin.json"));
      const r = await deps.exec([...deps.volleyArgv, "auth", "rotate", "volleyd", "--json"], {
        env: { ...e, VOLLEY_BROKER_URL: brokerUrl, VOLLEY_AUTH_DIR: authDir },
      });
      // Never its stdout: it carries the new password.
      if (r.code !== 0) throw new Failed(`volley auth rotate volleyd failed: ${r.stderr.trim()}`);
      rotated = true;
      let password: unknown;
      try {
        password = (JSON.parse(r.stdout) as { password?: unknown }).password;
      } catch {}
      if (typeof password !== "string") throw new Failed("volley auth rotate printed no password");
      put(join(vhome, "broker.json"), "volleyd/broker.json", {
        text: `${JSON.stringify({ username: "volleyd", password })}\n`,
      });
      put(join(vhome, "dynsec-admin.json"), "volleyd/dynsec-admin.json", {
        text: `${JSON.stringify(admin)}\n`,
      });
      io.stdout("Rotated volleyd's broker login (broker.json, dynsec-admin.json: mode 0600).\n");

      // 7. volleyd as this machine's service.
      started = true;
      io.stdout(`${await installVolleyd(deps, e, vhome, authDir, brokerUrl, put)}\n`);

      // 8. A code for the old machine to pair back with.
      const code = mintCode(vhome, v.from, deps.now());
      io.stdout(`Pairing code for ${v.from}: ${code}\n`);
      return EXIT.OK;
    } catch (err) {
      if (started) await stopVolleyd(deps).catch(() => {});
      for (const u of undo.reverse()) {
        try {
          u();
        } catch {}
      }
      rmSync(replacedDir, { recursive: true, force: true });
      const msg = err instanceof Error ? err.message : String(err);
      return rotated
        ? fail(
            `${msg}; undone, but volleyd's login was rotated: the old supervisor must rotate it again (\`volley auth rotate volleyd\`)`,
            ROTATED,
          )
        : fail(`${msg}; nothing changed`);
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

function parseOptions(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      from: { type: "string" },
      "local-terminal": { type: "string" },
      "local-agents": { type: "string" },
      "broker-url": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });
}

/** The manifest, checked against the extracted files; or why the bundle is refused. */
function checkManifest(stage: string, from: string, self: string): Manifest | string {
  let m: Manifest;
  try {
    m = JSON.parse(readFileSync(join(stage, "manifest.json"), "utf-8")) as Manifest;
  } catch (e) {
    return `the bundle has no readable manifest.json (${e instanceof Error ? e.message : String(e)})`;
  }
  if (m.version !== 1) return `manifest version ${String(m.version)} is not 1`;
  if (m.role !== "supervisor") return `the bundle moves ${String(m.role)}, not the supervisor`;
  if (typeof m.move_id !== "string" || !MOVE_ID.test(m.move_id))
    return "the manifest's move_id is not a move id";
  if (m.from !== from) return `the bundle is from ${String(m.from)}, not from ${from}`;
  if (m.to !== self) return `the bundle is for ${String(m.to)}, and this machine is ${self}`;
  if (!Array.isArray(m.files)) return "the manifest lists no files";
  for (const f of m.files) {
    const parts = typeof f?.path === "string" ? f.path.split("/") : [];
    if (
      parts.length < 2 ||
      !(PREFIXES as readonly string[]).includes(parts[0] as string) ||
      parts.some((p) => p === "" || p === "." || p === "..")
    ) {
      return `the manifest lists ${JSON.stringify(f?.path)}, outside ${PREFIXES.map((p) => `${p}/`).join(", ")}`;
    }
    const file = join(stage, f.path);
    if (!existsSync(file)) return `${f.path} is in the manifest but not in the bundle`;
    const sha = createHash("sha256").update(readFileSync(file)).digest("hex");
    if (sha !== f.sha256) return `${f.path}: its sha256 is not the manifest's`;
  }
  return m;
}

/** A rename, or a copy and delete across filesystems (the auth dir may be elsewhere). */
function move(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch {
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

function writeSecret(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function readLogin(path: string): { username: string; password: string } {
  try {
    const l = JSON.parse(readFileSync(path, "utf-8")) as { username?: unknown; password?: unknown };
    if (typeof l.username === "string" && typeof l.password === "string")
      return { username: l.username, password: l.password };
  } catch {}
  throw new Failed(`${path} holds no admin login`);
}

async function must(deps: ReceiveDeps, argv: string[], env?: Record<string, string | undefined>) {
  const r = await deps.exec(argv, env !== undefined ? { env } : {});
  if (r.code !== 0) {
    throw new Failed(
      `\`${argv.join(" ")}\` failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`,
    );
  }
}

/** The peer service picks up peer.json again (it reads it at start). */
function restartPeer(deps: ReceiveDeps): Promise<void> {
  return deps.platform === "darwin"
    ? must(deps, ["launchctl", "kickstart", "-k", `gui/${deps.uid()}/${LAUNCHD_LABEL}`])
    : must(deps, ["systemctl", "--user", "restart", SYSTEMD_UNIT]);
}

const volleydCli = (deps: ReceiveDeps) =>
  join(deps.volleyDir, "packages", "volleyd", "src", "cli.ts");

/** Install and start volleyd as `volley setup`'s Services step does; what was done. */
async function installVolleyd(
  deps: ReceiveDeps,
  e: Record<string, string | undefined>,
  vhome: string,
  authDir: string,
  brokerUrl: string,
  put: (to: string, key: string, data: { text: string }) => void,
): Promise<string> {
  const env = {
    VOLLEYD_HOME: vhome,
    VOLLEY_BROKER_URL: brokerUrl,
    VOLLEY_AUTH_DIR: authDir,
    VOLLEY_NAMESPACE: e.VOLLEY_NAMESPACE ?? "default",
    PATH: stableServicePath({ home: deps.home, bun: deps.bun, tmpdir: e.TMPDIR }),
  };
  if (deps.platform === "darwin") {
    await must(deps, [deps.bun, volleydCli(deps), "install", "--broker-url", brokerUrl], {
      ...e,
      ...env,
    });
    return "Installed and started volleyd (volleyd install).";
  }
  if (deps.platform === "linux") {
    const unit = join(
      e.XDG_CONFIG_HOME ?? join(deps.home, ".config"),
      "systemd",
      "user",
      "volleyd.service",
    );
    mkdirSync(vhome, { recursive: true, mode: 0o700 });
    put(unit, "systemd/volleyd.service", {
      text: renderSystemd(volleydUnitSpec(deps.bun, volleydCli(deps), env, vhome)),
    });
    for (const step of ["daemon-reload", "enable", "restart"]) {
      await must(deps, [
        "systemctl",
        "--user",
        step,
        ...(step === "daemon-reload" ? [] : ["volleyd.service"]),
      ]);
    }
    return `Installed and started volleyd (${unit}).`;
  }
  throw new Failed(`no launchd or systemd here (${deps.platform}): volleyd cannot be installed`);
}

async function stopVolleyd(deps: ReceiveDeps): Promise<void> {
  if (deps.platform === "darwin") await deps.exec([deps.bun, volleydCli(deps), "uninstall"]);
  else await deps.exec(["systemctl", "--user", "stop", "volleyd.service"]);
}

// A pairing code exactly as volleyd's peers.ts mints one (its alphabet, normalisation and salted
// scrypt hash), bound to the old machine (`for`), so the new supervisor's peer_join accepts it.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_TTL_S = 600;

function mintCode(vhome: string, forName: string, now: Date): string {
  const pick = () =>
    Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)] as string).join("");
  const code = `${pick()}-${pick()}`;
  const salt = randomBytes(16);
  const file = join(vhome, "peer-codes.json");
  let codes: { expires_at?: unknown }[] = [];
  try {
    const c = (JSON.parse(readFileSync(file, "utf-8")) as { codes?: unknown }).codes;
    if (Array.isArray(c)) codes = c;
  } catch {}
  const live = codes.filter(
    (c) => typeof c.expires_at === "string" && Date.parse(c.expires_at) > now.getTime(),
  );
  live.push({
    salt: salt.toString("base64url"),
    hash: scryptSync(code.replace("-", ""), salt, 32).toString("base64url"),
    expires_at: new Date(now.getTime() + CODE_TTL_S * 1000).toISOString(),
    by: "volley role receive",
    for: forName,
  } as { expires_at: string });
  writeSecret(file, `${JSON.stringify({ codes: live }, null, 2)}\n`);
  return code;
}

const realExec: ReceiveExec = (argv, opts = {}) =>
  new Promise((done) => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd as string, args, {
      stdio: ["ignore", "pipe", "pipe"],
      ...(opts.env !== undefined ? { env: opts.env as NodeJS.ProcessEnv } : {}),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (err) => done({ code: 127, stdout, stderr: stderr + err.message }));
    child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
  });

export function realReceiveDeps(): ReceiveDeps {
  const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
  return {
    exec: realExec,
    home: os.homedir(),
    env: process.env,
    platform: process.platform,
    uid: () => os.userInfo().uid,
    now: () => new Date(),
    volleyArgv: [process.execPath, cli],
    bun: process.execPath,
    // packages/volley-cli/src/commands → the checkout root.
    volleyDir: resolve(dirname(cli), "..", "..", ".."),
  };
}
