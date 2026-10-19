#!/usr/bin/env bun
/**
 * statusLine command (SPEC §4.6.12): Claude Code pipes its statusLine JSON in after each assistant
 * message (and at session start, on permission-mode changes, …). Publish the session's usage —
 * its context window and its Claude account's 5-hour and weekly windows — retained on
 * `volley/<ns>/<agent>/usage`, at most once per 15 s unless a percentage moved by more than a
 * point. The status line itself stays the user's own: the statusLine command the install saved
 * (`<state root>/statusline-chain.json`) runs on the same input and its output is printed;
 * without one, a minimal line.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isAuthFailed } from "../lib/auth";
import {
  type Env,
  type HookContext,
  type HookInput,
  type HookTrace,
  invokeHook,
  parseHookInput,
  readStdin,
  reportAuthFailed,
} from "../lib/hook-io";
import { hooksStateRoot } from "../lib/identity";
import { hookTimeoutMs, writeFileAtomic } from "../lib/seq";
import { openSession } from "../lib/session";

/** The account an agent runs under when nothing names a profile (SPEC §4.6.11). */
const PRIMARY_ACCOUNT = "primary";
/** At most one publish per this long, unless a percentage moved by more than `MIN_DELTA_PT`. */
export const MIN_INTERVAL_MS = 15_000;
export const MIN_DELTA_PT = 1;
/** Bound on the user's own statusLine command. */
const CHAIN_TIMEOUT_MS = 2_000;
/** Where the install keeps the statusLine it replaced. */
export const CHAIN_FILE = "statusline-chain.json";

export interface UsageWindow {
  pct: number;
  resets_at: string | null;
}

/** usage.schema.json payload. */
export interface UsagePayload {
  account: string | null;
  config_dir?: string;
  model: string | null;
  context_window: { used_percentage: number | null; used: number | null; size: number | null };
  rate_limits: { five_hour?: UsageWindow; weekly?: UsageWindow };
  captured_at: string;
}

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pct = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.min(100, Math.max(0, n));
};
const tokens = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && Number.isSafeInteger(n) && n >= 0 ? n : null;
};

/** A statusLine rate-limit window (`used_percentage`, `resets_at` in epoch seconds). */
function window(v: unknown): UsageWindow | undefined {
  const w = obj(v);
  const p = pct(w.used_percentage);
  if (p === null) return undefined;
  const at = num(w.resets_at);
  return { pct: p, resets_at: at === null ? null : new Date(at * 1000).toISOString() };
}

/**
 * Claude Code's statusLine JSON as a usage payload. `used` is the last request's context: its
 * input plus cache reads and writes (`current_usage`, null before the first request).
 */
export function usageSample(
  input: Record<string, unknown>,
  who: { account: string | null; configDir?: string },
  now: Date,
): UsagePayload {
  const cw = obj(input.context_window);
  const cu = input.context_window !== undefined ? cw.current_usage : null;
  const u = obj(cu);
  const used =
    cu === null || cu === undefined
      ? null
      : tokens(
          (num(u.input_tokens) ?? 0) +
            (num(u.cache_creation_input_tokens) ?? 0) +
            (num(u.cache_read_input_tokens) ?? 0),
        );
  const size = tokens(cw.context_window_size);
  const rl = obj(input.rate_limits);
  const fiveHour = window(rl.five_hour);
  const weekly = window(rl.seven_day);
  const model = obj(input.model).id;
  return {
    account: who.account,
    ...(who.account === null && who.configDir !== undefined ? { config_dir: who.configDir } : {}),
    model: typeof model === "string" && model !== "" ? model : null,
    context_window: {
      used_percentage: pct(cw.used_percentage),
      used,
      size: size !== null && size > 0 ? size : null,
    },
    rate_limits: {
      ...(fiveHour !== undefined ? { five_hour: fiveHour } : {}),
      ...(weekly !== undefined ? { weekly } : {}),
    },
    captured_at: now.toISOString(),
  };
}

/** The last usage this session published (`<stateDir>/usage.json`), for the throttle. */
export interface LastUsage {
  at: number;
  payload: UsagePayload;
}

/** Moved by more than `MIN_DELTA_PT`, or appeared / disappeared. */
function moved(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return a !== b;
  return Math.abs(a - b) > MIN_DELTA_PT;
}

/** Publish `next`: the first sample, 15 s after the last one, or on a change that matters now. */
export function shouldPublish(prev: LastUsage | null, next: UsagePayload, now: number): boolean {
  if (prev === null || now - prev.at >= MIN_INTERVAL_MS) return true;
  const p = prev.payload;
  const a = p.rate_limits;
  const b = next.rate_limits;
  return (
    p.account !== next.account ||
    p.config_dir !== next.config_dir ||
    p.model !== next.model ||
    a.five_hour?.resets_at !== b.five_hour?.resets_at ||
    a.weekly?.resets_at !== b.weekly?.resets_at ||
    moved(p.context_window.used_percentage, next.context_window.used_percentage) ||
    moved(a.five_hour?.pct, b.five_hour?.pct) ||
    moved(a.weekly?.pct, b.weekly?.pct)
  );
}

/** The minimal status line: model, context fill and whichever windows the session reported. */
export function statusText(input: Record<string, unknown>): string {
  const m = obj(input.model);
  const name = typeof m.display_name === "string" ? m.display_name : m.id;
  const parts = [typeof name === "string" && name !== "" ? name : "Claude"];
  const ctx = pct(obj(input.context_window).used_percentage);
  if (ctx !== null) parts.push(`ctx ${Math.round(ctx)}%`);
  const rl = obj(input.rate_limits);
  for (const [label, key] of [
    ["5h", "five_hour"],
    ["7d", "seven_day"],
  ] as const) {
    const w = window(rl[key]);
    if (w !== undefined) parts.push(`${label} ${Math.round(w.pct)}%`);
  }
  return parts.join(" · ");
}

/** The user's own statusLine command, saved by the install, if any. */
function chainedCommand(env: Env): string | null {
  try {
    const c = JSON.parse(readFileSync(join(hooksStateRoot(env), CHAIN_FILE), "utf-8")) as {
      command?: unknown;
    };
    return typeof c.command === "string" && c.command.trim() !== "" ? c.command : null;
  } catch {
    return null;
  }
}

/**
 * What the status line shows: the chained command's stdout, or the minimal line when there is
 * none or it fails. The chained command is the user's own statusLine, run as Claude Code would
 * run it (a shell, the same JSON on stdin), bounded by a 2 s timeout. Like `cmux identify` in
 * session.ts, it runs outside volleyd's authority fence on purpose: this is the agent's own
 * harness, not the supervisor.
 */
export function statusOutput(raw: string, input: HookInput | null, env: Env): string {
  const command = chainedCommand(env);
  if (command !== null) {
    const r = spawnSync("sh", ["-c", command], {
      input: raw,
      encoding: "utf-8",
      timeout: CHAIN_TIMEOUT_MS,
      env,
    });
    if (r.status === 0 && typeof r.stdout === "string") return r.stdout;
  }
  return `${statusText(input ?? {})}\n`;
}

const lastPath = (stateDir: string) => join(stateDir, "usage.json");

function readLast(stateDir: string): LastUsage | null {
  try {
    const l = JSON.parse(readFileSync(lastPath(stateDir), "utf-8")) as LastUsage;
    return typeof l.at === "number" && typeof l.payload === "object" ? l : null;
  } catch {
    return null;
  }
}

/**
 * The account this session runs under: the supervisor's `claude_account` (agent.json), else the
 * primary when no `CLAUDE_CONFIG_DIR` is set; otherwise unknown here (the supervisor maps the
 * published `config_dir` to its profile).
 */
function accountOf(ctx: HookContext): { account: string | null; configDir?: string } {
  if (ctx.identity.claudeAccount !== undefined) return { account: ctx.identity.claudeAccount };
  const dir = ctx.env.CLAUDE_CONFIG_DIR;
  return dir === undefined || dir === ""
    ? { account: PRIMARY_ACCOUNT }
    : { account: null, configDir: dir };
}

export async function handle(ctx: HookContext, now: () => number = Date.now): Promise<null> {
  const payload = usageSample(ctx.input, accountOf(ctx), new Date(now()));
  const { stateDir } = ctx.identity;
  if (!shouldPublish(readLast(stateDir), payload, now())) return null;
  const session = await openSession(ctx.identity, ctx.event, ctx.env);
  try {
    await session.publish(session.topic("usage"), "usage", "usage", payload, {
      qos: 1,
      retain: true,
    });
  } finally {
    await session.close();
  }
  writeFileAtomic(lastPath(stateDir), `${JSON.stringify({ at: now(), payload })}\n`);
  return null;
}

/**
 * Print the status line first (Claude Code shows whatever arrives), then publish. Never fails the
 * status line: a refused CONNACK is recorded in `hooks-error.json` like any hook's, and any other
 * error is swallowed (`VOLLEY_HOOKS_DEBUG=1` shows it on stderr).
 */
async function main(): Promise<void> {
  const env = process.env;
  setTimeout(() => process.exit(0), hookTimeoutMs(env)).unref();
  const raw = await readStdin();
  const out = statusOutput(raw, parseHookInput(raw), env);
  await new Promise<void>((resolve) => process.stdout.write(out, () => resolve()));
  const trace: HookTrace = {};
  try {
    await invokeHook("StatusLine", (ctx) => handle(ctx), raw, env, [], trace);
  } catch (e) {
    if (isAuthFailed(e)) reportAuthFailed("StatusLine", trace, env, e);
    else if (env.VOLLEY_HOOKS_DEBUG === "1")
      process.stderr.write(`volley-hooks StatusLine: ${e}\n`);
  }
  process.exit(0);
}

if (import.meta.main) await main();
