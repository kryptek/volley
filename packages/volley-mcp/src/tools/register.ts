import { buildEnvelope } from "../envelope";
import { VolleyError } from "../errors";
import type { ServerState } from "../state";
import { buildTopic, isValidAgentId, registryTopic } from "../topics";

export interface RegisterInput {
  capabilities: string[];
  parent_id?: string | null;
  model?: string;
  cwd?: string;
}

export interface RegisterResult {
  agent_id: string;
  namespace: string;
}

/**
 * vol_register — publish this agent's retained registry entry (SPEC.md §6) and a retained
 * status: registered, then flip state.registered. Idempotent: re-callable to republish
 * with updated capabilities/model/cwd.
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
        started_at: new Date().toISOString(),
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
  return { agent_id: config.agentId, namespace: config.namespace };
}
