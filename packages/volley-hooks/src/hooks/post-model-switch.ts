#!/usr/bin/env bun
/** PostModelSwitch: re-publish the registry entry with `to_model`, heartbeat. */
import { type HookContext, runHook } from "../lib/hook-io";
import { openSession, writeHarnessModel } from "../lib/session";

export async function handle(ctx: HookContext): Promise<string | null> {
  const session = await openSession(ctx.identity, ctx.event);
  try {
    const to = ctx.input.to_model;
    const model = typeof to === "string" && to !== "" ? to : undefined;
    if (model !== undefined) writeHarnessModel(ctx.identity.stateDir, model);
    await session.republishRegistry(model);
    await session.heartbeat();
    return null;
  } finally {
    await session.close();
  }
}

if (import.meta.main) await runHook("PostModelSwitch", handle);
