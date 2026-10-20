import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { DAEMON_DEFAULTS } from "./config-defaults";
import { waveDecisionId } from "./decisions";
import type { ExecFn } from "./exec";
import { SpawnError } from "./spawn-error";
import type { WaveId } from "./types";

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

/** File identity used to detect a concurrent rewrite (Claude Code writes this file often). */
const fileStamp = (path: string) => {
  if (!existsSync(path)) return "absent";
  const st = statSync(path);
  return `${st.mtimeMs}:${st.size}:${st.ino}`;
};

/**
 * Record the owner's explicit `trust` answer: set `projects[root].hasTrustDialogAccepted` to
 * true and change nothing else in the file. Never called without that answer. Claude Code
 * rewrites `~/.claude.json` often, so the file is re-checked just before the rename and the
 * whole read-modify-write is retried if it changed, rather than dropping that write.
 * `hooks.beforeRename` is a test seam.
 */
export function recordRepoTrust(
  claudeJsonPath: string,
  root: string,
  hooks: { beforeRename?: () => void } = {},
): void {
  for (let i = 0; i < DAEMON_DEFAULTS.trust_write_attempts; i++) {
    const stamp = fileStamp(claudeJsonPath);
    const tmp = writeTrusted(claudeJsonPath, root);
    hooks.beforeRename?.();
    if (fileStamp(claudeJsonPath) === stamp) {
      renameSync(tmp, claudeJsonPath);
      return;
    }
    unlinkSync(tmp);
  }
  throw new Error(`${claudeJsonPath} kept changing; trust not recorded`);
}

/**
 * `cfg` with `projects[root].hasTrustDialogAccepted` set and nothing else changed (mutates and
 * returns it). Shared by the local write and a remote host's (RemoteHost.recordTrust).
 */
export function withTrust(cfg: Record<string, unknown>, root: string): Record<string, unknown> {
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
  return cfg;
}

/** Write the updated file next to the original; returns the temp path. */
function writeTrusted(claudeJsonPath: string, root: string): string {
  const cfg = withTrust(readClaudeJson(claudeJsonPath) ?? {}, root);
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
  return tmp;
}

/**
 * One `repo_untrusted` decision per wave and repo root (a wave's spawns into it all park on it),
 * per machine: a remote host's clone (`target`) is trusted in its own `~/.claude.json`, so it never
 * shares an id with a local clone at the same path.
 */
export function trustDecisionId(wave: WaveId, root: string, target?: string): string {
  return waveDecisionId("repo_untrusted", wave, target === undefined ? root : `${target}:${root}`);
}

/** The decision's question, as the owner sees it. */
export const trustQuestion = (root: string, target?: string, account?: string) =>
  `Needs you: trust ${root}${target !== undefined ? ` on ${target}` : ""}${account !== undefined ? ` in Claude account ${account}` : ""} for dispatch?`;
