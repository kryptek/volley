import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GithubStatus } from "../src/autopilot/github-status";
import { CONFIG_DEFAULTS, DAEMON_DEFAULTS } from "../src/config-defaults";
import { emptyPipeline, reducePipeline } from "../src/pipeline";
import { FIXTURES } from "./helpers/fake-host";
import { type Harness, isHeadRunsRead, pipelineHarness, sha } from "./helpers/pipeline-harness";

/**
 * Self-healing CI (SPEC §4.6.16): a red head is classified before anyone is asked. The PR's own
 * change opens A2's ci_failed (fixup first); a flake journals a `fix_flake` remediation and offers
 * `fix flake`; an infra incident holds the task in CI and re-checks, and only past
 * `autopilot.incident_wait_max_s` asks the owner. Nothing is ever re-run.
 */

const H1 = sha(0x4001);
const FLAKE = "test/clock.test.ts > sleep > resolves on abort";
const fx = (name: string) => readFileSync(join(FIXTURES, name), "utf-8");
const INCIDENT: GithubStatus = {
  incident: true,
  components: [{ name: "Actions", status: "major_outage" }],
};

let h: Harness;
afterEach(() => h?.cleanup());

const ciFailed = () => h.openDecisions().find((d) => d.kind === "ci_failed");
const facts = (d: unknown) => d as Record<string, unknown>;
const events = (type: string) => h.events.filter((e) => e.type === type);

/** The implementer pushes H1 and CI fails on it with the flake fixture's log. */
async function redHead(o: { log?: string } = {}) {
  await h.start();
  h.openPr(H1);
  h.world.runLog = o.log ?? fx("gh-run-log-failed-flake.txt");
  await h.finish("implementer", { head: H1, ci: "red" });
}

describe("a red head is classified before anyone is asked", () => {
  it("own_change: a failing test's file is in the PR → ci_failed, fixup first, with the evidence", async () => {
    h = pipelineHarness();
    h.world.prFiles[7] = JSON.stringify({
      files: [{ path: "packages/volleyd/test/clock.test.ts" }, { path: "src/clock.ts" }],
    });
    await redHead();
    const d = ciFailed();
    expect(d?.options?.[0]).toBe("fixup");
    expect(facts(d).classification).toBe("own_change");
    expect(facts(d).evidence).toMatchObject({
      failing_tests: [FLAKE],
      test_files: ["test/clock.test.ts"],
      pr_files: ["packages/volleyd/test/clock.test.ts", "src/clock.ts"],
      release_ci: { state: "none" },
    });
    expect(events("remediation_requested")).toEqual([]);
    expect(h.calls.some((c) => c.includes("rerun"))).toBe(false);
  });

  it("flake: an untouched test the release branch is red on too → remediation_requested, `fix flake` offered", async () => {
    h = pipelineHarness();
    h.world.releaseRuns = fx("gh-run-list-release-red.json");
    h.world.runLogs[812] = fx("gh-run-log-failed-flake.txt");
    await redHead();
    const [req] = events("remediation_requested");
    expect(req?.task).toBe("T1");
    expect(req?.data).toMatchObject({
      kind: "fix_flake",
      test: FLAKE,
      test_file: "test/clock.test.ts",
      head: H1,
      for: "T1",
    });
    expect((req?.data.run_urls as string[]).length).toBeGreaterThan(0);
    const d = ciFailed();
    expect(d?.options).toEqual(["fix flake", "fixup", "re-verify", "cancel"]);
    expect(facts(d).classification).toBe("flake");
    expect(facts(d).evidence).toMatchObject({
      release_ci: { state: "red", failing_tests: [FLAKE] },
    });
    // The release branch was read with its own --branch run list.
    expect(
      h.calls.some((c) => c[2] === "list" && c.includes("--branch") && c.includes("release/w1")),
    ).toBe(true);
  });

  it("flake answered `fix flake`: the request stands, the task stays parked with the reason, nothing re-verifies", async () => {
    h = pipelineHarness();
    await redHead();
    const d = ciFailed();
    expect(facts(d).classification).toBe("flake");
    await h.resolve(d?.decision_id as string, "fix flake");
    expect(h.task()?.remediation).toMatchObject({ kind: "fix_flake", test: FLAKE });
    expect(h.task()?.why_waiting).toBe(`CI flake in ${FLAKE}: fixer pending`);
    const lists = h.calls.length;
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    expect(h.calls.slice(lists).some((c) => isHeadRunsRead(c) || c.includes("--branch"))).toBe(
      false,
    );
    expect(h.openDecisions()).toEqual([]);
    expect(events("remediation_requested")).toHaveLength(1);
  });

  it("flake answered `re-verify`: CI re-running is held and re-polled like any pending head, then accepted green", async () => {
    h = pipelineHarness();
    await redHead();
    const d = ciFailed();
    expect(facts(d).classification).toBe("flake");
    h.world.ci[H1] = "running";
    await h.resolve(d?.decision_id as string, "re-verify");
    expect(events("ci_pending")).toHaveLength(1);
    // The CI hold supersedes the flake: nothing waits on a fixer for a head that is not red now.
    expect(h.task()?.remediation).toBeUndefined();
    h.world.ci[H1] = "green";
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    expect(events("ci_green")).toHaveLength(1);
    expect(h.run("implementer")?.accepted).toBe(true);
    expect(h.openDecisions()).toEqual([]);
  });

  it("infra-shaped red → a ci_pending infra hold, no decision; re-verified after ci_poll_ms; budget → ci_failed escalated", async () => {
    h = pipelineHarness();
    h.world.runJobs = fx("gh-run-view-infra.json");
    await redHead({ log: "" });
    expect(h.openDecisions()).toEqual([]);
    const [hold] = events("ci_pending");
    expect(hold?.data).toMatchObject({ role: "implementer", sha: H1, reason: "infra_incident" });
    expect(typeof hold?.data.next_poll_at).toBe("string");
    expect(h.task()?.why_waiting).toMatch(/^CI infra incident: .+; re-checking$/);

    // Not re-checked before ci_poll_ms; re-checked after it, still held (no second event).
    const runLists = () => h.calls.filter(isHeadRunsRead).length;
    const before = runLists();
    await h.tick();
    expect(runLists()).toBe(before);
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    expect(runLists()).toBeGreaterThan(before);
    expect(h.openDecisions()).toEqual([]);

    // Past autopilot.incident_wait_max_s the owner is asked.
    h.elapse(CONFIG_DEFAULTS.autopilot.incident_wait_max_s * 1000);
    await h.tick();
    const d = ciFailed();
    expect(facts(d).classification).toBe("infra_incident");
    expect(d?.question).toContain("infra incident");
    expect(h.calls.some((c) => c.includes("rerun"))).toBe(false);
  });

  it("infra hold that clears: the re-check finds the head green and the hold ends", async () => {
    h = pipelineHarness();
    h.world.runJobs = fx("gh-run-view-infra.json");
    await redHead({ log: "" });
    h.world.ci[H1] = "green";
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    expect(events("ci_green")).toHaveLength(1);
    expect(h.run("implementer")?.accepted).toBe(true);
    expect(h.openDecisions()).toEqual([]);
  });

  it("a status-page incident holds the same way (own-change evidence aside)", async () => {
    h = pipelineHarness({ statusPage: INCIDENT });
    await redHead();
    expect(h.openDecisions()).toEqual([]);
    const [hold] = events("ci_pending");
    expect(hold?.data).toMatchObject({ reason: "infra_incident" });
    expect(h.task()?.why_waiting).toBe(
      "CI infra incident: GitHub Actions major_outage; re-checking",
    );
    h.elapse(CONFIG_DEFAULTS.autopilot.incident_wait_max_s * 1000 + DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    expect(facts(ciFailed()).classification).toBe("infra_incident");
  });
});

describe("an unreadable release branch read (#310) classifies nothing", () => {
  const RATE = "HTTP 403: API rate limit exceeded for user ID 1.";
  const rateAlarms = () =>
    events("alarm_raised").filter((e) => e.data.alarm === "github_rate_limited");
  const releaseReads = () =>
    h.calls.filter((c) => c[1] === "run" && c[2] === "list" && c.includes("--branch")).length;

  it("a 403 on the release read: no ci_failed, one rate-limit alarm, no CI call until retry_at; readable again → classified", async () => {
    h = pipelineHarness();
    h.world.releaseError = RATE;
    await redHead();
    expect(ciFailed()).toBeUndefined();
    expect(events("remediation_requested")).toEqual([]);
    expect(rateAlarms()).toHaveLength(1);

    // Backed off: neither the head nor the release branch is read before retry_at.
    const calls = h.calls.length;
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    expect(h.calls.slice(calls).some((c) => isHeadRunsRead(c) || c.includes("--branch"))).toBe(
      false,
    );
    expect(ciFailed()).toBeUndefined();

    // GitHub answers again: the head is re-verified and classified.
    h.world.releaseError = undefined;
    h.elapse(CONFIG_DEFAULTS.ci_rate_limit_backoff_ms);
    await h.tick();
    expect(facts(ciFailed()).classification).toBe("flake");
    expect(
      events("alarm_cleared").filter((e) => e.data.alarm === "github_rate_limited"),
    ).toHaveLength(1);
  });

  it("another failure (HTTP 502) on the release read: no decision, re-checked every ci_poll_ms", async () => {
    h = pipelineHarness();
    h.world.releaseError = "HTTP 502: Bad Gateway";
    await redHead();
    expect(ciFailed()).toBeUndefined();
    expect(rateAlarms()).toEqual([]);
    const before = releaseReads();
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    expect(releaseReads()).toBeGreaterThan(before);
    expect(ciFailed()).toBeUndefined();
  });
});

describe("a blocked agent whose reason is a failing test, on a red PR head", () => {
  it("is classified like ci_failed: the decision carries the classification and offers fix flake", async () => {
    h = pipelineHarness();
    await h.start();
    h.openPr(H1);
    h.world.origin[h.PR_BRANCH] = H1;
    h.world.ci[H1] = "red";
    h.world.runLog = fx("gh-run-log-failed-flake.txt");
    await h.block("implementer", "test/clock.test.ts is red on CI, not in my change");
    const [d] = h.openDecisions();
    expect(d?.kind).toBe("agent_blocked");
    expect(facts(d).pipeline).toMatchObject({
      on: "agent_blocked_ci",
      role: "implementer",
      head: H1,
    });
    expect(facts(d).classification).toBe("flake");
    expect(d?.options?.[0]).toBe("fix flake");
    expect(events("remediation_requested")).toHaveLength(1);
  });

  it("own change: `fixup` stops the blocked agent and starts a CI fixup at the red head", async () => {
    h = pipelineHarness();
    h.world.prFiles[7] = JSON.stringify({ files: [{ path: "test/clock.test.ts" }] });
    await h.start();
    h.openPr(H1);
    h.world.ci[H1] = "red";
    h.world.runLog = fx("gh-run-log-failed-flake.txt");
    const agent = h.run("implementer")?.agent_id;
    await h.block("implementer", "a test fails on CI: test/clock.test.ts");
    const [d] = h.openDecisions();
    expect(facts(d).classification).toBe("own_change");
    expect(d?.options?.[0]).toBe("fixup");
    await h.resolve(d?.decision_id as string, "fixup");
    expect(h.retired).toContainEqual({ agent_id: agent, status: "stopped" });
    expect(h.spawns.at(-1)?.role).toBe("fixup");
    expect(h.spawns.at(-1)?.start).toEqual({ ref: H1, detach: false });
  });

  it("flake: `fix flake` stops the blocked agent; the task parks for the fixer", async () => {
    h = pipelineHarness();
    await h.start();
    h.openPr(H1);
    h.world.ci[H1] = "red";
    h.world.runLog = fx("gh-run-log-failed-flake.txt");
    const agent = h.run("implementer")?.agent_id;
    await h.block("implementer", "test/clock.test.ts is red on CI, not in my change");
    const [d] = h.openDecisions();
    await h.resolve(d?.decision_id as string, "fix flake");
    expect(h.retired).toContainEqual({ agent_id: agent, status: "stopped" });
    expect(h.task()?.why_waiting).toBe(`CI flake in ${FLAKE}: fixer pending`);
    const spawned = h.spawns.length;
    h.elapse(DAEMON_DEFAULTS.ci_poll_ms);
    await h.tick();
    expect(h.spawns.length).toBe(spawned);
    expect(h.openDecisions()).toEqual([]);
  });

  it("two agents blocked on a red head at once: each gets its own decision", async () => {
    h = pipelineHarness();
    await h.start();
    h.openPr(H1);
    await h.finish("implementer", { head: H1, ci: "green" });
    h.world.ci[H1] = "red";
    h.world.runLog = fx("gh-run-log-failed-flake.txt");
    const block = (role: "spec_reviewer" | "quality_reviewer") => {
      const reason = "test/clock.test.ts is red on CI";
      const agent_id = h.run(role)?.agent_id as string;
      return h.driver.handle("T1", {
        kind: "agent_blocked",
        role,
        agent_id,
        reason,
        payload: { reason },
      });
    };
    await Promise.all([block("spec_reviewer"), block("quality_reviewer")]);
    await h.driver.settled();
    const roles = h
      .openDecisions()
      .filter((d) => d.kind === "agent_blocked")
      .map((d) => (facts(d).pipeline as { role: string }).role)
      .sort();
    expect(roles).toEqual(["quality_reviewer", "spec_reviewer"]);
  });

  it("infra incident: the owner's (continue, respawn or cancel); no CI hold, no policy answer", async () => {
    h = pipelineHarness({ statusPage: INCIDENT });
    await h.start();
    h.openPr(H1);
    h.world.ci[H1] = "red";
    h.world.runLog = fx("gh-run-log-failed-flake.txt");
    await h.block("implementer", "test/clock.test.ts is red on CI, not in my change");
    const [d] = h.openDecisions();
    expect(facts(d).pipeline).toMatchObject({ on: "agent_blocked_ci", head: H1 });
    expect(facts(d).classification).toBe("infra_incident");
    expect(d?.options).toEqual(["continue", "respawn", "cancel"]);
    expect(events("ci_pending")).toEqual([]);
    expect(events("remediation_requested")).toEqual([]);
  });

  it("an unreadable release branch (#310): the plain agent_blocked decision, nothing classified", async () => {
    h = pipelineHarness();
    await h.start();
    h.openPr(H1);
    h.world.origin[h.PR_BRANCH] = H1;
    h.world.ci[H1] = "red";
    h.world.runLog = fx("gh-run-log-failed-flake.txt");
    h.world.releaseError = "HTTP 502: Bad Gateway";
    await h.block("implementer", "test/clock.test.ts is red on CI, not in my change");
    const [d] = h.openDecisions();
    expect(d?.kind).toBe("agent_blocked");
    expect(facts(d).pipeline).toEqual({ on: "agent_blocked", role: "implementer" });
    expect(facts(d).classification).toBeUndefined();
    expect(events("remediation_requested")).toEqual([]);
  });

  it("a PR list entry without a number or url: the plain agent_blocked decision", async () => {
    h = pipelineHarness();
    await h.start();
    h.openPr(H1);
    h.world.ci[H1] = "red";
    h.world.runLog = fx("gh-run-log-failed-flake.txt");
    for (const pr of h.world.prs) (pr as { url?: unknown }).url = undefined;
    await h.block("implementer", "test/clock.test.ts is red on CI, not in my change");
    expect(facts(h.openDecisions()[0]).pipeline).toEqual({
      on: "agent_blocked",
      role: "implementer",
    });
  });

  it("no worktree to read the PR head from: still the plain agent_blocked decision", async () => {
    h = pipelineHarness();
    await h.start();
    h.openPr(H1);
    h.world.ci[H1] = "red";
    // The run's worktree is unknown (an agent_spawned without one).
    await h.journal({
      type: "agent_spawned",
      task: "T1",
      data: { agent_id: "w1-t1-implementer-9", role: "implementer", attempt: 9 },
    });
    await h.driver.handle("T1", {
      kind: "agent_blocked",
      role: "implementer",
      agent_id: "w1-t1-implementer-9",
      reason: "test/clock.test.ts is red on CI",
      payload: {},
    });
    await h.driver.settled();
    expect(facts(h.openDecisions()[0]).pipeline).toEqual({
      on: "agent_blocked",
      role: "implementer",
    });
  });

  it("a PR head that is not red, or a reason about something else: the plain agent_blocked decision", async () => {
    h = pipelineHarness();
    await h.start();
    h.openPr(H1);
    h.world.ci[H1] = "green";
    await h.block("implementer", "test/clock.test.ts is red on CI");
    expect(facts(h.openDecisions()[0]).pipeline).toEqual({
      on: "agent_blocked",
      role: "implementer",
    });

    h = pipelineHarness();
    await h.start();
    h.openPr(H1);
    h.world.ci[H1] = "red";
    await h.block("implementer", "needs the API key");
    expect(facts(h.openDecisions()[0]).pipeline).toEqual({
      on: "agent_blocked",
      role: "implementer",
    });
  });
});

describe("a parked flake's remediation", () => {
  it("ends when the PR head moves off the flaky head; a move from another head keeps it", () => {
    const p = emptyPipeline();
    const ev = (seq: number, type: string, data: Record<string, unknown>) =>
      reducePipeline(p, { seq, at: "", type, task: "T1", data } as never, { stages: [] });
    const flake = { kind: "fix_flake", test: FLAKE, head: H1, role: "implementer" };
    ev(1, "remediation_requested", flake);
    ev(2, "pr_head_moved", { from: sha(0x4002), to: sha(0x4003), during: "review" });
    expect(p.remediation?.head).toBe(H1);
    ev(3, "pr_head_moved", { from: H1, to: sha(0x4003), during: "review" });
    expect(p.remediation).toBeUndefined();
  });
});

describe("the flake's fix landed (SPEC §4.6.16: the fixer task merged)", () => {
  const H2 = sha(0x4002);
  const FIXER = "fix-test-clock-test-ts-sleep-resolves-on-abort";

  /** The fixer merged: volleyd journals remediation_closed releasing T1, then tells the pipeline. */
  async function landed() {
    await h.journal({
      type: "remediation_closed",
      task: FIXER,
      data: { kind: "fix_flake", test: FLAKE, outcome: "landed", released: ["T1"] },
    });
    await h.driver.handle("T1", { kind: "fix_landed", test: FLAKE });
    await h.driver.settled();
  }

  it("a parked flake enters the branch-update step at the red head, then re-verifies and continues to the reviews", async () => {
    h = pipelineHarness();
    await redHead();
    await h.resolve(ciFailed()?.decision_id as string, "fix flake");
    await landed();
    const entered = events("stage_entered").at(-1);
    expect(entered?.data).toMatchObject({
      stage: "fixup",
      roles: ["rebase"],
      rebase: true,
      fix_landed: FLAKE,
    });
    const rebase = h.spawns.at(-1);
    expect(rebase?.role).toBe("rebase");
    expect(rebase?.start).toEqual({ ref: H1, detach: false });
    // No longer waiting on a fixer.
    expect(h.task()?.remediation).toBeUndefined();
    expect(h.task()?.why_waiting).toBeUndefined();
    // The updated head is verified (CI on it) and the pipeline goes on where the flake stopped it.
    await h.finish("rebase", { head: H2, ci: "green" });
    expect(h.run("rebase")?.accepted).toBe(true);
    expect(h.spawns.filter((s) => s.role === "spec_reviewer")).toHaveLength(1);
    expect(h.spawns.find((s) => s.role === "spec_reviewer")?.start).toEqual({
      ref: H2,
      detach: true,
    });
  });

  it("an open ci_failed resolved `fix landed`: nothing re-verifies; the fix_landed step updates the branch", async () => {
    h = pipelineHarness();
    await redHead();
    const d = ciFailed();
    const lists = h.calls.length;
    await h.journal({
      type: "remediation_closed",
      task: FIXER,
      data: { kind: "fix_flake", test: FLAKE, outcome: "landed", released: ["T1"] },
    });
    // While the decision is open the task stays parked.
    await h.driver.handle("T1", { kind: "fix_landed", test: FLAKE });
    expect(events("stage_entered").some((e) => e.data.rebase === true)).toBe(false);
    await h.resolve(d?.decision_id as string, "fix landed", "volleyd");
    await h.driver.handle("T1", { kind: "fix_landed", test: FLAKE });
    await h.driver.settled();
    expect(h.calls.slice(lists).some(isHeadRunsRead)).toBe(false);
    expect(events("stage_entered").at(-1)?.data).toMatchObject({ rebase: true, fix_landed: FLAKE });
  });

  it("a fix for another test, or a remediation not released, changes nothing", async () => {
    h = pipelineHarness();
    await redHead();
    await h.resolve(ciFailed()?.decision_id as string, "fix flake");
    await h.driver.handle("T1", { kind: "fix_landed", test: "other.test.ts > x" });
    await h.driver.settled();
    expect(events("stage_entered").some((e) => e.data.rebase === true)).toBe(false);
    expect(h.task()?.remediation).toMatchObject({ test: FLAKE });
  });
});
