import {
  type HookIdentity,
  coordinatorEnabled,
  projectDirOf,
  readAgentIdentity,
  resolveCoordinatorIdentity,
} from "./identity";
import { hookTimeoutMs } from "./seq";

export type Env = Record<string, string | undefined>;

/** Common Claude Code hook stdin fields; each event adds its own. */
export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  [key: string]: unknown;
}

/** Runs once the hook's stdout is written (`emitted`), or when the hook ends without it. */
export type AfterEmit = (emitted: boolean) => void;

export interface HookContext {
  /** The hook event this script handles (`hookSpecificOutput.hookEventName`). */
  event: string;
  input: HookInput;
  env: Env;
  identity: HookIdentity;
  /** Defer work until the injected context has actually been handed to Claude Code. */
  afterEmit: (fn: AfterEmit) => void;
}

/** Returns text to inject as `additionalContext`, or null. */
export type HookHandler = (ctx: HookContext) => Promise<string | null>;

/** Events whose `additionalContext` reaches the model (Claude Code hooks reference). */
const CONTEXT_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"]);

export function parseHookInput(raw: string): HookInput | null {
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as HookInput) : null;
  } catch {
    return null;
  }
}

/** The JSON stdout that injects `text` (plain stdout does not reach the model on PostToolUse). */
export function contextOutput(event: string, text: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
}

/** First `max` characters of a string field, or undefined. */
export function clip(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

/**
 * The longest `question` published whole. A longer one is a bounded excerpt: its end (where
 * the question is), behind a marker that points at the session for the rest.
 */
export const QUESTION_MAX = 8192;

export function boundQuestion(question: string, max = QUESTION_MAX): string {
  if (question.length <= max) return question;
  const omitted = question.length - max;
  return `[… ${omitted} earlier characters omitted; the full question is in the session]\n${question.slice(omitted)}`;
}

/**
 * When `text` ends in a question, the question: its last paragraph, whole (bounded by
 * `QUESTION_MAX`). Otherwise null. Pass the unclipped text — a clipped one has lost its end.
 */
export function questionOf(text: string | undefined): string | null {
  if (text === undefined || !text.trimEnd().endsWith("?")) return null;
  const paragraphs = text.trim().split(/\n\s*\n/);
  const question = (paragraphs[paragraphs.length - 1] ?? "").trim();
  return question === "" ? null : boundQuestion(question);
}

/**
 * Resolve the identity and run `handler`. Returns the hook's stdout: empty unless the handler
 * produced context for an event that accepts it. In agent mode, a directory without
 * `.volley/agent.json` returns "" before any socket is opened. In coordinator mode the
 * registry lookup costs one connection per minute per directory (misses are cached too), so
 * the hooks stay cheap in a global settings file. `afterEmit` collects the handler's
 * deferred callbacks; the caller runs them once stdout is written.
 */
export async function invokeHook(
  event: string,
  handler: HookHandler,
  raw: string,
  env: Env,
  afterEmit: AfterEmit[] = [],
): Promise<string> {
  const input = parseHookInput(raw);
  if (input === null) return "";
  const dir = projectDirOf(input, env);
  let identity = readAgentIdentity(dir, env);
  if (identity === null && coordinatorEnabled(env)) {
    const { lookupRegistry } = await import("./session");
    const startup = event === "SessionStart" && input.source === "startup";
    identity = await resolveCoordinatorIdentity(dir, env, lookupRegistry, {
      refresh: event === "SessionStart",
      // A new session's entry is newer than the session; an older one is a previous session.
      ...(startup ? { notBefore: Date.now() - STARTUP_SKEW_MS } : {}),
    });
  }
  if (identity === null) return "";
  const text = await handler({
    event,
    input,
    env,
    identity,
    afterEmit: (fn) => afterEmit.push(fn),
  });
  if (text === null || text === "" || !CONTEXT_EVENTS.has(event)) return "";
  return contextOutput(event, text);
}

/** How much older than the SessionStart hook this session's own registry entry may be. */
const STARTUP_SKEW_MS = 60_000;

function runAfterEmit(callbacks: AfterEmit[], emitted: boolean): void {
  for (const fn of callbacks.splice(0)) {
    try {
      fn(emitted);
    } catch {
      // a hook never fails the session
    }
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

/**
 * Script entry point: read stdin, run, print, exit 0. A hook never fails the session — any
 * error is swallowed (set `VOLLEY_HOOKS_DEBUG=1` to see it on stderr), and a deadline
 * (`VOLLEY_HOOKS_TIMEOUT_MS`, default 10 s) bounds how long Claude waits on us.
 */
export async function runHook(event: string, handler: HookHandler): Promise<void> {
  const env = process.env;
  const after: AfterEmit[] = [];
  setTimeout(() => {
    runAfterEmit(after, false);
    process.exit(0);
  }, hookTimeoutMs(env)).unref();
  let out = "";
  try {
    out = await invokeHook(event, handler, await readStdin(), env, after);
  } catch (e) {
    if (env.VOLLEY_HOOKS_DEBUG === "1") process.stderr.write(`volley-hooks ${event}: ${e}\n`);
  }
  if (out === "") {
    runAfterEmit(after, false);
    process.exit(0);
  }
  process.stdout.write(out, (err) => {
    runAfterEmit(after, err == null);
    process.exit(0);
  });
}
