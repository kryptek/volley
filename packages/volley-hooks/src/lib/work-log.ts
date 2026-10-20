import { readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { withLock, writeFileAtomic } from "./seq";
import type { HookSession } from "./session";

/**
 * The hook work log (SPEC §4.3 `activity`): a one-line `progress/activity` tick per tool call
 * or prompt, so a session that never publishes progress of its own still shows what it is
 * doing. At most one tick per session per `ACTIVITY_INTERVAL_MS`; a tick inside the window is
 * held back (newest wins) and published at the next slot. The session's count of tool calls
 * and the rate-limit state live in `<stateDir>/work-log.json`. Every work-log step is
 * cosmetic: a hook catches its failure and carries on.
 */

/** At most one `activity` publish per session in this window. */
export const ACTIVITY_INTERVAL_MS = 5000;
/** An `activity` `msg` is one line of at most this many characters. */
export const ACTIVITY_MSG_MAX = 120;
/** UserPromptSubmit's tick. The prompt text itself is never published. */
export const PROMPT_RECEIVED = "prompt received";

const MASK = "***";
/** A flag or assignment value: one quoted string or one bare word. */
const VALUE = `(?:'[^']*'|"[^"]*"|[^\\s'"]+)`;
/** An assignment or query-string value stops at `&` too. */
const ASSIGNED = `(?:'[^']*'|"[^"]*"|[^\\s'"&]+)`;
/** The end of a token: no further token character follows. */
const END = "(?![A-Za-z0-9_-])";
/** Name endings that mark a credential. */
const SECRET_NAME = "(?:token|password|passwd|secret|key)";
/**
 * A credential name: the last `-` / `_` part of the name is one of the words, never a suffix
 * of a longer word (`X-Api-Key`, `GH_TOKEN`, `--client-secret`; not `monkey`, `hotkey`).
 */
const NAMED = (words: string) => `(?<![A-Za-z0-9])(?:[A-Za-z0-9]+[-_])*${words}(?![A-Za-z0-9])`;
/** An HTTP auth scheme word, kept in front of a masked header value. */
const AUTH_SCHEME = "(?:Bearer|Basic|Digest|Token|Negotiate)";

const RULES: [RegExp, string][] = [
  // Token shapes, wherever they appear and whatever surrounds them.
  // AWS access key ids
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
  // GitHub tokens (classic and fine-grained)
  [new RegExp(`\\bgh[pousr]_[A-Za-z0-9]{20,}${END}`, "g"), MASK],
  [new RegExp(`\\bgithub_pat_[A-Za-z0-9_]{20,}${END}`, "g"), MASK],
  // OpenAI / Anthropic style keys (sk-…, sk-ant-…, sk-proj-…)
  [new RegExp(`\\bsk-[A-Za-z0-9_-]{16,}${END}`, "g"), MASK],
  // Slack tokens
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, MASK],
  // JWTs
  [new RegExp(`\\beyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+${END}`, "g"), MASK],
  // A PEM private key: from its header to its footer, or to the end of the line
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----(?:.*?-----END [A-Z ]*PRIVATE KEY-----|.*)/g, MASK],
  // https://user:pass@host, https://token@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi, `$1${MASK}@`],
  // Authorization: Bearer <token>, or a bare Bearer <token>
  [/\b(Bearer)\s+[^\s'"]+/gi, `$1 ${MASK}`],
  // Authorization: Basic <x> / Authorization: <x>
  [/(Authorization:[ \t]*)(?![ \t]|Bearer\b)(\w+[ \t]+)?[^\s'"]+/gi, `$1$2${MASK}`],
  // Cookie: <everything up to the closing quote or end of line>
  [/\b((?:Set-)?Cookie[ \t]*:[ \t]*)[^'"\n]+/gi, `$1${MASK}`],
  // Credential headers and JSON / YAML keys: X-Api-Key: v, X-Auth-Token: v, "api_key": "v",
  // Proxy-Authorization: Basic v (an auth scheme word is kept)
  [
    new RegExp(
      `(${NAMED("(?:key|token|secret|password|passwd|authorization)")}["']?[ \\t]*:[ \\t]*["']?)(${AUTH_SCHEME}[ \\t]+)?(?!${AUTH_SCHEME}\\b)[^\\s'"]+`,
      "gi",
    ),
    `$1$2${MASK}`,
  ],
  // --password <v>, --token=<v>, --api-key <v>, --client-secret <v>, --access-token=<v>, …
  [new RegExp(`(--${NAMED(SECRET_NAME)}(?:=|\\s+))(?!-)${VALUE}`, "gi"), `$1${MASK}`],
  // curl -u user:pass, --user user:pass, --user=user:pass: the password part
  [/(^|\s)(-u[ \t]*|--user(?:=|[ \t]+))(['"])([^:'"]+):[^'"]*\3/g, `$1$2$3$4:${MASK}$3`],
  [/(^|\s)(-u[ \t]*|--user(?:=|[ \t]+))([^\s:'"]+):[^\s'"]+/g, `$1$2$3:${MASK}`],
  // -p is a credential only glued to mysql / mariadb (`-pSECRET`; a spaced `-p` prompts for
  // it). Anywhere else -p is not (`mkdir -p`, `git log -p`, `ssh -p 22`, `docker run -p 80:80`).
  [
    new RegExp(
      `(\\b(?:mysql|mariadb|mysqldump|mysqladmin|mariadb-dump)\\b[^|;&]*?\\s-p)(?=[^\\s-])${VALUE}`,
      "g",
    ),
    `$1${MASK}`,
  ],
  // mosquitto_pub / mosquitto_sub take the password as -P <v>
  [new RegExp(`(\\bmosquitto_(?:pub|sub)\\b[^|;&]*?\\s-P\\s+)(?!-)${VALUE}`, "g"), `$1${MASK}`],
  // A credential name and its value after a set / config command:
  // `aws configure set aws_secret_access_key <v>`, `git config user.signingkey <v>`
  [
    new RegExp(
      `(\\b(?:set|config|configure)\\s+(?:[^\\s'"]+\\s+){0,3}?[^\\s'"=]*${SECRET_NAME}\\s+)(?!-)${VALUE}`,
      "gi",
    ),
    `$1${MASK}`,
  ],
  // token=, password=, secret=, api_key=, apikey=, GH_TOKEN=, DB_PASSWORD=, AWS_SECRET=, *_KEY=
  [
    new RegExp(`(${NAMED("(?:token|password|passwd|secret|key|apikey)")})=${ASSIGNED}`, "gi"),
    `$1=${MASK}`,
  ],
];

/**
 * Mask what looks like a credential in a line about to be published. Token shapes are masked
 * wherever they appear: AWS access key ids (`AKIA…` / `ASIA…`), GitHub tokens (`ghp_…`,
 * `gho_…`, `github_pat_…`), `sk-…` API keys, Slack `xox?-…` tokens, JWTs and PEM private keys.
 * In context: credential flags (`--password`, `--token`, `--api-key`, any `--*secret` /
 * `--*token` / `--*key` part, mysql's glued `-pSECRET`, mosquitto's `-P`), curl's `-u` / `--user user:pass`, credential headers and keys
 * (`Authorization`, `Bearer`, `Cookie`, `X-Api-Key:`, `X-Auth-Token:`, `"api_key": …`: the
 * name's last part is key, token, secret, password or authorization, never a suffix such as
 * `monkey`), `token=` / `password=` style assignments and query parameters (a last name part
 * TOKEN, PASSWORD, SECRET, KEY or APIKEY), a credential name and value after `set` / `config`
 * (`aws configure set aws_secret_access_key …`) and URL userinfo. Common commands stay
 * readable: `-p` / `-P` outside those tools and words that merely end in "key" are not masked.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out;
}

function firstLine(text: string): string {
  return (text.trimStart().split(/\r?\n/)[0] ?? "").trimEnd();
}

/** The first line of `text`, cut to `max` characters (the last one an ellipsis). */
export function clipLine(text: string, max = ACTIVITY_MSG_MAX): string {
  const line = firstLine(text);
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const v = input[key];
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/** `path` relative to `projectDir` when it lies inside it; otherwise unchanged. */
function projectRelative(path: string | undefined, projectDir: string): string | undefined {
  if (path === undefined || !isAbsolute(path)) return path;
  const rel = relative(projectDir, path);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? path : rel;
}

/** A usable home directory: absolute, not the root, no trailing slash. */
function usableHome(home: string | undefined): string | undefined {
  if (home === undefined || !isAbsolute(home)) return undefined;
  const h = home.replace(/\/+$/, "");
  return h === "" ? undefined : h;
}

/** Every `<home>/…` (or a bare `<home>`) in `text` written as `~/…` (`~`). */
function homeRelative(text: string, home: string | undefined): string {
  const h = usableHome(home);
  if (h === undefined) return text;
  const escaped = h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`(?<=^|[\\s'"=:])${escaped}(?=/|$|[\\s'"])`, "g"), "~");
}

function hostOf(url: string | undefined): string | undefined {
  if (url === undefined || !URL.canParse(url)) return undefined;
  const host = new URL(url).host;
  return host === "" ? undefined : host;
}

/**
 * PreToolUse's one-line summary of a tool call: `Bash: <first line>`, `Edit: <path>` (relative
 * to the project dir inside it), `Task: <description>`, `Grep: <pattern>`, `WebFetch: <host>`,
 * …; any other tool is its name (`mcp__<server>__<tool>` → `<tool>`). Paths under `home` (the
 * hook's `HOME`) outside the project are written `~/…`, so the home directory (and the user
 * name in it) is never published. Redacted, then clipped.
 */
export function toolSummary(
  toolName: unknown,
  toolInput: unknown,
  projectDir: string,
  home?: string,
): string {
  const name = typeof toolName === "string" && toolName !== "" ? toolName : "tool";
  const input =
    typeof toolInput === "object" && toolInput !== null && !Array.isArray(toolInput)
      ? (toolInput as Record<string, unknown>)
      : {};
  let label = name;
  let detail: string | undefined;
  switch (name) {
    case "Bash":
      detail = stringField(input, "command");
      break;
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "Read":
      detail = projectRelative(stringField(input, "file_path"), projectDir);
      break;
    case "NotebookEdit":
      detail = projectRelative(stringField(input, "notebook_path"), projectDir);
      break;
    case "Task":
    case "Agent":
      label = "Task";
      detail = stringField(input, "description");
      break;
    case "Grep":
    case "Glob":
      detail = stringField(input, "pattern");
      break;
    case "WebFetch":
      detail = hostOf(stringField(input, "url"));
      break;
    case "WebSearch":
      detail = stringField(input, "query");
      break;
    default: {
      const mcp = /^mcp__.+?__(.+)$/.exec(name);
      if (mcp?.[1] !== undefined) label = mcp[1];
    }
  }
  const line = detail === undefined ? label : `${label}: ${homeRelative(firstLine(detail), home)}`;
  return clipLine(redactSecrets(line));
}

/**
 * One Claude Code session's entry in `<stateDir>/work-log.json`. The state dir is shared by
 * every session run in the same directory (coordinator mode) or worktree (agent mode), so the
 * file keeps one entry per session (`session_id`, from the hook input): a new session starts
 * from zero with a fresh rate-limit window, two sessions running side by side each keep their
 * own count, and compact and resume keep the session id and the count.
 */
export interface WorkLog {
  /** The Claude Code session this log counts (absent only for an empty log). */
  session_id?: string;
  /** Tool calls this session has made (every PreToolUse, rate-limited or not). */
  tool_calls: number;
  /** Epoch ms of the last tick allowed to publish; null before the first. */
  last_published_at: number | null;
  /**
   * The newest tick held back by the rate limit: published at the next slot (by PostToolUse,
   * see `flushPending`), or superseded by the next tick that publishes its own line.
   */
  pending?: string;
}

/** The file: `{ sessions: { <session_id>: { tool_calls, last_published_at, pending?, touched_at } } }`. */
interface Entry {
  tool_calls: number;
  last_published_at: number | null;
  pending?: string;
  /** Epoch ms of the entry's last write: old sessions are dropped (`prune`). */
  touched_at: number;
}
type Sessions = Record<string, Entry>;

/** Entries untouched this long are dropped, and at most this many are kept (newest first). */
const SESSION_TTL_MS = 7 * 24 * 3600_000;
const SESSIONS_MAX = 16;

/** The work log's session key: the hook input's `session_id`, else the agent id. */
export function workLogSession(input: { session_id?: unknown }, agentId: string): string {
  const id = input.session_id;
  return typeof id === "string" && id !== "" ? id : agentId;
}

const workLogPath = (stateDir: string) => join(stateDir, "work-log.json");
const lockPath = (stateDir: string) => join(stateDir, "work-log.lock");

function entryOf(v: unknown): Entry | null {
  if (typeof v !== "object" || v === null) return null;
  const raw = v as Record<string, unknown>;
  const n = raw.tool_calls;
  const at = raw.last_published_at;
  const touched = raw.touched_at;
  return {
    tool_calls: typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0,
    last_published_at: typeof at === "number" && Number.isFinite(at) ? at : null,
    ...(typeof raw.pending === "string" ? { pending: raw.pending } : {}),
    touched_at: typeof touched === "number" && Number.isFinite(touched) ? touched : 0,
  };
}

/** Every session's entry; a missing, corrupt or older-format file is none. */
function readSessions(stateDir: string): Sessions {
  try {
    const raw = JSON.parse(readFileSync(workLogPath(stateDir), "utf-8")) as { sessions?: unknown };
    const out: Sessions = {};
    if (typeof raw.sessions !== "object" || raw.sessions === null) return out;
    for (const [id, v] of Object.entries(raw.sessions)) {
      const e = entryOf(v);
      if (e) out[id] = e;
    }
    return out;
  } catch {
    return {};
  }
}

const asLog = (id: string, e: Entry): WorkLog => ({
  session_id: id,
  tool_calls: e.tool_calls,
  last_published_at: e.last_published_at,
  ...(e.pending !== undefined ? { pending: e.pending } : {}),
});

/** `sessionId`'s log (empty when it has none); without one, the most recently written. */
export function readWorkLog(stateDir: string, sessionId?: string): WorkLog {
  const sessions = readSessions(stateDir);
  if (sessionId !== undefined) {
    const e = sessions[sessionId];
    return e
      ? asLog(sessionId, e)
      : { session_id: sessionId, tool_calls: 0, last_published_at: null };
  }
  const newest = Object.entries(sessions).sort((a, b) => b[1].touched_at - a[1].touched_at)[0];
  return newest ? asLog(newest[0], newest[1]) : { tool_calls: 0, last_published_at: null };
}

/** `sessionId`'s log: its own entry, else an empty one. */
export function sessionWorkLog(stateDir: string, sessionId: string): WorkLog {
  return readWorkLog(stateDir, sessionId);
}

/** Write `log` as its session's entry, dropping old sessions. */
function writeWorkLog(stateDir: string, log: WorkLog & { session_id: string }, now: number): void {
  const sessions = readSessions(stateDir);
  sessions[log.session_id] = {
    tool_calls: log.tool_calls,
    last_published_at: log.last_published_at,
    ...(log.pending !== undefined ? { pending: log.pending } : {}),
    touched_at: now,
  };
  const kept = Object.entries(sessions)
    .filter(([id, e]) => id === log.session_id || now - e.touched_at < SESSION_TTL_MS)
    .sort((a, b) => b[1].touched_at - a[1].touched_at)
    .slice(0, SESSIONS_MAX);
  writeFileAtomic(
    workLogPath(stateDir),
    `${JSON.stringify({ sessions: Object.fromEntries(kept) })}\n`,
  );
}

/** Whether a tick at `now` may publish, given the last publish. */
const slotOpen = (last: number | null, now: number) =>
  last === null || now - last >= ACTIVITY_INTERVAL_MS || now < last;

interface TickOpts {
  /** The Claude Code session (`workLogSession`). */
  sessionId: string;
  now?: () => number;
}

/**
 * Record one tick of `sessionId` under `work-log.lock` (parallel tool calls run their hooks
 * concurrently): count it when it is a tool call, and decide whether it may publish. Outside
 * the window it may (its own `msg`; any pending one is dropped: newest wins) and the window
 * restarts; inside it, `msg` becomes `pending` and nothing is published. The window restarts
 * before the publish is attempted, so a down broker is retried on the same schedule.
 */
export function recordActivity(
  stateDir: string,
  msg: string,
  opts: TickOpts & { toolCall: boolean },
): Promise<{ publish: boolean; tool_calls: number }> {
  return withLock(lockPath(stateDir), () => {
    const now = (opts.now ?? Date.now)();
    const prev = sessionWorkLog(stateDir, opts.sessionId);
    const tool_calls = prev.tool_calls + (opts.toolCall ? 1 : 0);
    const last = prev.last_published_at;
    const publish = slotOpen(last, now);
    writeWorkLog(
      stateDir,
      publish
        ? { session_id: opts.sessionId, tool_calls, last_published_at: now }
        : { session_id: opts.sessionId, tool_calls, last_published_at: last, pending: msg },
      now,
    );
    return { publish, tool_calls };
  });
}

/**
 * The next slot for a held-back tick (PostToolUse): when `sessionId`'s log has a `pending`
 * line and the window is over, clear it, restart the window and return it with the current
 * count for the caller to publish. Otherwise null, and the log is left as it is.
 */
export function flushPending(
  stateDir: string,
  opts: TickOpts,
): Promise<{ msg: string; tool_calls: number } | null> {
  return withLock(lockPath(stateDir), () => {
    const now = (opts.now ?? Date.now)();
    const log = readWorkLog(stateDir, opts.sessionId);
    if (log.pending === undefined) return null;
    if (!slotOpen(log.last_published_at, now)) return null;
    writeWorkLog(
      stateDir,
      { session_id: opts.sessionId, tool_calls: log.tool_calls, last_published_at: now },
      now,
    );
    return { msg: log.pending, tool_calls: log.tool_calls };
  });
}

/**
 * Stop: drop `sessionId`'s pending tick (the session is idle now) and return its tool-call
 * count; 0, and nothing written, when the session has no entry.
 */
export function settleWorkLog(
  stateDir: string,
  sessionId: string,
  now: () => number = Date.now,
): Promise<number> {
  return withLock(lockPath(stateDir), () => {
    if (readSessions(stateDir)[sessionId] === undefined) return 0;
    const { pending: _dropped, ...log } = readWorkLog(stateDir, sessionId);
    writeWorkLog(stateDir, { ...log, session_id: sessionId }, now());
    return log.tool_calls;
  });
}

/**
 * Record a tick on an already-open session and publish it if the rate limit allows
 * (UserPromptSubmit's `prompt received`).
 */
export async function activityTick(
  session: HookSession,
  msg: string,
  opts: TickOpts & { toolCall: boolean },
): Promise<void> {
  const { publish, tool_calls } = await recordActivity(session.identity.stateDir, msg, opts);
  if (publish) await session.progress("activity", { msg, tool_calls });
}

/** PostToolUse: publish the held-back tick on its already-open session, if its slot has come. */
export async function flushActivity(session: HookSession, opts: TickOpts): Promise<void> {
  const tick = await flushPending(session.identity.stateDir, opts);
  if (tick !== null) await session.progress("activity", tick);
}
