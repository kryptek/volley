#!/usr/bin/env bun
/**
 * SessionStart: bootstrap the persistent drain session (and inject anything queued), publish
 * the registry entry with the harness-reported `model` (`model_source: "harness-hook"`, or
 * `"unknown"` keeping the last known model when the input has none — non-interactive `-p`
 * sessions omit it), flip a `spawning`/`registered` status to `working`, heartbeat. On
 * `source` compact or resume, re-inject every live STEERING.md directive.
 */
import { join } from "node:path";
import { parseEnvelope } from "volley-mcp/envelope";
import { formatSteering, openDrainSession, processMail } from "../lib/drain";
import { type HookContext, runHook } from "../lib/hook-io";
import { coordinatorFields } from "../lib/session";
import { liveDirectives } from "../lib/steering-file";

const REINJECT_SOURCES = new Set(["compact", "resume"]);

export async function handle(ctx: HookContext): Promise<string | null> {
  const { identity, input } = ctx;
  const { session, drained } = await openDrainSession(identity, ctx, true);
  try {
    const parts: string[] = [];
    // Re-inject before processing new mail, so a directive is never listed twice.
    if (typeof input.source === "string" && REINJECT_SOURCES.has(input.source)) {
      const live = liveDirectives(join(identity.stateDir, "STEERING.md"));
      if (live.length > 0) {
        parts.push(
          formatSteering(
            `[volley steering] ${live.length} directive(s) still in force from your Volley mailbox (re-injected after ${input.source}), oldest first:`,
            live,
          ),
        );
      }
    }
    if (drained !== null) {
      const fresh = await processMail(session, drained);
      if (fresh !== null) parts.push(fresh);
    }

    const model = typeof input.model === "string" && input.model !== "" ? input.model : undefined;
    await session.republishRegistry(model, coordinatorFields(identity, ctx.env));

    const statusTopic = session.topic("status");
    const raw = await session.broker.queryRetained(statusTopic, 300);
    const status = raw === null ? null : parseEnvelope(raw);
    if (status !== null && (status.type === "spawning" || status.type === "registered")) {
      await session.publish(
        statusTopic,
        "status",
        "working",
        { source: "harness-hook" },
        { qos: 1, retain: true },
      );
    }

    await session.heartbeat();
    return parts.length > 0 ? parts.join("\n\n") : null;
  } finally {
    await session.close();
  }
}

if (import.meta.main) await runHook("SessionStart", handle);
