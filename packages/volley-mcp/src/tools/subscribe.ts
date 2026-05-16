import { type Envelope, parseEnvelope } from "../envelope";
import { VolleyError } from "../errors";
import type { ServerState } from "../state";
import { isValidTopicFilter } from "../topics";

export interface SubscribeInput {
  topic_pattern: string;
  max_messages?: number;
  timeout_ms?: number;
}

export interface CollectedMessage {
  topic: string;
  envelope: Envelope | null;
  raw: string;
}

export interface SubscribeResult {
  messages: CollectedMessage[];
}

/**
 * vol_subscribe — block until `max_messages` (default 1) arrive on `topic_pattern` or
 * `timeout_ms` (default 60000) elapses. Synchronous one-shot collection (design doc §5.2).
 */
export async function volSubscribe(
  state: ServerState,
  input: SubscribeInput,
): Promise<SubscribeResult> {
  if (!isValidTopicFilter(input.topic_pattern)) {
    throw new VolleyError(
      "INVALID_TOPIC",
      `invalid topic pattern: ${JSON.stringify(input.topic_pattern)}`,
    );
  }
  const collected = await state.broker.subscribeCollect(
    input.topic_pattern,
    input.max_messages ?? 1,
    input.timeout_ms ?? 60000,
  );
  return {
    messages: collected.map((m) => ({
      topic: m.topic,
      envelope: parseEnvelope(m.payload),
      raw: m.payload,
    })),
  };
}
