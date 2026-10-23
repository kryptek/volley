import { describe, expect, it } from "vitest";
import { queueOf } from "../src/autopilot/merge-queue";
import { formTrain } from "../src/autopilot/merge-train";
import { type TaskPipeline, emptyPipeline } from "../src/pipeline";
import type { WaveRecord } from "../src/reducer";
import type { MergeTrain, TaskStage } from "../src/types";
import { parseWaveFile } from "../src/wave-file";

/**
 * Merge-train formation (SPEC §4.6.23): on a release branch with no merge in flight and at least
 * two gated tasks, the first up to `size` of them (the front task's cluster first) merge as one
 * train. Pure.
 */

const T0 = Date.parse("2026-10-20T10:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const sha = (n: number) => n.toString(16).padStart(40, "0");
const BRANCH = "/repo#release/r1";
const OPTS = { size: 4, enabled: true };

interface TaskFixture {
  /** Minutes after T0 the task was queued; absent: not in the queue. */
  queued?: number;
  stage?: TaskStage;
  cluster?: string;
  p?: Partial<TaskPipeline>;
}

/** A wave whose tasks are gated at `sha(issue)` in PR `100 + issue`. */
function record(wave: string, tasks: Record<string, TaskFixture>, trains?: MergeTrain[]) {
  const w = parseWaveFile(
    [
      `wave: ${wave}`,
      "repo: /repo",
      "release_branch: release/r1",
      "model: claude-opus-5-5",
      "pipeline: [implement, merge_ready]",
      "tasks:",
      ...Object.keys(tasks).map((id, i) => `  ${id}: { issue: ${i + 1} }`),
      "",
    ].join("\n"),
  );
  const ids = Object.keys(tasks);
  return {
    seq: 1,
    wave: w,
    state: {
      wave,
      release_branch: "release/r1",
      repo: "/repo",
      tasks: Object.entries(tasks).map(([id, t]) => ({
        id,
        stage: t.stage ?? "merge_ready",
        ...(t.cluster !== undefined ? { cluster: t.cluster } : {}),
      })),
      ...(trains !== undefined ? { trains } : {}),
    },
    pipeline: Object.fromEntries(
      Object.entries(tasks).map(([id, t]) => {
        const n = ids.indexOf(id) + 1;
        const head = sha(n);
        return [
          id,
          {
            ...emptyPipeline(),
            head,
            gated: [head],
            pr: { number: 100 + n, url: `https://example.test/pr/${100 + n}` },
            ...(t.queued !== undefined ? { queued_at: at(t.queued) } : {}),
            ...t.p,
          },
        ];
      }),
    ),
  } as unknown as WaveRecord;
}

const form = (rec: WaveRecord, opts = OPTS, inflight = new Set<string>()) =>
  formTrain({ [BRANCH]: queueOf(rec) }, inflight, { [rec.state?.wave as string]: rec }, opts);

describe("formTrain", () => {
  it("three gated entries on one branch: a train of all three, in queue order", () => {
    const rec = record("w1", { T1: { queued: 3 }, T2: { queued: 1 }, T3: { queued: 2 } });
    expect(form(rec)).toEqual({
      id: "train-1",
      branch: "volley/train/w1-t1",
      release_branch: "release/r1",
      members: [
        { wave: "w1", task: "T2", pr: 102, head: sha(2) },
        { wave: "w1", task: "T3", pr: 103, head: sha(3) },
        { wave: "w1", task: "T1", pr: 101, head: sha(1) },
      ],
    });
  });

  it("a single gated task takes the ordinary turn: no train", () => {
    const rec = record("w1", { T1: { queued: 1 }, T2: { queued: 2, stage: "fixup" } });
    expect(form(rec)).toBeNull();
  });

  it("five gated: the first four, the front task's cluster first", () => {
    const rec = record("w1", {
      T1: { queued: 1, cluster: "c1" },
      T2: { queued: 2, cluster: "c2" },
      T3: { queued: 3, cluster: "c1" },
      T4: { queued: 4 },
      T5: { queued: 5, cluster: "c1" },
    });
    expect(form(rec)?.members.map((m) => m.task)).toEqual(["T1", "T3", "T5", "T2"]);
  });

  it("skips a merge_manual entry, an ungated one and one without a gated head", () => {
    const rec = record("w1", {
      T1: { queued: 1, p: { merge_manual: true } },
      T2: { queued: 2 },
      T3: { queued: 3, stage: "fixup" },
      T4: { queued: 4, p: { gated: [] } },
      T5: { queued: 5, p: { pr: undefined } as unknown as Partial<TaskPipeline> },
      T6: { queued: 6 },
    });
    expect(form(rec)?.members.map((m) => m.task)).toEqual(["T2", "T6"]);
    // queueOf already leaves merge_manual out; formTrain checks it again for any queue it is given.
    const q = queueOf(record("w1", { T1: { queued: 1 }, T2: { queued: 2 } }));
    const manual = record("w1", {
      T1: { queued: 1, p: { merge_manual: true } },
      T2: { queued: 2 },
    });
    expect(formTrain({ [BRANCH]: q }, new Set(), { w1: manual }, OPTS)).toBeNull();
  });

  it("a branch with a merge in flight forms no train", () => {
    const rec = record("w1", { T1: { queued: 1 }, T2: { queued: 2 }, T3: { queued: 3 } });
    expect(form(rec, OPTS, new Set([BRANCH]))).toBeNull();
    const merging = record("w1", {
      T1: { queued: 1, p: { merge_inflight: true } },
      T2: { queued: 2 },
      T3: { queued: 3 },
    });
    expect(form(merging)).toBeNull();
  });

  it("a branch with a train running forms no second one", () => {
    const rec = record(
      "w1",
      { T1: { queued: 1 }, T2: { queued: 2 }, T3: { queued: 3 }, T4: { queued: 4 } },
      [{ id: "train-1", tasks: ["T1", "T2"], state: "ci", since: at(5) }],
    );
    expect(form(rec)).toBeNull();
  });

  it("a branch whose running train's members left the queue forms no second one", () => {
    const rec = record("w1", { T1: {}, T2: {}, T3: { queued: 3 }, T4: { queued: 4 } }, [
      { id: "train-1", tasks: ["T1", "T2"], state: "integrating", since: at(5) },
    ]);
    expect(form(rec)).toBeNull();
  });

  it("enabled: false forms none", () => {
    const rec = record("w1", { T1: { queued: 1 }, T2: { queued: 2 } });
    expect(form(rec, { size: 4, enabled: false })).toBeNull();
  });

  it("ids are sequential per wave, from the trains already started", () => {
    const rec = record("w1", { T1: { queued: 1 }, T2: { queued: 2 }, T3: { queued: 3 } }, [
      { id: "train-1", tasks: ["T3"], state: "failed", since: at(4) },
      { id: "train-2", tasks: ["T3"], state: "merged", since: at(5) },
    ]);
    const t = form(rec);
    expect(t?.id).toBe("train-3");
    expect(t?.branch).toBe("volley/train/w1-t3");
  });

  it("a train carries one wave's tasks: the front task's", () => {
    const a = record("wa", { T1: { queued: 1 }, T2: { queued: 3 } });
    const b = record("wb", { U1: { queued: 2 }, U2: { queued: 4 } });
    const t = formTrain(
      { [BRANCH]: [...queueOf(a), ...queueOf(b)] },
      new Set(),
      { wa: a, wb: b },
      OPTS,
    );
    expect(t?.members.map((m) => `${m.wave}/${m.task}`)).toEqual(["wa/T1", "wa/T2"]);
  });

  it("size bounds the train; a size below two forms none", () => {
    const rec = record("w1", { T1: { queued: 1 }, T2: { queued: 2 }, T3: { queued: 3 } });
    expect(form(rec, { size: 2, enabled: true })?.members).toHaveLength(2);
    expect(form(rec, { size: 1, enabled: true })).toBeNull();
  });

  it("a refused entry that lost its turn goes last and is not the front; one that keeps its place is not moved", () => {
    const rec = record("w1", {
      T1: { queued: 1, cluster: "c1", p: { merge_refusals: 1, merge_refusal_reason: "behind" } },
      T2: { queued: 2, cluster: "c2" },
      T3: { queued: 3, cluster: "c1" },
      T4: { queued: 4, p: { merge_refusals: 1, merge_refusal_reason: "checks" } },
    });
    // The front is T2 (T1 lost its turn), so c2 leads; T1 comes after every other member.
    expect(form(rec)?.members.map((m) => m.task)).toEqual(["T2", "T3", "T4", "T1"]);
    expect(queueOf(rec).find((e) => e.task === "T4")?.keepsPlace).toBe(true);
  });
});
