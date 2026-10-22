import type { ExecFn } from "../exec";
import type { MergeToken } from "../fence";

/**
 * Autopilot merging (SPEC §4.6.17): the ONE module that may build `gh pr merge`
 * (test/no-merge.test.ts exempts exactly this file). The argv is the only shape the fence allows,
 * and only with the gate's MergeToken for exactly that PR and head: GitHub refuses the merge when
 * the head moved since the gate (`--match-head-commit`). Never --admin or --auto: a refused merge
 * is reported, not forced.
 */

/**
 * Why a merge was refused. Only `behind` (out of date with, or conflicting with, the release
 * branch) and `head_moved` (the PR is no longer at the gated head) say the branch must change
 * before it can merge; `retargeted` and `closed` say it can never merge into it. Those four give up
 * the merge turn (refusalEndsTurn); `checks` (required checks, branch protection) and `unknown`
 * say nothing about the release branch and keep it.
 */
export type RefusalReason =
  | "behind"
  | "head_moved"
  | "retargeted"
  | "closed"
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

/**
 * Merge the token's PR at its head, then read the merge commit back (`gh pr view`). Right before
 * merging, the PR is re-read: `gh pr merge` merges into whatever the PR targets now, so a PR
 * retargeted away from the token's release branch (or whose head moved, or that cannot be read)
 * is refused without merging. A merge whose commit cannot be read back is still a merge
 * (`merge_sha: null`); `gh` exiting non-zero (head moved, checks required, branch protection) is
 * `{ ok: false, reason, stderr }` (refusalReason).
 */
export async function mergePr(
  exec: ExecFn,
  token: MergeToken,
  cwd?: string,
  deleteBranch = false,
): Promise<MergeOutcome> {
  const where = cwd !== undefined ? { cwd } : {};
  const pre = await exec(
    ["gh", "pr", "view", String(token.pr), "--json", "baseRefName,headRefOid,state"],
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
  const r = await exec(mergeArgv(token, deleteBranch), { merge: token, ...where });
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
function notMergeable(
  text: string,
  token: MergeToken,
): { reason: RefusalReason; text: string } | null {
  let v: { baseRefName?: unknown; headRefOid?: unknown; state?: unknown };
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
  return null;
}

// Keyed by every RefusalReason, so the compiler rejects a reason left out.
const REFUSAL_REASONS: Record<RefusalReason, true> = {
  behind: true,
  head_moved: true,
  retargeted: true,
  closed: true,
  checks: true,
  unknown: true,
};

/** A journaled `reason` volleyd knows. Pure. */
export function isRefusalReason(v: unknown): v is RefusalReason {
  return typeof v === "string" && Object.hasOwn(REFUSAL_REASONS, v);
}

/** What `gh pr merge`'s refusal says, from its stderr. Pure. */
export function refusalReason(stderr: string): RefusalReason {
  if (/head branch was modified|match-head-commit/i.test(stderr)) return "head_moved";
  // "Base branch was modified": the release branch moved during the merge. Quoted
  // text (a check's name, e.g. "merge-conflict-scan") never reads as behind. Only
  // double quotes (GitHub's) are blanked, since apostrophes appear in prose; a name
  // in single quotes or none can still read as behind, which fails safe: the task
  // gives up its turn, and updates its branch only if checkRebase counts commits.
  if (
    /base branch was modified|out of date|not up to date|\bbehind\b|\bconflicts?\b|cannot be cleanly created/i.test(
      stderr.replace(/"[^"]*"/g, '""'),
    )
  )
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
