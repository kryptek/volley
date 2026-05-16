/**
 * Pure reducer for the dashboard's `DashState` (handoff README §State
 * Management). Actions cover the full Phase 1 contract: registry hydration,
 * per-agent upsert/transition, ring-buffer event recv/age, and the four
 * filter / selection / pause toggles.
 *
 * Invariants:
 * - `agents` is replaced with a fresh `Map` on every mutation (functional
 *   update; never mutate the prior Map). Identity changes signal React.
 * - `events` is a ring buffer capped at `EVENT_RING_CAP` (200, per handoff
 *   throughput section). Newest events sit at the head.
 */
import type { Agent, AgentId, AgentStatus, ChannelKind, DashState, FeedEvent } from "../types";

export const EVENT_RING_CAP = 200;

export type DashAction =
  | { type: "REGISTRY_HYDRATE"; agents: Agent[] }
  | { type: "AGENT_UPSERT"; agent: Agent }
  | { type: "AGENT_TRANSITION"; id: AgentId; status: AgentStatus; lastSeen: number }
  | { type: "EVENT_RECV"; event: Omit<FeedEvent, "fresh"> }
  | { type: "EVENT_AGE" }
  | { type: "FILTER_NAMESPACE"; ns: string | "all" }
  | { type: "FILTER_STATUS"; status: AgentStatus | "all" }
  | { type: "FILTER_QUERY"; query: string }
  | { type: "SELECT_AGENT"; id: AgentId | null }
  | { type: "TOGGLE_PAUSE" }
  | { type: "CHANNEL_FILTER_SET"; channel: ChannelKind | "all" };

export const initialState: DashState = {
  agents: new Map(),
  events: [],
  ns: "all",
  statusFilter: "all",
  query: "",
  selectedId: null,
  paused: false,
  channelFilter: "all",
};

export function reducer(state: DashState, action: DashAction): DashState {
  switch (action.type) {
    case "REGISTRY_HYDRATE": {
      const next = new Map<AgentId, Agent>();
      for (const a of action.agents) next.set(a.id, a);
      return { ...state, agents: next };
    }
    case "AGENT_UPSERT": {
      const next = new Map(state.agents);
      next.set(action.agent.id, action.agent);
      return { ...state, agents: next };
    }
    case "AGENT_TRANSITION": {
      const existing = state.agents.get(action.id);
      if (existing === undefined) return state;
      const updated: Agent = {
        ...existing,
        status: action.status,
        lastSeen: action.lastSeen,
      };
      const next = new Map(state.agents);
      next.set(action.id, updated);
      return { ...state, agents: next };
    }
    case "EVENT_RECV": {
      const fresh: FeedEvent = { ...action.event, fresh: true };
      const events =
        state.events.length >= EVENT_RING_CAP
          ? [fresh, ...state.events.slice(0, EVENT_RING_CAP - 1)]
          : [fresh, ...state.events];
      return { ...state, events };
    }
    case "EVENT_AGE": {
      if (state.events.length === 0) return state;
      const events = state.events.map((e) => (e.fresh ? { ...e, fresh: false } : e));
      return { ...state, events };
    }
    case "FILTER_NAMESPACE":
      return { ...state, ns: action.ns };
    case "FILTER_STATUS":
      return { ...state, statusFilter: action.status };
    case "FILTER_QUERY":
      return { ...state, query: action.query };
    case "SELECT_AGENT":
      return { ...state, selectedId: action.id };
    case "TOGGLE_PAUSE":
      return { ...state, paused: !state.paused };
    case "CHANNEL_FILTER_SET":
      return { ...state, channelFilter: action.channel };
    default:
      return state;
  }
}
