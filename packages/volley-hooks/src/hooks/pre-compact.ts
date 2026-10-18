#!/usr/bin/env bun
/**
 * PreCompact: snapshot STEERING.md to `.volley/steering.snapshot.md` (defensive — the file
 * itself survives compaction; SessionStart source=compact re-injects from it), heartbeat.
 */
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { type HookContext, runHook } from "../lib/hook-io";
import { openSession } from "../lib/session";

export async function handle(ctx: HookContext): Promise<string | null> {
  const { stateDir } = ctx.identity;
  const steering = join(stateDir, "STEERING.md");
  if (existsSync(steering)) copyFileSync(steering, join(stateDir, "steering.snapshot.md"));
  const session = await openSession(ctx.identity, ctx.event);
  try {
    await session.heartbeat();
    return null;
  } finally {
    await session.close();
  }
}

if (import.meta.main) await runHook("PreCompact", handle);
