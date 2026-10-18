import type { ExecFn } from "../exec";
import type { ConsentToken } from "../fence";

/** Where and how one agent's worktree is cut. */
export interface WorktreeSpec {
  /** The wave's repository (a local checkout on the host). */
  repo: string;
  /** `<worktree_root>/<wave>/<task>-<role>`. */
  path: string;
  /** `<wave>/<task>-<role>-<attempt>`. */
  branch: string;
  /** The wave's release branch the worktree is cut from. */
  base: string;
}

export interface WorktreeResult {
  path: string;
  branch: string;
  /** True when the worktree already existed (a relaunch into the same lock) and was reused. */
  reused: boolean;
}

/** One terminal to open: the command is run by the pane's shell, nothing else is typed. */
export interface LaunchSpec {
  cwd: string;
  /** Workspace title, e.g. `<wave> <task> <role>`. */
  name: string;
  command: string;
}

/**
 * A machine agents run on. `local-cmux` (this package) runs them in cmux workspaces on the
 * daemon's own host; a remote host (ssh + tmux) implements the same interface. Every child
 * process a host starts goes through the fenced `exec`.
 */
export interface Host {
  /** `local`, or a remote host's name from the wave file's per-task `host:` key. */
  readonly name: string;
  /** The fenced exec this host runs commands with. */
  readonly exec: ExecFn;
  /** `git worktree add` (or reuse) and keep `.volley/` out of the repo's status. */
  prepareWorktree(spec: WorktreeSpec): Promise<WorktreeResult>;
  /** Write a file on the host, creating parent directories. */
  writeFile(path: string, content: string, mode?: number): Promise<void>;
  /** Open a terminal running `spec.command`; resolves with the workspace ref. */
  launch(spec: LaunchSpec): Promise<{ workspace: string }>;
  /** The last `lines` lines of the workspace's screen, or null when it cannot be read. */
  readScreen(workspace: string, lines: number): Promise<string | null>;
  /** Press one key (e.g. `Enter`, `Escape`) in the workspace. */
  sendKeys(workspace: string, key: string): Promise<void>;
  /** Type text into the workspace (no trailing Enter). */
  sendText(workspace: string, text: string): Promise<void>;
  /** Close the workspace. Destructive: only with consent from `volleyd cleanup --yes`. */
  close(workspace: string, consent: ConsentToken): Promise<void>;
  /** The screen channel's `source` for this host's captures (default `cmux`). */
  readonly screenSource?: string;
  /** Extra launch.sh exports for an agent (remote hosts: broker URL, namespace, agent id). */
  launchEnv?(id: { agent_id: string; namespace: string }): Record<string, string>;
}
