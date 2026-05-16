import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { buildTopic, registryTopic } from "volley-mcp/topics";

export interface AgentScenario {
  /** Unique id for this synthetic agent (e.g. "parity-agent-01"). */
  agentId: string;
  /** Volley namespace ("parity"). */
  namespace: string;
  /** Milliseconds after start() to publish the terminal "done" status. */
  doneAtMs: number;
}

export interface AgentRun {
  /** When the agent published its terminal status (Date.now()). */
  terminalPublishedAt: number;
}

/**
 * A synthetic agent: connects to the broker, publishes registry + spawning + working,
 * then waits `scenario.doneAtMs` and publishes `done`. Returns once `done` is on the
 * wire. Records `terminalPublishedAt` for the test to subtract from the coordinator's
 * detection time.
 */
export async function runSyntheticAgent(
  brokerUrl: string,
  scenario: AgentScenario,
): Promise<AgentRun> {
  const broker = new VolleyBroker();
  await broker.connect({
    url: brokerUrl,
    agentId: scenario.agentId,
    willTopic: buildTopic(scenario.namespace, scenario.agentId, "status"),
    willPayload: JSON.stringify(
      buildEnvelope({
        agentId: scenario.agentId,
        parentId: null,
        channel: "status",
        type: "reaped",
        payload: { reason: "disconnect" },
      }),
    ),
  });

  // Registry entry (retained).
  const registry = {
    ...buildEnvelope({
      agentId: scenario.agentId,
      parentId: null,
      channel: "_system/registry",
      type: "registered",
      payload: { capabilities: ["parity-synth"] },
    }),
    namespace: scenario.namespace,
  };
  await broker.publish(registryTopic(scenario.agentId), JSON.stringify(registry), {
    qos: 1,
    retain: true,
  });

  // spawning → working (both retained).
  for (const type of ["spawning", "working"] as const) {
    const env = buildEnvelope({
      agentId: scenario.agentId,
      parentId: null,
      channel: "status",
      type,
      payload: {},
    });
    await broker.publish(
      buildTopic(scenario.namespace, scenario.agentId, "status"),
      JSON.stringify(env),
      { qos: 1, retain: true },
    );
  }

  await new Promise((r) => setTimeout(r, scenario.doneAtMs));

  // Terminal: done.
  const doneEnv = buildEnvelope({
    agentId: scenario.agentId,
    parentId: null,
    channel: "status",
    type: "done",
    payload: { summary: "synthetic done" },
  });
  const terminalPublishedAt = Date.now();
  await broker.publish(
    buildTopic(scenario.namespace, scenario.agentId, "status"),
    JSON.stringify(doneEnv),
    { qos: 1, retain: true },
  );

  await broker.disconnect();
  return { terminalPublishedAt };
}
