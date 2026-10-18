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
}

/**
 * Read `<cwd>/.volley/agent.json` if present. The file carries a literal agent_id (no suffix)
 * and optional namespace / parent_id / broker_url. Returns null when the file does not exist;
 * throws, naming the path, when it exists but is malformed or out of grammar.
 */
function readAssignedIdentity(cwd: string): AssignedIdentity | null {
  const path = join(cwd, ".volley", "agent.json");
  if (!existsSync(path)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    throw new Error(`${path}: malformed identity file — ${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${path}: identity file must be a JSON object`);
  }
  const file = raw as Record<string, unknown>;

  const agentId = file.agent_id;
  if (typeof agentId !== "string") {
    throw new Error(`${path}: identity file must set agent_id to a string`);
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
      throw new Error(
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
      throw new Error(
        `${path}: parent_id ${JSON.stringify(file.parent_id)} does not match the agent id grammar`,
      );
    }
    identity.parentId = file.parent_id;
  }
  if (file.broker_url !== undefined) {
    if (typeof file.broker_url !== "string" || file.broker_url.length === 0) {
      throw new Error(`${path}: broker_url must be a non-empty string`);
    }
    identity.brokerUrl = file.broker_url;
  }
  if (file.broker !== undefined) {
    const broker = file.broker as Record<string, unknown> | null;
    if (
      typeof broker !== "object" ||
      broker === null ||
      Array.isArray(broker) ||
      typeof broker.username !== "string" ||
      broker.username.length === 0 ||
      typeof broker.password !== "string"
    ) {
      throw new Error(
        `${path}: broker must be an object with a non-empty string username and a string password`,
      );
    }
    identity.auth = { username: broker.username, password: broker.password };
  }
  return identity;
}

/**
 * Where Homebrew / distro packages keep mosquitto.conf. `volley auth` keeps its files in
 * `volley/` under the first that exists when neither `--dir` nor `VOLLEY_AUTH_DIR` is given;
 * the coordinator's hooks look for `coordinator.json` in the same place.
 */
export const MOSQUITTO_ETC_DIRS: readonly string[] = [
  "/opt/homebrew/etc/mosquitto",
  "/usr/local/etc/mosquitto",
  "/etc/mosquitto",
];

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
 * defaults. A key set in the identity file beats its env var. `env`/`cwd` are injectable for tests.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
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

  const auth = identity?.auth ?? authFromEnv(env);

  return { brokerUrl, namespace, agentId, parentId, ...(auth !== null ? { auth } : {}) };
}
