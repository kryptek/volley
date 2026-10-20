/** The spec error codes (SPEC.md §9). */
export type VolleyErrorCode =
  | "BROKER_DOWN"
  | "INVALID_TOPIC"
  | "INVALID_AGENT_ID"
  | "TIMEOUT"
  | "SCHEMA_VERSION_MISMATCH"
  | "NOT_REGISTERED"
  | "RESERVED_TOPIC_WRITE"
  | "AUTH_FAILED";

/** Codes a tool may return: the spec codes plus implementation-defined IMPL_* codes (SPEC.md §9). */
export type ToolErrorCode = VolleyErrorCode | `IMPL_${string}`;

export class VolleyError extends Error {
  readonly code: ToolErrorCode;
  constructor(code: ToolErrorCode, message: string) {
    super(message);
    this.name = "VolleyError";
    this.code = code;
  }
}

export interface ToolError {
  error: string;
  code: ToolErrorCode;
}

/** Normalize any thrown value into the { error, code } shape tools return on failure. */
export function toToolError(e: unknown): ToolError {
  if (e instanceof VolleyError) {
    return { error: e.message, code: e.code };
  }
  const message = e instanceof Error ? e.message : String(e);
  return { error: message, code: "IMPL_UNEXPECTED" };
}
