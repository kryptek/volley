import { classifyRex, rexAdvice, rexSaid } from "volley-cli/setup/terminal";
import { DAEMON_DEFAULTS } from "../config-defaults";
import type { ExecFn, ExecOptions, ExecResult } from "../exec";
import {
  type ConsentToken,
  FenceError,
  REX_GLOBAL,
  REX_SCREEN_FORMAT,
  REX_SCREEN_MAX_BYTES,
  TMUX_LAUNCH_COMMAND,
} from "../fence";
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
import { localSessionName } from "./local-tmux";
import { DEFAULT_SIZE, tmuxSize } from "./ssh-tmux";

/** A Rex session's id, the workspace ref (what `rex ls` shows and every rex command takes). */
const SESSION_ID = /^session:[0-9a-f-]{36}$/;
const BLOCK_ID = /^block:[0-9a-f-]{36}$/;

/** The block an agent runs in: the one Rex's terminal created (`session inspect`). */
const TERMINAL_CREATOR = "com.superlogical.terminal";

/**
 * The Host's key names in Rex's key-binding syntax (`rex keymap`). `space` is Rex's name for the
 * space bar in that syntax, as `enter`, `esc`, `up` and `down` are.
 */
const REX_KEYS: Record<string, string> = {
  Enter: "enter",
  Escape: "esc",
  Up: "up",
  Down: "down",
  Space: "space",
};

/** exec spawns without a shell, so a missing rex rejects with ENOENT rather than exiting 127. */
const isNotFound = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code === "ENOENT";

/** Rex's answer to a kill of a session that is not there (exit 3). */
const GONE = /not found/i;

/**
 * The local host under `fleet.local_terminal: rex`: worktrees on this machine, each agent in a
 * Rex session labelled `volley-<wave>-<task>-<role>` whose one block runs the sealed launch
 * script, so `rex ls` and the Rex app show it. Rex labels are not unique (and `rex` refuses an
 * ambiguous label), so every command but `new` targets the session's id and its block's id: the
 * workspace ref is `session:<uuid>`, the block id is cached (and resolved through `session
 * inspect` for a session this process did not launch). Every call passes `--autostart=false`: a
 * missing Rex server is the owner's to start. Every command goes through the fenced `exec`,
 * whose rex rules admit exactly these shapes, and killing a session needs a consent token
 * (`cleanup --yes`, or a retire for its agent's own session).
 */
export class LocalRexHost implements Host {
  readonly name = "local";
  readonly screenSource = "rex";
  constructor(
    readonly exec: ExecFn,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  /** `exec` for `rex <REX_GLOBAL> <args>`. */
  private rex(args: readonly string[], opts: ExecOptions = {}): Promise<ExecResult> {
    return this.exec(["rex", ...REX_GLOBAL, ...args], opts);
  }

  prepareWorktree(spec: WorktreeSpec): Promise<WorktreeResult> {
    return addWorktree(this.exec, spec);
  }

  writeFile(path: string, content: string, mode?: number): Promise<void> {
    return writeLocalFile(path, content, mode);
  }

  /** Each session's block (the one its agent runs in). */
  private readonly blocks = new Map<string, string>();
  /** Each session's size at launch, what `resize(…, "launch")` returns it to. */
  private readonly launchSizes = new Map<string, TermSize>();

  /** The launch chain: each launch starts after the one before it settles. */
  private launches: Promise<unknown> = Promise.resolve();

  /** Open a Rex session. Serialized: one `rex new` in flight at a time. */
  launch(spec: LaunchSpec): Promise<{ workspace: string }> {
    const run = this.launches.then(() => this.launchNow(spec));
    this.launches = run.catch(() => undefined);
    return run;
  }

  /**
   * A failed launch's `detail.outcome`: `refused` when nothing was created (no `rex`, no Rex
   * server, the fence, the label lookup before `new`), `unknown` when `new` may have created the
   * session (a timeout, an exit volleyd does not recognise, an answer with no session id):
   * spawn.ts reconciles through `findWorkspace` with `detail.candidate`, the label tried.
   */
  private async launchNow(spec: LaunchSpec): Promise<{ workspace: string }> {
    const fail = (msg: string, detail: Record<string, unknown> = {}) =>
      new SpawnError("LAUNCH_FAILED", msg, { outcome: "refused", ...detail });
    // The coordinator role (SPEC §4.6.25) runs in tmux on every machine.
    if (spec.coordinator !== undefined)
      throw fail("the coordinator runs in tmux on every machine, never in a Rex session");
    if (spec.command.trim() !== TMUX_LAUNCH_COMMAND)
      throw fail(`a Rex session runs only '${TMUX_LAUNCH_COMMAND}'`);
    const base = localSessionName(spec.name);
    const label = await this.freeLabel(base).catch((e: unknown) => {
      throw fail(`volleyd cannot open a Rex session: ${this.why(e)}`, { candidate: base });
    });
    const r = await this.rex(
      ["new", label, "-c", spec.cwd, "--json", "--", ...TMUX_LAUNCH_COMMAND.split(" ")],
      {
        timeoutMs: DAEMON_DEFAULTS.launch_timeout_ms,
        ...(spec.launch !== undefined ? { launch: spec.launch } : {}),
      },
    ).catch((e: unknown) => {
      if (isNotFound(e))
        throw fail(`volleyd cannot open a Rex session. ${this.advice("missing")}`, {
          candidate: label,
        });
      throw fail(`rex new: ${e instanceof Error ? e.message : String(e)}`, {
        candidate: label,
        // The fence refusing it means nothing ran; anything else may have started Rex.
        outcome: e instanceof FenceError ? "refused" : "unknown",
      });
    });
    if (r.timedOut)
      throw fail("rex new failed: timed out", { candidate: label, outcome: "unknown" });
    if (r.code !== 0) {
      const access = classifyRex(r);
      const refused = access === "not_running" || access === "missing";
      throw fail(
        refused
          ? `volleyd cannot open a Rex session. ${this.advice(access)}${rexSaid(r.stderr || r.stdout)}`
          : `rex new failed: exit ${r.code}${rexSaid(r.stderr || r.stdout)}`,
        {
          exit: r.code,
          rex: r.stderr.trim(),
          candidate: label,
          outcome: refused ? "refused" : "unknown",
        },
      );
    }
    const made = parseRexNew(r.stdout);
    if (made === null)
      throw fail(`rex new answered no session id${rexSaid(r.stdout)}`, {
        stdout: r.stdout.trim(),
        candidate: label,
        outcome: "unknown",
      });
    if (made.block !== null) this.blocks.set(made.session, made.block);
    // Rex sizes a new block 80×24; an agent nobody watches renders at the configured width.
    const size = tmuxSize(spec.size ?? DEFAULT_SIZE);
    this.launchSizes.set(made.session, size);
    await this.requestSize(made.session, size).catch(() => undefined);
    return { workspace: made.session };
  }

  /** The advice for an access problem, with the PATH volleyd looked on for a missing `rex`. */
  private advice(access: Parameters<typeof rexAdvice>[0]): string {
    return rexAdvice(access, this.env.PATH);
  }

  /** Why a lookup failed, in the owner's words where Rex's answer says how to fix it. */
  private why(e: unknown): string {
    if (isNotFound(e)) return this.advice("missing");
    return e instanceof Error ? e.message : String(e);
  }

  /** `base`, or `base-2`, `base-3`, … — the first label no Rex session has. */
  private async freeLabel(base: string): Promise<string> {
    const taken = new Set((await this.sessions()).map((s) => s.label));
    for (let i = 1; i <= DAEMON_DEFAULTS.tmux_session_attempts; i++) {
      const name = i === 1 ? base : `${base}-${i}`;
      if (!taken.has(name)) return name;
    }
    throw new Error(`no free session label for ${base}`);
  }

  /** `rex ls --json`; rejects when Rex cannot answer (no server, no rex, a timeout). */
  private async sessions(): Promise<RexSession[]> {
    const r = await this.rex(["ls", "--json"], {
      timeoutMs: DAEMON_DEFAULTS.workspace_lookup_timeout_ms,
    }).catch((e: unknown) => {
      throw isNotFound(e) ? new Error(this.advice("missing")) : e;
    });
    if (r.timedOut) throw new Error("rex ls failed: timed out");
    if (r.code !== 0) {
      const access = classifyRex(r);
      throw new Error(
        access === "not_running" || access === "missing"
          ? `${this.advice(access)}${rexSaid(r.stderr || r.stdout)}`
          : `rex ls failed: exit ${r.code}${rexSaid(r.stderr || r.stdout)}`,
      );
    }
    const list = parseRexSessions(r.stdout);
    if (list === null) throw new Error(`rex ls answered no session list${rexSaid(r.stdout)}`);
    return list;
  }

  /**
   * The id of the one session labelled `candidate` (the label a failed launch tried) or
   * `volley-<wave>-<task>-<role>`; null when none is, and a throw when more than one is (which
   * one a launch opened cannot be told).
   */
  async findWorkspace(name: string, candidate?: string): Promise<string | null> {
    const want = candidate ?? localSessionName(name);
    const ids = (await this.sessions()).filter((s) => s.label === want).map((s) => s.session_id);
    if (ids.length > 1)
      throw new Error(`${ids.length} Rex sessions are labelled "${want}": ${ids.join(", ")}`);
    return ids[0] ?? null;
  }

  /** The session's agent block: cached, else resolved once through `session inspect`. */
  private async blockOf(session: string, timeoutMs: number): Promise<string> {
    if (!SESSION_ID.test(session)) throw new Error(`${session} is not a Rex session id`);
    const known = this.blocks.get(session);
    if (known !== undefined) return known;
    const j = jsonOf(
      await this.rex(["session", "inspect", session, "--json"], { timeoutMs }),
      "session inspect",
    );
    const block = terminalBlock(j);
    if (block === null) throw new Error(`Rex session ${session} has no terminal block`);
    this.blocks.set(session, block);
    return block;
  }

  /** `rex block call -s <session> -b <block> <method> [<arg>]`, its JSON answer. */
  private async blockCall(
    session: string,
    method: string,
    arg: string | null,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const block = await this.blockOf(session, timeoutMs);
    const r = await this.rex(
      ["block", "call", "-s", session, "-b", block, method, ...(arg === null ? [] : [arg])],
      { timeoutMs },
    );
    return jsonOf(r, `block call ${method}`);
  }

  /**
   * The screen's last `lines` rows. `rex capture` prints the whole scrollback (and exec's output
   * cap would cut the end, the part a tail needs), so: `format` with a bounded `max_bytes`, and
   * when more remains, `blob_read` of the last 64 KiB. Null on any failure, never a throw.
   */
  async readScreen(workspace: string, lines: number): Promise<string | null> {
    const t = DAEMON_DEFAULTS.screen_read_timeout_ms;
    try {
      const first = await this.blockCall(workspace, "format", REX_SCREEN_FORMAT, t);
      if (typeof first.content !== "string") return null;
      let text = first.content;
      if (typeof first.id === "number") {
        const total = typeof first.total === "number" ? first.total : 0;
        const rest = await this.blockCall(
          workspace,
          "blob_read",
          JSON.stringify({
            id: first.id,
            offset: Math.max(0, total - REX_SCREEN_MAX_BYTES),
            max_bytes: REX_SCREEN_MAX_BYTES,
          }),
          t,
        );
        if (typeof rest.data !== "string") return null;
        text = rest.data;
      }
      return rexTail(text, lines);
    } catch {
      return null;
    }
  }

  async sendKeys(workspace: string, key: string, tokens: TypedTextTokens = {}): Promise<void> {
    const rexKey = REX_KEYS[key];
    if (rexKey === undefined) throw new Error(`volleyd never presses ${key} in a Rex session`);
    await this.send("send-key", workspace, [rexKey], tokens);
  }

  /** `--`: a text starting with `-` is never read as a flag. */
  async sendText(workspace: string, text: string, tokens: TypedTextTokens = {}): Promise<void> {
    await this.send("send", workspace, ["--", text], tokens);
  }

  /** Bounded: a hung Rex must not hold the daemon's queue (an inbox carry runs on it). */
  private async send(
    verb: "send" | "send-key",
    workspace: string,
    args: string[],
    tokens: TypedTextTokens,
  ): Promise<void> {
    const timeoutMs = DAEMON_DEFAULTS.send_keys_timeout_ms;
    const block = await this.blockOf(workspace, timeoutMs);
    const r = await this.rex([verb, "-s", workspace, "-b", block, ...args], {
      ...tokens,
      timeoutMs,
    });
    if (r.timedOut) throw new Error(`rex ${verb} ${workspace} timed out`);
    if (r.code !== 0)
      throw new Error(`rex ${verb} ${workspace} exit ${r.code}: ${r.stderr.trim()}`);
  }

  /** Ask Rex for a size (`block call resize`); rejects when Rex refused the call. */
  private async requestSize(session: string, size: TermSize): Promise<void> {
    const timeoutMs = DAEMON_DEFAULTS.send_keys_timeout_ms;
    const block = await this.blockOf(session, timeoutMs);
    const r = await this.rex(
      [
        "block",
        "call",
        "-s",
        session,
        "-b",
        block,
        "resize",
        JSON.stringify({ columns: size.cols, rows: size.rows }),
      ],
      { timeoutMs },
    );
    // Rex answers `{}` whether or not it applied the size: `size` reads it back.
    if (r.timedOut || r.code !== 0)
      throw new Error(
        `rex block call resize: ${r.timedOut ? "timed out" : `exit ${r.code}`}${rexSaid(r.stderr)}`,
      );
  }

  /**
   * Resize, then read the size back: Rex applies it at once only when no client (or volleyd)
   * owns the block; the Rex app owns the blocks it shows and keeps its own size, so false then.
   */
  async resize(workspace: string, size: TermSize | "launch"): Promise<boolean> {
    const to =
      size === "launch"
        ? (this.launchSizes.get(workspace) ?? tmuxSize(DEFAULT_SIZE))
        : tmuxSize(size);
    await this.requestSize(workspace, to);
    const now = await this.blockCall(workspace, "size", null, DAEMON_DEFAULTS.send_keys_timeout_ms);
    return now.columns === to.cols && now.rows === to.rows;
  }

  /** Kill the session; one already gone (Rex: exit 3, `… not found`) is closed. */
  async close(workspace: string, consent: ConsentToken): Promise<void> {
    // Bounded: a slow Rex must not hold a retire (or cleanup) forever.
    const r = await this.rex(["kill", workspace], {
      consent,
      timeoutMs: DAEMON_DEFAULTS.workspace_close_timeout_ms,
    }).catch((e: unknown) => {
      throw isNotFound(e) ? new Error(this.advice("missing")) : e;
    });
    if (r.timedOut) throw new Error(`rex kill ${workspace} timed out`);
    if (r.code !== 0 && !(r.code === 3 && GONE.test(r.stderr)))
      throw new Error(`rex kill ${workspace}: ${r.stderr.trim() || `exit ${r.code}`}`);
    this.blocks.delete(workspace);
    this.launchSizes.delete(workspace);
  }

  /**
   * Kill the session, then stop whatever still runs under the agent's worktree: a process the
   * agent left in the background outlives its block.
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

/** One session in `rex ls --json`. */
export interface RexSession {
  session_id: string;
  label: string;
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** A rex call's JSON object answer; throws when it failed or answered something else. */
function jsonOf(r: ExecResult, what: string): Record<string, unknown> {
  if (r.timedOut) throw new Error(`rex ${what} timed out`);
  if (r.code !== 0) throw new Error(`rex ${what} exit ${r.code}${rexSaid(r.stderr || r.stdout)}`);
  const j = parseJson(r.stdout);
  if (!isObject(j)) throw new Error(`rex ${what} answered no JSON object`);
  return j;
}

/**
 * `rex new --json`'s answer, `{ session_id, initial_windows: [{ window_id, block_ids }] }`: the
 * session id and its first block's (null when it named none). Null without a session id.
 */
export function parseRexNew(stdout: string): { session: string; block: string | null } | null {
  const j = parseJson(stdout.trim());
  if (!isObject(j) || typeof j.session_id !== "string" || !SESSION_ID.test(j.session_id))
    return null;
  const windows = Array.isArray(j.initial_windows) ? j.initial_windows : [];
  const first = isObject(windows[0]) ? windows[0] : {};
  const ids = Array.isArray(first.block_ids) ? first.block_ids : [];
  const block = typeof ids[0] === "string" && BLOCK_ID.test(ids[0]) ? ids[0] : null;
  return { session: j.session_id, block };
}

/** `rex ls --json`'s sessions (`{ sessions: [...] }`, or an array): id and label. Null: not that. */
export function parseRexSessions(stdout: string): RexSession[] | null {
  const j = parseJson(stdout.trim());
  const list = Array.isArray(j) ? j : isObject(j) ? j.sessions : undefined;
  if (!Array.isArray(list)) return null;
  return list
    .filter(isObject)
    .filter(
      (s): s is Record<string, unknown> & { session_id: string } =>
        typeof s.session_id === "string",
    )
    .map((s) => ({ session_id: s.session_id, label: typeof s.label === "string" ? s.label : "" }));
}

/**
 * The agent's block in `rex session inspect --json`: the first in `windows[].layers[].blocks[]`
 * that Rex's terminal created. Null when there is none.
 */
function terminalBlock(j: Record<string, unknown>): string | null {
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter(isObject) : []);
  for (const w of arr(j.windows))
    for (const l of arr(w.layers))
      for (const b of arr(l.blocks)) {
        const id = b.block_id ?? b.id;
        if (b.creator_name === TERMINAL_CREATOR && typeof id === "string" && BLOCK_ID.test(id))
          return id;
      }
  return null;
}

/** The last `lines` rows of a screen's text, trailing blank rows dropped (as tmux's capture). */
export function rexTail(text: string, lines: number): string {
  const rows = text.split(/\r?\n/);
  while (rows.length > 0 && (rows.at(-1) as string).trim() === "") rows.pop();
  return rows.slice(-lines).join("\n");
}
