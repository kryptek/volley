import { randomUUID } from "node:crypto";
import { channelConfigFor } from "../channels";
import { buildEnvelope } from "../envelope";
import { VolleyError } from "../errors";
import type { ServerState } from "../state";
import { buildTopic, isReservedTopic } from "../topics";

export interface PublishInput {
  channel: string;
  type: string;
  payload?: unknown;
  correlation_id?: string | null;
}

export interface PublishResult {
  message_id: string;
  topic: string;
  retained: boolean;
}

/** vol_publish — publish a message to one of this agent's channels. Requires prior vol_register. */
export async function volPublish(state: ServerState, input: PublishInput): Promise<PublishResult> {
  if (!state.registered) {
    throw new VolleyError("NOT_REGISTERED", "call vol_register before publishing");
  }
  const cfg = channelConfigFor(input.channel);
  if (cfg === null) {
    throw new VolleyError(
      "INVALID_TOPIC",
      `channel "${input.channel}" is not a reserved channel or a valid _user/* channel`,
    );
  }
  const topic = buildTopic(state.config.namespace, state.config.agentId, input.channel);
  // Architecturally unreachable today (namespace/agentId grammar forbids _system/_meta
  // prefixes), but kept as a spec-mandated safety net in case that constraint ever relaxes.
  if (isReservedTopic(topic)) {
    throw new VolleyError("RESERVED_TOPIC_WRITE", `refusing to publish to reserved topic ${topic}`);
  }
  const envelope = buildEnvelope({
    agentId: state.config.agentId,
    parentId: state.config.parentId,
    channel: input.channel,
    type: input.type,
    payload: input.payload,
    correlationId: input.correlation_id ?? null,
  });
  await state.broker.publish(topic, JSON.stringify(envelope), { qos: cfg.qos, retain: cfg.retain });
  return { message_id: randomUUID(), topic, retained: cfg.retain };
}
