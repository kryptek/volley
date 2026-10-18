import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { ExecFn } from "./exec";
import { SpawnError } from "./spawn-error";

/**
 * Repo trust (Claude Code's folder-trust dialog). Claude Code records an accepted dialog as
 * `projects[<dir>].hasTrustDialogAccepted: true` in `~/.claude.json`; until the repo is trusted
 * its hooks do not run, so a launch there would look like a silent failure. volleyd checks the
 * repo root before the first spawn and, when untrusted, opens a `repo_untrusted` decision
 * instead of launching. It never accepts the dialog on its own: `recordRepoTrust` is called only
 * on the owner's explicit `trust` answer.
 */

/** The repo's top-level directory (`git rev-parse --show-toplevel`), through the fence. */
export async function repoRoot(exec: ExecFn, repo: string): Promise<string> {
  const r = await exec(["git", "-C", repo, "rev-parse", "--show-toplevel"]);
  const root = r.stdout.trim();
  if (r.code !== 0 || root === "") {
    throw new SpawnError("WORKTREE_FAILED", `${repo} is not a git repository`, {
      repo,
      stderr: r.stderr.trim(),
    });
  }
  return root;
}

/** Parse `~/.claude.json`; null when absent or unreadable. */
export function readClaudeJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const v = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** True when `root` or one of its parent directories has an accepted trust dialog. */
export function isRepoTrusted(claudeJson: Record<string, unknown> | null, root: string): boolean {
  const projects = claudeJson?.projects;
  if (typeof projects !== "object" || projects === null) return false;
  const table = projects as Record<string, unknown>;
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    const entry = Object.hasOwn(table, dir) ? table[dir] : undefined;
    if (
      typeof entry === "object" &&
      entry !== null &&
      (entry as Record<string, unknown>).hasTrustDialogAccepted === true
    ) {
      return true;
    }
    if (dirname(dir) === dir) return false;
  }
}

/**
 * Record the owner's explicit `trust` answer: set `projects[root].hasTrustDialogAccepted` to
 * true and change nothing else in the file. Never called without that answer.
 */
export function recordRepoTrust(claudeJsonPath: string, root: string): void {
  const cfg = readClaudeJson(claudeJsonPath) ?? {};
  const projects =
    typeof cfg.projects === "object" && cfg.projects !== null
      ? (cfg.projects as Record<string, unknown>)
      : {};
  const entry = Object.hasOwn(projects, root) ? projects[root] : undefined;
  projects[root] = {
    ...(typeof entry === "object" && entry !== null ? entry : {}),
    hasTrustDialogAccepted: true,
  };
  cfg.projects = projects;
  // Atomic replace that keeps the file's mode (it holds credentials; usually 0600).
  const mode = existsSync(claudeJsonPath) ? statSync(claudeJsonPath).mode & 0o777 : 0o600;
  const tmp = `${claudeJsonPath}.volleyd.tmp`;
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, `${JSON.stringify(cfg, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, claudeJsonPath);
}

/** One `repo_untrusted` decision per repo root (a wave's spawns into it all park on it). */
export function trustDecisionId(root: string): string {
  return `repo_untrusted-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`;
}

/** The decision's question, as the owner sees it. */
export const trustQuestion = (root: string) => `Needs you: trust ${root} for dispatch?`;
