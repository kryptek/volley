import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { VolleyError } from "./errors";
import { isValidAgentId, isValidNamespace } from "./topics";
import { randomSuffix } from "./util";

export interface VolleyConfig {
  brokerUrl: string;
  namespace: string;
  agentId: string;
  parentId: string | null;
  /** Broker credentials; absent means connect anonymously. */
  auth?: BrokerAuth;
  /** The Claude account profile a supervisor launched the agent under (agent.json `claude_account`). */
  claudeAccount?: string;
  /**
   * The stable coordinator name (`VOLLEY_COORDINATOR`, SPEC §6.2) a wave may name as its owner,
   * so a session keeps its waves across restarts. Checked by `vol_register` (`checkCoordinator`).
   */
  coordinator?: string;
  /**
   * The cmux surface (pane) the server runs in (`CMUX_SURFACE_ID`). Recorded on the registry
   * entry so the session's hooks find their own entry when several sessions share a cwd.
   */
  surface?: string;
}

/** MQTT username/password for brokers that require authentication (SPEC §11.5). */
export interface BrokerAuth {
  username: string;
  password?: string;
}

/**
 * Grammar for `VOLLEY_AGENT_ID` when used as an agent_id PREFIX (Plan 6).
 * SPEC §2.2 grammar applies to the final agent_id; constrain the prefix to
 * leave room for the 5-char "-XXXX" suffix inside 63 chars total.
 */
const PREFIX_GRAMMAR = /^[a-z0-9][a-z0-9_-]{0,57}$/;

/**
 * Derive an agent id from a working directory: lowercased basename, non-conforming runs
 * collapsed to "-", leading/trailing "-_" trimmed, capped to leave room for the suffix,
 * plus a 4-char random suffix. Falls back to "agent" when the basename sanitizes to empty.
 */
export function generateAgentId(cwd: string): string {
  const sanitized = basename(cwd)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+/, "")
    .replace(/[-_]+$/, "");
  const slug = sanitized.length > 0 ? sanitized.slice(0, 57) : "agent";
  return `${slug}-${randomSuffix(4)}`;
}

/** Supervisor-assigned identity read from `<cwd>/.volley/agent.json` (SPEC §6.5). */
interface AssignedIdentity {
  agentId: string;
  namespace?: string;
  parentId?: string | null;
  brokerUrl?: string;
  auth?: BrokerAuth;
  claudeAccount?: string;
}

/**
 * Read `<cwd>/.volley/agent.json` if present. The file carries a literal agent_id (no suffix)
 * and optional namespace / parent_id / broker_url. Returns null when the file does not exist;
 * throws, naming the path, when it exists but is malformed or out of grammar.
 */
function readAssignedIdentity(cwd: string): AssignedIdentity | null {
  const path = join(cwd, ".volley", "agent.json");
  if (!existsSync(path)) return null;

  // Never the parser's message: it quotes the file, and the file may hold a broker password.
  const text = readSecretText(path);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CredentialsFileError(`${path}: malformed identity file (not valid JSON)`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CredentialsFileError(`${path}: identity file must be a JSON object`);
  }
  const file = raw as Record<string, unknown>;

  const agentId = file.agent_id;
  if (typeof agentId !== "string") {
    throw new CredentialsFileError(`${path}: identity file must set agent_id to a string`);
  }
  if (!isValidAgentId(agentId)) {
    throw new VolleyError(
      "INVALID_AGENT_ID",
      `INVALID_AGENT_ID: ${path}: agent_id "${agentId}" does not match [a-z0-9][a-z0-9_-]{0,62} (SPEC §2.2)`,
    );
  }
  const identity: AssignedIdentity = { agentId };

  if (file.namespace !== undefined) {
    if (typeof file.namespace !== "string" || !isValidNamespace(file.namespace)) {
      throw new CredentialsFileError(
        `${path}: namespace ${JSON.stringify(file.namespace)} does not match [a-z0-9][a-z0-9_-]{0,62}`,
      );
    }
    identity.namespace = file.namespace;
  }
  if (file.parent_id !== undefined) {
    if (
      file.parent_id !== null &&
      (typeof file.parent_id !== "string" || !isValidAgentId(file.parent_id))
    ) {
      throw new CredentialsFileError(
        `${path}: parent_id ${JSON.stringify(file.parent_id)} does not match the agent id grammar`,
      );
    }
    identity.parentId = file.parent_id;
  }
  if (file.broker_url !== undefined) {
    if (typeof file.broker_url !== "string" || file.broker_url.length === 0) {
      throw new CredentialsFileError(`${path}: broker_url must be a non-empty string`);
    }
    identity.brokerUrl = file.broker_url;
  }
  if (file.claude_account !== undefined) {
    if (typeof file.claude_account !== "string" || !isValidAgentId(file.claude_account)) {
      throw new CredentialsFileError(
        `${path}: claude_account ${JSON.stringify(file.claude_account)} does not match [a-z0-9][a-z0-9_-]{0,62}`,
      );
    }
    identity.claudeAccount = file.claude_account;
  }
  if (file.broker !== undefined) {
    const broker = credentialsOf(file.broker);
    if (broker === null) {
      throw new CredentialsFileError(
        `${path}: broker must be an object with a non-empty string username and a string password`,
      );
    }
    identity.auth = broker;
  }
  return identity;
}

/**
 * Where Homebrew, distro packages and the snap keep mosquitto.conf. `volley auth` keeps its files
 * in `volley/` under the first that exists when neither `--dir` nor `VOLLEY_AUTH_DIR` is given;
 * the coordinator's hooks look for `coordinator.json` in the same place. The snap's comes last,
 * so a machine that already has an auth directory keeps it.
 */
export const MOSQUITTO_ETC_DIRS: readonly string[] = [
  "/opt/homebrew/etc/mosquitto",
  "/usr/local/etc/mosquitto",
  "/etc/mosquitto",
  "/var/snap/mosquitto/common",
];

/**
 * `$VOLLEY_AUTH_DIR/coordinator.json` (written by `volley auth init --coordinator-file`); without
 * VOLLEY_AUTH_DIR, the CLI's default `<mosquitto etc dir>/volley/coordinator.json`.
 */
export function coordinatorAuthPath(env: Record<string, string | undefined>): string | null {
  if (env.VOLLEY_AUTH_DIR !== undefined) return join(env.VOLLEY_AUTH_DIR, "coordinator.json");
  const etc = MOSQUITTO_ETC_DIRS.find((d) => existsSync(d));
  return etc === undefined ? null : join(etc, "volley", "coordinator.json");
}

/**
 * The coordinator's credentials from `coordinatorAuthPath(env)`, or null when there is no such
 * file. An unreadable or malformed file throws (never a silent anonymous connect), naming the
 * path and never a byte of the file.
 */
export function readCoordinatorAuth(env: Record<string, string | undefined>): BrokerAuth | null {
  const path = coordinatorAuthPath(env);
  if (path === null || !existsSync(path)) return null;
  return parseCredentialsFile(path, readSecretText(path));
}

/** `{username, password}` when `v` is an object with a non-empty string username and a string password. */
function credentialsOf(v: unknown): { username: string; password: string } | null {
  const c = v as { username?: unknown; password?: unknown } | null;
  if (
    typeof c !== "object" ||
    c === null ||
    Array.isArray(c) ||
    typeof c.username !== "string" ||
    c.username === "" ||
    typeof c.password !== "string"
  ) {
    return null;
  }
  return { username: c.username, password: c.password };
}

/**
 * A credentials file's `{username, password}` (coordinator.json, broker.json, admin.json, …). A
 * damaged one throws a fixed sentence naming `path`: never the JSON parser's message, which quotes
 * the text it failed on, and so a fragment of the password.
 */
export function parseCredentialsFile(
  path: string,
  text: string,
): { username: string; password: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  const c = credentialsOf(raw);
  if (c === null) {
    throw new CredentialsFileError(
      `${path}: not a JSON object with a string username and password`,
    );
  }
  return c;
}

/**
 * A credentials file that cannot be used (damaged, unreadable): its message names the path and
 * never a byte of the file. A CLI reports it as an error (exit 1), not a usage mistake.
 */
export class CredentialsFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialsFileError";
  }
}

/** A file that may hold a secret, as text; unreadable: `cannot read` and the errno code only. */
export function readSecretText(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "unknown error";
    throw new CredentialsFileError(`${path}: cannot read (${code})`);
  }
}

/**
 * Credentials from `VOLLEY_AUTH_USERNAME` / `VOLLEY_AUTH_PASSWORD`. A username alone is
 * allowed (some brokers check only the username); a password alone is a configuration error.
 */
export function authFromEnv(env: Record<string, string | undefined>): BrokerAuth | null {
  const username = env.VOLLEY_AUTH_USERNAME;
  const password = env.VOLLEY_AUTH_PASSWORD;
  if (username === undefined || username === "") {
    if (password !== undefined && password !== "") {
      throw new Error("VOLLEY_AUTH_PASSWORD is set but VOLLEY_AUTH_USERNAME is not");
    }
    return null;
  }
  return password !== undefined ? { username, password } : { username };
}

/**
 * Broker credentials for a client running in `cwd`: the identity file's `broker` block wins,
 * then `VOLLEY_AUTH_*`, else null (anonymous). Shared by every client that connects with the
 * agent's identity (MCP server, CLI, hooks), so they all resolve credentials the same way.
 */
export function resolveBrokerAuth(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): BrokerAuth | null {
  return readAssignedIdentity(cwd)?.auth ?? authFromEnv(env);
}

/**
 * Read configuration from `<cwd>/.volley/agent.json` (if present), then the environment, then
 * defaults. A key set in the identity file beats its env var. `env`/`cwd` are injectable for tests;
 * `warn` receives one line per ignored setting (default: stderr).
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
  warn: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): VolleyConfig {
  const identity = readAssignedIdentity(cwd);

  const brokerUrl = identity?.brokerUrl ?? env.VOLLEY_BROKER_URL ?? "mqtt://localhost:1883";

  const namespace = identity?.namespace ?? env.VOLLEY_NAMESPACE ?? "default";
  if (!isValidNamespace(namespace)) {
    throw new Error(`VOLLEY_NAMESPACE "${namespace}" does not match [a-z0-9][a-z0-9_-]{0,62}`);
  }

  let agentId: string;
  if (identity !== null) {
    agentId = identity.agentId;
  } else if (env.VOLLEY_AGENT_ID !== undefined) {
    const prefix = env.VOLLEY_AGENT_ID;
    if (!PREFIX_GRAMMAR.test(prefix)) {
      throw new Error(
        `VOLLEY_AGENT_ID "${prefix}" does not match the prefix grammar [a-z0-9][a-z0-9_-]{0,57} (SPEC §2.2 — agent_id grammar with room for auto-suffix). Use a bare lowercase role like "coordinator".`,
      );
    }
    agentId = `${prefix}-${randomSuffix(4)}`;
  } else {
    agentId = generateAgentId(cwd);
  }

  const parentId =
    identity?.parentId !== undefined ? identity.parentId : (env.VOLLEY_PARENT_ID ?? null);
  if (parentId !== null && !isValidAgentId(parentId)) {
    throw new Error(`VOLLEY_PARENT_ID "${parentId}" does not match the agent id grammar`);
  }

  // A coordinator's MCP registration names the auth dir, never a password (`volley setup`): the
  // login is its coordinator.json. A supervised agent uses only the login minted for it.
  const auth = identity?.auth ?? authFromEnv(env) ?? (identity === null ? authDirLogin(env) : null);

  if (env.VOLLEY_HEARTBEAT_S !== undefined) {
    warn(
      "VOLLEY_HEARTBEAT_S is retired (#483): presence is the connection's will; no heartbeats are sent",
    );
  }

  const surface = oneLine(env.CMUX_SURFACE_ID);

  return {
    brokerUrl,
    namespace,
    agentId,
    parentId,
    ...(auth !== null ? { auth } : {}),
    ...(identity?.claudeAccount !== undefined ? { claudeAccount: identity.claudeAccount } : {}),
    // A supervised agent (identity file) is never a coordinator, whatever its shell exported.
    ...(identity === null && env.VOLLEY_COORDINATOR ? { coordinator: env.VOLLEY_COORDINATOR } : {}),
    ...(surface !== undefined ? { surface } : {}),
  };
}

/**
 * The login in `$VOLLEY_AUTH_DIR/coordinator.json` when VOLLEY_AUTH_DIR is set; null when it is
 * not. Set but without the file: an error naming the file (never a silent anonymous connect).
 */
export function authDirLogin(env: Record<string, string | undefined>): BrokerAuth | null {
  if (env.VOLLEY_AUTH_DIR === undefined || env.VOLLEY_AUTH_DIR === "") return null;
  const login = readCoordinatorAuth(env);
  if (login === null) {
    throw new Error(
      `${coordinatorAuthPath(env)} does not exist: VOLLEY_AUTH_DIR names it as this server's broker login (run \`volley setup\`, or \`volley setup --check\` to see what is missing)`,
    );
  }
  return login;
}

/** A non-blank single-line value, at most 128 characters; anything else is none. */
function oneLine(v: string | undefined): string | undefined {
  return v !== undefined && /^[^\s][^\r\n]{0,127}$/.test(v) ? v : undefined;
}

/** The coordinator name when it is in the agent-id grammar; else an INVALID_AGENT_ID error. */
export function checkCoordinator(name: string): string {
  if (!isValidAgentId(name)) {
    throw new VolleyError(
      "INVALID_AGENT_ID",
      `VOLLEY_COORDINATOR "${name}" does not match [a-z0-9][a-z0-9_-]{0,62} (SPEC §2.2): set it to a stable lowercase name like "coord-main"`,
    );
  }
  return name;
}
