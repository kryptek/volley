import { describe, expect, it } from "vitest";
import type { DecisionRecord } from "../src/decisions";
import { type PipelineView, type TaskPipeline, emptyPipeline, next } from "../src/pipeline";
import type { PipelineStage } from "../src/types";
import { sha } from "./helpers/pipeline-harness";

const H1 = sha(0x3001);

const DEFAULT: PipelineStage[][] = [
  ["implement"],
  ["spec_review", "quality_review"],
  ["fixup"],
  ["merge_ready"],
];

const view = (p: TaskPipeline): PipelineView => ({
  task: "T1",
  stages: DEFAULT,
  stage: "awaiting_decision",
  release_branch: "release/w1",
  p,
});

const resolvedFixup = (agent: string): DecisionRecord =>
  ({
    decision_id: "d1",
    wave: "w1",
    task: "T1",
    kind: "ci_failed",
    question: "q",
    options: ["fixup", "re-verify", "cancel"],
    pointers: {},
    opened_at: "2026-10-20T12:00:00.000Z",
    resolved: { answer: "fixup", by: "owner", at: "2026-10-20T12:01:00.000Z" },
    pipeline: { on: "ci_failed", role: "implementer", head: H1, agent_id: agent },
    failed_jobs: ["CI / test"],
  }) as unknown as DecisionRecord;

const at = (agent: string): TaskPipeline => ({
  ...emptyPipeline(),
  step: 0,
  roles: ["implementer"],
  head: H1,
  runs: { implementer: { agent_id: agent, steers: {}, accepted: false } },
});

describe("ci_failed answered fixup: only for the run whose head went red", () => {
  it("the red run is still the role's: a fixup enters", () => {
    const actions = next(view(at("a-impl-1")), {
      kind: "decision_resolved",
      decision: resolvedFixup("a-impl-1"),
    });
    expect(actions.some((a) => a.kind === "journal" && a.event.type === "stage_entered")).toBe(
      true,
    );
  });

  it("the role was relaunched meanwhile (a new run): the late fixup answer is stale", () => {
    const actions = next(view(at("a-impl-2")), {
      kind: "decision_resolved",
      decision: resolvedFixup("a-impl-1"),
    });
    expect(actions).toEqual([]);
  });
});
