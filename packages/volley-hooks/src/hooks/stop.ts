#!/usr/bin/env bun
/**
 * Stop: publish `idle` with the last assistant message (first 500 chars). For a coordinator
 * whose turn ends in a question, also `awaiting_input` with the whole `question` (read from
 * the unclipped message), `session_url` and `workspace` (SPEC §4.3) — cleared by `resumed` on
 * the next prompt or tool call. When Stop's `background_tasks` lists a task still running (a
 * `volley wait` armed in the background) and the turn did not end in a question, `idle`
 * carries `background_wait: true` and it is recorded in `activity.json` for the idle
 * notification that follows: the session waits on events, not on a person. A question is
 * always one, background task or not. `idle` also carries `tool_calls` (this session's count
 * in the work log, whose pending tick is dropped). Heartbeat.
 */
import { type HookContext, clip, questionOf, runHook } from "../lib/hook-io";
import {
  coordinatorFields,
  hasLiveBackgroundTask,
  openSession,
  writeActivity,
} from "../lib/session";
import { sessionWorkLog, settleWorkLog, workLogSession } from "../lib/work-log";

export async function handle(ctx: HookContext): Promise<string | null> {
  const message = ctx.input.last_assistant_message;
  const text = clip(message, 500);
  const question =
    ctx.identity.mode === "coordinator" && typeof message === "string" ? questionOf(message) : null;
  const wait =
    question === null && hasLiveBackgroundTask(ctx.input.background_tasks)
      ? { background_wait: true as const }
      : {};
  const { stateDir } = ctx.identity;
  const sessionId = workLogSession(ctx.input, ctx.identity.agentId);
  // The work log is cosmetic: a stuck lock falls back to an unlocked read.
  const tool_calls = await settleWorkLog(stateDir, sessionId).catch(
    () => sessionWorkLog(stateDir, sessionId).tool_calls,
  );
  const session = await openSession(ctx.identity, ctx.event, ctx.env);
  try {
    await session.progress("idle", {
      ...(text !== undefined ? { text } : {}),
      ...wait,
      tool_calls,
    });
    if (question !== null) {
      await session.progress("awaiting_input", {
        question,
        ...(text !== undefined ? { text } : {}),
        ...coordinatorFields(ctx.identity, ctx.env),
      });
    }
    writeActivity(ctx.identity.stateDir, {
      state: question !== null ? "awaiting_input" : "idle",
      at: new Date().toISOString(),
      hook_event: ctx.event,
      ...(question !== null ? { question } : {}),
      ...wait,
    });
    await session.heartbeat();
    return null;
  } finally {
    await session.close();
  }
}

if (import.meta.main) await runHook("Stop", handle);
