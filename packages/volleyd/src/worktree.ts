import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExecFn } from "./exec";
import type { WorktreeResult, WorktreeSpec } from "./hosts/host";
import { SpawnError } from "./spawn-error";

/** `~` and `~/x` → the home directory; anything else resolved as given. */
export function expandHome(p: string, home: string = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return resolve(p);
}

/** `<worktree_root>/<wave>/<task>-<role>` — one worktree (and one lock) per task and role. */
export function worktreePath(root: string, wave: string, task: string, role: string): string {
  return join(expandHome(root), wave, `${task}-${role}`);
}

/** `<wave>/<task>-<role>-<attempt>` — a fresh branch per attempt. */
export function branchName(wave: string, task: string, role: string, attempt: number): string {
  return `${wave}/${task}-${role}-${attempt}`;
}

/**
 * Lines volleyd keeps out of every agent's `git status` (and `git add -A`): the supervisor's
 * per-agent files and the issue copy it writes at the worktree root.
 */
export const EXCLUDE_LINES = [".volley/", "/ISSUE.md"];

/** The remote a wave's release branch is pushed to (and fetched from). */
const REMOTE = "origin";

const missingText = (repo: string, branch: string) =>
  `${repo} has neither ${branch} nor ${REMOTE}/${branch} — push it first`;

/** The refusal when a wave's repo has its release branch neither locally nor on origin. */
export const releaseBranchMissing = (repo: string, branch: string) =>
  `RELEASE_BRANCH_MISSING: ${missingText(repo, branch)}`;

/** The commit `ref` names in `repo`, or null when it does not resolve. */
async function commitOf(exec: ExecFn, repo: string, ref: string): Promise<string | null> {
  const r = await exec(["git", "-C", repo, "rev-parse", "--verify", "--quiet", ref]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** The local release branch's and origin's tracking ref's commits (null where absent). */
async function releaseRefs(exec: ExecFn, repo: string, branch: string) {
  return {
    local: await commitOf(exec, repo, `refs/heads/${branch}`),
    remote: await commitOf(exec, repo, `refs/remotes/${REMOTE}/${branch}`),
  };
}

/**
 * `volleyd validate` / `run`: null when `repo` has the release branch locally or as
 * `origin/<branch>` (no fetch: what the repo knows now), else the RELEASE_BRANCH_MISSING text.
 */
export async function checkReleaseBranch(
  exec: ExecFn,
  repo: string,
  branch: string,
): Promise<string | null> {
  const refs = await releaseRefs(exec, repo, branch);
  return refs.local !== null || refs.remote !== null ? null : releaseBranchMissing(repo, branch);
}

/**
 * The ref an agent's branch is cut from for release branch `branch`, all through the fence:
 * `git fetch origin <branch>` (a failure — offline, no remote — leaves what the repo has), then
 *   - only `origin/<branch>`: create the tracking branch (`branch --track`) and use it, or use
 *     `origin/<branch>` itself if that fails;
 *   - both, the local one strictly behind origin's: `origin/<branch>`;
 *   - otherwise the local branch (level with or ahead of origin, or never pushed);
 *   - neither: SpawnError RELEASE_BRANCH_MISSING.
 */
export async function resolveReleaseBase(
  exec: ExecFn,
  repo: string,
  branch: string,
): Promise<string> {
  await exec(["git", "-C", repo, "fetch", "--quiet", REMOTE, branch]);
  const { local, remote } = await releaseRefs(exec, repo, branch);
  const tracking = `${REMOTE}/${branch}`;
  if (local === null && remote === null) {
    throw new SpawnError("RELEASE_BRANCH_MISSING", missingText(repo, branch), { repo, branch });
  }
  if (remote === null) return branch;
  if (local === null) {
    const r = await exec(["git", "-C", repo, "branch", "--track", branch, tracking]);
    return r.code === 0 ? branch : tracking;
  }
  if (local === remote) return branch;
  const behind = await exec(["git", "-C", repo, "merge-base", "--is-ancestor", local, remote]);
  return behind.code === 0 ? tracking : branch;
}

/**
 * `git worktree add <path> -b <branch> <base>` in the wave's repo, through the fence. A path
 * that is already a worktree (a relaunch under the same lock) is reused as it is. A release base
 * is resolved against origin first (`resolveReleaseBase`).
 */
export async function addWorktree(exec: ExecFn, spec: WorktreeSpec): Promise<WorktreeResult> {
  if (existsSync(spec.path)) {
    const r = await exec(["git", "-C", spec.path, "rev-parse", "--is-inside-work-tree"]);
    if (r.code === 0 && r.stdout.trim() === "true") {
      await excludeVolleyFiles(exec, spec.repo);
      // The worktree keeps the branch it was cut with; report that one, not the requested one.
      const head = await exec(["git", "-C", spec.path, "rev-parse", "--abbrev-ref", "HEAD"]);
      const branch =
        head.code === 0 && head.stdout.trim() !== "" ? head.stdout.trim() : spec.branch;
      return { path: spec.path, branch, reused: true };
    }
  }
  const base =
    spec.releaseBase === true ? await resolveReleaseBase(exec, spec.repo, spec.base) : spec.base;
  const r = await exec(
    spec.detach === true
      ? ["git", "-C", spec.repo, "worktree", "add", "--detach", spec.path, base]
      : [
          "git",
          "-C",
          spec.repo,
          "worktree",
          "add",
          spec.path,
          (await leftoverBranch(exec, spec.repo, spec.branch, base)) ? "-B" : "-b",
          spec.branch,
          base,
        ],
  );
  if (r.code !== 0) {
    throw new SpawnError("WORKTREE_FAILED", `git worktree add failed: ${r.stderr.trim()}`, {
      path: spec.path,
      branch: spec.branch,
    });
  }
  await excludeVolleyFiles(exec, spec.repo);
  return {
    path: spec.path,
    branch: spec.detach === true ? `HEAD (detached at ${base})` : spec.branch,
    reused: false,
  };
}

/**
 * Whether `branch` already exists with no commit of its own (its tip is in `base`): what a failed
 * `worktree add -b` leaves behind (git creates the branch before it fails on the path), which
 * would refuse every retry of the same attempt. Such a branch is re-created with `-B`; one with
 * commits of its own is never reset (the add then fails visibly). git itself refuses `-B` for a
 * branch checked out in another worktree.
 */
async function leftoverBranch(
  exec: ExecFn,
  repo: string,
  branch: string,
  base: string,
): Promise<boolean> {
  const tip = await commitOf(exec, repo, `refs/heads/${branch}`);
  if (tip === null || tip === "") return false;
  const r = await exec(["git", "-C", repo, "merge-base", "--is-ancestor", tip, base]);
  return r.code === 0;
}

/** Append `EXCLUDE_LINES` to the repo's shared `info/exclude`, each at most once. */
export async function excludeVolleyFiles(exec: ExecFn, repo: string): Promise<void> {
  const r = await exec(["git", "-C", repo, "rev-parse", "--git-common-dir"]);
  if (r.code !== 0) return;
  const common = r.stdout.trim();
  const file = join(isAbsolute(common) ? common : join(repo, common), "info", "exclude");
  const have = existsSync(file) ? readFileSync(file, "utf-8") : "";
  const lines = new Set(have.split("\n").map((l) => l.trim()));
  const missing = EXCLUDE_LINES.filter((l) => !lines.has(l));
  if (missing.length === 0) return;
  mkdirSync(dirname(file), { recursive: true });
  const sep = have === "" || have.endsWith("\n") ? "" : "\n";
  await appendFile(file, `${sep}# volleyd (agent worktrees)\n${missing.join("\n")}\n`);
}
