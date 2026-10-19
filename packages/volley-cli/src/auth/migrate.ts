import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readAccounts } from "../commands/auth-accounts";
import { EXIT, type ExitCode } from "../exit-codes";
import { readSetupInstall } from "../setup/journal";
import { unifiedDiff } from "../setup/step";
import {
  configListeners,
  configTraps,
  generateConfig,
  listenerChanges,
  sameConfig,
  writeConfig,
} from "./config";
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
  inspectRoles,
} from "./dynsec";
import {
  ACCOUNT_ROLE_MAP,
  DYNSEC_ADMIN_USER,
  FIXED_CLIENTS,
  FIXED_IDENTITIES,
  VOLLEY_ROLES,
  badAgentId,
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
 *   5. migrate only: a login for every agent with a `.volley/agent.json`, keeping the password
 *      the file already holds (the running agent keeps working), and for every account in
 *      accounts.json; any other user in the old password file is named as not migrated.
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
export function includedFiles(configText: string): string[] {
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
    // The WebSocket listener on 9001 keeps its bind (`volley setup --lan` opened it to the LAN,
    // or the config's own; never another WebSocket listener's); with none to read, the LAN
    // choice setup.json recorded.
    const found = configListeners(current).find(
      (l) => l.protocol === "websockets" && l.port === 9001,
    )?.bind;
    const recorded = readSetupInstall(volleydHome(ctx.env, sudoUser?.home))?.lan;
    const wsBind = found ?? (recorded === true ? "" : layout.bind);
    const wanted = generateConfig({ ...layout, stateFile: f.stateFile, wsBind });
    // Shown before it is written (a config `volley setup` wrote differs only in its header and
    // is left as it is).
    if (current !== "" && !sameConfig(current, wanted)) {
      io.stdout(
        `Changes to ${f.config}:\n${listenerChanges(current, wanted)
          .map((c) => `${c}\n`)
          .join("")}${unifiedDiff(f.config, current, wanted)}\n\n`,
      );
    }
    const w = writeConfig(f.config, wanted, io.now());
    if (w.written) {
      restartNeeded = true;
      out.push(`Wrote ${f.config}.`);
      if (wsBind !== layout.bind) {
        // Only a LAN bind on a loopback layout is `volley setup --lan`'s, which `--no-lan` closes.
        const lan = wsBind === "" && layout.bind !== "";
        out.push(
          `Kept the WebSocket listener (9001) ${lan ? "open to the LAN" : `on ${wsBind}`}, as ${found !== undefined ? "the previous config had it" : "`volley setup` recorded"}${lan ? " (`volley setup --no-lan` closes it)" : ""}.`,
        );
      }
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
      const agents = await migrateAgents(ctx, admin_, f, invoker, out);
      await migrateAccounts(ctx, admin_, out, minted, agents);
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

type InvokingUser = ReturnType<AuthContext["deps"]["invokingUser"]>;

/**
 * One login per agent with a minted `.volley/agent.json`, created with the password the file
 * already holds: the agent's MCP server and hooks read it at start, so a new one would lock every
 * running agent out after the broker restart. A file without a password gets a new one, written
 * to the file BEFORE the login exists (a crash in between leaves a file a rerun picks up, never a
 * login whose password nobody knows). Returns every agent id found.
 */
async function migrateAgents(
  ctx: AuthContext,
  link: AdminLink,
  f: MigrateFlags,
  invoker: InvokingUser,
  out: string[],
): Promise<string[]> {
  // Under sudo HOME is root's and env_reset drops VOLLEYD_HOME: the agents are the invoking user's.
  const home = typeof invoker === "object" && invoker !== null ? invoker.home : undefined;
  const roots =
    f.worktrees.length > 0
      ? f.worktrees
      : [
          join(home ?? ctx.env.HOME ?? homedir(), ".volley", "worktrees"),
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
    const why = badAgentId(file.agent_id);
    if (why !== null) {
      out.push(`Skipped ${path}: ${why}.`);
      continue;
    }
    found.push({ path, id: file.agent_id, file });
  }
  if (found.length === 0) {
    out.push(`No agent to migrate under ${roots.join(", ")} (--worktrees names other roots).`);
    return [];
  }
  const exist = await link.session.run(found.map((a) => cmd.getClient(a.id)));
  const todo = found.filter((_a, i) => classify(exist[i] as never) === "missing");
  if (todo.length === 0) return found.map((a) => a.id);
  const fresh: string[] = [];
  const pws = todo.map((a) => {
    const b = a.file.broker;
    if (typeof b?.password === "string" && b.password !== "" && b.username === a.id) {
      return b.password;
    }
    const pw = ctx.deps.generatePassword();
    // Root writes the file: hand it back to whoever owned it, or the agent can no longer read it.
    const owner = invoker !== null ? statSync(a.path) : null;
    writeSecret(
      a.path,
      `${JSON.stringify({ ...a.file, broker: { username: a.id, password: pw } }, null, 2)}\n`,
    );
    if (owner !== null) ctx.deps.chown(a.path, owner.uid, owner.gid);
    fresh.push(a.id);
    return pw;
  });
  const made = await link.session.run(
    todo.map((a, i) => cmd.createClient(a.id, pws[i] as string, ["agent"])),
  );
  const created: string[] = [];
  todo.forEach((a, i) => {
    const r = made[i];
    if (r === undefined || classify(r) !== "ok") {
      out.push(`Could not create ${a.id}'s login: ${r?.error ?? "no answer"}.`);
    } else created.push(a.id);
  });
  if (created.length > 0) {
    out.push(
      `Created ${created.length} agent login(s) with the passwords their .volley/agent.json holds: ${created.join(", ")}.`,
    );
  }
  const restart = fresh.filter((id) => created.includes(id));
  if (restart.length > 0) {
    out.push(
      `Their .volley/agent.json had no password, so it now holds a new one; restart these agents: ${restart.join(", ")}.`,
    );
  }
  return found.map((a) => a.id);
}

/** One login per accounts.json entry, holding its role's roles; new passwords printed once. */
async function migrateAccounts(
  ctx: AuthContext,
  link: AdminLink,
  out: string[],
  minted: [string, string][],
  agents: readonly string[],
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
  const passwd = join(ctx.dir, "passwd");
  if (existsSync(passwd)) {
    // Everyone else in the old password file (someone added them by hand) gets no login: say so.
    const known = new Set<string>([
      ...FIXED_IDENTITIES,
      DYNSEC_ADMIN_USER,
      ...agents,
      ...accounts.map((a) => a.name),
    ]);
    const others = readFileSync(passwd, "utf-8")
      .split("\n")
      .map((l) => l.split(":")[0]?.trim() ?? "")
      .filter((u) => u !== "" && !u.startsWith("#") && !known.has(u))
      // An O2 one-time token's login: its token is reported above.
      .filter((u) => !/^redeem-[0-9a-f]{8}$/.test(u));
    if (others.length > 0) {
      out.push(
        `Users in ${passwd} not migrated: ${others.join(", ")} (give each a login with \`volley auth add\` or \`volley auth add-agent\`).`,
      );
    }
  }
  if (existsSync(passwd) || existsSync(join(ctx.dir, "acl.conf"))) {
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
    // Read-only until --yes: without it nothing is created or edited.
    const { missing, drifted: drift } = await inspectRoles(link.session, VOLLEY_ROLES);
    if (drift.length === 0 && missing.length === 0) {
      io.stdout("The shared roles already match this Volley.\n");
      return EXIT.OK;
    }
    const plan = [
      ...missing.map((r) => `  ${roleName(r)}: missing, to create`),
      ...drift.map(
        (d) =>
          `  ${roleName(d.role)}: ${d.missing.length} ACL(s) to add, ${d.extra.length} to remove`,
      ),
    ];
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
    if (missing.length > 0) await ensureRoles(link.session, missing);
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
