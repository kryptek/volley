import { describe, expect, it } from "vitest";
import { emptyPipeline, reducePipeline } from "../src/pipeline";
import type { JournalEvent, PipelineStage } from "../src/types";

const stages: PipelineStage[][] = [
  ["implement"],
  ["spec_review", "quality_review"],
  ["fixup"],
  ["merge_ready"],
];
const at = "2026-10-22T17:31:34.000Z";
const spawned = (seq: number, role: string, attempt: number): JournalEvent => ({
  seq,
  at,
  type: "agent_spawned",
  task: "T1",
  data: { role, agent_id: `w-t1-${role}-${attempt}`, attempt },
});

describe("reducePipeline: an implementer launched on a later attempt (#409)", () => {
  it("starts the pipeline at the implement step and keeps the run", () => {
    // spawn.ts journals stage_entered { implement } only on attempt 1: none follows here.
    const p = reducePipeline(emptyPipeline(), spawned(10, "implementer", 3), { stages });
    expect(p.step).toBe(0);
    expect(p.roles).toEqual(["implementer"]);
    expect(p.runs.implementer?.agent_id).toBe("w-t1-implementer-3");
  });

  it("a later stage_entered { implement } (attempt 1) changes nothing it set", () => {
    const p = reducePipeline(emptyPipeline(), spawned(10, "implementer", 1), { stages });
    reducePipeline(
      p,
      { seq: 11, at, type: "stage_entered", task: "T1", data: { stage: "implement" } },
      { stages },
    );
    expect(p.step).toBe(0);
    expect(p.runs.implementer?.agent_id).toBe("w-t1-implementer-1");
  });

  it("a reviewer launching does not start it, and a started pipeline is not reset", () => {
    expect(reducePipeline(emptyPipeline(), spawned(10, "spec_reviewer", 1), { stages }).step).toBe(
      -1,
    );
    const p = emptyPipeline();
    p.step = 2;
    p.roles = ["fixup"];
    reducePipeline(p, spawned(12, "implementer", 4), { stages });
    expect(p.step).toBe(2);
    expect(p.roles).toEqual(["fixup"]);
  });
});
