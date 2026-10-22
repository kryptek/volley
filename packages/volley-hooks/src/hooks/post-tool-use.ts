#!/usr/bin/env bun
/**
 * PostToolUse (matcher "" = every tool): publish `resumed` if the agent was idle or waiting,
 * drain the mailbox into `additionalContext` (acking each message), heartbeat with the call's
 * `tool_use_id` and `tool` (the end of the tool boundary PreToolUse published). Then, on the
 * session already open, the work log's held-back tick: when PreToolUse rate-limited a tick
 * (`pending` in `work-log.json`) and the 5 s window is over, it is published now with the
 * current `tool_calls`, so the last call of a burst is not lost. `VOLLEY_HOOKS_DRAIN_MATCHER`
 * narrows which tools drain.
 */
import { drainHook } from "../lib/drain";
import { type HookContext, runHook } from "../lib/hook-io";
import { flushActivity, workLogSession } from "../lib/work-log";

export function handle(ctx: HookContext): Promise<string | null> {
  const sessionId = workLogSession(ctx.input, ctx.identity.agentId);
  return drainHook(ctx, (session) => flushActivity(session, { sessionId }));
}

if (import.meta.main) await runHook("PostToolUse", handle);
