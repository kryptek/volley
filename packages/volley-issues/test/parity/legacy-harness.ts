import { VolleyBroker } from "volley-mcp/broker";
import { parseEnvelope } from "volley-mcp/envelope";
import { buildTopic } from "volley-mcp/topics";

const TERMINAL_TYPES = new Set(["done", "blocked", "failed", "reaped"]);

export interface LegacyDetection {
  /** When the legacy poller detected the agent's terminal status (Date.now()). */
  detectedAt: number;
}

/**
 * Simulates the legacy claude-peers + ScheduleWakeup polling loop:
 * polls the agent's retained status topic every `pollIntervalMs` milliseconds
 * (default 270000 = 270s, matching the design doc's stated cadence). Returns
 * when a terminal status is observed.
 *
 * NOTE: This is a SIMULATION — the real legacy loop is in the dispatch-issues
 * skill, which uses ScheduleWakeup wakes + list_peers calls. The polling
 * interval is what determines the latency, so simulating just the poll is a
 * faithful approximation for measurement.
 */
export async function runLegacyHarness(
  brokerUrl: string,
  namespace: string,
  agentId: string,
  pollIntervalMs = 270000,
  overallTimeoutMs = 600000,
): Promise<LegacyDetection> {
  const broker = new VolleyBroker();
  await broker.connect({ url: brokerUrl, agentId: `legacy-coord-${agentId}` });
  const topic = buildTopic(namespace, agentId, "status");
  const deadline = Date.now() + overallTimeoutMs;
  try {
    while (Date.now() < deadline) {
      const raw = await broker.queryRetained(topic, 1000);
      if (raw !== null) {
        const env = parseEnvelope(raw);
        if (env !== null && TERMINAL_TYPES.has(env.type)) {
          return { detectedAt: Date.now() };
        }
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
    throw new Error(`legacy harness timed out for ${agentId}`);
  } finally {
    await broker.disconnect();
  }
}
