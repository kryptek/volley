import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type BrokerAuth,
  authFromEnv,
  coordinatorAuthPath,
  readCoordinatorAuth,
  resolveBrokerAuth,
} from "volley-mcp/config";
import {
  KEYCHAIN_SERVICE,
  type SavedLoginDeps,
  agentContext,
  savedLoginSource,
  savedLoginSteps,
} from "./coordinator-login";

/**
 * The one broker-login ladder every Volley CLI climbs (`volley …`, `volleyd …`, `volley lease`,
 * `volley peer`): the first step that names a login wins.
 *
 * 1. `flags`: `--username`, with `--password` or `VOLLEY_AUTH_PASSWORD`;
 * 2. `identity_file`: the `broker` block of `<cwd>/.volley/agent.json` (an agent's own login);
 * 3. `env`: `VOLLEY_AUTH_USERNAME` / `VOLLEY_AUTH_PASSWORD`;
 * 4. `auth_dir`: `$VOLLEY_AUTH_DIR/coordinator.json` when the environment names a dir (the MCP
 *    server's rule), never for an agent — the volleyd-run coordinator's session excepted
 *    (`VOLLEY_HOOKS_COORDINATOR=1`, no identity file above `cwd`);
 * 5. `keychain`: the macOS keychain item setup stores (`volley` only; volleyd starts no child);
 * 6. `coordinator_file`: coordinator.json in the auth dir setup recorded, else the default.
 *
 * Steps 5 and 6 are the saved login (coordinator-login.ts): on only once an entry point turns it
 * on, only for a broker on this machine, never for an agent. `skipped` says why each step was not
 * taken, in plain words and never with a value: `volley auth status` prints it.
 */

export type LoginSource =
  | "flags"
  | "identity_file"
  | "env"
  | "auth_dir"
  | "keychain"
  | "coordinator_file";

export interface ResolvedLogin {
  /** The login; null: connect anonymously. */
  auth: BrokerAuth | null;
  source: LoginSource | null;
  /** The file the login came from (`identity_file`, `auth_dir`, `coordinator_file`). */
  path?: string;
  /** One plain reason per step not taken. */
  skipped: string[];
}

export interface LoginInput {
  flags?: { username?: string | undefined; password?: string | undefined };
  env: Record<string, string | undefined>;
  cwd?: string;
  /** The broker the login is for; without it the saved login is never asked. */
  brokerUrl?: string | undefined;
  /** The saved login's sources (default: this process's, null until an entry point opts in). */
  saved?: SavedLoginDeps | null | undefined;
  /** Leave out the identity file step (`volley lease --coordinator`: never an agent's login). */
  identityFile?: boolean;
}

/** What each step is called in `skipped` and `volley auth status`. */
const LABEL: Record<LoginSource, string> = {
  flags: "flags",
  identity_file: "identity file",
  env: "env",
  auth_dir: "auth dir",
  keychain: "keychain",
  coordinator_file: "coordinator.json",
};

const ORDER: readonly LoginSource[] = [
  "flags",
  "identity_file",
  "env",
  "auth_dir",
  "keychain",
  "coordinator_file",
];

/** The login a command in `cwd` connects with, where it came from, and why no other step served. */
export function resolveLogin(input: LoginInput): ResolvedLogin {
  const { env } = input;
  const flags = input.flags ?? {};
  const cwd = input.cwd ?? process.cwd();
  const saved = input.saved === undefined ? savedLoginSource() : input.saved;
  const skipped: string[] = [];
  const found = (
    source: LoginSource,
    auth: BrokerAuth,
    path?: string | null,
    after: string[] = [],
  ): ResolvedLogin => {
    const later = ORDER.slice(ORDER.indexOf(source) + 1)
      .filter((s) => !(s === "identity_file" && input.identityFile === false))
      .map((s) => `${LABEL[s]} (${LABEL[source]} answered first)`);
    return {
      auth,
      source,
      ...(path !== undefined && path !== null ? { path } : {}),
      skipped: [...skipped, ...after, ...later],
    };
  };

  if (flags.username !== undefined) {
    // `--username` + VOLLEY_AUTH_PASSWORD is the documented way to keep the password off argv.
    const password = flags.password ?? env.VOLLEY_AUTH_PASSWORD;
    return found(
      "flags",
      password !== undefined
        ? { username: flags.username, password }
        : { username: flags.username },
    );
  }
  if (flags.password !== undefined) throw new Error("--password requires --username");
  skipped.push("flags (no --username)");

  if (input.identityFile !== false) {
    const file = join(cwd, ".volley", "agent.json");
    // Only the identity file's half of resolveBrokerAuth: VOLLEY_AUTH_* is the next step.
    const fromFile = existsSync(file) ? resolveBrokerAuth({}, cwd) : null;
    if (fromFile !== null) return found("identity_file", fromFile, file);
    skipped.push(
      existsSync(file)
        ? `identity file (${file} has no broker block)`
        : `identity file (no ${file})`,
    );
  }

  const fromEnv = authFromEnv(env);
  if (fromEnv !== null) return found("env", fromEnv);
  skipped.push("env (VOLLEY_AUTH_USERNAME unset)");

  const dirNamed = env.VOLLEY_AUTH_DIR !== undefined && env.VOLLEY_AUTH_DIR !== "";
  const authDir = authDirStep(env, cwd, dirNamed);
  if (authDir.auth !== null) return found("auth_dir", authDir.auth, authDir.path);
  skipped.push(`auth dir (${authDir.why})`);

  // The auth dir step read VOLLEY_AUTH_DIR's coordinator.json already: the file step would too.
  const rest = savedLoginSteps(env, input.brokerUrl, cwd, saved, { fileStep: !dirNamed });
  if (rest.auth !== null && rest.source !== null) {
    return found(rest.source, rest.auth, rest.path, rest.skipped);
  }
  skipped.push(...rest.skipped);
  if (dirNamed) skipped.push("coordinator.json (the auth dir's, above)");
  return { auth: null, source: null, skipped };
}

/** Step 4: `$VOLLEY_AUTH_DIR/coordinator.json`, or why not. */
function authDirStep(
  env: Record<string, string | undefined>,
  cwd: string,
  dirNamed: boolean,
): { auth: BrokerAuth; path: string } | { auth: null; why: string } {
  if (!dirNamed) return { auth: null, why: "VOLLEY_AUTH_DIR unset" };
  if (env.VOLLEY_NO_SAVED_LOGIN !== undefined && env.VOLLEY_NO_SAVED_LOGIN !== "") {
    return { auth: null, why: "VOLLEY_NO_SAVED_LOGIN is set" };
  }
  const agent = agentContext(env, cwd, { coordinatorRole: true });
  if (agent !== null) return { auth: null, why: `agent context: ${agent}` };
  const path = coordinatorAuthPath(env) as string;
  try {
    const auth = readCoordinatorAuth(env);
    return auth !== null ? { auth, path } : { auth: null, why: `no coordinator.json at ${path}` };
  } catch (e) {
    // Another user's file (a root-owned auth dir) is not this user's login; a damaged one throws.
    const m = e instanceof Error ? e.message : String(e);
    if (/\((EACCES|EPERM)\)$/.test(m)) return { auth: null, why: m };
    throw e;
  }
}

/** What this machine knows about a username: a fixed identity, an account's role, or nothing. */
export interface LoginKind {
  kind: "fixed" | "account";
  /** The account's role from the auth dir's accounts.json, when readable. */
  role?: string;
}

/** Whether the broker took the login: the `broker:` line of `volley auth status`. */
export type BrokerResult = "accepted" | "refused" | "unreachable";

/** `volley auth status --json`. Never a password, whatever the source. */
export interface LoginReport {
  username: string | null;
  kind: "fixed" | "account" | null;
  role?: string;
  source: LoginSource | null;
  path?: string;
  broker: { url: string; result: BrokerResult };
  skipped: string[];
}

/** The `--json` object for `login` (whose `kind` came from `loginKind`). */
export function describeLogin(
  login: ResolvedLogin,
  kind: LoginKind | null,
  broker: { url: string; result: BrokerResult },
): LoginReport {
  return {
    username: login.auth?.username ?? null,
    kind: kind?.kind ?? null,
    ...(kind?.role !== undefined ? { role: kind.role } : {}),
    source: login.source,
    ...(login.path !== undefined ? { path: login.path } : {}),
    broker,
    skipped: login.skipped,
  };
}

/** `volley auth status`'s lines for `report`. */
export function loginLines(report: LoginReport): string[] {
  const lines: string[] = [];
  if (report.username === null) {
    lines.push("login:   none (anonymous)");
  } else {
    const what =
      report.kind === "fixed"
        ? "fixed identity"
        : report.role !== undefined
          ? `${report.role} account`
          : "account (role not known here)";
    lines.push(`login:   ${report.username} (${what})`);
  }
  if (report.source !== null) {
    const where =
      report.source === "keychain"
        ? ` (${KEYCHAIN_SERVICE})`
        : report.path !== undefined
          ? ` (${report.path})`
          : "";
    lines.push(`source:  ${LABEL[report.source]}${where}`);
  }
  lines.push(`broker:  ${report.broker.url} · ${report.broker.result}`);
  if (report.skipped.length > 0) lines.push(`not used: ${report.skipped.join(" · ")}`);
  return lines;
}
