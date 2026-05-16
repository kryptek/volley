/**
 * Parse + minimally validate an MQTT payload as a Volley envelope (SPEC §3).
 *
 * Required fields: `schema_version`, `agent_id`, `channel`, `type`. Unknown
 * extras are preserved (SPEC §3.3 forward-compat). Returns `null` for
 * malformed JSON or missing required fields; warns via `console.warn` so the
 * dev console surfaces drift without crashing the dashboard.
 */
export interface ParsedEnvelope {
  schema_version: string;
  agent_id: string;
  channel: string;
  type: string;
  wall_time?: string;
  parent_id?: string | null;
  payload?: unknown;
  correlation_id?: string | null;
  [key: string]: unknown;
}

const REQUIRED = ["schema_version", "agent_id", "channel", "type"] as const;

export function parseEnvelope(raw: string | Uint8Array): ParsedEnvelope | null {
  const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.warn("volley-dash: malformed envelope JSON", err);
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn("volley-dash: envelope is not a JSON object");
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  for (const field of REQUIRED) {
    if (typeof obj[field] !== "string") {
      console.warn(`volley-dash: envelope missing required field ${field}`);
      return null;
    }
  }
  return obj as ParsedEnvelope;
}
