#!/usr/bin/env bun
/**
 * SessionStart: bootstrap the persistent drain session (and inject anything queued), publish
 * the registry entry with the harness-reported `model` (`model_source: "harness-hook"`, or
 * `"unknown"` keeping the last known model when the input has none — non-interactive `-p`
 * sessions omit it), flip a `spawning`/`registered` status (or none at all) to `working`,
 * heartbeat. A coordinator's entry also carries `session_url`, `workspace` and `workspace_title`.
 * The model is remembered in `model.json` so drain hooks can restore it after the MCP
 * server's own register overwrites the entry. On `source` compact or resume, re-inject the live steering
 * directives already delivered, for context only: `cancel`/`nudge`/`query` were one-shot and
 * are not repeated, and nothing asks for a new acknowledgement. Directives never delivered
 * are injected as new mail.
 */
import { join } from "node:path";
import { parseEnvelope } from "volley-mcp/envelope";
import { deliverAfterEmit, formatSteering, openDrainSession, processMail } from "../lib/drain";
import { type HookContext, runHook } from "../lib/hook-io";
import { registryFields, writeHarnessModel } from "../lib/session";
import { liveDirectives } from "../lib/steering-file";

const REINJECT_SOURCES = new Set(["compact", "resume"]);

/** Mailbox types acted on once; repeating them after a compaction would re-trigger them. */
const ONE_SHOT = new Set(["cancel", "nudge", "query"]);

/** At most this many (the newest) directives are re-injected; the rest stay in STEERING.md. */
const REINJECT_MAX = 20;

function reinjection(stateDir: string, source: string): string | null {
  const live = liveDirectives(join(stateDir, "STEERING.md")).filter(
    (b) => b.delivered && !ONE_SHOT.has(b.type),
  );
  if (live.length === 0) return null;
  const shown = live.slice(-REINJECT_MAX);
  const omitted =
    live.length > shown.length
      ? ` (${live.length - shown.length} older one(s) omitted; see .volley/STEERING.md)`
      : "";
  return formatSteering(
    `[volley steering] ${shown.length} directive(s) from your Volley mailbox still in force${omitted}, re-shown after ${source}. They were already delivered and acknowledged: keep following them, no new acknowledgement needed.`,
    shown,
    null,
  );
}

export async function handle(ctx: HookContext): Promise<string | null> {
  const { identity, input } = ctx;
  const model = typeof input.model === "string" && input.model !== "" ? input.model : undefined;
  // A new process without a reported model: whatever an earlier session recorded is stale.
  if (model !== undefined || input.source === "startup") {
    writeHarnessModel(identity.stateDir, model);
  }

  const { session, drained, release } = await openDrainSession(identity, ctx, true);
  let handedOff = false;
  try {
    const parts: string[] = [];
    if (typeof input.source === "string" && REINJECT_SOURCES.has(input.source)) {
      const again = reinjection(identity.stateDir, input.source);
      if (again !== null) parts.push(again);
    }
    if (drained !== null) {
      const mail = await processMail(session, drained);
      if (mail.text !== null) parts.push(mail.text);
      deliverAfterEmit(ctx, identity.stateDir, mail.ids, release);
      handedOff = true;
    }

    await session.republishRegistry(model, registryFields(identity, ctx.env));

    const statusTopic = session.topic("status");
    const raw = await session.broker.queryRetained(statusTopic, 300);
    const status = raw === null ? null : parseEnvelope(raw);
    // No status at all (the agent's MCP server is not on this broker, or not up yet): publish
    // `working` anyway, so a hook-only registration never shows as `unknown`.
    if (status === null || status.type === "spawning" || status.type === "registered") {
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
    if (!handedOff) release();
  }
}

if (import.meta.main) await runHook("SessionStart", handle);
