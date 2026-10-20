import { readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { withLock, writeFileAtomic } from "./seq";
import type { HookSession } from "./session";

/**
 * The hook work log (SPEC §4.3 `activity`): a one-line `progress/activity` tick per tool call
 * or prompt, so a session that never publishes progress of its own still shows what it is
 * doing. At most one tick per agent per `ACTIVITY_INTERVAL_MS`; the count of tool calls and
 * the rate-limit state live in `<stateDir>/work-log.json`.
 */

/** At most one `activity` publish per agent in this window. */
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

const RULES: [RegExp, string][] = [
  // https://user:pass@host, https://token@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi, `$1${MASK}@`],
  // Authorization: Bearer <token>, or a bare Bearer <token>
  [/\b(Bearer)\s+[^\s'"]+/gi, `$1 ${MASK}`],
  // Authorization: Basic <x> / Authorization: <x>
  [/(Authorization:[ \t]*)(?![ \t]|Bearer\b)(\w+[ \t]+)?[^\s'"]+/gi, `$1$2${MASK}`],
  // --password <v>, --token <v>, --password=<v>, --token=<v>
  [new RegExp(`(--(?:password|passwd|token)(?:=|\\s+))${VALUE}`, "gi"), `$1${MASK}`],
  // -p <v>, -p<v> (mysql and friends); a following flag is not a value, and find's
  // -print / -printf / -print0 / -perm / -path / -prune are whole words, not -p<v>
  [
    new RegExp(`(^|\\s)-p(\\s+|(?!(?:rint0?|rintf|erm|ath|rune)(?:\\s|$)))(?!-)${VALUE}`, "g"),
    `$1-p$2${MASK}`,
  ],
  // token=, password=, secret=, api_key=, apikey=, GH_TOKEN=, DB_PASSWORD=, AWS_SECRET=, *_KEY=
  [
    new RegExp(`(?<![\\w-])([\\w-]*(?:token|password|passwd|secret|key))=${ASSIGNED}`, "gi"),
    `$1=${MASK}`,
  ],
];

/**
 * Mask what looks like a credential in a line about to be published: flag values
 * (`--password`, `--token`, `-p`), `token=` / `password=` / `secret=` / `api_key=` style
 * assignments and query parameters (any name ending in TOKEN, PASSWORD, SECRET or KEY),
 * `Authorization` / `Bearer` values and URL userinfo. Errs on the side of masking.
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

function hostOf(url: string | undefined): string | undefined {
  if (url === undefined || !URL.canParse(url)) return undefined;
  const host = new URL(url).host;
  return host === "" ? undefined : host;
}

/**
 * PreToolUse's one-line summary of a tool call: `Bash: <first line>`, `Edit: <path>` (relative
 * to the project dir inside it), `Task: <description>`, `Grep: <pattern>`, `WebFetch: <host>`,
 * …; any other tool is its name (`mcp__<server>__<tool>` → `<tool>`). Redacted, then clipped.
 */
export function toolSummary(toolName: unknown, toolInput: unknown, projectDir: string): string {
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
  const line = detail === undefined ? label : `${label}: ${firstLine(detail)}`;
  return clipLine(redactSecrets(line));
}

/** `<stateDir>/work-log.json`. */
export interface WorkLog {
  /** Tool calls this session has made (every PreToolUse, rate-limited or not). */
  tool_calls: number;
  /** Epoch ms of the last tick allowed to publish; null before the first. */
  last_published_at: number | null;
  /** The newest tick held back by the rate limit; superseded by the next published one. */
  pending?: string;
}

const workLogPath = (stateDir: string) => join(stateDir, "work-log.json");
const lockPath = (stateDir: string) => join(stateDir, "work-log.lock");

export function readWorkLog(stateDir: string): WorkLog {
  try {
    const raw = JSON.parse(readFileSync(workLogPath(stateDir), "utf-8")) as Record<string, unknown>;
    const n = raw.tool_calls;
    const at = raw.last_published_at;
    return {
      tool_calls: typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0,
      last_published_at: typeof at === "number" && Number.isFinite(at) ? at : null,
      ...(typeof raw.pending === "string" ? { pending: raw.pending } : {}),
    };
  } catch {
    return { tool_calls: 0, last_published_at: null };
  }
}

function writeWorkLog(stateDir: string, log: WorkLog): void {
  writeFileAtomic(workLogPath(stateDir), `${JSON.stringify(log)}\n`);
}

/**
 * Record one tick under `work-log.lock` (parallel tool calls run their hooks concurrently):
 * count it when it is a tool call, and decide whether it may publish. Outside the window it
 * may (its own `msg`; any pending one is dropped) and the window restarts; inside it, `msg`
 * becomes `pending` (newest wins) and nothing is published. The window restarts before the
 * publish is attempted, so a down broker is retried on the same schedule.
 */
export function recordActivity(
  stateDir: string,
  msg: string,
  opts: { toolCall: boolean; now?: () => number },
): Promise<{ publish: boolean; tool_calls: number }> {
  return withLock(lockPath(stateDir), () => {
    const now = (opts.now ?? Date.now)();
    const prev = readWorkLog(stateDir);
    const tool_calls = prev.tool_calls + (opts.toolCall ? 1 : 0);
    const last = prev.last_published_at;
    const publish = last === null || now - last >= ACTIVITY_INTERVAL_MS || now < last;
    writeWorkLog(
      stateDir,
      publish
        ? { tool_calls, last_published_at: now }
        : { tool_calls, last_published_at: last, pending: msg },
    );
    return { publish, tool_calls };
  });
}

/** Stop: drop the pending tick (the session is idle now) and return the tool-call count. */
export function settleWorkLog(stateDir: string): Promise<number> {
  return withLock(lockPath(stateDir), () => {
    const { pending: _dropped, ...log } = readWorkLog(stateDir);
    writeWorkLog(stateDir, log);
    return log.tool_calls;
  });
}

/** Record a tick on an already-open session and publish it if the rate limit allows. */
export async function activityTick(
  session: HookSession,
  msg: string,
  opts: { toolCall: boolean; now?: () => number },
): Promise<void> {
  const { publish, tool_calls } = await recordActivity(session.identity.stateDir, msg, opts);
  if (publish) await session.progress("activity", { msg, tool_calls });
}
