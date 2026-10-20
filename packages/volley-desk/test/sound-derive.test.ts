/** `deriveSoundEvents`: which sound events a store change means. */
import { describe, expect, it } from "vitest";
import { type SoundCtx, deriveSoundEvents } from "../src/sounds/derive";
import { initialState } from "../src/store/reducer";
import type {
  AgentView,
  DecisionPayload,
  DeskState,
  MachinePayload,
  WaveStatePayload,
  WaveTask,
} from "../src/store/types";

const NOW = 1_000_000;
const ctx = (over: Partial<SoundCtx> = {}): SoundCtx => ({
  now: NOW,
  settling: false,
  connection: "connected",
  prevConnection: "connected",
  ...over,
});

const agent = (id: string, over: Partial<AgentView> = {}): AgentView => ({
  id,
  namespace: "default",
  parentId: null,
  wave: "w1",
  task: "t1",
  role: "implementer",
  registered: true,
  registry: null,
  model: null,
  status: null,
  progress: null,
  narration: null,
  heartbeat: null,
  lastSeen: NOW,
  attention: null,
  attentionObserved: false,
  feed: [],
  screen: null,
  bornAt: NOW - 60_000,
  ...over,
});

const status = (type: string) => ({ type, payload: {}, at: NOW });

const task = (over: Partial<WaveTask> = {}): WaveTask => ({
  id: "t1",
  issue: 1,
  stage: "implement",
  agents: {},
  ...over,
});

const waveState = (over: Partial<WaveStatePayload> = {}): WaveStatePayload => ({
  wave: "w1",
  version: 1,
  owner: null,
  repo: "example/repo",
  release_branch: "release/x",
  status: "running",
  tasks: [task()],
  open_decisions: [],
  gates: [],
  updated_at: "2026-10-19T00:00:00Z",
  ...over,
});

const decision = (over: Partial<DecisionPayload> = {}): DecisionPayload => ({
  decision_id: "d1",
  wave: "w1",
  task: "t1",
  kind: "agent_question",
  question: "?",
  opened_at: "2026-10-19T00:00:00Z",
  ...over,
});

function desk(
  parts: {
    agents?: AgentView[];
    wave?: WaveStatePayload | null;
    decisions?: DecisionPayload[];
    machines?: MachinePayload[];
  } = {},
): DeskState {
  const s = initialState();
  for (const a of parts.agents ?? []) s.agents[a.id] = a;
  if (parts.wave !== undefined || parts.decisions)
    s.waves.w1 = {
      id: "w1",
      state: parts.wave ?? null,
      decisions: Object.fromEntries((parts.decisions ?? []).map((d) => [d.decision_id, d])),
      receivedAt: NOW,
    };
  if (parts.machines) s.machines = Object.fromEntries(parts.machines.map((m) => [m.name, m]));
  return s;
}

const machine = (tunnel: "up" | "down"): MachinePayload => ({
  name: "m1",
  os: "linux",
  cores: 8,
  tunnel,
  load: [0, 0, 0],
  agents: 0,
  last_seen: "2026-10-19T00:00:00Z",
});

describe("deriveSoundEvents", () => {
  it("is pure: the same inputs give the same output", () => {
    const a = desk({ agents: [agent("a", { status: status("working") })] });
    const b = desk({ agents: [agent("a", { status: status("done") })] });
    expect(deriveSoundEvents(a, b, ctx())).toEqual(deriveSoundEvents(a, b, ctx()));
  });

  it("derives nothing while settling or from the first state", () => {
    const b = desk({ agents: [agent("a", { bornAt: NOW, status: status("done") })] });
    expect(deriveSoundEvents(desk(), b, ctx({ settling: true }))).toEqual([]);
    expect(deriveSoundEvents(null, b, ctx())).toEqual([]);
  });

  it("maps agent status transitions", () => {
    const from = (was: string | null, to: string, role: AgentView["role"] = "implementer") =>
      deriveSoundEvents(
        desk({ agents: [agent("a", { role, status: was ? status(was) : null })] }),
        desk({ agents: [agent("a", { role, status: status(to) })] }),
        ctx(),
      );
    expect(from("working", "done")).toEqual(["agent_complete"]);
    expect(from("working", "failed")).toEqual(["agent_failed"]);
    expect(from("working", "blocked")).toEqual(["agent_failed"]);
    expect(from("working", "reaped")).toEqual(["agent_reaped"]);
    expect(from("registered", "working")).toEqual(["agent_working"]);
    expect(from(null, "working")).toEqual(["agent_working"]);
    expect(from("awaiting_input", "working")).toEqual([]);
    expect(from("done", "done")).toEqual([]);
  });

  it("a reviewer reaching done is both agent_complete and review_written", () => {
    const out = deriveSoundEvents(
      desk({ agents: [agent("r", { role: "spec_reviewer", status: status("working") })] }),
      desk({ agents: [agent("r", { role: "spec_reviewer", status: status("done") })] }),
      ctx(),
    );
    expect(out).toEqual(["agent_complete", "review_written"]);
  });

  it("a live spawn is agent_spawned; a retained replay's old bornAt is not", () => {
    expect(
      deriveSoundEvents(desk(), desk({ agents: [agent("a", { bornAt: NOW - 100 })] }), ctx()),
    ).toEqual(["agent_spawned"]);
    expect(
      deriveSoundEvents(desk(), desk({ agents: [agent("a", { bornAt: NOW - 60_000 })] }), ctx()),
    ).toEqual([]);
    expect(
      deriveSoundEvents(desk(), desk({ agents: [agent("a", { bornAt: null })] }), ctx()),
    ).toEqual([]);
  });

  it("maps CI and stage changes, but not a PR first seen already green", () => {
    const pr = (ci: "green" | "red" | "running" | "none") => ({ number: 1, url: "u", ci });
    const t = (a: Partial<WaveTask>, b: Partial<WaveTask>) =>
      deriveSoundEvents(
        desk({ wave: waveState({ tasks: [task(a)] }) }),
        desk({ wave: waveState({ tasks: [task(b)] }) }),
        ctx(),
      );
    expect(t({ pr: pr("running") }, { pr: pr("green") })).toEqual(["ci_passed"]);
    expect(t({ pr: pr("running") }, { pr: pr("red") })).toEqual(["ci_failed"]);
    expect(t({}, { pr: pr("green") })).toEqual([]);
    expect(t({ stage: "quality_review" }, { stage: "merge_ready" })).toEqual(["merge_ready"]);
    expect(t({ stage: "merge_ready" }, { stage: "done" })).toEqual(["pr_merged"]);
    // A task first seen is not news.
    expect(
      deriveSoundEvents(
        desk({ wave: waveState({ tasks: [] }) }),
        desk({ wave: waveState({ tasks: [task({ stage: "done" })] }) }),
        ctx(),
      ),
    ).toEqual([]);
  });

  it("maps wave status changes", () => {
    const w = (a: WaveStatePayload["status"] | null, b: WaveStatePayload["status"]) =>
      deriveSoundEvents(
        a === null ? desk() : desk({ wave: waveState({ status: a }) }),
        desk({ wave: waveState({ status: b }) }),
        ctx(),
      );
    expect(w(null, "running")).toEqual(["wave_start"]);
    expect(w("paused", "running")).toEqual(["wave_start"]);
    expect(w("running", "complete")).toEqual(["wave_complete"]);
    expect(w("running", "stopped")).toEqual(["wave_stopped"]);
    expect(w("running", "paused")).toEqual([]);
    expect(w(null, "complete")).toEqual([]);
  });

  it("maps decisions: answered, account limit, agent blocked", () => {
    const d = (a: DecisionPayload[], b: DecisionPayload[]) =>
      deriveSoundEvents(
        desk({ wave: waveState(), decisions: a }),
        desk({ wave: waveState(), decisions: b }),
        ctx(),
      );
    const resolved = { answer: "yes", by: "desk", at: "2026-10-19T00:00:00Z" };
    expect(d([decision()], [decision({ resolved })])).toEqual(["decision_answered"]);
    expect(d([], [decision({ kind: "account_limit" })])).toEqual(["account_limit"]);
    expect(d([], [decision({ kind: "agent_blocked" })])).toEqual(["agent_failed"]);
    expect(d([], [decision()])).toEqual([]);
    expect(d([], [decision({ kind: "account_limit", resolved })])).toEqual([]);
  });

  it("maps a machine tunnel going down", () => {
    expect(
      deriveSoundEvents(
        desk({ machines: [machine("up")] }),
        desk({ machines: [machine("down")] }),
        ctx(),
      ),
    ).toEqual(["machine_down"]);
    expect(deriveSoundEvents(desk(), desk({ machines: [machine("down")] }), ctx())).toEqual([]);
  });

  it("maps the broker connection, even while settling, but not the first connect", () => {
    const s = desk();
    expect(
      deriveSoundEvents(
        s,
        s,
        ctx({ prevConnection: "connected", connection: "disconnected", settling: true }),
      ),
    ).toEqual(["broker_disconnected"]);
    expect(
      deriveSoundEvents(
        s,
        s,
        ctx({ prevConnection: "disconnected", connection: "connected", settling: true }),
      ),
    ).toEqual(["broker_reconnected"]);
    expect(
      deriveSoundEvents(s, s, ctx({ prevConnection: "connecting", connection: "connected" })),
    ).toEqual([]);
  });
});
