import { parseEnvelope } from "../envelope";
import type { ServerState } from "../state";
import { buildTopic } from "../topics";

export interface ListAgentsInput {
  namespace?: string;
  include_reaped?: boolean;
}

export interface AgentSummary {
  agent_id: string;
  namespace: string;
  status: string | null;
  parent_id: string | null;
  cwd: string | null;
  model: string | null;
  /** What the agent registered it is working on (SPEC §6.2), else null. */
  title: string | null;
  capabilities: string[];
  last_seen: string;
}

export interface ListAgentsResult {
  agents: AgentSummary[];
}

const REGISTRY_COLLECT_MAX = 1000; // retained entries deliver at subscribe time; 1000 agents is beyond realistic scale
const REGISTRY_COLLECT_TIMEOUT_MS = 500; // retained delivery is immediate; 500ms is generous
const STATUS_QUERY_TIMEOUT_MS = 500; // same rationale: retained, immediate

/**
 * vol_list_agents — enumerate registered agents from the retained registry topics
 * (SPEC.md §6.4), cross-referencing each agent's current retained status. Reaped agents
 * are excluded unless `include_reaped` is true.
 */
export async function volListAgents(
  state: ServerState,
  input: ListAgentsInput,
): Promise<ListAgentsResult> {
  // Retained registry entries arrive immediately on subscribe; 500ms is ample.
  const registryMessages = await state.broker.subscribeCollect(
    "volley/_system/registry/+",
    REGISTRY_COLLECT_MAX,
    REGISTRY_COLLECT_TIMEOUT_MS,
  );

  const agents: AgentSummary[] = [];
  for (const message of registryMessages) {
    const env = parseEnvelope(message.payload);
    if (env === null) continue;
    const namespace = env.namespace ?? "default";
    if (input.namespace !== undefined && namespace !== input.namespace) continue;

    const payload = (env.payload ?? {}) as Record<string, unknown>;
    const statusRaw = await state.broker.queryRetained(
      buildTopic(namespace, env.agent_id, "status"),
      STATUS_QUERY_TIMEOUT_MS,
    );
    const statusEnv = statusRaw === null ? null : parseEnvelope(statusRaw);
    const status = statusEnv === null ? null : statusEnv.type;
    if (input.include_reaped !== true && status === "reaped") continue;

    agents.push({
      agent_id: env.agent_id,
      namespace,
      status,
      parent_id: env.parent_id,
      cwd: typeof payload.cwd === "string" ? payload.cwd : null,
      model: typeof payload.model === "string" ? payload.model : null,
      title: typeof payload.title === "string" ? payload.title : null,
      capabilities: Array.isArray(payload.capabilities)
        ? payload.capabilities.filter((c): c is string => typeof c === "string")
        : [],
      last_seen: env.wall_time,
    });
  }
  return { agents };
}
