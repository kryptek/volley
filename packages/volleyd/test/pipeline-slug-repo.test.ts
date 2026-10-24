import { afterEach, describe, expect, it } from "vitest";
import { type Harness, pipelineHarness, sha } from "./helpers/pipeline-harness";

/**
 * A wave named by an `owner/name` only paired machines hold (#448): the supervisor has no clone of
 * it, so the pipeline's GitHub work runs with `--repo <owner/name>` and no `cwd`, and nothing it
 * does reads a local checkout at the slug's relative path.
 */

const H = sha(0x448);
const MERGE_SHA = sha(0x4480);

let h: Harness;
afterEach(() => h?.cleanup());

describe("a wave whose repo: is an owner/name the supervisor holds no clone of (#448)", () => {
  it("gates the PR and merges it with --repo b/b, never in a cwd of b/b", async () => {
    h = pipelineHarness({ pipeline: "[implement, merge_ready]", merge: "auto", repo: "b/b" });
    await h.start();
    h.openPr(H);
    h.world.mergeCommit[7] = MERGE_SHA;
    await h.finish("implementer", { head: H, ci: "green" });
    await h.tick();

    expect(h.task()?.stage).toBe("done");
    expect(h.events.some((e) => e.type === "merged_by_supervisor")).toBe(true);
    const merges = h.calls.filter((a) => a[0] === "gh" && a[1] === "pr" && a[2] === "merge");
    expect(merges).toEqual([
      ["gh", "pr", "merge", "7", "--squash", "--match-head-commit", H, "--repo", "b/b"],
    ]);
    // The supervisor's gh work: every argv names the repository, none runs in `b/b`.
    h.calls.forEach((a, i) => {
      expect(h.callOpts[i]?.cwd ?? "").not.toMatch(/(^|\/)b\/b$/);
      if (a[0] === "gh" && a[1] !== "api") expect(a.slice(-2)).toEqual(["--repo", "b/b"]);
      if (a[0] === "git") expect(a).not.toContain("b/b");
    });
    expect(
      h.events.some((e) => e.type === "alarm_raised" && e.data.alarm === "pipeline_error"),
    ).toBe(false);
  });
});
