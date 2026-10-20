import type { ExecFn } from "../exec";
import type { MergeToken } from "../fence";

/**
 * Autopilot merging (SPEC §4.6.16): the ONE module that may build `gh pr merge`
 * (test/no-merge.test.ts exempts exactly this file). The argv is the only shape the fence allows,
 * and only with the gate's MergeToken for exactly that PR and head: GitHub refuses the merge when
 * the head moved since the gate (`--match-head-commit`). Never --admin or --auto: a refused merge
 * is reported, not forced.
 */

export type MergeOutcome = { ok: true; merge_sha: string | null } | { ok: false; stderr: string };

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
 * `{ ok: false, stderr }`.
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
  const why = pre.code === 0 ? notMergeable(pre.stdout, token) : (pre.stderr || pre.stdout).trim();
  if (why !== null) return { ok: false, stderr: `not merged: ${why || "gh pr view failed"}` };
  const r = await exec(mergeArgv(token, deleteBranch), { merge: token, ...where });
  if (r.code !== 0) return { ok: false, stderr: (r.stderr || r.stdout).trim() };
  const view = await exec(
    ["gh", "pr", "view", String(token.pr), "--json", "mergeCommit,state"],
    where,
  );
  return { ok: true, merge_sha: view.code === 0 ? mergeSha(view.stdout) : null };
}

/** Why the PR as GitHub has it now is not the one the token was minted for; null when it is. */
function notMergeable(text: string, token: MergeToken): string | null {
  let v: { baseRefName?: unknown; headRefOid?: unknown; state?: unknown };
  try {
    v = (JSON.parse(text) ?? {}) as typeof v;
  } catch {
    return "gh pr view returned no JSON";
  }
  if (v.baseRefName !== token.release_branch)
    return `PR #${token.pr} targets ${String(v.baseRefName)}, not ${token.release_branch}`;
  if (v.headRefOid !== token.head)
    return `PR #${token.pr} head is ${String(v.headRefOid)}, not the gated ${token.head}`;
  if (v.state !== "OPEN") return `PR #${token.pr} is ${String(v.state)}`;
  return null;
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
