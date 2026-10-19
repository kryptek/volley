import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { landed } from "../src/artifacts";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
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

/** T1 at merge_ready on H1 (PR #7), then the PR is closed unmerged. */
async function closedAtGate() {
  h = pipelineHarness({ pipeline: "[implement, merge_ready]" });
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

  it("not an ancestor, patches not upstream, but a release commit names (#7) → landed via subject", async () => {
    await closedAtGate();
    h.world.releaseLog = `${sha(0x77)} unrelated change (#5)\n${SQUASH} Batch the uploads (#7)\n`;
    await checkMerged();
    expect(merged()?.data).toMatchObject({ via: "outside_github", how: "subject", sha: SQUASH });
    expect(h.task()?.stage).toBe("done");
    expect(h.events.some((e) => e.data.alarm === "pr_closed_unmerged")).toBe(false);
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
    // Asked once: the next check does not ask again.
    await checkMerged();
    expect(h.events.filter((e) => e.type === "decision_opened")).toHaveLength(1);

    await h.resolve(d?.decision_id as string, "landed");
    expect(merged()?.data).toMatchObject({ via: "owner_answer", by: "coord-1", head_sha: H1 });
    expect(h.task()?.stage).toBe("done");
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
  it("ancestor first, then patch equivalence, then a subject naming the PR", () => {
    expect(landed({ ...base, ancestor: true }, H1, "tip", 7)).toEqual({
      how: "ancestor",
      sha: H1,
    });
    expect(landed({ ...base, unmatched: [] }, H1, "tip", 7)).toEqual({ how: "patch", sha: "tip" });
    expect(
      landed({ ...base, subjects: [{ sha: SQUASH, subject: "Batch uploads (#7)" }] }, H1, "tip", 7),
    ).toEqual({ how: "subject", sha: SQUASH });
  });
  it("(#70) is not (#7); nothing matching is null", () => {
    expect(
      landed({ ...base, subjects: [{ sha: SQUASH, subject: "Other (#70)" }] }, H1, "tip", 7),
    ).toBeNull();
    expect(landed(base, H1, "tip", 7)).toBeNull();
  });
});
