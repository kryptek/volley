import { afterEach, describe, expect, it } from "vitest";
import { formatWave } from "../src/commands/status";
import { CONFIG_DEFAULTS, DAEMON_DEFAULTS } from "../src/config-defaults";
import { type Harness, pipelineHarness, sha } from "./helpers/pipeline-harness";

/**
 * After an implementer's done the pipeline holds for CI; that hold is visible: `ci_pending
 * { sha, checks: { done, total }, next_poll_at }` journaled (once per change), the task's
 * why_waiting `CI pending on <sha7> (n/m checks)`, and `pr: { ci: running, checks }` in the
 * state `status --json` prints. CI green → `ci_green`, the hold cleared, reviewers spawn.
 */

const H1 = sha(0x1001);
const H2 = sha(0x1002);
let h: Harness;
afterEach(() => h?.cleanup());

const run = (status: string, conclusion = "") => ({ status, conclusion });
const twoOfFive = [
  run("completed", "success"),
  run("completed", "success"),
  run("in_progress"),
  run("queued"),
  run("in_progress"),
];

async function pending() {
  h = pipelineHarness();
  await h.start();
  h.openPr(H1);
  h.world.ciRuns[H1] = twoOfFive;
  await h.finish("implementer", { head: H1 });
}

const recheck = async () => {
  h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
  await h.tick();
};

describe("CI pending is visible", () => {
  it("done + CI running → ci_pending journaled, why_waiting and pr.ci: running", async () => {
    await pending();
    const ev = h.events.find((e) => e.type === "ci_pending");
    expect(ev?.data).toMatchObject({
      role: "implementer",
      sha: H1,
      checks: { done: 2, total: 5 },
      pr: { number: 7 },
    });
    // The harness driver's clock starts at 12:00; the next re-check is one ci_poll_ms on.
    expect(ev?.data.next_poll_at).toBe(
      new Date(Date.parse("2026-10-18T12:00:00.000Z") + DAEMON_DEFAULTS.ci_poll_ms).toISOString(),
    );
    const t = h.task();
    expect(t?.stage).toBe("implement");
    expect(t?.why_waiting).toBe(`CI pending on ${H1.slice(0, 7)} (2/5 checks)`);
    expect(t?.pr).toMatchObject({
      number: 7,
      head_sha: H1,
      ci: "running",
      checks: { done: 2, total: 5 },
    });
    // `volleyd status` prints the same.
    expect(formatWave(h.record().state as never)).toContain(
      `CI pending on ${H1.slice(0, 7)} (2/5 checks)`,
    );
    // The implementer is retired: the hold is the pipeline's, not the agent's.
    expect(h.run("implementer")?.retired).toBe("done");
  });

  it("a re-check with the same counts journals nothing; a change journals again", async () => {
    await pending();
    await recheck();
    expect(h.events.filter((e) => e.type === "ci_pending")).toHaveLength(1);
    h.world.ciRuns[H1] = [
      ...twoOfFive.slice(0, 3).map(() => run("completed", "success")),
      run("queued"),
      run("in_progress"),
    ];
    await recheck();
    const evs = h.events.filter((e) => e.type === "ci_pending");
    expect(evs).toHaveLength(2);
    expect(evs[1]?.data.checks).toEqual({ done: 3, total: 5 });
    expect(h.task()?.why_waiting).toBe(`CI pending on ${H1.slice(0, 7)} (3/5 checks)`);
  });

  it("a change in a superseded run only journals nothing; its run is not counted", async () => {
    await pending();
    // A stale run of check-3 that a newer run (902) replaced: not a check of this head.
    const stale = { id: 800, workflow: "check-3" };
    h.world.ciRuns[H1] = [...twoOfFive, { ...run("in_progress"), ...stale }];
    await recheck();
    h.world.ciRuns[H1] = [...twoOfFive, { ...run("completed", "cancelled"), ...stale }];
    await recheck();
    expect(h.events.filter((e) => e.type === "ci_pending")).toHaveLength(1);
    expect(h.task()?.why_waiting).toBe(`CI pending on ${H1.slice(0, 7)} (2/5 checks)`);
    expect(h.openDecisions()).toEqual([]);
  });

  it("CI green → ci_green, why_waiting cleared, the reviewers spawn", async () => {
    await pending();
    h.world.ciRuns[H1] = twoOfFive.map(() => run("completed", "success"));
    await recheck();
    expect(h.events.find((e) => e.type === "ci_green")?.data).toMatchObject({ sha: H1 });
    expect(h.task()?.why_waiting).toBeUndefined();
    expect(h.task()?.pr).toMatchObject({ ci: "green" });
    expect(h.spawns.map((s) => s.role)).toEqual([
      "implementer",
      "spec_reviewer",
      "quality_reviewer",
    ]);
  });

  it("CI red → T6's ci_failed decision, unchanged; pr.ci: red", async () => {
    await pending();
    h.world.ciRuns[H1] = [
      ...twoOfFive.slice(0, 4).map(() => run("completed", "success")),
      run("completed", "failure"),
    ];
    await recheck();
    const [d] = h.openDecisions();
    expect(d).toMatchObject({ kind: "ci_failed", options: ["fixup", "re-verify", "cancel"] });
    expect(h.events.some((e) => e.type === "ci_green")).toBe(false);
    expect(h.task()?.pr).toMatchObject({ number: 7, ci: "red" });
    expect(h.task()?.why_waiting).toContain("awaiting decision");
  });
});

describe("unreadable CI (a rate limit) is not `no CI` (#310)", () => {
  const RATE = "HTTP 403: API rate limit exceeded for user ID 1.";
  const probes = () => h.calls.filter((c) => c[0] === "gh" && c[1] === "api").length;
  const rateAlarms = () =>
    h.events.filter((e) => e.type === "alarm_raised" && e.data.alarm === "github_rate_limited");

  it("403 on every probe past ci_none_grace_ms: no decision, one alarm, backoff; green after it verifies", async () => {
    h = pipelineHarness();
    await h.start();
    h.openPr(H1);
    h.world.ciError = RATE;
    await h.finish("implementer", { head: H1 });
    const until = DAEMON_DEFAULTS.ci_none_grace_ms + DAEMON_DEFAULTS.ci_poll_ms;
    for (let t = 0; t <= until; t += DAEMON_DEFAULTS.ci_poll_ms) await recheck();

    expect(h.openDecisions()).toEqual([]);
    expect(rateAlarms()).toHaveLength(1);
    const backoff = CONFIG_DEFAULTS.ci_rate_limit_backoff_ms;
    expect(rateAlarms()[0]?.data).toMatchObject({
      alarm: "github_rate_limited",
      retry_at: new Date(Date.parse("2026-10-18T12:00:00.000Z") + backoff).toISOString(),
    });
    // No CI call before retry_at: one probe per backoff, not one per poll.
    expect(probes()).toBeLessThanOrEqual(
      Math.ceil((until + DAEMON_DEFAULTS.ci_poll_ms) / backoff) + 1,
    );
    expect(h.task()?.why_waiting).toBe(`CI unreadable (${RATE}), retrying`);
    expect(h.task()?.stage).toBe("implement");

    // GitHub answers again: the head is green.
    h.world.ciError = undefined;
    h.world.ci[H1] = "green";
    h.elapse(backoff);
    await h.tick();
    expect(h.events.find((e) => e.type === "artifact_verified")?.data).toMatchObject({
      head_sha: H1,
    });
    expect(
      h.events.find((e) => e.type === "alarm_cleared" && e.data.alarm === "github_rate_limited"),
    ).toBeDefined();
    expect(h.openDecisions()).toEqual([]);
  });

  it("a Retry-After longer than the backoff is honoured", async () => {
    h = pipelineHarness();
    await h.start();
    h.openPr(H1);
    h.world.ciError = "HTTP 429: Too Many Requests\nRetry-After: 900";
    await h.finish("implementer", { head: H1 });
    expect(rateAlarms()[0]?.data.retry_at).toBe(
      new Date(Date.parse("2026-10-18T12:00:00.000Z") + 900_000).toISOString(),
    );
    const before = probes();
    h.elapse(CONFIG_DEFAULTS.ci_rate_limit_backoff_ms);
    await h.tick();
    expect(probes()).toBe(before);
  });

  it("a non-rate-limit failure (HTTP 502) is a hold re-polled every ci_poll_ms, never a decision", async () => {
    h = pipelineHarness();
    await h.start();
    h.openPr(H1);
    h.world.ciError = "HTTP 502: Bad Gateway";
    await h.finish("implementer", { head: H1 });
    const until = DAEMON_DEFAULTS.ci_none_grace_ms + DAEMON_DEFAULTS.ci_poll_ms;
    for (let t = 0; t <= until; t += DAEMON_DEFAULTS.ci_poll_ms) await recheck();
    expect(h.openDecisions()).toEqual([]);
    expect(rateAlarms()).toEqual([]);
    expect(probes()).toBeGreaterThan(until / DAEMON_DEFAULTS.ci_poll_ms);
    expect(h.task()?.why_waiting).toBe("CI unreadable (HTTP 502: Bad Gateway), retrying");
  });
});

describe("a CONFLICTING PR enters the branch-update step (no CI will run on it)", () => {
  async function conflicting(mode: "merge" | "rebase" = "merge") {
    h = pipelineHarness({ branchUpdate: mode });
    await h.start();
    h.openPr(H1);
    const pr = h.world.prs[0];
    if (pr !== undefined)
      Object.assign(pr, { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" });
    await h.finish("implementer", { head: H1 });
  }

  it("done + CONFLICTING + no run → pr_conflicting, then the update step at once; never the no-CI decision", async () => {
    await conflicting();
    const ev = h.events.filter((e) => e.type === "pr_conflicting");
    expect(ev).toHaveLength(1);
    expect(ev[0]?.task).toBe("T1");
    expect(ev[0]?.data).toEqual({
      role: "implementer",
      pr: { number: 7, url: "https://github.com/example/repo/pull/7" },
      head: H1,
      release_branch: "release/w1",
    });
    const entered = h.events.filter((e) => e.type === "stage_entered").at(-1);
    expect(entered?.data).toMatchObject({
      stage: "fixup",
      roles: ["rebase"],
      rebase: true,
      conflicting: true,
      branch_update: "merge",
    });
    expect(h.events.some((e) => e.type === "ci_pending")).toBe(false);
    const step = h.spawns.find((s) => s.role === "rebase");
    expect(step?.start).toEqual({ ref: H1, detach: false });
    expect(step?.files["rebase.md"]).toContain("conflicts with `release/w1`");
    expect(h.run("implementer")?.retired).toBe("done");
    expect(h.task()?.why_waiting).toBe("PR conflicts with release/w1, updating");

    // The grace for a head with no CI passes: nothing is asked, nothing journaled again.
    h.elapse(DAEMON_DEFAULTS.ci_none_grace_ms + DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    expect(h.openDecisions()).toEqual([]);
    expect(h.events.filter((e) => e.type === "pr_conflicting")).toHaveLength(1);
    expect(h.spawns.filter((s) => s.role === "rebase")).toHaveLength(1);
  });

  it("the update step's own head still CONFLICTING: no second update, the owner is asked after the grace", async () => {
    await conflicting();
    h.world.ancestor[`${H1}..${H2}`] = true;
    await h.finish("rebase", { head: H2 });
    expect(h.spawns.filter((s) => s.role === "rebase")).toHaveLength(1);
    expect(h.events.filter((e) => e.type === "pr_conflicting")).toHaveLength(1);
    expect(h.openDecisions()).toEqual([]);
    // Its head waits under the no-CI clock like any other; past the grace, one decision opens.
    h.elapse(DAEMON_DEFAULTS.ci_none_grace_ms + DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    const open = h.openDecisions();
    expect(open).toHaveLength(1);
    expect(open[0]?.question).toContain("still conflicts with release/w1");
    expect(h.spawns.filter((s) => s.role === "rebase")).toHaveLength(1);
    expect(h.events.filter((e) => e.type === "pr_conflicting")).toHaveLength(1);
  });

  it("under branch_update: rebase the step's .volley/rebase.md says the PR conflicts too", async () => {
    await conflicting("rebase");
    const md = h.spawns.find((s) => s.role === "rebase")?.files["rebase.md"] as string;
    expect(md).toContain("git rebase origin/release/w1");
    expect(md).toContain("conflicts with `release/w1`");
  });

  it("UNKNOWN (GitHub still computing) is pending, re-polled: no clock, no decision", async () => {
    h = pipelineHarness();
    await h.start();
    h.openPr(H1);
    const pr = h.world.prs[0];
    if (pr !== undefined) pr.mergeable = "UNKNOWN";
    await h.finish("implementer", { head: H1 });
    h.elapse(DAEMON_DEFAULTS.ci_none_grace_ms + DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    expect(h.openDecisions()).toEqual([]);
    expect(h.events.some((e) => e.type === "pr_conflicting")).toBe(false);
    expect(h.spawns.some((s) => s.role === "rebase")).toBe(false);
    // Once it is computed as CONFLICTING, the update step starts.
    if (pr !== undefined) pr.mergeable = "CONFLICTING";
    await recheck();
    expect(h.events.filter((e) => e.type === "pr_conflicting")).toHaveLength(1);
    expect(h.spawns.filter((s) => s.role === "rebase")).toHaveLength(1);
    expect(h.task()?.why_waiting).toBe("PR conflicts with release/w1, updating");
  });
});
