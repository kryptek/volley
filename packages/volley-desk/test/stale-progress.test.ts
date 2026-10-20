import { describe, expect, it } from "vitest";
import {
  type AttentionCtx,
  STALE_PROGRESS_MS,
  agentAttention,
  staleProgressFor,
  waveAttention,
} from "../src/attention";
import { UNASSIGNED } from "../src/store/reducer";
import type { AgentView, WaveStatePayload, WaveView } from "../src/store/types";

const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const MIN = 60_000;

function agent(id: string, over: Partial<AgentView> = {}): AgentView {
  return {
    id,
    namespace: "default",
    parentId: "coordinator-ab12",
    wave: UNASSIGNED,
    task: null,
    role: null,
    registered: true,
    registry: { capabilities: [], started_at: new Date(NOW - 30 * MIN).toISOString() },
    model: null,
    status: { type: "working", payload: {}, at: NOW - 30 * MIN, seenAt: NOW - 30 * MIN },
    progress: null,
    narration: null,
    // Its hooks are alive: it is not quiet, just not reporting.
    heartbeat: NOW - 10_000,
    lastSeen: NOW - 10_000,
    attention: null,
    attentionObserved: false,
    feed: [],
    screen: null,
    bornAt: null,
    ...over,
  };
}

const ctx = (
  agents: Record<string, AgentView>,
  over: Partial<AttentionCtx> = {},
): AttentionCtx => ({
  now: NOW,
  me: null,
  config: null,
  coordinators: {},
  agents,
  leases: {},
  ...over,
});

function wave(): WaveView {
  const state = {
    wave: "w1",
    version: 1,
    owner: "coord-1",
    repo: "example-org/example-repo",
    release_branch: "release/w1",
    status: "running",
    tasks: [{ id: "T1", issue: 1, stage: "implement", agents: { implementer: "w1-t1-impl-1" } }],
    open_decisions: [],
    gates: [],
    updated_at: new Date(NOW).toISOString(),
    coordinator: {
      agent_id: "coord-1",
      state: "working",
      last_seen: new Date(NOW).toISOString(),
    },
  } as unknown as WaveStatePayload;
  return { id: "w1", state, decisions: {}, receivedAt: NOW };
}

describe("no progress reported for 10 m", () => {
  it("a dispatched agent with no progress of its own for 10 minutes is flagged, at info tier", () => {
    const a = agent("coordinator-8fb2", { reportedAt: NOW - STALE_PROGRESS_MS - 1000 });
    expect(staleProgressFor(a, undefined, ctx({ [a.id]: a }))?.label).toBe(
      "no progress reported for 10 m",
    );
    expect(agentAttention(a, undefined, ctx({ [a.id]: a }))).toEqual({
      tier: "info",
      reason: "no progress reported for 10 m",
    });
  });

  it("not before 10 minutes", () => {
    const a = agent("coordinator-8fb2", { reportedAt: NOW - 9 * MIN });
    expect(staleProgressFor(a, undefined, ctx({ [a.id]: a }))).toBeNull();
  });

  it("hook activity does not count as reported progress; with none ever, it is timed from `working`", () => {
    const a = agent("coordinator-8fb2", {
      lastProgress: { type: "activity", at: NOW - 5000 },
    });
    expect(staleProgressFor(a, undefined, ctx({ [a.id]: a }))?.label).toBe(
      "no progress reported for 30 m",
    );
  });

  it("a session, a finished agent, a waiting agent or a syncing Desk is never flagged", () => {
    const session = agent("coordinator-t7j0", {
      parentId: null,
      registry: {
        capabilities: [],
        started_at: new Date(NOW - 30 * MIN).toISOString(),
        model_source: "harness-hook",
      },
    });
    const done = agent("a-done", { status: { type: "done", payload: {}, at: NOW - 20 * MIN } });
    const waiting = agent("a-wait", {
      attention: { state: "awaiting_input", at: NOW - 20 * MIN, question: "Which one?" },
    });
    const plain = agent("a-plain");
    for (const a of [session, done, waiting]) {
      expect(staleProgressFor(a, undefined, ctx({ [a.id]: a })), a.id).toBeNull();
    }
    expect(staleProgressFor(plain, undefined, ctx({ [plain.id]: plain }, { syncing: true }))).toBe(
      null,
    );
  });

  it("the parent session gets an info item naming the agent", () => {
    const parent = agent("coordinator-ab12", {
      parentId: null,
      registry: {
        capabilities: [],
        started_at: new Date(NOW - 30 * MIN).toISOString(),
        model_source: "harness-hook",
      },
    });
    const child = agent("coordinator-8fb2", {
      registry: {
        capabilities: [],
        started_at: new Date(NOW - 30 * MIN).toISOString(),
        title: "#155 C13 parity — spec review",
      },
    });
    const c = ctx({ [parent.id]: parent, [child.id]: child });
    expect(agentAttention(parent, undefined, c)).toEqual({
      tier: "info",
      reason: "#155 C13 parity — spec review: no progress reported for 30 m",
    });
  });

  it("a wave agent's wave gets the info item", () => {
    const w = wave();
    const a = agent("w1-t1-impl-1", { wave: "w1", task: "T1", role: "implementer" });
    const c = ctx({ [a.id]: a }, { coordinators: {} });
    expect(waveAttention(w, c)).toEqual({
      tier: "info",
      reason: "T1: no progress reported for 30 m",
    });
  });
});
