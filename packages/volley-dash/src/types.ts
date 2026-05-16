/**
 * Dashboard state vocabulary — ported verbatim from the design handoff
 * (`README.md` §State Management). These types describe what the reducer
 * holds and what it dispatches over; Phase 1 fills in the reducer + MQTT
 * subscription wiring that produces values matching this shape.
 */

export type AgentId = string;

export type AgentStatus =
  | "spawning"
  | "registered"
  | "working"
  | "done"
  | "blocked"
  | "failed"
  | "reaped";

export type ChannelKind = "status" | "progress" | "mailbox" | "result" | "system";

export interface Agent {
  id: AgentId;
  ns: string; // namespace
  status: AgentStatus;
  parent: AgentId | null;
  caps: string[]; // capability tags
  msg: string; // latest progress message
  pct: number | null; // 0-100 or null
  spawnedAt: number; // ms epoch
  lastSeen: number; // ms epoch
}

export interface FeedEvent {
  id: string; // ev-<ts>-<seq>
  ts: number; // ms epoch
  agent: AgentId;
  ch: ChannelKind;
  type: string; // tick, transition, progress, inbox, outbox, will, register, result
  msg: string;
  fresh?: boolean; // true for ~400ms after recv, drives row-flash animation
}

export interface DashState {
  agents: Map<AgentId, Agent>; // by id, never re-allocate
  events: FeedEvent[]; // ring buffer, max 200
  ns: string | "all";
  statusFilter: AgentStatus | "all";
  query: string;
  selectedId: AgentId | null;
  paused: boolean;
  channelFilter: ChannelKind | "all";
}
