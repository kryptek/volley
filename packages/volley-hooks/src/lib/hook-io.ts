import {
  type HookIdentity,
  coordinatorEnabled,
  projectDirOf,
  readAgentIdentity,
  resolveCoordinatorIdentity,
} from "./identity";

export type Env = Record<string, string | undefined>;

/** Common Claude Code hook stdin fields; each event adds its own. */
export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  [key: string]: unknown;
}

export interface HookContext {
  /** The hook event this script handles (`hookSpecificOutput.hookEventName`). */
  event: string;
  input: HookInput;
  env: Env;
  identity: HookIdentity;
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

/** First two non-empty lines of `text`. */
export function firstLines(text: string, n = 2): string {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, n)
    .join("\n");
}

/**
 * When `text` ends in a question, the question: the first two lines of its last paragraph.
 * Otherwise null.
 */
export function questionOf(text: string | undefined): string | null {
  if (text === undefined || !text.trimEnd().endsWith("?")) return null;
  const paragraphs = text.trim().split(/\n\s*\n/);
  return firstLines(paragraphs[paragraphs.length - 1] ?? "") || null;
}

/**
 * Resolve the identity and run `handler`. Returns the hook's stdout: empty unless the handler
 * produced context for an event that accepts it. Without an identity it returns "" before
 * any socket is opened, so the hooks are harmless in a global settings file.
 */
export async function invokeHook(
  event: string,
  handler: HookHandler,
  raw: string,
  env: Env,
): Promise<string> {
  const input = parseHookInput(raw);
  if (input === null) return "";
  const dir = projectDirOf(input, env);
  let identity = readAgentIdentity(dir, env);
  if (identity === null && coordinatorEnabled(env)) {
    const { listRegistry } = await import("./session");
    identity = await resolveCoordinatorIdentity(dir, env, listRegistry, {
      refresh: event === "SessionStart",
    });
  }
  if (identity === null) return "";
  const text = await handler({ event, input, env, identity });
  if (text === null || text === "" || !CONTEXT_EVENTS.has(event)) return "";
  return contextOutput(event, text);
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
  const timeoutMs = Number(env.VOLLEY_HOOKS_TIMEOUT_MS ?? 10_000);
  setTimeout(() => process.exit(0), timeoutMs > 0 ? timeoutMs : 10_000).unref();
  let out = "";
  try {
    out = await invokeHook(event, handler, await readStdin(), env);
  } catch (e) {
    if (env.VOLLEY_HOOKS_DEBUG === "1") process.stderr.write(`volley-hooks ${event}: ${e}\n`);
  }
  if (out === "") process.exit(0);
  process.stdout.write(out, () => process.exit(0));
}
