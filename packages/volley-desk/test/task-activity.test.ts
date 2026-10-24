import { describe, expect, it } from "vitest";
import { initialState, reduceAll } from "../src/store/reducer";
import type { AgentView, MergeQueueEntry, WaveTask } from "../src/store/types";
import { agentAlive, taskActivity } from "../src/windows/wave/activity";
import { NOW, S, registry, status, waveState } from "./helpers/desk-msgs";

const HOLD = "CI 21/22 · running: Backend IT shard 6/6 · ~3 min left";
const JOBS = { done: 21, total: 22, running: ["Backend IT shard 6/6"], failed: [] };

const agents = (byId: Record<string, "done" | "working">): Record<string, AgentView> =>
  reduceAll(
    initialState(),
    Object.entries(byId).flatMap(([id, st]) => [
      registry(id, NOW - 900 * S),
      status(id, st, NOW - 300 * S),
    ]),
  ).agents;

const task = (over: Partial<WaveTask>): WaveTask => {
  const t = waveState({ tasks: [{ id: "T8", issue: 8, stage: "implement", agents: {}, ...over }] })
    .tasks[0];
  if (!t) throw new Error("no task");
  return t;
};

const pr = (jobs?: typeof JOBS) => ({
  number: 12,
  url: "https://example.invalid/pr/12",
  head_sha: "abc1234",
  ci: "running" as const,
  ...(jobs ? { jobs } : {}),
});

const act = (
  t: WaveTask,
  byId: Record<string, "done" | "working"> = {},
  queue?: MergeQueueEntry[],
) => {
  const a = agents(byId);
  return taskActivity(t, { agent: (id) => a[id], ...(queue ? { queue } : {}) });
};

const q = (state: MergeQueueEntry["state"]): MergeQueueEntry[] => [
  { task: "T8", state, since: new Date(NOW).toISOString() },
];

describe("taskActivity (#451)", () => {
  const held = (why: string, jobs?: typeof JOBS) =>
    task({ agents: { implementer: "impl-1" }, why_waiting: why, pr: pr(jobs) });

  it("a retired implementer and a job-counted CI hold: waiting for CI with the job count", () => {
    expect(act(held(HOLD, JOBS), { "impl-1": "done" })).toEqual({
      kind: "ci",
      label: "waiting for CI · 21/22 jobs",
      node: "CI · 21/22",
    });
  });

  it("an unreadable or infra-incident hold is still waiting for CI", () => {
    for (const why of [
      "CI unreadable (no answer), retrying",
      "CI infra incident: runner outage; re-checking",
    ]) {
      expect(act(held(why), { "impl-1": "done" })).toEqual({
        kind: "ci",
        label: "waiting for CI",
        node: "CI pending",
      });
    }
  });

  it("a running agent wins over a CI hold", () => {
    expect(act(held(HOLD, JOBS), { "impl-1": "working" })).toMatchObject({
      kind: "agent",
      label: "implementing",
      node: "implementing",
    });
  });

  it("names what the running agent does", () => {
    const cases: [Partial<WaveTask>, string][] = [
      [{ stage: "spec_review", agents: { implementer: "i", spec_reviewer: "r" } }, "reviewing"],
      [{ stage: "quality_review", agents: { quality_reviewer: "r" } }, "reviewing"],
      [{ stage: "fixup", agents: { implementer: "i", fixup: "r" } }, "fixing"],
      [{ stage: "merge_ready", agents: { rebase: "r" } }, "rebasing"],
    ];
    for (const [over, label] of cases) {
      expect(act(task(over), { i: "done", r: "working" }).label).toBe(label);
    }
  });

  it("a merge turn: merging, updating, waiting for a merge turn, or merge-ready", () => {
    const t = task({ stage: "merge_ready" });
    expect(act(t, {}, q("queued"))).toMatchObject({
      kind: "merge",
      label: "waiting for a merge turn",
      node: "merge turn",
    });
    expect(act(t, {}, q("merging")).label).toBe("merging");
    expect(act(t, {}, q("updating")).label).toBe("updating");
    expect(act(t, {}, q("refused"))).toMatchObject({ kind: "stage", label: "merge-ready" });
    expect(act(t)).toMatchObject({ kind: "stage", label: "merge-ready" });
  });

  it("a decision, an end, or the stage", () => {
    expect(act(task({ stage: "awaiting_decision" }))).toMatchObject({
      kind: "decision",
      label: "waiting for a decision",
      node: "decision",
    });
    expect(act(task({ stage: "blocked" })).label).toBe("waiting for a decision");
    expect(act(task({ stage: "done" }))).toMatchObject({ kind: "ended", label: "merged" });
    expect(act(task({ stage: "cancelled" }))).toMatchObject({ kind: "ended", label: "cancelled" });
    expect(act(task({ stage: "queued" }))).toMatchObject({ kind: "stage", label: "queued" });
  });

  it("an agent the Desk has no record of is not alive", () => {
    expect(agentAlive(undefined)).toBe(false);
    expect(act(task({ agents: { implementer: "ghost" } }))).toMatchObject({
      kind: "stage",
      label: "implementing",
    });
  });
});
