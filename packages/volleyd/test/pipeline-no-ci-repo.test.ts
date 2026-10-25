import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import { FIXTURES } from "./helpers/fake-host";
import { type Harness, pipelineHarness, sha } from "./helpers/pipeline-harness";

/**
 * A repository with no workflows and no required checks (`ci_mode: none`, read at admission,
 * SPEC §4.6.8): a head with no run is verified at once without CI (`ci: "none"`), the reviewers
 * and the gate being the check. Never a hold, a grace or an owner decision for it; a run that
 * does exist on a head is honoured as ever.
 */

const H1 = sha(0x602);
const A = sha(0x603);
const B = sha(0x604);
const result = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, "review-results", `${name}.json`), "utf-8"));

let h: Harness;
afterEach(() => h?.cleanup());

const of = (type: string) => h.events.filter((e) => e.type === type);
const mergeCalls = () => h.calls.filter((a) => a[0] === "gh" && a[1] === "pr" && a[2] === "merge");
const poll = async () => {
  h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
  await h.tick();
};

describe("ci_mode: none", () => {
  it("implementer done on a head with no run → artifact_verified with ci: none at once; the reviewers spawn", async () => {
    h = pipelineHarness({ ciMode: "none" });
    await h.start();
    h.openPr(H1);
    await h.finish("implementer", { head: H1 });
    const verified = of("artifact_verified").find((e) => e.data.role === "implementer");
    expect(verified?.data).toMatchObject({
      head_sha: H1,
      pr: { number: 7, head_sha: H1, ci: "none" },
      ci_runs: [],
    });
    expect(of("ci_pending")).toEqual([]);
    expect(h.openDecisions()).toEqual([]);
    expect(h.task()?.pr).toMatchObject({ ci: "none" });
    expect(h.task()?.why_waiting ?? "").not.toContain("CI pending");
    expect(h.spawns.map((s) => s.role)).toEqual([
      "implementer",
      "spec_reviewer",
      "quality_reviewer",
    ]);
  });

  it("a draft under merge: auto: marked ready, verified without CI, merged, no grace waited", async () => {
    h = pipelineHarness({ ciMode: "none", pipeline: "[implement, merge_ready]", merge: "auto" });
    await h.start();
    h.openPr(H1, "T1", 7, { draft: true });
    const t0 = Date.parse(h.iso(0));
    await h.finish("implementer", { head: H1 });
    expect(of("pr_marked_ready")).toHaveLength(1);
    for (let i = 0; i < 4 && mergeCalls().length === 0; i++) await poll();
    expect(of("artifact_verified").find((e) => e.data.role === "implementer")?.data).toMatchObject({
      pr: { ci: "none" },
      ci_runs: [],
    });
    expect(mergeCalls()).toEqual([
      ["gh", "pr", "merge", "7", "--squash", "--match-head-commit", H1],
    ]);
    expect(of("ci_pending")).toEqual([]);
    expect(h.openDecisions()).toEqual([]);
    expect(Date.parse(h.iso(0)) - t0).toBeLessThan(DAEMON_DEFAULTS.ci_none_grace_ms);
  });

  it("made a draft at its merge turn: refused, marked ready, ci_green at the gate with no runs, merged", async () => {
    h = pipelineHarness({ ciMode: "none", pipeline: "[implement, merge_ready]", merge: "auto" });
    await h.start();
    h.openPr(H1);
    await h.finish("implementer", { head: H1 });
    expect(h.task()?.stage).toBe("merge_ready");
    const pr = h.world.prs[0];
    if (pr !== undefined) pr.isDraft = true;
    await h.tick();
    expect(of("pr_marked_ready")).toHaveLength(1);
    for (let i = 0; i < 4 && mergeCalls().length === 0; i++) await poll();
    expect(of("ci_green").find((e) => e.data.role === "gate")?.data).toMatchObject({
      sha: H1,
      ci_runs: [],
    });
    expect(mergeCalls()).toEqual([
      ["gh", "pr", "merge", "7", "--squash", "--match-head-commit", H1],
    ]);
    expect(of("ci_pending")).toEqual([]);
    expect(h.openDecisions()).toEqual([]);
  });

  it("a head moved after the gate with no run → the pr_head_moved decision at once", async () => {
    h = pipelineHarness({ ciMode: "none" });
    await h.start();
    h.openPr(H1);
    await h.finish("implementer", { head: H1 });
    await h.finish("spec_reviewer", { result: result("spec-p1") });
    await h.finish("quality_reviewer", { result: result("quality-p1-elsewhere") });
    await h.finish("fixup", { head: A, result: result("fixup-resolved") });
    expect(h.task()?.stage).toBe("merge_ready");
    h.world.origin[h.PR_BRANCH] = B;
    for (const pr of h.world.prs) pr.headRefOid = B;
    await poll();
    await poll();
    expect(of("pr_head_moved")[0]?.data).toMatchObject({ from: A, to: B });
    expect(h.openDecisions().map((d) => d.kind)).toEqual(["pr_head_moved"]);
    expect(of("ci_pending")).toEqual([]);
  });

  it("a head that does have a red run is classified ci_failed as ever", async () => {
    h = pipelineHarness({ ciMode: "none" });
    await h.start();
    h.openPr(H1);
    await h.finish("implementer", { head: H1, ci: "red" });
    expect(of("artifact_verified")).toEqual([]);
    expect(h.openDecisions()[0]).toMatchObject({ kind: "ci_failed" });
    expect(h.task()?.pr).toMatchObject({ ci: "red" });
  });

  it("a head with a running run holds until it settles", async () => {
    h = pipelineHarness({ ciMode: "none" });
    await h.start();
    h.openPr(H1);
    await h.finish("implementer", { head: H1, ci: "running" });
    expect(of("artifact_verified")).toEqual([]);
    expect(of("ci_pending")).toHaveLength(1);
    h.world.ci[H1] = "green";
    await poll();
    expect(of("artifact_verified")[0]?.data).toMatchObject({ pr: { ci: "green" } });
  });
});

describe("ci_mode: workflows and required, with no run", () => {
  it("workflows: today's hold, then after the grace the ci_none decision offering accept", async () => {
    h = pipelineHarness({ ciMode: "workflows" });
    await h.start();
    h.openPr(H1);
    await h.finish("implementer", { head: H1 });
    expect(of("artifact_verified")).toEqual([]);
    expect(of("ci_pending")).toHaveLength(1);
    expect(h.openDecisions()).toEqual([]);
    h.elapse(DAEMON_DEFAULTS.ci_none_grace_ms + DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    const [d] = h.openDecisions();
    expect(d).toMatchObject({ kind: "ci_failed", options: ["accept", "cancel"] });
    expect(d?.question).toContain("Check the repository's workflows");
  });

  it("required: a hold, then a question naming the required checks, cancel only", async () => {
    h = pipelineHarness({ ciMode: "required", requiredChecks: ["build", "test"] });
    await h.start();
    h.openPr(H1);
    await h.finish("implementer", { head: H1 });
    expect(of("ci_pending")).toHaveLength(1);
    expect(h.openDecisions()).toEqual([]);
    h.elapse(DAEMON_DEFAULTS.ci_none_grace_ms + DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    const [d] = h.openDecisions();
    expect(d).toMatchObject({ kind: "ci_failed", options: ["cancel"] });
    expect(d?.question).toContain("release/w1 requires the checks build, test");
    expect(d?.question).not.toContain("Accept");
  });
});
