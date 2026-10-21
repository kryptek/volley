#!/usr/bin/env bun
/**
 * PostToolUse (matcher "AskUserQuestion"): publish `progress/picker_answered { tool_use_id,
 * answers }` (the tool response's question → answer map), whoever picked and wherever, so the
 * supervisor closes the picker's inbox item (SPEC §4.6.18). Empty output.
 */
import { type HookContext, runHook } from "../lib/hook-io";
import { openSession } from "../lib/session";

export async function handle(ctx: HookContext): Promise<null> {
  const { input, identity } = ctx;
  const answers = (input.tool_response as { answers?: unknown } | undefined)?.answers;
  if (input.tool_name !== "AskUserQuestion" || typeof input.tool_use_id !== "string") return null;
  if (typeof answers !== "object" || answers === null || Object.keys(answers).length === 0)
    return null;
  const session = await openSession(identity, ctx.event, ctx.env);
  try {
    await session.progress("picker_answered", { tool_use_id: input.tool_use_id, answers });
  } finally {
    await session.close();
  }
  return null;
}

if (import.meta.main) await runHook("PostToolUse", handle);
