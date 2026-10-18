#!/usr/bin/env bun
/** PostModelSwitch: re-publish the registry entry with `to_model`, heartbeat. */
import { type HookContext, runHook } from "../lib/hook-io";
import { openSession } from "../lib/session";

export async function handle(ctx: HookContext): Promise<string | null> {
  const session = await openSession(ctx.identity, ctx.event);
  try {
    const model = ctx.input.to_model;
    await session.republishRegistry(typeof model === "string" && model !== "" ? model : undefined);
    await session.heartbeat();
    return null;
  } finally {
    await session.close();
  }
}

if (import.meta.main) await runHook("PostModelSwitch", handle);
