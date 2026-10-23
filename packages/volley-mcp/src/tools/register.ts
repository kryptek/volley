import { checkCoordinator } from "../config";
import { buildEnvelope } from "../envelope";
import { VolleyError } from "../errors";
import type { ServerState } from "../state";
import { buildTopic, isValidAgentId, registryTopic } from "../topics";

export interface RegisterInput {
  capabilities: string[];
  parent_id?: string | null;
  model?: string;
  cwd?: string;
  /** What the agent is working on, one line (SPEC §6.2); blank is no title. */
  title?: string;
  /** References for that purpose (SPEC §6.2): a number is an issue / PR in `repo`. */
  links?: RegisterLinks;
}

/** SPEC §6.2: a `title` is at most this many characters. */
export const TITLE_MAX = 120;

export interface RegisterLinks {
  repo?: string;
  issue?: number | string;
  pr?: number | string;
}

export interface RegisterResult {
  agent_id: string;
  namespace: string;
  /** The stable coordinator name (`VOLLEY_COORDINATOR`), when set. */
  coordinator?: string;
}

/**
 * vol_register — publish this agent's retained registry entry (SPEC.md §6) and a retained
 * status: registered, then flip state.registered. Idempotent: re-callable to republish
 * with updated capabilities/model/cwd/title/links.
 */
export async function volRegister(
  state: ServerState,
  input: RegisterInput,
): Promise<RegisterResult> {
  const { config, broker } = state;
  const parentId = input.parent_id !== undefined ? input.parent_id : config.parentId;
  if (parentId !== null && !isValidAgentId(parentId)) {
    throw new VolleyError(
      "INVALID_AGENT_ID",
      `parent_id "${parentId}" does not match the agent id grammar`,
    );
  }

  const coordinator =
    config.coordinator !== undefined ? checkCoordinator(config.coordinator) : undefined;

  // One line: a direct caller's line breaks become spaces (the MCP boundary refuses them).
  // SPEC §6.2's cap: a direct caller's longer title is cut (the MCP boundary refuses it).
  const title = input.title
    ?.replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, TITLE_MAX);
  const links =
    input.links !== undefined && Object.keys(input.links).length > 0 ? input.links : undefined;
  const registryEnvelope = {
    ...buildEnvelope({
      agentId: config.agentId,
      parentId,
      channel: "_system/registry",
      type: "registered",
      payload: {
        capabilities: input.capabilities,
        cwd: input.cwd,
        model: input.model,
        ...(title ? { title } : {}),
        ...(links !== undefined ? { links } : {}),
        started_at: new Date().toISOString(),
        ...(config.claudeAccount !== undefined ? { claude_account: config.claudeAccount } : {}),
        ...(coordinator !== undefined ? { coordinator } : {}),
        // Which session this entry is: hooks sharing the cwd match on these (SPEC §6.2).
        pid: process.pid,
        ...(config.surface !== undefined ? { surface: config.surface } : {}),
      },
    }),
    namespace: config.namespace,
  };
  await broker.publish(registryTopic(config.agentId), JSON.stringify(registryEnvelope), {
    qos: 1,
    retain: true,
  });

  const statusEnvelope = buildEnvelope({
    agentId: config.agentId,
    parentId,
    channel: "status",
    type: "registered",
    payload: {},
  });
  await broker.publish(
    buildTopic(config.namespace, config.agentId, "status"),
    JSON.stringify(statusEnvelope),
    { qos: 1, retain: true },
  );

  state.registered = true;
  return {
    agent_id: config.agentId,
    namespace: config.namespace,
    ...(coordinator !== undefined ? { coordinator } : {}),
  };
}
