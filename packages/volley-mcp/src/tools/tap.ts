import { type Envelope, parseEnvelope } from "../envelope";
import { VolleyError } from "../errors";
import type { ServerState } from "../state";
import { isValidTopicFilter } from "../topics";

export interface TapInput {
  topic_pattern: string;
  max_messages?: number;
  timeout_ms?: number;
}

export interface TapResult {
  messages: { topic: string; envelope: Envelope | null; raw: string }[];
}

/**
 * vol_tap — debugging wildcard subscription. Same collection mechanism as vol_subscribe
 * but with debug-tuned defaults: up to 100 messages, 5-second window (design doc §5.2).
 */
export async function volTap(state: ServerState, input: TapInput): Promise<TapResult> {
  if (!isValidTopicFilter(input.topic_pattern)) {
    throw new VolleyError(
      "INVALID_TOPIC",
      `invalid topic pattern: ${JSON.stringify(input.topic_pattern)}`,
    );
  }
  const collected = await state.broker.subscribeCollect(
    input.topic_pattern,
    input.max_messages ?? 100,
    input.timeout_ms ?? 5000,
  );
  return {
    messages: collected.map((m) => ({
      topic: m.topic,
      envelope: parseEnvelope(m.payload),
      raw: m.payload,
    })),
  };
}
