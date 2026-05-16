import { randomUUID } from "node:crypto";
import { buildEnvelope } from "../envelope";
import { VolleyError } from "../errors";
import type { ServerState } from "../state";
import { buildTopic, isValidAgentId } from "../topics";

export interface SendMailboxInput {
  to_agent_id: string;
  type: "steering" | "cancel" | "nudge" | "query";
  payload: { text: string; [k: string]: unknown };
  correlation_id?: string | null;
}

export interface SendMailboxResult {
  message_id: string;
  /** True when the broker acknowledged receipt (PUBACK). Does not mean the recipient
   *  has processed the message — QoS 1 delivers to the broker, not to the subscriber. */
  delivered: boolean;
}

/**
 * vol_send_mailbox — deliver a mailbox message to another agent. The topic addresses the
 * RECIPIENT (`to_agent_id`); the envelope `agent_id` is the SENDER (this agent), per
 * SPEC.md §3.1. Requires prior vol_register.
 */
export async function volSendMailbox(
  state: ServerState,
  input: SendMailboxInput,
): Promise<SendMailboxResult> {
  if (!state.registered) {
    throw new VolleyError("NOT_REGISTERED", "call vol_register before sending mailbox messages");
  }
  if (!isValidAgentId(input.to_agent_id)) {
    throw new VolleyError(
      "INVALID_AGENT_ID",
      `to_agent_id "${input.to_agent_id}" does not match the agent id grammar`,
    );
  }
  const topic = buildTopic(state.config.namespace, input.to_agent_id, "mailbox");
  const envelope = buildEnvelope({
    agentId: state.config.agentId,
    parentId: state.config.parentId,
    channel: "mailbox",
    type: input.type,
    payload: input.payload,
    correlationId: input.correlation_id ?? null,
  });
  // mailbox is QoS 1, not retained (SPEC.md §4.1). publishAsync resolves on PUBACK.
  await state.broker.publish(topic, JSON.stringify(envelope), { qos: 1, retain: false });
  return { message_id: randomUUID(), delivered: true };
}
