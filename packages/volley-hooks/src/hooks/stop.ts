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
 *
 * Owner wake (SPEC §4.6.16): a coordinator that owns a wave still running or releasing, at a
 * turn that did not end in a question, waits up to 2 s for the owner-wake waiter's live lock
 * (the two Stop hooks run in parallel); with it, `idle` carries `background_wait: true, wait:
 * "owner_wake"` (a live background task alone: `wait: "background_task"`). With neither, and
 * `stop_hook_active` false, the turn is blocked once (`decision: "block"`) with a `reason` that
 * names the wave and the one `volley sub` command that arms a wait; `idle` then has no flag.
 */
import { type HookContext, type HookResult, clip, questionOf, runHook } from "../lib/hook-io";
import {
  awaitLiveLock,
  blockReason,
  liveLock,
  ownedWavesInFlight,
  readWaveStates,
} from "../lib/owner-waves";
import {
  type WaitKind,
  coordinatorFields,
  hasLiveBackgroundTask,
  openSession,
  writeActivity,
} from "../lib/session";
import { sessionWorkLog, settleWorkLog, workLogSession } from "../lib/work-log";

/** How long Stop waits for the owner-wake waiter (its parallel Stop hook) to take its lock. */
export const LOCK_WAIT_MS = 2000;

export async function handle(ctx: HookContext): Promise<HookResult | null> {
  const message = ctx.input.last_assistant_message;
  const text = clip(message, 500);
  const coordinator = ctx.identity.mode === "coordinator";
  const question = coordinator && typeof message === "string" ? questionOf(message) : null;
  const backgroundTask = question === null && hasLiveBackgroundTask(ctx.input.background_tasks);
  const { stateDir } = ctx.identity;
  const sessionId = workLogSession(ctx.input, ctx.identity.agentId);
  // The work log is cosmetic: a stuck lock falls back to an unlocked read.
  const tool_calls = await settleWorkLog(stateDir, sessionId).catch(
    () => sessionWorkLog(stateDir, sessionId).tool_calls,
  );
  const session = await openSession(ctx.identity, ctx.event, ctx.env);
  try {
    let kind: WaitKind | null = backgroundTask ? "background_task" : null;
    let block: HookResult | null = null;
    if (coordinator && question === null) {
      const owned = ownedWavesInFlight(await readWaveStates(session.broker), ctx.identity.agentId);
      if (owned.length > 0) {
        const armed = backgroundTask
          ? liveLock(stateDir) !== null
          : await awaitLiveLock(stateDir, LOCK_WAIT_MS);
        if (armed) kind = "owner_wake";
        else if (!backgroundTask && ctx.input.stop_hook_active !== true)
          block = { decision: "block", reason: blockReason(owned) };
      }
    }
    const wait = kind !== null ? { background_wait: true as const, wait: kind } : {};
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
    return block;
  } finally {
    await session.close();
  }
}

if (import.meta.main) await runHook("Stop", handle);
