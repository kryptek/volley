import { describe, expect, it } from "vitest";
import type { ParsedEnvelope } from "../src/lib/parse-envelope";
import type { ParsedTopic } from "../src/lib/parse-topic";
import { actionsFromMessage } from "../src/state/envelope-to-actions";
import { initialState } from "../src/state/reducer";
import type { Agent, DashState } from "../src/types";

function topic(partial: Partial<ParsedTopic> = {}): ParsedTopic {
  return {
    namespace: "default",
    agentId: "agent-1",
    channel: "status",
    ...partial,
  };
}

function envelope(partial: Partial<ParsedEnvelope> = {}): ParsedEnvelope {
  return {
    schema_version: "0.1",
    agent_id: "agent-1",
    parent_id: null,
    wall_time: "2026-05-16T12:00:00.000Z",
    channel: "status",
    type: "working",
    payload: {},
    ...partial,
  };
}

function stateWith(agents: Agent[]): DashState {
  const map = new Map<string, Agent>();
  for (const a of agents) map.set(a.id, a);
  return { ...initialState, agents: map };
}

function agent(partial: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    ns: "default",
    status: "working",
    parent: null,
    caps: [],
    msg: "",
    pct: null,
    spawnedAt: 0,
    lastSeen: 0,
    ...partial,
  };
}

describe("actionsFromMessage — LWT will-handling", () => {
  it("transitions a known working agent to failed when a will envelope arrives", () => {
    const state = stateWith([agent({ status: "working" })]);
    const { agentAction, feedEvent } = actionsFromMessage(
      topic({ channel: "status" }),
      envelope({ type: "will", payload: { reason: "disconnect" } }),
      state,
    );
    expect(agentAction).toEqual({
      type: "AGENT_TRANSITION",
      id: "agent-1",
      status: "failed",
      lastSeen: Date.parse("2026-05-16T12:00:00.000Z"),
    });
    // Feed event preserves the wire type so the UI can distinguish LWT-origin
    // from graceful failures.
    expect(feedEvent.type).toBe("will");
  });

  it("UPSERTs to failed when a will envelope arrives for an unseen agent", () => {
    const state = stateWith([]);
    const { agentAction, feedEvent } = actionsFromMessage(
      topic({ channel: "status", agentId: "ghost-7a3f" }),
      envelope({ agent_id: "ghost-7a3f", type: "will" }),
      state,
    );
    expect(agentAction?.type).toBe("AGENT_UPSERT");
    if (agentAction?.type === "AGENT_UPSERT") {
      expect(agentAction.agent.id).toBe("ghost-7a3f");
      expect(agentAction.agent.status).toBe("failed");
    }
    expect(feedEvent.type).toBe("will");
  });

  it("UPSERTs to failed (no transition) when an already-failed agent receives a will", () => {
    const state = stateWith([agent({ status: "failed" })]);
    const { agentAction } = actionsFromMessage(
      topic({ channel: "status" }),
      envelope({ type: "will" }),
      state,
    );
    // Don't emit a no-op AGENT_TRANSITION; UPSERT keeps the record consistent.
    expect(agentAction?.type).toBe("AGENT_UPSERT");
  });
});

describe("actionsFromMessage — registry + transition basics", () => {
  it("UPSERTs an unseen agent from a registry envelope", () => {
    const state = stateWith([]);
    const { agentAction } = actionsFromMessage(
      topic({ channel: "system", namespace: "_system" }),
      envelope({ channel: "_system/registry", type: "registered" }),
      state,
    );
    expect(agentAction?.type).toBe("AGENT_UPSERT");
    if (agentAction?.type === "AGENT_UPSERT") {
      expect(agentAction.agent.status).toBe("registered");
    }
  });

  it("TRANSITIONs when a known agent's status channel reports a new state", () => {
    const state = stateWith([agent({ status: "working" })]);
    const { agentAction } = actionsFromMessage(
      topic({ channel: "status" }),
      envelope({ type: "done" }),
      state,
    );
    expect(agentAction).toMatchObject({
      type: "AGENT_TRANSITION",
      id: "agent-1",
      status: "done",
    });
  });

  it("UPSERTs (no TRANSITION) when a known agent's status is unchanged", () => {
    const state = stateWith([agent({ status: "working" })]);
    const { agentAction } = actionsFromMessage(
      topic({ channel: "status" }),
      envelope({ type: "working" }),
      state,
    );
    expect(agentAction?.type).toBe("AGENT_UPSERT");
  });

  it("UPSERTs to fold progress fields into a known agent", () => {
    const state = stateWith([agent({ status: "working", msg: "old", pct: 20 })]);
    const { agentAction } = actionsFromMessage(
      topic({ channel: "progress" }),
      envelope({ channel: "progress", type: "tick", payload: { msg: "new", progress: 50 } }),
      state,
    );
    expect(agentAction?.type).toBe("AGENT_UPSERT");
    if (agentAction?.type === "AGENT_UPSERT") {
      expect(agentAction.agent.msg).toBe("new");
      expect(agentAction.agent.pct).toBe(50);
    }
  });
});
