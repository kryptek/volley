#!/usr/bin/env bun
/**
 * UserPromptSubmit: `resumed` if needed, mailbox drain + inject + ack, heartbeat, then an
 * `activity` tick `prompt received` (rate-limited with the PreToolUse ticks; the prompt text
 * is never published). The tick runs after the steering is processed and fails soft, so a
 * work-log failure never costs drained mail.
 */
import { drainHook } from "../lib/drain";
import { type HookContext, runHook } from "../lib/hook-io";
import { PROMPT_RECEIVED, activityTick, workLogSession } from "../lib/work-log";

export function handle(ctx: HookContext): Promise<string | null> {
  const sessionId = workLogSession(ctx.input, ctx.identity.agentId);
  return drainHook(ctx, (session) =>
    activityTick(session, PROMPT_RECEIVED, { toolCall: false, sessionId }),
  );
}

if (import.meta.main) await runHook("UserPromptSubmit", handle);
