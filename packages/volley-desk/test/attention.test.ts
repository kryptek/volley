import { describe, expect, it } from "vitest";
import {
  type AttentionCtx,
  DEFAULT_CLAIM_AFTER_S,
  DEFAULT_ESCALATE_AFTER_MIN,
  agentAttention,
  connectedSilence,
  coordinatorFor,
  needsYouTargets,
  tierFor,
  waveAttention,
} from "../src/attention";
import { UNASSIGNED } from "../src/store/reducer";
import type {
  AgentView,
  ConfigPayload,
  CoordinatorState,
  CoordinatorView,
  DecisionPayload,
  DeskState,
  WaveStatePayload,
  WaveView,
} from "../src/store/types";

const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

function wave(over: Partial<WaveStatePayload> = {}, decisions: DecisionPayload[] = []): WaveView {
  const state: WaveStatePayload = {
    wave: "w1",
    version: 1,
    owner: "coord-1",
    repo: "example-org/example-repo",
    release_branch: "release/w1",
    status: "running",
    tasks: [
      { id: "T1", issue: 1, stage: "implement", agents: { implementer: "impl-1" } },
      { id: "T2", issue: 2, stage: "merge_ready", agents: { implementer: "impl-2" } },
    ],
    open_decisions: decisions.map((d) => d.decision_id),
    gates: [],
    updated_at: iso(NOW),
    ...over,
  };
  return {
    id: state.wave,
    state,
    decisions: Object.fromEntries(decisions.map((d) => [d.decision_id, d])),
    receivedAt: NOW,
  };
}

function decision(over: Partial<DecisionPayload> = {}): DecisionPayload {
  return {
    decision_id: "d-1",
    wave: "w1",
    task: "T1",
    kind: "reviewers_disagree",
    question: "Shared or dense ranking?",
    opened_at: iso(NOW - MIN),
    ...over,
  };
}

function agent(id: string, over: Partial<AgentView> = {}): AgentView {
  return {
    id,
    namespace: "default",
    parentId: null,
    wave: "w1",
    task: "T1",
    role: "implementer",
    registered: true,
    registry: null,
    model: null,
    status: { type: "working", payload: {}, at: NOW - MIN },
    progress: null,
    narration: null,
    heartbeat: null,
    lastSeen: NOW - MIN,
    attention: null,
    attentionObserved: false,
    feed: [],
    screen: null,
    bornAt: null,
    ...over,
  };
}

function coord(state: CoordinatorState, over: Partial<CoordinatorView> = {}): CoordinatorView {
  return { id: "coord-1", waves: ["w1"], state, ...over };
}

function ctx(over: Partial<AttentionCtx> = {}): AttentionCtx {
  return {
    now: NOW,
    me: null,
    config: null,
    coordinators: { "coord-1": coord("working") },
    agents: { "coord-1": agent("coord-1", { wave: UNASSIGNED, task: null, role: null }) },
    leases: {},
    ...over,
  };
}

const config = (over: Partial<ConfigPayload>): ConfigPayload => ({
  version: 1,
  updated_at: iso(NOW),
  updated_by: "owner",
  ...over,
});

describe("a wave the Desk itself owns (claimed; P2-11)", () => {
  // After `claim` the owner is the Desk's broker identity, which has no agent of its own.
  const own = (over: Partial<WaveStatePayload> = {}, decisions: DecisionPayload[] = []) =>
    wave({ owner: "desk", ...over }, decisions);
  const deskCtx = (over: Partial<AttentionCtx> = {}) =>
    ctx({ identity: "desk", coordinators: { desk: coord("gone", { id: "desk" }) }, ...over });

  it("has a coordinator: the person at this Desk", () => {
    expect(coordinatorFor(own(), deskCtx())).toMatchObject({ id: "desk", state: "working" });
    expect(waveAttention(own(), deskCtx())).toEqual({ tier: "none" });
  });

  it("puts its open decisions and merge-ready gates on you, not on a coordinator", () => {
    expect(waveAttention(own({}, [decision()]), deskCtx())).toEqual({
      tier: "you",
      reason: "Decision: Shared or dense ranking?",
    });
    expect(waveAttention(own({ gates: ["T2"] }), deskCtx())).toMatchObject({ tier: "you" });
    const blocked = agent("impl-1", { status: { type: "blocked", payload: {}, at: NOW } });
    expect(agentAttention(blocked, own(), deskCtx()).tier).toBe("you");
  });

  it("another browser (another identity) still sees a wave nobody coordinates", () => {
    expect(waveAttention(own(), deskCtx({ identity: "desk-phone" })).tier).toBe("you");
  });
});

describe("defaults", () => {
  it("match volleyd's claim_after_s and the prototype's escalate_after_min", () => {
    expect(DEFAULT_CLAIM_AFTER_S).toBe(1800);
    expect(DEFAULT_ESCALATE_AFTER_MIN).toBe(15);
  });
});

describe("tierFor(wave)", () => {
  const rows: [string, WaveView, Partial<AttentionCtx>, string][] = [
    ["working coordinator, nothing open", wave(), {}, "none"],
    [
      "coordinator awaiting input",
      wave(),
      { coordinators: { "coord-1": coord("awaiting_input", { question: "Merge T2?" }) } },
      "you",
    ],
    ["coordinator gone (reaped)", wave(), { coordinators: { "coord-1": coord("gone") } }, "you"],
    ["no owner at all", wave({ owner: null }), { coordinators: {} }, "you"],
    ["open decision, live coordinator", wave({}, [decision()]), {}, "coordinator"],
    ["open decision on a wave this browser owns", wave({}, [decision()]), { me: "coord-1" }, "you"],
    [
      "resolved decision is not open",
      wave({}, [decision({ resolved: { answer: "a", by: "x", at: iso(NOW) } })]),
      {},
      "none",
    ],
    ["merge-ready gate, live coordinator", wave({ gates: ["T2"] }), {}, "coordinator"],
    [
      "open PR is info",
      wave({
        tasks: [
          {
            id: "T1",
            issue: 1,
            stage: "spec_review",
            agents: {},
            pr: { number: 7, url: "https://example.invalid/pr/7" },
          },
        ],
      }),
      {},
      "info",
    ],
    [
      "lease wait is info",
      wave({
        tasks: [
          { id: "T1", issue: 1, stage: "queued", agents: {}, why_waiting: "waiting for lease ci" },
        ],
      }),
      {},
      "info",
    ],
    [
      "complete wave needs nobody",
      wave({ status: "complete" }),
      { coordinators: { "coord-1": coord("gone") } },
      "none",
    ],
    ["wave state not yet arrived", { ...wave(), state: null }, {}, "none"],
  ];
  it.each(rows)("%s → %s", (_name, w, over, tier) => {
    expect(tierFor(w, ctx(over))).toBe(tier);
  });

  it("escalates a coordinator-tier decision to you after escalate_after_min", () => {
    const w = wave({}, [decision({ opened_at: iso(NOW - 16 * MIN) })]);
    expect(tierFor(w, ctx())).toBe("you");
    // The config-driven rows below anticipate `escalate_after_min` becoming a
    // SPEC §4.6.4 tunable; today volleyd never publishes it, so 15 min applies.
    expect(tierFor(w, ctx({ config: config({ escalate_after_min: 20 }) }))).toBe("coordinator");
    // A per-wave override wins over the global config.
    const local = wave({ effective_config: { escalate_after_min: 10 } }, [
      decision({ opened_at: iso(NOW - 12 * MIN) }),
    ]);
    expect(tierFor(local, ctx({ config: config({ escalate_after_min: 20 }) }))).toBe("you");
    expect(waveAttention(w, ctx()).reason).toMatch(/16 min/);
  });

  it("escalates a gate by when this browser first saw it", () => {
    const w = wave({ gates: ["T2"] });
    expect(tierFor(w, ctx({ gateSince: { "w1/T2": NOW - 14 * MIN } }))).toBe("coordinator");
    expect(tierFor(w, ctx({ gateSince: { "w1/T2": NOW - 15 * MIN } }))).toBe("you");
  });

  it("does not count time the Desk was offline as coordinator silence", () => {
    const quiet = { agents: { "coord-1": agent("coord-1", { lastSeen: NOW - 40 * MIN }) } };
    expect(tierFor(wave(), ctx(quiet))).toBe("you");
    // Offline for the last 20 min (and still): only 20 min of connected silence.
    expect(tierFor(wave(), ctx({ ...quiet, offline: [{ from: NOW - 20 * MIN, to: null }] }))).toBe(
      "none",
    );
    // A closed span counts the same; one before lastSeen does not help.
    expect(
      tierFor(wave(), ctx({ ...quiet, offline: [{ from: NOW - 30 * MIN, to: NOW - 15 * MIN }] })),
    ).toBe("none");
    expect(
      tierFor(wave(), ctx({ ...quiet, offline: [{ from: NOW - 90 * MIN, to: NOW - 50 * MIN }] })),
    ).toBe("you");
    expect(connectedSilence(NOW - 10 * MIN, NOW, [{ from: NOW - 5 * MIN, to: null }])).toBe(
      5 * MIN,
    );
  });

  it("treats a quiet coordinator as gone after claim_after_s", () => {
    const quiet = (ms: number) => ({
      agents: { "coord-1": agent("coord-1", { lastSeen: NOW - ms }) },
    });
    expect(tierFor(wave(), ctx(quiet(29 * MIN)))).toBe("none");
    expect(tierFor(wave(), ctx(quiet(31 * MIN)))).toBe("you");
    expect(coordinatorFor(wave(), ctx(quiet(31 * MIN))).state).toBe("gone");
    // A heartbeat keeps it alive.
    const beating = {
      agents: { "coord-1": agent("coord-1", { lastSeen: NOW - 40 * MIN, heartbeat: NOW - MIN }) },
    };
    expect(tierFor(wave(), ctx(beating))).toBe("none");
    // claim_after_s comes from the retained config.
    expect(
      tierFor(wave(), ctx({ ...quiet(31 * MIN), config: config({ claim_after_s: 3600 }) })),
    ).toBe("none");
    // Only the supervisor's view: its last_seen counts.
    const sup = wave({
      coordinator: { agent_id: "coord-1", state: "working", last_seen: iso(NOW - 45 * MIN) },
    });
    expect(tierFor(sup, ctx({ agents: {} }))).toBe("you");
  });

  it("keeps awaiting_input over staleness: the coordinator waits quietly for an answer", () => {
    const c = ctx({
      coordinators: { "coord-1": coord("awaiting_input") },
      agents: { "coord-1": agent("coord-1", { lastSeen: NOW - 90 * MIN }) },
    });
    expect(coordinatorFor(wave(), c).state).toBe("awaiting_input");
  });

  it("explains why: the question, or how long the coordinator has been gone", () => {
    const asked = ctx({
      coordinators: { "coord-1": coord("awaiting_input", { question: "Merge T2?" }) },
    });
    expect(waveAttention(wave(), asked)).toMatchObject({ tier: "you", reason: "Merge T2?" });
    const gone = ctx({ agents: { "coord-1": agent("coord-1", { lastSeen: NOW - 34 * MIN }) } });
    expect(waveAttention(wave(), gone).reason).toMatch(/no coordinator for 34 min/i);
  });
});

describe("tierFor(agent, wave)", () => {
  const blocked = { type: "blocked", payload: { reason: "rebase conflict" }, at: NOW - MIN };
  const rows: [string, AgentView, WaveView | undefined, Partial<AttentionCtx>, string][] = [
    ["working agent", agent("impl-1"), wave(), {}, "none"],
    ["blocked, live coordinator", agent("impl-1", { status: blocked }), wave(), {}, "coordinator"],
    [
      "blocked, coordinator gone",
      agent("impl-1", { status: blocked }),
      wave(),
      { coordinators: { "coord-1": coord("gone") } },
      "you",
    ],
    [
      "blocked, no wave",
      agent("solo", { status: blocked, wave: UNASSIGNED, task: null }),
      undefined,
      {},
      "you",
    ],
    [
      "awaiting input counts like blocked",
      agent("impl-1", { attention: { state: "awaiting_input", at: NOW - MIN } }),
      wave(),
      {},
      "coordinator",
    ],
    [
      "a finished agent's leftover awaiting_input",
      agent("impl-1", {
        status: { type: "done", payload: {}, at: NOW },
        attention: { state: "awaiting_input", at: NOW - MIN },
      }),
      wave(),
      {},
      "none",
    ],
    ["open decision on its task", agent("impl-1"), wave({}, [decision()]), {}, "coordinator"],
    [
      "open decision on its task, coordinator gone",
      agent("impl-1"),
      wave({}, [decision()]),
      { coordinators: { "coord-1": coord("gone") } },
      "you",
    ],
    [
      "its task at the merge-ready gate",
      agent("impl-2", { task: "T2" }),
      wave({ gates: ["T2"] }),
      {},
      "coordinator",
    ],
    [
      "queued for a lease",
      agent("impl-1"),
      wave(),
      {
        leases: {
          ci: {
            pool: "ci",
            capacity: 1,
            held: [],
            queue: [{ lease_id: "l1", holder: "impl-1", since: iso(NOW) }],
            reasons: [],
          },
        },
      },
      "info",
    ],
  ];
  it.each(rows)("%s → %s", (_name, a, w, over, tier) => {
    expect(tierFor(a, w, ctx(over))).toBe(tier);
  });

  it("escalates a blocked agent after escalate_after_min", () => {
    const old = agent("impl-1", { status: { type: "blocked", payload: {}, at: NOW - 20 * MIN } });
    expect(tierFor(old, wave(), ctx())).toBe("you");
    expect(agentAttention(old, wave(), ctx()).reason).toMatch(/blocked/i);
  });

  it("says why it is blocked, without doubling the word", () => {
    const why = (payload: unknown) =>
      agentAttention(
        agent("impl-1", { status: { type: "blocked", payload, at: NOW } }),
        wave(),
        ctx(),
      ).reason;
    expect(why({ reason: "rebase conflict" })).toBe("Blocked: rebase conflict");
    expect(why({ msg: "Blocked: should ties share a rank?" })).toBe(
      "Blocked: should ties share a rank?",
    );
    expect(why({})).toBe("Blocked");
  });
});

describe("needsYouTargets", () => {
  it("lists you-tier waves, then you-tier agents outside them, for the pill and dock badge", () => {
    const gone = wave({ wave: "w2", owner: "coord-2" });
    const fine = wave();
    const state: DeskState = {
      waves: { w1: fine, w2: { ...gone, id: "w2" } },
      agents: {
        "impl-1": agent("impl-1", {
          status: { type: "blocked", payload: {}, at: NOW - 20 * MIN },
        }),
        "impl-9": agent("impl-9", {
          wave: "w2",
          status: { type: "blocked", payload: {}, at: NOW },
        }),
        "coord-1": agent("coord-1", { wave: UNASSIGNED, task: null, role: null }),
      },
      coordinators: {
        "coord-1": coord("working"),
        "coord-2": coord("gone", { id: "coord-2", waves: ["w2"] }),
      },
      supervisors: {},
      config: null,
      leases: {},
      admission: null,
    };
    expect(needsYouTargets(state, { now: NOW, me: null })).toEqual([
      { kind: "wave", id: "w2", wave: "w2" },
      { kind: "agent", id: "impl-1", wave: "w1" },
    ]);
  });
});
