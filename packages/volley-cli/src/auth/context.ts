import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { VolleyBroker } from "volley-mcp/broker";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";
import { type Layout, detectLayout } from "./config";
import { DynsecSession, brokerTransport, sysVersion } from "./dynsec";
import { requireBrokerVersion, snapListVersion } from "./version";

/**
 * What every `volley auth` verb shares: its side effects (injectable, so tests never touch a
 * real broker), the credential files, and the admin login to the broker's Dynamic Security
 * plugin.
 */

/** An admin connection to the broker's Dynamic Security plugin. */
export interface AdminLink {
  session: DynsecSession;
  /** The broker's retained `$SYS/broker/version` (null when none is retained). */
  sysVersion: () => Promise<string | null>;
  close: () => Promise<void>;
}

/** Side effects `volley auth` needs, injectable so tests never touch a real broker. */
export interface AuthDeps {
  /** Log in to the broker as the dynsec admin. Throws when it cannot. */
  connectAdmin: (url: string, creds: AdminCredentials) => Promise<AdminLink>;
  /** `<binary> -h` output (it prints its version), or null when there is no such binary. */
  mosquittoVersion: (binary: string) => Promise<string | null>;
  /** `<ctrl> dynsec init <file> <user> <password>`: the state file with its first admin. */
  ctrlInit: (
    ctrl: string,
    stateFile: string,
    user: string,
    password: string,
  ) => Promise<{ code: number; stderr: string }>;
  /** Run the layout's restart command (`--restart`). */
  restart: (command: string) => Promise<{ code: number; stderr: string }>;
  /** This machine's mosquitto install. */
  layout: () => Layout;
  generatePassword: () => string;
  /** `bytes` random bytes as lowercase hex (one-time token ids and secrets). */
  randomHex: (bytes: number) => string;
  /** All of stdin (`redeem` reads its token there, never from argv). */
  readStdin: () => Promise<string>;
  /**
   * The uid/gid the broker drops to when `volley auth` runs as root (a distro mosquitto starts
   * as root, then opens its files as the `mosquitto` user), or null when no hand-off is needed.
   */
  brokerOwner: () => { uid: number; gid: number } | null;
  chown: (path: string, uid: number, gid: number) => void;
  /**
   * When `volley auth` runs as root: the user who ran it through sudo (SUDO_UID / SUDO_GID,
   * home from /etc/passwd), or "root" when there is no such user to hand files to. null when
   * not root.
   */
  invokingUser: (
    env: Record<string, string | undefined>,
  ) => { uid: number; gid: number; home: string } | "root" | null;
  /** How long a restarted broker gets to accept the admin login (`--restart`). */
  restartWaitMs?: number;
}

export interface AdminCredentials {
  username: string;
  password: string;
}

/**
 * Where volleyd keeps its state (volleyd's config-store.ts `volleydHome`, which this mirrors),
 * for the user volleyd runs as: under sudo that is the invoking user, never root.
 */
export function volleydHome(env: Record<string, string | undefined>, sudoHome?: string): string {
  return env.VOLLEYD_HOME ?? join(sudoHome ?? env.HOME ?? homedir(), ".volley", "volleyd");
}

/** volleyd's broker credentials file in $VOLLEYD_HOME (volleyd's broker-auth.ts reads it). */
export const VOLLEYD_BROKER_FILE = "broker.json";
/** The dynsec admin login volleyd mints and retires agents with, in $VOLLEYD_HOME. */
export const VOLLEYD_ADMIN_FILE = "dynsec-admin.json";
/** The dynsec admin login, in the auth directory (mode 0600). */
export const ADMIN_FILE = "admin.json";
/** The snap layout's mosquitto command: absent from current snaps (their broker is a service). */
const SNAP_MOSQUITTO = "/snap/bin/mosquitto";

function run(
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (e) => resolve({ code: 127, stdout, stderr: e.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export const realAuthDeps: AuthDeps = {
  connectAdmin: async (url, creds) => {
    const b = new VolleyBroker();
    await b.connect({
      url,
      agentId: `auth-${randomBytes(3).toString("hex")}`,
      username: creds.username,
      password: creds.password,
    });
    const session = await DynsecSession.open(brokerTransport(b));
    return {
      session,
      sysVersion: () => sysVersion(b),
      close: async () => {
        await session.close();
        await b.disconnect();
      },
    };
  },
  mosquittoVersion: async (binary) => {
    const r = await run(binary, ["-h"]);
    const text = `${r.stdout}\n${r.stderr}`;
    if (r.code !== 127 && /version/.test(text)) return text;
    // The snap's broker is a service with no command in /snap/bin: snapd knows its version.
    if (binary !== SNAP_MOSQUITTO) return null;
    const v = snapListVersion((await run("snap", ["list", "mosquitto"])).stdout);
    return v === null ? null : `mosquitto version ${v}`;
  },
  // The password reaches mosquitto_ctrl on its command line, so it is briefly visible in `ps`.
  ctrlInit: (ctrl, stateFile, user, password) =>
    run(ctrl, ["dynsec", "init", stateFile, user, password]),
  restart: (command) => {
    const [bin, ...args] = command.split(" ");
    return run(bin as string, args);
  },
  layout: () => detectLayout(),
  generatePassword: () => randomBytes(24).toString("base64url"),
  randomHex: (bytes) => randomBytes(bytes).toString("hex"),
  readStdin: async () => {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString("utf-8");
  },
  brokerOwner: () => {
    if (process.getuid?.() !== 0 || !existsSync("/etc/passwd")) return null;
    const line = readFileSync("/etc/passwd", "utf-8")
      .split("\n")
      .find((l) => l.startsWith("mosquitto:"));
    const [, , uid, gid] = line?.split(":") ?? [];
    return uid !== undefined && gid !== undefined ? { uid: Number(uid), gid: Number(gid) } : null;
  },
  chown: (path, uid, gid) => chownSync(path, uid, gid),
  invokingUser: (env) => {
    if (process.getuid?.() !== 0) return null;
    const uid = Number(env.SUDO_UID);
    const gid = Number(env.SUDO_GID);
    if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid <= 0 || env.SUDO_GID === "") {
      return "root";
    }
    const line = existsSync("/etc/passwd")
      ? readFileSync("/etc/passwd", "utf-8")
          .split("\n")
          .find((l) => l.split(":")[2] === String(uid))
      : undefined;
    const home = line?.split(":")[5];
    return home !== undefined && home !== "" ? { uid, gid, home } : "root";
  },
};

/** Write `text` to `path` (mode 0600) by rename: a crash never leaves half a file. */
export function writeSecret(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** `{username, password}` from a 0600 JSON file, or null when there is none. */
export function readCredentials(path: string): AdminCredentials | null {
  if (!existsSync(path)) return null;
  const c = JSON.parse(readFileSync(path, "utf-8")) as Partial<AdminCredentials> | null;
  if (typeof c?.username !== "string" || c.username === "" || typeof c.password !== "string") {
    throw new Error(`${path}: must hold a non-empty string username and a string password`);
  }
  return { username: c.username, password: c.password };
}

/** Everything one `volley auth` run shares. */
export interface AuthContext {
  dir: string;
  layout: Layout;
  url: string;
  io: IO;
  env: Record<string, string | undefined>;
  deps: AuthDeps;
}

/** Report a failure the way every verb does: one `volley auth:` line (plus its detail). */
export function report(io: IO, e: unknown): ExitCode {
  io.stderr(`volley auth: ${e instanceof Error ? e.message : String(e)}\n`);
  return EXIT.ERROR;
}

/**
 * Log in as the dynsec admin (`<dir>/admin.json`) and refuse a broker older than 2.1 before
 * anything is changed. The caller closes the link.
 */
export async function openAdmin(ctx: AuthContext): Promise<AdminLink> {
  const path = join(ctx.dir, ADMIN_FILE);
  const creds = readCredentials(path);
  if (creds === null) {
    throw new Error(`${path} does not exist; run \`volley auth init\` first`);
  }
  let link: AdminLink;
  try {
    link = await ctx.deps.connectAdmin(ctx.url, creds);
  } catch (e) {
    throw new Error(
      `cannot log in to the broker at ${ctx.url} as ${creds.username}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  try {
    await requireBrokerVersion({
      sys: link.sysVersion,
      binary: () => ctx.deps.mosquittoVersion(binaryOf(ctx.layout)),
    });
  } catch (e) {
    await link.close().catch(() => {});
    throw e;
  }
  return link;
}

/** The mosquitto binary of `layout` (the snap's wrapper, not a distro 2.0 earlier on PATH). */
export const binaryOf = (layout: Layout) => (layout.name === "snap" ? SNAP_MOSQUITTO : "mosquitto");

/** Directories holding one `.volley/agent.json` per agent: `<root>/<wave>/<task>-<role>`. */
export function agentJsonFiles(roots: readonly string[]): string[] {
  const out: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const wave of readdirSync(root, { withFileTypes: true })) {
      if (!wave.isDirectory()) continue;
      for (const wt of readdirSync(join(root, wave.name), { withFileTypes: true })) {
        const p = join(root, wave.name, wt.name, ".volley", "agent.json");
        if (wt.isDirectory() && existsSync(p)) out.push(p);
      }
    }
  }
  return out.sort();
}

/** Create `dir` (0700) and hand every directory it created, plus `files`, to `user`. */
export function ensureOwnedDir(
  deps: AuthDeps,
  dir: string,
  user: { uid: number; gid: number } | null,
): string[] {
  const first = mkdirSync(dir, { recursive: true, mode: 0o700 });
  const created: string[] = [];
  if (first !== undefined) {
    for (let d = dir; ; d = dirname(d)) {
      created.unshift(d);
      if (d === first || d === dirname(d)) break;
    }
  }
  if (user !== null) for (const d of created) deps.chown(d, user.uid, user.gid);
  return created;
}

/**
 * Under sudo, the snap layout's auth dir and the files in it (admin.json, coordinator.json, the
 * account and token registries) go to the invoking user, as ~/.volley/volleyd/dynsec-admin.json
 * does: the user-level setup and the coordinator's CLIs read and rewrite them. mosquitto never
 * reads this dir (its state file, outside it, stays root's). Other layouts, and root with no sudo
 * user, keep them root's, and so does a dir that holds mosquitto's config or state file
 * (`--dir` at /var/snap/mosquitto/common). `volley setup` and `volley auth` call it when they
 * finish, since a registry rewritten by rename comes back root's.
 */
export function handAuthDirToInvoker(ctx: Pick<AuthContext, "dir" | "layout" | "env" | "deps">) {
  if (ctx.layout.name !== "snap" || !existsSync(ctx.dir)) return;
  const dir = resolve(ctx.dir);
  if ([ctx.layout.config, ctx.layout.stateFile].some((f) => dirname(resolve(f)) === dir)) return;
  const user = ctx.deps.invokingUser(ctx.env);
  if (typeof user !== "object" || user === null) return;
  ctx.deps.chown(ctx.dir, user.uid, user.gid);
  for (const e of readdirSync(ctx.dir, { withFileTypes: true })) {
    if (e.isFile()) ctx.deps.chown(join(ctx.dir, e.name), user.uid, user.gid);
  }
}

/**
 * handAuthDirToInvoker when a command finishes: a failed handover (EPERM, a file renamed away
 * mid-walk) is a warning, never the command's exit code or message.
 */
export function handAuthDirOnExit(
  ctx: Pick<AuthContext, "dir" | "layout" | "env" | "deps">,
  warn: (line: string) => void,
) {
  try {
    handAuthDirToInvoker(ctx);
  } catch (e) {
    warn(
      `could not give ${ctx.dir} to the sudo user (${e instanceof Error ? e.message : String(e)}); ` +
        `fix it with: sudo chown -R "$SUDO_USER" ${ctx.dir}`,
    );
  }
}

/** Run `fn` on an admin link, closing it and reporting any failure. */
export async function withAdmin(
  ctx: AuthContext,
  fn: (link: AdminLink) => Promise<ExitCode>,
): Promise<ExitCode> {
  let link: AdminLink;
  try {
    link = await openAdmin(ctx);
  } catch (e) {
    return report(ctx.io, e);
  }
  try {
    return await fn(link);
  } catch (e) {
    return report(ctx.io, e);
  } finally {
    await link.close().catch(() => {});
  }
}
