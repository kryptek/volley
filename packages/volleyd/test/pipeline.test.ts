import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import { FIXTURES } from "./helpers/fake-host";
import { type Harness, pipelineHarness, sha } from "./helpers/pipeline-harness";

const result = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, "review-results", `${name}.json`), "utf-8"));

const H1 = sha(0x1001);
const H2 = sha(0x1002);
const H3 = sha(0x1003);

let h: Harness;
afterEach(() => h?.cleanup());

const types = () => h.events.map((e) => e.type);
const stage = () => h.task()?.stage;

/** Implementer done with its PR open and CI green on H1. */
async function implemented(o: { pipeline?: string } = {}) {
  h = pipelineHarness(o);
  await h.start();
  h.openPr(H1);
  await h.finish("implementer", { head: H1, ci: "green" });
}

/** Through both reviews (spec P1 + P2; quality P1 + P3 elsewhere) to a spawned fixup. */
async function reviewed() {
  await implemented();
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
    expect(d).toMatchObject({ kind: "agent_blocked", options: ["re-verify", "cancel"] });
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
    await h.driver.tick();
    expect(runLists()).toBe(before);
    h.world.ci[H1] = "red";
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.driver.tick();
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
    await h.driver.tick();
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

describe("pipeline: after the gate", () => {
  it("merge_ready → done once a human merged the PR (polled read-only), releasing dependents", async () => {
    await implemented({ pipeline: "[implement, merge_ready]" });
    expect(stage()).toBe("merge_ready");
    // Still open: polling (rate-limited) changes nothing.
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.driver.tick();
    expect(stage()).toBe("merge_ready");
    const views = h.calls.filter((c) => c[1] === "pr" && c[2] === "view");
    expect(views.at(-1)).toEqual([
      "gh",
      "pr",
      "view",
      "7",
      "--json",
      "state,mergedAt,mergeCommit,baseRefName",
    ]);

    h.world.prState[7] = "MERGED";
    await h.driver.tick(); // within the poll interval: not re-checked yet
    expect(stage()).toBe("merge_ready");
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.driver.tick();
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

  it("a PR closed without merging stays at the gate with one alarm", async () => {
    await implemented({ pipeline: "[implement, merge_ready]" });
    h.world.prState[7] = "CLOSED";
    for (let i = 0; i < 2; i++) {
      h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
      await h.driver.tick();
    }
    expect(stage()).toBe("merge_ready");
    expect(h.events.filter((e) => e.data.alarm === "pr_closed_unmerged")).toHaveLength(1);
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
