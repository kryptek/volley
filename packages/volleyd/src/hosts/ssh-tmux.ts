import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { DAEMON_DEFAULTS, REMOTE_HOST_DEFAULTS } from "../config-defaults";
import type { ExecFn, ExecOptions, ExecResult } from "../exec";
import {
  type ConsentToken,
  REMOTE_CLAUDE_JSON,
  REMOTE_CLAUDE_JSON_TMP,
  type RemoteStep,
  TMUX_LAUNCH_COMMAND,
} from "../fence";
import { fetchFailure, lockedFetch } from "../git-lock";
import { type DoctorReport, parseDoctorReport } from "../machines";
import { PATH_TOOLS, type PathProbe, parsePathProbe } from "../readiness";
import { SpawnError } from "../spawn-error";
import { withTrust } from "../trust";
import type { RemoteHostConfig } from "../types";
import { EXCLUDE_LINES, firstLine, freshBaseFix } from "../worktree";
import type {
  Host,
  LaunchSpec,
  SessionEnd,
  TypedTextTokens,
  WorktreeResult,
  WorktreeSpec,
} from "./host";

/** A remote host with every key resolved (config `hosts.<name>` ← the task's inline `host:`). */
export interface RemoteHostSpec {
  name: string;
  target: string;
  repo: string;
  worktree_root: string;
  volley_dir: string;
  tunnel: { remote_port: number; supervise: boolean };
}

/**
 * Resolve a task's host: the config entry `hosts.<name>`, with the task's inline `host:` layered
 * over it, and defaults for the rest. Throws LAUNCH_FAILED naming what is missing.
 */
export function resolveRemoteHost(
  name: string,
  inline: (RemoteHostConfig & { name?: string }) | undefined,
  configured: Record<string, RemoteHostConfig>,
): RemoteHostSpec {
  const base = Object.hasOwn(configured, name) ? configured[name] : undefined;
  if (base === undefined && inline === undefined) {
    throw new SpawnError("LAUNCH_FAILED", `host '${name}' is not configured`, { host: name });
  }
  const { name: _label, ...over } = inline ?? {};
  const h: RemoteHostConfig = {
    ...base,
    ...over,
    tunnel: { ...base?.tunnel, ...inline?.tunnel },
  };
  const missing = (["target", "repo", "volley_dir"] as const).filter((k) => h[k] === undefined);
  if (missing.length > 0) {
    throw new SpawnError("LAUNCH_FAILED", `host '${name}' has no ${missing.join(", ")}`, {
      host: name,
      missing,
    });
  }
  const repo = h.repo as string;
  return {
    name,
    target: h.target as string,
    repo,
    worktree_root:
      h.worktree_root ?? posix.join(posix.dirname(repo), REMOTE_HOST_DEFAULTS.worktree_dir),
    volley_dir: h.volley_dir as string,
    tunnel: {
      remote_port: h.tunnel?.remote_port ?? REMOTE_HOST_DEFAULTS.remote_port,
      supervise: h.tunnel?.supervise ?? REMOTE_HOST_DEFAULTS.supervise_tunnel,
    },
  };
}

/** What the daemon needs from a remote host beyond `Host` (SshTmuxHost; fakes in tests). */
export interface RemoteHost extends Host {
  readonly spec: RemoteHostSpec;
  /** Run fenced steps on the box as one `bash -s` script (claude/remote-signin.ts). */
  run(steps: RemoteStep[], opts?: RemoteRunOptions): Promise<ExecResult>;
  /** `$VOLLEY_HOOKS_DIR` on the box. */
  readonly hooksDir: string;
  /** The box's volley-mcp entry point (its `.volley/mcp.json` server). */
  readonly mcpEntry: string;
  /** The broker URL agents on the box use (the tunnel's remote end). */
  readonly brokerUrl: string;
  /** True / false for a clone / none at `repo`; throws LAUNCH_FAILED when ssh itself fails. */
  repoExists(): Promise<boolean>;
  tunnelUp(): Promise<boolean>;
  /** The box's folder trust; null when it has no readable `~/.claude.json`; throws if ssh fails. */
  readTrust(): Promise<Record<string, unknown> | null>;
  /** The owner's `trust` answer, recorded in the box's own `~/.claude.json`. */
  recordTrust(root: string): Promise<void>;
  /** A file on the box; null when it does not exist; throws when ssh fails. */
  readFile(path: string): Promise<string | null>;
  /**
   * Readiness's PATH probe: whether `claude` and `bun` resolve on the non-interactive ssh PATH
   * (the same `bash -s` that runs launch.sh). Throws when ssh fails.
   */
  probePath(): Promise<PathProbe>;
  /**
   * `volley peer doctor --json --supervisor-volley-dir <volley_dir> [--fix --yes [--clone
   * --origin <clone>]]` on the box, in its volley checkout: the parsed report. `clone` (with `fix`) is the wave repo's URL the doctor clones
   * where the box's clone is missing. Throws when ssh fails or the doctor printed no report.
   */
  runDoctor(opts: { fix: boolean; clone?: string }): Promise<DoctorReport>;
}

/** The fence tokens and bound a `run` may carry. */
export type RemoteRunOptions = Pick<
  ExecOptions,
  "consent" | "timeoutMs" | "launch" | "modelSwitch" | "signin" | "picker" | "handoff" | "wake"
>;

/** ssh's own failure (unreachable, auth, host key, timeout), as opposed to the remote command's. */
const SSH_FAILED = 255;

/** True when the result is ssh failing, not the remote command. */
const transportFailed = (r: ExecResult) => r.timedOut || r.code === SSH_FAILED;

/** Programs that act on the daemon's own machine (`volley auth`: the broker's logins), never the box. */
const LOCAL_PROGRAMS = new Set(["volley"]);

/**
 * A second machine: worktrees in its clone of the repo, agents in tmux sessions, reached over
 * SSH. Every remote command is a fenced script sent on stdin to `ssh -T <target> bash -s` —
 * never a command string, which a zsh login shell would word-split differently — and files are
 * written as base64 through that script (mode 0600 for anything with a mode, e.g. agent.json).
 * The agents reach the broker through a reverse tunnel (src/hosts/tunnel.ts) at
 * `mqtt://127.0.0.1:<remote_port>`; their identity still comes from `.volley/agent.json`.
 */
export class SshTmuxHost implements RemoteHost {
  readonly name: string;
  readonly screenSource = "tmux";
  /** `exec` for spawn's steps: credentials and the brief gate run here, the rest on the box. */
  readonly exec: ExecFn;

  constructor(
    readonly spec: RemoteHostSpec,
    private readonly localExec: ExecFn,
  ) {
    this.name = spec.name;
    this.exec = (argv, opts = {}) => this.route(argv, opts);
  }

  /** `$VOLLEY_HOOKS_DIR` on the box: its volley checkout's hooks. */
  get hooksDir(): string {
    return posix.join(this.spec.volley_dir, "packages", "volley-hooks");
  }

  /** The box's volley checkout's MCP server: what its agents' `.volley/mcp.json` runs. */
  get mcpEntry(): string {
    return posix.join(this.spec.volley_dir, "packages", "volley-mcp", "src", "index.ts");
  }

  /** The broker as the box sees it: the tunnel's remote end. */
  get brokerUrl(): string {
    return `mqtt://127.0.0.1:${this.spec.tunnel.remote_port}`;
  }

  /** Env exports for launch.sh, for tooling that reads env (the identity file still wins). */
  launchEnv(id: { agent_id: string; namespace: string }): Record<string, string> {
    return {
      VOLLEY_BROKER_URL: this.brokerUrl,
      VOLLEY_NAMESPACE: id.namespace,
      VOLLEY_AGENT_ID: id.agent_id,
    };
  }

  /** Run steps on the box as one fenced `bash -s` script. */
  run(steps: RemoteStep[], opts: RemoteRunOptions = {}): Promise<ExecResult> {
    return this.localExec(
      [
        "ssh",
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        `ConnectTimeout=${DAEMON_DEFAULTS.ssh_connect_timeout_s}`,
        this.spec.target,
        "bash",
        "-s",
      ],
      {
        remote: { steps },
        timeoutMs: opts.timeoutMs ?? DAEMON_DEFAULTS.remote_exec_timeout_ms,
        ...(opts.consent !== undefined ? { consent: opts.consent } : {}),
        ...(opts.launch !== undefined ? { launch: opts.launch } : {}),
        ...(opts.modelSwitch !== undefined ? { modelSwitch: opts.modelSwitch } : {}),
        ...(opts.picker !== undefined ? { picker: opts.picker } : {}),
        ...(opts.handoff !== undefined ? { handoff: opts.handoff } : {}),
        ...(opts.wake !== undefined ? { wake: opts.wake } : {}),
        ...(opts.signin !== undefined ? { signin: opts.signin } : {}),
      },
    );
  }

  private async route(argv: readonly string[], opts: ExecOptions): Promise<ExecResult> {
    if (LOCAL_PROGRAMS.has(argv[0] ?? "")) return this.localExec(argv, opts);
    if (opts.script !== undefined) return this.runGate(argv, opts);
    return this.run([{ argv: [...argv], ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}) }], {
      ...(opts.consent !== undefined ? { consent: opts.consent } : {}),
    });
  }

  /** The brief gate is a local program: run it on a local copy of the remote brief. */
  private async runGate(argv: readonly string[], opts: ExecOptions): Promise<ExecResult> {
    const [gate, brief] = argv;
    if (gate === undefined || brief === undefined) return this.localExec(argv, opts);
    const r = await this.run([{ argv: ["cat", brief] }]);
    if (r.code !== 0) return r;
    const dir = await mkdtemp(join(tmpdir(), "volleyd-brief-"));
    try {
      const copy = join(dir, "brief.md");
      await writeFile(copy, r.stdout, { mode: 0o600 });
      const { cwd: _remoteCwd, ...rest } = opts;
      return await this.localExec([gate, copy], { ...rest, cwd: dir });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async runOrThrow(steps: RemoteStep[], what: string): Promise<ExecResult> {
    const r = await this.run(steps);
    if (r.code !== 0) {
      throw new Error(
        `${what} on ${this.spec.target} failed: ${r.stderr.trim() || `exit ${r.code}`}`,
      );
    }
    return r;
  }

  /** A worktree at an exact commit: detached (a reviewer) or on a new branch (a fixup). */
  private async worktreeAtCommit(
    spec: WorktreeSpec,
    fetchError: string | null,
  ): Promise<WorktreeResult> {
    const git = (...args: string[]) => this.run([{ argv: ["git", ...args] }]);
    if (fetchError !== null) {
      const has = await git(
        "-C",
        spec.repo,
        "rev-parse",
        "--verify",
        "--quiet",
        `${spec.base}^{commit}`,
      );
      if (has.code !== 0) {
        throw new SpawnError(
          "WORKTREE_FAILED",
          `git fetch origin ${spec.base} failed on ${this.spec.target}: ${fetchError}`,
          { host: this.name, repo: spec.repo },
        );
      }
    }
    const add = await git(
      "-C",
      spec.repo,
      "worktree",
      "add",
      ...(spec.detach === true
        ? ["--detach", spec.path, spec.base]
        : ["--no-track", spec.path, "-b", spec.branch, spec.base]),
    );
    if (add.code !== 0) {
      throw new SpawnError(
        "WORKTREE_FAILED",
        `git worktree add failed on ${this.spec.target}: ${add.stderr.trim()}`,
        { host: this.name, path: spec.path, branch: spec.branch },
      );
    }
    await this.excludeVolleyFiles(spec.repo);
    return {
      path: spec.path,
      branch: spec.detach === true ? `HEAD (detached at ${spec.base})` : spec.branch,
      reused: false,
    };
  }

  async prepareWorktree(spec: WorktreeSpec): Promise<WorktreeResult> {
    const git = (...args: string[]) => this.run([{ argv: ["git", ...args] }]);
    const inside = await git("-C", spec.path, "rev-parse", "--is-inside-work-tree");
    if (inside.code === 0 && inside.stdout.trim() === "true") {
      await this.excludeVolleyFiles(spec.repo);
      const head = await git("-C", spec.path, "rev-parse", "--abbrev-ref", "HEAD");
      const branch =
        head.code === 0 && head.stdout.trim() !== "" ? head.stdout.trim() : spec.branch;
      return { path: spec.path, branch, reused: true };
    }
    // The box's clone must have the release branch as it is now: fetch it, cut from origin's.
    // A failed fetch refuses the spawn unless require_fresh_base is off (then: the box's copy);
    // for a start ref (a reviewer's head), it is a plain worktree failure, as it always was.
    // One fetch into the box's clone at a time (git-lock.ts); a lost ref-lock race is retried.
    const { result: fetch, retried } = await lockedFetch(this.name, spec.repo, () =>
      git("-C", spec.repo, "fetch", "--quiet", "origin", spec.base),
    );
    const fetchError = fetch.code === 0 ? null : firstLine(fetch.stderr, `exit ${fetch.code}`);
    const retriedNote = retried !== undefined ? { fetch_retried: retried } : {};
    // A start commit (a reviewer's or fixup's PR head, by sha) is used as it is, like on this
    // machine: never `origin/<sha>`. The box may already hold it (its own agent pushed it).
    if (isCommitSha(spec.base))
      return { ...(await this.worktreeAtCommit(spec, fetchError)), ...retriedNote };
    if (fetchError !== null && spec.releaseBase !== true) {
      throw new SpawnError(
        "WORKTREE_FAILED",
        `git fetch origin ${spec.base} failed on ${this.spec.target}: ${fetchError}`,
        { host: this.name, repo: spec.repo },
      );
    }
    if (
      fetchError !== null &&
      spec.requireFresh !== false &&
      fetchFailure(fetchError) === "unreachable"
    ) {
      throw new SpawnError(
        "BASE_UNREACHABLE",
        `git fetch origin ${spec.base} failed on ${this.spec.target}: ${fetchError}; origin was not reached, so no worktree is cut from the box's copy. The spawn is retried with the usual backoff.`,
        { host: this.name, repo: spec.repo, branch: spec.base, fetch_error: fetchError },
      );
    }
    if (fetchError !== null && spec.requireFresh !== false) {
      throw new SpawnError(
        "BASE_STALE",
        `git fetch origin ${spec.base} failed on ${this.spec.target}: ${fetchError}; require_fresh_base is on, so no worktree is cut from the box's copy. ${freshBaseFix(spec.base)}`,
        {
          host: this.name,
          repo: spec.repo,
          branch: spec.base,
          fetch_error: fetchError,
        },
      );
    }
    const add = await git(
      "-C",
      spec.repo,
      "worktree",
      "add",
      "--no-track",
      spec.path,
      "-b",
      spec.branch,
      `origin/${spec.base}`,
    );
    if (add.code !== 0) {
      throw new SpawnError(
        "WORKTREE_FAILED",
        `git worktree add failed on ${this.spec.target}: ${add.stderr.trim()}`,
        {
          host: this.name,
          path: spec.path,
          branch: spec.branch,
        },
      );
    }
    await this.excludeVolleyFiles(spec.repo);
    // The commit it was cut from (the task's base_sha): the new branch's tip, as it is now.
    const tip = spec.releaseBase === true ? await git("-C", spec.path, "rev-parse", "HEAD") : null;
    const sha = tip?.code === 0 ? tip.stdout.trim() : "";
    return {
      path: spec.path,
      branch: spec.branch,
      reused: false,
      ...retriedNote,
      ...(sha !== ""
        ? {
            base: {
              sha,
              fresh: fetchError === null,
              ...(fetchError !== null ? { fetch_error: fetchError } : {}),
            },
          }
        : {}),
    };
  }

  /** Append `EXCLUDE_LINES` to the box repo's shared `info/exclude`, each at most once. */
  private async excludeVolleyFiles(repo: string): Promise<void> {
    const r = await this.run([{ argv: ["git", "-C", repo, "rev-parse", "--git-common-dir"] }]);
    if (r.code !== 0) return;
    const common = r.stdout.trim();
    const file = posix.join(
      posix.isAbsolute(common) ? common : posix.join(repo, common),
      "info",
      "exclude",
    );
    const have = await this.run([{ argv: ["cat", file] }]);
    const text = have.code === 0 ? have.stdout : "";
    const lines = new Set(text.split("\n").map((l) => l.trim()));
    const missing = EXCLUDE_LINES.filter((l) => !lines.has(l));
    if (missing.length === 0) return;
    const sep = text === "" || text.endsWith("\n") ? "" : "\n";
    await this.runOrThrow(
      [
        { argv: ["mkdir", "-p", posix.dirname(file)] },
        {
          argv: ["base64", "-d"],
          stdin: b64(`${sep}# volleyd (agent worktrees)\n${missing.join("\n")}\n`),
          stdout: file,
          append: true,
        },
      ],
      `update ${file}`,
    );
  }

  async writeFile(path: string, content: string, mode?: number): Promise<void> {
    await this.runOrThrow(
      [
        { argv: ["mkdir", "-p", posix.dirname(path)] },
        { argv: ["base64", "-d"], stdin: b64(content), stdout: path },
        ...(mode !== undefined ? [{ argv: ["chmod", mode.toString(8), path] }] : []),
      ],
      `write ${path}`,
    );
  }

  /** The launch chain: each launch starts after the one before it settles. */
  private launches: Promise<unknown> = Promise.resolve();

  /** Open a tmux session. Serialized: one `new-session` in flight at a time on this host. */
  launch(spec: LaunchSpec): Promise<{ workspace: string }> {
    const run = this.launches.then(() => this.launchNow(spec));
    this.launches = run.catch(() => undefined);
    return run;
  }

  /**
   * A failed launch's `detail.outcome` is `unknown` when `new-session` was sent and ssh failed
   * (the command may have run), else `refused`; `detail.candidate` is the session name tried.
   */
  private async launchNow(spec: LaunchSpec): Promise<{ workspace: string }> {
    const fail = (msg: string, detail: Record<string, unknown> = {}) =>
      new SpawnError("LAUNCH_FAILED", msg, { host: this.name, outcome: "refused", ...detail });
    if (spec.command.trim() !== TMUX_LAUNCH_COMMAND) {
      throw fail(`a remote session runs only '${TMUX_LAUNCH_COMMAND}'`);
    }
    const session = await this.freeSession(sessionName(spec.name)).catch((e: unknown) => {
      throw fail(`tmux on ${this.spec.target}: ${e instanceof Error ? e.message : String(e)}`, {
        candidate: sessionName(spec.name),
      });
    });
    await this.syncTmuxPath();
    const r = await this.run(
      [{ argv: ["tmux", "new-session", "-d", "-s", session, "-c", spec.cwd, TMUX_LAUNCH_COMMAND] }],
      spec.launch !== undefined ? { launch: spec.launch } : {},
    ).catch((e: unknown) => {
      throw fail(`tmux new-session: ${e instanceof Error ? e.message : String(e)}`, {
        candidate: session,
        outcome: "unknown",
      });
    });
    if (r.code !== 0) {
      const lost = transportFailed(r);
      throw fail(
        `tmux new-session failed on ${this.spec.target}: ${lost && r.timedOut ? "timed out" : r.stderr.trim()}`,
        { exit: r.code, candidate: session, outcome: lost ? "unknown" : "refused" },
      );
    }
    return { workspace: session };
  }

  async findWorkspace(name: string, candidate?: string): Promise<string | null> {
    const session = candidate ?? sessionName(name);
    const r = await this.run([{ argv: ["tmux", "has-session", "-t", `=${session}`] }]);
    if (transportFailed(r)) throw this.sshFailed("has-session", r);
    return r.code === 0 ? session : null;
  }

  /**
   * Give the box's tmux server the PATH an ssh session gets there now (its login shell's, e.g.
   * from ~/.zshenv): a server started earlier keeps the PATH it started with, and its new
   * sessions inherit that, so a fixed PATH would not reach the agent. It may be the user's own
   * server (no -L: the default socket), so the ssh PATH goes first and every directory the
   * server already has stays, after it: nothing a working PATH had is dropped. Best effort, and
   * nothing to do with no server running: the server `new-session` starts gets the ssh PATH.
   */
  private async syncTmuxPath(): Promise<void> {
    const dirs = (path: string) => path.split(":").filter((d) => d.startsWith("/"));
    const r = await this.run([{ argv: ["printenv", "PATH"] }]).catch(() => null);
    const ssh = r?.code === 0 && !r.stdout.trim().includes("\n") ? dirs(r.stdout.trim()) : [];
    if (ssh.length === 0) return;
    const shown = await this.run([{ argv: ["tmux", "show-environment", "-g", "PATH"] }]).catch(
      () => null,
    );
    const line = shown?.code === 0 ? shown.stdout.trim() : "";
    // `PATH=<dirs>`; `-PATH` (removed) or anything else: the server has no PATH to keep.
    if (shown?.code !== 0 || line.includes("\n")) return;
    const server = line.startsWith("PATH=") ? dirs(line.slice(5)) : [];
    const merged = [...new Set([...ssh, ...server])];
    if (merged.length === server.length) return;
    await this.run([{ argv: ["tmux", "set-environment", "-g", "PATH", merged.join(":")] }]).catch(
      () => null,
    );
  }

  /**
   * `base`, or `base-2`, `base-3`, … — the first name no tmux session has. A fallback can equal
   * a later attempt's base (`w1-T1-role-2` is also attempt 2's `sessionName`); that is harmless,
   * since a reconcile looks up the exact candidate the launch tried, not the base.
   */
  private async freeSession(base: string): Promise<string> {
    for (let i = 1; i <= DAEMON_DEFAULTS.tmux_session_attempts; i++) {
      const name = i === 1 ? base : `${base}-${i}`;
      const r = await this.run([{ argv: ["tmux", "has-session", "-t", `=${name}`] }]);
      if (transportFailed(r)) throw this.sshFailed("has-session", r);
      if (r.code !== 0) return name;
    }
    throw new Error(`no free session name for ${base}`);
  }

  async readScreen(workspace: string, lines: number): Promise<string | null> {
    const r = await this.run([
      { argv: ["tmux", "capture-pane", "-p", "-t", pane(workspace), `-S-${lines}`] },
    ]).catch(() => null);
    if (r === null || r.code !== 0) return null;
    // capture-pane prints the whole pane, blank rows included: keep the last `lines` up to the
    // last row with text, like cmux read-screen --lines.
    const rows = r.stdout.split("\n");
    while (rows.length > 0 && (rows.at(-1) as string).trim() === "") rows.pop();
    return rows.slice(-lines).join("\n");
  }

  async sendKeys(workspace: string, key: string, tokens: TypedTextTokens = {}): Promise<void> {
    await this.run([{ argv: ["tmux", "send-keys", "-t", pane(workspace), key] }], tokens);
  }

  async sendText(workspace: string, text: string, tokens: TypedTextTokens = {}): Promise<void> {
    await this.run(
      [{ argv: ["tmux", "send-keys", "-t", pane(workspace), "-l", "--", text] }],
      tokens,
    );
  }

  async close(workspace: string, consent: ConsentToken): Promise<void> {
    await this.run([{ argv: ["tmux", "kill-session", "-t", `=${workspace}`] }], { consent });
  }

  /** `kill-session`: tmux ends the pane's process group, so no process is signalled here. */
  async endSession(
    workspace: string | null,
    _worktree: string | null,
    consent: ConsentToken,
  ): Promise<SessionEnd> {
    if (workspace === null) return { closed: false, pids: [], how: "none" };
    const closed = await this.run([{ argv: ["tmux", "kill-session", "-t", `=${workspace}`] }], {
      consent,
    }).then(
      (r) => r.code === 0 && !r.timedOut,
      () => false,
    );
    return { closed, pids: [], how: closed ? "kill-session" : "none" };
  }

  /** A transient refusal for an ssh failure: the spawn backs off, no decision is opened. */
  private sshFailed(what: string, r: ExecResult | null): SpawnError {
    const why = r === null ? "no result" : r.timedOut ? "timed out" : r.stderr.trim();
    return new SpawnError("LAUNCH_FAILED", `ssh to ${this.spec.target} failed (${what}): ${why}`, {
      host: this.name,
      target: this.spec.target,
    });
  }

  /** True when the box has a clone at `repo`, false when git says it has none. */
  async repoExists(): Promise<boolean> {
    const r = await this.run([
      { argv: ["git", "-C", this.spec.repo, "rev-parse", "--git-dir"] },
    ]).catch(() => null);
    if (r === null || transportFailed(r)) throw this.sshFailed("repo check", r);
    return r.code === 0;
  }

  async readFile(path: string): Promise<string | null> {
    const r = await this.run([{ argv: ["cat", path] }]).catch(() => null);
    if (r === null || transportFailed(r)) throw this.sshFailed(`read ${path}`, r);
    return r.code === 0 ? r.stdout : null;
  }

  async probePath(): Promise<PathProbe> {
    const r = await this.run([{ argv: ["command", "-v", ...PATH_TOOLS] }], {
      timeoutMs: DAEMON_DEFAULTS.path_probe_timeout_ms,
    }).catch(() => null);
    if (r === null || transportFailed(r)) throw this.sshFailed("PATH probe", r);
    // `command -v` exits 1 when a name is missing: what it printed is the answer either way.
    return parsePathProbe(r.stdout);
  }

  async runDoctor(opts: { fix: boolean; clone?: string }): Promise<DoctorReport> {
    const doctorRun = (dir: string[]) => {
      const argv = [
        "volley",
        "peer",
        "doctor",
        "--json",
        ...dir,
        ...(opts.fix ? ["--fix", "--yes"] : []),
        ...(opts.fix && opts.clone !== undefined ? ["--clone", "--origin", opts.clone] : []),
      ];
      // Through run, not exec: `volley` is otherwise a local program (LOCAL_PROGRAMS).
      return this.run([{ argv, cwd: this.spec.volley_dir }], {
        timeoutMs: DAEMON_DEFAULTS.peer_doctor_timeout_ms,
      }).catch(() => null);
    };
    // The box's volley_dir: every volley MCP entry there must run it (agents are launched from
    // it). A volley older than the flag refuses it: its doctor then runs without.
    let r = await doctorRun(["--supervisor-volley-dir", this.spec.volley_dir]);
    if (
      r !== null &&
      !transportFailed(r) &&
      parseDoctorReport(r.stdout) === null &&
      r.stderr.includes("--supervisor-volley-dir")
    ) {
      r = await doctorRun([]);
    }
    if (r === null || transportFailed(r)) throw this.sshFailed("volley peer doctor", r);
    // A failing block check exits 1 with the report on stdout.
    const report = parseDoctorReport(r.stdout);
    if (report === null) {
      throw new Error(
        `volley peer doctor on ${this.spec.target} printed no report: ${firstLine(r.stderr, `exit ${r.code}`)}`,
      );
    }
    return report;
  }

  /** The tunnel check: something listens on the box's `127.0.0.1:<remote_port>`. */
  async tunnelUp(): Promise<boolean> {
    const port = String(this.spec.tunnel.remote_port);
    const r = await this.run([{ argv: ["nc", "-z", "127.0.0.1", port] }], {
      timeoutMs: DAEMON_DEFAULTS.tunnel_check_timeout_ms,
    }).catch(() => null);
    return r?.code === 0 && !r.timedOut;
  }

  /**
   * The folder-trust entries of the box's `~/.claude.json` (Claude Code's trust dialog), and
   * nothing else from that file: `{ projects: { <dir>: { hasTrustDialogAccepted: true } } }`.
   * Null when it cannot be read.
   */
  async readTrust(): Promise<Record<string, unknown> | null> {
    const cfg = await this.readClaudeJson();
    if (cfg === null) return null;
    const projects: Record<string, { hasTrustDialogAccepted: true }> = {};
    const table = (cfg as { projects?: unknown } | null)?.projects;
    if (typeof table === "object" && table !== null) {
      for (const [dir, entry] of Object.entries(table)) {
        if (
          (entry as { hasTrustDialogAccepted?: unknown } | null)?.hasTrustDialogAccepted === true
        ) {
          projects[dir] = { hasTrustDialogAccepted: true };
        }
      }
    }
    return { projects };
  }

  /** The box's whole `~/.claude.json` and its text; null when absent or not a JSON object. */
  private async readClaudeJson(): Promise<Record<string, unknown> | null> {
    return (await this.readClaudeJsonText())?.cfg ?? null;
  }

  private async readClaudeJsonText(): Promise<{
    text: string;
    cfg: Record<string, unknown>;
  } | null> {
    // bash -s starts in the login user's home directory.
    const text = await this.readFile(REMOTE_CLAUDE_JSON);
    if (text === null) return null;
    try {
      const cfg = JSON.parse(text) as unknown;
      return typeof cfg === "object" && cfg !== null && !Array.isArray(cfg)
        ? { text, cfg: cfg as Record<string, unknown> }
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Set `projects[root].hasTrustDialogAccepted` in the box's `~/.claude.json`, changing nothing
   * else, like the local recordRepoTrust: read it, write the new file beside it, and swap it in
   * only if the file is still what was read (`cmp`, then `mv`, in one script). Claude Code
   * rewrites the file often, so a changed file is re-read and the write retried. Called only on
   * the owner's explicit `trust` answer.
   */
  async recordTrust(root: string): Promise<void> {
    for (let i = 0; i < DAEMON_DEFAULTS.trust_write_attempts; i++) {
      const cur = await this.readClaudeJsonText();
      if (cur === null) {
        throw new Error(
          `no readable ~/.claude.json on ${this.spec.target}: run claude there once, then retry`,
        );
      }
      const next = `${JSON.stringify(withTrust(cur.cfg, root), null, 2)}\n`;
      const r = await this.run([
        { argv: ["cmp", "-s", "-", REMOTE_CLAUDE_JSON], stdin: b64(cur.text) },
        { argv: ["base64", "-d"], stdin: b64(next), stdout: REMOTE_CLAUDE_JSON_TMP },
        { argv: ["mv", "-f", REMOTE_CLAUDE_JSON_TMP, REMOTE_CLAUDE_JSON] },
      ]).catch(() => null);
      if (r === null || transportFailed(r)) throw this.sshFailed("trust write", r);
      if (r.code === 0) return;
    }
    throw new Error(`~/.claude.json on ${this.spec.target} kept changing; trust not recorded`);
  }
}

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");

/** `<wave> <task> <role>` → `<wave>-<task>-<role>`; tmux forbids `.` and `:` in session names. */
export function sessionName(title: string): string {
  return title.trim().replace(/[^A-Za-z0-9_-]+/g, "-");
}

/** The session's current pane, matched exactly (`=` stops tmux's prefix matching). */
const pane = (session: string) => `=${session}:`;

/** A full commit id (what a reviewer or fixup starts from), not a branch name. */
function isCommitSha(ref: string): boolean {
  return /^[0-9a-f]{40}$/.test(ref);
}
