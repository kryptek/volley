import { toPathErrors, validator } from "../../src/schemas";

/** Assert `value` validates against `ref` (e.g. `wave-state.schema.json`); returns error strings. */
export function schemaErrors(ref: string, value: unknown): string[] {
  const v = validator(ref);
  if (v(value)) return [];
  return toPathErrors(v.errors).map((e) => `${e.path}: ${e.reason}`);
}

/** Wrap a payload in a v0.1 envelope from volleyd. */
export function envelope(channel: string, type: string, payload: unknown) {
  return {
    schema_version: "0.1",
    agent_id: "volleyd",
    parent_id: null,
    wall_time: "2026-10-18T12:00:00.000Z",
    channel,
    type,
    payload,
    correlation_id: null,
  };
}
