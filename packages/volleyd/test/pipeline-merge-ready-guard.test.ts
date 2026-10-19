import { describe, expect, it } from "vitest";
import {
  type PipelineAction,
  type PipelineView,
  type TaskPipeline,
  emptyPipeline,
  mergeReadyCheck,
  next,
} from "../src/pipeline";
import { type WaveRecord, apply } from "../src/reducer";
import type { ReviewResult } from "../src/reviews";
import type { PipelineStage } from "../src/types";
import { parseWaveFile } from "../src/wave-file";
import { sha } from "./helpers/pipeline-harness";

const H0 = sha(0x2000);
const H1 = sha(0x2001);
const H2 = sha(0x2002);
const H3 = sha(0x2003);

const DEFAULT: PipelineStage[][] = [
  ["implement"],
  ["spec_review", "quality_review"],
  ["fixup"],
  ["merge_ready"],
];
const NO_REVIEWS: PipelineStage[][] = [["implement"], ["merge_ready"]];

const approve: ReviewResult = {
  findings: [],
  verdict: "approve",
  hygiene: { checked: true, findings: [] },
};
const changes: ReviewResult = {
  findings: [{ severity: "P1", file: "src/a.ts", text: "broken" }],
  verdict: "changes_requested",
  hygiene: { checked: true, findings: [] },
};

/** A task at the end of its pipeline: verified at `head`, PR open. */
function at(head: string, over: Partial<TaskPipeline> = {}): TaskPipeline {
  return {
    ...emptyPipeline(),
    step: 2,
    roles: ["fixup"],
    head,
    branch: "w1/T1-implementer-1",
    pr: { number: 7, url: "https://github.com/example/repo/pull/7" },
    ci: "green",
    round: 1,
    ...over,
  };
}

const view = (p: TaskPipeline, stages = DEFAULT): PipelineView => ({
  task: "T1",
  stages,
  stage: "fixup",
  release_branch: "release/w1",
  p,
});

/** The transition into the gate: the release branch checked at the head, not behind. */
const gateFor = (v: PipelineView): PipelineAction[] =>
  next(v, {
    kind: "rebase_checked",
    head: v.p.head as string,
    check: { release_sha: H0, merge_base: H0, behind: 0 },
    diffstats: {},
  });

const kinds = (as: PipelineAction[]) => as.map((a) => a.kind);
const alarmOf = (as: PipelineAction[]) =>
  as.flatMap((a) => (a.kind === "alarm" || a.kind === "journal" ? [a.event.data] : []))[0];

describe("merge_ready invariant: never without both reviews for the current head", () => {
  it("spec review present, quality review missing → no gate, an invariant alarm", () => {
    const p = at(H1, { reviews: { spec_reviewer: { round: 1, head: H1, result: approve } } });
    expect(mergeReadyCheck(DEFAULT, p)).toMatchObject({
      ok: false,
      missing: ["quality_reviewer"],
      stale: [],
    });
    const actions = gateFor(view(p));
    expect(kinds(actions)).not.toContain("gate");
    expect(alarmOf(actions)).toMatchObject({
      alarm: "merge_ready_invariant",
      head: H1,
      missing: ["quality_reviewer"],
    });
  });

  it("no review at all → no gate", () => {
    const actions = gateFor(view(at(H1)));
    expect(kinds(actions)).not.toContain("gate");
    expect(alarmOf(actions)).toMatchObject({
      missing: ["spec_reviewer", "quality_reviewer"],
    });
  });

  it("both reviews present, one for an older head the PR moved past without a fixup → no gate", () => {
    const p = at(H1, {
      reviews: {
        spec_reviewer: { round: 1, head: H1, result: approve },
        quality_reviewer: { round: 1, head: H0, result: approve },
      },
    });
    expect(mergeReadyCheck(DEFAULT, p)).toMatchObject({ ok: false, stale: ["quality_reviewer"] });
    const actions = gateFor(view(p));
    expect(kinds(actions)).not.toContain("gate");
    expect(alarmOf(actions)).toMatchObject({
      alarm: "merge_ready_invariant",
      stale: ["quality_reviewer"],
    });
  });

  it("both reviews for the current head → the gate", () => {
    const p = at(H1, {
      reviews: {
        spec_reviewer: { round: 1, head: H1, result: approve },
        quality_reviewer: { round: 1, head: H1, result: approve },
      },
    });
    expect(mergeReadyCheck(DEFAULT, p)).toEqual({ ok: true, skippedByPlan: false });
    expect(kinds(gateFor(view(p)))).toEqual(["gate"]);
  });

  it("reviews of the head a fixup started from, the fixup having run after both → the gate", () => {
    const p = at(H2, {
      reviews: {
        spec_reviewer: { round: 1, head: H1, result: changes },
        quality_reviewer: { round: 1, head: H1, result: approve },
      },
      fixups: [{ round: 1, from: H1, to: H2 }],
    });
    expect(mergeReadyCheck(DEFAULT, p).ok).toBe(true);
    expect(kinds(gateFor(view(p)))).toEqual(["gate"]);
  });

  it("a rebase after the reviews (no flagged file touched) keeps them; a push outside the pipeline does not", () => {
    const reviews = {
      spec_reviewer: { round: 1, head: H1, result: approve },
      quality_reviewer: { round: 1, head: H1, result: approve },
    };
    const rebased = at(H2, { reviews, rebases: [{ from: H1, to: H2, touched: [] }] });
    expect(kinds(gateFor(view(rebased)))).toEqual(["gate"]);
    // Nobody reviewed H2..H3.
    const moved = at(H3, {
      reviews,
      rebases: [{ from: H1, to: H2, touched: [] }],
      moves: [{ from: H2, to: H3, touched: [] }],
    });
    expect(mergeReadyCheck(DEFAULT, moved)).toMatchObject({
      ok: false,
      stale: ["spec_reviewer", "quality_reviewer"],
    });
    expect(kinds(gateFor(view(moved)))).not.toContain("gate");
  });

  it("a fixup that ran before a re-review only counts for the reviews it followed", () => {
    // Round 1 at H1, fixup H1→H2, round 2 re-reviews spec at H2 with findings and no fixup yet:
    // quality's H1 review still leads to H2 through the fixup; spec's H2 review is at the head.
    const p = at(H2, {
      round: 2,
      reviews: {
        spec_reviewer: { round: 2, head: H2, result: changes },
        quality_reviewer: { round: 1, head: H1, result: approve },
      },
      fixups: [{ round: 1, from: H1, to: H2 }],
    });
    expect(mergeReadyCheck(DEFAULT, p).ok).toBe(true);
    // A fixup that worked from an earlier round than a review cannot vouch for it.
    const early = at(H2, {
      round: 2,
      reviews: {
        spec_reviewer: { round: 2, head: H1, result: approve },
        quality_reviewer: { round: 1, head: H1, result: approve },
      },
      fixups: [{ round: 1, from: H1, to: H2 }],
    });
    expect(mergeReadyCheck(DEFAULT, early)).toMatchObject({ ok: false, stale: ["spec_reviewer"] });
  });

  it("a plan that lists no review stage is honoured, journaled as reviews_skipped_by_plan", () => {
    const p = at(H1, { step: 0, roles: ["implementer"] });
    expect(mergeReadyCheck(NO_REVIEWS, p)).toEqual({ ok: true, skippedByPlan: true });
    const actions = gateFor(view(p, NO_REVIEWS));
    expect(kinds(actions)).toEqual(["alarm", "gate"]);
    expect(alarmOf(actions)).toEqual({ alarm: "reviews_skipped_by_plan" });
  });

  it("a plan with only one reviewer needs only that one", () => {
    const stages: PipelineStage[][] = [["implement"], ["spec_review"], ["merge_ready"]];
    const p = at(H1, { reviews: { spec_reviewer: { round: 1, head: H1, result: approve } } });
    expect(mergeReadyCheck(stages, p)).toEqual({ ok: true, skippedByPlan: false });
  });

  it("the wave state shows reviews_skipped_by_plan on the task", () => {
    const wave = parseWaveFile(
      "wave: w1\nrepo: /r\nrelease_branch: release/w1\nmodel: claude-opus-5-5\npipeline: [implement, merge_ready]\ntasks:\n  T1: { issue: 1 }\n",
    );
    let rec: WaveRecord = apply(
      {
        seq: 0,
        state: null,
        wave: null,
        admitted: [],
        spawns: 0,
        overrides: {},
        decisions: {},
        steers: {},
        pipeline: {},
        spawnFailures: {},
      },
      {
        seq: 1,
        at: "2026-10-18T12:00:00.000Z",
        type: "wave_submitted",
        data: { wave, owner: null },
      },
    );
    rec = apply(rec, {
      seq: 2,
      at: "2026-10-18T12:00:01.000Z",
      type: "task_queued",
      task: "T1",
      data: { issue: 1 },
    });
    rec = apply(rec, {
      seq: 3,
      at: "2026-10-18T12:00:02.000Z",
      type: "alarm_raised",
      task: "T1",
      data: { alarm: "reviews_skipped_by_plan" },
    });
    expect(rec.state?.tasks[0]?.reviews_skipped_by_plan).toBe(true);
  });
});
