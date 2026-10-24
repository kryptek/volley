import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { failingTests } from "../src/artifacts";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import type { EvidenceJson } from "../src/evidence";
import { ready } from "../src/scheduler";
import { FIXTURES } from "./helpers/fake-host";
import { type Harness, pipelineHarness, sha } from "./helpers/pipeline-harness";

/**
 * A PR head that moves while the task sits at a gate (merge_ready, or a review in flight) is
 * noticed on the CI-poll cadence (the driver's injected clock): `pr_head_moved { from, to }`, the
 * gate invalidated (the task leaves merge_ready, its evidence marked stale, nothing downstream
 * admitted), CI awaited on the new head (`ci_pending`), then a `pr_head_moved` decision:
 * rereview | fixup | cancel. A red CI's failing jobs and tests go into the fixup's directive.
 */

const H1 = sha(0x1001);
const A = sha(0x1002); // the gated head (after the first fixup)
const B = sha(0x1003); // pushed outside the pipeline
const C = sha(0x1004); // the next fixup's head
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf-8");
const result = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, "review-results", `${name}.json`), "utf-8"));

let h: Harness;
afterEach(() => h?.cleanup());

/** Implement → reviews with P1s → fixup-1 → merge_ready at A. T2 waits for T1. */
async function gatedAtA() {
  h = pipelineHarness({ dependents: { T2: ["T1"] } });
  await h.start();
  h.openPr(H1);
  await h.finish("implementer", { head: H1, ci: "green" });
  await h.finish("spec_reviewer", { result: result("spec-p1") });
  await h.finish("quality_reviewer", { result: result("quality-p1-elsewhere") });
  await h.finish("fixup", { head: A, ci: "green", result: result("fixup-resolved") });
  expect(h.task()?.stage).toBe("merge_ready");
}

/** Someone pushes B to the PR branch (e.g. merges the release branch into it). */
function pushB(ci?: "green" | "red" | "running") {
  h.world.origin[h.PR_BRANCH] = B;
  for (const pr of h.world.prs) pr.headRefOid = B;
  if (ci !== undefined) h.world.ci[B] = ci;
}

const poll = async () => {
  h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
  await h.tick();
};
const evidence = (): EvidenceJson =>
  JSON.parse(readFileSync((h.task()?.evidence_path as string).replace(/\.md$/, ".json"), "utf-8"));

/** Red CI on B with two failing tests in its log. */
function redOnB() {
  h.world.ci[B] = "red";
  h.world.runJobs = fixture("gh-run-failed-jobs.json");
  h.world.runLog = fixture("gh-run-log-failed.txt");
}

describe("PR head moved during the CI hold", () => {
  it("fixup-1 done, CI on its head running, B pushed → pr_head_moved from the reviewed head, then the decision", async () => {
    h = pipelineHarness();
    await h.start();
    h.openPr(H1);
    await h.finish("implementer", { head: H1, ci: "green" });
    await h.finish("spec_reviewer", { result: result("spec-p1") });
    await h.finish("quality_reviewer", { result: result("quality-p1-elsewhere") });
    await h.finish("fixup", { head: A, ci: "running", result: result("fixup-resolved") });
    expect(h.events.some((e) => e.type === "ci_pending" && e.data.sha === A)).toBe(true);
    pushB("running");
    await poll();
    const moved = h.events.find((e) => e.type === "pr_head_moved");
    // The reviews saw H1: the move is from there (fixup-1's A was never accepted).
    expect(moved?.data).toMatchObject({ from: H1, to: B, during: "fixup" });
    // No verify-mismatch question about the agent's push.
    expect(
      h.events.some((e) => e.type === "decision_opened" && e.data.kind === "agent_blocked"),
    ).toBe(false);
    redOnB();
    await poll();
    const [d] = h.openDecisions();
    expect(d).toMatchObject({ kind: "pr_head_moved", options: ["rereview", "fixup", "cancel"] });
    await h.resolve(d?.decision_id as string, "fixup");
    expect(h.spawns.filter((s) => s.role === "fixup").map((s) => s.agent_id)).toEqual([
      "w1-t1-fixup-1",
      "w1-t1-fixup-2",
    ]);
  });

  it("the implementer's CI hold: a push to its PR is a move too (the PR comes from the hold)", async () => {
    h = pipelineHarness();
    await h.start();
    h.openPr(H1);
    await h.finish("implementer", { head: H1, ci: "running" });
    expect(h.events.some((e) => e.type === "ci_pending" && e.data.sha === H1)).toBe(true);
    pushB("green");
    await poll();
    expect(h.events.find((e) => e.type === "pr_head_moved")?.data).toMatchObject({
      from: H1,
      to: B,
    });
    await poll();
    const [d] = h.openDecisions();
    expect(d).toMatchObject({ kind: "pr_head_moved" });
    expect(d?.pointers?.pr).toBe("https://github.com/example/repo/pull/7");
  });

  it("CI settling on the held head without a push is not a move", async () => {
    h = pipelineHarness();
    await h.start();
    h.openPr(H1);
    await h.finish("implementer", { head: H1, ci: "running" });
    h.world.ci[H1] = "green";
    await poll();
    expect(h.events.some((e) => e.type === "pr_head_moved")).toBe(false);
    expect(h.events.some((e) => e.type === "ci_green")).toBe(true);
  });
});

describe("PR head moved at merge_ready", () => {
  it("is noticed: pr_head_moved, gate invalidated, evidence stale, CI awaited on the new head", async () => {
    await gatedAtA();
    pushB("running");
    await poll();
    const moved = h.events.find((e) => e.type === "pr_head_moved");
    expect(moved?.data).toMatchObject({ from: A, to: B, during: "merge_ready" });
    expect(h.task()?.stage).not.toBe("merge_ready");
    expect(h.record().state?.gates).toEqual([]);
    expect(evidence().stale).toMatchObject({ from: A, to: B });
    // Nothing downstream is admitted while the head is unanswered.
    expect(ready(h.record())).toEqual([]);
    // CI on B is awaited (and visible); nothing is asked yet.
    const pending = h.events.find((e) => e.type === "ci_pending" && e.data.sha === B);
    expect(pending?.data.checks).toEqual({ done: 0, total: 1 });
    expect(h.task()?.why_waiting).toContain(`CI pending on ${B.slice(0, 7)}`);
    expect(h.openDecisions()).toEqual([]);
    // The move is journaled once.
    await poll();
    expect(h.events.filter((e) => e.type === "pr_head_moved")).toHaveLength(1);
  });

  it("CI on B unreadable past ci_none_grace_ms: an unreadable hold, never the decision (#310)", async () => {
    await gatedAtA();
    pushB();
    h.world.ciError = "HTTP 502: Bad Gateway";
    const until = DAEMON_DEFAULTS.ci_none_grace_ms + 2 * DAEMON_DEFAULTS.ci_poll_ms;
    for (let t = 0; t <= until; t += DAEMON_DEFAULTS.ci_poll_ms) await poll();
    expect(h.events.some((e) => e.type === "pr_head_moved")).toBe(true);
    expect(h.openDecisions()).toEqual([]);
    const pending = h.events.find((e) => e.type === "ci_pending" && e.data.sha === B);
    expect(pending?.data).toMatchObject({
      reason: "ci_unreadable",
      error: "HTTP 502: Bad Gateway",
    });
    expect(h.task()?.why_waiting).toBe("CI unreadable (HTTP 502: Bad Gateway), retrying");
    // Readable again: green on B asks (the reviews saw A).
    h.world.ciError = undefined;
    h.world.ci[B] = "green";
    await poll();
    expect(h.openDecisions()).toHaveLength(1);
  });

  it("CI red on B → decision rereview | fixup | cancel with the failing jobs and tests; fixup → fixup-2 with the directive", async () => {
    await gatedAtA();
    pushB("running");
    await poll();
    redOnB();
    await poll();
    const [d] = h.openDecisions();
    expect(d).toMatchObject({
      kind: "pr_head_moved",
      task: "T1",
      options: ["rereview", "fixup", "cancel"],
    });
    const x = d as unknown as Record<string, unknown>;
    expect(x.failed_jobs).toEqual(["CI / test (volleyd)"]);
    expect(x.failing_tests).toEqual([
      "test/pipeline.test.ts > pipeline: the default sequence > implement then merge_ready",
      "test/clock.test.ts > sleep > resolves on abort",
    ]);
    expect(d?.question).toContain(B.slice(0, 7));
    expect(d?.question).toContain("red");
    expect(h.events.some((e) => e.type === "decision_opened" && e.data.kind === "ci_failed")).toBe(
      false,
    );

    await h.resolve(d?.decision_id as string, "fixup");
    const fixups = h.spawns.filter((s) => s.role === "fixup");
    expect(fixups.map((s) => s.agent_id)).toEqual(["w1-t1-fixup-1", "w1-t1-fixup-2"]);
    const f2 = fixups[1];
    expect(f2?.start).toEqual({ ref: B, detach: false });
    const brief = f2?.files["findings.md"] as string;
    expect(brief).toContain("CI / test (volleyd)");
    expect(brief).toContain("test/clock.test.ts > sleep > resolves on abort");
    expect(brief).toContain(`${A.slice(0, 12)}..${B.slice(0, 12)}`);
    expect(brief).toContain("src/batch.ts"); // the A→B diffstat
    // The old findings were fixed by fixup-1: they are not handed out again.
    expect(JSON.parse(f2?.files["findings.json"] as string)).toEqual([]);

    // fixup-2 fixes CI → the gate again, its evidence regenerated with every head.
    await h.finish("fixup", {
      head: C,
      ci: "green",
      result: { resolved: [{ finding: "CI", how: "fixed the clock test" }] },
    });
    expect(h.task()?.stage).toBe("merge_ready");
    const ev = evidence();
    expect(ev.head_sha).toBe(C);
    expect(ev.stale).toBeUndefined();
    expect(ev.head_history).toEqual([A, B, C]);
  });

  it("rereview → spec + quality on B (a new round) → fixup with the CI directive → the gate", async () => {
    await gatedAtA();
    pushB("running");
    await poll();
    redOnB();
    await poll();
    const [d] = h.openDecisions();
    await h.resolve(d?.decision_id as string, "rereview");
    const round2 = h.spawns.filter((s) => s.role !== "implementer" && s.role !== "fixup").slice(2);
    expect(round2.map((s) => [s.role, s.start])).toEqual([
      ["spec_reviewer", { ref: B, detach: true }],
      ["quality_reviewer", { ref: B, detach: true }],
    ]);
    expect(
      h.events.filter((e) => e.type === "stage_entered" && e.data.review_round === 2),
    ).toHaveLength(1);
    // Both approve, but CI on B is red: the fixup still runs, with the directive.
    await h.finish("spec_reviewer", { result: result("approve-empty") });
    await h.finish("quality_reviewer", { result: result("approve-empty") });
    const f2 = h.spawns.filter((s) => s.role === "fixup")[1];
    expect(f2?.files["findings.md"]).toContain("CI / test (volleyd)");
    await h.finish("fixup", {
      head: C,
      ci: "green",
      result: { resolved: [{ finding: "CI", how: "fixed" }] },
    });
    expect(h.task()?.stage).toBe("merge_ready");
    expect(evidence().head_history).toEqual([A, B, C]);
  });

  it("CI green on B still asks (the reviews saw A); rereview with approvals gates at B", async () => {
    await gatedAtA();
    pushB("green");
    await poll();
    await poll();
    const [d] = h.openDecisions();
    expect(d?.kind).toBe("pr_head_moved");
    expect(d?.question).toContain("green");
    await h.resolve(d?.decision_id as string, "rereview");
    await h.finish("spec_reviewer", { result: result("approve-empty") });
    await h.finish("quality_reviewer", { result: result("approve-empty") });
    expect(h.spawns.filter((s) => s.role === "fixup")).toHaveLength(1);
    expect(h.task()?.stage).toBe("merge_ready");
    expect(evidence()).toMatchObject({ head_sha: B, head_history: [A, B] });
  });

  it("an accepted moved head's evidence keeps the runs superseded on it", async () => {
    await gatedAtA();
    pushB();
    h.world.ciRuns[B] = [
      { status: "completed", conclusion: "cancelled", id: 1301, workflow: "CI" },
      { status: "completed", conclusion: "success", id: 1302, workflow: "CI" },
    ];
    await poll();
    await poll();
    const [d] = h.openDecisions();
    expect(d?.kind).toBe("pr_head_moved");
    await h.resolve(d?.decision_id as string, "rereview");
    await h.finish("spec_reviewer", { result: result("approve-empty") });
    await h.finish("quality_reviewer", { result: result("approve-empty") });
    expect(h.task()?.stage).toBe("merge_ready");
    expect(evidence().ci).toEqual({
      status: "green",
      runs: [expect.objectContaining({ id: 1302 })],
      superseded: [
        {
          id: 1301,
          url: "https://github.com/example/repo/actions/runs/1301",
          conclusion: "cancelled",
        },
      ],
    });
  });

  it("cancel cancels the task", async () => {
    await gatedAtA();
    pushB("green");
    await poll();
    await poll();
    const [d] = h.openDecisions();
    await h.resolve(d?.decision_id as string, "cancel");
    expect(h.task()?.stage).toBe("cancelled");
  });
});

describe("PR head moved at another gate", () => {
  it("a move while the reviews run is handled the same way", async () => {
    h = pipelineHarness();
    await h.start();
    h.openPr(H1);
    await h.finish("implementer", { head: H1, ci: "green" });
    expect(h.task()?.stage).toBe("spec_review");
    h.world.origin[h.PR_BRANCH] = B;
    for (const pr of h.world.prs) pr.headRefOid = B;
    h.world.ci[B] = "green";
    await poll();
    expect(h.events.find((e) => e.type === "pr_head_moved")?.data).toMatchObject({
      from: H1,
      to: B,
      during: "spec_review",
    });
    await poll();
    expect(h.openDecisions().map((d) => d.kind)).toEqual(["pr_head_moved"]);
  });
});

describe("failingTests (pure)", () => {
  it("reads vitest and bun failures from a --log-failed log, once each", () => {
    expect(failingTests(fixture("gh-run-log-failed.txt"))).toEqual([
      "test/pipeline.test.ts > pipeline: the default sequence > implement then merge_ready",
      "test/clock.test.ts > sleep > resolves on abort",
    ]);
    expect(failingTests("job\tstep\t(fail) sleep > resolves on abort [3.1ms]\n")).toEqual([
      "sleep > resolves on abort",
    ]);
  });

  it("a bun id picks up its file from the log's ##[group]<file>: header", () => {
    const log = [
      "job\tstep\t2026-10-24T01:02:03Z ##[group]test/clock.test.ts:",
      "job\tstep\t2026-10-24T01:02:04Z (fail) sleep > resolves on abort [3.1ms]",
      "job\tstep\t2026-10-24T01:02:04Z ##[endgroup]",
      "job\tstep\t2026-10-24T01:02:05Z (fail) orphan > no header [1ms]",
    ].join("\n");
    expect(failingTests(log)).toEqual([
      "test/clock.test.ts > sleep > resolves on abort",
      "orphan > no header",
    ]);
  });
});

describe("PR head moved: answers that must not go wrong", () => {
  it("an answer that is not an option re-asks, and the re-ask keeps the directive", async () => {
    await gatedAtA();
    pushB("running");
    await poll();
    redOnB();
    await poll();
    const [d] = h.openDecisions();
    await h.resolve(d?.decision_id as string, "maybe");
    const [again] = h.openDecisions();
    expect(again?.decision_id).not.toBe(d?.decision_id);
    await h.resolve(again?.decision_id as string, "fixup");
    const f2 = h.spawns.filter((s) => s.role === "fixup")[1];
    expect(f2?.files["findings.md"]).toContain("CI / test (volleyd)");
    expect(JSON.parse(f2?.files["findings.json"] as string)).toEqual([]);
  });

  it("a red moved head with no fixup stage after the reviews is not offered rereview", async () => {
    h = pipelineHarness({ pipeline: "[implement, [spec_review, quality_review], merge_ready]" });
    await h.start();
    h.openPr(A);
    await h.finish("implementer", { head: A, ci: "green" });
    await h.finish("spec_reviewer", { result: result("approve-empty") });
    await h.finish("quality_reviewer", { result: result("approve-empty") });
    expect(h.task()?.stage).toBe("merge_ready");
    pushB();
    redOnB();
    await poll();
    await poll();
    const [d] = h.openDecisions();
    expect(d?.options).toEqual(["fixup", "cancel"]);
    await h.resolve(d?.decision_id as string, "rereview");
    expect(h.spawns.filter((s) => s.role === "spec_reviewer")).toHaveLength(1);
    // The answer it was not offered leaves the move to answer: the re-ask's fixup is the
    // owner's acceptance of B, so the gate holds at the fixup's head.
    const [again] = h.openDecisions();
    expect(again?.options).toEqual(["fixup", "cancel"]);
    await h.resolve(again?.decision_id as string, "fixup");
    await h.finish("fixup", { head: C, ci: "green", result: result("fixup-resolved") });
    expect(h.openDecisions()).toEqual([]);
    expect(h.task()?.stage).toBe("merge_ready");
    expect(evidence().moves).toContainEqual(
      expect.objectContaining({ from: A, to: B, accepted_by: "coord-1" }),
    );
  });

  it("merged while its pr_head_moved decision is open: the late answer spawns nothing", async () => {
    await gatedAtA();
    pushB("green");
    await poll();
    await poll();
    const [d] = h.openDecisions();
    await h.driver.handle("T1", {
      kind: "operator_merged",
      sha: B,
      by: "coord-1",
      how: "ancestor",
      head: A,
    });
    await h.resolve(d?.decision_id as string, "fixup");
    expect(h.task()?.stage).toBe("done");
    expect(h.spawns.filter((s) => s.role === "fixup")).toHaveLength(1);
    expect(ready(h.record())).toEqual(["T2"]);
  });
});

describe("PR head moved by a merge of the release branch only", () => {
  const X = sha(0x1005); // a commit on the release branch
  const MB = sha(0x1006); // where the PR branched from the release branch

  /** B merges X into A; the move touches `moved`, the release branch changed CHANGELOG + src/x.ts. */
  function releaseMergeB(moved: string[], ci: "green" | "red" = "green") {
    h.world.parents[B] = [A, X];
    h.world.ancestor[`${X}..${h.world.releaseTip}`] = true;
    h.world.mergeBase[A] = MB;
    h.world.diffNames[`${A}..${B}`] = moved;
    h.world.diffNames[`${MB}..${X}`] = ["CHANGELOG.md", "src/x.ts"];
    pushB(ci);
  }

  it("CI green and only release files touched → accept is offered; accept gates at B with the reviews of A", async () => {
    await gatedAtA();
    releaseMergeB(["CHANGELOG.md"]);
    await poll();
    await poll();
    const [d] = h.openDecisions();
    expect(d?.options).toEqual(["rereview", "fixup", "accept", "cancel"]);
    expect(d?.question).toContain("a merge of release/w1 only");
    expect(d?.question).toContain("CHANGELOG.md");
    expect(d?.question).toContain("may carry content resolved by hand");
    await h.resolve(d?.decision_id as string, "accept", "owner");
    const verified = h.events
      .filter((e) => e.type === "artifact_verified" && e.data.adopted)
      .at(-1);
    expect(verified?.data).toMatchObject({
      head_sha: B,
      adopted: true,
      accepted_by: "owner",
      move: { from: A, to: B, how: "release_merge", parent: X, touched: ["CHANGELOG.md"] },
    });
    // No re-review, no fixup: straight to the gate at B.
    expect(h.spawns.filter((s) => s.role === "spec_reviewer")).toHaveLength(1);
    expect(h.spawns.filter((s) => s.role === "fixup")).toHaveLength(1);
    expect(h.task()?.stage).toBe("merge_ready");
    const ev = evidence();
    expect(ev.head_sha).toBe(B);
    expect(ev.stale).toBeUndefined();
    expect(ev.moves).toEqual([
      expect.objectContaining({
        from: A,
        to: B,
        how: "release_merge",
        accepted_by: "owner",
        touched: ["CHANGELOG.md"],
      }),
    ]);
  });

  it("a file of the PR's own in the move → no accept; answering accept re-asks", async () => {
    await gatedAtA();
    releaseMergeB(["CHANGELOG.md", "src/mine.ts"]);
    await poll();
    await poll();
    const [d] = h.openDecisions();
    expect(d?.options).toEqual(["rereview", "fixup", "cancel"]);
    await h.resolve(d?.decision_id as string, "accept", "owner");
    const [again] = h.openDecisions();
    expect(again?.decision_id).not.toBe(d?.decision_id);
    expect(again?.question).toMatch(/^"accept" is not one of rereview \/ fixup \/ cancel\./);
    expect(h.task()?.stage).not.toBe("merge_ready");
  });

  it("accepted while the reviewers still run: their reviews of H1 hold at B, one pr_head_moved, the gate at B (#270)", async () => {
    h = pipelineHarness();
    await h.start();
    h.openPr(H1);
    await h.finish("implementer", { head: H1, ci: "green" });
    expect(h.task()?.stage).toBe("spec_review");
    // B merges X into H1 (an "Update branch") before either reviewer reports.
    h.world.parents[B] = [H1, X];
    h.world.ancestor[`${X}..${h.world.releaseTip}`] = true;
    h.world.mergeBase[H1] = MB;
    h.world.diffNames[`${H1}..${B}`] = ["CHANGELOG.md"];
    h.world.diffNames[`${MB}..${X}`] = ["CHANGELOG.md"];
    pushB("green");
    await poll();
    await poll();
    const [d] = h.openDecisions();
    expect(d?.options).toContain("accept");
    await h.resolve(d?.decision_id as string, "accept", "volleyd");

    await h.finish("spec_reviewer", { result: result("approve-empty") });
    await poll();
    await h.finish("quality_reviewer", { result: result("approve-empty") });
    for (let i = 0; i < 3; i++) await poll();

    expect(h.events.filter((e) => e.type === "pr_head_moved")).toHaveLength(1);
    expect(h.events.filter((e) => e.type === "decision_opened")).toHaveLength(1);
    expect(h.events.map((e) => e.data.alarm)).not.toContain("merge_ready_invariant");
    expect(h.spawns.filter((s) => s.role === "spec_reviewer")).toHaveLength(1);
    expect(h.task()?.stage).toBe("merge_ready");
    const ev = evidence();
    expect(ev.head_sha).toBe(B);
    expect(ev.stale).toBeUndefined();
  });

  it("red CI on a release-only merge → no accept", async () => {
    await gatedAtA();
    releaseMergeB(["CHANGELOG.md"], "red");
    await poll();
    await poll();
    const [d] = h.openDecisions();
    expect(d?.options).toEqual(["rereview", "fixup", "cancel"]);
  });
});

describe("PR merged on GitHub while not at merge_ready", () => {
  it("merged while its pr_head_moved decision is open → superseded_by_merge, done, dependents admitted", async () => {
    await gatedAtA();
    pushB("green");
    await poll();
    await poll();
    const [d] = h.openDecisions();
    expect(d?.kind).toBe("pr_head_moved");
    h.world.prState[7] = "MERGED";
    await poll();
    const types = h.events.map((e) => e.type);
    const resolved = h.events.findIndex(
      (e) => e.type === "decision_resolved" && e.data.decision_id === d?.decision_id,
    );
    expect(h.events[resolved]?.data).toMatchObject({
      answer: "superseded_by_merge",
      by: "volleyd",
    });
    const merged = h.events.findIndex(
      (e) => e.type === "artifact_verified" && e.data.role === "merged",
    );
    const done = h.events.findIndex(
      (e) => e.type === "stage_entered" && e.data.stage === "done" && e.data.merged === true,
    );
    expect(resolved).toBeGreaterThan(-1);
    expect(resolved).toBeLessThan(merged);
    expect(merged).toBeLessThan(done);
    expect(types).toContain("alarm_raised");
    expect(
      h.events.find((e) => e.type === "alarm_raised" && e.data.alarm === "merged_unverified_head")
        ?.data,
    ).toMatchObject({ gated: A, merged: B });
    expect(h.task()?.stage).toBe("done");
    expect(h.openDecisions()).toEqual([]);
    expect(ready(h.record())).toEqual(["T2"]);
    // The answer reaching the pipeline afterwards does nothing (a done task acts on no answer).
    await h.driver.handle("T1", {
      kind: "decision_resolved",
      decision: h.record().decisions[d?.decision_id as string] as never,
    });
    expect(h.openDecisions()).toEqual([]);
  });
});
