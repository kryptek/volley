import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { MOSQUITTO_ETC_DIRS } from "volley-mcp/config";
import { resolveBrokerUrl } from "../args";
import { LAYOUTS, type Layout, type LayoutName } from "../auth/config";
import { type AuthContext, type AuthDeps, realAuthDeps, withAdmin } from "../auth/context";
import { DynsecError, classify, cmd, deleteClients, listAllClients } from "../auth/dynsec";
import { type MigrateFlags, initOrMigrate } from "../auth/migrate";
import { FIXED_IDENTITIES, RESERVED_AGENT_IDS, badAgentId, isAgentClient } from "../auth/roles";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";
import {
  ACCOUNT_VERBS,
  type AccountFlags,
  type AccountVerb,
  RESERVED_ACCOUNT_NAMES,
  accountVerb,
} from "./auth-accounts";

export type { AuthDeps } from "../auth/context";
export {
  ADMIN_FILE,
  VOLLEYD_ADMIN_FILE,
  VOLLEYD_BROKER_FILE,
  realAuthDeps,
} from "../auth/context";
export { FIXED_IDENTITIES, RESERVED_AGENT_IDS };

export interface AuthArgs {
  argv: string[];
  env: Record<string, string | undefined>;
  io: IO;
}

/**
 * `<first existing mosquitto config dir>/volley` (where the coordinator's hooks look for
 * coordinator.json, volley-mcp's MOSQUITTO_ETC_DIRS), else the layout's. The broker never reads
 * this directory, so it need not follow the layout.
 */
function defaultAuthDir(layout: Layout): string {
  const etc = MOSQUITTO_ETC_DIRS.find((d) => existsSync(d));
  return etc !== undefined ? join(etc, "volley") : layout.authDir;
}

function resolveLayout(flag: string | undefined, deps: AuthDeps): Layout {
  if (flag === undefined) return deps.layout();
  if (!Object.hasOwn(LAYOUTS, flag)) {
    throw new Error(`--layout must be one of ${Object.keys(LAYOUTS).join(", ")}`);
  }
  return LAYOUTS[flag as LayoutName];
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
        layout: { type: "string" },
        config: { type: "string" },
        "state-file": { type: "string" },
        "no-config": { type: "boolean" },
        restart: { type: "boolean" },
        "broker-url": { type: "string" },
        force: { type: "boolean" },
        json: { type: "boolean" },
        "coordinator-file": { type: "boolean" },
        "volleyd-file": { type: "boolean" },
        roles: { type: "boolean" },
        yes: { type: "boolean" },
        worktrees: { type: "string", multiple: true },
        role: { type: "string" },
        kind: { type: "string" },
        label: { type: "string" },
        ttl: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (e) {
    io.stderr(`volley auth: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.USAGE;
  }
  const v = parsed.values;
  if (v.help === true) {
    io.stdout(AUTH_HELP);
    return EXIT.OK;
  }
  const str = (k: string) => v[k] as string | undefined;
  const bool = (k: string) => v[k] === true;

  const [verb, name, ...extra] = parsed.positionals;
  const ACCOUNT = (ACCOUNT_VERBS as readonly string[]).includes(verb ?? "");
  const known = ["init", "migrate", "add-agent", "rm-agent", "list-agents"];
  if (verb === undefined || (!ACCOUNT && !known.includes(verb)) || extra.length > 0) {
    io.stderr(AUTH_HELP);
    return EXIT.USAGE;
  }
  // Each flag belongs to some verbs only.
  const only: Record<string, string[]> = {
    layout: ["init", "migrate"],
    config: ["init", "migrate"],
    "state-file": ["init", "migrate"],
    "no-config": ["init", "migrate"],
    restart: ["init", "migrate"],
    force: ["init"],
    "coordinator-file": ["init", "migrate"],
    "volleyd-file": ["init", "migrate"],
    roles: ["migrate"],
    yes: ["migrate"],
    worktrees: ["migrate"],
  };
  for (const [flag, verbs] of Object.entries(only)) {
    if (v[flag] !== undefined && !verbs.includes(verb)) {
      io.stderr(`volley auth: --${flag} only applies to ${verbs.join(" and ")}\n`);
      return EXIT.USAGE;
    }
  }
  if (!ACCOUNT) {
    for (const flag of ["role", "kind", "label", "ttl"]) {
      if (v[flag] !== undefined) {
        io.stderr(`volley auth: --${flag} only applies to the account verbs\n`);
        return EXIT.USAGE;
      }
    }
  }
  let layout: Layout;
  try {
    layout = resolveLayout(str("layout"), deps);
  } catch (e) {
    io.stderr(`volley auth: ${(e as Error).message}\n`);
    return EXIT.USAGE;
  }
  const ctx: AuthContext = {
    dir: str("dir") ?? env.VOLLEY_AUTH_DIR ?? defaultAuthDir(layout),
    layout,
    url: resolveBrokerUrl(str("broker-url"), env),
    io,
    env,
    deps,
  };

  if (ACCOUNT) {
    const flags: AccountFlags = { json: bool("json") };
    for (const k of ["role", "kind", "label", "ttl"] as const) {
      const s = str(k);
      if (s !== undefined) flags[k] = s;
    }
    return accountVerb(ctx, verb as AccountVerb, name, flags, (fn) => withAdmin(ctx, fn), [
      ...RESERVED_ACCOUNT_NAMES,
      ...RESERVED_AGENT_IDS,
    ]);
  }

  const takesId = verb === "add-agent" || verb === "rm-agent";
  if (takesId !== (name !== undefined)) {
    io.stderr(AUTH_HELP);
    return EXIT.USAGE;
  }

  if (verb === "init" || verb === "migrate") {
    const flags: MigrateFlags = {
      migrate: verb === "migrate",
      force: bool("force"),
      noConfig: bool("no-config"),
      restart: bool("restart"),
      coordinatorFile: bool("coordinator-file"),
      volleydFile: bool("volleyd-file"),
      roles: bool("roles"),
      yes: bool("yes"),
      worktrees: (v.worktrees as string[] | undefined) ?? [],
      config: str("config") ?? layout.config,
      stateFile: str("state-file") ?? layout.stateFile,
    };
    return initOrMigrate(ctx, flags);
  }

  if (verb === "list-agents") {
    return withAdmin(ctx, async ({ session }) => {
      const agents = (await listAllClients(session)).filter(isAgentClient).map((c) => c.username);
      io.stdout(
        bool("json")
          ? `${JSON.stringify({ agents })}\n`
          : agents.length === 0
            ? "No agent logins.\n"
            : `${agents.join("\n")}\n`,
      );
      return EXIT.OK;
    });
  }

  const id = name as string;
  const why = badAgentId(id);
  if (why !== null) {
    io.stderr(`volley auth: ${why}\n`);
    return EXIT.USAGE;
  }
  if (verb === "add-agent") {
    return withAdmin(ctx, async ({ session }) => {
      const password = deps.generatePassword();
      const [r] = await session.run([cmd.createClient(id, password, ["agent"])]);
      const o = r === undefined ? "failed" : classify(r);
      if (o === "exists") {
        io.stderr(
          `volley auth: "${id}" already has a broker login; rm-agent it first for a new password\n`,
        );
        return EXIT.ERROR;
      }
      if (o !== "ok") throw new DynsecError(`createClient ${id}: ${r?.error ?? "no answer"}`);
      io.stdout(bool("json") ? `${JSON.stringify({ username: id, password })}\n` : `${password}\n`);
      return EXIT.OK;
    });
  }

  // rm-agent: idempotent, so a supervisor's retire path can simply retry. Only an agent login.
  return withAdmin(ctx, async ({ session }) => {
    const [r] = await session.run([cmd.getClient(id)]);
    if (r !== undefined && classify(r) === "missing") {
      io.stderr(`volley auth: "${id}" has no broker login; nothing to revoke\n`);
      return EXIT.OK;
    }
    const roles = (
      (r?.data?.client as { roles?: { rolename: string }[] } | undefined)?.roles ?? []
    ).map((x) => x.rolename);
    if (!isAgentClient({ roles })) {
      io.stderr(
        `volley auth: "${id}" is not an agent login (roles: ${roles.join(", ") || "none"}); not deleted\n`,
      );
      return EXIT.ERROR;
    }
    await deleteClients(session, [id]);
    return EXIT.OK;
  });
}

export const AUTH_HELP = `Usage: volley auth <verb> [args] [options]

Broker logins on mosquitto >= 2.1 with the Dynamic Security plugin
(examples/mosquitto-auth/). Changes go to the broker over its control topic: no password
file, no ACL file, no reload. Every verb refuses a broker older than 2.1.

  volley auth init                 Write the broker config (plugin before the listeners,
                                   per_listener_settings false, nodelay, raised queue; the old
                                   one backed up), create the state file with its admin
                                   login, then — once the broker runs it — Volley's eight
                                   shared roles and the fixed identities (volleyd, desk,
                                   coordinator), printing new passwords once. Idempotent:
                                   rerun after the restart it asks for.
  volley auth migrate              From an acl_file / password_file setup: the same as init,
                                   plus new passwords for the fixed identities (written to
                                   the credential files their clients read), a login for each
                                   agent with a .volley/agent.json (keeping the password it
                                   holds, so running agents keep working), and one for each
                                   account in accounts.json; other passwd users are named.
                                   Under sudo it looks in the invoking user's home. Rerunning
                                   changes nothing. Rollback: restore the config backup it names.
  volley auth migrate --roles --yes
                                   Bring the shared roles to this Volley's ACLs. Every client
                                   holding a changed role is disconnected (it reconnects).
  volley auth add-agent <id>       A login for agent <id> (username = id, role volley-agent).
                                   Prints only the password (or --json: the
                                   .volley/agent.json "broker" block).
  volley auth rm-agent <id>        Delete agent <id>'s login. Succeeds if it has none; never
                                   deletes anything but an agent login.
  volley auth list-agents [--json] The agent logins.

Accounts (registry: <dir>/accounts.json; each account is a login with its role's roles):
  volley auth add <name> --role <admin|steer|watch|supervisor|peer> [--kind <k>]
                                   Create an account; prints its password ONCE (or --json).
  volley auth rotate <name>        New password for an account (disconnects its sessions).
  volley auth revoke <name>        Delete the account and its login.
  volley auth list [--json]        The accounts (never their passwords).
  volley auth token [--ttl <s>]    A one-time admin token (vly_admin_…, 10 minutes, single
                                   use, stored hashed in <dir>/tokens.json). Redeemed over
                                   the control channel for an admin account bound to a device.
  volley auth signin-link --role <steer|watch> --label <device> [--ttl <s>]
                                   A one-time sign-in token for one device.
  volley auth redeem --label <device> [--json]
                                   Redeem a token read from STDIN (volleyd runs this): burns it
                                   and creates an account with its role, printed once.

Options:
  --dir <dir>     Where admin.json, accounts.json and tokens.json live (env: VOLLEY_AUTH_DIR;
                  default: <mosquitto config dir>/volley, e.g. /opt/homebrew/etc/mosquitto/volley)
  --broker-url    The broker (env: VOLLEY_BROKER_URL; default mqtt://localhost:1883)
  --layout <name> init, migrate: brew-arm64 | brew-intel | snap | etc | container
                  (default: detected; the snap first on Linux)
  --config <path> init, migrate: the mosquitto.conf to write (default: the layout's)
  --state-file <path>
                  init, migrate: the plugin's state file (default: the layout's; for the
                  snap it must be under /var/snap/mosquitto/common/)
  --no-config     init, migrate: leave the broker config alone (you manage it)
  --restart       init, migrate: restart the broker with the layout's command and continue,
                  instead of asking you to restart and rerun
  --force         init: rotate the fixed identities' passwords (disconnects their sessions)
  --coordinator-file
                  init, migrate: also write <dir>/coordinator.json (mode 0600) with the
                  coordinator's credentials, read by the coordinator's volley-hooks.
  --volleyd-file  init, migrate: also write $VOLLEYD_HOME/broker.json and
                  $VOLLEYD_HOME/dynsec-admin.json (mode 0600; default ~/.volley/volleyd):
                  volleyd's login and the admin login it mints agents with. Under sudo they
                  go to the invoking user's home, owned by that user.
  --worktrees <dir>
                  migrate: where agents' worktrees live (repeatable; default
                  ~/.volley/worktrees and $VOLLEYD_HOME/worktrees)
  --json          add-agent, list-agents and the account verbs: machine-readable output
  --role <role>   add, signin-link: the account's role
  --kind <kind>   add: human | device | machine | service (default from the role)
  --label <text>  signin-link, redeem: the device the account is for (1..64 chars)
  --ttl <s>       token, signin-link: lifetime in seconds (default 600, at most 86400)
  -h, --help      Show this help and exit
`;
