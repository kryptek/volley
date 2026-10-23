import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { releaseLockOn } from "../src/pipeline";
import {
  type Harness,
  type HarnessOptions,
  pipelineHarness,
  sha,
} from "./helpers/pipeline-harness";

/**
 * The merge train in the pipeline (SPEC §4.6.23): two or more gated tasks of a wave whose front is
 * behind its release branch are integrated by one `integrator` agent onto the train branch, CI
 * runs once on that head, the gate mints a TrainToken and the train's PR merges with a merge
 * commit, which lands every member.
 */

const R0 = sha(0xbea5e); // the harness's release tip, where the members were cut
const R1 = sha(0xbea51); // the release tip once something else merged: every member is behind
const H = { T1: sha(0x1001), T2: sha(0x2001), T3: sha(0x3001) } as const;
const PR = { T1: 7, T2: 8, T3: 9 } as const;
const TRAIN = "train-1";
const TRAIN_BRANCH = "volley/train/w1-t1";
const TH = sha(0x7001); // the integrator's train head
const TH2 = sha(0x7002); // a fixup's
const TPR = 20;
const TMERGE = sha(0xa120);

let h: Harness;
afterEach(() => h?.cleanup());

const ofType = (type: string) => h.events.filter((e) => e.type === type);
const mergeCalls = () => h.calls.filter((a) => a[0] === "gh" && a[1] === "pr" && a[2] === "merge");
const queue = () => h.record().state?.merge_queue ?? [];
const RESULT = { merged: [7, 8, 9], conflicts: [], touched: [] };

/** T1, T2, T3 gated at heads cut from R0 while the release branch moved on to R1. */
async function threeGatedBehind(o: HarnessOptions = {}) {
  h = pipelineHarness({
    pipeline: "[implement, merge_ready]",
    merge: "auto",
    mergeTrain: true,
    siblings: { T2: null, T3: null },
    ...o,
  });
  await h.start();
  await h.startTask("T2");
  await h.startTask("T3");
  h.world.releaseTip = R1;
  for (const t of ["T1", "T2", "T3"] as const) {
    h.openPr(H[t], t, PR[t]);
    h.world.mergeBase[H[t]] = R0;
    await h.finish("implementer", { task: t, head: H[t], ci: "green" });
  }
  for (const t of ["T1", "T2", "T3"]) expect(h.task(t)?.stage).toBe("merge_ready");
}

/** The train head contains `members`' gated heads and descends from R1. */
function contains(head: string, members: readonly (keyof typeof H)[]) {
  for (const t of members) h.world.ancestor[`${H[t]}..${head}`] = true;
  h.world.ancestor[`${R1}..${head}`] = true;
}

/** The train formed (one tick), and its integrator started; its PR opened from the train branch. */
async function trainStarted() {
  await h.tick();
  expect(ofType("train_started")).toHaveLength(1);
  await h.admitTrain(TRAIN);
  h.openPr(TH, TRAIN, TPR);
  h.world.mergeCommit[TPR] = TMERGE;
}

describe("merge train: formation and the train task", () => {
  it("three gated tasks behind their release branch form train-1: a synthetic task the integrator runs", async () => {
    await threeGatedBehind();
    await h.tick();
    expect(ofType("train_started").map((e) => e.data)).toEqual([
      {
        train: TRAIN,
        tasks: ["T1", "T2", "T3"],
        heads: { T1: H.T1, T2: H.T2, T3: H.T3 },
        release_sha: R1,
      },
    ]);
    const queued = ofType("task_queued").find((e) => e.task === TRAIN);
    expect(queued?.data).toEqual({
      issue: 0,
      synthetic: true,
      title: "Train: #42, #60, #61",
      train: {
        members: [
          { task: "T1", pr: 7, head: H.T1 },
          { task: "T2", pr: 8, head: H.T2 },
          { task: "T3", pr: 9, head: H.T3 },
        ],
      },
    });
    expect(h.task(TRAIN)).toMatchObject({ synthetic: true, issue: 0, stage: "queued" });
    expect(h.task(TRAIN)?.train?.members.map((m) => m.task)).toEqual(["T1", "T2", "T3"]);
    expect(h.record().wave?.tasks[TRAIN]?.stages).toEqual([["implement"], ["merge_ready"]]);
    // The members wait in the queue as merging: no ordinary turn, no update, no merge.
    expect(queue().map((e) => [e.task, e.state])).toEqual([
      ["T1", "merging"],
      ["T2", "merging"],
      ["T3", "merging"],
    ]);
    expect(h.record().state?.trains).toEqual([
      expect.objectContaining({ id: TRAIN, tasks: ["T1", "T2", "T3"], state: "integrating" }),
    ]);
    expect(ofType("stage_entered").filter((e) => e.data.rebase === true)).toEqual([]);
    expect(mergeCalls()).toEqual([]);

    // The integrator's .volley/integrate.md: the release branch and sha, the train branch, each
    // member in order with its PR, branch, gated head and issue.
    await h.admitTrain(TRAIN);
    const spawn = h.spawns.find((s) => s.task === TRAIN);
    expect(spawn?.role).toBe("integrator");
    const md = spawn?.files["integrate.md"] ?? "";
    expect(md).toContain("release/w1");
    expect(md).toContain(R1);
    expect(md).toContain(TRAIN_BRANCH);
    const at = (s: string) => md.indexOf(s);
    expect(at("PR #7")).toBeGreaterThan(0);
    expect(at("PR #7")).toBeLessThan(at("PR #8"));
    expect(at("PR #8")).toBeLessThan(at("PR #9"));
    for (const t of ["T1", "T2", "T3"] as const) expect(md).toContain(H[t]);
    expect(md).toContain("w1/T2-implementer-1");
    expect(md).toContain("Closes #60");
    expect(h.task(TRAIN)?.stage).toBe("implement");
  });

  it("gated tasks up to date with the release branch take the ordinary turn (the front is not behind)", async () => {
    h = pipelineHarness({
      pipeline: "[implement, merge_ready]",
      merge: "auto",
      mergeTrain: true,
      siblings: { T2: null },
    });
    await h.start();
    await h.startTask("T2");
    for (const t of ["T1", "T2"] as const) {
      h.openPr(H[t], t, PR[t]);
      await h.finish("implementer", { task: t, head: H[t], ci: "green" });
    }
    await h.tick();
    expect(ofType("train_started")).toEqual([]);
    expect(mergeCalls()[0]).toEqual([
      "gh",
      "pr",
      "merge",
      "7",
      "--squash",
      "--match-head-commit",
      H.T1,
    ]);
  });

  it("autopilot.merge_train off: never a train", async () => {
    await threeGatedBehind({ mergeTrain: false });
    await h.tick();
    expect(ofType("train_started")).toEqual([]);
    expect(
      ofType("stage_entered").filter((e) => e.data.rebase === true && e.task === "T1"),
    ).toHaveLength(1);
  });
});

describe("merge train: verification, the gate, the merge and completion", () => {
  it("a head containing every member, green once: TrainToken, one merge commit, every member done", async () => {
    await threeGatedBehind();
    await trainStarted();
    contains(TH, ["T1", "T2", "T3"]);
    await h.finish("integrator", { task: TRAIN, head: TH, ci: "green", result: RESULT });

    // The gate: evidence written, merged with a merge commit at exactly the train head.
    expect(mergeCalls()).toEqual([
      ["gh", "pr", "merge", String(TPR), "--merge", "--match-head-commit", TH],
    ]);
    const gate = ofType("artifact_verified").find(
      (e) => e.task === TRAIN && e.data.role === "gate",
    );
    expect(gate?.data).toMatchObject({ head_sha: TH, pr: { number: TPR } });
    const evidence = JSON.parse(readFileSync(gate?.data.evidence_json as string, "utf-8"));
    expect(evidence.train).toMatchObject({
      id: TRAIN,
      members: [
        { task: "T1", pr: 7, head: H.T1 },
        { task: "T2", pr: 8, head: H.T2 },
        { task: "T3", pr: 9, head: H.T3 },
      ],
      release_sha: R1,
      conflicts: [],
      touched: [],
    });
    expect(
      ofType("alarm_raised").find((e) => e.data.alarm === "train_reviews_skipped")?.data,
    ).toEqual({
      alarm: "train_reviews_skipped",
      why: "no conflict resolution touched a flagged file",
    });

    // Completion.
    expect(ofType("train_merged").map((e) => e.data)).toEqual([
      { train: TRAIN, pr: TPR, merge_sha: TMERGE, tasks: ["T1", "T2", "T3"] },
    ]);
    expect(ofType("merged_by_supervisor").map((e) => e.data)).toEqual(
      (["T1", "T2", "T3"] as const).map((t) => ({
        task: t,
        pr: PR[t],
        head: H[t],
        merge_sha: TMERGE,
        by: "volleyd",
        via: "train",
        train_pr: TPR,
      })),
    );
    for (const t of ["T1", "T2", "T3", TRAIN]) expect(h.task(t)?.stage).toBe("done");
    expect(
      ofType("artifact_verified")
        .filter((e) => e.data.role === "merged")
        .map((e) => e.task),
    ).toEqual(["T1", "T2", "T3", TRAIN]);
    expect(
      ofType("merge_dequeued")
        .filter((e) => e.data.why === "merged")
        .map((e) => e.task),
    ).toEqual(["T1", "T2", "T3"]);
    expect(h.record().state?.trains?.[0]).toMatchObject({ state: "merged", pr: TPR });
    // GitHub marked every member PR merged: no alarm.
    expect(ofType("alarm_raised").filter((e) => e.data.alarm === "train_member_open")).toEqual([]);
    // CI ran once, on the train head: the members were never updated.
    expect(ofType("stage_entered").filter((e) => e.data.rebase === true)).toEqual([]);
  });

  it("a member PR GitHub still reports open after the train merged: train_member_open, never closed", async () => {
    await threeGatedBehind();
    await trainStarted();
    contains(TH, ["T1", "T2", "T3"]);
    h.world.prState[PR.T3] = "OPEN";
    await h.finish("integrator", { task: TRAIN, head: TH, ci: "green", result: RESULT });
    expect(ofType("train_merged")).toHaveLength(1);
    expect(
      ofType("alarm_raised")
        .filter((e) => e.data.alarm === "train_member_open")
        .map((e) => e.data),
    ).toEqual([{ alarm: "train_member_open", task: "T3", pr: PR.T3, train: TRAIN }]);
    expect(h.calls.some((a) => a[0] === "gh" && a[1] === "pr" && a[2] === "close")).toBe(false);
  });

  it("the release lock is held by the train from train_started until train_merged", async () => {
    const held = new Map<string, string>();
    await threeGatedBehind({ releaseLock: releaseLockOn(held) });
    await h.tick();
    expect(held.get("/repo#release/w1")).toBe(`w1/${TRAIN}`);
    // `volleyd merge` of a member is refused while its train runs, naming the train.
    const r = await h.driver.mergeNow("T2", "coord-1");
    expect(r).toEqual({ ok: false, error: expect.stringContaining(TRAIN) });
    await h.tick();
    expect(held.get("/repo#release/w1")).toBe(`w1/${TRAIN}`);
    await h.admitTrain(TRAIN);
    h.openPr(TH, TRAIN, TPR);
    h.world.mergeCommit[TPR] = TMERGE;
    contains(TH, ["T1", "T2", "T3"]);
    await h.finish("integrator", { task: TRAIN, head: TH, ci: "green", result: RESULT });
    expect(ofType("train_merged")).toHaveLength(1);
    await h.tick();
    expect(held.has("/repo#release/w1")).toBe(false);
  });

  it("a head missing a member's commit: the integrator is steered once, then a fixup merges it", async () => {
    await threeGatedBehind();
    await trainStarted();
    contains(TH, ["T1", "T3"]);
    await h.finish("integrator", { task: TRAIN, head: TH, ci: "green", result: RESULT });
    expect(h.steers.map((s) => [s.task, s.role, s.reason])).toEqual([
      [TRAIN, "integrator", "artifacts"],
    ]);
    expect(h.steers[0]?.text).toContain("PR #8");
    expect(mergeCalls()).toEqual([]);

    // Done again at the same head: a fixup on the train branch merges the missing member.
    await h.finish("integrator", { task: TRAIN, head: TH, ci: "green", result: RESULT });
    const fixup = h.spawns.find((s) => s.task === TRAIN && s.role === "fixup");
    expect(fixup?.start).toEqual({ ref: TH, detach: false });
    expect(fixup?.files["findings.md"]).toContain("PR #8");
    expect(fixup?.files["findings.md"]).toContain("w1/T2-implementer-1");

    contains(TH2, ["T1", "T2", "T3"]);
    await h.finish("fixup", {
      task: TRAIN,
      head: TH2,
      ci: "green",
      result: { resolved: [{ finding: "TRAIN", how: "merged PR #8" }] },
    });
    expect(mergeCalls()).toEqual([
      ["gh", "pr", "merge", String(TPR), "--merge", "--match-head-commit", TH2],
    ]);
    expect(ofType("train_merged")).toHaveLength(1);
  });

  it("a resolution that touched a member reviewer's flagged file: that reviewer reviews the train head", async () => {
    await threeGatedBehind();
    // T2's quality reviewer flagged src/batch.ts in an earlier round.
    await h.journal({
      type: "artifact_verified",
      task: "T2",
      data: {
        role: "quality_reviewer",
        review: {
          findings: [{ severity: "P2", file: "src/batch.ts", line: 3, text: "a nit" }],
          verdict: "approve",
        },
      },
    });
    await trainStarted();
    contains(TH, ["T1", "T2", "T3"]);
    await h.finish("integrator", {
      task: TRAIN,
      head: TH,
      ci: "green",
      result: {
        ...RESULT,
        conflicts: [{ pr: 8, files: ["src/batch.ts"] }],
        touched: ["src/batch.ts"],
      },
    });
    const review = h.spawns.find((s) => s.task === TRAIN && s.role === "quality_reviewer");
    expect(review?.start).toEqual({ ref: TH, detach: true });
    expect(review?.files["review.md"]).toContain("src/batch.ts");
    expect(review?.files["review.md"]).toContain("--remerge-diff");
    expect(h.spawns.some((s) => s.task === TRAIN && s.role === "spec_reviewer")).toBe(false);
    expect(mergeCalls()).toEqual([]);

    await h.finish("quality_reviewer", {
      task: TRAIN,
      result: { findings: [], verdict: "approve", hygiene: { checked: true, findings: [] } },
    });
    expect(ofType("alarm_raised").filter((e) => e.data.alarm === "train_reviews_skipped")).toEqual(
      [],
    );
    expect(mergeCalls()).toEqual([
      ["gh", "pr", "merge", String(TPR), "--merge", "--match-head-commit", TH],
    ]);
  });
});

describe("merge train: failure", () => {
  it("the integrator blocked on member two: merge_conflict { train }; autopilot drops it and the train re-forms with two", async () => {
    await threeGatedBehind({
      autopilot: (d) => (d.kind === "merge_conflict" ? "drop T2" : undefined),
    });
    await trainStarted();
    await h.block("integrator", "PR #8 conflicts in src/batch.ts", TRAIN, { pr: 8 });
    await h.settle();
    const d = Object.values(h.record().decisions).find((x) => x.kind === "merge_conflict");
    expect(d).toMatchObject({
      task: "T2",
      train: TRAIN,
      options: ["drop T2", "respawn", "manual", "cancel"],
    });
    expect(ofType("train_failed").map((e) => e.data)).toEqual([
      expect.objectContaining({ train: TRAIN, tasks: ["T1", "T2", "T3"], dropped: "T2" }),
    ]);
    expect(h.task(TRAIN)?.stage).toBe("cancelled");
    expect(h.record().state?.trains?.[0]?.state).toBe("failed");

    await h.tick();
    expect(ofType("train_started").map((e) => [e.data.train, e.data.tasks])).toEqual([
      [TRAIN, ["T1", "T2", "T3"]],
      ["train-2", ["T1", "T3"]],
    ]);
    // The dropped member keeps its place in the queue, outside the train.
    expect(queue().map((e) => [e.task, e.state])).toEqual([
      ["T1", "merging"],
      ["T2", "queued"],
      ["T3", "merging"],
    ]);
  });

  it("a refused train merge (behind): train_failed, members queued again; the next tick forms anew", async () => {
    await threeGatedBehind();
    await trainStarted();
    contains(TH, ["T1", "T2", "T3"]);
    h.world.mergeRefuse = "Pull request is not mergeable: the head branch is out of date";
    await h.finish("integrator", { task: TRAIN, head: TH, ci: "green", result: RESULT });
    expect(ofType("train_failed").map((e) => e.data)).toEqual([
      { train: TRAIN, why: "behind", tasks: ["T1", "T2", "T3"] },
    ]);
    expect(h.task(TRAIN)?.stage).toBe("cancelled");
    expect(queue().map((e) => [e.task, e.state])).toEqual([
      ["T1", "queued"],
      ["T2", "queued"],
      ["T3", "queued"],
    ]);
    for (const t of ["T1", "T2", "T3"]) expect(h.task(t)?.stage).toBe("merge_ready");
    h.world.mergeRefuse = undefined;
    await h.tick();
    expect(ofType("train_started").map((e) => e.data.train)).toEqual([TRAIN, "train-2"]);
  });

  it("a train whose CI fixups are spent: train_failed, members queued, the cluster on hold", async () => {
    await threeGatedBehind({
      ciFixupMax: 0,
      autopilot: (d) => (d.kind === "ci_failed" ? "fixup" : undefined),
    });
    await h.journal({
      type: "wave_planned",
      data: {
        clusters: [
          {
            id: "c1",
            tasks: ["T1", "T2", "T3"],
            hot: [],
            strategy: {},
            state: "planned",
            why: "they share src/batch.ts",
          },
        ],
      },
    });
    await trainStarted();
    contains(TH, ["T1", "T2", "T3"]);
    await h.finish("integrator", { task: TRAIN, head: TH, ci: "red", result: RESULT });
    expect(ofType("train_failed").map((e) => e.data)).toEqual([
      expect.objectContaining({ train: TRAIN, tasks: ["T1", "T2", "T3"] }),
    ]);
    expect(String(ofType("train_failed")[0]?.data.why)).toMatch(/CI/);
    expect(h.spawns.some((s) => s.task === TRAIN && s.role === "fixup")).toBe(false);
    expect(queue().map((e) => e.state)).toEqual(["queued", "queued", "queued"]);
    expect(ofType("cluster_strategy_changed").map((e) => e.data)).toEqual([
      { cluster: "c1", from: "independent", to: "hold", why: expect.stringContaining(TRAIN) },
    ]);
    expect(h.record().state?.overlap_plan?.clusters[0]?.state).toBe("hold");
  });

  it("artifacts: a train evidence file exists only once gated", async () => {
    await threeGatedBehind();
    await trainStarted();
    const gate = () =>
      ofType("artifact_verified").find((e) => e.task === TRAIN && e.data.role === "gate");
    expect(gate()).toBeUndefined();
    contains(TH, ["T1", "T2", "T3"]);
    await h.finish("integrator", { task: TRAIN, head: TH, ci: "green", result: RESULT });
    expect(existsSync(gate()?.data.evidence_path as string)).toBe(true);
  });
});

describe("merge train: a conflict's other answers", () => {
  /** The integrator blocked on member two, the merge_conflict left open for the owner. */
  async function blockedOnT2(o: HarnessOptions = {}) {
    await threeGatedBehind(o);
    await trainStarted();
    await h.block("integrator", "PR #8 conflicts in src/batch.ts", TRAIN, { pr: 8 });
    const d = h.openDecisions().find((x) => x.kind === "merge_conflict");
    expect(d).toMatchObject({ task: "T2", train: TRAIN });
    return d?.decision_id as string;
  }

  it("respawn: a fresh integrator on the same train; nothing fails", async () => {
    const id = await blockedOnT2();
    const agent = h.run("integrator", TRAIN)?.agent_id as string;
    await h.resolve(id, "respawn");
    expect(h.retired).toContainEqual({ agent_id: agent, status: "relaunched" });
    const integrators = h.spawns.filter((s) => s.task === TRAIN && s.role === "integrator");
    expect(integrators).toHaveLength(2);
    expect(h.run("integrator", TRAIN)?.agent_id).not.toBe(agent);
    expect(ofType("train_failed")).toEqual([]);
    expect(h.record().state?.trains?.[0]?.state).toBe("integrating");
  });

  it("manual: the member goes to a person, the train fails (its integrator retired once) and re-forms without it", async () => {
    const id = await blockedOnT2();
    const agent = h.run("integrator", TRAIN)?.agent_id as string;
    await h.resolve(id, "manual");
    expect(ofType("train_failed").map((e) => e.data)).toEqual([
      expect.objectContaining({ train: TRAIN, tasks: ["T1", "T2", "T3"] }),
    ]);
    expect(h.retired.filter((r) => r.agent_id === agent)).toEqual([
      { agent_id: agent, status: "stopped" },
    ]);
    expect(h.task(TRAIN)?.stage).toBe("cancelled");
    expect(queue().map((e) => e.task)).not.toContain("T2");
    await h.tick();
    expect(ofType("train_started").map((e) => [e.data.train, e.data.tasks])).toEqual([
      [TRAIN, ["T1", "T2", "T3"]],
      ["train-2", ["T1", "T3"]],
    ]);
  });

  it("drop: its integrator is retired once", async () => {
    const id = await blockedOnT2();
    const agent = h.run("integrator", TRAIN)?.agent_id as string;
    await h.resolve(id, "drop T2");
    expect(ofType("train_failed")[0]?.data).toMatchObject({ dropped: "T2" });
    expect(h.retired.filter((r) => r.agent_id === agent)).toEqual([
      { agent_id: agent, status: "stopped" },
    ]);
  });

  it("cancel: the train task is cancelled; the next tick journals train_failed (cancelled) and frees the lock", async () => {
    const held = new Map<string, string>();
    const id = await blockedOnT2({ releaseLock: releaseLockOn(held) });
    await h.resolve(id, "cancel");
    expect(h.task(TRAIN)?.stage).toBe("cancelled");
    await h.tick();
    expect(ofType("train_failed").map((e) => e.data)).toEqual([
      { train: TRAIN, why: "cancelled", tasks: ["T1", "T2", "T3"] },
    ]);
    expect(h.record().state?.trains?.[0]?.state).toBe("failed");
    expect(held.get("/repo#release/w1")).not.toBe(`w1/${TRAIN}`);
  });
});

describe("merge train: the release lock on the way in and out", () => {
  it("train_started fails to journal: the lock is freed, and a later tick forms the train", async () => {
    const held = new Map<string, string>();
    await threeGatedBehind({ releaseLock: releaseLockOn(held) });
    let fail = true;
    h.world.journalFail = (ev) => fail && ev.type === "train_started";
    await h.tick();
    expect(ofType("train_started")).toEqual([]);
    expect(held.has("/repo#release/w1")).toBe(false);
    fail = false;
    await h.tick();
    expect(ofType("train_started").map((e) => e.data.train)).toEqual([TRAIN]);
    expect(held.get("/repo#release/w1")).toBe(`w1/${TRAIN}`);
  });

  it("a transient refusal of the train's merge (#445): the lock is kept, retried after the backoff, merged", async () => {
    const held = new Map<string, string>();
    await threeGatedBehind({ releaseLock: releaseLockOn(held) });
    await trainStarted();
    contains(TH, ["T1", "T2", "T3"]);
    h.world.mergeRefuse = "GraphQL: Merge already in progress (mergePullRequest)";
    await h.finish("integrator", { task: TRAIN, head: TH, ci: "green", result: RESULT });
    expect(mergeCalls()).toHaveLength(1);
    expect(ofType("train_failed")).toEqual([]);
    expect(h.openDecisions()).toEqual([]);
    expect(
      ofType("alarm_raised").find((e) => e.data.alarm === "merge_refused")?.data,
    ).toMatchObject({ reason: "transient", attempt: 1 });
    await h.tick();
    expect(held.get("/repo#release/w1")).toBe(`w1/${TRAIN}`);

    h.world.mergeRefuse = undefined;
    h.elapse(60_000);
    await h.tick();
    expect(mergeCalls()).toHaveLength(2);
    expect(ofType("train_merged")).toHaveLength(1);
    for (const t of ["T1", "T2", "T3", TRAIN]) expect(h.task(t)?.stage).toBe("done");
  });
});
