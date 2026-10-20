import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import {
  type Harness,
  type HarnessOptions,
  pipelineHarness,
  sha,
} from "./helpers/pipeline-harness";

/**
 * Autopilot merging (A5, SPEC §4.6.16): under `merge: auto` the gate mints a MergeToken and the
 * pipeline merges exactly the gated head (`gh pr merge <n> --squash --match-head-commit <head>`),
 * journaled as merged_by_supervisor. Under `merge: manual` nothing changes: a human merges.
 */

const H = sha(0x1001);
const MERGE_SHA = sha(0x3e46e);
const AUTO_LINE =
  "volleyd merges this PR itself (merge: auto) at exactly this head; the merge is journaled as merged_by_supervisor.";

let h: Harness;
afterEach(() => h?.cleanup());

const mergeCalls = () => h.calls.filter((a) => a[0] === "gh" && a[1] === "pr" && a[2] === "merge");
const types = () => h.events.map((e) => e.type);
const refusals = () =>
  h.events.filter((e) => e.type === "alarm_raised" && e.data.alarm === "merge_refused");

/** T1 (the wave's only task) through the implementer to the gate on H, PR #7. */
async function gated(o: HarnessOptions = {}) {
  h = pipelineHarness({ pipeline: "[implement, merge_ready]", ...o });
  await h.start();
  h.openPr(H);
  h.world.mergeCommit[7] = MERGE_SHA;
  await h.finish("implementer", { head: H, ci: "green" });
}

async function due() {
  h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
  await h.tick();
}

describe("merge: auto", () => {
  it("merges exactly the gated head once, journals merged_by_supervisor, then done", async () => {
    await gated({ merge: "auto" });
    expect(mergeCalls()).toEqual([
      ["gh", "pr", "merge", "7", "--squash", "--match-head-commit", H],
    ]);
    const ev = h.events.find((e) => e.type === "merged_by_supervisor");
    expect(ev?.data).toMatchObject({
      task: "T1",
      pr: 7,
      head: H,
      merge_sha: MERGE_SHA,
      by: "volleyd",
    });
    const t = types();
    const verified = h.events.findIndex(
      (e) => e.type === "artifact_verified" && e.data.role === "merged",
    );
    expect(t.indexOf("merged_by_supervisor")).toBeLessThan(verified);
    expect(h.events[verified]?.data).toMatchObject({
      role: "merged",
      via: "supervisor",
      merge_sha: MERGE_SHA,
      head_sha: H,
    });
    expect(h.task()?.stage).toBe("done");
    expect(refusals()).toEqual([]);
    // The evidence says who merges.
    const md = readFileSync(h.task()?.evidence_path as string, "utf-8");
    expect(md).toContain(AUTO_LINE);
    expect(md).not.toContain("volleyd never merges");
    // Nothing more on later ticks.
    await due();
    expect(mergeCalls()).toHaveLength(1);
  });

  it("a refused merge is alarmed and re-checked; a second refusal opens merge_refused", async () => {
    h = pipelineHarness({ pipeline: "[implement, merge_ready]", merge: "auto" });
    h.world.mergeRefuse = "GraphQL: Head branch was modified. Review and try the merge again.";
    await h.start();
    h.openPr(H);
    await h.finish("implementer", { head: H, ci: "green" });
    expect(mergeCalls()).toHaveLength(1);
    expect(refusals()).toHaveLength(1);
    expect(refusals()[0]?.data).toMatchObject({
      alarm: "merge_refused",
      stderr: "GraphQL: Head branch was modified. Review and try the merge again.",
      head: H,
    });
    expect(h.task()?.stage).toBe("merge_ready");
    expect(h.openDecisions()).toEqual([]);
    // Handed to check_merged as today: the PR is read right after the refusal.
    const views = h.calls.filter(
      (a) =>
        a[1] === "pr" &&
        a[2] === "view" &&
        a.includes("state,mergedAt,mergeCommit,baseRefName,headRefOid"),
    );
    expect(views.length).toBeGreaterThan(0);

    // Not again before the re-check interval.
    await h.tick();
    expect(mergeCalls()).toHaveLength(1);

    await due();
    expect(mergeCalls()).toHaveLength(2);
    expect(refusals()).toHaveLength(2);
    const [d] = h.openDecisions();
    expect(d?.kind).toBe("merge_refused");
    expect(d?.options).toEqual(["retry", "manual", "cancel"]);
    expect(h.task()?.stage).toBe("awaiting_decision");

    // retry: one more attempt at once; it merges this time.
    h.world.mergeRefuse = undefined;
    await h.resolve(d?.decision_id as string, "retry");
    expect(mergeCalls()).toHaveLength(3);
    expect(h.task()?.stage).toBe("done");
    expect(h.events.some((e) => e.type === "merged_by_supervisor")).toBe(true);
  });

  it("retry that is refused again asks again", async () => {
    h = pipelineHarness({ pipeline: "[implement, merge_ready]", merge: "auto", mergeRetryMax: 1 });
    h.world.mergeRefuse = "Pull request is not mergeable: required checks";
    await h.start();
    h.openPr(H);
    await h.finish("implementer", { head: H, ci: "green" });
    const [d] = h.openDecisions();
    expect(d?.kind).toBe("merge_refused");
    await h.resolve(d?.decision_id as string, "retry");
    expect(mergeCalls()).toHaveLength(2);
    expect(h.openDecisions().map((x) => x.kind)).toEqual(["merge_refused"]);
  });

  it("manual: the task waits at merge_ready for a human, as today", async () => {
    h = pipelineHarness({ pipeline: "[implement, merge_ready]", merge: "auto" });
    h.world.mergeRefuse = "branch protection";
    await h.start();
    h.openPr(H);
    await h.finish("implementer", { head: H, ci: "green" });
    await due();
    const [d] = h.openDecisions();
    await h.resolve(d?.decision_id as string, "manual");
    expect(h.record().pipeline.T1?.merge_manual).toBe(true);
    expect(h.task()?.stage).toBe("merge_ready");
    h.world.mergeRefuse = undefined;
    await due();
    await due();
    expect(mergeCalls()).toHaveLength(2);
    // A human merges: done the usual way.
    h.world.prState[7] = "MERGED";
    await due();
    expect(h.task()?.stage).toBe("done");
    expect(h.events.some((e) => e.type === "merged_by_supervisor")).toBe(false);
  });

  it("cancel cancels the task", async () => {
    h = pipelineHarness({ pipeline: "[implement, merge_ready]", merge: "auto", mergeRetryMax: 1 });
    h.world.mergeRefuse = "x";
    await h.start();
    h.openPr(H);
    await h.finish("implementer", { head: H, ci: "green" });
    const [d] = h.openDecisions();
    await h.resolve(d?.decision_id as string, "cancel");
    expect(h.task()?.stage).toBe("cancelled");
  });

  it("after a restart the gate re-mints the token through the rebase check, then merges", async () => {
    h = pipelineHarness({ pipeline: "[implement, merge_ready]", merge: "auto" });
    h.world.mergeRefuse = "required checks pending";
    await h.start();
    h.openPr(H);
    await h.finish("implementer", { head: H, ci: "green" });
    expect(mergeCalls()).toHaveLength(1);
    h.restart();
    h.world.mergeRefuse = undefined;
    await due(); // re-gates: the rebase check, then the token
    await due();
    expect(mergeCalls()).toHaveLength(2);
    expect(mergeCalls()[1]).toEqual([
      "gh",
      "pr",
      "merge",
      "7",
      "--squash",
      "--match-head-commit",
      H,
    ]);
    expect(h.task()?.stage).toBe("done");
  });

  it("a wave with more than one task is not merged here (A6's queue decides)", async () => {
    await gated({ merge: "auto", dependents: { T2: ["T1"] } });
    expect(mergeCalls()).toEqual([]);
    expect(h.task()?.stage).toBe("merge_ready");
  });
});

describe("merge: manual", () => {
  it("is the harness default: no merge call, the task waits at merge_ready, the old evidence line", async () => {
    await gated();
    await due();
    expect(mergeCalls()).toEqual([]);
    expect(h.task()?.stage).toBe("merge_ready");
    const md = readFileSync(h.task()?.evidence_path as string, "utf-8");
    expect(md).toContain("volleyd never merges. A human merges this PR after reading the above.");
  });

  it("explicit manual is the same", async () => {
    await gated({ merge: "manual" });
    await due();
    expect(mergeCalls()).toEqual([]);
    expect(h.task()?.stage).toBe("merge_ready");
  });
});
