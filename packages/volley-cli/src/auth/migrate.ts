import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readAccounts } from "../commands/auth-accounts";
import { EXIT, type ExitCode } from "../exit-codes";
import { configTraps, generateConfig, writeConfig } from "./config";
import {
  ADMIN_FILE,
  type AdminLink,
  type AuthContext,
  VOLLEYD_ADMIN_FILE,
  VOLLEYD_BROKER_FILE,
  agentJsonFiles,
  binaryOf,
  ensureOwnedDir,
  openAdmin,
  readCredentials,
  report,
  volleydHome,
  writeSecret,
} from "./context";
import {
  applyRoleDrift,
  classify,
  clientOf,
  cmd,
  ensureClients,
  ensureRoles,
  roleDrift,
} from "./dynsec";
import {
  ACCOUNT_ROLE_MAP,
  DYNSEC_ADMIN_USER,
  FIXED_CLIENTS,
  FIXED_IDENTITIES,
  VOLLEY_ROLES,
  roleName,
} from "./roles";
import { BrokerVersionError, requireBrokerVersion } from "./version";

/**
 * `volley auth init` and `volley auth migrate`: one idempotent procedure. Each run does what is
 * still missing and leaves the rest alone, so a rerun after the broker restart it asks for
 * completes the setup, and a rerun after that changes nothing.
 *
 *   1. refuse a broker older than 2.1 (nothing else runs);
 *   2. the broker config: refuse the traps, write it atomically with a backup (unless --no-config);
 *   3. the plugin's state file with its first admin (`mosquitto_ctrl dynsec init`), whose login
 *      is stored 0600 in <dir>/admin.json;
 *   4. once the broker runs the plugin: the eight shared roles (created once, never edited
 *      here) and the fixed identities, with new passwords printed once and written to the
 *      credential files their clients read;
 *   5. migrate only: a login for every agent with a `.volley/agent.json` (the file gets the new
 *      password) and for every account in accounts.json.
 */

export interface MigrateFlags {
  migrate: boolean;
  force: boolean;
  noConfig: boolean;
  restart: boolean;
  coordinatorFile: boolean;
  volleydFile: boolean;
  roles: boolean;
  yes: boolean;
  worktrees: string[];
  config: string;
  stateFile: string;
}

const RESTART_WAIT_MS = 10_000;

/** The files an `include_dir` line names, as text (mosquitto reads them as part of the config). */
function includedFiles(configText: string): string[] {
  const out: string[] = [];
  for (const line of configText.split("\n")) {
    const m = /^\s*include_dir\s+(\S+)/.exec(line);
    if (m === null) continue;
    const dir = m[1] as string;
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)
      .filter((x) => x.endsWith(".conf"))
      .sort()) {
      out.push(readFileSync(join(dir, f), "utf-8"));
    }
  }
  return out;
}

export async function initOrMigrate(ctx: AuthContext, f: MigrateFlags): Promise<ExitCode> {
  const { io, deps, layout, dir } = ctx;
  const verb = f.migrate ? "migrate" : "init";
  const adminPath = join(dir, ADMIN_FILE);

  // Who volleyd's files belong to: under sudo, the invoking user; a bare root must name the home.
  const invoker = deps.invokingUser(ctx.env);
  const sudoUser = typeof invoker === "object" && invoker !== null ? invoker : null;
  if (f.volleydFile && invoker === "root" && ctx.env.VOLLEYD_HOME === undefined) {
    io.stderr(
      "volley auth: running as root with no sudo user, so whose volleyd home is unknown; set VOLLEYD_HOME to the home of the user volleyd runs as\n",
    );
    return EXIT.USAGE;
  }

  // 1. Version first: nothing is written for a broker that cannot run Volley's roles.
  let existingAdmin: ReturnType<typeof readCredentials>;
  try {
    existingAdmin = readCredentials(adminPath);
  } catch (e) {
    return report(io, e);
  }
  try {
    await requireBrokerVersion({
      sys: async () => {
        if (existingAdmin === null) return null;
        const link = await deps.connectAdmin(ctx.url, existingAdmin);
        try {
          return await link.sysVersion();
        } finally {
          await link.close().catch(() => {});
        }
      },
      binary: () => deps.mosquittoVersion(binaryOf(layout)),
    });
  } catch (e) {
    if (e instanceof BrokerVersionError) {
      io.stderr(`volley auth: ${e.code}: ${e.message}\n`);
      return EXIT.ERROR;
    }
    return report(io, e);
  }

  if (f.roles) {
    if (!f.migrate) return report(io, "--roles only applies to migrate");
    return migrateRoles(ctx, f.yes);
  }

  const out: string[] = [];
  let restartNeeded = false;

  // 2. The broker config.
  if (!f.noConfig) {
    const current = existsSync(f.config) ? readFileSync(f.config, "utf-8") : "";
    const traps = configTraps(current, includedFiles(current));
    if (traps.length > 0) {
      io.stderr(
        `volley auth: refusing to replace ${f.config}:\n${traps.map((t) => `  - ${t}`).join("\n")}\nFix it (or move it aside) and rerun.\n`,
      );
      return EXIT.ERROR;
    }
    const w = writeConfig(
      f.config,
      generateConfig({ ...layout, stateFile: f.stateFile }),
      io.now(),
    );
    if (w.written) {
      restartNeeded = true;
      out.push(`Wrote ${f.config}.`);
      if (w.backup !== null) {
        out.push(`Backed the previous config up to ${w.backup} (rollback: copy it back, restart).`);
      }
    }
  }

  // 3. The state file and its admin.
  let admin = existingAdmin;
  if (admin === null) {
    if (existsSync(f.stateFile)) {
      return report(
        io,
        `${f.stateFile} exists but ${adminPath} does not: put its admin login there as {"username","password"} (mode 0600), or move the state file aside to start over`,
      );
    }
    ensureOwnedDir(deps, dir, null);
    const password = deps.generatePassword();
    const r = await deps.ctrlInit(layout.ctrl, f.stateFile, DYNSEC_ADMIN_USER, password);
    if (r.code !== 0 || !existsSync(f.stateFile)) {
      io.stderr(
        `volley auth: ${layout.ctrl} dynsec init ${f.stateFile} failed (exit ${r.code}): ${r.stderr.trim()}\n`,
      );
      if (r.code === 127) io.stderr("Hint: mosquitto_ctrl ships with mosquitto >= 2.0.\n");
      return EXIT.ERROR;
    }
    admin = { username: DYNSEC_ADMIN_USER, password };
    writeSecret(adminPath, `${JSON.stringify(admin)}\n`);
    const owner = deps.brokerOwner();
    if (owner !== null) deps.chown(f.stateFile, owner.uid, owner.gid);
    restartNeeded = true;
    out.push(
      `Created ${f.stateFile} with the admin login ${DYNSEC_ADMIN_USER} (stored in ${adminPath}, mode 0600).`,
    );
  }

  // 4. Roles and identities need the broker running the plugin.
  let link: AdminLink | null = null;
  const tryOpen = async () => {
    try {
      link = await openAdmin(ctx);
      return null;
    } catch (e) {
      return e;
    }
  };
  let why = await tryOpen();
  if (why !== null && f.restart) {
    const r = await deps.restart(layout.restart);
    if (r.code !== 0) {
      return report(io, `\`${layout.restart}\` failed (exit ${r.code}): ${r.stderr.trim()}`);
    }
    restartNeeded = false;
    out.push(`Restarted the broker (${layout.restart}).`);
    const until = Date.now() + (deps.restartWaitMs ?? RESTART_WAIT_MS);
    while (why !== null && Date.now() < until) {
      await new Promise((res) => setTimeout(res, 250));
      why = await tryOpen();
    }
  }
  if (why !== null || link === null) {
    if (why instanceof BrokerVersionError) {
      io.stderr(`volley auth: ${why.code}: ${why.message}\n`);
      return EXIT.ERROR;
    }
    io.stdout(
      [
        ...out,
        "",
        `Next: restart the broker so it loads the plugin (${layout.restart}), then run`,
        `\`volley auth ${verb}\` again: it creates Volley's roles and identities.`,
        `(${why instanceof Error ? why.message : String(why)})`,
        "",
      ].join("\n"),
    );
    return EXIT.ERROR;
  }
  const admin_ = link as AdminLink;
  try {
    const roles = await ensureRoles(admin_.session);
    if (roles.created.length > 0) {
      out.push(`Created the shared roles ${roles.created.map(roleName).join(", ")}.`);
    }
    for (const d of roles.drifted) {
      out.push(
        `Warning: role ${roleName(d.role)} differs from this Volley (${d.missing.length} ACL(s) missing, ${d.extra.length} extra); \`volley auth migrate --roles --yes\` updates it and disconnects every client holding it.`,
      );
    }

    const minted = await fixedIdentities(ctx, admin_, f, sudoUser, out);
    if (f.migrate) {
      await migrateAgents(ctx, admin_, f, out);
      await migrateAccounts(ctx, admin_, out, minted);
    }
    if (minted.length > 0) {
      out.push(
        "",
        "New passwords (shown ONCE; store them now):",
        ...minted.map(([user, pw]) => `  ${user.padEnd(14)} ${pw}`),
      );
    }
  } catch (e) {
    return report(io, e);
  } finally {
    await admin_.close().catch(() => {});
  }

  if (restartNeeded) out.push("", `Restart the broker to apply the new config: ${layout.restart}`);
  if (out.length === 0)
    out.push("Nothing to do: the broker already has Volley's roles and identities.");
  io.stdout(`${out.join("\n")}\n`);
  return EXIT.OK;
}

/** The fixed identities: created with new passwords, or rotated with --force. */
async function fixedIdentities(
  ctx: AuthContext,
  link: AdminLink,
  f: MigrateFlags,
  sudoUser: { uid: number; gid: number; home: string } | null,
  out: string[],
): Promise<[string, string][]> {
  const { deps, dir, env } = ctx;
  {
    const wanted = FIXED_IDENTITIES.map((username) => ({
      username,
      password: deps.generatePassword(),
      roles: FIXED_CLIENTS[username],
    }));
    const r = await ensureClients(link.session, wanted);
    const fresh = new Map<string, string>();
    wanted.forEach((w, i) => {
      if (r[i] === "created") fresh.set(w.username, w.password);
    });
    if (f.force) {
      const rotate = wanted.filter((w) => !fresh.has(w.username));
      for (const a of await link.session.run(
        rotate.map((w) => cmd.setClientPassword(w.username, w.password)),
      )) {
        if (classify(a) !== "ok") throw new Error(`setClientPassword: ${a.error}`);
      }
      for (const w of rotate) fresh.set(w.username, w.password);
      if (rotate.length > 0) {
        out.push(
          `Rotated ${rotate.map((w) => w.username).join(", ")} (their sessions were disconnected).`,
        );
      }
    }
    const kept = FIXED_IDENTITIES.filter((u) => !fresh.has(u));
    if (kept.length > 0 && fresh.size > 0) {
      out.push(`Kept the existing logins of ${kept.join(", ")} (--force rotates them).`);
    }

    // The coordinator's hooks read coordinator.json; volleyd reads broker.json and the admin login.
    const coordinatorFile = join(dir, "coordinator.json");
    const coordinatorPw = fresh.get("coordinator");
    if (coordinatorPw !== undefined && (f.coordinatorFile || existsSync(coordinatorFile))) {
      writeSecret(
        coordinatorFile,
        `${JSON.stringify({ username: "coordinator", password: coordinatorPw })}\n`,
      );
      out.push(`Wrote ${coordinatorFile} (mode 0600): the coordinator's hook credentials.`);
    }
    const vdir = volleydHome(env, sudoUser?.home);
    const brokerFile = join(vdir, VOLLEYD_BROKER_FILE);
    const adminFile = join(vdir, VOLLEYD_ADMIN_FILE);
    const volleydPw = fresh.get("volleyd");
    const wantVolleyd = f.volleydFile || existsSync(brokerFile);
    if (wantVolleyd && (volleydPw !== undefined || !existsSync(adminFile))) {
      ensureOwnedDir(deps, vdir, sudoUser);
      const files: string[] = [];
      if (volleydPw !== undefined) {
        writeSecret(
          brokerFile,
          `${JSON.stringify({ username: "volleyd", password: volleydPw })}\n`,
        );
        files.push(brokerFile);
      }
      const admin = readCredentials(join(dir, ADMIN_FILE));
      if (admin !== null) {
        writeSecret(adminFile, `${JSON.stringify(admin)}\n`);
        files.push(adminFile);
      }
      if (sudoUser !== null) for (const p of files) deps.chown(p, sudoUser.uid, sudoUser.gid);
      out.push(
        `Wrote ${files.join(" and ")} (mode 0600): volleyd's login and the admin login it mints agents with (run volleyd as the user that owns them${sudoUser !== null ? `, uid ${sudoUser.uid}` : ""}).`,
      );
    }
    if (fresh.size > 0) {
      out.push(
        "Give each client its identity: coordinator sessions VOLLEY_AUTH_USERNAME=coordinator +",
        "VOLLEY_AUTH_PASSWORD in the MCP server env and your shell profile (or coordinator.json);",
        "the Desk / volley dash: sign in as desk; volleyd: $VOLLEYD_HOME/broker.json (--volleyd-file).",
      );
    }
    return [...fresh];
  }
}

interface AgentFile {
  agent_id?: unknown;
  broker?: { username?: unknown; password?: unknown };
  [k: string]: unknown;
}

/** One login per agent with a minted `.volley/agent.json`; the file gets the new password. */
async function migrateAgents(
  ctx: AuthContext,
  link: AdminLink,
  f: MigrateFlags,
  out: string[],
): Promise<void> {
  const roots =
    f.worktrees.length > 0
      ? f.worktrees
      : [
          join(ctx.env.HOME ?? homedir(), ".volley", "worktrees"),
          ...(ctx.env.VOLLEYD_HOME !== undefined ? [join(ctx.env.VOLLEYD_HOME, "worktrees")] : []),
        ];
  const found: { path: string; id: string; file: AgentFile }[] = [];
  for (const path of agentJsonFiles(roots)) {
    let file: AgentFile;
    try {
      file = JSON.parse(readFileSync(path, "utf-8")) as AgentFile;
    } catch {
      out.push(`Skipped ${path}: not JSON.`);
      continue;
    }
    if (typeof file.agent_id !== "string" || file.broker === undefined) continue;
    found.push({ path, id: file.agent_id, file });
  }
  if (found.length === 0) return;
  {
    const exist = await link.session.run(found.map((a) => cmd.getClient(a.id)));
    const todo = found.filter((_a, i) => classify(exist[i] as never) === "missing");
    if (todo.length === 0) return;
    const pws = todo.map(() => ctx.deps.generatePassword());
    const made = await link.session.run(
      todo.map((a, i) => cmd.createClient(a.id, pws[i] as string, ["agent"])),
    );
    todo.forEach((a, i) => {
      const r = made[i];
      if (r === undefined || classify(r) !== "ok") {
        out.push(`Could not create ${a.id}'s login: ${r?.error ?? "no answer"}.`);
        return;
      }
      const next = { ...a.file, broker: { username: a.id, password: pws[i] } };
      writeSecret(a.path, `${JSON.stringify(next, null, 2)}\n`);
    });
    out.push(
      `Created ${todo.length} agent login(s) and updated their .volley/agent.json: ${todo.map((a) => a.id).join(", ")}.`,
    );
  }
}

/** One login per accounts.json entry, holding its role's roles; new passwords printed once. */
async function migrateAccounts(
  ctx: AuthContext,
  link: AdminLink,
  out: string[],
  minted: [string, string][],
): Promise<void> {
  const accounts = readAccounts(ctx.dir);
  if (accounts.length > 0) {
    {
      const exist = await link.session.run(accounts.map((a) => cmd.getClient(a.name)));
      const todo = accounts.filter((_a, i) => clientOf(exist[i] as never) === null);
      const pws = todo.map(() => ctx.deps.generatePassword());
      const made = await link.session.run(
        todo.map((a, i) => cmd.createClient(a.name, pws[i] as string, ACCOUNT_ROLE_MAP[a.role])),
      );
      todo.forEach((a, i) => {
        if (classify(made[i] as never) === "ok") minted.push([a.name, pws[i] as string]);
        else out.push(`Could not create account ${a.name}'s login: ${made[i]?.error}.`);
      });
      if (todo.length > 0) out.push(`Created ${todo.length} account login(s) (passwords below).`);
    }
  }
  const tokens = join(ctx.dir, "tokens.json");
  if (existsSync(tokens)) {
    const now = ctx.io.now().getTime();
    const list =
      (
        JSON.parse(readFileSync(tokens, "utf-8")) as {
          tokens?: { used_at?: string; expires_at: string }[];
        }
      ).tokens ?? [];
    const pending = list.filter((t) => t.used_at === undefined && Date.parse(t.expires_at) > now);
    if (pending.length > 0) {
      out.push(
        `${pending.length} pending one-time token(s) were not migrated (only their hash is stored); issue new ones with \`volley auth token\` / signin-link.`,
      );
    }
  }
  if (existsSync(join(ctx.dir, "passwd")) || existsSync(join(ctx.dir, "acl.conf"))) {
    out.push(
      `The broker no longer reads ${join(ctx.dir, "passwd")} / acl.conf; keep them until you no longer need the rollback.`,
    );
  }
}

/** `migrate --roles`: show the role changes; with --yes, apply them (disconnecting holders). */
async function migrateRoles(ctx: AuthContext, yes: boolean): Promise<ExitCode> {
  const { io } = ctx;
  let link: AdminLink;
  try {
    link = await openAdmin(ctx);
  } catch (e) {
    return report(io, e);
  }
  try {
    await ensureRoles(link.session, VOLLEY_ROLES);
    const drift = await roleDrift(link.session, VOLLEY_ROLES);
    if (drift.length === 0) {
      io.stdout("The shared roles already match this Volley.\n");
      return EXIT.OK;
    }
    const plan = drift.map(
      (d) =>
        `  ${roleName(d.role)}: ${d.missing.length} ACL(s) to add, ${d.extra.length} to remove`,
    );
    if (!yes) {
      io.stderr(
        [
          "volley auth: WARNING: clients holding these roles will be disconnected (they reconnect):",
          ...plan,
          "Nothing was changed. Rerun with --yes to apply.",
          "",
        ].join("\n"),
      );
      return EXIT.ERROR;
    }
    await applyRoleDrift(link.session, drift);
    io.stdout(
      ["Updated the shared roles (their holders were disconnected):", ...plan, ""].join("\n"),
    );
    return EXIT.OK;
  } catch (e) {
    return report(io, e);
  } finally {
    await link.close().catch(() => {});
  }
}
