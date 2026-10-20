#!/usr/bin/env bun
/**
 * PreToolUse (matcher "" = every tool): the hook work log (SPEC §4.3 `activity`). Counts the
 * tool call in `work-log.json` (per Claude Code session) and publishes `progress/activity`
 * with a one-line, redacted summary of the call (`Bash: gh pr checks 153`, `Edit: src/x.ts`,
 * …) and `tool_calls`, at most once per 5 s per session. A tick inside that window only
 * updates the file (its summary kept as `pending`, newest wins; PostToolUse publishes it at
 * the next slot) and opens no connection: this hook runs before every tool call. It never
 * changes the tool call (empty output), a work-log failure is ignored (the log is cosmetic),
 * and it needs no heartbeat: PostToolUse sends one.
 */
import { type HookContext, runHook } from "../lib/hook-io";
import { recordActivity, toolSummary, workLogSession } from "../lib/work-log";

export async function handle(ctx: HookContext): Promise<null> {
  const { identity } = ctx;
  const msg = toolSummary(
    ctx.input.tool_name,
    ctx.input.tool_input,
    identity.projectDir,
    ctx.env.HOME,
  );
  const sessionId = workLogSession(ctx.input, identity.agentId);
  let tick: { publish: boolean; tool_calls: number };
  try {
    tick = await recordActivity(identity.stateDir, msg, { toolCall: true, sessionId });
  } catch {
    return null; // a stuck work-log lock: no tick this time
  }
  if (!tick.publish) return null;
  // Loaded only when this tick publishes, so the rate-limited path stays light.
  const { openSession } = await import("../lib/session");
  const session = await openSession(identity, ctx.event, ctx.env);
  try {
    await session.progress("activity", { msg, tool_calls: tick.tool_calls });
  } finally {
    await session.close();
  }
  return null;
}

if (import.meta.main) await runHook("PreToolUse", handle);
