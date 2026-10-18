import { parseEnvelope } from "../envelope";
import type { ServerState } from "../state";

export interface QueryInput {
  topic: string;
}

export interface QueryResult {
  topic: string;
  /** The retained Volley envelope, a raw string if the value is not an envelope, or null. */
  payload: unknown;
  /** The envelope's wall_time, or null if there is no retained envelope. */
  last_seen: string | null;
}

/** vol_query — fetch the current retained value at an exact topic. */
export async function volQuery(state: ServerState, input: QueryInput): Promise<QueryResult> {
  const raw = await state.broker.queryRetained(input.topic, 1000);
  if (raw === null) {
    return { topic: input.topic, payload: null, last_seen: null };
  }
  const envelope = parseEnvelope(raw);
  if (envelope === null) {
    return { topic: input.topic, payload: raw, last_seen: null };
  }
  return { topic: input.topic, payload: envelope, last_seen: envelope.wall_time };
}
