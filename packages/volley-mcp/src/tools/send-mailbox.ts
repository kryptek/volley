import { randomUUID } from "node:crypto";
import { buildEnvelope, parseEnvelope } from "../envelope";
import { VolleyError } from "../errors";
import type { ServerState } from "../state";
import { buildTopic, isValidAgentId } from "../topics";

export interface SendMailboxInput {
  to_agent_id: string;
  type: "steering" | "cancel" | "nudge" | "query" | "ack";
  payload: {
    text: string;
    /** Monotonic per sender, so a recipient can order and de-duplicate (SPEC §4.4). */
    seq?: number;
    /** Message id (correlation_id) of an earlier message this one replaces. */
    supersedes?: string;
    [k: string]: unknown;
  };
  /** Becomes the message id. Generated when omitted; required for `ack` (the id being acked). */
  correlation_id?: string | null;
  /** Wait this long after publishing for the recipient's `ack` of this message id. */
  wait_ack_ms?: number;
}

export interface SendMailboxResult {
  /** The envelope's `correlation_id` — the id a recipient references in its `ack`. */
  message_id: string;
  /** True when the broker acknowledged receipt (PUBACK). Does not mean the recipient
   *  has processed the message — QoS 1 delivers to the broker, not to the subscriber. */
  delivered: boolean;
  /** Present only when `wait_ack_ms` was given: whether an `ack` arrived within the wait. */
  acked?: boolean;
  /** The `agent_id` of the acking envelope, when `acked` is true. */
  acked_by?: string;
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
  // "" is no id at all (and not a UUID): treat it as missing.
  const suppliedId =
    input.correlation_id === undefined ||
    input.correlation_id === null ||
    input.correlation_id === ""
      ? null
      : input.correlation_id;
  if (input.type === "ack" && suppliedId === null) {
    throw new VolleyError(
      "IMPL_CORRELATION_ID_REQUIRED",
      "an ack must carry the correlation_id of the message it acknowledges",
    );
  }
  if (input.type === "ack" && input.wait_ack_ms !== undefined) {
    throw new VolleyError(
      "IMPL_INVALID_INPUT",
      "wait_ack_ms cannot be used on an ack: recipients never ack an ack (SPEC §4.4)",
    );
  }
  // The id goes into the envelope BEFORE publishing so the recipient can ack it.
  const messageId = suppliedId ?? randomUUID();
  const topic = buildTopic(state.config.namespace, input.to_agent_id, "mailbox");
  const envelope = buildEnvelope({
    agentId: state.config.agentId,
    parentId: state.config.parentId,
    channel: "mailbox",
    type: input.type,
    payload: input.payload,
    correlationId: messageId,
  });
  // Subscribe to our own mailbox before publishing, so an ack that races back cannot
  // land before the subscription exists (MQTT orders SUBSCRIBE ahead of PUBLISH). The
  // broker reference-counts the filter, so concurrent waits on it don't cut each other off.
  const cancelWait = new AbortController();
  const ackWait =
    input.wait_ack_ms === undefined
      ? null
      : state.broker.subscribeUntil(
          buildTopic(state.config.namespace, state.config.agentId, "mailbox"),
          (raw) => {
            const env = parseEnvelope(raw);
            // Only the recipient acks (SPEC §4.4); an ack from anyone else is not this one.
            return (
              env?.type === "ack" &&
              env.correlation_id === messageId &&
              env.agent_id === input.to_agent_id
            );
          },
          input.wait_ack_ms,
          cancelWait.signal,
        );
  // Handled up front: a failed SUBSCRIBE must not surface as an unhandled rejection
  // while the publish below is still awaiting its PUBACK.
  ackWait?.catch(() => {});
  try {
    // mailbox is QoS 1, not retained (SPEC.md §4.1). publishAsync resolves on PUBACK.
    await state.broker.publish(topic, JSON.stringify(envelope), { qos: 1, retain: false });
  } catch (e) {
    cancelWait.abort();
    throw e;
  }
  if (ackWait === null) return { message_id: messageId, delivered: true };
  const ack = await ackWait;
  const ackedBy = ack === null ? undefined : parseEnvelope(ack.payload)?.agent_id;
  return ackedBy === undefined
    ? { message_id: messageId, delivered: true, acked: false }
    : { message_id: messageId, delivered: true, acked: true, acked_by: ackedBy };
}
