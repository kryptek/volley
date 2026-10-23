import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { type ProfileKeys, onboardingEdits } from "../claude/sharing";
import { CONFIG_DEFAULTS, DAEMON_DEFAULTS, REMOTE_HOST_DEFAULTS } from "../config-defaults";
import type { ExecFn, ExecOptions, ExecResult } from "../exec";
import {
  type ConsentToken,
  FenceError,
  REMOTE_CLAUDE_JSON,
  REMOTE_CLAUDE_JSON_TMP,
  REMOTE_SETTINGS_JSON,
  REMOTE_SETTINGS_JSON_TMP,
  type RemoteStep,
  TMUX_LAUNCH_COMMAND,
  TMUX_SIZE,
} from "../fence";
import { fetchFailure, lockedFetch } from "../git-lock";
import { type DoctorReport, parseDoctorReport } from "../machines";
import { PATH_TOOLS, type PathProbe, parsePathProbe } from "../readiness";
import { type MachineFacts, cloneSource, managedWorktreeRoot } from "../repos";
import { SpawnError } from "../spawn-error";
import { withTrust } from "../trust";
import type { RemoteHostConfig, Tunables } from "../types";
import { EXCLUDE_LINES, firstLine, freshBaseFix } from "../worktree";
import type {
  Host,
  LaunchSpec,
  SessionEnd,
  TermSize,
  TypedTextTokens,
  WorktreeResult,
  WorktreeSpec,
} from "./host";

/**
 * A remote host with every key resolved (config `hosts.<name>` ← the task's inline `host:`), for
 * one repository: `slug` and its clone (`repo`) and worktree root there. A repo-less spec (the
 * doctor, sign-in) has none of the three.
 */
export interface RemoteHostSpec {
  name: string;
  target: string;
  /** The repository's GitHub `owner/name`; absent for a legacy (non-GitHub) or repo-less spec. */
  slug?: string;
  repo?: string;
  worktree_root?: string;
  volley_dir: string;
  tunnel: { remote_port: number; supervise: boolean };
}

/** A spec for one repository: its clone and worktree root are always resolved. */
export type RepoHostSpec = RemoteHostSpec & { repo: string; worktree_root: string };

/** What resolving a host's clone of one repository reads (config `repos`, `fleet.repo_root`). */
export interface SlugTarget extends MachineFacts {
  slug: string;
  repos: Tunables["repos"];
  repo_root: string;
}

/**
 * Which clone a spec resolves: one repository's (`SlugTarget`), the host's own `repo` (`legacy`:
 * a wave whose repository is not on GitHub) or none (`none`: the doctor and sign-in paths).
 */
export type RepoTarget = SlugTarget | "legacy" | "none";

const missingOf = (h: RemoteHostConfig, keys: readonly ("target" | "repo" | "volley_dir")[]) =>
  keys.filter((k) => h[k] === undefined);

/**
 * Resolve a task's host: the config entry `hosts.<name>`, with the task's inline `host:` layered
 * over it, and defaults for the rest; its clone and worktree root for `repo` (a slug's, by
 * `cloneSource`; an inline `repo` wins). Throws LAUNCH_FAILED naming what is missing.
 */
export function resolveRemoteHost(
  name: string,
  inline: (RemoteHostConfig & { name?: string }) | undefined,
  configured: Record<string, RemoteHostConfig>,
  repo?: SlugTarget | "legacy",
): RepoHostSpec;
export function resolveRemoteHost(
  name: string,
  inline: (RemoteHostConfig & { name?: string }) | undefined,
  configured: Record<string, RemoteHostConfig>,
  repo: RepoTarget,
): RemoteHostSpec;
export function resolveRemoteHost(
  name: string,
  inline: (RemoteHostConfig & { name?: string }) | undefined,
  configured: Record<string, RemoteHostConfig>,
  repo: RepoTarget = "legacy",
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
  const missing = missingOf(
    h,
    repo === "legacy" ? ["target", "repo", "volley_dir"] : ["target", "volley_dir"],
  );
  if (missing.length > 0) {
    throw new SpawnError("LAUNCH_FAILED", `host '${name}' has no ${missing.join(", ")}`, {
      host: name,
      missing,
    });
  }
  const spec: RemoteHostSpec = {
    name,
    target: h.target as string,
    volley_dir: h.volley_dir as string,
    tunnel: {
      remote_port: h.tunnel?.remote_port ?? REMOTE_HOST_DEFAULTS.remote_port,
      supervise: h.tunnel?.supervise ?? REMOTE_HOST_DEFAULTS.supervise_tunnel,
    },
  };
  if (repo === "none") return spec;
  // A legacy spec (and an inline `repo`) is the host's own clone; any other is a slug's.
  const slug = repo === "legacy" ? undefined : repo.slug;
  const clone =
    repo === "legacy" || over.repo !== undefined
      ? { path: h.repo as string, kind: "legacy" as const, slug }
      : cloneSource(
          {
            repos: repo.repos,
            fleet: { repo_root: repo.repo_root },
            hosts: {
              [name]: {
                ...(base?.repo !== undefined ? { repo: base.repo } : {}),
                ...(h.repos !== undefined ? { repos: h.repos } : {}),
              },
            },
          },
          name,
          repo.slug,
          repo,
        );
  if (clone === undefined) {
    throw new SpawnError(
      "LAUNCH_FAILED",
      `host '${name}' has no clone of ${slug}: add it (Settings → Repositories, or volley repo add ${slug} --machine ${name})`,
      { host: name, slug },
    );
  }
  // A legacy clone keeps its worktrees beside it; any other is under the repository's managed root.
  const worktree_root =
    h.worktree_root ??
    (clone.kind === "legacy" || clone.slug === undefined
      ? posix.join(posix.dirname(clone.path), REMOTE_HOST_DEFAULTS.worktree_dir)
      : managedWorktreeRoot(repo === "legacy" ? undefined : repo.home, clone.slug));
  // Only a managed path can still hold a `~` (an unknown home); config paths are absolute.
  for (const p of [clone.path, worktree_root]) {
    if (!p.startsWith("/")) {
      throw new SpawnError(
        "LAUNCH_FAILED",
        `host '${name}': ${p} needs the machine's home directory, which is not known yet; set hosts.${name}.repos.${slug} and hosts.${name}.worktree_root to absolute paths`,
        { host: name, slug, path: p },
      );
    }
  }
  return {
    ...spec,
    ...(slug !== undefined ? { slug } : {}),
    repo: clone.path,
    worktree_root,
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
  /**
   * The box's folder trust (or, with `configDir`, that profile's there); null when it has no
   * readable `.claude.json`; throws if ssh fails.
   */
  readTrust(configDir?: string): Promise<Record<string, unknown> | null>;
  /** The owner's `trust` answer, recorded in the box's own `~/.claude.json` (or the profile's). */
  recordTrust(root: string, configDir?: string): Promise<void>;
  /**
   * Make a profile the supervisor created on the box ready to run agents unattended (#400): its
   * onboarding keys and bypass consent (claude/sharing.ts onboardingEdits). Returns the keys it
   * wrote, per file; throws if ssh fails or the profile has no readable `.claude.json`.
   */
  seedProfile(configDir: string, claudeVersion?: string): Promise<ProfileKeys>;
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

/** A remote host resolved for one repository (`resolveRemoteHost` with a slug, or legacy). */
export type RepoRemoteHost = RemoteHost & { readonly spec: RepoHostSpec };

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
        remote: {
          steps,
          // A repo-less spec (doctor, sign-in) has no worktree root: no profile passes the check.
          host: { name: this.spec.name, worktree_root: this.spec.worktree_root ?? "" },
        },
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
    // Detached, tmux would size it 80×24 (its default-size) and nothing would ever widen it.
    const size = tmuxSize(spec.size ?? DEFAULT_SIZE);
    const r = await this.run(
      [
        {
          argv: [
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
        },
      ],
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
    this.launchSizes.set(session, size);
    return { workspace: session };
  }

  /** Each session's size at launch, what `resize(…, "launch")` returns it to. */
  private readonly launchSizes = new Map<string, TermSize>();

  /**
   * `tmux resize-window`: Claude Code re-wraps on the SIGWINCH. A session launched before a
   * daemon restart goes back to the default launch size.
   */
  async resize(workspace: string, size: TermSize | "launch"): Promise<boolean> {
    const to =
      size === "launch"
        ? (this.launchSizes.get(workspace) ?? tmuxSize(DEFAULT_SIZE))
        : tmuxSize(size);
    const r = await this.run([
      { argv: ["tmux", "resize-window", "-t", pane(workspace), ...sizeArgs(to)] },
    ]);
    if (r.code !== 0) {
      throw new Error(
        `tmux resize-window on ${this.spec.target}: ${r.timedOut ? "timed out" : r.stderr.trim()}`,
      );
    }
    return true;
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
    const r = await this.run([{ argv: ["printenv", "PATH"] }]).catch(this.noResult("PATH sync"));
    const ssh = r?.code === 0 && !r.stdout.trim().includes("\n") ? dirs(r.stdout.trim()) : [];
    if (ssh.length === 0) return;
    const shown = await this.run([{ argv: ["tmux", "show-environment", "-g", "PATH"] }]).catch(
      this.noResult("PATH sync"),
    );
    const line = shown?.code === 0 ? shown.stdout.trim() : "";
    // `PATH=<dirs>`; `-PATH` (removed) or anything else: the server has no PATH to keep.
    if (shown?.code !== 0 || line.includes("\n")) return;
    const server = line.startsWith("PATH=") ? dirs(line.slice(5)) : [];
    const merged = [...new Set([...ssh, ...server])];
    if (merged.length === server.length) return;
    await this.run([{ argv: ["tmux", "set-environment", "-g", "PATH", merged.join(":")] }]).catch(
      this.noResult("PATH sync"),
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
    ]).catch(this.noResult("read-screen"));
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
    this.launchSizes.delete(workspace);
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
    if (closed) this.launchSizes.delete(workspace);
    return { closed, pids: [], how: closed ? "kill-session" : "none" };
  }

  /**
   * A rejected `run` (the step `what`) as no result, which each caller treats as it treats an
   * ssh failure (a spawn step reports it through sshFailed and is retried; a best-effort check
   * gives up) — except a fence denial, rethrown as a permanent FENCE_DENIED SpawnError: a step
   * the fence refuses is refused on every retry, so it names the denied step, never "no result".
   */
  private noResult(what: string): (e: unknown) => null {
    return (e) => {
      if (e instanceof FenceError) {
        throw new SpawnError(
          "FENCE_DENIED",
          `${e.message.slice(`${e.code}: `.length)} (${what} on ${this.spec.target})`,
          { host: this.name, target: this.spec.target, verb: e.verb },
          { permanent: true },
        );
      }
      return null;
    };
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
    const repo = this.spec.repo;
    if (repo === undefined) {
      throw new SpawnError("LAUNCH_FAILED", `host '${this.name}': no repository to check`, {
        host: this.name,
      });
    }
    const r = await this.run([{ argv: ["git", "-C", repo, "rev-parse", "--git-dir"] }]).catch(
      this.noResult("repo check"),
    );
    if (r === null || transportFailed(r)) throw this.sshFailed("repo check", r);
    return r.code === 0;
  }

  async readFile(path: string): Promise<string | null> {
    const r = await this.run([{ argv: ["cat", path] }]).catch(this.noResult(`read ${path}`));
    if (r === null || transportFailed(r)) throw this.sshFailed(`read ${path}`, r);
    return r.code === 0 ? r.stdout : null;
  }

  async probePath(): Promise<PathProbe> {
    const r = await this.run([{ argv: ["command", "-v", ...PATH_TOOLS] }], {
      timeoutMs: DAEMON_DEFAULTS.path_probe_timeout_ms,
    }).catch(this.noResult("PATH probe"));
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
      }).catch(this.noResult("doctor"));
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

  /**
   * The tunnel check: something listens on the box's `127.0.0.1:<remote_port>`. False when ssh
   * fails; rejects with FENCE_DENIED only if the fence ever refuses the `nc -z` step.
   */
  async tunnelUp(): Promise<boolean> {
    const port = String(this.spec.tunnel.remote_port);
    const r = await this.run([{ argv: ["nc", "-z", "127.0.0.1", port] }], {
      timeoutMs: DAEMON_DEFAULTS.tunnel_check_timeout_ms,
    }).catch(this.noResult("tunnel check"));
    return r?.code === 0 && !r.timedOut;
  }

  /**
   * The folder-trust entries of the box's `~/.claude.json` (Claude Code's trust dialog), and
   * nothing else from that file: `{ projects: { <dir>: { hasTrustDialogAccepted: true } } }`.
   * Null when it cannot be read.
   */
  async readTrust(configDir?: string): Promise<Record<string, unknown> | null> {
    const cfg = (await this.readClaudeJsonText(configDir))?.cfg ?? null;
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

  /**
   * The box's whole `~/.claude.json` (or a profile's, in `configDir`) and its text; null when
   * absent or not a JSON object.
   */
  private async readClaudeJsonText(configDir?: string): Promise<{
    text: string;
    cfg: Record<string, unknown>;
  } | null> {
    // bash -s starts in the login user's home directory; a profile's is read in its own dir.
    const text =
      configDir === undefined
        ? await this.readFile(REMOTE_CLAUDE_JSON)
        : await this.run([{ argv: ["cat", REMOTE_CLAUDE_JSON], cwd: configDir }])
            .catch(this.noResult(`read ${configDir}`))
            .then((r) => {
              if (r === null || transportFailed(r)) throw this.sshFailed(`read ${configDir}`, r);
              return r.code === 0 ? r.stdout : null;
            });
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
  async recordTrust(root: string, configDir?: string): Promise<void> {
    // A profile's files by absolute path: a write step does not run in a cwd.
    const json =
      configDir !== undefined ? posix.join(configDir, REMOTE_CLAUDE_JSON) : REMOTE_CLAUDE_JSON;
    const tmp =
      configDir !== undefined
        ? posix.join(configDir, REMOTE_CLAUDE_JSON_TMP)
        : REMOTE_CLAUDE_JSON_TMP;
    for (let i = 0; i < DAEMON_DEFAULTS.trust_write_attempts; i++) {
      const cur = await this.readClaudeJsonText(configDir);
      if (cur === null) {
        throw new Error(
          `no readable ${configDir !== undefined ? json : "~/.claude.json"} on ${this.spec.target}: run claude there once, then retry`,
        );
      }
      const next = `${JSON.stringify(withTrust(cur.cfg, root), null, 2)}\n`;
      const r = await this.run([
        { argv: ["cmp", "-s", "-", json], stdin: b64(cur.text) },
        { argv: ["base64", "-d"], stdin: b64(next), stdout: tmp },
        { argv: ["mv", "-f", tmp, json] },
      ]).catch(this.noResult("trust write"));
      if (r === null || transportFailed(r)) throw this.sshFailed("trust write", r);
      if (r.code === 0) return;
    }
    throw new Error(`~/.claude.json on ${this.spec.target} kept changing; trust not recorded`);
  }

  /**
   * RemoteHost.seedProfile: the profile's `.claude.json` and `settings.json`, each by
   * compare-and-swap. The version is the box's own (its default profile's
   * `lastOnboardingVersion`), else `claudeVersion` (the supervisor's).
   */
  async seedProfile(configDir: string, claudeVersion?: string): Promise<ProfileKeys> {
    const settingsPath = posix.join(configDir, REMOTE_SETTINGS_JSON);
    const readSettings = async (): Promise<{
      text: string | null;
      cfg: Record<string, unknown>;
    }> => {
      const r = await this.run([{ argv: ["cat", settingsPath] }]).catch(
        this.noResult(`read ${settingsPath}`),
      );
      if (r === null || transportFailed(r)) throw this.sshFailed(`read ${settingsPath}`, r);
      if (r.code !== 0) return { text: null, cfg: {} };
      try {
        const cfg = JSON.parse(r.stdout) as unknown;
        if (typeof cfg === "object" && cfg !== null && !Array.isArray(cfg))
          return { text: r.stdout, cfg: cfg as Record<string, unknown> };
      } catch {}
      // Not a JSON object: Claude Code would not read it either; left to the owner.
      throw new Error(`${settingsPath} on ${this.spec.target} is not a JSON object`);
    };
    // The box's own Claude Code version, as its default profile recorded it; else the caller's.
    const own = (await this.readClaudeJsonText().catch(() => null))?.cfg.lastOnboardingVersion;
    const version = typeof own === "string" && own !== "" ? own : claudeVersion;
    const keys: ProfileKeys = { ".claude.json": [], "settings.json": [] };
    keys[".claude.json"] = await this.swap(
      posix.join(configDir, REMOTE_CLAUDE_JSON),
      posix.join(configDir, REMOTE_CLAUDE_JSON_TMP),
      async () => {
        const cur = await this.readClaudeJsonText(configDir);
        if (cur === null)
          throw new Error(
            `no readable ${posix.join(configDir, REMOTE_CLAUDE_JSON)} on ${this.spec.target}: sign the account in first`,
          );
        const e = onboardingEdits(cur.cfg, {}, version);
        return { text: cur.text, next: e.claudeJson, keys: e.keys[".claude.json"] };
      },
    );
    keys["settings.json"] = await this.swap(
      settingsPath,
      posix.join(configDir, REMOTE_SETTINGS_JSON_TMP),
      async () => {
        const cur = await readSettings();
        const e = onboardingEdits({}, cur.cfg);
        return { text: cur.text, next: e.settings, keys: e.keys["settings.json"] };
      },
    );
    return keys;
  }

  /**
   * Compare-and-swap one profile file (recordTrust's way): `read` it, write `next` beside it and
   * `mv` it in only if the file is still what was read; a file that changed is re-read and the
   * write retried. A file that did not exist (`text` null) is written whole. Returns the keys
   * written; nothing to write, nothing is run.
   */
  private async swap(
    path: string,
    tmp: string,
    read: () => Promise<{ text: string | null; next: Record<string, unknown>; keys: string[] }>,
  ): Promise<string[]> {
    for (let i = 0; i < DAEMON_DEFAULTS.trust_write_attempts; i++) {
      const cur = await read();
      if (cur.keys.length === 0) return [];
      const r = await this.run([
        ...(cur.text !== null ? [{ argv: ["cmp", "-s", "-", path], stdin: b64(cur.text) }] : []),
        {
          argv: ["base64", "-d"],
          stdin: b64(`${JSON.stringify(cur.next, null, 2)}\n`),
          stdout: tmp,
        },
        { argv: ["mv", "-f", tmp, path] },
      ]).catch(this.noResult(`write ${path}`));
      if (r === null || transportFailed(r)) throw this.sshFailed(`write ${path}`, r);
      if (r.code === 0) return cur.keys;
    }
    throw new Error(`${path} on ${this.spec.target} kept changing; not written`);
  }
}

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");

/** `<wave> <task> <role>` → `<wave>-<task>-<role>`; tmux forbids `.` and `:` in session names. */
export function sessionName(title: string): string {
  return title.trim().replace(/[^A-Za-z0-9_-]+/g, "-");
}

/** The session's current pane, matched exactly (`=` stops tmux's prefix matching). */
const pane = (session: string) => `=${session}:`;

/** A session's size when the spawn names none (the tunables' defaults). */
const DEFAULT_SIZE: TermSize = { cols: CONFIG_DEFAULTS.tmux_cols, rows: CONFIG_DEFAULTS.tmux_rows };

/** `size` in whole cells, inside the fence's bounds. */
function tmuxSize(size: TermSize): TermSize {
  const fit = (n: number) => Math.max(TMUX_SIZE.min, Math.min(TMUX_SIZE.max, Math.round(n)));
  return { cols: fit(size.cols), rows: fit(size.rows) };
}

const sizeArgs = (s: TermSize) => ["-x", String(s.cols), "-y", String(s.rows)];

/** A full commit id (what a reviewer or fixup starts from), not a branch name. */
function isCommitSha(ref: string): boolean {
  return /^[0-9a-f]{40}$/.test(ref);
}
