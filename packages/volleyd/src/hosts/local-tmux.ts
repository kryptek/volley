import { DAEMON_DEFAULTS } from "../config-defaults";
import type { ExecFn, ExecResult } from "../exec";
import { type ConsentToken, FenceError, TMUX_LAUNCH_COMMAND } from "../fence";
import { reapUnder } from "../procs";
import { SpawnError } from "../spawn-error";
import { addWorktree } from "../worktree";
import type {
  Host,
  LaunchSpec,
  SessionEnd,
  TermSize,
  TypedTextTokens,
  WorktreeResult,
  WorktreeSpec,
} from "./host";
import { writeLocalFile } from "./local-cmux";
import { DEFAULT_SIZE, pane, sessionName, sizeArgs, tmuxSize } from "./ssh-tmux";

/** `<wave> <task> <role>` → `volley-<wave>-<task>-<role>`: the only local sessions the fence lets volleyd run agents in. */
export const localSessionName = (title: string) => `volley-${sessionName(title)}`;

/** Exit 127: the shell found no `tmux` to run. */
const NOT_FOUND = 127;
/** What `volley setup` and the owner do about a missing tmux (setup's `tmuxInstallLine` lines). */
const INSTALL_TMUX =
  "Install tmux (macOS: `brew install tmux`; Debian, Ubuntu: `sudo apt-get install -y tmux`; Fedora: `sudo dnf install -y tmux`), then run `volley setup --check`.";
const NOT_INSTALLED = `tmux is not installed. ${INSTALL_TMUX}`;

/** exec spawns without a shell, so a missing tmux rejects with ENOENT rather than exiting 127. */
const isNotFound = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code === "ENOENT";

/** tmux's answer for a session (or server) that is not there. */
const GONE = /can't find session|session not found|no server running|error connecting to/i;

/**
 * The local host under `fleet.local_terminal: tmux` (every Linux supervisor; a Mac without
 * cmux): worktrees on this machine, each agent in a detached tmux session named
 * `volley-<wave>-<task>-<role>` on the user's default tmux server, so `tmux attach -t <it>`
 * shows it. The tmux shapes are the paired machine's (hosts/ssh-tmux.ts) without the ssh
 * transport; every command goes through the fenced `exec`, whose local tmux rules admit only
 * those session names, and killing one needs a consent token (`cleanup --yes`, or a retire for
 * its agent's own session).
 */
export class LocalTmuxHost implements Host {
  readonly name = "local";
  readonly screenSource = "tmux";
  constructor(readonly exec: ExecFn) {}

  prepareWorktree(spec: WorktreeSpec): Promise<WorktreeResult> {
    return addWorktree(this.exec, spec);
  }

  writeFile(path: string, content: string, mode?: number): Promise<void> {
    return writeLocalFile(path, content, mode);
  }

  /** The launch chain: each launch starts after the one before it settles. */
  private launches: Promise<unknown> = Promise.resolve();

  /** Open a tmux session. Serialized: one `new-session` in flight at a time. */
  launch(spec: LaunchSpec): Promise<{ workspace: string }> {
    const run = this.launches.then(() => this.launchNow(spec));
    this.launches = run.catch(() => undefined);
    return run;
  }

  /**
   * A failed launch's `detail.outcome` is `unknown` when `new-session` may have run (a timeout,
   * a rejected exec past the fence), else `refused`: tmux checks before it creates anything.
   * `detail.candidate` is the session name tried.
   */
  private async launchNow(spec: LaunchSpec): Promise<{ workspace: string }> {
    const fail = (msg: string, detail: Record<string, unknown> = {}) =>
      new SpawnError("LAUNCH_FAILED", msg, { outcome: "refused", ...detail });
    if (spec.command.trim() !== TMUX_LAUNCH_COMMAND) {
      throw fail(`a local tmux session runs only '${TMUX_LAUNCH_COMMAND}'`);
    }
    const base = localSessionName(spec.name);
    const session = await this.freeSession(base).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === NOT_INSTALLED)
        throw fail(`volleyd cannot open a tmux session: ${msg}`, { candidate: base });
      throw fail(`tmux: ${msg}`, { candidate: base });
    });
    // Detached, tmux would size it 80×24 (its default-size) and nothing would ever widen it.
    const size = tmuxSize(spec.size ?? DEFAULT_SIZE);
    const r = await this.exec(
      [
        "tmux",
        "new-session",
        "-d",
        ...sizeArgs(size),
        "-s",
        session,
        "-c",
        spec.cwd,
        TMUX_LAUNCH_COMMAND,
      ],
      {
        timeoutMs: DAEMON_DEFAULTS.launch_timeout_ms,
        ...(spec.launch !== undefined ? { launch: spec.launch } : {}),
      },
    ).catch((e: unknown) => {
      if (isNotFound(e))
        throw fail(`volleyd cannot open a tmux session: ${NOT_INSTALLED}`, { candidate: session });
      throw fail(`tmux new-session: ${e instanceof Error ? e.message : String(e)}`, {
        candidate: session,
        // The fence refusing it means nothing ran; anything else may have started tmux.
        outcome: e instanceof FenceError ? "refused" : "unknown",
      });
    });
    if (r.code !== 0 || r.timedOut) {
      throw fail(
        r.code === NOT_FOUND
          ? `volleyd cannot open a tmux session: ${NOT_INSTALLED}`
          : `tmux new-session failed: ${r.timedOut ? "timed out" : r.stderr.trim()}`,
        {
          exit: r.code,
          tmux: r.stderr.trim(),
          candidate: session,
          outcome: r.timedOut ? "unknown" : "refused",
        },
      );
    }
    this.launchSizes.set(session, size);
    return { workspace: session };
  }

  /** Each session's size at launch, what `resize(…, "launch")` returns it to. */
  private readonly launchSizes = new Map<string, TermSize>();

  /** `tmux resize-window`: Claude Code re-wraps on the SIGWINCH. */
  async resize(workspace: string, size: TermSize | "launch"): Promise<boolean> {
    const to =
      size === "launch"
        ? (this.launchSizes.get(workspace) ?? tmuxSize(DEFAULT_SIZE))
        : tmuxSize(size);
    const r = await this.exec(["tmux", "resize-window", "-t", pane(workspace), ...sizeArgs(to)]);
    if (r.code !== 0) {
      throw new Error(`tmux resize-window: ${r.timedOut ? "timed out" : r.stderr.trim()}`);
    }
    return true;
  }

  async findWorkspace(name: string, candidate?: string): Promise<string | null> {
    const session = candidate ?? localSessionName(name);
    return (await this.hasSession(session)) ? session : null;
  }

  /** Whether the session exists; rejects when tmux cannot say (a timeout, no tmux). */
  private async hasSession(session: string): Promise<boolean> {
    const r = await this.exec(["tmux", "has-session", "-t", `=${session}`], {
      timeoutMs: DAEMON_DEFAULTS.workspace_lookup_timeout_ms,
    }).catch((e: unknown) => {
      throw isNotFound(e) ? new Error(NOT_INSTALLED) : e;
    });
    // 1: no such session, or no server at all; anything else is tmux failing to answer.
    if (r.timedOut || (r.code !== 0 && r.code !== 1)) throw tmuxFailed("has-session", r);
    return r.code === 0;
  }

  /** `base`, or `base-2`, `base-3`, … — the first name no tmux session has. */
  private async freeSession(base: string): Promise<string> {
    for (let i = 1; i <= DAEMON_DEFAULTS.tmux_session_attempts; i++) {
      const name = i === 1 ? base : `${base}-${i}`;
      if (!(await this.hasSession(name))) return name;
    }
    throw new Error(`no free session name for ${base}`);
  }

  async readScreen(workspace: string, lines: number): Promise<string | null> {
    // Bounded: a hung tmux must not hold a caller (the screen publisher, verification) forever.
    const r = await this.exec(
      ["tmux", "capture-pane", "-p", "-t", pane(workspace), `-S-${lines}`],
      {
        timeoutMs: DAEMON_DEFAULTS.screen_read_timeout_ms,
      },
    ).catch(() => null);
    if (r === null || r.code !== 0 || r.timedOut) return null;
    // capture-pane prints the whole pane, blank rows included: keep the last `lines` up to the
    // last row with text, like cmux read-screen --lines.
    const rows = r.stdout.split("\n");
    while (rows.length > 0 && (rows.at(-1) as string).trim() === "") rows.pop();
    return rows.slice(-lines).join("\n");
  }

  async sendKeys(workspace: string, key: string, tokens: TypedTextTokens = {}): Promise<void> {
    await this.exec(["tmux", "send-keys", "-t", pane(workspace), key], tokens);
  }

  async sendText(workspace: string, text: string, tokens: TypedTextTokens = {}): Promise<void> {
    await this.exec(["tmux", "send-keys", "-t", pane(workspace), "-l", "--", text], tokens);
  }

  /** Kill the session; one already gone (or no tmux server at all) is closed. */
  async close(workspace: string, consent: ConsentToken): Promise<void> {
    // Bounded: a slow tmux must not hold a retire (or cleanup) forever.
    const r = await this.exec(["tmux", "kill-session", "-t", `=${workspace}`], {
      consent,
      timeoutMs: DAEMON_DEFAULTS.workspace_close_timeout_ms,
    });
    if (r.timedOut) throw new Error(`tmux kill-session ${workspace} timed out`);
    if (r.code !== 0 && !GONE.test(r.stderr))
      throw new Error(`tmux kill-session ${workspace}: ${r.stderr.trim() || `exit ${r.code}`}`);
    this.launchSizes.delete(workspace);
  }

  /**
   * Kill the session, then stop whatever still runs under the agent's worktree: a process the
   * agent left in the background outlives its pane's process group.
   */
  async endSession(
    workspace: string | null,
    worktree: string | null,
    consent: ConsentToken,
  ): Promise<SessionEnd> {
    let closed = false;
    if (workspace !== null)
      closed = await this.close(workspace, consent).then(
        () => true,
        () => false,
      );
    const pids =
      worktree === null
        ? []
        : await reapUnder(this.exec, worktree).then(
            (r) => r.stopped.map((s) => s.pid),
            () => [],
          );
    return { closed, pids, how: closed ? "kill-session" : pids.length > 0 ? "signal" : "none" };
  }
}

function tmuxFailed(what: string, r: ExecResult): Error {
  if (r.code === NOT_FOUND) return new Error(NOT_INSTALLED);
  return new Error(
    `tmux ${what} failed: ${r.timedOut ? "timed out" : r.stderr.trim() || `exit ${r.code}`}`,
  );
}
