import { VolleyBroker } from "./broker";
import type { VolleyConfig } from "./config";
import { buildEnvelope } from "./envelope";
import type { ServerState } from "./state";
import { volRegister } from "./tools/register";
import { buildTopic } from "./topics";

/**
 * Start the Volley server lifecycle (SPEC §5 states, §7 LWT):
 *  1. connect to the broker with the LWT pre-armed (retained status: reaped),
 *  2. publish the initial retained status: spawning,
 *  3. auto-register with default capabilities=[] and cwd=process.cwd() so the
 *     server is SPEC §6.3-compliant by default — agents/skills can re-call
 *     vol_register later to update capabilities/model/cwd (idempotent).
 * Throws VolleyError(BROKER_DOWN) if the broker is unreachable, or
 * VolleyError(AUTH_FAILED) if it refuses `config.auth` (or anonymous access).
 */
export async function startLifecycle(config: VolleyConfig): Promise<ServerState> {
  const statusTopic = buildTopic(config.namespace, config.agentId, "status");

  const willEnvelope = buildEnvelope({
    agentId: config.agentId,
    parentId: config.parentId,
    channel: "status",
    type: "reaped",
    payload: { reason: "disconnect" },
  });

  const broker = new VolleyBroker();
  await broker.connect({
    url: config.brokerUrl,
    agentId: config.agentId,
    willTopic: statusTopic,
    willPayload: JSON.stringify(willEnvelope),
    ...(config.auth !== undefined ? config.auth : {}),
  });

  const spawning = buildEnvelope({
    agentId: config.agentId,
    parentId: config.parentId,
    channel: "status",
    type: "spawning",
    payload: {},
  });
  try {
    await broker.publish(statusTopic, JSON.stringify(spawning), { qos: 1, retain: true });
  } catch (e) {
    await broker.disconnect();
    throw e;
  }

  const state: ServerState = { config, broker, registered: false };

  try {
    await volRegister(state, { capabilities: [], cwd: process.cwd() });
  } catch (e) {
    await broker.disconnect();
    throw e;
  }

  return state;
}

/**
 * Shut down the lifecycle: publish a retained terminal status (default `done`), then
 * disconnect cleanly — the DISCONNECT packet suppresses the LWT. No-op if already
 * disconnected.
 */
export async function shutdownLifecycle(
  state: ServerState,
  terminalType: "done" | "blocked" | "failed" = "done",
): Promise<void> {
  if (!state.broker.connected) return;
  const statusTopic = buildTopic(state.config.namespace, state.config.agentId, "status");
  const terminal = buildEnvelope({
    agentId: state.config.agentId,
    parentId: state.config.parentId,
    channel: "status",
    type: terminalType,
    payload: { reason: "shutdown" },
  });
  try {
    await state.broker.publish(statusTopic, JSON.stringify(terminal), { qos: 1, retain: true });
  } finally {
    await state.broker.disconnect();
  }
}
