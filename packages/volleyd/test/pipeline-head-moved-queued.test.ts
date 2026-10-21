import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import { branchName } from "../src/worktree";
import { FIXTURES } from "./helpers/fake-host";
import { type Harness, pipelineHarness, sha } from "./helpers/pipeline-harness";

/**
 * A PR queued behind another at merge_ready takes a merge of the release branch ("Update branch").
 * On one tick both head detectors can see it: the merge check (the gate's head check, a
 * `pr_head_moved` decision) and the turn's gate check (`head_moved`). One detector, one decision:
 * the gate's; the gate check's report of the same move re-verifies nothing, so an `accept` keeps
 * the reviews and the PR merges without a re-review (#271).
 */

const H = { T1: sha(0x1001), T2: sha(0x2001) } as const;
const B = sha(0x2002); // T2's head after the release branch is merged into it
const MB = sha(0x2003); // where T2 branched from the release branch
const PR = { T1: 7, T2: 8 } as const;
const MERGED = { 7: sha(0xa101), 8: sha(0xa102) } as const;
const approve = (): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, "review-results", "approve-empty.json"), "utf-8"));

let h: Harness;
afterEach(() => h?.cleanup());

const ofType = (type: string, task = "T2") =>
  h.events.filter((e) => e.type === type && e.task === task);
const mergedPrs = () =>
  h.calls
    .filter((a) => a[0] === "gh" && a[1] === "pr" && a[2] === "merge")
    .map((a) => Number(a[3]));

describe("a queued PR's head move seen by both head checks in one tick", () => {
  it("one pr_head_moved, accept, merged without a re-review", async () => {
    h = pipelineHarness({
      merge: "auto",
      siblings: { T2: null },
      autopilot: (d) => (d.kind === "pr_head_moved" ? "accept" : undefined),
    });
    await h.start();
    await h.startTask("T2");
    for (const t of ["T1", "T2"] as const) {
      h.openPr(H[t], t, PR[t]);
      h.world.mergeCommit[PR[t]] = MERGED[PR[t]];
    }
    for (const t of ["T1", "T2"] as const) {
      await h.finish("implementer", { task: t, head: H[t], ci: "green" });
      await h.finish("spec_reviewer", { task: t, result: approve() });
      await h.finish("quality_reviewer", { task: t, result: approve() });
      expect(h.task(t)?.stage).toBe("merge_ready");
    }

    // T1 merges; T2 waits its turn in the queue.
    await h.tick();
    expect(mergedPrs()).toEqual([7]);
    expect(h.task("T2")?.stage).toBe("merge_ready");

    // "Update branch" on T2: B merges the new release tip into H2, touching release files only.
    const tip = h.world.releaseTip;
    const branch = branchName("w1", "T2", "implementer", 1);
    h.world.parents[B] = [H.T2, tip];
    h.world.ancestor[`${tip}..${tip}`] = true;
    h.world.mergeBase[H.T2] = MB;
    h.world.diffNames[`${H.T2}..${B}`] = ["CHANGELOG.md"];
    h.world.diffNames[`${MB}..${tip}`] = ["CHANGELOG.md"];
    h.world.origin[branch] = B;
    for (const pr of h.world.prs) if (pr.number === PR.T2) pr.headRefOid = B;
    h.world.ci[B] = "green";

    // One tick: the merge check sees B, and T2 takes the turn whose gate check sees B too.
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    for (let i = 0; i < 4 && !mergedPrs().includes(8); i++) {
      h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
      await h.tick();
    }

    expect(ofType("pr_head_moved")).toHaveLength(1);
    expect(ofType("alarm_raised").map((e) => e.data.alarm)).not.toContain("pr_head_moved");
    expect(ofType("alarm_raised").map((e) => e.data.alarm)).not.toContain("merge_ready_invariant");
    const opened = ofType("decision_opened");
    expect(opened.map((e) => e.data.kind)).toEqual(["pr_head_moved"]);
    expect(ofType("decision_resolved").map((e) => [e.data.answer, e.data.by])).toEqual([
      ["accept", "volleyd"],
    ]);
    // The only re-verification at B is the accept's: the move, and who took it.
    const atB = ofType("artifact_verified").filter(
      (e) => e.data.role === "implementer" && e.data.head_sha === B,
    );
    expect(atB.map((e) => e.data)).toEqual([
      expect.objectContaining({
        accepted_by: "volleyd",
        move: expect.objectContaining({ how: "release_merge" }),
      }),
    ]);
    expect(h.spawns.filter((s) => s.task === "T2" && s.role === "spec_reviewer")).toHaveLength(1);
    expect(mergedPrs()).toEqual([7, 8]);
    expect(h.task("T2")?.stage).toBe("done");
  });
});
