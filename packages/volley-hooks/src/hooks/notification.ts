#!/usr/bin/env bun
/**
 * Notification (side-effect only): `agent_needs_input` / `idle_prompt` / `permission_prompt`
 * → `awaiting_input`; `quota_auto_resume_*` → `awaiting_input` with `class: "credit"`;
 * `agent_completed` → `idle` with `completed: true`; anything else → heartbeat only.
 * Coordinators add `question` (the last Stop's whole question, else the whole message),
 * `session_url` and `workspace`.
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
  const session = await openSession(identity, ctx.event);
  try {
    let state: Activity["state"] | null = null;
    if (AWAITING.has(type) || type.startsWith("quota_auto_resume")) {
      const coordinator: Record<string, unknown> = {};
      if (identity.mode === "coordinator") {
        const question = readActivity(identity.stateDir)?.question ?? boundQuestion(message);
        if (question !== "") coordinator.question = question;
        Object.assign(coordinator, coordinatorFields(identity, ctx.env));
      }
      await session.progress("awaiting_input", {
        ...base,
        ...(AWAITING.has(type) ? {} : { class: "credit" }),
        ...coordinator,
      });
      state = "awaiting_input";
    } else if (type === "agent_completed") {
      await session.progress("idle", { ...base, completed: true });
      state = "idle";
    }
    if (state !== null) {
      const prev = readActivity(identity.stateDir);
      writeActivity(identity.stateDir, {
        state,
        at: new Date().toISOString(),
        hook_event: ctx.event,
        ...(prev?.question !== undefined ? { question: prev.question } : {}),
      });
    }
    await session.heartbeat();
    return null;
  } finally {
    await session.close();
  }
}

if (import.meta.main) await runHook("Notification", handle);
