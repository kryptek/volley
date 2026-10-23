import { describe, expect, it } from "vitest";
import { type CiJob, collapseJobNames, holdJobs, jobsWhy, noteJobTimes } from "../src/ci-jobs";

/** #415: a CI hold counts jobs, names the running ones and estimates what is left. */

const T0 = Date.parse("2026-10-23T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

const job = (name: string, status: string, o: Partial<CiJob> = {}): CiJob => ({
  workflow: "CI",
  name,
  status,
  conclusion: status === "completed" ? "success" : null,
  run_done: false,
  ...o,
});

/** One run of 13 jobs: 3 completed, 8 in progress, 2 queued. */
const thirteen = (): CiJob[] => [
  job("lint", "completed", { started_at: iso(T0), completed_at: iso(T0 + 60_000) }),
  job("typecheck", "completed", { started_at: iso(T0), completed_at: iso(T0 + 90_000) }),
  job("Unit", "completed", { started_at: iso(T0), completed_at: iso(T0 + 120_000) }),
  job("Frontend", "in_progress", { started_at: iso(T0) }),
  job("Backend IT shard 1/6", "in_progress", { started_at: iso(T0) }),
  ...[2, 3, 4, 5, 6].map((n) =>
    job(`Backend IT shard ${n}/6`, "in_progress", { started_at: iso(T0) }),
  ),
  job("e2e", "in_progress", { started_at: iso(T0) }),
  job("deploy-preview", "queued"),
  job("smoke", "queued"),
];

describe("holdJobs", () => {
  it("counts done / total and names the running jobs; none failed", () => {
    const j = holdJobs(thirteen(), new Map(), T0 + 120_000);
    expect(j).toMatchObject({ done: 3, total: 13, failed: [] });
    expect(j.running).toEqual([
      "Frontend",
      "Backend IT shard 1/6",
      "Backend IT shard 2/6",
      "Backend IT shard 3/6",
      "Backend IT shard 4/6",
      "Backend IT shard 5/6",
      "Backend IT shard 6/6",
      "e2e",
    ]);
    expect(j.eta_s).toBeUndefined();
  });

  it("a failed job lands in failed and counts as done", () => {
    const jobs = thirteen();
    jobs[3] = job("Frontend", "completed", { conclusion: "failure" });
    const j = holdJobs(jobs, new Map(), T0);
    expect(j.failed).toEqual(["Frontend"]);
    expect(j.done).toBe(4);
    expect(j.running).not.toContain("Frontend");
  });

  it("eta: the slowest unfinished job's last duration minus its elapsed time", () => {
    const last = new Map([
      ["CI/Backend IT shard 3/6", 900],
      ["CI/e2e", 600],
      ["CI/lint", 60],
    ]);
    // 7 min in: shard 3 has 8 min left, e2e 3.
    const j = holdJobs(thirteen(), last, T0 + 7 * 60_000);
    expect(j.eta_s).toBe(480);
    expect(j.slowest_s).toBe(900);
    expect(j.last_done_at).toBe(iso(T0 + 120_000));
  });

  it("no completed job yet: last_done_at is the first job's start", () => {
    const j = holdJobs([job("a", "in_progress", { started_at: iso(T0 + 5_000) })], new Map(), T0);
    expect(j.last_done_at).toBe(iso(T0 + 5_000));
  });
});

describe("noteJobTimes", () => {
  it("keeps the durations of a completed run's jobs only", () => {
    const last = new Map<string, number>();
    noteJobTimes(last, [
      job("a", "completed", {
        run_done: true,
        started_at: iso(T0),
        completed_at: iso(T0 + 300_000),
      }),
      job("b", "completed", { started_at: iso(T0), completed_at: iso(T0 + 60_000) }),
      job("c", "in_progress", { run_done: true, started_at: iso(T0) }),
    ]);
    expect([...last]).toEqual([["CI/a", 300]]);
  });
});

describe("collapseJobNames", () => {
  it("collapses consecutive shards into a range and keeps the order", () => {
    expect(
      collapseJobNames([
        "Frontend",
        "Backend IT shard 2/6",
        "Backend IT shard 3/6",
        "Backend IT shard 4/6",
        "Backend IT shard 6/6",
        "Backend IT shard 5/6",
        "e2e",
      ]),
    ).toEqual(["Frontend", "Backend IT shard 2–6/6", "e2e"]);
    expect(collapseJobNames(["shard 1/4", "shard 3/4"])).toEqual(["shard 1/4", "shard 3/4"]);
  });
});

describe("jobsWhy", () => {
  const base = { done: 3, total: 13, failed: [] as string[] };
  it("reads CI n/m · running: … · ~k min left", () => {
    expect(
      jobsWhy({
        ...base,
        running: [
          "Backend IT shard 2/6",
          "Backend IT shard 3/6",
          "Backend IT shard 4/6",
          "Backend IT shard 5/6",
          "Backend IT shard 6/6",
        ],
        eta_s: 480,
      }),
    ).toBe("CI 3/13 · running: Backend IT shard 2–6/6 · ~8 min left");
  });

  it("without an estimate the left part is absent; nothing running says queued", () => {
    expect(jobsWhy({ ...base, running: ["e2e"] })).toBe("CI 3/13 · running: e2e");
    expect(jobsWhy({ ...base, running: [] })).toBe("CI 3/13 · queued");
  });

  it("names failed jobs and caps a long running list", () => {
    const running = ["a", "b", "c", "d", "e", "f"];
    expect(jobsWhy({ ...base, running, failed: ["lint"], eta_s: 20 })).toBe(
      "CI 3/13 · running: a, b, c, d +2 more · failed: lint · <1 min left",
    );
  });
});
