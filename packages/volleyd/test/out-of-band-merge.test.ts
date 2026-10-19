import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { landed } from "../src/artifacts";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import { ready } from "../src/scheduler";
import { FIXTURES } from "./helpers/fake-host";
import { type Harness, pipelineHarness, sha } from "./helpers/pipeline-harness";

/**
 * A merge done outside GitHub's merge button (a local squash + push, the PR closed with
 * `mergedAt: null`) is recognised: the release branch contains the gated head (ancestor), its
 * patches (cherry-pick equivalence) or a commit whose subject names the PR. Nothing matching is
 * a `pr_closed` decision (landed | abandoned), never a bare alarm.
 */

const H1 = sha(0x1001);
const SQUASH = sha(0x5a5a);
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf-8");

let h: Harness;
afterEach(() => h?.cleanup());

/** T1 at merge_ready on H1 (PR #7), then the PR is closed unmerged. T2 waits for T1. */
async function closedAtGate() {
  h = pipelineHarness({ pipeline: "[implement, merge_ready]", dependents: { T2: ["T1"] } });
  await h.start();
  h.openPr(H1);
  await h.finish("implementer", { head: H1, ci: "green" });
  expect(h.task()?.stage).toBe("merge_ready");
  h.world.prState[7] = "CLOSED";
  h.world.prView[7] = JSON.parse(fixture("gh-pr-closed-unmerged.json"));
  h.world.cherry[H1] = fixture("git-cherry-unlanded.txt");
}

/** The level-triggered merge check is due again: tick. */
async function checkMerged() {
  h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
  await h.tick();
}

const merged = () =>
  h.events.find((e) => e.type === "artifact_verified" && e.data.role === "merged");

describe("out-of-band merges", () => {
  it("CLOSED + the gated head on the release branch → verified outside_github, done, alarm cleared", async () => {
    await closedAtGate();
    // An older journal's bare alarm for the same PR.
    await h.journal({
      type: "alarm_raised",
      task: "T1",
      data: { alarm: "pr_closed_unmerged", pr: "https://github.com/example/repo/pull/7" },
    });
    h.world.ancestor[`${H1}..${h.world.releaseTip}`] = true;
    await checkMerged();
    expect(merged()?.data).toMatchObject({
      role: "merged",
      via: "outside_github",
      how: "ancestor",
      sha: H1,
      head_sha: H1,
    });
    expect(h.task()?.stage).toBe("done");
    // Its dependent is admitted (the scheduler's ready set).
    expect(ready(h.record())).toEqual(["T2"]);
    expect(h.events.find((e) => e.type === "alarm_cleared")?.data).toMatchObject({
      alarm: "pr_closed_unmerged",
    });
    expect(h.openDecisions()).toEqual([]);
    // The probes are read-only (the harness runs every argv through the fence).
    expect(h.calls).toContainEqual([
      "git",
      "-C",
      "/wt/w1/T1-implementer-1",
      "merge-base",
      "--is-ancestor",
      H1,
      "origin/release/w1",
    ]);
  });

  /** The PR's whole diff since it forked (the release tip, in the harness). */
  const PR_DIFF =
    "diff --git a/up.ts b/up.ts\n--- a/up.ts\n+++ b/up.ts\n@@ -1 +1 @@\n-a\n+batched\n";

  it("not an ancestor, patches not upstream, but a release commit names (#7) and is its squash → landed via subject", async () => {
    await closedAtGate();
    h.world.releaseLog = `${sha(0x77)} unrelated change (#5)\n${SQUASH} Batch the uploads (#7)\n`;
    h.world.patches[SQUASH] = PR_DIFF;
    h.world.patches[`${h.world.releaseTip}..${H1}`] = PR_DIFF;
    await checkMerged();
    expect(merged()?.data).toMatchObject({ via: "outside_github", how: "subject", sha: SQUASH });
    expect(h.task()?.stage).toBe("done");
    expect(h.events.some((e) => e.data.alarm === "pr_closed_unmerged")).toBe(false);
  });

  it("a commit naming (#7) whose diff is not the PR's → not landed: the pr_closed decision", async () => {
    await closedAtGate();
    h.world.releaseLog = `${SQUASH} Batch the uploads (#7)\n`;
    h.world.patches[SQUASH] = "diff --git a/other.ts b/other.ts\n+something else\n";
    h.world.patches[`${h.world.releaseTip}..${H1}`] = PR_DIFF;
    await checkMerged();
    expect(merged()).toBeUndefined();
    expect(h.openDecisions()[0]).toMatchObject({ kind: "pr_closed" });
  });

  it("a revert or a subject that only mentions (#7) is never checked, never landed", async () => {
    await closedAtGate();
    h.world.releaseLog = `${sha(0x71)} Revert "Batch the uploads (#7)"\n${sha(0x72)} Other work, replaces (#7) (#9)\n${sha(0x73)} fix flake from (#7) in CI\n`;
    for (const c of [0x71, 0x72, 0x73]) h.world.patches[sha(c)] = PR_DIFF;
    h.world.patches[`${h.world.releaseTip}..${H1}`] = PR_DIFF;
    await checkMerged();
    expect(merged()).toBeUndefined();
    expect(h.openDecisions()[0]).toMatchObject({ kind: "pr_closed" });
    expect(h.calls.some((a) => a.includes("show"))).toBe(false);
  });

  it("every commit of the head has an equivalent patch upstream → landed via patch", async () => {
    await closedAtGate();
    h.world.cherry[H1] = fixture("git-cherry-landed.txt");
    await checkMerged();
    expect(merged()?.data).toMatchObject({ via: "outside_github", how: "patch" });
    expect(h.task()?.stage).toBe("done");
  });

  it("nothing matches → a pr_closed decision (landed | abandoned), no bare alarm", async () => {
    await closedAtGate();
    await checkMerged();
    const [d] = h.openDecisions();
    expect(d).toMatchObject({ kind: "pr_closed", task: "T1", options: ["landed", "abandoned"] });
    expect(d?.question).toContain("#7");
    expect(h.events.some((e) => e.data.alarm === "pr_closed_unmerged")).toBe(false);
    expect(h.task()?.stage).toBe("awaiting_decision");
    expect(h.record().state?.gates).toEqual([]);
    expect(ready(h.record())).toEqual([]);
    // Asked once: the next check does not ask again.
    await checkMerged();
    expect(h.events.filter((e) => e.type === "decision_opened")).toHaveLength(1);

    // An answer alone never makes a closed, unmerged PR landed: it is asked again, pointing at
    // `volleyd merged --sha` (which verifies where it landed).
    await h.resolve(d?.decision_id as string, "landed");
    expect(merged()).toBeUndefined();
    expect(h.task()?.stage).not.toBe("done");
    const [again] = h.openDecisions();
    expect(again).toMatchObject({ kind: "pr_closed", options: ["landed", "abandoned"] });
    expect(again?.question).toContain("volleyd merged <wave> T1 --sha <sha>");
    expect(again?.question).toContain("#7");
    // Asked again, the prefix is not repeated.
    await h.resolve(again?.decision_id as string, "landed");
    const [third] = h.openDecisions();
    expect(third?.question.match(/needs the commit/g)).toHaveLength(1);
  });

  it("`volleyd merged` verified it: the task is done and its landed answer asks nothing more", async () => {
    await closedAtGate();
    await checkMerged();
    const [d] = h.openDecisions();
    // mergedOp: the merge is handed over on the queue before the decision's answer is acted on.
    await h.driver.handle("T1", {
      kind: "operator_merged",
      sha: SQUASH,
      by: "coord-1",
      how: "squash",
      head: H1,
    });
    await h.resolve(d?.decision_id as string, "landed");
    expect(merged()?.data).toMatchObject({ via: "operator", sha: SQUASH });
    expect(h.task()?.stage).toBe("done");
    expect(h.openDecisions()).toEqual([]);
  });

  it("a merge verified against a head the task has since left records nothing", async () => {
    await closedAtGate();
    await h.driver.handle("T1", {
      kind: "operator_merged",
      sha: SQUASH,
      by: "coord-1",
      how: "squash",
      head: sha(0x0bad),
    });
    expect(merged()).toBeUndefined();
    expect(h.events.some((e) => e.type === "merged_by_operator")).toBe(false);
  });

  it("pr_closed → abandoned cancels the task", async () => {
    await closedAtGate();
    await checkMerged();
    const [d] = h.openDecisions();
    await h.resolve(d?.decision_id as string, "abandoned");
    expect(h.task()?.stage).toBe("cancelled");
    expect(merged()).toBeUndefined();
  });
});

describe("landed (pure)", () => {
  const base = { ancestor: false, unmatched: [H1], subjects: [] };
  const one = (subject: string, patch = true) => ({
    ...base,
    subjects: [{ sha: SQUASH, subject, patch }],
  });
  it("ancestor first, then patch equivalence, then a squash subject naming the PR with its diff", () => {
    expect(landed({ ...base, ancestor: true }, H1, "tip", 7)).toEqual({
      how: "ancestor",
      sha: H1,
    });
    expect(landed({ ...base, unmatched: [] }, H1, "tip", 7)).toEqual({ how: "patch", sha: "tip" });
    expect(landed(one("Batch uploads (#7)"), H1, "tip", 7)).toEqual({
      how: "subject",
      sha: SQUASH,
    });
  });
  it("a subject alone is not enough: its commit must carry the PR's diff", () => {
    expect(landed(one("Batch uploads (#7)", false), H1, "tip", 7)).toBeNull();
    expect(
      landed({ ...base, subjects: [{ sha: SQUASH, subject: "Batch uploads (#7)" }] }, H1, "tip", 7),
    ).toBeNull();
  });
  it("(#70) is not (#7); a mention, a superseding PR or a revert is not a squash; nothing is null", () => {
    expect(landed(one("Other (#70)"), H1, "tip", 7)).toBeNull();
    expect(landed(one("Other work, replaces (#7) (#9)"), H1, "tip", 7)).toBeNull();
    expect(landed(one("fix flake from (#7) in CI"), H1, "tip", 7)).toBeNull();
    expect(landed(one('Revert "Batch uploads (#7)"'), H1, "tip", 7)).toBeNull();
    expect(landed(one("Revert batch uploads (#7)"), H1, "tip", 7)).toBeNull();
    expect(landed(base, H1, "tip", 7)).toBeNull();
  });
});
