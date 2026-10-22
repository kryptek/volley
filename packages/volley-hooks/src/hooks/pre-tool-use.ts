#!/usr/bin/env bun
/**
 * PreToolUse (matcher "" = every tool): the tool boundary and the hook work log (SPEC §4.3
 * `activity`). Every call publishes `progress/activity` with the call's `tool_use_id` and `tool`,
 * so a supervisor knows a tool is in flight until the PostToolUse carrying the same id (a long
 * foreground test run is not silence). The work log counts the call in `work-log.json` (per
 * Claude Code session) and adds `msg`, a one-line, redacted summary (`Bash: gh pr checks 153`,
 * `Edit: src/x.ts`, …) and `tool_calls`, at most once per 5 s per session; a tick inside that
 * window publishes the boundary alone and keeps its summary as `pending` (newest wins;
 * PostToolUse publishes it at the next slot). It never changes the tool call (empty output), a
 * work-log failure only drops the line (the log is cosmetic), and it needs no heartbeat:
 * PostToolUse sends one. The cost: a broker connect on every call (not once per 5 s), and with
 * the broker unreachable each call can wait out the connect timeout here and in PostToolUse.
 */
import { type HookContext, runHook } from "../lib/hook-io";
import { openSession } from "../lib/session";
import { recordActivity, toolBoundary, toolSummary, workLogSession } from "../lib/work-log";

export async function handle(ctx: HookContext): Promise<null> {
  const { identity } = ctx;
  const msg = toolSummary(
    ctx.input.tool_name,
    ctx.input.tool_input,
    identity.projectDir,
    ctx.env.HOME,
  );
  const sessionId = workLogSession(ctx.input, identity.agentId);
  let line: { msg: string; tool_calls: number } | null = null;
  try {
    const tick = await recordActivity(identity.stateDir, msg, { toolCall: true, sessionId });
    if (tick.publish) line = { msg, tool_calls: tick.tool_calls };
  } catch {
    // a stuck work-log lock: no line this time, the boundary still goes out
  }
  const session = await openSession(identity, ctx.event, ctx.env);
  try {
    await session.progress("activity", { ...line, ...toolBoundary(ctx.input) });
  } finally {
    await session.close();
  }
  return null;
}

if (import.meta.main) await runHook("PreToolUse", handle);
