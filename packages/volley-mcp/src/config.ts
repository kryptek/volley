import { basename } from "node:path";
import { isValidAgentId, isValidNamespace } from "./topics";
import { randomSuffix } from "./util";

export interface VolleyConfig {
  brokerUrl: string;
  namespace: string;
  agentId: string;
  parentId: string | null;
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

/** Read configuration from environment, falling back to defaults. `env`/`cwd` are injectable for tests. */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): VolleyConfig {
  const brokerUrl = env.VOLLEY_BROKER_URL ?? "mqtt://localhost:1883";

  const namespace = env.VOLLEY_NAMESPACE ?? "default";
  if (!isValidNamespace(namespace)) {
    throw new Error(`VOLLEY_NAMESPACE "${namespace}" does not match [a-z0-9][a-z0-9_-]{0,62}`);
  }

  let agentId: string;
  if (env.VOLLEY_AGENT_ID !== undefined) {
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

  const parentId = env.VOLLEY_PARENT_ID ?? null;
  if (parentId !== null && !isValidAgentId(parentId)) {
    throw new Error(`VOLLEY_PARENT_ID "${parentId}" does not match the agent id grammar`);
  }

  return { brokerUrl, namespace, agentId, parentId };
}
