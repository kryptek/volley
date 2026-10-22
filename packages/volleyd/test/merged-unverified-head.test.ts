import { afterEach, describe, expect, it } from "vitest";
import { formatWave } from "../src/commands/status";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import { type PipelineView, emptyPipeline, next } from "../src/pipeline";
import { type Harness, pipelineHarness, sha } from "./helpers/pipeline-harness";

/**
 * GitHub reports MERGED with a head other than the gated one: the task completes (the merge
 * happened), the `merged_unverified_head` alarm is surfaced in the wave state (`alarms`,
 * `why_waiting`) and by `volleyd status`, and the merge record describes the head that merged —
 * its sha and ITS CI (fetched; `unknown` when it cannot be read) — never the gated head's CI.
 */

const A = sha(0xa1);
const C = sha(0xc3);
const SQUASH = sha(0x5a5a);
let h: Harness;
afterEach(() => h?.cleanup());

async function gated() {
  h = pipelineHarness({ pipeline: "[implement, merge_ready]" });
  await h.start();
  h.openPr(A);
  await h.finish("implementer", { head: A, ci: "green" });
  expect(h.task()?.stage).toBe("merge_ready");
}

const checkMerged = async () => {
  h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
  await h.tick();
};
const merged = () =>
  h.events.find((e) => e.type === "artifact_verified" && e.data.role === "merged");

describe("merged_unverified_head", () => {
  it("MERGED at C ≠ gated A → done, alarm surfaced in state and status, C's own CI recorded", async () => {
    await gated();
    h.world.prState[7] = "MERGED";
    h.world.prView[7] = { headRefOid: C };
    h.world.ci[C] = "red";
    await checkMerged();
    const t = h.task();
    expect(t?.stage).toBe("done");
    expect(h.events.find((e) => e.data.alarm === "merged_unverified_head")?.data).toMatchObject({
      gated: A,
      merged: C,
    });
    const line = `merged with an unverified head: gated ${A.slice(0, 7)}, merged ${C.slice(0, 7)}`;
    expect(t?.alarms).toEqual([{ alarm: "merged_unverified_head", message: line }]);
    expect(t?.why_waiting).toBe(line);
    const out = formatWave(h.record().state as never);
    expect(out).toContain(line);
    expect(out).toContain("alarms: 1");
    // The merge record: the head that merged and its CI, not A's green carried over.
    expect(merged()?.data).toMatchObject({
      head_sha: A,
      gated_head_sha: A,
      merged_head_sha: C,
      merged_ci: "red",
      pr: { number: 7, head_sha: C, ci: "red" },
    });
    expect(t?.pr).toMatchObject({ head_sha: C, ci: "red" });
    expect(h.calls).toContainEqual(expect.arrayContaining(["gh", "run", "list", "--commit", C]));
  });

  it("the merged head's CI cannot be read → merged_ci: unknown, no CI claimed for it", async () => {
    await gated();
    h.world.prState[7] = "MERGED";
    h.world.prView[7] = { headRefOid: C };
    h.world.fail = (argv) => argv[1] === "run" && argv.includes(C);
    await checkMerged();
    expect(h.task()?.stage).toBe("done");
    const d = merged()?.data as { merged_ci: string; pr: { ci?: string; head_sha: string } };
    expect(d.merged_ci).toBe("unknown");
    expect(d.pr.head_sha).toBe(C);
    expect(d.pr.ci).toBeUndefined();
  });

  it("an out-of-band squash at another commit records that commit and its CI too", async () => {
    await gated();
    h.world.prState[7] = "CLOSED";
    h.world.releaseLog = `${SQUASH} Batch the uploads (#7)\n`;
    // The squash's own diff is the PR's whole diff (a subject alone is never enough).
    const diff = "diff --git a/up.ts b/up.ts\n@@ -1 +1 @@\n-a\n+batched\n";
    h.world.patches[SQUASH] = diff;
    h.world.patches[`${h.world.releaseTip}..${A}`] = diff;
    h.world.ci[SQUASH] = "green";
    await checkMerged();
    expect(merged()?.data).toMatchObject({
      via: "outside_github",
      merged_head_sha: SQUASH,
      merged_ci: "green",
      pr: { head_sha: SQUASH, ci: "green" },
    });
  });

  it("merged at the gated head: no alarm, the gated CI stands", async () => {
    await gated();
    h.world.prState[7] = "MERGED";
    await checkMerged();
    expect(h.task()?.alarms).toBeUndefined();
    expect(merged()?.data).toMatchObject({ pr: { head_sha: A, ci: "green" } });
    expect(merged()?.data.merged_ci).toBeUndefined();
  });

  it("merged by a person at the gated head during a branch update: done, the update retired, no alarm (#311)", async () => {
    const B = sha(0xb2);
    h = pipelineHarness({
      pipeline: "[implement, merge_ready]",
      merge: "auto",
      branchUpdate: "merge",
      siblings: { T2: null },
    });
    await h.start();
    await h.startTask("T2");
    h.openPr(A, "T1", 7);
    h.openPr(B, "T2", 8);
    h.world.mergeCommit[7] = sha(0xa101);
    // T1's merge moves the release tip: T2 is behind it.
    h.world.before = (a) => {
      if (a[1] === "pr" && a[2] === "merge") h.world.mergeBase[B] = sha(0xbea5e);
    };
    await h.finish("implementer", { task: "T1", head: A, ci: "green" });
    await h.finish("implementer", { task: "T2", head: B, ci: "green" });
    await h.tick(); // T1 merged
    await h.tick(); // T2's turn: behind, its branch update starts
    expect(h.task("T2")?.stage).toBe("fixup");
    const update = h.spawns.find((s) => s.task === "T2" && s.role === "rebase");
    expect(update?.branch_update).toBe("merge");

    // A person merges PR #8 on GitHub at B, the head the gate saw.
    h.world.prState[8] = "MERGED";
    await checkMerged();
    expect(h.task("T2")?.stage).toBe("done");
    expect(h.events.some((e) => e.data.alarm === "merged_unverified_head")).toBe(false);
    expect(h.task("T2")?.alarms).toBeUndefined();
    const m = h.events.find(
      (e) => e.task === "T2" && e.type === "artifact_verified" && e.data.role === "merged",
    );
    // Merged with GitHub's button: no `via`, so the digest reads it as `github`, not `operator`.
    expect(m?.data).toMatchObject({ head_sha: B, pr: { head_sha: B } });
    expect(m?.data.via).toBeUndefined();
    expect(m?.data.merged_head_sha).toBeUndefined();
    expect(h.retired).toContainEqual({ agent_id: update?.agent_id, status: "superseded" });
  });

  it("only the current gated head counts: a merge at an older gated head still alarms (#311)", () => {
    const B = sha(0xb2);
    const view = (head: string): PipelineView => ({
      task: "T1",
      stages: [["implement"], ["merge_ready"]],
      stage: "fixup",
      release_branch: "release/w",
      p: { ...emptyPipeline(), pr: { url: "u", number: 7 } as never, head, gated: [A, B] },
    });
    const ev = (head: string) => ({
      kind: "merge_checked" as const,
      view: { state: "MERGED", baseRefName: "release/w", headRefOid: head },
    });
    const alarmed = (head: string) =>
      next(view(head), ev(head)).some(
        (a) => a.kind === "journal" && a.event.data?.alarm === "merged_unverified_head",
      );
    expect(alarmed(B)).toBe(false);
    expect(alarmed(A)).toBe(true);
  });
  it("off merge_ready, a merge whose head GitHub does not report still alarms (#311)", () => {
    const view: PipelineView = {
      task: "T1",
      stages: [["implement"], ["merge_ready"]],
      stage: "fixup",
      release_branch: "release/w",
      p: { ...emptyPipeline(), pr: { url: "u", number: 7 } as never, head: A, gated: [A] },
    };
    const actions = next(view, {
      kind: "merge_checked",
      view: { state: "MERGED", baseRefName: "release/w" },
    });
    expect(
      actions.some((a) => a.kind === "journal" && a.event.data?.alarm === "merged_unverified_head"),
    ).toBe(true);
  });
});
