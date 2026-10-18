import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { DAEMON_DEFAULTS, REMOTE_HOST_DEFAULTS } from "../config-defaults";
import type { ExecFn, ExecOptions, ExecResult } from "../exec";
import { type ConsentToken, type RemoteStep, TMUX_LAUNCH_COMMAND } from "../fence";
import { SpawnError } from "../spawn-error";
import type { RemoteHostConfig } from "../types";
import { EXCLUDE_LINES } from "../worktree";
import type { Host, LaunchSpec, WorktreeResult, WorktreeSpec } from "./host";

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
  /** `$VOLLEY_HOOKS_DIR` on the box. */
  readonly hooksDir: string;
  /** The broker URL agents on the box use (the tunnel's remote end). */
  readonly brokerUrl: string;
  repoExists(): Promise<boolean>;
  tunnelUp(): Promise<boolean>;
  readTrust(): Promise<Record<string, unknown> | null>;
}

/** Programs that act on the daemon's own machine (the broker's credentials), never the box. */
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
  run(
    steps: RemoteStep[],
    opts: Pick<ExecOptions, "consent" | "timeoutMs"> = {},
  ): Promise<ExecResult> {
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
    const fetch = await git("-C", spec.repo, "fetch", "--quiet", "origin", spec.base);
    if (fetch.code !== 0) {
      throw new SpawnError(
        "WORKTREE_FAILED",
        `git fetch origin ${spec.base} failed on ${this.spec.target}: ${fetch.stderr.trim()}`,
        {
          host: this.name,
          repo: spec.repo,
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
    return { path: spec.path, branch: spec.branch, reused: false };
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

  async launch(spec: LaunchSpec): Promise<{ workspace: string }> {
    const fail = (msg: string, detail: Record<string, unknown> = {}) =>
      new SpawnError("LAUNCH_FAILED", msg, { host: this.name, ...detail });
    if (spec.command.trim() !== TMUX_LAUNCH_COMMAND) {
      throw fail(`a remote session runs only '${TMUX_LAUNCH_COMMAND}'`);
    }
    const session = await this.freeSession(sessionName(spec.name)).catch((e: unknown) => {
      throw fail(`tmux on ${this.spec.target}: ${e instanceof Error ? e.message : String(e)}`);
    });
    const r = await this.run([
      {
        argv: ["tmux", "new-session", "-d", "-s", session, "-c", spec.cwd, TMUX_LAUNCH_COMMAND],
      },
    ]).catch((e: unknown) => {
      throw fail(`tmux new-session: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (r.code !== 0) {
      throw fail(`tmux new-session failed on ${this.spec.target}: ${r.stderr.trim()}`, {
        exit: r.code,
      });
    }
    return { workspace: session };
  }

  /** `base`, or `base-2`, `base-3`, … — the first name no tmux session has. */
  private async freeSession(base: string): Promise<string> {
    for (let i = 1; i <= DAEMON_DEFAULTS.tmux_session_attempts; i++) {
      const name = i === 1 ? base : `${base}-${i}`;
      const r = await this.run([{ argv: ["tmux", "has-session", "-t", `=${name}`] }]);
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

  async sendKeys(workspace: string, key: string): Promise<void> {
    await this.run([{ argv: ["tmux", "send-keys", "-t", pane(workspace), key] }]);
  }

  async sendText(workspace: string, text: string): Promise<void> {
    await this.run([{ argv: ["tmux", "send-keys", "-t", pane(workspace), "-l", "--", text] }]);
  }

  async close(workspace: string, consent: ConsentToken): Promise<void> {
    await this.run([{ argv: ["tmux", "kill-session", "-t", `=${workspace}`] }], { consent });
  }

  /** True when the box has a clone at `repo`. */
  async repoExists(): Promise<boolean> {
    const r = await this.run([
      { argv: ["git", "-C", this.spec.repo, "rev-parse", "--git-dir"] },
    ]).catch(() => null);
    return r?.code === 0;
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
    // bash -s starts in the login user's home directory.
    const r = await this.run([{ argv: ["cat", ".claude.json"] }]).catch(() => null);
    if (r === null || r.code !== 0) return null;
    let cfg: unknown;
    try {
      cfg = JSON.parse(r.stdout);
    } catch {
      return null;
    }
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
}

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");

/** `<wave> <task> <role>` → `<wave>-<task>-<role>`; tmux forbids `.` and `:` in session names. */
export function sessionName(title: string): string {
  return title.trim().replace(/[^A-Za-z0-9_-]+/g, "-");
}

/** The session's current pane, matched exactly (`=` stops tmux's prefix matching). */
const pane = (session: string) => `=${session}:`;
