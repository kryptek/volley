import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { failingTests } from "../src/artifacts";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import type { EvidenceJson } from "../src/evidence";
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

/** Implement → reviews with P1s → fixup-1 → merge_ready at A. */
async function gatedAtA() {
  h = pipelineHarness();
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
    // CI on B is awaited (and visible); nothing is asked yet.
    const pending = h.events.find((e) => e.type === "ci_pending" && e.data.sha === B);
    expect(pending?.data.checks).toEqual({ done: 0, total: 1 });
    expect(h.task()?.why_waiting).toContain(`CI pending on ${B.slice(0, 7)}`);
    expect(h.openDecisions()).toEqual([]);
    // The move is journaled once.
    await poll();
    expect(h.events.filter((e) => e.type === "pr_head_moved")).toHaveLength(1);
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
});
