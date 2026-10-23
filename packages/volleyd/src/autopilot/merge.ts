import type { ExecFn } from "../exec";
import type { MergeToken, TrainToken } from "../fence";

/**
 * Autopilot merging (SPEC §4.6.17, the merge train §4.6.23): the ONE module that may build
 * `gh pr merge` (test/no-merge.test.ts exempts exactly this file). Each argv is the only shape the
 * fence allows with its token: a squash with the gate's MergeToken, a merge commit with a train's
 * TrainToken, for exactly that PR and head: GitHub refuses the merge when the head moved since the
 * gate (`--match-head-commit`). Never --admin or --auto: a refused merge is reported, not forced.
 */

/**
 * Why a merge was refused. Only `behind` (out of date with, or conflicting with, the release
 * branch) and `head_moved` (the PR is no longer at the gated head) say the branch must change
 * before it can merge; `retargeted` and `closed` say it can never merge into it; `draft` says the
 * PR is a draft, which the pipeline marks ready and waits for the CI that starts (#408). Those
 * five give up the merge turn (refusalEndsTurn); `checks` (required checks, branch protection) and
 * `unknown` say nothing about the release branch and keep it. `transient` (GitHub busy, a 5xx, a
 * rate limit, a dropped connection) keeps it too, and is retried on a backoff ladder without
 * counting as a refusal (#445).
 */
export type RefusalReason =
  | "transient"
  | "behind"
  | "head_moved"
  | "retargeted"
  | "closed"
  | "draft"
  | "checks"
  | "unknown";

export type MergeOutcome =
  | { ok: true; merge_sha: string | null }
  | { ok: false; reason: RefusalReason; stderr: string };

export function mergeArgv(token: MergeToken, deleteBranch: boolean): string[] {
  return [
    "gh",
    "pr",
    "merge",
    String(token.pr),
    "--squash",
    "--match-head-commit",
    token.head,
    ...(deleteBranch ? ["--delete-branch"] : []),
  ];
}

/** A merge train's PR, with a merge commit: the member PRs, whose heads it contains, read as merged. */
export function trainMergeArgv(token: TrainToken): string[] {
  return ["gh", "pr", "merge", String(token.pr), "--merge", "--match-head-commit", token.head];
}

/**
 * Merge the token's PR at its head, then read the merge commit back (`gh pr view`). Right before
 * merging, the PR is re-read: `gh pr merge` merges into whatever the PR targets now, so a PR
 * retargeted away from the token's release branch (or whose head moved, that is a draft, or that
 * cannot be read) is refused without merging. A merge whose commit cannot be read back is still a merge
 * (`merge_sha: null`); `gh` exiting non-zero (head moved, checks required, branch protection) is
 * `{ ok: false, reason, stderr }` (refusalReason).
 */
export async function mergePr(
  exec: ExecFn,
  token: MergeToken,
  cwd?: string,
  deleteBranch = false,
): Promise<MergeOutcome> {
  return merged(exec, token, mergeArgv(token, deleteBranch), { merge: token }, cwd);
}

/**
 * Merge the train's PR at its head with a merge commit (trainMergeArgv), with the same re-read
 * before and the same outcome as mergePr: a train PR retargeted away from the release branch,
 * whose head moved, that is closed or a draft is refused without merging.
 */
export async function mergeTrain(
  exec: ExecFn,
  token: TrainToken,
  cwd?: string,
): Promise<MergeOutcome> {
  return merged(exec, token, trainMergeArgv(token), { train: token }, cwd);
}

/** The PR one token may merge: its number, its gated head, its release branch. */
type Target = Pick<MergeToken, "pr" | "head" | "release_branch">;

async function merged(
  exec: ExecFn,
  token: Target,
  argv: string[],
  fenced: { merge: MergeToken } | { train: TrainToken },
  cwd: string | undefined,
): Promise<MergeOutcome> {
  const where = cwd !== undefined ? { cwd } : {};
  const pre = await exec(
    ["gh", "pr", "view", String(token.pr), "--json", "baseRefName,headRefOid,isDraft,state"],
    where,
  );
  const why =
    pre.code === 0
      ? notMergeable(pre.stdout, token)
      : { reason: "unknown" as const, text: (pre.stderr || pre.stdout).trim() };
  if (why !== null)
    return {
      ok: false,
      reason: why.reason,
      stderr: `not merged: ${why.text || "gh pr view failed"}`,
    };
  const r = await exec(argv, { ...fenced, ...where });
  if (r.code !== 0) {
    const stderr = (r.stderr || r.stdout).trim();
    return { ok: false, reason: refusalReason(stderr), stderr };
  }
  const view = await exec(
    ["gh", "pr", "view", String(token.pr), "--json", "mergeCommit,state"],
    where,
  );
  return { ok: true, merge_sha: view.code === 0 ? mergeSha(view.stdout) : null };
}

/** Why the PR as GitHub has it now is not the one the token was minted for; null when it is. */
function notMergeable(text: string, token: Target): { reason: RefusalReason; text: string } | null {
  let v: { baseRefName?: unknown; headRefOid?: unknown; isDraft?: unknown; state?: unknown };
  try {
    v = (JSON.parse(text) ?? {}) as typeof v;
  } catch {
    return { reason: "unknown", text: "gh pr view returned no JSON" };
  }
  if (v.baseRefName !== token.release_branch)
    return {
      reason: "retargeted",
      text: `PR #${token.pr} targets ${String(v.baseRefName)}, not ${token.release_branch}`,
    };
  if (v.headRefOid !== token.head)
    return {
      reason: "head_moved",
      text: `PR #${token.pr} head is ${String(v.headRefOid)}, not the gated ${token.head}`,
    };
  if (v.state !== "OPEN")
    return { reason: "closed", text: `PR #${token.pr} is ${String(v.state)}` };
  if (v.isDraft === true) return { reason: "draft", text: `PR #${token.pr} is still a draft` };
  return null;
}

// Keyed by every RefusalReason, so the compiler rejects a reason left out.
const REFUSAL_REASONS: Record<RefusalReason, true> = {
  transient: true,
  behind: true,
  head_moved: true,
  retargeted: true,
  closed: true,
  draft: true,
  checks: true,
  unknown: true,
};

/** A journaled `reason` volleyd knows. Pure. */
export function isRefusalReason(v: unknown): v is RefusalReason {
  return typeof v === "string" && Object.hasOwn(REFUSAL_REASONS, v);
}

/** GitHub's transient refusals, 5xx answers, rate limits and transport errors. */
const TRANSIENT = new RegExp(
  [
    "merge already in progress",
    "base branch was modified",
    "\\bHTTP 5\\d\\d\\b",
    "something went wrong",
    "unexpected end of JSON",
    "secondary rate limit",
    "abuse detection",
    "API rate limit exceeded",
    "dial tcp",
    "i/o timeout",
    "connection reset",
    "TLS handshake timeout",
    "unexpected EOF",
  ].join("|"),
  "i",
);

/** What `gh pr merge`'s refusal says, from its stderr. Pure. */
export function refusalReason(stderr: string): RefusalReason {
  if (/head branch was modified|match-head-commit/i.test(stderr)) return "head_moved";
  // "Pull Request is still a draft (mergePullRequest)".
  if (/\bstill a draft\b/i.test(stderr)) return "draft";
  // Quoted text (a check's name, e.g. "merge-conflict-scan") never reads as transient or
  // behind. Only double quotes (GitHub's) are blanked, since apostrophes appear in prose; a
  // name in single quotes or none can still read as behind, which fails safe: the task gives
  // up its turn, and updates its branch only if checkRebase counts commits.
  const prose = stderr.replace(/"[^"]*"/g, '""');
  // GitHub busy or unreachable: a retry after a wait merges (#445). "Base branch was modified"
  // is GitHub's mergeability race: the retry merges, or reads a real `behind`.
  if (TRANSIENT.test(prose)) return "transient";
  if (/out of date|not up to date|\bbehind\b|\bconflicts?\b|cannot be cleanly created/i.test(prose))
    return "behind";
  if (/already merged|is (closed|merged)\b/i.test(stderr)) return "closed";
  if (/check|protect|review|approv/i.test(stderr)) return "checks";
  return "unknown";
}

function mergeSha(text: string): string | null {
  try {
    const v = JSON.parse(text) as { mergeCommit?: { oid?: unknown } | null };
    const oid = v?.mergeCommit?.oid;
    return typeof oid === "string" && oid !== "" ? oid : null;
  } catch {
    return null;
  }
}
