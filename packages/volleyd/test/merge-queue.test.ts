import { describe, expect, it } from "vitest";
import { dependents, nextToMerge, queueOf, refusalEndsTurn } from "../src/autopilot/merge-queue";
import { type TaskPipeline, emptyPipeline, reducePipeline } from "../src/pipeline";
import type { WaveRecord } from "../src/reducer";
import type { TaskStage } from "../src/types";
import { parseWaveFile } from "../src/wave-file";

/**
 * The merge queue (A6, SPEC §4.6.17): a wave's queued tasks ordered by dependency (more
 * dependents first; a task after another never ahead of it), then readiness (queued earliest
 * first), and at most one merge in flight per release branch.
 */

const T0 = Date.parse("2026-10-20T10:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

interface TaskFixture {
  stage?: TaskStage;
  after?: string[];
  p?: Partial<TaskPipeline>;
}

function record(wave: string, tasks: Record<string, TaskFixture>, branch = "release/r1") {
  const w = parseWaveFile(
    [
      `wave: ${wave}`,
      "repo: /repo",
      `release_branch: ${branch}`,
      "model: claude-opus-5-5",
      "pipeline: [implement, merge_ready]",
      "tasks:",
      ...Object.entries(tasks).map(
        ([id, t], i) => `  ${id}: { issue: ${i + 1}, after: [${(t.after ?? []).join(", ")}] }`,
      ),
      "",
    ].join("\n"),
  );
  return {
    seq: 1,
    wave: w,
    state: {
      wave,
      release_branch: branch,
      repo: "/repo",
      tasks: Object.entries(tasks).map(([id, t]) => ({
        id,
        stage: t.stage ?? "merge_ready",
      })),
    },
    pipeline: Object.fromEntries(
      Object.entries(tasks).map(([id, t]) => [id, { ...emptyPipeline(), ...t.p }]),
    ),
  } as unknown as WaveRecord;
}

const queued = (min: number, p: Partial<TaskPipeline> = {}): Partial<TaskPipeline> => ({
  queued_at: at(min),
  ...p,
});

describe("queueOf", () => {
  it("orders by dependents, then by the time each task was queued", () => {
    const rec = record("w1", {
      T1: { p: queued(5) },
      T2: { p: queued(1) },
      T3: { after: ["T1"], p: queued(2) },
    });
    expect(dependents(rec.wave as NonNullable<WaveRecord["wave"]>, "T1")).toBe(1);
    expect(dependents(rec.wave as NonNullable<WaveRecord["wave"]>, "T2")).toBe(0);
    expect(queueOf(rec).map((e) => e.task)).toEqual(["T1", "T2", "T3"]);
    expect(queueOf(rec)[0]).toEqual({
      wave: "w1",
      task: "T1",
      state: "queued",
      since: at(5),
      gated: true,
    });
  });

  it("never puts a task ahead of one it comes after", () => {
    // T2 has two dependents, but comes after T3.
    const rec = record("w1", {
      T2: { after: ["T3"], p: queued(1) },
      T3: { p: queued(9) },
      T4: { after: ["T2"], p: queued(3) },
      T5: { after: ["T2"], p: queued(4) },
    });
    const order = queueOf(rec).map((e) => e.task);
    expect(order.indexOf("T3")).toBeLessThan(order.indexOf("T2"));
    expect(order.indexOf("T2")).toBeLessThan(order.indexOf("T4"));
  });

  it("holds only queued tasks; a task a human merges is not in it", () => {
    const rec = record("w1", {
      T1: { p: queued(1) },
      T2: { p: queued(2, { merge_manual: true }) },
      T3: {},
    });
    expect(queueOf(rec).map((e) => e.task)).toEqual(["T1"]);
  });

  it("derives each entry's state", () => {
    const rec = record("w1", {
      T1: { p: queued(1, { merge_inflight: true }) },
      T2: { stage: "fixup", p: queued(2, { rebasing: true }) },
      T3: { p: queued(3, { merge_refusals: 1 }) },
      T4: { p: queued(4) },
    });
    expect(queueOf(rec).map((e) => [e.task, e.state, e.gated])).toEqual([
      ["T1", "merging", true],
      ["T2", "updating", false],
      ["T3", "refused", true],
      ["T4", "queued", true],
    ]);
  });
});

describe("nextToMerge", () => {
  it("picks the first gated entry, none while the branch has a merge in flight", () => {
    const rec = record("w1", {
      T1: { p: queued(1) },
      T2: { p: queued(2) },
    });
    const queues = { "/repo#release/r1": queueOf(rec) };
    expect(nextToMerge(queues, new Set(["/repo#release/r1"]))).toBeNull();
    expect(nextToMerge(queues, new Set())).toEqual({
      branch: "/repo#release/r1",
      wave: "w1",
      task: "T1",
    });
  });

  it("skips an entry that is updating, and takes a refused one only after the rest", () => {
    const rec = record("w1", {
      T1: { p: queued(1, { merge_refusals: 2 }) },
      T2: { stage: "fixup", p: queued(2, { rebasing: true }) },
      T3: { p: queued(3) },
    });
    const q = { b: queueOf(rec) };
    expect(nextToMerge(q, new Set())?.task).toBe("T3");
    const onlyRefused = { b: queueOf(rec).filter((e) => e.task !== "T3") };
    expect(nextToMerge(onlyRefused, new Set())?.task).toBe("T1");
  });

  it("a checks refusal keeps its queue place; a behind refusal waits behind the rest (#311)", () => {
    const refusal = (reason?: string) =>
      queued(1, {
        merge_refusals: 1,
        merge_refusal_reason: reason,
      });
    for (const reason of ["checks", "unknown"]) {
      const rec = record("w1", { T1: { p: refusal(reason) }, T2: { p: queued(2) } });
      expect(nextToMerge({ b: queueOf(rec) }, new Set())?.task).toBe("T1");
    }
    for (const reason of ["behind", "head_moved", undefined]) {
      const rec = record("w1", { T1: { p: refusal(reason) }, T2: { p: queued(2) } });
      expect(nextToMerge({ b: queueOf(rec) }, new Set())?.task).toBe("T2");
    }
  });

  it("a late refusal of an older gated head does not change the current refusal's reason (#311)", () => {
    const [A, B] = ["a".repeat(40), "b".repeat(40)];
    let seq = 0;
    const fold = (p: TaskPipeline, type: string, data: Record<string, unknown>) =>
      reducePipeline(p, { seq: ++seq, at: "", type, task: "T1", data } as never, { stages: [] });
    let p = emptyPipeline();
    p = fold(p, "artifact_verified", { role: "gate", head_sha: A });
    p = fold(p, "artifact_verified", { role: "gate", head_sha: B });
    p = fold(p, "alarm_raised", { alarm: "merge_refused", head: B, reason: "checks" });
    expect(refusalEndsTurn(p)).toBe(false);
    p = fold(p, "alarm_raised", { alarm: "merge_refused", head: A, reason: "behind" });
    expect(p.merge_refusals).toBe(1);
    expect(refusalEndsTurn(p)).toBe(false);
  });

  it("two waves on one release branch share it: one merge in flight", () => {
    const a = queueOf(record("wa", { T1: { p: queued(2) } }));
    const b = queueOf(record("wb", { T1: { p: queued(1) } }));
    const queues = { "/repo#release/r1": [...a, ...b] };
    expect(nextToMerge(queues, new Set())).toEqual({
      branch: "/repo#release/r1",
      wave: "wb",
      task: "T1",
    });
    expect(nextToMerge(queues, new Set(["/repo#release/r1"]))).toBeNull();
  });
});
