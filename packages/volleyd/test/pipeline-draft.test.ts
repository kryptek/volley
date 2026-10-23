import { afterEach, describe, expect, it } from "vitest";
import { POLICY_TABLE } from "../src/autopilot/policy";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import { type Harness, pipelineHarness, sha } from "./helpers/pipeline-harness";

/**
 * A draft PR is not merge-ready (#408): its repository may skip heavy CI jobs on drafts, so a
 * draft's green says nothing about them, and `gh pr merge` refuses a draft. volleyd marks it
 * ready (`gh pr ready`), journals `pr_marked_ready`, and gates on the CI that starts then.
 */

const H = sha(0x408);

let h: Harness;
afterEach(() => h?.cleanup());

const readyCalls = () => h.calls.filter((a) => a[0] === "gh" && a[1] === "pr" && a[2] === "ready");
const mergeCalls = () => h.calls.filter((a) => a[0] === "gh" && a[1] === "pr" && a[2] === "merge");
const of = (type: string) => h.events.filter((e) => e.type === type);
const marked = () => of("pr_marked_ready")[0]?.data as { pr: number; head: string; at: string };
/** An ISO time `ms` after the mark. */
const afterMark = (ms: number) => new Date(Date.parse(marked().at) + ms).toISOString();

async function due() {
  h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
  await h.tick();
}

/** The draft's CI: one green run of `CI`, created before anything was marked ready. */
const draftRun = () => ({
  id: 901,
  workflow: "CI",
  status: "completed",
  conclusion: "success",
  createdAt: h.iso(-60_000),
});

describe("a draft PR at the CI gate (#408)", () => {
  it("is marked ready once and gated on the run created after the mark, not the draft's", async () => {
    h = pipelineHarness({ pipeline: "[implement, merge_ready]", merge: "auto" });
    await h.start();
    h.openPr(H, "T1", 7, { draft: true });
    h.world.ciRuns[H] = [draftRun()];
    await h.finish("implementer", { head: H });

    expect(readyCalls()).toEqual([["gh", "pr", "ready", "7"]]);
    expect(marked()).toMatchObject({ pr: 7, head: H });
    expect(of("artifact_verified")).toEqual([]);
    expect(of("ci_pending").length).toBeGreaterThan(0);

    // Marked ready, but only the draft's run exists: the full CI has not started.
    await due();
    expect(of("artifact_verified")).toEqual([]);
    expect(h.task()?.stage).not.toBe("merge_ready");

    // The run the mark started supersedes the draft's: running, then green.
    h.world.ciRuns[H] = [
      {
        id: 902,
        workflow: "CI",
        status: "in_progress",
        conclusion: "",
        createdAt: afterMark(2_000),
      },
      draftRun(),
    ];
    await due();
    expect(of("artifact_verified")).toEqual([]);
    h.world.ciRuns[H] = [
      {
        id: 902,
        workflow: "CI",
        status: "completed",
        conclusion: "success",
        createdAt: afterMark(2_000),
      },
      draftRun(),
    ];
    await due();
    const verified = of("artifact_verified").find((e) => e.data.role === "implementer");
    expect((verified?.data.ci_runs as { id: number }[]).map((r) => r.id)).toEqual([902]);
    await due();
    expect(mergeCalls()).toEqual([
      ["gh", "pr", "merge", "7", "--squash", "--match-head-commit", H],
    ]);
    expect(readyCalls()).toHaveLength(1);
    expect(of("pr_marked_ready")).toHaveLength(1);
  });

  it("a red draft is fixed first, never marked ready", async () => {
    h = pipelineHarness({ pipeline: "[implement, merge_ready]", merge: "auto" });
    await h.start();
    h.openPr(H, "T1", 7, { draft: true });
    await h.finish("implementer", { head: H, ci: "red" });
    expect(readyCalls()).toEqual([]);
    expect(of("pr_marked_ready")).toEqual([]);
  });

  it("a PR that is not a draft is gated as before (no mark)", async () => {
    h = pipelineHarness({ pipeline: "[implement, merge_ready]", merge: "auto" });
    await h.start();
    h.openPr(H);
    await h.finish("implementer", { head: H, ci: "green" });
    await h.tick();
    expect(readyCalls()).toEqual([]);
    expect(of("pr_marked_ready")).toEqual([]);
    expect(mergeCalls()).toHaveLength(1);
  });

  it("a repository whose workflows never run on ready: after the grace, the latest runs gate", async () => {
    h = pipelineHarness({ pipeline: "[implement, merge_ready]", merge: "auto" });
    await h.start();
    h.openPr(H, "T1", 7, { draft: true });
    h.world.ciRuns[H] = [draftRun()];
    await h.finish("implementer", { head: H });
    await due();
    expect(of("artifact_verified")).toEqual([]);
    h.elapse(DAEMON_DEFAULTS.ci_none_grace_ms);
    await h.tick();
    expect(of("artifact_verified").some((e) => e.data.role === "implementer")).toBe(true);
  });
});

describe("autopilot merge of a draft PR (#408)", () => {
  /** Gated on H (not a draft), then made a draft before its merge turn. */
  async function draftAtMerge(before?: () => void) {
    h = pipelineHarness({ pipeline: "[implement, merge_ready]", merge: "auto" });
    await h.start();
    h.openPr(H);
    h.world.ciRuns[H] = [draftRun()];
    await h.finish("implementer", { head: H });
    expect(h.task()?.stage).toBe("merge_ready");
    const pr = h.world.prs[0];
    if (pr !== undefined) pr.isDraft = true;
    before?.();
    await h.tick();
  }

  it("is refused as draft, marked ready, held for the CI that starts, then merged: never escalated", async () => {
    await draftAtMerge();
    expect(mergeCalls()).toEqual([]);
    const refused = of("alarm_raised").filter((e) => e.data.alarm === "merge_refused");
    expect(refused.map((e) => e.data.reason)).toEqual(["draft"]);
    expect(readyCalls()).toEqual([["gh", "pr", "ready", "7"]]);
    expect(marked()).toMatchObject({ pr: 7, head: H });

    // Held: no merge before a run created after the mark passes.
    for (let i = 0; i < 4; i++) await due();
    expect(mergeCalls()).toEqual([]);
    expect(h.record().pipeline.T1?.ci_hold).toMatchObject({ role: "gate", sha: H });
    expect(h.task()?.stage).toBe("merge_ready");

    h.world.ciRuns[H] = [
      {
        id: 903,
        workflow: "CI",
        status: "completed",
        conclusion: "success",
        createdAt: afterMark(1_000),
      },
      draftRun(),
    ];
    await due();
    expect(of("ci_green").some((e) => e.data.role === "gate" && e.data.sha === H)).toBe(true);
    await due();
    await due();
    expect(mergeCalls()).toEqual([
      ["gh", "pr", "merge", "7", "--squash", "--match-head-commit", H],
    ]);
    expect(of("merged_by_supervisor")).toHaveLength(1);
    expect(h.openDecisions()).toEqual([]);
    expect(of("decision_opened")).toEqual([]);
  });

  it("GitHub's own refusal of a draft (`Pull Request is still a draft`) is handled the same way", async () => {
    h = pipelineHarness({ pipeline: "[implement, merge_ready]", merge: "auto" });
    await h.start();
    h.openPr(H);
    h.world.ciRuns[H] = [draftRun()];
    await h.finish("implementer", { head: H });
    // The pre-merge read still saw a ready PR; the merge itself is refused.
    h.world.mergeRefuse = "GraphQL: Pull Request is still a draft (mergePullRequest)";
    await h.tick();
    h.world.mergeRefuse = undefined;
    expect(
      of("alarm_raised")
        .filter((e) => e.data.alarm === "merge_refused")
        .map((e) => e.data.reason),
    ).toEqual(["draft"]);
    expect(readyCalls()).toEqual([["gh", "pr", "ready", "7"]]);
    for (let i = 0; i < 4; i++) await due();
    expect(of("decision_opened")).toEqual([]);
    expect(mergeCalls()).toHaveLength(1);
  });

  it("the full CI red once marked ready: the owner is asked (fixup, re-verify, cancel)", async () => {
    await draftAtMerge();
    h.world.ciRuns[H] = [
      {
        id: 903,
        workflow: "CI",
        status: "completed",
        conclusion: "failure",
        createdAt: afterMark(1_000),
      },
      draftRun(),
    ];
    await due();
    const [d] = h.openDecisions();
    expect(d).toMatchObject({ kind: "ci_failed", options: ["fixup", "re-verify", "cancel"] });
    expect((d as unknown as { pipeline: { on: string } }).pipeline.on).toBe("ready_ci");
    expect(h.task()?.stage).toBe("awaiting_decision");
    expect(mergeCalls()).toEqual([]);
  });

  it("no run yet after the mark, inside its grace: held, not merged (the CI it starts is awaited)", async () => {
    // A head with no run at all once it is a draft again (workflows on ready_for_review only).
    await draftAtMerge(() => {
      h.world.ciRuns[H] = [];
    });
    expect(readyCalls()).toEqual([["gh", "pr", "ready", "7"]]);
    // GitHub has not created the runs the mark starts yet: the gate holds, never green on `none`.
    for (let i = 0; i < 3; i++) await due();
    expect(mergeCalls()).toEqual([]);
    expect(of("ci_green").some((e) => e.data.role === "gate")).toBe(false);
    expect(h.record().pipeline.T1?.ci_hold).toMatchObject({ role: "gate", sha: H });
    expect(h.task()?.why_waiting).toBe(`CI pending on ${H.slice(0, 7)} (no run yet)`);
    // The run the mark started passes: merged.
    h.world.ciRuns[H] = [
      {
        id: 904,
        workflow: "CI",
        status: "completed",
        conclusion: "success",
        createdAt: afterMark(1_000),
      },
    ];
    for (let i = 0; i < 3; i++) await due();
    expect(mergeCalls()).toHaveLength(1);
  });

  it("`gh pr ready` keeps failing: the refusals count, then the owner is asked (no auto retry)", async () => {
    // The first refusal is free; its mark fails, and so does every one after it.
    await draftAtMerge(() => {
      h.world.readyError =
        "GraphQL: Resource not accessible by integration (markPullRequestReadyForReview)";
    });
    for (let i = 0; i < 8; i++) await due();
    expect(mergeCalls()).toEqual([]);
    expect(of("pr_marked_ready").length).toBeLessThanOrEqual(1);
    const [d] = h.openDecisions();
    expect(d).toMatchObject({ kind: "merge_refused" });
    expect(d?.question).toContain("marking the draft ready did not succeed");
    const opened = of("decision_opened").find((e) => e.data.kind === "merge_refused");
    expect(opened?.data).toMatchObject({ reason: "draft", ready_failed: true });
    // The merge_refused/draft row (retry) does not answer it: marking it ready already failed.
    const row = POLICY_TABLE.find((r) => r.policy === "merge_refused/draft");
    expect(row?.when?.(opened?.data as never, {} as never)).toBe(false);
    // Bounded: no further refusals while the owner decides.
    const refusals = of("alarm_raised").filter((e) => e.data.alarm === "merge_refused").length;
    for (let i = 0; i < 4; i++) await due();
    expect(of("alarm_raised").filter((e) => e.data.alarm === "merge_refused")).toHaveLength(
      refusals,
    );
  });

  it("the autopilot policy table has the merge_refused/draft row", () => {
    expect(POLICY_TABLE.some((r) => r.policy === "merge_refused/draft")).toBe(true);
  });
});
