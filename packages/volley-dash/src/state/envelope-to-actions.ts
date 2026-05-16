/**
 * Translate a parsed (topic, envelope) pair from the MQTT client into the
 * reducer actions the dashboard needs to dispatch. Kept pure + standalone
 * so the wiring in `dashboard-context.tsx` is a thin glue layer.
 *
 * Each incoming MQTT message produces:
 *   - one `EVENT_RECV` (always — every message becomes a feed row)
 *   - zero or one agent action:
 *       • `AGENT_UPSERT` if we've never seen this agent (or if the message
 *         is a retained registry entry, which is the canonical source for
 *         identity-shaped fields like `ns`, `parent`, `caps`)
 *       • `AGENT_TRANSITION` if the agent exists and its status changed
 *       • (no agent action when nothing identity-relevant moved)
 */
import type { ParsedEnvelope } from "../lib/parse-envelope";
import type { ParsedTopic } from "../lib/parse-topic";
import type { Agent, AgentStatus, ChannelKind, DashState, FeedEvent } from "../types";
import type { DashAction } from "./reducer";

const STATUS_TYPES: ReadonlySet<AgentStatus> = new Set([
  "spawning",
  "registered",
  "working",
  "done",
  "blocked",
  "failed",
  "reaped",
]);

function isStatusType(value: string): value is AgentStatus {
  return STATUS_TYPES.has(value as AgentStatus);
}

function envelopeWallTime(envelope: ParsedEnvelope, fallback: number): number {
  if (typeof envelope.wall_time === "string") {
    const parsed = Date.parse(envelope.wall_time);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return fallback;
}

function buildAgent(
  parsed: ParsedTopic,
  envelope: ParsedEnvelope,
  prior: Agent | undefined,
  now: number,
): Agent {
  const wallTime = envelopeWallTime(envelope, now);
  const payload = (envelope.payload ?? {}) as Record<string, unknown>;
  const status: AgentStatus = isStatusType(envelope.type)
    ? envelope.type
    : (prior?.status ?? "registered");
  const caps = Array.isArray(payload.capabilities)
    ? (payload.capabilities as string[])
    : (prior?.caps ?? []);
  const msg = typeof payload.msg === "string" ? payload.msg : (prior?.msg ?? "");
  const pct =
    typeof payload.progress === "number"
      ? payload.progress
      : payload.progress === null
        ? null
        : (prior?.pct ?? null);
  const parent =
    typeof envelope.parent_id === "string"
      ? envelope.parent_id
      : envelope.parent_id === null
        ? null
        : (prior?.parent ?? null);
  // Registry entries (and the first time we see an agent) seed `ns` from the
  // wildcard topic; for `_system/registry` we don't have a real namespace, so
  // fall back to whatever we already knew or to "default".
  const ns = parsed.channel === "system" ? (prior?.ns ?? "default") : parsed.namespace;
  const spawnedAt = prior?.spawnedAt ?? wallTime;
  return {
    id: parsed.agentId,
    ns,
    status,
    parent,
    caps,
    msg,
    pct,
    spawnedAt,
    lastSeen: wallTime,
  };
}

function feedType(parsed: ParsedTopic, envelope: ParsedEnvelope): string {
  // For status messages, the envelope `type` is the lifecycle state ("working",
  // "reaped", etc.); we surface it as the feed row's type so Phase 2 can
  // render `working → done` etc. and tell LWT (`type: "reaped" + payload.reason:
  // "disconnect"`) from a clean shutdown.
  if (parsed.channel === "system") return "register";
  return envelope.type;
}

function feedChannel(parsed: ParsedTopic): ChannelKind {
  return parsed.channel;
}

let evSeq = 0;

function nextEventId(now: number): string {
  evSeq = (evSeq + 1) % 1_000_000;
  return `ev-${now}-${evSeq.toString(36)}`;
}

export interface ActionsFromMessage {
  agentAction: DashAction | null;
  feedEvent: Omit<FeedEvent, "fresh">;
}

export function actionsFromMessage(
  parsed: ParsedTopic,
  envelope: ParsedEnvelope,
  state: DashState,
  now: number = Date.now(),
): ActionsFromMessage {
  const prior = state.agents.get(parsed.agentId);
  const wallTime = envelopeWallTime(envelope, now);

  const feedEvent: Omit<FeedEvent, "fresh"> = {
    id: nextEventId(now),
    ts: wallTime,
    agent: parsed.agentId,
    ch: feedChannel(parsed),
    type: feedType(parsed, envelope),
    msg: extractFeedMsg(envelope),
  };

  // LWT handling: an LWT-published status envelope has type "will". Per the
  // handoff README §Interactions ("this is what surfaces as working → failed
  // via the `will` event type") and Plan Phase 1 §Success criteria, transition
  // the agent to `failed`. The feed event preserves the wire type ("will") via
  // feedType() so the UI can render LWT-originated failures distinctly from
  // graceful failed transitions.
  if (parsed.channel === "status" && envelope.type === "will") {
    if (prior !== undefined && prior.status !== "failed") {
      return {
        agentAction: {
          type: "AGENT_TRANSITION",
          id: parsed.agentId,
          status: "failed",
          lastSeen: wallTime,
        },
        feedEvent,
      };
    }
    // Unseen agent or already-failed: UPSERT with status forced to "failed".
    const agent = buildAgent(parsed, envelope, prior, now);
    return {
      agentAction: { type: "AGENT_UPSERT", agent: { ...agent, status: "failed" } },
      feedEvent,
    };
  }

  // Registry entries and unseen agents always upsert (registry is the canonical
  // identity source).
  if (parsed.channel === "system" || prior === undefined) {
    const agent = buildAgent(parsed, envelope, prior, now);
    return { agentAction: { type: "AGENT_UPSERT", agent }, feedEvent };
  }

  // Known agent + status channel: detect transition vs. tick.
  if (
    parsed.channel === "status" &&
    isStatusType(envelope.type) &&
    envelope.type !== prior.status
  ) {
    return {
      agentAction: {
        type: "AGENT_TRANSITION",
        id: parsed.agentId,
        status: envelope.type,
        lastSeen: wallTime,
      },
      feedEvent,
    };
  }

  // Known agent, progress/mailbox/result, or same-status status tick: fold any
  // new payload fields (msg, pct, caps) into the agent record via UPSERT so
  // the card stays current.
  const agent = buildAgent(parsed, envelope, prior, now);
  return { agentAction: { type: "AGENT_UPSERT", agent }, feedEvent };
}

function extractFeedMsg(envelope: ParsedEnvelope): string {
  const payload = envelope.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const msg = (payload as Record<string, unknown>).msg;
    if (typeof msg === "string") return msg;
  }
  return envelope.type;
}
