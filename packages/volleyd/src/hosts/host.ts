import type { ExecFn } from "../exec";
import type { ConsentToken, CoordinatorToken, FenceOptions, LaunchToken } from "../fence";
import type { LocalTerminal } from "../types";

/**
 * The fence tokens typed text and keys need (src/fence.ts TYPED_TEXT, PICKER): a sealed launch, a
 * switch, an inbox picker's or handoff's answer, a mailbox wake.
 */
export type TypedTextTokens = Pick<
  FenceOptions,
  "launch" | "modelSwitch" | "picker" | "handoff" | "wake"
>;

/** Where and how one agent's worktree is cut. */
export interface WorktreeSpec {
  /** The wave's repository (a local checkout on the host). */
  repo: string;
  /** `<worktree_root>/<wave>/<task>-<role>`. */
  path: string;
  /** `<wave>/<task>-<role>-<attempt>`. */
  branch: string;
  /** What the worktree is cut from: the wave's release branch, or a pipeline role's start commit. */
  base: string;
  /** Check `base` out detached (`--detach`, no branch): reviewers' read-only worktrees. */
  detach?: boolean;
  /**
   * `base` is the wave's release branch: fetch it from origin first and cut from whichever of
   * the local branch and `origin/<base>` is current (worktree.ts `resolveReleaseBase`).
   */
  releaseBase?: boolean;
  /**
   * With `releaseBase`: a failed fetch refuses the spawn (SpawnError BASE_STALE) instead of
   * cutting from the host's last copy (the `require_fresh_base` tunable; default true).
   */
  requireFresh?: boolean;
}

export interface WorktreeResult {
  path: string;
  branch: string;
  /** True when the worktree already existed (a relaunch into the same lock) and was reused. */
  reused: boolean;
  /**
   * A release base (`releaseBase`, a new worktree): the commit it was cut from, and whether the
   * fetch before it succeeded (`fetch_error`: why not, when it did not).
   */
  base?: { sha: string; fresh: boolean; fetch_error?: string };
  /** The fetch lost a ref-lock race and was retried (git-lock.ts lockedFetch): the first error. */
  fetch_retried?: string;
}

/** One terminal to open: the command is run by the pane's shell, nothing else is typed. */
export interface LaunchSpec {
  cwd: string;
  /** Workspace title, e.g. `<wave> <task> <role>`. */
  name: string;
  command: string;
  /** The sealed `.volley/launch.sh` in `cwd` (sealLaunchScript): the fence starts it only so. */
  launch?: LaunchToken;
  /** The terminal's size at launch (`tmux_cols` × `tmux_rows`); hosts that cannot size ignore it. */
  size?: TermSize;
  /**
   * The coordinator role (SPEC §4.6.25): `command` is `bash .volley/coordinator.sh`, sealed by this
   * token, and `name` is its session (`volley-coordinator-<name>`), taken as it is. tmux hosts only.
   */
  coordinator?: CoordinatorToken;
}

/** A terminal's size in character cells. */
export interface TermSize {
  cols: number;
  rows: number;
}

/** What ending a retired agent's session did (SPEC §4.6.4, journaled `agent_session_closed`). */
export interface SessionEnd {
  /** The workspace was closed. */
  closed: boolean;
  /** Processes still running under the agent's worktree that were stopped (local host only). */
  pids: number[];
  how: "close-workspace" | "kill-session" | "signal" | "none";
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
  /**
   * Open a terminal running `spec.command`; resolves with the workspace ref. A failure is a
   * `SpawnError` LAUNCH_FAILED whose `detail.outcome` is `refused` (nothing was created) or
   * `unknown` (the workspace may exist and its agent be starting: spawn.ts reconciles before any
   * retry); a remote host's also carries `detail.candidate`, the session name it tried.
   */
  launch(spec: LaunchSpec): Promise<{ workspace: string }>;
  /**
   * The ref of the workspace volleyd titled `name` (`candidate`: the session name a failed
   * launch tried, for hosts that name sessions themselves), or null when there is none. Rejects
   * when the host cannot be asked: the caller treats that as undecidable.
   */
  findWorkspace(name: string, candidate?: string): Promise<string | null>;
  /** The last `lines` lines of the workspace's screen, or null when it cannot be read. */
  readScreen(workspace: string, lines: number): Promise<string | null>;
  /** Press one key (`Enter`, `Escape`; `Up`, `Down`, `Space` with a picker token) in the workspace. */
  sendKeys(workspace: string, key: string, tokens?: TypedTextTokens): Promise<void>;
  /** Type text into the workspace (no trailing Enter), with the token the fence needs for it. */
  sendText(workspace: string, text: string, tokens?: TypedTextTokens): Promise<void>;
  /**
   * Resize the workspace's terminal to `size`, or back to its launch size (`"launch"`): the
   * Desk's Terminal popout (#403). False when this host has no way to (cmux); rejects when the
   * resize failed.
   */
  resize(workspace: string, size: TermSize | "launch"): Promise<boolean>;
  /**
   * Close the workspace. Destructive: only with consent from `volleyd cleanup --yes`, or a
   * retire's for the retired agent's own workspace.
   */
  close(workspace: string, consent: ConsentToken): Promise<void>;
  /**
   * End a retired agent's session (a retire's own consent): close its workspace (null: its ref
   * is not known) and, on the local host, stop the processes still running under `worktree`
   * (procs.ts). Never rejects: what did not happen is reported as not done.
   */
  endSession(
    workspace: string | null,
    worktree: string | null,
    consent: ConsentToken,
  ): Promise<SessionEnd>;
  /** The screen channel's `source` for this host's captures (default `cmux`). */
  readonly screenSource?: LocalTerminal;
  /**
   * Read a file on the host (null when it does not exist). Remote hosts only: without it, files
   * such as `.volley/brief-extra.md` are read from the daemon's own filesystem.
   */
  readFile?(path: string): Promise<string | null>;
  /** Extra launch.sh exports for an agent (remote hosts: broker URL, namespace, agent id). */
  launchEnv?(id: { agent_id: string; namespace: string }): Record<string, string>;
}
