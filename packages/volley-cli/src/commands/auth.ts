import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { MOSQUITTO_ETC_DIRS } from "volley-mcp/config";
import { isValidAgentId } from "volley-mcp/topics";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";

export interface AuthArgs {
  argv: string[];
  env: Record<string, string | undefined>;
  io: IO;
}

/** Side effects `volley auth` needs, injectable so tests never touch a real broker. */
export interface AuthDeps {
  /** Run `mosquitto_passwd <args>`. */
  passwd: (args: string[]) => Promise<{ code: number; stderr: string }>;
  /** Ask the running broker to re-read its password and ACL files. */
  reload: () => Promise<{ ok: boolean; detail: string }>;
  generatePassword: () => string;
  /**
   * The uid/gid the broker drops to when `volley auth` runs as root (distro mosquitto starts
   * as root, then opens password_file as the `mosquitto` user), or null when no hand-off is
   * needed (not root, or no such user).
   */
  brokerOwner: () => { uid: number; gid: number } | null;
  chown: (path: string, uid: number, gid: number) => void;
}

/** Where volleyd keeps its state (volleyd's config-store.ts `volleydHome`, which this mirrors). */
function volleydHome(env: Record<string, string | undefined>): string {
  return env.VOLLEYD_HOME ?? join(env.HOME ?? homedir(), ".volley", "volleyd");
}

/** volleyd's broker credentials file in $VOLLEYD_HOME (volleyd's broker-auth.ts reads it). */
export const VOLLEYD_BROKER_FILE = "broker.json";

/** The identities every Volley deployment has; agents get their own via add-agent. */
export const FIXED_IDENTITIES = ["volleyd", "desk", "coordinator"] as const;

/**
 * Ids `add-agent` refuses because the ACL's namespace wildcard would carry them into reserved
 * or foreign topics: `volley/+/%u/status` with %u=`registry` matches
 * `volley/_system/registry/status`, and an agent named after a channel has a registry entry
 * (`volley/_system/registry/mailbox`) that every steering client's `volley/+/+/mailbox` matches.
 */
export const RESERVED_AGENT_IDS = [
  "registry",
  "leases",
  "health",
  "federation",
  "status",
  "progress",
  "result",
  "capability",
  "control",
  "mailbox",
  "screen",
] as const;

/** The shipped ACL; the CLI runs from source (no build step), so it is a repo-relative path. */
const BUNDLED_ACL = new URL("../../../../examples/mosquitto-auth/acl.conf", import.meta.url);

function run(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (e) => resolve({ code: 127, stderr: e.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
}

export const realAuthDeps: AuthDeps = {
  passwd: (args) => run("mosquitto_passwd", args),
  // mosquitto re-reads password_file and acl_file on SIGHUP. Works for `brew services`
  // (runs as you) and any broker you started yourself; a root-owned systemd broker needs
  // `sudo systemctl reload mosquitto` instead, which the warning below spells out.
  reload: async () => {
    const r = await run("pkill", ["-HUP", "-x", "mosquitto"]);
    return r.code === 0
      ? { ok: true, detail: "sent SIGHUP to mosquitto (password + ACL files reloaded)" }
      : {
          ok: false,
          detail:
            "could not signal mosquitto (not running, or owned by another user). Reload it " +
            "yourself: `brew services restart mosquitto` or `sudo systemctl reload mosquitto`.",
        };
  },
  generatePassword: () => randomBytes(24).toString("base64url"),
  brokerOwner: () => {
    if (process.getuid?.() !== 0 || !existsSync("/etc/passwd")) return null;
    const line = readFileSync("/etc/passwd", "utf-8")
      .split("\n")
      .find((l) => l.startsWith("mosquitto:"));
    const [, , uid, gid] = line?.split(":") ?? [];
    return uid !== undefined && gid !== undefined ? { uid: Number(uid), gid: Number(gid) } : null;
  },
  chown: (path, uid, gid) => chownSync(path, uid, gid),
};

const blockStart = (id: string) =>
  `# >>> volley agent ${id} (managed by \`volley auth\`; do not edit)`;
const blockEnd = (id: string) => `# <<< volley agent ${id}`;

/** Remove agent `id`'s managed block (and the blank line before it) from the ACL text. */
function withoutAgentBlock(acl: string, id: string): string {
  const start = acl.indexOf(`\n${blockStart(id)}\n`);
  if (start === -1) return acl;
  const endMarker = `${blockEnd(id)}\n`;
  const end = acl.indexOf(endMarker, start);
  return end === -1 ? acl : acl.slice(0, start) + acl.slice(end + endMarker.length);
}

/**
 * Rewrite the ACL so agent `id` may write exactly the `ackTo` senders' mailboxes (SPEC §4.4:
 * an ack goes to the SENDER's mailbox). A `user` section appended at the end; an empty
 * `ackTo` just removes any earlier one.
 */
function setAgentBlock(aclFile: string, id: string, ackTo: string[]): void {
  if (!existsSync(aclFile)) return;
  let acl = withoutAgentBlock(readFileSync(aclFile, "utf-8"), id);
  if (ackTo.length > 0) {
    if (!acl.endsWith("\n")) acl += "\n";
    acl += [
      "",
      blockStart(id),
      `user ${id}`,
      ...ackTo.map((sender) => `topic write volley/+/${sender}/mailbox`),
      blockEnd(id),
      "",
    ].join("\n");
  }
  writeFileSync(aclFile, acl);
}

function hasUser(passwdFile: string, user: string): boolean {
  return readFileSync(passwdFile, "utf-8")
    .split("\n")
    .some((l) => l.startsWith(`${user}:`));
}

function resolveDir(flag: string | undefined, env: Record<string, string | undefined>): string {
  const dir = flag ?? env.VOLLEY_AUTH_DIR;
  if (dir !== undefined) return dir;
  const etc = MOSQUITTO_ETC_DIRS.find((d) => existsSync(d));
  if (etc === undefined) {
    throw new Error(
      "no mosquitto config directory found; pass --dir <dir> (or set VOLLEY_AUTH_DIR)",
    );
  }
  return join(etc, "volley");
}

async function reload(deps: AuthDeps, io: IO, skip: boolean): Promise<void> {
  if (skip) {
    // stderr, so add-agent's stdout stays exactly the password.
    io.stderr(
      "volley auth: skipped broker reload (--no-reload); reload mosquitto before relying on this change\n",
    );
    return;
  }
  const r = await deps.reload();
  if (!r.ok) io.stderr(`volley auth: warning: ${r.detail}\n`);
}

async function passwd(deps: AuthDeps, io: IO, args: string[]): Promise<boolean> {
  const r = await deps.passwd(args);
  if (r.code === 0) return true;
  io.stderr(`volley auth: mosquitto_passwd failed (exit ${r.code}): ${r.stderr.trim()}\n`);
  if (r.code === 127)
    io.stderr("Hint: mosquitto_passwd ships with mosquitto (`brew install mosquitto`).\n");
  return false;
}

export async function auth(
  { argv, env, io }: AuthArgs,
  deps: AuthDeps = realAuthDeps,
): Promise<ExitCode> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        dir: { type: "string" },
        "ack-to": { type: "string", multiple: true },
        force: { type: "boolean" },
        json: { type: "boolean" },
        "no-reload": { type: "boolean" },
        "coordinator-file": { type: "boolean" },
        "volleyd-file": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (e) {
    io.stderr(`volley auth: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.USAGE;
  }
  if (parsed.values.help === true) {
    io.stdout(AUTH_HELP);
    return EXIT.OK;
  }

  const [verb, agentId, ...extra] = parsed.positionals;
  const takesId = verb === "add-agent" || verb === "rm-agent";
  if (
    (verb !== "init" && !takesId) ||
    (takesId && agentId === undefined) ||
    (verb === "init" && agentId !== undefined) ||
    extra.length > 0
  ) {
    io.stderr(AUTH_HELP);
    return EXIT.USAGE;
  }

  let dir: string;
  try {
    dir = resolveDir(parsed.values.dir as string | undefined, env);
  } catch (e) {
    io.stderr(`volley auth: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.ERROR;
  }
  const passwdFile = join(dir, "passwd");
  const aclFile = join(dir, "acl.conf");
  const skipReload = parsed.values["no-reload"] === true;
  for (const flag of ["coordinator-file", "volleyd-file"] as const) {
    if (parsed.values[flag] === true && verb !== "init") {
      io.stderr(`volley auth: --${flag} only applies to init\n`);
      return EXIT.USAGE;
    }
  }

  if (verb === "init") {
    const existed = existsSync(passwdFile);
    if (existed && parsed.values.force !== true) {
      io.stderr(
        `volley auth: ${passwdFile} already exists; re-run with --force to rotate the fixed identities' passwords\n`,
      );
      return EXIT.ERROR;
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // An existing ACL may carry the owner's edits and every agent's ack grants: keep it.
    const keptAcl = existsSync(aclFile);
    if (!keptAcl) {
      copyFileSync(BUNDLED_ACL, aclFile);
      chmodSync(aclFile, 0o600);
    }

    const minted: [string, string][] = [];
    let coordinatorPassword: string | null = null;
    let volleydPassword: string | null = null;
    for (const [i, user] of FIXED_IDENTITIES.entries()) {
      const password = deps.generatePassword();
      // `-c` truncates, so only for a new file; `-b` upserts, which keeps minted agents.
      const args =
        i === 0 && !existed
          ? ["-c", "-b", passwdFile, user, password]
          : ["-b", passwdFile, user, password];
      if (!(await passwd(deps, io, args))) {
        // A fresh file holding only some fixed identities would make the next `init` refuse.
        if (!existed) rmSync(passwdFile, { force: true });
        return EXIT.ERROR;
      }
      minted.push([user, password]);
      if (user === "coordinator") coordinatorPassword = password;
      if (user === "volleyd") volleydPassword = password;
    }
    chmodSync(passwdFile, 0o600);
    // The coordinator's hooks read their credentials from here (never from settings.json).
    // An existing file is rotated with the passwd entry, so it cannot go stale.
    const coordinatorFile = join(dir, "coordinator.json");
    const wroteCoordinator =
      parsed.values["coordinator-file"] === true || existsSync(coordinatorFile);
    if (wroteCoordinator) {
      if (coordinatorPassword === null) throw new Error("no coordinator identity was minted");
      const creds = { username: "coordinator", password: coordinatorPassword };
      writeFileSync(coordinatorFile, `${JSON.stringify(creds)}\n`, { mode: 0o600 });
      chmodSync(coordinatorFile, 0o600);
    }
    // volleyd reads its credentials from here (never from the launchd plist); rotated the same way.
    const volleydFile = join(volleydHome(env), VOLLEYD_BROKER_FILE);
    const wroteVolleyd = parsed.values["volleyd-file"] === true || existsSync(volleydFile);
    if (wroteVolleyd) {
      if (volleydPassword === null) throw new Error("no volleyd identity was minted");
      mkdirSync(volleydHome(env), { recursive: true, mode: 0o700 });
      const creds = { username: "volleyd", password: volleydPassword };
      writeFileSync(volleydFile, `${JSON.stringify(creds)}\n`, { mode: 0o600 });
      chmodSync(volleydFile, 0o600);
    }
    const owner = deps.brokerOwner();
    if (owner !== null) {
      for (const path of [dir, aclFile, passwdFile]) deps.chown(path, owner.uid, owner.gid);
    }

    io.stdout(
      [
        `Wrote ${passwdFile}${keptAcl ? "" : ` and ${aclFile}`}.`,
        ...(keptAcl
          ? [
              `Kept the existing ${aclFile}; compare it with ${BUNDLED_ACL.pathname} after upgrading Volley.`,
            ]
          : []),
        ...(wroteCoordinator
          ? [`Wrote ${coordinatorFile} (mode 0600): the coordinator's hook credentials.`]
          : []),
        ...(wroteVolleyd
          ? [
              `Wrote ${volleydFile} (mode 0600): volleyd's broker credentials (run volleyd as the user that owns it).`,
            ]
          : []),
        ...(owner !== null ? [`Handed ${dir} to the broker's user (uid ${owner.uid}).`] : []),
        ...(wroteCoordinator && owner !== null
          ? [
              `Note: ${coordinatorFile} is now readable only by root, not by your coordinator session's hooks:`,
              "  copy it to a directory you own and point VOLLEY_AUTH_DIR at it, or set VOLLEY_AUTH_USERNAME / VOLLEY_AUTH_PASSWORD.",
            ]
          : []),
        "",
        "Broker identities (passwords are shown ONCE; store them now):",
        ...minted.map(([user, password]) => `  ${user.padEnd(12)} ${password}`),
        "",
        "Add to mosquitto.conf (both listeners share these settings):",
        "  allow_anonymous false",
        `  password_file ${passwdFile}`,
        `  acl_file ${aclFile}`,
        "",
        "Then give each client its identity:",
        "  - coordinator sessions: VOLLEY_AUTH_USERNAME=coordinator VOLLEY_AUTH_PASSWORD=<pw> in the MCP server env,",
        "    AND exported in your shell profile (the volley CLI and mosquitto_pub run from the shell);",
        "    the hooks also read VOLLEY_AUTH_* or, failing that, coordinator.json (--coordinator-file)",
        "  - volley dash / Desk:   sign in as desk in the browser",
        wroteVolleyd
          ? `  - volleyd:              ${volleydFile} (written above)`
          : "  - volleyd:              $VOLLEYD_HOME/broker.json (re-run with --force --volleyd-file), or VOLLEY_AUTH_* in its environment",
        "",
      ].join("\n"),
    );
    await reload(deps, io, skipReload);
    return EXIT.OK;
  }

  const id = agentId as string;
  if (!isValidAgentId(id) || (FIXED_IDENTITIES as readonly string[]).includes(id)) {
    io.stderr(
      `volley auth: "${id}" is not a usable agent id (grammar [a-z0-9][a-z0-9_-]{0,62}, and not one of ${FIXED_IDENTITIES.join(", ")})\n`,
    );
    return EXIT.USAGE;
  }
  if (verb === "add-agent" && (RESERVED_AGENT_IDS as readonly string[]).includes(id)) {
    io.stderr(
      `volley auth: "${id}" is reserved (a reserved topic segment or channel name: ${RESERVED_AGENT_IDS.join(", ")}); prefer the <wave>-<task>-<role>-<attempt> form\n`,
    );
    return EXIT.USAGE;
  }
  const ackTo = (parsed.values["ack-to"] as string[] | undefined) ?? [];
  const badSender = ackTo.find((s) => !isValidAgentId(s));
  if (badSender !== undefined || (verb === "rm-agent" && ackTo.length > 0)) {
    io.stderr(
      badSender !== undefined
        ? `volley auth: --ack-to "${badSender}" is not a valid agent id\n`
        : "volley auth: --ack-to only applies to add-agent\n",
    );
    return EXIT.USAGE;
  }
  if (!existsSync(passwdFile)) {
    io.stderr(`volley auth: ${passwdFile} does not exist; run \`volley auth init\` first\n`);
    return EXIT.ERROR;
  }

  if (verb === "add-agent") {
    const password = deps.generatePassword();
    if (!(await passwd(deps, io, ["-b", passwdFile, id, password]))) return EXIT.ERROR;
    setAgentBlock(aclFile, id, ackTo);
    await reload(deps, io, skipReload);
    io.stdout(
      parsed.values.json === true
        ? `${JSON.stringify({ username: id, password })}\n`
        : `${password}\n`,
    );
    return EXIT.OK;
  }

  // Idempotent, so a supervisor's retire path can simply retry: mosquitto_passwd -D exits 1
  // for an unknown user.
  if (hasUser(passwdFile, id)) {
    if (!(await passwd(deps, io, ["-D", passwdFile, id]))) return EXIT.ERROR;
  } else {
    io.stderr(`volley auth: "${id}" is not in ${passwdFile}; nothing to revoke\n`);
  }
  setAgentBlock(aclFile, id, []);
  await reload(deps, io, skipReload);
  return EXIT.OK;
}

export const AUTH_HELP = `Usage: volley auth <init | add-agent <agent_id> | rm-agent <agent_id>> [options]

Manage the broker's password file (mosquitto_passwd) for Volley's ACLs
(examples/mosquitto-auth/). Every change reloads mosquitto (SIGHUP).

  volley auth init                 Create passwd + acl.conf with the fixed identities
                                   (volleyd, desk, coordinator); prints their passwords
                                   once and the mosquitto.conf lines to add.
  volley auth add-agent <id>       Mint a random password for agent <id> (username = id).
                                   Prints only the password (or --json: the
                                   .volley/agent.json "broker" block).
  volley auth rm-agent <id>        Revoke agent <id> (and its ACL block). Succeeds if
                                   <id> was never minted.

Options:
  --dir <dir>     Where passwd and acl.conf live (env: VOLLEY_AUTH_DIR;
                  default: <mosquitto etc dir>/volley, e.g. /opt/homebrew/etc/mosquitto/volley)
  --ack-to <id>   add-agent: let the agent write sender <id>'s mailbox, so its acks
                  (SPEC §4.4) and query replies reach that sender. Repeatable;
                  typically the parent (coordinator) id. Without it the agent can
                  write no mailbox and its acks are dropped by the broker.
  --force         init: rotate the fixed identities' passwords in an existing passwd
                  file (minted agents and an existing acl.conf are kept)
  --coordinator-file
                  init: also write <dir>/coordinator.json (mode 0600) with the
                  coordinator's credentials, read by the coordinator's volley-hooks
                  (so no password goes in settings.json). Rotated by --force.
  --volleyd-file  init: also write $VOLLEYD_HOME/broker.json (default
                  ~/.volley/volleyd/broker.json, mode 0600) with volleyd's
                  credentials, read by \`volleyd daemon\` (never put in the launchd
                  plist). Rotated by --force.
  --json          add-agent: print {"username","password"} instead of the bare password
  --no-reload     Do not signal the broker; reload it yourself before relying on the change
  -h, --help      Show this help and exit

Passwords reach mosquitto_passwd on its command line, so they are briefly visible
in the process list while it runs.
`;
