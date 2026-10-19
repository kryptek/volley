#!/usr/bin/env bun
/**
 * Notification (side-effect only): `agent_needs_input` / `idle_prompt` / `permission_prompt`
 * → `awaiting_input`; `quota_auto_resume_*` → `awaiting_input` with `class: "credit"`;
 * `agent_completed` → `idle` with `completed: true`; anything else → heartbeat only.
 * Coordinators add `question` (the last Stop's whole question, else the whole message),
 * `session_url` and `workspace`. An `idle_prompt` after a Stop
 * that left a background task running carries `background_wait: true`: the session waits on
 * that task's events, not on a person.
 */
import { type HookContext, boundQuestion, clip, runHook } from "../lib/hook-io";
import {
  type Activity,
  coordinatorFields,
  openSession,
  readActivity,
  writeActivity,
} from "../lib/session";

const AWAITING = new Set(["agent_needs_input", "idle_prompt", "permission_prompt"]);

export async function handle(ctx: HookContext): Promise<string | null> {
  const type = typeof ctx.input.notification_type === "string" ? ctx.input.notification_type : "";
  const message = typeof ctx.input.message === "string" ? ctx.input.message.trim() : "";
  const text = clip(ctx.input.message, 500);
  const base = { notification_type: type, ...(text !== undefined ? { text } : {}) };
  const { identity } = ctx;
  const session = await openSession(identity, ctx.event, ctx.env);
  try {
    let state: Activity["state"] | null = null;
    const prev = readActivity(identity.stateDir);
    // Only the idle prompt: a permission prompt or a direct question always wants a person.
    const wait = prev?.background_wait === true && type === "idle_prompt";
    if (AWAITING.has(type) || type.startsWith("quota_auto_resume")) {
      const coordinator: Record<string, unknown> = {};
      if (identity.mode === "coordinator") {
        const question = prev?.question ?? boundQuestion(message);
        if (question !== "") coordinator.question = question;
        Object.assign(coordinator, coordinatorFields(identity, ctx.env));
      }
      await session.progress("awaiting_input", {
        ...base,
        ...(AWAITING.has(type) ? {} : { class: "credit" }),
        ...(wait ? { background_wait: true } : {}),
        ...coordinator,
      });
      state = "awaiting_input";
    } else if (type === "agent_completed") {
      await session.progress("idle", { ...base, completed: true });
      state = "idle";
    }
    if (state !== null) {
      writeActivity(identity.stateDir, {
        state,
        at: new Date().toISOString(),
        hook_event: ctx.event,
        ...(prev?.question !== undefined ? { question: prev.question } : {}),
        ...(prev?.background_wait === true ? { background_wait: true } : {}),
      });
    }
    await session.heartbeat();
    return null;
  } finally {
    await session.close();
  }
}

if (import.meta.main) await runHook("Notification", handle);
