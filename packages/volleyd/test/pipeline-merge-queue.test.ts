import { afterEach, describe, expect, it } from "vitest";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import { releaseLockOn } from "../src/pipeline";
import {
  type Harness,
  type HarnessOptions,
  pipelineHarness,
  sha,
} from "./helpers/pipeline-harness";

/**
 * The merge queue in the pipeline (A6, SPEC §4.6.17): under `merge: auto` volleyd merges a wave's
 * gated tasks one at a time, in queue order; after each merge the next task is brought up to date
 * with the release branch (one rebase per merge, never all at once) and merged once it gates again.
 */

const R0 = sha(0xbea5e); // the harness's release tip
const H = { T1: sha(0x1001), T2: sha(0x2001), T3: sha(0x3001) } as const;
const H2b = sha(0x2002);
const H3b = sha(0x3002);
const PR = { T1: 7, T2: 8, T3: 9 } as const;
const MERGED = { 7: sha(0xa101), 8: sha(0xa102), 9: sha(0xa103) } as const;

let h: Harness;
afterEach(() => h?.cleanup());

const mergeCalls = () => h.calls.filter((a) => a[0] === "gh" && a[1] === "pr" && a[2] === "merge");
const mergedPrs = () => mergeCalls().map((a) => Number(a[3]));
const rebasesOf = (task: string) =>
  h.events.filter((e) => e.type === "stage_entered" && e.task === task && e.data.rebase === true)
    .length;
const ofType = (type: string) => h.events.filter((e) => e.type === type);
const queue = () => h.record().state?.merge_queue ?? [];

/** T1, T2, T3 (siblings) gated at heads cut from R0; nothing merged before the first tick. */
async function threeGated(o: HarnessOptions = {}) {
  h = pipelineHarness({
    pipeline: "[implement, merge_ready]",
    merge: "auto",
    siblings: { T2: null, T3: null },
    ...o,
  });
  await h.start();
  await h.startTask("T2");
  await h.startTask("T3");
  for (const t of ["T1", "T2", "T3"] as const) {
    h.openPr(H[t], t, PR[t]);
    h.world.mergeCommit[PR[t]] = MERGED[PR[t]];
  }
  // Every merge moves the release tip; the heads still queued are then behind it.
  h.world.before = (a) => {
    if (a[1] === "pr" && a[2] === "merge")
      for (const head of [H.T2, H.T3]) h.world.mergeBase[head] = R0;
  };
  for (const t of ["T1", "T2", "T3"] as const)
    await h.finish("implementer", { task: t, head: H[t], ci: "green" });
  for (const t of ["T1", "T2", "T3"]) expect(h.task(t)?.stage).toBe("merge_ready");
  expect(mergeCalls()).toEqual([]);
}

/** A release-branch lock shared with "other waves": `held` maps branch → holder key. */
function sharedLock() {
  const held = new Map<string, string>();
  return { held, lock: releaseLockOn(held) };
}

describe("merge queue", () => {
  it("merges strictly one at a time, updating the next task after each merge", async () => {
    await threeGated();
    await h.tick();
    expect(ofType("merge_queued").map((e) => [e.data.task, e.data.position])).toEqual([
      ["T1", 1],
      ["T2", 2],
      ["T3", 3],
    ]);
    expect(mergeCalls()).toEqual([
      ["gh", "pr", "merge", "7", "--squash", "--match-head-commit", H.T1],
    ]);
    expect(h.task("T1")?.stage).toBe("done");
    expect(h.world.releaseTip).toBe(MERGED[7]);

    // Next tick: T1 leaves the queue; T2 (only T2) is brought up to date.
    await h.tick();
    expect(ofType("merge_dequeued").map((e) => e.data)).toEqual([{ task: "T1", why: "merged" }]);
    expect(rebasesOf("T2")).toBe(1);
    expect(rebasesOf("T3")).toBe(0);
    expect(mergedPrs()).toEqual([7]);
    expect(queue().map((e) => [e.task, e.state])).toEqual([
      ["T2", "updating"],
      ["T3", "queued"],
    ]);

    // The update pushes H2b, green: gated again and merged at once (it holds the turn).
    await h.finish("rebase", { task: "T2", head: H2b, ci: "green" });
    expect(mergedPrs()).toEqual([7, 8]);
    expect(mergeCalls()[1]).toEqual([
      "gh",
      "pr",
      "merge",
      "8",
      "--squash",
      "--match-head-commit",
      H2b,
    ]);
    expect(h.task("T2")?.stage).toBe("done");

    await h.tick();
    expect(rebasesOf("T3")).toBe(1);
    await h.finish("rebase", { task: "T3", head: H3b, ci: "green" });
    expect(mergedPrs()).toEqual([7, 8, 9]);
    await h.tick();
    expect(queue()).toEqual([]);
    expect(h.record().state?.merge_queue).toBeUndefined();

    // merge_started / merged_by_supervisor bracket each merge: never two in flight.
    const bracket = h.events
      .filter((e) => e.type === "merge_started" || e.type === "merged_by_supervisor")
      .map((e) => `${e.type === "merge_started" ? "start" : "merged"} ${e.data.task}`);
    expect(bracket).toEqual([
      "start T1",
      "merged T1",
      "start T2",
      "merged T2",
      "start T3",
      "merged T3",
    ]);
    // N−1 updates, serially.
    expect(rebasesOf("T1") + rebasesOf("T2") + rebasesOf("T3")).toBe(2);
  });

  it("a refused merge releases the branch: the next task goes, the refused one is marked", async () => {
    await threeGated();
    await h.tick(); // T1 merged
    await h.tick(); // T2 updating
    h.world.mergeRefuse = "Pull request is not mergeable: required checks";
    await h.finish("rebase", { task: "T2", head: H2b, ci: "green" });
    expect(mergedPrs()).toEqual([7, 8]);
    expect(h.task("T2")?.stage).toBe("merge_ready");
    expect(queue().find((e) => e.task === "T2")?.state).toBe("refused");

    h.world.mergeRefuse = undefined;
    await h.tick(); // the turn passes to T3, which is behind: updated
    expect(rebasesOf("T3")).toBe(1);
    expect(queue().map((e) => [e.task, e.state])).toEqual([
      ["T2", "refused"],
      ["T3", "updating"],
    ]);
    expect(ofType("merge_dequeued").map((e) => e.data.task)).toEqual(["T1"]);
    await h.finish("rebase", { task: "T3", head: H3b, ci: "green" });
    expect(mergedPrs()).toEqual([7, 8, 9]);
  });

  it("a task after another never merges first, and dependents go first", async () => {
    // T1 is the task T3 waits on; T2 has none: T1 merges first even when gated last.
    h = pipelineHarness({
      pipeline: "[implement, merge_ready]",
      merge: "auto",
      siblings: { T2: null },
      dependents: { T3: ["T1"] },
    });
    await h.start();
    await h.startTask("T2");
    h.openPr(H.T2, "T2", 8);
    h.openPr(H.T1, "T1", 7);
    await h.finish("implementer", { task: "T2", head: H.T2, ci: "green" });
    await h.finish("implementer", { task: "T1", head: H.T1, ci: "green" });
    await h.tick();
    expect(mergedPrs()).toEqual([7]);
  });

  it("merge: manual queues nothing and merges nothing", async () => {
    await threeGated({ merge: "manual" });
    await h.tick();
    expect(ofType("merge_queued")).toEqual([]);
    expect(mergeCalls()).toEqual([]);
  });

  it("two waves on one release branch: the lock is shared", async () => {
    const { held, lock } = sharedLock();
    held.set("/repo#release/w1", "other-wave/T9");
    await threeGated({ releaseLock: lock });
    await h.tick();
    expect(mergeCalls()).toEqual([]);
    held.delete("/repo#release/w1");
    await h.tick();
    expect(mergedPrs()).toEqual([7]);
    // Released once T1 merged; the next tick takes it for T2's update.
    await h.tick();
    expect(held.get("/repo#release/w1")).toBe("w1/T2");
  });

  it("a merge that timed out is not left in flight: the task takes the turn again", async () => {
    await threeGated();
    const isMerge = (a: string[]) => a[0] === "gh" && a[1] === "pr" && a[2] === "merge";
    h.world.timeout = isMerge;
    await h.tick();
    expect(mergedPrs()).toEqual([7]);
    expect(ofType("merge_ended").map((e) => e.data)).toEqual([{ task: "T1", why: "timed_out" }]);
    expect(queue().find((e) => e.task === "T1")?.state).toBe("queued");

    h.world.timeout = undefined;
    h.elapse(60 * 60_000);
    await h.tick();
    await h.tick();
    expect(mergedPrs()).toEqual([7, 7]);
    expect(h.task("T1")?.stage).toBe("done");
  });

  it("a restart between merge_started and its outcome: the task takes the turn again", async () => {
    await threeGated({ merge: "manual" });
    // The daemon journaled the merge, then died before `gh pr merge` came back.
    await h.journal({ type: "merge_started", task: "T1", data: { task: "T1", pr: 7, head: H.T1 } });
    h.restart();
    await h.tick();
    expect(ofType("merge_ended").map((e) => e.data)).toEqual([{ task: "T1", why: "interrupted" }]);
    const r = await h.driver.mergeNow("T1", "coord-1");
    expect(r).toEqual({ ok: true, merge_sha: MERGED[7] });
  });

  it("a restart under merge: auto merges the interrupted task on its next turn", async () => {
    await threeGated();
    // The daemon journaled T1's merge, then died before `gh pr merge` came back (unmerged).
    await h.journal({ type: "merge_started", task: "T1", data: { task: "T1", pr: 7, head: H.T1 } });
    h.restart();
    await h.tick();
    await h.tick();
    expect(mergedPrs()).toContain(7);
    expect(h.task("T1")?.stage).toBe("done");
  });

  it("a stopped wave keeps the release branch while its merge is in flight", async () => {
    const { held, lock } = sharedLock();
    await threeGated({ releaseLock: lock });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered: (() => void) | undefined;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    h.world.gate = (a) => {
      if (a[1] !== "pr" || a[2] !== "merge") return undefined;
      entered?.();
      return gate;
    };
    await h.driver.tick();
    await started; // T1's `gh pr merge` is running, held
    expect(ofType("merge_started").map((e) => e.data.task)).toEqual(["T1"]);
    h.driver.releaseTurn();
    expect(held.get("/repo#release/w1")).toBe("w1/T1");
    release?.();
    await h.driver.settled();
    h.driver.releaseTurn();
    expect(held.get("/repo#release/w1")).toBeUndefined();
  });

  it("a turn holder whose turn check keeps failing passes the turn on: the queue is not wedged", async () => {
    await threeGated();
    // T1's PR is retargeted after its gate: every turn check of T1 throws.
    h.world.prView[7] = { baseRefName: "main" };
    for (let i = 0; i < DAEMON_DEFAULTS.merge_turn_check_failures_max + 2; i++) {
      h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
      await h.tick();
    }
    expect(mergedPrs()).toContain(8);
    expect(mergedPrs()).not.toContain(7);
  });

  it("autopilot.delete_branch adds --delete-branch", async () => {
    await threeGated({ deleteBranch: true });
    await h.tick();
    expect(mergeCalls()[0]).toEqual([
      "gh",
      "pr",
      "merge",
      "7",
      "--squash",
      "--match-head-commit",
      H.T1,
      "--delete-branch",
    ]);
  });
});

describe("mergeNow (volleyd merge)", () => {
  const BRANCH = "/repo#release/w1";

  it("is refused while another task holds the release branch, naming the holder", async () => {
    const { held, lock } = sharedLock();
    await threeGated({ merge: "manual", releaseLock: lock });
    held.set(BRANCH, "other-wave/T9");
    const r = await h.driver.mergeNow("T1", "coord-1");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain("other-wave/T9 holds release/w1");
    expect(mergeCalls()).toEqual([]);
    expect(held.get(BRANCH)).toBe("other-wave/T9");
  });

  it("a head no token can be minted for is refused and the release branch is released", async () => {
    const { held, lock } = sharedLock();
    h = pipelineHarness({
      pipeline: "[implement, merge_ready]",
      merge: "manual",
      releaseLock: lock,
    });
    await h.start();
    h.openPr("abc1234", "T1", 7);
    await h.finish("implementer", { task: "T1", head: "abc1234", ci: "green" });
    expect(h.task("T1")?.stage).toBe("merge_ready");
    const r = await h.driver.mergeNow("T1", "coord-1");
    expect(r.ok === false && r.error).toContain("no merge token can be minted");
    expect(mergeCalls()).toEqual([]);
    expect(held.get(BRANCH)).toBeUndefined();
  });

  it("a refused merge answers not merged and releases the release branch", async () => {
    const { held, lock } = sharedLock();
    await threeGated({ merge: "manual", releaseLock: lock });
    h.world.mergeRefuse = "Pull request is not mergeable: required checks";
    const r = await h.driver.mergeNow("T1", "coord-1");
    expect(r).toEqual({
      ok: false,
      error: "not merged: Pull request is not mergeable: required checks",
    });
    expect(mergedPrs()).toEqual([7]);
    expect(held.get(BRANCH)).toBeUndefined();
    expect(h.task("T1")?.stage).toBe("merge_ready");
  });

  it("under merge: auto, the queue's turn never merges the task a running volleyd merge is merging", async () => {
    const { held, lock } = sharedLock();
    await threeGated({ releaseLock: lock });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered: (() => void) | undefined;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    h.world.gate = (a) => {
      if (a[1] !== "pr" || a[2] !== "merge") return undefined;
      entered?.();
      return gate;
    };
    const pending = h.driver.mergeNow("T1", "coord-1");
    await started; // the owner's `gh pr merge` of T1 is running, held
    for (let i = 0; i < 3; i++) {
      h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
      await h.driver.tick();
    }
    expect(mergedPrs()).toEqual([7]);
    expect(held.get(BRANCH)).toBe("w1/T1");
    release?.();
    expect(await pending).toEqual({ ok: true, merge_sha: MERGED[7] });
    await h.driver.settled();
    expect(ofType("merge_ended")).toEqual([]);
    expect(ofType("merge_refused")).toEqual([]);
    expect(mergedPrs().filter((n) => n === 7)).toEqual([7]);
    expect(h.task("T1")?.stage).toBe("done");
  });

  it("under merge: auto, a turn check that comes back during volleyd merge does not merge again", async () => {
    const { held, lock } = sharedLock();
    await threeGated({ releaseLock: lock });
    const hold = () => {
      let open: (() => void) | undefined;
      const p = new Promise<void>((r) => {
        open = r;
      });
      let enter: (() => void) | undefined;
      const entered = new Promise<void>((r) => {
        enter = r;
      });
      return { p, entered, open: () => open?.(), enter: () => enter?.() };
    };
    const check = hold();
    const merge = hold();
    let checkHeld = false;
    h.world.gate = (a) => {
      if (a[0] === "git" && a[3] === "merge-base" && a[4] !== "--is-ancestor" && !checkHeld) {
        checkHeld = true;
        check.enter();
        return check.p;
      }
      if (a[1] === "pr" && a[2] === "merge") {
        merge.enter();
        return merge.p;
      }
      return undefined;
    };
    const ticked = h.driver.tick();
    await check.entered; // T1 holds the turn; its rebase check is running, held
    await ticked;
    const pending = h.driver.mergeNow("T1", "coord-1");
    await merge.entered; // the owner's `gh pr merge` of T1 is running, held
    check.open();
    for (let i = 0; i < 3; i++) {
      h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
      await h.driver.tick();
    }
    expect(mergedPrs()).toEqual([7]);
    expect(held.get(BRANCH)).toBe("w1/T1");
    merge.open();
    expect(await pending).toEqual({ ok: true, merge_sha: MERGED[7] });
    await h.driver.settled();
    expect(ofType("merge_ended")).toEqual([]);
    expect(ofType("merge_refused")).toEqual([]);
    expect(mergedPrs().filter((n) => n === 7)).toEqual([7]);
    expect(h.task("T1")?.stage).toBe("done");
  });

  it("a merge that fails to run answers not merged and releases the release branch", async () => {
    const { held, lock } = sharedLock();
    await threeGated({ merge: "manual", releaseLock: lock });
    h.world.fail = (a) => a[0] === "gh" && a[1] === "pr" && a[2] === "merge";
    const r = await h.driver.mergeNow("T1", "coord-1");
    expect(r.ok === false && r.error).toContain("not merged: ");
    expect(r.ok === false && r.error).toContain("ENOENT");
    expect(held.get(BRANCH)).toBeUndefined();
  });
});

describe("merge_conflict", () => {
  it("a rebase before the gate (never queued) that blocks is agent_blocked, not merge_conflict", async () => {
    h = pipelineHarness({ pipeline: "[implement, merge_ready]", merge: "auto" });
    await h.start();
    h.openPr(H.T1, "T1", PR.T1);
    h.world.mergeBase[H.T1] = sha(0xdead); // behind the release tip before it ever gated
    await h.finish("implementer", { head: H.T1, ci: "green" });
    expect(rebasesOf("T1")).toBe(1);
    await h.block("rebase", "CONFLICT (content): merge conflict in src/batch.ts", "T1");
    expect(h.openDecisions().map((d) => d.kind)).toEqual(["agent_blocked"]);
    expect(ofType("merge_queued")).toEqual([]);
  });

  async function conflicted() {
    await threeGated();
    await h.tick(); // T1 merged
    await h.tick(); // T2 updating
    await h.block("rebase", "CONFLICT (content): merge conflict in src/batch.ts", "T2");
    const [d] = h.openDecisions();
    expect(d?.kind).toBe("merge_conflict");
    expect(d?.task).toBe("T2");
    expect(d?.options).toEqual(["respawn", "manual", "cancel"]);
    return d?.decision_id as string;
  }

  it("respawn: a fresh rebase agent at attempt 2", async () => {
    const id = await conflicted();
    await h.resolve(id, "respawn");
    const rebases = h.spawns.filter((s) => s.task === "T2" && s.role === "rebase");
    expect(rebases.map((s) => s.agent_id.endsWith("-2"))).toEqual([false, true]);
  });

  it("a rebase agent that fails during the update opens it too", async () => {
    await threeGated();
    await h.tick();
    await h.tick();
    await h.finish("rebase", { task: "T2", status: "failed" });
    expect(h.openDecisions().map((d) => d.kind)).toEqual(["merge_conflict"]);
  });

  it("cancel: the blocked rebase agent is stopped and the task cancelled", async () => {
    const id = await conflicted();
    const agent = h.run("rebase", "T2")?.agent_id as string;
    await h.resolve(id, "cancel");
    expect(h.task("T2")?.stage).toBe("cancelled");
    expect(h.retired).toContainEqual({ agent_id: agent, status: "stopped" });
  });

  it("manual: the task leaves the queue and waits at the gate for a person", async () => {
    const id = await conflicted();
    await h.resolve(id, "manual");
    expect(h.task("T2")?.stage).toBe("merge_ready");
    await h.tick();
    expect(ofType("merge_dequeued").map((e) => e.data)).toContainEqual({
      task: "T2",
      why: "manual",
    });
    // The turn passes to T3; T2 is never merged by volleyd.
    expect(rebasesOf("T3")).toBe(1);
    await h.finish("rebase", { task: "T3", head: H3b, ci: "green" });
    await h.tick();
    expect(mergedPrs()).toEqual([7, 9]);
  });
});
