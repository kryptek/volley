import { describe, expect, it } from "vitest";
import type { Tier } from "../src/attention";
import { type ClawdInput, clawdState } from "../src/clawd/state";
import { demoMessages } from "../src/store/fixtures";
import { initialState, reduceAll } from "../src/store/reducer";
import type { AgentView, FeedEntry, Role, Stage } from "../src/store/types";

const NOW = Date.parse("2026-10-18T12:00:00Z");
type Agent = ClawdInput["agent"];

const st = (type: string) => ({ type, payload: {}, at: NOW });
const fe = (channel: string, type: string): FeedEntry => ({
  topic: `volley/demo/a/${channel}`,
  envelope: { schema_version: "0.1", agent_id: "a", channel, type, payload: {} },
  receivedAt: NOW,
});

function agent(over: Partial<Agent> = {}): Agent {
  return { status: st("working"), feed: [], attention: null, role: "implementer", ...over };
}

function input(a: Agent, over: Partial<Omit<ClawdInput, "agent">> = {}): ClawdInput {
  return { agent: a, stage: null, tier: "none", noSignal: false, session: false, ...over };
}

const state = reduceAll(initialState(), demoMessages(NOW));
function demo(id: string): { agent: AgentView; stage: Stage | null } {
  const a = state.agents[id];
  if (!a) throw new Error(`no agent ${id}`);
  const task = a.task ? state.waves[a.wave]?.state?.tasks.find((t) => t.id === a.task) : undefined;
  return { agent: a, stage: task?.stage ?? null };
}

describe("clawdState", () => {
  it("1. blocked waiting on you → needs_you", () => {
    const d = demo("leaderboard-t1-implementer-1");
    expect(clawdState(input(d.agent, { stage: d.stage, tier: "you" }))).toBe("needs_you");
  });

  it("1. blocked waiting on the coordinator → dozing", () => {
    const d = demo("leaderboard-t1-implementer-1");
    expect(clawdState(input(d.agent, { stage: d.stage, tier: "coordinator" }))).toBe("dozing");
  });

  it("2. a failed status → failed", () => {
    expect(clawdState(input(agent({ status: st("failed") }), { stage: "implement" }))).toBe(
      "failed",
    );
  });

  it("2. reaped while working → failed", () => {
    const a = agent({
      status: st("reaped"),
      feed: [fe("status", "working"), fe("status", "reaped")],
    });
    expect(clawdState(input(a, { stage: "implement" }))).toBe("failed");
  });

  it("2. reaped after blocked → failed (rule 1 reads the live status only)", () => {
    const a = agent({
      status: st("reaped"),
      feed: [fe("status", "blocked"), fe("status", "reaped")],
    });
    expect(clawdState(input(a, { stage: "implement", tier: "you" }))).toBe("failed");
  });

  it("3. attention tier you → needs_you", () => {
    expect(clawdState(input(agent(), { stage: "implement", tier: "you" }))).toBe("needs_you");
  });

  it("4. waiting on a person who is not you → dozing; a background wait is not", () => {
    const att = { state: "awaiting_input" as const, at: NOW };
    expect(clawdState(input(agent({ attention: att }), { stage: "implement" }))).toBe("dozing");
    const bg = agent({ attention: { ...att, backgroundWait: true } });
    expect(clawdState(input(bg, { stage: "implement" }))).toBe("implement");
  });

  it("5. a done agent on a merge_ready task → merge_ready", () => {
    const d = demo("status-chip-t2-implementer-1");
    expect(d.agent.status?.type).toBe("done");
    expect(clawdState(input(d.agent, { stage: d.stage }))).toBe("merge_ready");
  });

  it("6. done → done (by status or by stage)", () => {
    expect(clawdState(input(agent({ status: st("done") }), { stage: "fixup" }))).toBe("done");
    expect(clawdState(input(agent(), { stage: "done" }))).toBe("done");
  });

  it.each(["queued", "blocked", "awaiting_decision", "cancelled"] as const)(
    "7. held stage %s → dozing",
    (stage) => {
      expect(clawdState(input(agent(), { stage }))).toBe("dozing");
    },
  );

  it("9. a rebase agent with a held stage → fixup (it works outside the stage flow)", () => {
    expect(clawdState(input(agent({ role: "rebase" }), { stage: "awaiting_decision" }))).toBe(
      "fixup",
    );
  });

  it("7. nothing started yet, or no signal → dozing", () => {
    expect(clawdState(input(agent({ status: null }), { stage: "implement" }))).toBe("dozing");
    expect(clawdState(input(agent(), { stage: "implement", noSignal: true }))).toBe("dozing");
  });

  it("7. an idle session → dozing; 10. a working session → implement", () => {
    const work = { toolCalls: 3, lastToolAt: NOW, last: "Bash: ls", since: NOW };
    const idle = agent({ status: null, role: null, work: { ...work, state: "idle" } });
    const busy = agent({ status: null, role: null, work: { ...work, state: "working" } });
    expect(clawdState(input(idle, { session: true }))).toBe("dozing");
    expect(clawdState(input(busy, { session: true }))).toBe("implement");
  });

  it.each([
    ["implement", "implement"],
    ["spec_review", "review"],
    ["quality_review", "review"],
    ["fixup", "fixup"],
  ] as const)("8. stage %s → %s", (stage, want) => {
    expect(clawdState(input(agent({ role: "quality_reviewer" }), { stage }))).toBe(want);
  });

  it("8. the demo's fixup and implementer agents", () => {
    const f = demo("status-chip-t1-fixup-1");
    expect(clawdState(input(f.agent, { stage: f.stage }))).toBe("fixup");
    const i = demo("ci-speed-t3b-implementer-1");
    expect(clawdState(input(i.agent, { stage: i.stage }))).toBe("implement");
  });

  it.each([
    ["implementer", "implement"],
    ["spec_reviewer", "review"],
    ["quality_reviewer", "review"],
    ["fixup", "fixup"],
    ["rebase", "fixup"],
    ["integrator", "implement"],
  ] as const)("9. no pipeline stage, role %s → %s", (role: Role, want) => {
    expect(clawdState(input(agent({ role })))).toBe(want);
  });

  it("10. no role, no stage → implement", () => {
    expect(clawdState(input(agent({ role: null })))).toBe("implement");
  });

  it("tiers other than you do not change a working step", () => {
    for (const tier of ["coordinator", "info", "none"] as Tier[]) {
      expect(clawdState(input(agent(), { stage: "fixup", tier }))).toBe("fixup");
    }
  });
});
