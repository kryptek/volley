#!/usr/bin/env bun
/**
 * UserPromptSubmit: `resumed` if needed, an `activity` tick `prompt received` (rate-limited
 * with the PreToolUse ticks; the prompt text is never published), mailbox drain + inject +
 * ack, heartbeat.
 */
import { drainHook } from "../lib/drain";
import { type HookContext, runHook } from "../lib/hook-io";
import { PROMPT_RECEIVED, activityTick } from "../lib/work-log";

export function handle(ctx: HookContext): Promise<string | null> {
  return drainHook(ctx, (session) => activityTick(session, PROMPT_RECEIVED, { toolCall: false }));
}

if (import.meta.main) await runHook("UserPromptSubmit", handle);
