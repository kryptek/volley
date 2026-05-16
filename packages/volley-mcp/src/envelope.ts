/** The Volley protocol version this implementation emits (SPEC.md §3.1, §8). */
export const SCHEMA_VERSION = "0.1";

export interface Envelope {
  schema_version: string;
  agent_id: string;
  parent_id: string | null;
  wall_time: string;
  channel: string;
  type: string;
  payload: unknown;
  correlation_id: string | null;
  /** Registry envelopes only (SPEC §6.2); absent on all other channels. */
  namespace?: string;
}

export interface BuildEnvelopeInput {
  agentId: string;
  parentId: string | null;
  channel: string;
  type: string;
  payload?: unknown;
  correlationId?: string | null;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

/** Construct a v0.1 envelope. `wall_time` is ISO-8601 UTC with millisecond precision. */
export function buildEnvelope(input: BuildEnvelopeInput): Envelope {
  const now = input.now ?? (() => new Date());
  return {
    schema_version: SCHEMA_VERSION,
    agent_id: input.agentId,
    parent_id: input.parentId,
    wall_time: now().toISOString(),
    channel: input.channel,
    type: input.type,
    payload: input.payload ?? {},
    correlation_id: input.correlationId ?? null,
  };
}

/** True when `version` is a 0.x string this implementation supports (SPEC.md §8.2). */
export function isSupportedSchemaVersion(version: unknown): boolean {
  return typeof version === "string" && /^0\.[0-9]+$/.test(version);
}

/**
 * Parse a raw MQTT payload string into an Envelope. Returns null for malformed JSON or
 * when a required envelope field is missing/mistyped. Does NOT reject unsupported
 * schema_versions — that filtering is the caller's job.
 */
export function parseEnvelope(raw: string): Envelope | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const e = obj as Record<string, unknown>;
  if (
    typeof e.schema_version !== "string" ||
    typeof e.agent_id !== "string" ||
    typeof e.wall_time !== "string" ||
    typeof e.channel !== "string" ||
    typeof e.type !== "string"
  ) {
    return null;
  }
  const result: Envelope = {
    schema_version: e.schema_version,
    agent_id: e.agent_id,
    parent_id: typeof e.parent_id === "string" ? e.parent_id : null,
    wall_time: e.wall_time,
    channel: e.channel,
    type: e.type,
    payload: e.payload ?? {},
    correlation_id: typeof e.correlation_id === "string" ? e.correlation_id : null,
  };
  if (typeof e.namespace === "string") {
    result.namespace = e.namespace;
  }
  return result;
}
