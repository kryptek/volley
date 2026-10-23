import { describe, expect, it } from "vitest";
import { type DecisionRecord, ITS_RUNNING, ITS_RUNNING_HELP } from "../src/decisions";
import { AUTH_RESUME, type PipelineView, emptyPipeline, next } from "../src/pipeline";

/**
 * A spawn decision's third answer, `it's running` (#402): on an agent volleyd heard from since
 * the decision opened it closes with nothing restarted or stopped; on one it has not, the card
 * stays open and says so. `relaunch` and `cancel` are unchanged.
 */

const A1 = "w1-t1-implementer-1";
const OPENED = Date.parse("2026-10-22T10:00:00.000Z");

function view(heard: number | null, over: Partial<PipelineView> = {}): PipelineView {
  const p = emptyPipeline();
  p.step = 0;
  p.roles = ["implementer"];
  p.runs.implementer = { agent_id: A1, steers: {}, accepted: false };
  return {
    task: "T1",
    stages: [["implement"]],
    stage: "implement",
    release_branch: "release/w1",
    p,
    heard_from: (id) => (id === A1 ? heard : null),
    now: OPENED + 5 * 60_000,
    ...over,
  };
}

const QUESTION = `Needs you: ${A1} did not start (screen: working). Look at its terminal?`;

function decision(answer: string): DecisionRecord {
  return {
    decision_id: `unknown_screen-w1-${A1}`,
    wave: "w1",
    task: "T1",
    kind: "unknown_screen",
    question: QUESTION,
    options: ["relaunch", "cancel", ITS_RUNNING],
    option_help: { [ITS_RUNNING]: ITS_RUNNING_HELP },
    pointers: {},
    opened_at: new Date(OPENED).toISOString(),
    agent_id: A1,
    resolved: { answer, by: "owner", at: new Date(OPENED + 60_000).toISOString() },
    pipeline: {
      on: "relaunch",
      wave: "w1",
      task: "T1",
      role: "implementer",
      attempt: 1,
      agent_id: A1,
    },
  } as DecisionRecord;
}

const resolved = (v: PipelineView, answer: string) =>
  next(v, { kind: "decision_resolved", decision: decision(answer) });

describe("it's running on a spawn decision", () => {
  it("the agent was heard from after the decision opened: closed, nothing restarted or stopped", () => {
    expect(resolved(view(OPENED + 30_000), "it's running")).toEqual([]);
    // Lenient on case and spacing, like every other answer.
    expect(resolved(view(OPENED + 30_000), "  It's Running ")).toEqual([]);
  });

  it("not heard from since it opened: asked again, saying no live agent was found", () => {
    const acts = resolved(view(OPENED - 60_000), "it's running");
    expect(acts).toHaveLength(1);
    const ask = acts[0];
    expect(ask?.kind).toBe("decide");
    if (ask?.kind !== "decide") return;
    expect(ask.decision.question).toBe(
      `no live agent found for ${A1} (last heard 6 min ago). ${QUESTION}`,
    );
    // The same three answers and their hover text, and the agent it is about.
    expect(ask.decision.options).toEqual(["relaunch", "cancel", ITS_RUNNING]);
    expect(ask.decision.option_help).toEqual({ [ITS_RUNNING]: ITS_RUNNING_HELP });
    expect(ask.data).toMatchObject({ agent_id: A1 });
    expect(acts.some((a) => a.kind === "retire" || a.kind === "relaunch")).toBe(false);
  });

  it("never heard from: last heard never", () => {
    const acts = resolved(view(null), "it's running");
    const ask = acts[0];
    expect(ask?.kind === "decide" && ask.decision.question).toBe(
      `no live agent found for ${A1} (last heard never). ${QUESTION}`,
    );
  });

  it("a re-ask asked again does not stack its prefix", () => {
    const acts = resolved(view(null), "it's running");
    const ask = acts[0];
    if (ask?.kind !== "decide") throw new Error("expected a decide");
    const again = next(view(null), {
      kind: "decision_resolved",
      decision: { ...decision("it's running"), question: ask.decision.question },
    })[0];
    expect(again?.kind === "decide" && again.decision.question).toBe(
      `no live agent found for ${A1} (last heard never). ${QUESTION}`,
    );
  });

  it("a newer run replaced it: not live, asked again", () => {
    const v = view(OPENED + 30_000);
    v.p.runs.implementer = { agent_id: "w1-t1-implementer-2", steers: {}, accepted: false };
    const acts = resolved(v, "it's running");
    expect(acts[0]?.kind).toBe("decide");
  });

  it("hooks_auth_failed: the paused agent is told to resume", () => {
    const d = { ...decision("it's running"), kind: "hooks_auth_failed" } as DecisionRecord;
    expect(next(view(OPENED + 30_000), { kind: "decision_resolved", decision: d })).toEqual([
      {
        kind: "steer",
        role: "implementer",
        agent_id: A1,
        reason: "auth_resumed",
        text: AUTH_RESUME,
      },
    ]);
  });

  it("relaunch and cancel behave as before", () => {
    expect(resolved(view(OPENED + 30_000), "relaunch")).toEqual([
      { kind: "relaunch", role: "implementer", agent_id: A1 },
    ]);
    const cancel = resolved(view(OPENED + 30_000), "cancel");
    expect(cancel[0]).toEqual({ kind: "retire", agent_id: A1, status: "stopped" });
    expect(cancel[1]).toMatchObject({ kind: "journal", event: { type: "stage_entered" } });
  });

  it("any other answer is asked again, naming all three", () => {
    const ask = resolved(view(OPENED + 30_000), "hold")[0];
    expect(ask?.kind === "decide" && ask.decision.question).toBe(
      `"hold" is not one of relaunch / cancel / it's running. ${QUESTION}`,
    );
  });
});
