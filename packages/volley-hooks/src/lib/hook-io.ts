import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ConnectTarget,
  CredentialsError,
  HOOKS_ERROR_FILE,
  type HooksError,
  isAuthFailed,
  resolveHooksAuth,
  writeHooksError,
} from "./auth";
import {
  type HookIdentity,
  coordinatorBrokerUrl,
  coordinatorEnabled,
  coordinatorStateDir,
  projectDirOf,
  readAgentIdentity,
  readRetiredMarker,
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

/**
 * Structured hook output: `additionalContext` (events in CONTEXT_EVENTS) and, for PreToolUse,
 * `updatedInput` (the tool input Claude Code runs instead of the original).
 */
export interface HookResult {
  additionalContext?: string;
  updatedInput?: Record<string, unknown>;
}

/** Who the hook was connecting as, recorded before any connect so a refusal can be reported. */
export interface HookTrace {
  target?: ConnectTarget;
}

/** Returns text to inject as `additionalContext`, a structured result, or null. */
export type HookHandler = (ctx: HookContext) => Promise<string | HookResult | null>;

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

/** The JSON stdout for a structured result; "" when it carries nothing the event accepts. */
export function resultOutput(event: string, r: HookResult): string {
  const out: Record<string, unknown> = {};
  if (r.updatedInput !== undefined && event === "PreToolUse") out.updatedInput = r.updatedInput;
  if (r.additionalContext !== undefined && r.additionalContext !== "" && CONTEXT_EVENTS.has(event))
    out.additionalContext = r.additionalContext;
  if (Object.keys(out).length === 0) return "";
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, ...out } });
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
 * deferred callbacks; the caller runs them once stdout is written. `trace` records who the hook
 * connects as. An agent volleyd retired (`.volley/retired.json` naming its own id) returns ""
 * before any connect: its login is gone on purpose, so there is nothing to report.
 */
export async function invokeHook(
  event: string,
  handler: HookHandler,
  raw: string,
  env: Env,
  afterEmit: AfterEmit[] = [],
  trace: HookTrace = {},
): Promise<string> {
  const input = parseHookInput(raw);
  if (input === null) return "";
  const dir = projectDirOf(input, env);
  let identity = readAgentIdentity(dir, env);
  if (identity === null && coordinatorEnabled(env)) {
    const { lookupRegistry } = await import("./session");
    const startup = event === "SessionStart" && input.source === "startup";
    trace.target = {
      mode: "coordinator",
      projectDir: dir,
      agentId: "volley-hooks",
      brokerUrl: coordinatorBrokerUrl(env),
      stateDir: coordinatorStateDir(dir, env),
    };
    const lookup = (url: string, d: string) => lookupRegistry(url, d, env);
    identity = await resolveCoordinatorIdentity(dir, env, lookup, {
      refresh: event === "SessionStart",
      // A new session's entry is newer than the session; an older one is a previous session.
      ...(startup ? { notBefore: Date.now() - STARTUP_SKEW_MS } : {}),
    });
  }
  if (identity === null) return "";
  if (
    identity.mode === "agent" &&
    readRetiredMarker(identity.stateDir)?.agent_id === identity.agentId
  ) {
    noteRetired(event, identity.stateDir, identity.agentId);
    return "";
  }
  trace.target = identity;
  const text = await handler({
    event,
    input,
    env,
    identity,
    afterEmit: (fn) => afterEmit.push(fn),
  });
  if (text !== null && typeof text === "object") return resultOutput(event, text);
  if (text === null || text === "" || !CONTEXT_EVENTS.has(event)) return "";
  return contextOutput(event, text);
}

/** `hooks-error.json` says RETIRED once (later hooks leave it be). Never throws. */
function noteRetired(event: string, stateDir: string, agentId: string): void {
  try {
    const prev = JSON.parse(readFileSync(join(stateDir, HOOKS_ERROR_FILE), "utf-8")) as {
      code?: unknown;
    };
    if (prev?.code === "RETIRED") return;
  } catch {
    // none yet, or unreadable: (re)write it
  }
  const note: HooksError = {
    code: "RETIRED",
    at: new Date().toISOString(),
    hook_event: event,
    agent_id: agentId,
  };
  try {
    writeHooksError(stateDir, note);
  } catch {
    // a retired agent's hooks stay quiet either way
  }
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

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

/**
 * A refused CONNACK, or credentials that could not even be sent (`CredentialsError`): one
 * stderr line (Claude Code shows it to the operator on exit 1) and `<stateDir>/hooks-error.json`
 * for the supervisor. Never throws.
 */
export function reportAuthFailed(
  event: string,
  trace: HookTrace,
  env: Env,
  error?: unknown,
): string {
  const t = trace.target;
  const unusable = error instanceof CredentialsError ? error : null;
  let username: string | null = null;
  if (unusable === null) {
    try {
      if (t !== undefined) username = resolveHooksAuth(t, env)?.username ?? null;
    } catch {
      // unreadable credentials cannot have been sent
    }
  }
  const coordinator = unusable?.stateDir === undefined && t?.mode === "coordinator";
  const hint = coordinator
    ? "set VOLLEY_AUTH_*, or write $VOLLEY_AUTH_DIR/coordinator.json with `volley auth init --coordinator-file`"
    : "run volley auth add-agent, or check the .volley/agent.json broker block / VOLLEY_AUTH_*";
  const what =
    unusable !== null
      ? unusable.message
      : `for ${username ?? "anonymous"} at ${t?.brokerUrl ?? "the broker"}`;
  const line = `volley-hooks ${event}: AUTH_FAILED ${unusable !== null ? "— " : ""}${what} — ${hint}\n`;
  const stateDir = unusable?.stateDir ?? t?.stateDir;
  if (stateDir !== undefined) {
    const record: HooksError = {
      code: "AUTH_FAILED",
      at: new Date().toISOString(),
      hook_event: event,
      username,
      ...(unusable !== null ? { detail: unusable.message } : {}),
    };
    try {
      writeHooksError(stateDir, record);
    } catch {
      // the stderr line still reaches the operator
    }
  }
  return line;
}

/**
 * Script entry point: read stdin, run, print, exit 0. A hook never fails the session — any
 * error is swallowed (set `VOLLEY_HOOKS_DEBUG=1` to see it on stderr), and a deadline
 * (`VOLLEY_HOOKS_TIMEOUT_MS`, default 10 s) bounds how long Claude waits on us. The one
 * exception is a broker refusing the hooks' credentials (`AUTH_FAILED`): it is loud — a stderr
 * line, `hooks-error.json`, exit 1 (a non-blocking error: never 2, which would block the tool
 * call, and never 0, which would look like success).
 */
export async function runHook(event: string, handler: HookHandler): Promise<void> {
  const env = process.env;
  const after: AfterEmit[] = [];
  setTimeout(() => {
    runAfterEmit(after, false);
    process.exit(0);
  }, hookTimeoutMs(env)).unref();
  let out = "";
  const trace: HookTrace = {};
  try {
    out = await invokeHook(event, handler, await readStdin(), env, after, trace);
  } catch (e) {
    if (isAuthFailed(e)) {
      const line = reportAuthFailed(event, trace, env, e);
      runAfterEmit(after, false);
      process.stderr.write(line, () => process.exit(1));
      return;
    }
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
