import { describe, expect, it } from "vitest";
import { initialState, reducer } from "../src/state/reducer";
import type { Agent, ChannelKind, DashState, FeedEvent } from "../src/types";

function mkAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    ns: "default",
    status: "working",
    parent: null,
    caps: ["test"],
    msg: "running",
    pct: 50,
    spawnedAt: 1_700_000_000_000,
    lastSeen: 1_700_000_000_000,
    ...overrides,
  };
}

function mkEvent(overrides: Partial<FeedEvent> = {}): Omit<FeedEvent, "fresh"> {
  return {
    id: "ev-1",
    ts: 1_700_000_000_000,
    agent: "agent-1",
    ch: "status",
    type: "tick",
    msg: "heartbeat ok",
    ...overrides,
  };
}

describe("initialState", () => {
  it("is an empty dashboard waiting for data", () => {
    expect(initialState.agents.size).toBe(0);
    expect(initialState.events).toEqual([]);
    expect(initialState.ns).toBe("all");
    expect(initialState.statusFilter).toBe("all");
    expect(initialState.query).toBe("");
    expect(initialState.selectedId).toBeNull();
    expect(initialState.paused).toBe(false);
    expect(initialState.channelFilter).toBe("all");
  });
});

describe("REGISTRY_HYDRATE", () => {
  it("seeds the agents map from a retained registry burst", () => {
    const a = mkAgent({ id: "a1" });
    const b = mkAgent({ id: "b2", status: "done" });
    const next = reducer(initialState, { type: "REGISTRY_HYDRATE", agents: [a, b] });
    expect(next.agents.size).toBe(2);
    expect(next.agents.get("a1")).toEqual(a);
    expect(next.agents.get("b2")).toEqual(b);
  });

  it("replaces any prior agents Map", () => {
    const seed: DashState = {
      ...initialState,
      agents: new Map([["stale", mkAgent({ id: "stale" })]]),
    };
    const fresh = mkAgent({ id: "fresh" });
    const next = reducer(seed, { type: "REGISTRY_HYDRATE", agents: [fresh] });
    expect(next.agents.has("stale")).toBe(false);
    expect(next.agents.get("fresh")).toEqual(fresh);
  });

  it("returns a new Map instance (does not mutate prior state)", () => {
    const next = reducer(initialState, { type: "REGISTRY_HYDRATE", agents: [mkAgent()] });
    expect(next.agents).not.toBe(initialState.agents);
  });
});

describe("AGENT_UPSERT", () => {
  it("inserts a new agent keyed by id", () => {
    const next = reducer(initialState, { type: "AGENT_UPSERT", agent: mkAgent({ id: "new" }) });
    expect(next.agents.get("new")?.id).toBe("new");
  });

  it("replaces an existing agent in-place by id", () => {
    const prior: DashState = {
      ...initialState,
      agents: new Map([["agent-1", mkAgent({ pct: 25 })]]),
    };
    const updated = mkAgent({ pct: 75 });
    const next = reducer(prior, { type: "AGENT_UPSERT", agent: updated });
    expect(next.agents.get("agent-1")?.pct).toBe(75);
    expect(next.agents.size).toBe(1);
  });

  it("returns a fresh Map (functional update, prior state untouched)", () => {
    const prior: DashState = {
      ...initialState,
      agents: new Map([["agent-1", mkAgent()]]),
    };
    const next = reducer(prior, { type: "AGENT_UPSERT", agent: mkAgent({ pct: 99 }) });
    expect(next.agents).not.toBe(prior.agents);
    expect(prior.agents.get("agent-1")?.pct).toBe(50);
  });
});

describe("AGENT_TRANSITION", () => {
  it("updates the status of an existing agent", () => {
    const prior: DashState = {
      ...initialState,
      agents: new Map([["agent-1", mkAgent({ status: "working" })]]),
    };
    const next = reducer(prior, {
      type: "AGENT_TRANSITION",
      id: "agent-1",
      status: "done",
      lastSeen: 1_700_000_001_000,
    });
    expect(next.agents.get("agent-1")?.status).toBe("done");
    expect(next.agents.get("agent-1")?.lastSeen).toBe(1_700_000_001_000);
  });

  it("ignores transitions for unknown agents (defensive)", () => {
    const next = reducer(initialState, {
      type: "AGENT_TRANSITION",
      id: "ghost",
      status: "failed",
      lastSeen: 1_700_000_001_000,
    });
    expect(next.agents.size).toBe(0);
  });

  it("returns a fresh Map (prior state untouched)", () => {
    const prior: DashState = {
      ...initialState,
      agents: new Map([["agent-1", mkAgent()]]),
    };
    const next = reducer(prior, {
      type: "AGENT_TRANSITION",
      id: "agent-1",
      status: "failed",
      lastSeen: 1_700_000_001_000,
    });
    expect(next.agents).not.toBe(prior.agents);
    expect(prior.agents.get("agent-1")?.status).toBe("working");
  });
});

describe("EVENT_RECV", () => {
  it("pushes a new event to the head of the buffer with fresh=true", () => {
    const ev = mkEvent();
    const next = reducer(initialState, { type: "EVENT_RECV", event: ev });
    expect(next.events).toHaveLength(1);
    expect(next.events[0]?.id).toBe(ev.id);
    expect(next.events[0]?.fresh).toBe(true);
  });

  it("keeps newest events at the front (head insert)", () => {
    let state = initialState;
    state = reducer(state, { type: "EVENT_RECV", event: mkEvent({ id: "ev-1", ts: 100 }) });
    state = reducer(state, { type: "EVENT_RECV", event: mkEvent({ id: "ev-2", ts: 200 }) });
    expect(state.events[0]?.id).toBe("ev-2");
    expect(state.events[1]?.id).toBe("ev-1");
  });

  it("caps the ring buffer at 200 and drops the oldest", () => {
    let state = initialState;
    for (let i = 0; i < 250; i++) {
      state = reducer(state, {
        type: "EVENT_RECV",
        event: mkEvent({ id: `ev-${i}`, ts: i }),
      });
    }
    expect(state.events).toHaveLength(200);
    expect(state.events[0]?.id).toBe("ev-249"); // newest at head
    expect(state.events[199]?.id).toBe("ev-50"); // oldest kept
    expect(state.events.find((e) => e.id === "ev-49")).toBeUndefined();
  });
});

describe("EVENT_AGE", () => {
  it("clears the fresh flag on every event", () => {
    let state = initialState;
    state = reducer(state, { type: "EVENT_RECV", event: mkEvent({ id: "ev-1" }) });
    state = reducer(state, { type: "EVENT_RECV", event: mkEvent({ id: "ev-2" }) });
    expect(state.events.every((e) => e.fresh === true)).toBe(true);

    const aged = reducer(state, { type: "EVENT_AGE" });
    expect(aged.events).toHaveLength(2);
    expect(aged.events.every((e) => e.fresh === false)).toBe(true);
  });

  it("is a no-op when the buffer is empty", () => {
    const next = reducer(initialState, { type: "EVENT_AGE" });
    expect(next.events).toEqual([]);
  });
});

describe("filter actions", () => {
  it("FILTER_NAMESPACE sets the namespace filter", () => {
    const next = reducer(initialState, { type: "FILTER_NAMESPACE", ns: "ci" });
    expect(next.ns).toBe("ci");
  });

  it("FILTER_NAMESPACE accepts 'all' to clear", () => {
    const seed = { ...initialState, ns: "ci" };
    const next = reducer(seed, { type: "FILTER_NAMESPACE", ns: "all" });
    expect(next.ns).toBe("all");
  });

  it("FILTER_STATUS sets a status filter", () => {
    const next = reducer(initialState, { type: "FILTER_STATUS", status: "working" });
    expect(next.statusFilter).toBe("working");
  });

  it("FILTER_QUERY sets the search query", () => {
    const next = reducer(initialState, { type: "FILTER_QUERY", query: "coordinator" });
    expect(next.query).toBe("coordinator");
  });

  it("CHANNEL_FILTER_SET sets the channel filter", () => {
    const channel: ChannelKind = "progress";
    const next = reducer(initialState, { type: "CHANNEL_FILTER_SET", channel });
    expect(next.channelFilter).toBe("progress");
  });
});

describe("SELECT_AGENT", () => {
  it("sets the selected agent id", () => {
    const next = reducer(initialState, { type: "SELECT_AGENT", id: "agent-1" });
    expect(next.selectedId).toBe("agent-1");
  });

  it("accepts null to clear selection", () => {
    const seed = { ...initialState, selectedId: "agent-1" };
    const next = reducer(seed, { type: "SELECT_AGENT", id: null });
    expect(next.selectedId).toBeNull();
  });
});

describe("TOGGLE_PAUSE", () => {
  it("flips the paused flag", () => {
    const a = reducer(initialState, { type: "TOGGLE_PAUSE" });
    expect(a.paused).toBe(true);
    const b = reducer(a, { type: "TOGGLE_PAUSE" });
    expect(b.paused).toBe(false);
  });
});

describe("unknown action", () => {
  it("returns the prior state unchanged", () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing unhandled action default
    const next = reducer(initialState, { type: "BOGUS" } as any);
    expect(next).toBe(initialState);
  });
});
