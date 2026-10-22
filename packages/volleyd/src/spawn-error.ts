/** Codes a spawn step refuses with. Each refusal is journaled before it is thrown. */
export type SpawnErrorCode =
  | "SPAWN_LOCKED"
  | "SPAWN_BRIEF_REJECTED"
  | "BRIEF_PREFACE_TOO_LARGE"
  | "ISSUE_MISMATCH"
  | "ISSUE_FETCH_FAILED"
  | "CREDENTIALS_FAILED"
  | "WORKTREE_FAILED"
  | "RELEASE_BRANCH_MISSING"
  // The release branch could not be fetched and require_fresh_base is on (worktree.ts).
  | "BASE_STALE"
  // The release branch's fetch never reached origin (DNS, the network): transient, retried.
  | "BASE_UNREACHABLE"
  // `detail.outcome`: `refused` (nothing was created) or `unknown` (it may have been): Host.launch.
  | "LAUNCH_FAILED"
  | "REMOTE_REPO_MISSING"
  | "RETIRE_REFUSED"
  // Claude account profiles (src/claude/): unknown / not signed in / remote, or sharing failed.
  | "CLAUDE_ACCOUNT_UNAVAILABLE"
  | "CLAUDE_ACCOUNT_PREPARE_FAILED";

/**
 * A spawn (or retire) step refused. `detail` is journaled with the refusal. A `permanent` refusal
 * can never succeed as is (an agent id that cannot be formed): volleyd does not retry it.
 */
export class SpawnError extends Error {
  readonly code: SpawnErrorCode;
  readonly detail: Record<string, unknown>;
  readonly permanent: boolean;
  constructor(
    code: SpawnErrorCode,
    message: string,
    detail: Record<string, unknown> = {},
    opts: { permanent?: boolean } = {},
  ) {
    super(`${code}: ${message}`);
    this.name = "SpawnError";
    this.code = code;
    this.detail = detail;
    this.permanent = opts.permanent ?? false;
  }
}
