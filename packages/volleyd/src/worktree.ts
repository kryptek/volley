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

/**
 * `git worktree add <path> -b <branch> <base>` in the wave's repo, through the fence. A path
 * that is already a worktree (a relaunch under the same lock) is reused as it is.
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
  const r = await exec([
    "git",
    "-C",
    spec.repo,
    "worktree",
    "add",
    spec.path,
    "-b",
    spec.branch,
    spec.base,
  ]);
  if (r.code !== 0) {
    throw new SpawnError("WORKTREE_FAILED", `git worktree add failed: ${r.stderr.trim()}`, {
      path: spec.path,
      branch: spec.branch,
    });
  }
  await excludeVolleyFiles(exec, spec.repo);
  return { path: spec.path, branch: spec.branch, reused: false };
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
