/** Codes a spawn step refuses with. Each refusal is journaled before it is thrown. */
export type SpawnErrorCode =
  | "SPAWN_LOCKED"
  | "SPAWN_BRIEF_REJECTED"
  | "ISSUE_MISMATCH"
  | "ISSUE_FETCH_FAILED"
  | "CREDENTIALS_FAILED"
  | "WORKTREE_FAILED"
  | "LAUNCH_FAILED"
  | "RETIRE_REFUSED";

/** A spawn (or retire) step refused. `detail` is journaled with the refusal. */
export class SpawnError extends Error {
  readonly code: SpawnErrorCode;
  readonly detail: Record<string, unknown>;
  constructor(code: SpawnErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(`${code}: ${message}`);
    this.name = "SpawnError";
    this.code = code;
    this.detail = detail;
  }
}
