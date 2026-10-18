import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
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
}

/** The identities every Volley deployment has; agents get their own via add-agent. */
export const FIXED_IDENTITIES = ["volleyd", "desk", "coordinator"] as const;

/** The shipped ACL; the CLI runs from source (no build step), so it is a repo-relative path. */
const BUNDLED_ACL = new URL("../../../../examples/mosquitto-auth/acl.conf", import.meta.url);

/** Where Homebrew / distro packages keep mosquitto.conf; the first that exists gets a `volley/` dir. */
const MOSQUITTO_ETC_DIRS = [
  "/opt/homebrew/etc/mosquitto",
  "/usr/local/etc/mosquitto",
  "/etc/mosquitto",
];

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
};

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
        force: { type: "boolean" },
        json: { type: "boolean" },
        "no-reload": { type: "boolean" },
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

  if (verb === "init") {
    if (existsSync(passwdFile) && parsed.values.force !== true) {
      io.stderr(
        `volley auth: ${passwdFile} already exists; re-run with --force to replace every identity's password\n`,
      );
      return EXIT.ERROR;
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    copyFileSync(BUNDLED_ACL, aclFile);
    chmodSync(aclFile, 0o600);

    const minted: [string, string][] = [];
    for (const [i, user] of FIXED_IDENTITIES.entries()) {
      const password = deps.generatePassword();
      const args =
        i === 0 ? ["-c", "-b", passwdFile, user, password] : ["-b", passwdFile, user, password];
      if (!(await passwd(deps, io, args))) return EXIT.ERROR;
      minted.push([user, password]);
    }
    chmodSync(passwdFile, 0o600);

    io.stdout(
      [
        `Wrote ${passwdFile} and ${aclFile}.`,
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
        "  - coordinator sessions: VOLLEY_AUTH_USERNAME=coordinator VOLLEY_AUTH_PASSWORD=<pw> in the MCP server env",
        "  - volley dash / Desk:   sign in as desk in the browser",
        "  - volleyd:              its config file",
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
  if (!existsSync(passwdFile)) {
    io.stderr(`volley auth: ${passwdFile} does not exist; run \`volley auth init\` first\n`);
    return EXIT.ERROR;
  }

  if (verb === "add-agent") {
    const password = deps.generatePassword();
    if (!(await passwd(deps, io, ["-b", passwdFile, id, password]))) return EXIT.ERROR;
    await reload(deps, io, skipReload);
    io.stdout(
      parsed.values.json === true
        ? `${JSON.stringify({ username: id, password })}\n`
        : `${password}\n`,
    );
    return EXIT.OK;
  }

  if (!(await passwd(deps, io, ["-D", passwdFile, id]))) return EXIT.ERROR;
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
  volley auth rm-agent <id>        Revoke agent <id>.

Options:
  --dir <dir>     Where passwd and acl.conf live (env: VOLLEY_AUTH_DIR;
                  default: <mosquitto etc dir>/volley, e.g. /opt/homebrew/etc/mosquitto/volley)
  --force         init: replace an existing passwd file (rotates every fixed identity)
  --json          add-agent: print {"username","password"} instead of the bare password
  --no-reload     Do not signal the broker; reload it yourself before relying on the change
  -h, --help      Show this help and exit
`;
