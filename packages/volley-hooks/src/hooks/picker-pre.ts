#!/usr/bin/env bun
/**
 * PreToolUse (matcher "AskUserQuestion"): publish `progress/picker_opened { tool_use_id,
 * questions }` (the tool input's questions, verbatim) so the supervisor opens a needs-you inbox
 * item for the picker (SPEC §4.6.18); a coordinator's also carries its `session_url` /
 * `workspace`. It never changes or blocks the tool call (empty output).
 */
import { type HookContext, runHook } from "../lib/hook-io";
import { coordinatorFields, openSession } from "../lib/session";

export async function handle(ctx: HookContext): Promise<null> {
  const { input, identity } = ctx;
  const questions = (input.tool_input as { questions?: unknown } | undefined)?.questions;
  if (input.tool_name !== "AskUserQuestion" || typeof input.tool_use_id !== "string") return null;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const session = await openSession(identity, ctx.event, ctx.env);
  try {
    await session.progress("picker_opened", {
      tool_use_id: input.tool_use_id,
      questions,
      ...coordinatorFields(identity, ctx.env),
    });
  } finally {
    await session.close();
  }
  return null;
}

if (import.meta.main) await runHook("PreToolUse", handle);
