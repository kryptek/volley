import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DAEMON_DEFAULTS } from "./config-defaults";
import type { ExecFn } from "./exec";
import type { WorktreeResult, WorktreeSpec } from "./hosts/host";
import { SpawnError } from "./spawn-error";
import type { Wave } from "./types";

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
 * The shape of every branch `branchName` mints: the wave-file id grammars for the wave and task,
 * a role volleyd spawns (brief.ts ROLES — not imported: brief.ts imports the fence, which uses
 * this), and an attempt from 1. The fence lets `worktree add -B` re-create only such a branch.
 */
export const AGENT_BRANCH =
  /^[a-z0-9][a-z0-9_-]{0,62}\/[A-Za-z0-9][A-Za-z0-9_-]{0,62}-(implementer|spec_reviewer|quality_reviewer|fixup|rebase)-[1-9][0-9]*$/;

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
  const sha = r.stdout.trim();
  return r.code === 0 && sha !== "" ? sha : null;
}

/**
 * `git fetch origin <branch>` in `repo`, through the fence: bounded by `git_fetch_timeout_ms` and
 * never prompting for credentials. Resolves with null when it succeeded, else why it failed
 * (offline, no remote, a timeout); what a failure means is the caller's call (`resolveReleaseBase`).
 */
export async function fetchRelease(
  exec: ExecFn,
  repo: string,
  branch: string,
): Promise<string | null> {
  const r = await exec(["git", "-C", repo, "fetch", "--quiet", REMOTE, branch], {
    timeoutMs: DAEMON_DEFAULTS.git_fetch_timeout_ms,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (r.timedOut) return "git fetch timed out";
  return r.code === 0 ? null : r.stderr.trim() || `git fetch exited ${r.code}`;
}

/** The local release branch's and origin's tracking ref's commits (null where absent). */
async function releaseRefs(exec: ExecFn, repo: string, branch: string) {
  return {
    local: await commitOf(exec, repo, `refs/heads/${branch}`),
    remote: await commitOf(exec, repo, `refs/remotes/${REMOTE}/${branch}`),
  };
}

/**
 * Whether volleyd spawns into the wave's `repo` on this machine (a task on the local host): only
 * then do `validate` and `run` check its release branch (a remote host's clone is checked on
 * the box).
 */
export const spawnsLocally = (wave: Pick<Wave, "tasks">): boolean =>
  Object.values(wave.tasks).some((t) => t.host === "local");

/**
 * `volleyd validate` / `run`: null when `repo` has the release branch locally or as
 * `origin/<branch>` (no fetch here: what the repo knows now — `run` fetches first), else the
 * RELEASE_BRANCH_MISSING text.
 */
export async function checkReleaseBranch(
  exec: ExecFn,
  repo: string,
  branch: string,
): Promise<string | null> {
  const git = await exec(["git", "-C", repo, "rev-parse", "--git-dir"]);
  if (git.code !== 0) return `RELEASE_BRANCH_MISSING: ${repo} is not a git repository`;
  const refs = await releaseRefs(exec, repo, branch);
  return refs.local !== null || refs.remote !== null ? null : releaseBranchMissing(repo, branch);
}

/** Where an agent's branch is cut from for a release branch (`resolveReleaseBase`). */
export interface ReleaseBase {
  /** The ref handed to `git worktree add`: the release branch or `origin/<branch>`. */
  ref: string;
  /** The commit `ref` names: the task's `base_sha`. */
  sha: string;
  /** False when the fetch failed and `requireFresh` was off: `sha` is this repo's last copy. */
  fresh: boolean;
  /** Why the fetch failed (only when not fresh). */
  fetch_error?: string;
}

/**
 * The ref an agent's branch is cut from for release branch `branch`, all through the fence:
 * `fetchRelease` first. A failed fetch refuses with SpawnError BASE_STALE while `requireFresh`
 * is on (the `require_fresh_base` tunable, default on: no agent starts on a stale base); off, it
 * leaves what the repo has (`fresh: false`, the caller journals the warning). Then
 *   - only `origin/<branch>`: create the tracking branch (`branch --track`) and use it, or use
 *     `origin/<branch>` itself if that fails;
 *   - both, the local one containing origin's commit (level or ahead): the local branch;
 *   - both otherwise (behind, or diverged — origin has commits the local one lacks):
 *     `origin/<branch>`;
 *   - only the local branch (never pushed): the local branch;
 *   - neither: SpawnError RELEASE_BRANCH_MISSING.
 */
export async function resolveReleaseBase(
  exec: ExecFn,
  repo: string,
  branch: string,
  opts: { requireFresh?: boolean } = {},
): Promise<ReleaseBase> {
  const fetchError = await fetchRelease(exec, repo, branch);
  if (fetchError !== null && opts.requireFresh !== false) {
    throw new SpawnError(
      "BASE_STALE",
      `git fetch ${REMOTE} ${branch} failed in ${repo} (${fetchError}); require_fresh_base is on, so no worktree is cut from the local copy`,
      { repo, branch, fetch_error: fetchError },
    );
  }
  const freshness =
    fetchError === null ? { fresh: true } : { fresh: false, fetch_error: fetchError };
  const { local, remote } = await releaseRefs(exec, repo, branch);
  const tracking = `${REMOTE}/${branch}`;
  if (local === null && remote === null) {
    throw new SpawnError("RELEASE_BRANCH_MISSING", missingText(repo, branch), { repo, branch });
  }
  if (remote === null) return { ref: branch, sha: local as string, ...freshness };
  if (local === null) {
    const r = await exec(["git", "-C", repo, "branch", "--track", branch, tracking]);
    return { ref: r.code === 0 ? branch : tracking, sha: remote, ...freshness };
  }
  if (local === remote) return { ref: branch, sha: local, ...freshness };
  const contains = await exec(["git", "-C", repo, "merge-base", "--is-ancestor", remote, local]);
  return contains.code === 0
    ? { ref: branch, sha: local, ...freshness }
    : { ref: tracking, sha: remote, ...freshness };
}

/**
 * `git worktree add <path> -b <branch> <base>` in the wave's repo, through the fence. A path
 * that is already a worktree (a relaunch under the same lock) is reused as it is. A release base
 * is resolved against origin first (`resolveReleaseBase`); the result names the commit it was cut
 * from (`base`).
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
  const release =
    spec.releaseBase === true
      ? await resolveReleaseBase(exec, spec.repo, spec.base, {
          ...(spec.requireFresh !== undefined ? { requireFresh: spec.requireFresh } : {}),
        })
      : null;
  const base = release?.ref ?? spec.base;
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
    ...(release !== null ? { base: baseOf(release) } : {}),
  };
}

/** A resolved release base as a `WorktreeResult` reports it. */
const baseOf = (r: ReleaseBase): NonNullable<WorktreeResult["base"]> => ({
  sha: r.sha,
  fresh: r.fresh,
  ...(r.fetch_error !== undefined ? { fetch_error: r.fetch_error } : {}),
});

/**
 * Whether `branch` already exists with no commit of its own (its tip is in `base`): what a failed
 * `worktree add -b` leaves behind (git creates the branch before it fails on the path), which
 * would refuse every retry of the same attempt. Such a branch is re-created with `-B` — only an
 * `AGENT_BRANCH` one (the fence allows nothing else); one with commits of its own is never reset (the add then fails visibly). git itself refuses `-B` for a
 * branch checked out in another worktree.
 */
async function leftoverBranch(
  exec: ExecFn,
  repo: string,
  branch: string,
  base: string,
): Promise<boolean> {
  if (!AGENT_BRANCH.test(branch)) return false;
  const tip = await commitOf(exec, repo, `refs/heads/${branch}`);
  if (tip === null) return false;
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
