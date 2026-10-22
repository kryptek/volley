import { VolleyBroker } from "./broker";
import { DEFAULT_HEARTBEAT_S, type VolleyConfig } from "./config";
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
 *     vol_register later to update capabilities/model/cwd (idempotent),
 *  4. publish a `progress` heartbeat every `config.heartbeatS` while registered (SPEC §4.3), so a
 *     session that is quiet on purpose (blocked on `volley wait`) still reads as alive.
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

  startHeartbeat(state);
  return state;
}

/**
 * Arm the heartbeat timer: a non-retained `progress { type: "heartbeat" }` on the agent's own
 * topic every `heartbeatS`. It stops itself once the connection is gone (no auto-reconnect: the
 * LWT has spoken), and never keeps the process alive.
 */
function startHeartbeat(state: ServerState): void {
  const seconds = state.config.heartbeatS ?? DEFAULT_HEARTBEAT_S;
  if (seconds <= 0) return;
  const topic = buildTopic(state.config.namespace, state.config.agentId, "progress");
  const timer = setInterval(() => {
    if (!state.broker.connected) {
      stopHeartbeat(state);
      return;
    }
    if (!state.registered) return;
    const beat = buildEnvelope({
      agentId: state.config.agentId,
      parentId: state.config.parentId,
      channel: "progress",
      type: "heartbeat",
      payload: { source: "volley-mcp" },
    });
    state.broker.publish(topic, JSON.stringify(beat), { qos: 0, retain: false }).catch(() => {
      // A lost beat is harmless: the next one (or the LWT) tells the truth.
    });
  }, seconds * 1000);
  timer.unref?.();
  state.heartbeat = timer;
}

function stopHeartbeat(state: ServerState): void {
  if (state.heartbeat === undefined) return;
  clearInterval(state.heartbeat);
  state.heartbeat = undefined;
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
  stopHeartbeat(state);
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
