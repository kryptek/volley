import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS, DAEMON_DEFAULTS } from "../src/config-defaults";
import type { DecisionRecord } from "../src/decisions";
import type { EvidenceJson } from "../src/evidence";
import { roleSpawnHold } from "../src/pipeline";
import { eventually } from "./helpers/broker-wait";
import { FIXTURES } from "./helpers/fake-host";
import {
  type Harness,
  type HarnessOptions,
  pipelineHarness,
  sha,
} from "./helpers/pipeline-harness";

const result = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, "review-results", `${name}.json`), "utf-8"));

const H1 = sha(0x1001);
const H2 = sha(0x1002);
const H3 = sha(0x1003);
const H4 = sha(0x1004);

let h: Harness;
afterEach(() => h?.cleanup());

const types = () => h.events.map((e) => e.type);
const stage = () => h.task()?.stage;

/** Implementer done with its PR open and CI green on H1. */
async function implemented(o: HarnessOptions = {}) {
  h = pipelineHarness(o);
  await h.start();
  h.openPr(H1);
  await h.finish("implementer", { head: H1, ci: "green" });
}

/** Through both reviews (spec P1 + P2; quality P1 + P3 elsewhere) to a spawned fixup. */
async function reviewed(o: HarnessOptions = {}) {
  await implemented(o);
  await h.finish("spec_reviewer", { result: result("spec-p1") });
  await h.finish("quality_reviewer", { result: result("quality-p1-elsewhere") });
}

describe("pipeline: the default sequence", () => {
  it("implement → both reviewers in parallel at the same head → fixup → merge_ready", async () => {
    await implemented();
    // Implementer verified (pushed, PR, CI green on H1), then retired.
    const verified = h.events.find((e) => e.type === "artifact_verified");
    expect(verified?.data).toMatchObject({ role: "implementer", head_sha: H1, pr: { number: 7 } });
    expect(h.run("implementer")?.retired).toBe("done");

    // Two spawns, different roles, same head, detached worktrees.
    const reviewers = h.spawns.filter((s) => s.role !== "implementer");
    expect(reviewers.map((s) => s.role)).toEqual(["spec_reviewer", "quality_reviewer"]);
    expect(reviewers.map((s) => s.start)).toEqual([
      { ref: H1, detach: true },
      { ref: H1, detach: true },
    ]);
    expect(reviewers[0]?.files["review.md"]).toContain("ISSUE.md");
    expect(reviewers[0]?.files["review.md"]).toContain(`git diff origin/release/w1...${H1}`);
    expect(stage()).toBe("spec_review");
    expect(h.task()?.agents).toMatchObject({
      spec_reviewer: reviewers[0]?.agent_id,
      quality_reviewer: reviewers[1]?.agent_id,
    });

    // One reviewer done: the other still runs, nothing advances.
    await h.finish("spec_reviewer", { result: result("spec-p1") });
    expect(h.spawns.some((s) => s.role === "fixup")).toBe(false);
    await h.finish("quality_reviewer", { result: result("quality-p1-elsewhere") });

    const fixup = h.spawns.find((s) => s.role === "fixup");
    expect(fixup?.start).toEqual({ ref: H1, detach: false });
    expect(fixup?.files["findings.md"]).toContain("Empty batches reach the API");
    expect(fixup?.files["findings.md"]).toContain("Retries forever on a 4xx");
    expect(stage()).toBe("fixup");

    await h.finish("fixup", { head: H2, ci: "green", result: result("fixup-resolved") });
    expect(stage()).toBe("merge_ready");
    expect(h.record().state?.gates).toEqual(["T1"]);
    expect(h.task()?.pr).toMatchObject({ head_sha: H2, ci: "green" });
    expect(existsSync(h.task()?.evidence_path as string)).toBe(true);
    // Every agent was retired once.
    expect(h.events.filter((e) => e.type === "agent_retired")).toHaveLength(4);
  });

  it("a custom [implement, merge_ready] pipeline skips the reviews", async () => {
    await implemented({ pipeline: "[implement, merge_ready]" });
    expect(h.spawns.map((s) => s.role)).toEqual(["implementer"]);
    expect(stage()).toBe("merge_ready");
    expect(h.record().state?.gates).toEqual(["T1"]);
  });

  it("a reviewer done without a parseable result is steered once, then a decision", async () => {
    await implemented();
    const spec = h.run("spec_reviewer")?.agent_id as string;
    await h.finish("spec_reviewer", { result: result("unparseable") });
    expect(h.steers).toEqual([
      expect.objectContaining({ role: "spec_reviewer", agent_id: spec, reason: "result" }),
    ]);
    expect(h.steers[0]?.text).toMatch(/channel="result", type="review"/);
    expect(h.run("spec_reviewer")?.retired).toBeUndefined(); // still alive, re-waited

    await h.finish("spec_reviewer", {}); // done again, still no result
    expect(h.steers).toHaveLength(1);
    expect(h.run("spec_reviewer")?.retired).toBe("done");
    const [d] = h.openDecisions();
    expect(d).toMatchObject({ kind: "agent_blocked", task: "T1", options: ["respawn", "skip"] });
    expect(stage()).toBe("awaiting_decision");

    // skip → an empty review; with the other reviewer approving, the fixup is skipped too.
    await h.finish("quality_reviewer", { result: result("approve-empty") });
    await h.resolve(d?.decision_id as string, "skip");
    expect(h.spawns.some((s) => s.role === "fixup")).toBe(false);
    expect(stage()).toBe("merge_ready");
  });

  it("public hygiene p1: a review without the hygiene block is steered once, with the 0.3.1 text", async () => {
    await implemented();
    await h.finish("spec_reviewer", { result: result("no-hygiene") });
    expect(h.steers).toHaveLength(1);
    expect(h.steers[0]?.text).toBe(
      'Your done arrived without a parseable review result. Publish it first — vol_publish(channel="result", type="review", payload={ "findings": [{ "severity": "P1"|"P2"|"P3", "file": "<path>", "line": <n>, "text": "<finding>" }], "verdict": "approve"|"changes_requested", "hygiene": { "checked": true, "findings": [<public-hygiene P1s, same shape>] } }) — then publish done again.',
    );
  });

  it("public hygiene p3 (private repo): a review without the block is accepted; hits stay P3", async () => {
    await implemented({ hygiene: "p3" });
    await h.finish("spec_reviewer", { result: result("no-hygiene") });
    expect(h.steers).toEqual([]);
    expect(h.run("spec_reviewer")?.retired).toBe("done");
    await h.finish("quality_reviewer", {
      result: {
        findings: [],
        verdict: "approve",
        hygiene: {
          checked: true,
          findings: [{ severity: "P1", file: "docs/ops.md", line: 3, text: "a hostname" }],
        },
      },
    });
    expect(h.steers).toEqual([]);
    const verified = h.events.filter(
      (e) => e.type === "artifact_verified" && e.data.role === "quality_reviewer",
    );
    expect((verified.at(-1)?.data.review as { findings: { severity: string }[] }).findings).toEqual(
      [expect.objectContaining({ severity: "P3", file: "docs/ops.md" })],
    );
  });

  it("an unparseable result → respawn answer starts a fresh reviewer at the same head", async () => {
    await implemented();
    await h.finish("spec_reviewer", {});
    await h.finish("spec_reviewer", {});
    const [d] = h.openDecisions();
    await h.resolve(d?.decision_id as string, "respawn");
    const specs = h.spawns.filter((s) => s.role === "spec_reviewer");
    expect(specs).toHaveLength(2);
    expect(specs[1]?.start).toEqual({ ref: H1, detach: true });
    expect(specs[1]?.agent_id).not.toBe(specs[0]?.agent_id);
  });

  it("reviewers disagreeing on a P1 park the task on reviewers_disagree; 'fine' downgrades it", async () => {
    await implemented();
    await h.finish("spec_reviewer", { result: result("spec-p1") });
    await h.finish("quality_reviewer", { result: result("quality-fine-same-hunk") });
    const [d] = h.openDecisions();
    expect(d?.kind).toBe("reviewers_disagree");
    expect(h.spawns.some((s) => s.role === "fixup")).toBe(false);
    await h.resolve(d?.decision_id as string, "fine");
    const fixup = h.spawns.find((s) => s.role === "fixup");
    expect(fixup?.files["findings.md"]).toMatch(/S1 · P3.*not a blocker/);
  });
});

describe("pipeline: artifacts and CI", () => {
  it("missing push: steer the implementer once, then an agent_blocked decision", async () => {
    h = pipelineHarness();
    await h.start();
    await h.finish("implementer", { head: H1, push: false });
    expect(h.steers).toEqual([
      expect.objectContaining({ role: "implementer", reason: "artifacts" }),
    ]);
    expect(h.steers[0]?.text).toMatch(/publish done again/);
    expect(h.events.filter((e) => e.type === "alarm_raised").at(-1)?.data).toMatchObject({
      alarm: "artifact_missing",
      missing: "push",
    });
    // Pushed but still no PR: no second steer.
    await h.finish("implementer", { head: H1 });
    expect(h.steers).toHaveLength(1);
    const [d] = h.openDecisions();
    expect(d).toMatchObject({ kind: "agent_blocked", options: ["respawn", "re-verify", "cancel"] });
    // The owner opens the PR by hand and answers re-verify.
    h.openPr(H1);
    h.world.ci[H1] = "green";
    await h.resolve(d?.decision_id as string, "re-verify");
    expect(h.spawns.map((s) => s.role)).toContain("spec_reviewer");
  });

  it("CI red escalates as ci_failed (never re-run); pending CI is re-checked, not escalated", async () => {
    h = pipelineHarness();
    await h.start();
    h.openPr(H1);
    await h.finish("implementer", { head: H1, ci: "running" });
    expect(h.openDecisions()).toEqual([]);
    expect(h.run("implementer")?.retired).toBe("done");
    expect(stage()).toBe("implement");

    // Re-checks are rate-limited.
    const runLists = () => h.calls.filter((c) => c[1] === "run" && c[2] === "list").length;
    const before = runLists();
    await h.tick();
    expect(runLists()).toBe(before);
    h.world.ci[H1] = "red";
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    const [d] = h.openDecisions();
    expect(d?.kind).toBe("ci_failed");
    expect(d?.question).toContain("actions/runs/1001");
    expect(h.calls.some((c) => c.includes("rerun"))).toBe(false);
  });
});

describe("pipeline: rebase before the gate", () => {
  /** Reviews done, fixup pushed H2 green, and the release branch moved meanwhile. */
  async function fixedUpBehind() {
    await reviewed();
    h.world.mergeBase[H2] = sha(0xdead);
    await h.finish("fixup", { head: H2, ci: "green", result: result("fixup-resolved") });
  }

  it("release branch moved: a rebase agent starts at the head; touching a flagged file re-runs that reviewer only", async () => {
    await fixedUpBehind();
    expect(stage()).toBe("fixup");
    const rebase = h.spawns.find((s) => s.role === "rebase");
    expect(rebase?.start).toEqual({ ref: H2, detach: false });
    expect(rebase?.files["rebase.md"]).toContain("--force-with-lease=");

    // The rebase changed src/api.ts — flagged only by the spec reviewer.
    h.world.diffNames[`${H2}..${H3}`] = ["src/api.ts"];
    await h.finish("rebase", { head: H3, ci: "green" });
    const specs = h.spawns.filter((s) => s.role === "spec_reviewer");
    expect(specs).toHaveLength(2);
    expect(specs[1]?.start).toEqual({ ref: H3, detach: true });
    expect(h.spawns.filter((s) => s.role === "quality_reviewer")).toHaveLength(1);
    expect(stage()).toBe("spec_review");

    await h.finish("spec_reviewer", { result: result("approve-empty") });
    expect(stage()).toBe("merge_ready");
    expect(h.task()?.pr?.head_sha).toBe(H3);
  });

  it("a rebase that touched no flagged file goes straight to the gate", async () => {
    await fixedUpBehind();
    h.world.diffNames[`${H2}..${H3}`] = ["README.md"];
    await h.finish("rebase", { head: H3, ci: "green" });
    expect(h.spawns.filter((s) => s.role === "spec_reviewer")).toHaveLength(1);
    expect(stage()).toBe("merge_ready");
  });

  it("CI must be green on the post-rebase head before the gate", async () => {
    await fixedUpBehind();
    h.world.diffNames[`${H2}..${H3}`] = ["README.md"];
    await h.finish("rebase", { head: H3, ci: "running" });
    expect(stage()).toBe("fixup");
    expect(h.record().state?.gates).toEqual([]);
    h.world.ci[H3] = "green";
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    expect(stage()).toBe("merge_ready");
    expect(h.task()?.pr?.head_sha).toBe(H3);
  });

  it("the release branch not moving means no rebase", async () => {
    await reviewed();
    await h.finish("fixup", { head: H2, ci: "green", result: result("fixup-resolved") });
    expect(h.spawns.some((s) => s.role === "rebase")).toBe(false);
    expect(types()).toContain("stage_entered");
    expect(stage()).toBe("merge_ready");
  });
});

describe("pipeline: branch_update: merge (no force-push)", () => {
  /** As fixedUpBehind, with the `branch_update` tunable set (default `merge`). */
  async function behindInMergeMode(mode: "merge" | "rebase" = "merge") {
    h = pipelineHarness({ branchUpdate: mode });
    await h.start();
    h.openPr(H1);
    await h.finish("implementer", { head: H1, ci: "green" });
    await h.finish("spec_reviewer", { result: result("spec-p1") });
    await h.finish("quality_reviewer", { result: result("quality-p1-elsewhere") });
    h.world.mergeBase[H2] = sha(0xdead);
    await h.finish("fixup", { head: H2, ci: "green", result: result("fixup-resolved") });
  }

  it("the update step merges the release branch and pushes without force; the merge commit passes verification", async () => {
    await behindInMergeMode();
    const step = h.spawns.find((s) => s.role === "rebase");
    expect(step?.start).toEqual({ ref: H2, detach: false });
    expect(step?.branch_update).toBe("merge");
    const md = step?.files["rebase.md"] as string;
    expect(md).toContain("# Merge");
    expect(md).toContain("git merge --no-edit origin/release/w1");
    expect(md).toContain("git push origin HEAD:w1/T1-implementer-1");
    expect(md).not.toMatch(/force/i);
    expect(md).not.toContain("git rebase");
    const entered = h.events.filter((e) => e.type === "stage_entered").at(-1);
    expect(entered?.data).toMatchObject({ rebase: true, branch_update: "merge" });

    // H3 is a merge commit: it contains the release tip and descends from H2.
    h.world.ancestor[`${H2}..${H3}`] = true;
    h.world.diffNames[`${H2}..${H3}`] = ["README.md"];
    await h.finish("rebase", { head: H3, ci: "green" });
    expect(
      h.events.find((e) => e.type === "artifact_verified" && e.data.role === "rebase")?.data,
    ).toMatchObject({ head_sha: H3 });
    expect(stage()).toBe("merge_ready");
    expect(h.task()?.pr?.head_sha).toBe(H3);
    expect(
      h.calls.some(
        (c) => c.join(" ") === `git -C /wt/w1/T1-rebase-1 merge-base --is-ancestor ${H2} ${H3}`,
      ),
    ).toBe(true);
    // volleyd itself never pushes, merges or rebases.
    expect(
      h.calls.filter((c) => c.includes("push") || c[3] === "merge" || c[3] === "rebase"),
    ).toEqual([]);
  });

  it("a head that rewrote the PR history (a force-push) is not accepted in merge mode", async () => {
    await behindInMergeMode();
    // H3 does not descend from H2: the branch was rebased and force-pushed.
    await h.finish("rebase", { head: H3, ci: "green" });
    expect(stage()).toBe("fixup");
    expect(h.events.some((e) => e.type === "artifact_verified" && e.data.role === "rebase")).toBe(
      false,
    );
    const steer = h.steers.find((s) => s.role === "rebase");
    expect(steer?.text).toContain(`does not descend from ${H2.slice(0, 12)}`);
    expect(steer?.text).toContain("Do not force-push.");
    expect(steer?.text).toContain(
      `\`git fetch origin && git checkout -B fix ${H2} && git merge --no-edit origin/release/w1 && git merge --no-edit origin/${h.record().pipeline.T1?.branch}\``,
    );
    expect(steer?.text).toContain(
      `then \`git push origin HEAD:${h.record().pipeline.T1?.branch}\` (a normal push)`,
    );
    expect(steer?.text).not.toMatch(/force-with-lease|lease-guarded|--force\b/);

    // A second miss goes to the owner, worded as the merge step it is.
    await h.finish("rebase", { head: H3, ci: "green" });
    const d = Object.values(h.record().decisions).find((x) => x.kind === "agent_blocked");
    expect(d?.question).toMatch(/^merge \(branch update\) /);
    expect(d?.question).toContain("does not descend from");
  });

  it("the mode is fixed when the step starts: a later config change does not reach it", async () => {
    await behindInMergeMode();
    h.setBranchUpdate("rebase");
    h.world.ancestor[`${H2}..${H3}`] = true;
    h.world.diffNames[`${H2}..${H3}`] = ["README.md"];
    await h.finish("rebase", { head: H3, ci: "green" });
    expect(stage()).toBe("merge_ready");
    expect(h.calls.some((c) => c.includes("--is-ancestor") && c.includes(H3))).toBe(true);
  });

  it("a step after a config change takes the new mode, even straight after a merge step", async () => {
    await behindInMergeMode();
    h.setBranchUpdate("rebase");
    h.world.ancestor[`${H2}..${H3}`] = true;
    h.world.diffNames[`${H2}..${H3}`] = ["README.md"];
    // The release branch moved again past the merge commit: another update step.
    h.world.mergeBase[H3] = sha(0xbeef);
    await h.finish("rebase", { head: H3, ci: "green" });
    const steps = h.spawns.filter((s) => s.role === "rebase");
    expect(steps).toHaveLength(2);
    expect(steps[1]?.branch_update).toBeUndefined();
    expect(steps[1]?.files["rebase.md"]).toContain("--force-with-lease=");
    expect(h.events.filter((e) => e.type === "stage_entered").at(-1)?.data).not.toHaveProperty(
      "branch_update",
    );
    expect(h.record().pipeline.T1?.branch_update).toBeUndefined();
  });

  it("rebase (the default) keeps the lease-guarded push and no ancestry check", async () => {
    await behindInMergeMode("rebase");
    const step = h.spawns.find((s) => s.role === "rebase");
    expect(step?.branch_update).toBeUndefined();
    expect(step?.files["rebase.md"]).toContain("git rebase origin/release/w1");
    expect(step?.files["rebase.md"]).toContain("--force-with-lease=");
    const entered = h.events.filter((e) => e.type === "stage_entered").at(-1);
    expect(entered?.data).not.toHaveProperty("branch_update");
    h.world.diffNames[`${H2}..${H3}`] = ["README.md"];
    await h.finish("rebase", { head: H3, ci: "green" });
    expect(h.calls.some((c) => c.includes("--is-ancestor") && c.includes(H3))).toBe(false);
    expect(stage()).toBe("merge_ready");
  });
});

describe("pipeline: after the gate", () => {
  it("merge_ready → done once a human merged the PR (polled read-only), releasing dependents", async () => {
    await implemented({ pipeline: "[implement, merge_ready]" });
    expect(stage()).toBe("merge_ready");
    // Still open: polling (rate-limited) changes nothing.
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    expect(stage()).toBe("merge_ready");
    const views = h.calls.filter((c) => c[1] === "pr" && c[2] === "view");
    expect(views.at(-1)).toEqual([
      "gh",
      "pr",
      "view",
      "7",
      "--json",
      "state,mergedAt,mergeCommit,baseRefName,headRefOid",
    ]);

    h.world.prState[7] = "MERGED";
    await h.tick(); // within the poll interval: not re-checked yet
    expect(stage()).toBe("merge_ready");
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    expect(stage()).toBe("done");
    expect(h.record().state?.gates).toEqual([]);
    expect(h.events.find((e) => e.data.role === "merged")?.data).toMatchObject({
      merge_sha: sha(0xa11),
    });
    // volleyd itself never merged anything.
    expect(h.calls.some((c) => c.includes("merge") && c[0] === "gh" && c[2] === "merge")).toBe(
      false,
    );
  });

  it("a PR closed without merging (and not landed) asks once with pr_closed, no bare alarm", async () => {
    await implemented({ pipeline: "[implement, merge_ready]" });
    h.world.prState[7] = "CLOSED";
    for (let i = 0; i < 2; i++) {
      h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
      await h.tick();
    }
    expect(stage()).toBe("awaiting_decision");
    expect(h.openDecisions().map((d) => d.kind)).toEqual(["pr_closed"]);
    expect(h.events.filter((e) => e.data.alarm === "pr_closed_unmerged")).toHaveLength(0);
  });
});

describe("pipeline: the merge nudge", () => {
  const T2 = "w1-t2-implementer-1";
  const T3 = "w1-t3-implementer-1";
  const T4 = "w1-t4-implementer-1";

  /**
   * T1 gated; T2 (hint overlaps the merged PR), T3 (hint does not), T4 (no hint) implementing;
   * T5 (hint overlaps) starts only after the merge. `filesFail`: the PR's file list does not
   * parse until the test restores it.
   */
  async function mergedWith(
    nudgeOnMerge?: "files" | "all" | "off",
    o: { filesFail?: boolean } = {},
  ) {
    h = pipelineHarness({
      pipeline: "[implement, merge_ready]",
      siblings: {
        T2: ["packages/volleyd/src/daemon.ts", "packages/volleyd/test/daemon.test.ts"],
        T3: ["packages/volley-desk/src/app.tsx"],
        T4: null,
        T5: ["packages/volleyd/src/overlap.ts"],
      },
      ...(nudgeOnMerge !== undefined ? { nudgeOnMerge } : {}),
    });
    await h.start();
    h.openPr(H1);
    await h.finish("implementer", { head: H1, ci: "green" });
    for (const t of ["T2", "T3", "T4"]) await h.startSibling(t);
    expect(stage()).toBe("merge_ready");
    if (o.filesFail === true) h.world.prFiles[7] = "<html>rate limited</html>";
    h.world.prState[7] = "MERGED";
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    expect(stage()).toBe("done");
  }
  const filesCalls = () => h.calls.filter((c) => c[1] === "pr" && c.at(-1) === "files");
  const nudges = () => h.events.filter((e) => e.type === "merge_nudge_sent");

  it("files (the default): one steering to the implementer whose files hint overlaps the merged PR, none to the others", async () => {
    await mergedWith();
    expect(h.steers).toEqual([
      {
        task: "T2",
        role: "implementer",
        agent_id: T2,
        reason: "merge_nudge",
        text: expect.stringContaining(
          `origin/release/w1 moved to ${sha(0xa11).slice(0, 7)} with #7 (touches 1 of your files`,
        ),
      },
    ]);
    expect(h.steers[0]?.text).toContain("rebase when convenient");
    expect(h.steers[0]?.text).toContain("packages/volleyd/src/daemon.ts");
    // The PR's files were read once, read-only.
    expect(h.calls.filter((c) => c[1] === "pr" && c.at(-1) === "files")).toEqual([
      ["gh", "pr", "view", "7", "--json", "files"],
    ]);
    expect(nudges()).toHaveLength(1);
    expect(nudges()[0]).toMatchObject({
      task: "T2",
      data: {
        task: "T2",
        agent_id: T2,
        merged_pr: 7,
        files: ["packages/volleyd/src/daemon.ts"],
        merged_task: "T1",
        pr_url: "https://github.com/example/repo/pull/7",
      },
    });
    // The journaled steering is the existing steer path's.
    expect(h.events.filter((e) => e.type === "steering_sent").map((e) => e.task)).toEqual(["T2"]);
  });

  it("a second observation of the same merge sends nothing", async () => {
    await mergedWith();
    expect(h.steers).toHaveLength(1);
    // Seen again (a later tick, a restart's re-observation): no second nudge.
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    await h.driver.nudgeMerged("T1");
    await h.driver.settled();
    expect(h.steers).toHaveLength(1);
    expect(nudges()).toHaveLength(1);
  });

  it("a failed file list is retried on a later tick: exactly one nudge, and no re-read once sent", async () => {
    await mergedWith("files", { filesFail: true });
    expect(nudges()).toEqual([]);
    expect(
      h.events.filter((e) => e.data.alarm === "pipeline_error" && e.data.check === "merge_nudge"),
    ).toHaveLength(1);
    // Not before the re-check interval.
    await h.tick();
    expect(filesCalls()).toHaveLength(1);
    h.world.prFiles = {};
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    expect(h.steers.map((x) => x.agent_id)).toEqual([T2]);
    expect(nudges()).toHaveLength(1);
    // Sent: later ticks neither nudge again nor read the file list again.
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    expect(filesCalls()).toHaveLength(2);
    expect(nudges()).toHaveLength(1);
  });

  it("a restart after the merge was journaled but before the nudge went out: sent once on the next start", async () => {
    h = pipelineHarness({
      pipeline: "[implement, merge_ready]",
      siblings: { T2: ["packages/volleyd/src/daemon.ts"] },
    });
    await h.start();
    h.openPr(H1);
    await h.finish("implementer", { head: H1, ci: "green" });
    await h.startSibling("T2");
    // The file list never comes back: the daemon dies with the nudge unsent.
    h.world.hang = (a) => a[1] === "pr" && a.at(-1) === "files";
    h.world.prState[7] = "MERGED";
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.driver.tick();
    // Not settled (the file list hangs): the merge folds back in on the queue soon after.
    await eventually(() => stage() === "done");
    expect(nudges()).toEqual([]);
    h.world.hang = undefined;
    h.restart();
    await h.tick();
    expect(h.steers.map((x) => x.agent_id)).toEqual([T2]);
    expect(nudges()).toHaveLength(1);
    // A second restart finds it journaled: nothing more.
    h.restart();
    await h.tick();
    expect(nudges()).toHaveLength(1);
  });

  it("an implementer spawned after the merge is never nudged about it (its base already has it)", async () => {
    await mergedWith("files", { filesFail: true });
    const T5 = await h.startSibling("T5");
    h.world.prFiles = {};
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    expect(h.steers.map((x) => x.agent_id)).toEqual([T2]);
    expect(h.steers.map((x) => x.agent_id)).not.toContain(T5);
  });

  it("the nudge lists at most 5 of the overlapping files; merge_nudge_sent keeps them all", async () => {
    const many = Array.from({ length: 8 }, (_, i) => `packages/volleyd/src/m${i}.ts`);
    h = pipelineHarness({
      pipeline: "[implement, merge_ready]",
      siblings: { T2: ["packages/volleyd/**"] },
    });
    await h.start();
    h.openPr(H1);
    await h.finish("implementer", { head: H1, ci: "green" });
    await h.startSibling("T2");
    h.world.prFiles[7] = JSON.stringify({ files: many.map((path) => ({ path })) });
    h.world.prState[7] = "MERGED";
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    const text = h.steers[0]?.text ?? "";
    expect(text).toContain(`touches 8 of your files: ${many.slice(0, 5).join(", ")} and 3 more`);
    expect(text).not.toContain(many[5] as string);
    expect(nudges()[0]?.data.files).toEqual(many);
  });

  it("all: every running implementer of the wave, a task without a files hint included", async () => {
    await mergedWith("all");
    expect(h.steers.map((x) => x.agent_id).sort()).toEqual([T2, T3, T4]);
    expect(nudges().map((e) => e.data.files)).toEqual([[], [], []]);
    // No file list is needed to nudge everyone.
    expect(h.calls.some((c) => c[1] === "pr" && c.at(-1) === "files")).toBe(false);
  });

  it("off: no nudge at all", async () => {
    await mergedWith("off");
    expect(h.steers).toEqual([]);
    expect(nudges()).toEqual([]);
  });
});

describe("pipeline role spawns", () => {
  it("a reviewer gets its own detached worktree at the head, per attempt, with its inputs", async () => {
    const { makeSpawnEnv } = await import("./helpers/fake-host");
    const { spawnAgent } = await import("../src/spawn");
    const env = await makeSpawnEnv();
    try {
      const res = await spawnAgent(
        env.request({
          role: "spec_reviewer",
          attempt: 2,
          start: { ref: H1, detach: true },
          files: { "review.md": "# What to review\n" },
        }),
        env.deps,
      );
      expect(res.kind).toBe("launched");
      const wt = join(env.dir, "wt", "w1", "T1-spec_reviewer-2");
      expect(env.host.worktrees[0]).toMatchObject({ path: wt, base: H1, detach: true });
      expect(readFileSync(join(wt, ".volley", "review.md"), "utf-8")).toBe("# What to review\n");
      expect(existsSync(join(wt, "ISSUE.md"))).toBe(true);
      expect(env.events.find((e) => e.type === "agent_spawned")?.data).toMatchObject({
        role: "spec_reviewer",
        start: H1,
        detached: true,
        branch: `HEAD (detached at ${H1})`,
      });
      if (res.kind === "launched") {
        await res.verified;
        res.lock.release();
      }
    } finally {
      await env.cleanup();
    }
  });

  it("the quality reviewer's worktree has no ISSUE.md (it reviews the diff only)", async () => {
    const { makeSpawnEnv } = await import("./helpers/fake-host");
    const { spawnAgent } = await import("../src/spawn");
    const env = await makeSpawnEnv();
    try {
      const res = await spawnAgent(
        env.request({
          role: "quality_reviewer",
          attempt: 1,
          start: { ref: H1, detach: true },
          files: { "review.md": "# What to review\n" },
        }),
        env.deps,
      );
      expect(res.kind).toBe("launched");
      const wt = join(env.dir, "wt", "w1", "T1-quality_reviewer-1");
      expect(existsSync(join(wt, ".volley", "review.md"))).toBe(true);
      expect(existsSync(join(wt, "ISSUE.md"))).toBe(false);
      if (res.kind === "launched") {
        await res.verified;
        res.lock.release();
      }
    } finally {
      await env.cleanup();
    }
  });

  it("git worktree add --detach for a detached spec (fenced argv)", async () => {
    const { addWorktree } = await import("../src/worktree");
    const { fakeExec } = await import("./helpers/fake-exec");
    const fx = fakeExec().on(["git", "-C", "/repo", "rev-parse", "--git-common-dir"], { code: 1 });
    const r = await addWorktree(fx.exec, {
      repo: "/repo",
      path: "/nonexistent/wt/T1-spec_reviewer-1",
      branch: "w1/T1-spec_reviewer-1",
      base: H1,
      detach: true,
    });
    expect(fx.argvs(["git", "-C", "/repo", "worktree"])).toEqual([
      [
        "git",
        "-C",
        "/repo",
        "worktree",
        "add",
        "--detach",
        "/nonexistent/wt/T1-spec_reviewer-1",
        H1,
      ],
    ]);
    expect(r.branch).toBe(`HEAD (detached at ${H1})`);
  });
});

/** The gate's evidence JSON. */
const evidence = (): EvidenceJson =>
  JSON.parse(readFileSync((h.task()?.evidence_path as string).replace(/\.md$/, ".json"), "utf-8"));

describe("pipeline: the fixup's result is durable", () => {
  it("a fixup done while CI is still running keeps its resolutions until CI settles", async () => {
    await reviewed();
    await h.finish("fixup", { head: H2, ci: "running", result: result("fixup-resolved") });
    expect(stage()).toBe("fixup");
    h.world.ci[H2] = "green";
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    expect(stage()).toBe("merge_ready");
    expect(h.record().pipeline.T1?.fixups[0]?.result).toEqual(result("fixup-resolved"));
    const j = evidence();
    expect(j.unresolved_p1).toEqual([]);
    expect(j.reviews.spec_reviewer?.findings[0]?.resolution).toMatch(/\S/);
    // The fixup's diffstat keeps git's alignment.
    expect(readFileSync(h.task()?.evidence_path as string, "utf-8")).toContain(
      "```\n src/batch.ts | 4 ++--\n 1 file changed\n```",
    );
  });

  it("CI red at the fixup's done → re-verify after a fix keeps the resolutions", async () => {
    await reviewed();
    await h.finish("fixup", { head: H2, ci: "red", result: result("fixup-resolved") });
    const [d] = h.openDecisions();
    expect(d?.kind).toBe("ci_failed");
    h.world.ci[H2] = "green";
    await h.resolve(d?.decision_id as string, "re-verify");
    expect(stage()).toBe("merge_ready");
    expect(evidence().unresolved_p1).toEqual([]);
  });

  it("a fixup done without a parseable result is steered once, then a decision", async () => {
    await reviewed();
    const id = h.run("fixup")?.agent_id as string;
    await h.finish("fixup", { head: H2, ci: "green" });
    expect(h.steers).toEqual([
      expect.objectContaining({ role: "fixup", agent_id: id, reason: "result" }),
    ]);
    expect(h.steers[0]?.text).toMatch(/channel="result", type="fixup"/);
    expect(h.run("fixup")?.accepted).toBe(false);
    await h.finish("fixup", { head: H2, ci: "green" });
    expect(h.steers).toHaveLength(1);
    const [d] = h.openDecisions();
    expect(d).toMatchObject({ kind: "agent_blocked", options: ["skip", "respawn", "cancel"] });
    // skip: the pushed work is verified; the P1s it reported nothing for stay UNRESOLVED.
    await h.resolve(d?.decision_id as string, "skip");
    expect(stage()).toBe("merge_ready");
    expect(evidence().unresolved_p1).toEqual(["S1", "Q1"]);
  });
});

describe("pipeline: decisions", () => {
  it("a free-text answer that merely contains 'cancel' does not cancel", async () => {
    await reviewed();
    await h.finish("fixup", { head: H2, ci: "red", result: result("fixup-resolved") });
    const [d] = h.openDecisions();
    await h.resolve(d?.decision_id as string, "re-verify, do not cancel");
    expect(stage()).not.toBe("cancelled");
    // Re-verified (still red): asked again.
    expect(h.openDecisions().map((x) => x.kind)).toEqual(["ci_failed"]);
  });

  it("an answer that is not one of the options re-asks instead of guessing", async () => {
    await implemented();
    await h.finish("spec_reviewer", {});
    await h.finish("spec_reviewer", {});
    const [d] = h.openDecisions();
    await h.resolve(d?.decision_id as string, "hmm, not sure");
    const [again] = h.openDecisions();
    expect(again?.decision_id).not.toBe(d?.decision_id);
    expect(again).toMatchObject({ kind: "agent_blocked", options: ["respawn", "skip"] });
    expect(again?.question).toMatch(/not one of/);
  });

  it("a respawn the daemon holds is retried on later ticks", async () => {
    await implemented();
    await h.finish("spec_reviewer", { status: "failed" });
    const [d] = h.openDecisions();
    expect(d?.options).toEqual(["respawn", "cancel"]);
    h.holdSpawns(true);
    await h.resolve(d?.decision_id as string, "respawn");
    expect(h.spawns.filter((s) => s.role === "spec_reviewer")).toHaveLength(1);
    await h.tick();
    expect(h.spawns.filter((s) => s.role === "spec_reviewer")).toHaveLength(1);
    h.holdSpawns(false);
    await h.tick();
    const specs = h.spawns.filter((s) => s.role === "spec_reviewer");
    expect(specs).toHaveLength(2);
    expect(specs[1]?.start).toEqual({ ref: H1, detach: true });
    expect(h.task()?.agents.spec_reviewer).toBe(specs[1]?.agent_id);
  });

  it("a P1 the owner ruled not a blocker is not an unresolved P1 in the evidence", async () => {
    await implemented();
    await h.finish("spec_reviewer", { result: result("spec-p1") });
    await h.finish("quality_reviewer", { result: result("quality-fine-same-hunk") });
    const [d] = h.openDecisions();
    await h.resolve(d?.decision_id as string, "fine");
    // The fixup resolves nothing it reports (S1 is a P3 to it now).
    await h.finish("fixup", { head: H2, ci: "green", result: { resolved: [] } });
    expect(stage()).toBe("merge_ready");
    const j = evidence();
    expect(j.unresolved_p1).toEqual([]);
    expect(j.reviews.spec_reviewer?.findings[0]).toMatchObject({
      id: "S1",
      severity: "P3",
      note: "owner: not a blocker (coord-1)",
    });
    const md = readFileSync(h.task()?.evidence_path as string, "utf-8");
    expect(md).toMatch(/S1 · P3.*owner: not a blocker/);
  });
});

describe("pipeline: rebase without CI", () => {
  it("accepting a no-CI rebase head keeps its touched files: a flagged one still re-runs that review", async () => {
    await reviewed();
    h.world.mergeBase[H2] = sha(0xdead);
    await h.finish("fixup", { head: H2, ci: "green", result: result("fixup-resolved") });
    h.world.diffNames[`${H2}..${H3}`] = ["src/api.ts"];
    await h.finish("rebase", { head: H3 }); // no CI run at all
    h.elapse(DAEMON_DEFAULTS.ci_none_grace_ms + DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    const [d] = h.openDecisions();
    expect(d?.options).toEqual(["accept", "cancel"]);
    await h.resolve(d?.decision_id as string, "accept");
    expect(h.record().pipeline.T1?.rebases).toEqual([
      { from: H2, to: H3, touched: ["src/api.ts"] },
    ]);
    expect(h.spawns.filter((s) => s.role === "spec_reviewer")).toHaveLength(2);
    expect(stage()).toBe("spec_review");
  });
});

describe("pipeline: the PR head at the gate and at the merge", () => {
  it("a PR merged on GitHub while the reviews run → done, the reviewers retired, merged_unverified_head", async () => {
    await implemented();
    expect(stage()).toBe("spec_review");
    const reviewers = h.spawns.filter((s) => s.role !== "implementer").map((s) => s.agent_id);
    expect(reviewers).toHaveLength(2);
    h.world.prState[7] = "MERGED";
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    expect(stage()).toBe("done");
    expect(h.retired.map((r) => r.agent_id)).toEqual(expect.arrayContaining(reviewers));
    expect(
      h.events.find((e) => e.type === "alarm_raised" && e.data.alarm === "merged_unverified_head")
        ?.data,
    ).toMatchObject({ gated: H1, merged: H1 });
    expect(
      h.events.find((e) => e.type === "stage_entered" && e.data.stage === "done")?.data,
    ).toMatchObject({ merged: true });
    // A reviewer reporting after the merge changes nothing.
    await h.finish("spec_reviewer", { result: result("approve-empty") });
    expect(stage()).toBe("done");
  });

  it("an open PR outside merge_ready is only read: no gate, no move", async () => {
    await implemented();
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    expect(stage()).toBe("spec_review");
    expect(h.calls).toContainEqual([
      "gh",
      "pr",
      "view",
      "7",
      "--json",
      "state,mergedAt,mergeCommit,baseRefName,headRefOid",
    ]);
    expect(h.events.some((e) => e.type === "pr_head_moved")).toBe(false);
  });

  it("a push after verification is re-verified before the gate; the evidence names both heads", async () => {
    h = pipelineHarness({ pipeline: "[implement, merge_ready]" });
    await h.start();
    h.openPr(H1);
    // Someone pushes H2 to the PR after the implementer's H1 was verified, before the gate.
    h.world.before = (a) => {
      if (a[1] !== "pr" || a[2] !== "view") return;
      h.world.before = undefined;
      h.world.origin[h.PR_BRANCH] = H2;
      (h.world.prs[0] as { headRefOid: string }).headRefOid = H2;
      h.world.ci[H2] = "running";
    };
    await h.finish("implementer", { head: H1, ci: "green" });
    expect(h.events.find((e) => e.data.alarm === "pr_head_moved")?.data).toMatchObject({
      expected: H1,
      actual: H2,
    });
    expect(stage()).toBe("implement");
    expect(h.record().state?.gates).toEqual([]);
    h.world.ci[H2] = "green";
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    expect(stage()).toBe("merge_ready");
    const j = evidence();
    expect(j.head_sha).toBe(H2);
    expect(j.moves).toEqual([{ from: H1, to: H2, touched: [] }]);
    expect(readFileSync(h.task()?.evidence_path as string, "utf-8")).toMatch(
      /pushed outside the pipeline/,
    );
  });

  it("a push after the reviews breaks the merge_ready invariant: the owner gets a decision, rereview re-runs the reviewers at the new head", async () => {
    await reviewed();
    // Someone pushes H3 to the PR after the fixup's H2 was verified, before the gate.
    h.world.before = (a) => {
      if (a[1] !== "pr" || a[2] !== "view") return;
      h.world.before = undefined;
      h.world.origin[h.PR_BRANCH] = H3;
      (h.world.prs[0] as { headRefOid: string }).headRefOid = H3;
      h.world.ci[H3] = "green";
    };
    await h.finish("fixup", { head: H2, ci: "green", result: result("fixup-resolved") });
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    expect(h.record().pipeline.T1?.moves).toEqual([{ from: H2, to: H3, touched: [] }]);
    // Nobody reviewed H3: no gate, the task is parked on a decision that says why.
    expect(h.record().state?.gates).toEqual([]);
    expect(h.events.find((e) => e.data.alarm === "merge_ready_invariant")?.data).toMatchObject({
      head: H3,
      stale: ["spec_reviewer", "quality_reviewer"],
    });
    const [d] = h.openDecisions();
    expect(d).toMatchObject({ kind: "agent_blocked", task: "T1", options: ["rereview", "cancel"] });
    expect(d?.question).toMatch(/spec_reviewer, quality_reviewer/);
    expect(stage()).toBe("awaiting_decision");
    expect(h.task()?.why_waiting).toMatch(/awaiting decision/);
    // Parked: later ticks do not ask again; they only look for a merge of the PR.
    const calls = h.calls.length;
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    expect(h.openDecisions()).toHaveLength(1);
    expect(h.calls.slice(calls)).toEqual([
      ["gh", "pr", "view", "7", "--json", "state,mergedAt,mergeCommit,baseRefName,headRefOid"],
    ]);

    await h.resolve(d?.decision_id as string, "rereview");
    const reviewers = h.spawns.filter((s) => s.role !== "implementer" && s.start?.ref === H3);
    expect(reviewers.map((s) => s.role)).toEqual(["spec_reviewer", "quality_reviewer"]);
    expect(reviewers.every((s) => s.start?.detach === true)).toBe(true);
    expect(stage()).toBe("spec_review");
    await h.finish("spec_reviewer", { result: result("approve-empty") });
    await h.finish("quality_reviewer", { result: result("approve-empty") });
    expect(stage()).toBe("merge_ready");
    expect(evidence().head_sha).toBe(H3);
  });

  it("a PR merged at another head than the gated one is done, with an alarm naming both", async () => {
    await implemented({ pipeline: "[implement, merge_ready]" });
    (h.world.prs[0] as { headRefOid: string }).headRefOid = H2;
    h.world.prState[7] = "MERGED";
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    expect(stage()).toBe("done");
    expect(h.events.find((e) => e.data.alarm === "merged_unverified_head")?.data).toMatchObject({
      gated: H1,
      merged: H2,
    });
    expect(h.events.find((e) => e.data.role === "merged")?.data).toMatchObject({
      head_sha: H1,
      merged_head_sha: H2,
    });
  });
});

describe("pipeline: the merge_ready invariant under autopilot", () => {
  /** Autopilot's agent_blocked/rereview-stale within rereview_max (2), then the owner's. */
  const rereviewMax = () => {
    let used = 0;
    return (d: DecisionRecord) =>
      (d as { pipeline?: { on?: string } }).pipeline?.on === "merge_ready_invariant" &&
      used++ < CONFIG_DEFAULTS.autopilot.rereview_max
        ? "rereview"
        : undefined;
  };
  const invariantDecisions = () =>
    h.events.filter(
      (e) =>
        e.type === "decision_opened" &&
        (e.data.pipeline as { on?: string } | undefined)?.on === "merge_ready_invariant",
    );
  const rounds = () =>
    h.events.filter((e) => e.type === "stage_entered" && e.data.stage === "spec_review");

  it("the head moves while both reviewers work: one decision, one rereview, one round, no escalation", async () => {
    h = pipelineHarness({ autopilot: rereviewMax() });
    await h.start();
    h.openPr(H1);
    await h.finish("implementer", { head: H1, ci: "green" });
    expect(rounds()).toHaveLength(1);
    // An "Update branch" push to the PR while the reviewers work: they approve H1.
    h.world.origin[h.PR_BRANCH] = H2;
    (h.world.prs[0] as { headRefOid: string }).headRefOid = H2;
    h.world.ci[H2] = "green";
    await h.finish("spec_reviewer", { result: result("approve-empty") });
    // The second reviewer's done is the observation that finds the head moved.
    await h.finish("quality_reviewer", { result: result("approve-empty") });
    expect(h.events.find((e) => e.data.alarm === "merge_ready_invariant")?.data).toMatchObject({
      head: H2,
      stale: ["spec_reviewer", "quality_reviewer"],
    });
    expect(invariantDecisions()).toHaveLength(1);
    expect(h.openDecisions()).toEqual([]);
    // One re-review round at H2, and its approvals gate the task.
    expect(rounds()).toHaveLength(2);
    const again = h.spawns.filter((s) => s.role !== "implementer" && s.start?.ref === H2);
    expect(again.map((s) => s.role)).toEqual(["spec_reviewer", "quality_reviewer"]);
    await h.finish("spec_reviewer", { result: result("approve-empty") });
    await h.finish("quality_reviewer", { result: result("approve-empty") });
    expect(stage()).toBe("merge_ready");
    expect(h.openDecisions()).toEqual([]);
  });

  it("a push after the fixup is verified: one decision answered rereview starts one round", async () => {
    await reviewed({ autopilot: rereviewMax() });
    h.world.before = (a) => {
      if (a[1] !== "pr" || a[2] !== "view") return;
      h.world.before = undefined;
      h.world.origin[h.PR_BRANCH] = H3;
      (h.world.prs[0] as { headRefOid: string }).headRefOid = H3;
      h.world.ci[H3] = "green";
    };
    await h.finish("fixup", { head: H2, ci: "green", result: result("fixup-resolved") });
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    expect(invariantDecisions()).toHaveLength(1);
    expect(h.openDecisions()).toEqual([]);
    expect(rounds()).toHaveLength(2);
    expect(h.spawns.filter((s) => s.start?.ref === H3).map((s) => s.role)).toEqual([
      "spec_reviewer",
      "quality_reviewer",
    ]);
  });

  it("an answer that is not an option is asked again once, and its rereview starts one round", async () => {
    const answers = ["later", "rereview"];
    await reviewed({ autopilot: () => answers.shift() });
    h.world.before = (a) => {
      if (a[1] !== "pr" || a[2] !== "view") return;
      h.world.before = undefined;
      h.world.origin[h.PR_BRANCH] = H3;
      (h.world.prs[0] as { headRefOid: string }).headRefOid = H3;
      h.world.ci[H3] = "green";
    };
    await h.finish("fixup", { head: H2, ci: "green", result: result("fixup-resolved") });
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    const asked = invariantDecisions();
    expect(asked).toHaveLength(2);
    expect(asked[1]?.data.question).toMatch(/"later" is not one of rereview \/ cancel/);
    expect(h.openDecisions()).toEqual([]);
    expect(rounds()).toHaveLength(2);
  });
});

describe("pipeline: I/O never blocks the queue", () => {
  it("every git / gh call has a hard timeout", async () => {
    await reviewed();
    await h.finish("fixup", { head: H2, ci: "green", result: result("fixup-resolved") });
    expect(stage()).toBe("merge_ready");
    expect(h.calls.length).toBeGreaterThan(0);
    expect(h.callOpts.every((o) => o.timeoutMs === DAEMON_DEFAULTS.pipeline_io_ms)).toBe(true);
  });

  it("a hung gh call does not hold up handle(): the work runs beside the queue", async () => {
    h = pipelineHarness();
    await h.start();
    h.openPr(H1);
    h.world.hang = (a) => a[0] === "gh";
    const done = h.driver.handle("T1", {
      kind: "agent_done",
      role: "implementer",
      agent_id: h.run("implementer")?.agent_id as string,
      status: "done",
    });
    // The hung gh call never resolves: a handle() blocked on it would never return.
    expect(await done.then(() => "returned")).toBe("returned");
    // A second observation of the same check while it is in flight starts nothing new.
    const n = h.calls.length;
    await h.driver.tick();
    expect(h.calls.length).toBe(n);
  });

  it("a timed-out call is 'not verified yet': no alarm, re-checked on a later tick", async () => {
    h = pipelineHarness();
    await h.start();
    h.openPr(H1);
    h.world.ci[H1] = "green";
    h.world.local[h.run("implementer")?.worktree as string] = H1;
    h.world.origin[h.PR_BRANCH] = H1;
    (h.world.prs[0] as { headRefOid: string }).headRefOid = H1;
    h.world.timeout = (a) => a[1] === "run";
    await h.finish("implementer", {});
    expect(h.events.filter((e) => e.type === "alarm_raised")).toEqual([]);
    expect(h.openDecisions()).toEqual([]);
    expect(stage()).toBe("implement");
    h.world.timeout = undefined;
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    expect(h.spawns.map((s) => s.role)).toContain("spec_reviewer");
  });

  it("an error in one check is one pipeline_error alarm, not an aborted tick", async () => {
    await implemented({ pipeline: "[implement, merge_ready]" });
    h.cleanup();
    h = pipelineHarness({ pipeline: "[implement, merge_ready]" });
    await h.start();
    h.openPr(H1);
    h.world.fail = (a) => a[0] === "git" && a.includes("merge-base");
    await h.finish("implementer", { head: H1, ci: "green" });
    for (let i = 0; i < 2; i++) {
      h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
      await expect(h.tick()).resolves.toBeUndefined();
    }
    const alarms = h.events.filter((e) => e.data.alarm === "pipeline_error");
    expect(alarms).toHaveLength(1);
    expect(alarms[0]?.data.message).toMatch(/ENOENT/);
    h.world.fail = undefined;
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    expect(stage()).toBe("merge_ready");
  });
});

describe("pipeline: where the checks run", () => {
  it("a task's git / gh checks go through its own exec when it has one (a remote host)", async () => {
    const used: string[][] = [];
    h = pipelineHarness({
      execFor: (task, exec) => async (argv, opts) => {
        used.push([task, ...argv.slice(0, 3)]);
        return exec(argv, opts);
      },
    });
    await h.start();
    h.openPr(H1);
    await h.finish("implementer", { head: H1, ci: "green" });
    expect(stage()).toBe("spec_review");
    expect(used.length).toBe(h.calls.length);
    expect(used.every((u) => u[0] === "T1")).toBe(true);
  });
});

describe("roleSpawnHold (what the daemon checks before a role spawn)", () => {
  const ok = { killSwitch: false, running: true, admission: 1, used: 0, budget: 4 };
  it("holds on the kill switch, a wave not running, a closed admission or a spent budget", () => {
    expect(roleSpawnHold(ok)).toBeNull();
    expect(roleSpawnHold({ ...ok, killSwitch: true })).toMatch(/kill switch/);
    expect(roleSpawnHold({ ...ok, running: false })).toMatch(/not running/);
    expect(roleSpawnHold({ ...ok, admission: 0, reasons: ["memory pressure"] })).toMatch(
      /admission closed: memory pressure/,
    );
    expect(roleSpawnHold({ ...ok, used: 4 })).toMatch(/spawn budget exhausted \(4\/4\)/);
  });
});

describe("pipeline: remediations (respawn an unverifiable agent, fixup a red head)", () => {
  const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf-8");
  const redOn = (head: string) => {
    h.world.ci[head] = "red";
    h.world.runLog = fixture("gh-run-log-failed.txt");
    // The PR touches the failing tests: the red head is its own change (A3's classification).
    h.world.prFiles[7] = JSON.stringify({
      files: [{ path: "test/pipeline.test.ts" }, { path: "test/clock.test.ts" }],
    });
  };
  const ciFailed = () => h.openDecisions().find((d) => d.kind === "ci_failed");

  it("the CI directive lists only the failed runs (a skipped run is left out)", async () => {
    h = pipelineHarness();
    await h.start();
    h.openPr(H1);
    h.world.runLog = fixture("gh-run-log-failed.txt");
    h.world.ciRuns[H1] = [
      { status: "completed", conclusion: "failure", workflow: "CI / test" },
      { status: "completed", conclusion: "skipped", workflow: "CI / docs" },
    ];
    await h.finish("implementer", { head: H1 });
    await h.resolve(ciFailed()?.decision_id as string, "fixup");
    const md = h.spawns.find((s) => s.role === "fixup")?.files["findings.md"] ?? "";
    expect(md).toContain("- CI / test: failure");
    expect(md).not.toContain("CI / docs");
  });

  it("CI red on the implementer's first head: fixup with the CI directive, then the reviews", async () => {
    h = pipelineHarness();
    await h.start();
    h.openPr(H1);
    await h.finish("implementer", { head: H1, ci: "red" });
    redOn(H1);
    // The verification ran before the log was set: re-verify reads it now.
    const first = ciFailed();
    await h.resolve(first?.decision_id as string, "re-verify");
    const d = ciFailed();
    expect(d?.options?.[0]).toBe("fixup");
    const x = d as unknown as Record<string, unknown>;
    expect(x.failing_tests).toEqual([
      "test/pipeline.test.ts > pipeline: the default sequence > implement then merge_ready",
      "test/clock.test.ts > sleep > resolves on abort",
    ]);
    expect(String(x.log)).toContain("AssertionError");

    await h.resolve(d?.decision_id as string, "fixup");
    const entered = h.events.filter((e) => e.type === "stage_entered").at(-1);
    expect(entered?.data).toMatchObject({
      stage: "fixup",
      roles: ["fixup"],
      directive: { ci: "red", to: H1, only: true, failed_jobs: ["CI / test"] },
    });
    const fixup = h.spawns.find((s) => s.role === "fixup");
    expect(fixup?.start).toEqual({ ref: H1, detach: false });
    const md = fixup?.files["findings.md"] ?? "";
    expect(md.startsWith("# Directive: CI failed on your head")).toBe(true);
    expect(md).toContain("- CI / test");
    expect(md).toContain("`test/clock.test.ts > sleep > resolves on abort`");
    expect(md).toContain("AssertionError: expected 1 to be 2");
    expect(JSON.parse(fixup?.files["findings.json"] ?? "null")).toEqual([]);
    expect(stage()).toBe("fixup");
    expect(h.task()?.stage_label).toBe("fixup (CI directive)");

    // Green: no review exists yet, so the reviews run at the fixup's head.
    await h.finish("fixup", {
      head: H2,
      ci: "green",
      result: { resolved: [{ finding: "CI", how: "fixed the off-by-one" }] },
    });
    expect(stage()).toBe("spec_review");
    expect(h.task()?.stage_label).toBe("review (spec + quality)");
    const reviewers = h.spawns.filter((s) => s.role === "spec_reviewer");
    expect(reviewers.map((s) => s.start)).toEqual([{ ref: H2, detach: true }]);
    expect(h.record().pipeline.T1?.directive).toBeUndefined();
  });

  it("CI red on a fixup's head after the reviews: a CI fixup, and its green head goes to the gate", async () => {
    await reviewed();
    redOn(H2);
    await h.finish("fixup", { head: H2, ci: "red", result: result("fixup-resolved") });
    const d = ciFailed();
    expect(d?.options).toEqual(["fixup", "re-verify", "cancel"]);
    await h.resolve(d?.decision_id as string, "fixup");
    const fixups = h.spawns.filter((s) => s.role === "fixup");
    expect(fixups).toHaveLength(2);
    expect(fixups[1]?.start).toEqual({ ref: H2, detach: false });
    expect(fixups[1]?.files["findings.md"]).toMatch(/^# Directive: CI failed on your head/);
    // only: the review findings were the first fixup's job.
    expect(fixups[1]?.files["findings.md"]).not.toContain("Empty batches reach the API");

    await h.finish("fixup", {
      head: H3,
      ci: "green",
      result: { resolved: [{ finding: "CI", how: "fixed the test" }] },
    });
    // The reviews of H1 hold at H3: H3 ← CI fixup ← H2 ← fixup ← H1.
    expect(stage()).toBe("merge_ready");
    expect(h.task()?.pr).toMatchObject({ head_sha: H3, ci: "green" });
    expect(h.spawns.filter((s) => s.role === "spec_reviewer")).toHaveLength(1);
  });

  it("CI red answered re-verify still re-verifies; cancel cancels", async () => {
    h = pipelineHarness();
    await h.start();
    h.openPr(H1);
    await h.finish("implementer", { head: H1, ci: "red" });
    h.world.ci[H1] = "green";
    await h.resolve(ciFailed()?.decision_id as string, "re-verify");
    expect(h.spawns.map((s) => s.role)).toContain("spec_reviewer");
    expect(h.spawns.some((s) => s.role === "fixup")).toBe(false);

    h = pipelineHarness();
    await h.start();
    h.openPr(H1);
    await h.finish("implementer", { head: H1, ci: "red" });
    await h.resolve(ciFailed()?.decision_id as string, "cancel");
    expect(stage()).toBe("cancelled");
    expect(h.spawns.some((s) => s.role === "fixup")).toBe(false);
  });

  it("CI red on a rebase's head: a CI fixup, and its green head goes to the gate with no re-review", async () => {
    await reviewed();
    h.world.mergeBase[H2] = sha(0xdead);
    await h.finish("fixup", { head: H2, ci: "green", result: result("fixup-resolved") });
    const rebase = h.spawns.find((s) => s.role === "rebase");
    expect(rebase?.start).toEqual({ ref: H2, detach: false });
    h.world.diffNames[`${H2}..${H3}`] = ["README.md"];
    redOn(H3);
    await h.finish("rebase", { head: H3, ci: "red" });
    const d = ciFailed();
    expect(d?.options).toEqual(["fixup", "re-verify", "cancel"]);
    await h.resolve(d?.decision_id as string, "fixup");
    const fixups = h.spawns.filter((s) => s.role === "fixup");
    expect(fixups).toHaveLength(2);
    expect(fixups[1]?.start).toEqual({ ref: H3, detach: false });
    expect(fixups[1]?.files["findings.md"]).toMatch(/^# Directive: CI failed on your head/);
    // The rebase head is chained like an accepted one.
    expect(h.record().pipeline.T1?.rebases).toContainEqual(
      expect.objectContaining({ from: H2, to: H3 }),
    );

    await h.finish("fixup", {
      head: H4,
      ci: "green",
      result: { resolved: [{ finding: "CI", how: "fixed the test" }] },
    });
    // H4 ← CI fixup ← H3 ← rebase ← H2 ← fixup ← H1: the reviews of H1 hold.
    expect(stage()).toBe("merge_ready");
    expect(h.task()?.pr).toMatchObject({ head_sha: H4, ci: "green" });
    expect(h.spawns.filter((s) => s.role === "spec_reviewer")).toHaveLength(1);
    expect(h.spawns.filter((s) => s.role === "quality_reviewer")).toHaveLength(1);
    expect(h.spawns.filter((s) => s.role === "rebase")).toHaveLength(1);
  });

  it("a stale fixup answer after CI went green and the role verified does nothing", async () => {
    h = pipelineHarness();
    await h.start();
    h.openPr(H1);
    await h.finish("implementer", { head: H1, ci: "red" });
    const stale = ciFailed();
    expect(stale?.options?.[0]).toBe("fixup");
    // A re-run turns it green; a second ci_failed answered re-verify accepts the role.
    h.world.ci[H1] = "green";
    await h.resolve(stale?.decision_id as string, "re-verify");
    expect(h.run("implementer")?.accepted).toBe(true);
    const before = stage();
    const entered = h.events.filter((e) => e.type === "stage_entered").length;
    // A late `fixup` answer to the red head's decision reaches the pipeline anyway.
    const late = {
      ...(h.record().decisions[stale?.decision_id as string] as DecisionRecord),
      resolved: { answer: "fixup", by: "coord-1", at: new Date().toISOString() },
    } as DecisionRecord;
    await h.driver.handle("T1", { kind: "decision_resolved", decision: late });
    await h.driver.settled();
    expect(h.spawns.some((s) => s.role === "fixup")).toBe(false);
    expect(stage()).toBe(before);
    expect(h.events.filter((e) => e.type === "stage_entered")).toHaveLength(entered);
  });

  it("an unverifiable done answered respawn: relaunched at the next attempt, the implementer again", async () => {
    h = pipelineHarness();
    await h.start();
    const first = h.run("implementer")?.agent_id as string;
    await h.finish("implementer", { head: H1, push: false });
    await h.finish("implementer", { head: H1, push: false });
    const [d] = h.openDecisions();
    expect(d).toMatchObject({ kind: "agent_blocked", options: ["respawn", "re-verify", "cancel"] });
    expect((d as unknown as { pipeline: unknown }).pipeline).toMatchObject({
      on: "verify",
      role: "implementer",
      agent_id: first,
    });
    await h.resolve(d?.decision_id as string, "respawn");
    expect(h.events.find((e) => e.type === "relaunched")?.data).toMatchObject({
      from_agent: first,
      to_agent: "w1-t1-implementer-2",
      role: "implementer",
      attempt: 2,
    });
    const impl = h.spawns.filter((s) => s.role === "implementer");
    expect(impl).toHaveLength(2);
    // No start: the daemon's spawn continues the pushed branch (continueBranch).
    expect(impl[1]?.start).toBeUndefined();
    expect(h.run("implementer")?.agent_id).toBe("w1-t1-implementer-2");
    expect(h.retired).toContainEqual({ agent_id: first, status: "relaunched" });
  });

  it("a free-text cancel to a stall is the daemon's to steer: the pipeline does not cancel the task", async () => {
    h = pipelineHarness();
    await h.start();
    const agent = h.run("implementer")?.agent_id as string;
    const stalled = {
      decision_id: "d-stalled",
      kind: "agent_stalled",
      task: "T1",
      agent_id: agent,
      question: "stalled",
      options: ["nudge again", "respawn", "stop task"],
      pipeline: { on: "liveness", role: "implementer", agent_id: agent, attempt: 1 },
      resolved: { answer: "cancel", by: "coord-1", at: new Date().toISOString() },
    } as unknown as DecisionRecord;
    await h.driver.handle("T1", { kind: "decision_resolved", decision: stalled });
    await h.driver.settled();
    expect(types()).not.toContain("task_cancelled");
    expect(stage()).not.toBe("cancelled");
    expect(h.retired).toEqual([]);
  });

  it("a stall answered respawn after the agent ended (failed) relaunches nothing", async () => {
    h = pipelineHarness();
    await h.start();
    const agent = h.run("implementer")?.agent_id as string;
    await h.finish("implementer", { status: "failed" });
    const stalled = {
      decision_id: "d-stalled-late",
      kind: "agent_stalled",
      task: "T1",
      agent_id: agent,
      question: "stalled",
      options: ["nudge again", "respawn", "stop task"],
      pipeline: { on: "liveness", role: "implementer", agent_id: agent, attempt: 1 },
      resolved: { answer: "respawn", by: "coord-1", at: new Date().toISOString() },
    } as unknown as DecisionRecord;
    await h.driver.handle("T1", { kind: "decision_resolved", decision: stalled });
    await h.driver.settled();
    expect(h.events.some((e) => e.type === "relaunched")).toBe(false);
    expect(h.spawns.filter((s) => s.role === "implementer")).toHaveLength(1);
  });

  it("an unverifiable done answered re-verify re-verifies (no respawn)", async () => {
    h = pipelineHarness();
    await h.start();
    await h.finish("implementer", { head: H1, push: false });
    await h.finish("implementer", { head: H1 }); // pushed, still no PR
    h.openPr(H1);
    h.world.ci[H1] = "green";
    await h.resolve(h.openDecisions()[0]?.decision_id as string, "re-verify");
    expect(h.events.some((e) => e.type === "relaunched")).toBe(false);
    expect(stage()).toBe("spec_review");
  });
});
