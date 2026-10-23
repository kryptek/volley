import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ArtifactSpec,
  artifactOutcome,
  checkRebase,
  isInfraFailure,
  missingCloses,
  prFiles,
  probeLanded,
  probeMovedHead,
  probeReleaseCi,
  probeReleaseTip,
  probeTrainHead,
  verifyArtifacts,
  verifyOperatorMerge,
} from "../src/artifacts";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import { type FakeExec, fakeExec } from "./helpers/fake-exec";
import { FIXTURES } from "./helpers/fake-host";

const HEAD = "1111111111111111111111111111111111111111";
const OTHER = "2222222222222222222222222222222222222222";
const WT = "/wt/w1/T1-implementer";
const BRANCH = "w1/T1-implementer-1";
const SPEC: ArtifactSpec = { cwd: WT, branch: BRANCH, release_branch: "release/w1" };
const fx = (name: string) => readFileSync(join(FIXTURES, name), "utf-8");

/** A repo where everything is in place: pushed, one PR for the branch, CI green on the head. */
function allGood(): FakeExec {
  return fakeExec()
    .on(["git", "-C", WT, "rev-parse", "HEAD"], { stdout: `${HEAD}\n` })
    .on(["git", "-C", WT, "rev-parse", "--verify", "--quiet"], { stdout: `${HEAD}\n` })
    .on(["gh", "pr", "list"], { stdout: fx("gh-pr-list-ok.json") })
    .on(["gh", "run", "list"], { stdout: fx("gh-run-list-green.json") });
}

describe("artifact verification", () => {
  it("an unpushed branch → artifact_missing: push", async () => {
    const fake = allGood().on(["git", "-C", WT, "rev-parse", "--verify", "--quiet"], {
      stdout: `${OTHER}\n`,
    });
    const report = await verifyArtifacts(fake.exec, SPEC);
    expect(report).toMatchObject({ kind: "missing", missing: "push" });
    expect(fake.argvs(["git", "-C", WT, "fetch"])).toEqual([
      ["git", "-C", WT, "fetch", "origin", BRANCH],
    ]);
    const out = artifactOutcome("T1", "implementer", report);
    expect(out.kind).toBe("missing");
    expect(out.kind === "missing" && out.event).toMatchObject({
      type: "alarm_raised",
      task: "T1",
      data: { alarm: "artifact_missing", missing: "push", role: "implementer" },
    });

    // A branch that never reached origin at all is the same miss.
    const none = allGood().on(["git", "-C", WT, "rev-parse", "--verify", "--quiet"], {
      code: 1,
    });
    expect(await verifyArtifacts(none.exec, SPEC)).toMatchObject({ missing: "push" });
  });

  it("a PR whose headRefName is another branch is not accepted → artifact_missing: pr", async () => {
    const fake = allGood().on(["gh", "pr", "list"], { stdout: fx("gh-pr-list-other-branch.json") });
    const report = await verifyArtifacts(fake.exec, SPEC);
    expect(report).toMatchObject({ kind: "missing", missing: "pr" });
    expect(fake.argvs(["gh", "pr", "list"])[0]).toEqual([
      "gh",
      "pr",
      "list",
      "--head",
      BRANCH,
      "--state",
      "open",
      "--json",
      "number,url,headRefName,baseRefName,headRefOid,mergeable,mergeStateStatus,isDraft,body",
    ]);
    expect(fake.calls.find((c) => c.argv[1] === "pr")?.opts.cwd).toBe(WT);
    // No CI is consulted for a PR that is not ours.
    expect(fake.argvs(["gh", "run"])).toEqual([]);
  });

  it("a PR against another base → artifact_missing: base", async () => {
    const pr = JSON.parse(fx("gh-pr-list-ok.json"));
    pr[0].baseRefName = "main";
    const fake = allGood().on(["gh", "pr", "list"], { stdout: JSON.stringify(pr) });
    expect(await verifyArtifacts(fake.exec, SPEC)).toMatchObject({
      kind: "missing",
      missing: "base",
    });
  });

  it("CI red on the head → ci_failed decision with the run url and failed jobs", async () => {
    const fake = allGood()
      .on(["gh", "run", "list"], { stdout: fx("gh-run-list-red.json") })
      .on(["gh", "run", "view"], { stdout: fx("gh-run-view-failed.json") });
    const report = await verifyArtifacts(fake.exec, SPEC);
    expect(fake.argvs(["gh", "run", "list"])[0]).toEqual([
      "gh",
      "run",
      "list",
      "--commit",
      HEAD,
      "--json",
      "databaseId,name,workflowName,status,conclusion,url,headSha,event,createdAt,workflowDatabaseId",
    ]);
    expect(report).toMatchObject({ kind: "ok", ci: { state: "red", failed_jobs: ["CI / test"] } });
    const out = artifactOutcome("T1", "implementer", report);
    expect(out.kind).toBe("ci_failed");
    if (out.kind !== "ci_failed") return;
    expect(out.decision).toMatchObject({
      kind: "ci_failed",
      task: "T1",
      pointers: { pr: "https://github.com/example/repo/pull/7" },
    });
    expect(out.decision.question).toContain("https://github.com/example/repo/actions/runs/502");
    expect(out.decision.question).toContain("CI / test");
    expect(out.decision.question).not.toMatch(/status page/);
    expect(out.data).toMatchObject({ head_sha: HEAD, run_urls: [expect.stringContaining("502")] });
  });

  it("CI red: the failed runs' logs are read once each; ci_failed carries failing_tests, log and offers fixup first", async () => {
    const fake = allGood()
      .on(["gh", "run", "list"], { stdout: fx("gh-run-list-red.json") })
      .on(["gh", "run", "view"], { stdout: fx("gh-run-view-failed.json") })
      .on(["gh", "run", "view", "502", "--log-failed"], { stdout: fx("gh-run-log-failed.txt") });
    const report = await verifyArtifacts(fake.exec, SPEC);
    expect(fake.argvs(["gh", "run", "view", "502", "--log-failed"])).toHaveLength(1);
    const out = artifactOutcome("T1", "implementer", report);
    expect(out.kind).toBe("ci_failed");
    if (out.kind !== "ci_failed") return;
    expect(out.decision.options).toEqual(["fixup", "re-verify", "cancel"]);
    expect(out.decision.question).toMatch(/fixup: a fixup agent/);
    expect(out.data.failing_tests).toEqual([
      "test/pipeline.test.ts > pipeline: the default sequence > implement then merge_ready",
      "test/clock.test.ts > sleep > resolves on abort",
    ]);
    expect(out.data.log).toContain("AssertionError: expected 1 to be 2");
    expect(out.data.ci_runs).toEqual(report.kind === "ok" ? report.ci.runs : []);
  });

  it("CI red on two runs: each run's log is headed by its name", async () => {
    const [one] = JSON.parse(fx("gh-run-list-red.json")) as Record<string, unknown>[];
    const two = { ...one, databaseId: 503, name: "Lint", workflowName: "Lint" };
    const fake = allGood()
      .on(["gh", "run", "list"], { stdout: JSON.stringify([one, two]) })
      .on(["gh", "run", "view"], { stdout: fx("gh-run-view-failed.json") })
      .on(["gh", "run", "view", "502", "--log-failed"], { stdout: "first log\n" })
      .on(["gh", "run", "view", "503", "--log-failed"], { stdout: "second log\n" });
    const out = artifactOutcome("T1", "implementer", await verifyArtifacts(fake.exec, SPEC));
    const log = out.kind === "ci_failed" ? String(out.data.log) : "";
    expect(log).toBe("== CI (run 502) ==\nfirst log\n== Lint (run 503) ==\nsecond log");
  });

  it("a red report's log is clipped to its tail; a green report reads no log and is unchanged", async () => {
    const long = `${"x".repeat(DAEMON_DEFAULTS.ci_log_max_chars)}\nthe last line\n`;
    const red = allGood()
      .on(["gh", "run", "list"], { stdout: fx("gh-run-list-red.json") })
      .on(["gh", "run", "view"], { stdout: fx("gh-run-view-failed.json") })
      .on(["gh", "run", "view", "502", "--log-failed"], { stdout: long });
    const out = artifactOutcome("T1", "implementer", await verifyArtifacts(red.exec, SPEC));
    const log = out.kind === "ci_failed" ? String(out.data.log) : "";
    expect(log.length).toBeLessThanOrEqual(DAEMON_DEFAULTS.ci_log_max_chars);
    expect(log).toMatch(/the last line$/);

    const green = allGood();
    const report = await verifyArtifacts(green.exec, SPEC);
    // A green head's jobs are read for their durations (#415), never its logs.
    expect(green.argvs(["gh", "run", "view"])).toEqual([
      ["gh", "run", "view", "501", "--json", "jobs"],
    ]);
    expect(report.kind === "ok" && report.ci).not.toHaveProperty("log");
    expect(report.kind === "ok" && report.ci).not.toHaveProperty("failing_tests");
  });

  it("an infra-shaped failure says to check the hosting provider's status page first", async () => {
    const fake = allGood()
      .on(["gh", "run", "list"], { stdout: fx("gh-run-list-red.json") })
      .on(["gh", "run", "view"], { stdout: fx("gh-run-view-infra.json") });
    const out = artifactOutcome("T1", "implementer", await verifyArtifacts(fake.exec, SPEC));
    expect(out.kind === "ci_failed" && out.decision.question).toMatch(
      /check the hosting provider's status page first/,
    );
    expect(out.kind === "ci_failed" && out.data).toMatchObject({
      infra: true,
      infra_reason: "steps",
    });
  });

  it("isInfraFailure names the reason: startup, steps, cancelled, or null", () => {
    expect(isInfraFailure([{ conclusion: "startup_failure" }], [])).toBe("startup");
    expect(
      isInfraFailure([{ conclusion: "failure" }], [{ name: "test", steps: ["Checkout"] }]),
    ).toBe("steps");
    expect(isInfraFailure([{ conclusion: "cancelled" }], [])).toBe("cancelled");
    // Cancelled during checkout is still a cancel, not an outage.
    expect(
      isInfraFailure([{ conclusion: "cancelled" }], [{ name: "test", steps: ["Checkout"] }]),
    ).toBe("cancelled");
    // A real failure beside a cancel: a re-run of the cancelled one cannot turn the head green.
    expect(
      isInfraFailure(
        [{ conclusion: "cancelled" }, { conclusion: "failure" }],
        [{ name: "test", steps: ["Run tests"] }],
      ),
    ).toBeNull();
    expect(
      isInfraFailure([{ conclusion: "failure" }], [{ name: "test", steps: ["Run tests"] }]),
    ).toBeNull();
  });

  it("CI still running (or no run yet) → pending; nothing is journaled", async () => {
    const running = JSON.parse(fx("gh-run-list-green.json"));
    running[0].status = "in_progress";
    running[0].conclusion = "";
    const fake = allGood().on(["gh", "run", "list"], { stdout: JSON.stringify(running) });
    const report = await verifyArtifacts(fake.exec, SPEC);
    expect(report).toMatchObject({ kind: "ok", ci: { state: "running" } });
    expect(artifactOutcome("T1", "implementer", report).kind).toBe("ci_pending");
    const none = allGood().on(["gh", "run", "list"], { stdout: "[]" });
    expect(await verifyArtifacts(none.exec, SPEC)).toMatchObject({ ci: { state: "none" } });
  });

  it("a CONFLICTING PR with no run → conflicting (GitHub runs no CI on it); UNKNOWN → pending, running", async () => {
    const withMergeable = (mergeable: string) => {
      const pr = JSON.parse(fx("gh-pr-list-ok.json"));
      pr[0].mergeable = mergeable;
      pr[0].mergeStateStatus = mergeable === "CONFLICTING" ? "DIRTY" : "UNKNOWN";
      return allGood()
        .on(["gh", "pr", "list"], { stdout: JSON.stringify(pr) })
        .on(["gh", "run", "list"], { stdout: "[]" });
    };
    const report = await verifyArtifacts(withMergeable("CONFLICTING").exec, SPEC);
    expect(report).toMatchObject({
      kind: "ok",
      pr: { number: 7, mergeable: "CONFLICTING", merge_state: "DIRTY" },
      ci: { state: "none" },
    });
    expect(artifactOutcome("T1", "implementer", report)).toEqual({
      kind: "conflicting",
      head: HEAD,
      pr: { number: 7, url: "https://github.com/example/repo/pull/7" },
    });
    // Still computing: the head is pending, as if CI ran (no no-CI clock).
    const unknown = await verifyArtifacts(withMergeable("UNKNOWN").exec, SPEC);
    expect(unknown).toMatchObject({ pr: { mergeable: "UNKNOWN" }, ci: { state: "running" } });
    expect(artifactOutcome("T1", "implementer", unknown)).toEqual({
      kind: "ci_pending",
      state: "running",
      head: HEAD,
    });
    // A conflicting head CI did run on is judged by its CI, as before.
    const green = JSON.parse(fx("gh-pr-list-ok.json"));
    green[0].mergeable = "CONFLICTING";
    const ran = allGood().on(["gh", "pr", "list"], { stdout: JSON.stringify(green) });
    expect(artifactOutcome("T1", "implementer", await verifyArtifacts(ran.exec, SPEC)).kind).toBe(
      "verified",
    );
  });

  it("all good → artifact_verified journaled with the sha, PR and run links", async () => {
    const report = await verifyArtifacts(allGood().exec, SPEC);
    const out = artifactOutcome("T1", "implementer", report);
    expect(out.kind).toBe("verified");
    expect(out.kind === "verified" && out.event).toEqual({
      type: "artifact_verified",
      task: "T1",
      data: {
        role: "implementer",
        head_sha: HEAD,
        branch: BRANCH,
        pr: {
          number: 7,
          url: "https://github.com/example/repo/pull/7",
          head_sha: HEAD,
          ci: "green",
        },
        ci_runs: [
          {
            id: 501,
            name: "CI",
            status: "completed",
            conclusion: "success",
            url: "https://github.com/example/repo/actions/runs/501",
          },
        ],
      },
    });
  });

  it("with `since` (after a rebase) the report lists the files the new head changed", async () => {
    const fake = allGood().on(["git", "-C", WT, "diff", "--name-only"], {
      stdout: "src/a.ts\nsrc/b.ts\n",
    });
    const report = await verifyArtifacts(fake.exec, { ...SPEC, since: OTHER });
    expect(fake.argvs(["git", "-C", WT, "diff"])).toEqual([
      ["git", "-C", WT, "diff", "--name-only", OTHER, HEAD],
    ]);
    const out = artifactOutcome("T1", "rebase", report);
    expect(out.kind === "verified" && out.event.data.touched).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("draft PRs: the CI that starts once marked ready (#408)", () => {
  const READY_AT = "2026-10-22T10:00:00.000Z";
  const pr = (v: object) => JSON.stringify([{ ...JSON.parse(fx("gh-pr-list-ok.json"))[0], ...v }]);
  const run = (id: number, createdAt: string, v: object = {}) => ({
    databaseId: id,
    name: "CI",
    workflowName: "CI",
    workflowDatabaseId: 9,
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    headSha: HEAD,
    createdAt,
    url: `https://github.com/example/repo/actions/runs/${id}`,
    ...v,
  });
  const ready = { ...SPEC, ready: { head: HEAD, at: READY_AT } };

  it("a draft PR is reported as one; a ready one is not", async () => {
    const draft = await verifyArtifacts(
      allGood().on(["gh", "pr", "list"], { stdout: pr({ isDraft: true }) }).exec,
      SPEC,
    );
    expect(draft).toMatchObject({ kind: "ok", pr: { draft: true } });
    const open = await verifyArtifacts(
      allGood().on(["gh", "pr", "list"], { stdout: pr({ isDraft: false }) }).exec,
      SPEC,
    );
    expect(open.kind === "ok" && "draft" in open.pr).toBe(false);
  });

  it("marked ready: a green run created before it is not the gate's CI → running", async () => {
    const fake = allGood().on(["gh", "run", "list"], {
      stdout: JSON.stringify([run(501, "2026-10-22T09:50:00Z")]),
    });
    const report = await verifyArtifacts(fake.exec, ready);
    expect(report).toMatchObject({ kind: "ok", ci: { state: "running" } });
    expect(artifactOutcome("T1", "implementer", report)).toMatchObject({
      kind: "ci_pending",
      state: "running",
    });
  });

  it("marked ready: a run created a few seconds before the mark by GitHub's clock counts (skew)", async () => {
    const skewed = new Date(
      Date.parse(READY_AT) - DAEMON_DEFAULTS.ready_skew_ms + 5_000,
    ).toISOString();
    const fake = allGood().on(["gh", "run", "list"], {
      stdout: JSON.stringify([run(502, skewed), run(501, "2026-10-22T09:50:00Z")]),
    });
    expect(await verifyArtifacts(fake.exec, ready)).toMatchObject({ ci: { state: "green" } });
  });

  it("marked ready: the run created after it supersedes the draft's run and is gated on", async () => {
    const runs = (post: object) =>
      JSON.stringify([run(502, "2026-10-22T10:00:05Z", post), run(501, "2026-10-22T09:50:00Z")]);
    const running = allGood().on(["gh", "run", "list"], {
      stdout: runs({ status: "in_progress", conclusion: null }),
    });
    expect(await verifyArtifacts(running.exec, ready)).toMatchObject({ ci: { state: "running" } });
    const red = allGood()
      .on(["gh", "run", "list"], { stdout: runs({ conclusion: "failure" }) })
      .on(["gh", "run", "view"], { stdout: JSON.stringify({ jobs: [] }) });
    expect(await verifyArtifacts(red.exec, ready)).toMatchObject({ ci: { state: "red" } });
    const green = await verifyArtifacts(
      allGood().on(["gh", "run", "list"], { stdout: runs({}) }).exec,
      ready,
    );
    expect(green).toMatchObject({ ci: { state: "green", runs: [{ id: 502 }] } });
    expect(green.kind === "ok" && green.ci.superseded.map((r) => r.id)).toEqual([501]);
  });

  it("a mark on another head says nothing about this one", async () => {
    const fake = allGood().on(["gh", "run", "list"], {
      stdout: JSON.stringify([run(501, "2026-10-22T09:50:00Z")]),
    });
    const report = await verifyArtifacts(fake.exec, {
      ...SPEC,
      ready: { head: OTHER, at: READY_AT },
    });
    expect(report).toMatchObject({ ci: { state: "green" } });
  });
});

describe("superseded runs (latest run per workflow and trigger event wins)", () => {
  const ids = (runs: { id: number }[]) => runs.map((r) => r.id);

  it("a cancelled run replaced by a green run of the same workflow and event → verified", async () => {
    const fake = allGood().on(["gh", "run", "list"], { stdout: fx("gh-run-list-superseded.json") });
    const report = await verifyArtifacts(fake.exec, SPEC);
    expect(report.kind).toBe("ok");
    if (report.kind !== "ok") return;
    expect(report.ci.state).toBe("green");
    expect(ids(report.ci.runs)).toEqual([602]);
    expect(report.ci.superseded).toEqual([
      {
        id: 601,
        url: "https://github.com/example/repo/actions/runs/601",
        conclusion: "cancelled",
      },
    ]);
    // A superseded run's jobs are never looked at.
    expect(fake.argvs(["gh", "run", "view"])).toEqual([
      ["gh", "run", "view", "602", "--json", "jobs"],
    ]);
    const out = artifactOutcome("T1", "implementer", report);
    expect(out.kind).toBe("verified");
    if (out.kind !== "verified") return;
    expect(ids(out.event.data.ci_runs as { id: number }[])).toEqual([602]);
    expect(out.event.data.ci_superseded).toEqual(report.ci.superseded);
  });

  it("a cancelled run nothing replaced stays red, and says to re-run it (no status page)", async () => {
    // Cancelled early, in checkout: still a cancel, not an outage.
    const cancelledInCheckout = {
      jobs: [
        {
          name: "test",
          conclusion: "cancelled",
          steps: [{ name: "Checkout", conclusion: "cancelled" }],
        },
      ],
    };
    const fake = allGood()
      .on(["gh", "run", "list"], { stdout: fx("gh-run-list-cancelled-only.json") })
      .on(["gh", "run", "view"], { stdout: JSON.stringify(cancelledInCheckout) });
    const report = await verifyArtifacts(fake.exec, SPEC);
    expect(report).toMatchObject({ kind: "ok", ci: { state: "red", superseded: [] } });
    const out = artifactOutcome("T1", "implementer", report);
    expect(out.kind).toBe("ci_failed");
    if (out.kind !== "ci_failed") return;
    expect(out.decision.question).toContain(
      "Run https://github.com/example/repo/actions/runs/601 was cancelled and nothing replaced it: re-run it (or push again). volleyd never re-runs CI. fixup: a fixup agent at",
    );
    expect(out.decision.question).not.toMatch(/status page/);
    expect(out.data).toMatchObject({ infra: true, infra_reason: "cancelled" });
  });

  it("a different trigger event is not a replacement: push green + pull_request failed → red", async () => {
    const fake = allGood()
      .on(["gh", "run", "list"], { stdout: fx("gh-run-list-push-and-pr.json") })
      .on(["gh", "run", "view"], { stdout: fx("gh-run-view-failed.json") });
    const report = await verifyArtifacts(fake.exec, SPEC);
    expect(report).toMatchObject({ kind: "ok", ci: { state: "red", superseded: [] } });
    if (report.kind !== "ok") return;
    expect(ids(report.ci.runs).sort()).toEqual([603, 604]);
  });

  it("a superseded run still cancelling never makes the state running", async () => {
    const runs = JSON.parse(fx("gh-run-list-superseded.json"));
    runs[1].status = "in_progress";
    runs[1].conclusion = "";
    const fake = allGood().on(["gh", "run", "list"], { stdout: JSON.stringify(runs) });
    const report = await verifyArtifacts(fake.exec, SPEC);
    expect(report).toMatchObject({ kind: "ok", ci: { state: "green" } });
    if (report.kind !== "ok") return;
    expect(report.ci.superseded).toEqual([
      { id: 601, url: "https://github.com/example/repo/actions/runs/601", conclusion: null },
    ]);
  });

  it("runs without a workflow id group by workflow name", async () => {
    const runs = JSON.parse(fx("gh-run-list-superseded.json"));
    for (const r of runs) r.workflowDatabaseId = undefined;
    const fake = allGood().on(["gh", "run", "list"], { stdout: JSON.stringify(runs) });
    expect(await verifyArtifacts(fake.exec, SPEC)).toMatchObject({ ci: { state: "green" } });
  });
});

describe("unreadable CI is unknown, never `none` (#310)", () => {
  const RATE = "HTTP 403: API rate limit exceeded for user ID 1. (https://api.github.com/x)";

  it("a failed `gh run list` → state unknown with the error; the outcome is an unreadable hold", async () => {
    const fake = allGood().on(["gh", "run", "list"], { code: 1, stderr: `${RATE}\n` });
    const report = await verifyArtifacts(fake.exec, SPEC);
    expect(report).toMatchObject({
      kind: "ok",
      ci: { state: "unknown", runs: [], error: RATE, rate_limited: {} },
    });
    expect(artifactOutcome("T1", "implementer", report)).toEqual({
      kind: "ci_pending",
      state: "unknown",
      head: HEAD,
      unreadable: true,
      error: RATE,
    });
  });

  it("unparseable output and a failed `gh run view` are unknown too; a 502 is not a rate limit", async () => {
    const garbage = allGood().on(["gh", "run", "list"], { stdout: "<html>oops" });
    expect(await verifyArtifacts(garbage.exec, SPEC)).toMatchObject({
      ci: { state: "unknown" },
    });
    const red = JSON.parse(fx("gh-run-list-green.json"));
    red[0].conclusion = "failure";
    const view = allGood()
      .on(["gh", "run", "list"], { stdout: JSON.stringify(red) })
      .on(["gh", "run", "view"], { code: 1, stderr: "HTTP 502: Bad Gateway" });
    const report = await verifyArtifacts(view.exec, SPEC);
    expect(report).toMatchObject({ ci: { state: "unknown", error: "HTTP 502: Bad Gateway" } });
    expect(report.kind === "ok" && report.ci.rate_limited).toBeUndefined();
  });

  it("a 429 with Retry-After carries the wait", async () => {
    const fake = allGood().on(["gh", "run", "list"], {
      code: 1,
      stderr: "HTTP 429: Too Many Requests\nRetry-After: 120\n",
    });
    expect(await verifyArtifacts(fake.exec, SPEC)).toMatchObject({
      ci: { state: "unknown", rate_limited: { retry_after_ms: 120_000 } },
    });
  });

  it("with runs_via, runs are read by head_sha (one gh api GET) through the supervisor's exec", async () => {
    const api = fakeExec().on(["gh", "api"], {
      stdout: JSON.stringify([
        {
          id: 501,
          name: "CI",
          status: "completed",
          conclusion: "success",
          html_url: "https://github.com/example/repo/actions/runs/501",
          head_sha: HEAD,
          event: "pull_request",
          run_attempt: 1,
          workflow_id: 9,
        },
      ]),
    });
    const fake = allGood();
    const report = await verifyArtifacts(fake.exec, {
      ...SPEC,
      runs_via: { exec: api.exec, cwd: "/repo" },
    });
    expect(report).toMatchObject({
      kind: "ok",
      ci: {
        state: "green",
        runs: [
          {
            id: 501,
            name: "CI",
            status: "completed",
            conclusion: "success",
            url: "https://github.com/example/repo/actions/runs/501",
          },
        ],
      },
    });
    // The task's exec lists no runs (it reads their jobs, as for a failed run); the supervisor's
    // reads them in the wave repo.
    expect(fake.argvs(["gh", "run", "list"])).toEqual([]);
    const [argv] = api.argvs(["gh", "api"]);
    expect(argv?.[2]).toBe(`repos/{owner}/{repo}/actions/runs?head_sha=${HEAD}&per_page=50`);
    expect(api.calls[0]?.opts.cwd).toBe("/repo");
  });

  it("with runs_via, a 403 from gh api is unknown", async () => {
    const api = fakeExec().on(["gh", "api"], { code: 1, stderr: RATE });
    const report = await verifyArtifacts(allGood().exec, {
      ...SPEC,
      runs_via: { exec: api.exec, cwd: "/repo" },
    });
    expect(report).toMatchObject({ ci: { state: "unknown", rate_limited: {} } });
  });
});

describe("rebase check", () => {
  const TIP = "3333333333333333333333333333333333333333";
  it("current when the merge-base with origin/<release> is its tip; else behind by N", async () => {
    const current = fakeExec()
      .on(["git", "-C", WT, "rev-parse"], { stdout: `${TIP}\n` })
      .on(["git", "-C", WT, "merge-base"], { stdout: `${TIP}\n` });
    expect(
      await checkRebase(current.exec, { cwd: WT, head: HEAD, release_branch: "release/w1" }),
    ).toEqual({ release_sha: TIP, merge_base: TIP, behind: 0 });
    expect(current.argvs()).toEqual([
      ["git", "-C", WT, "fetch", "origin", "release/w1"],
      ["git", "-C", WT, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/release/w1"],
      ["git", "-C", WT, "merge-base", HEAD, TIP],
    ]);
    const behind = fakeExec()
      .on(["git", "-C", WT, "rev-parse"], { stdout: `${TIP}\n` })
      .on(["git", "-C", WT, "merge-base"], { stdout: `${OTHER}\n` })
      .on(["git", "-C", WT, "log"], { stdout: "aaa one\nbbb two\n" });
    expect(
      await checkRebase(behind.exec, { cwd: WT, head: HEAD, release_branch: "release/w1" }),
    ).toEqual({ release_sha: TIP, merge_base: OTHER, behind: 2 });
    expect(behind.argvs(["git", "-C", WT, "log"])).toEqual([
      ["git", "-C", WT, "log", "--oneline", `${OTHER}..${TIP}`],
    ]);
  });

  it("a failed fetch or log, or an empty log off the tip, throws: never counted as behind (#311)", async () => {
    const o = { cwd: WT, head: HEAD, release_branch: "release/w1" };
    const offTip = () =>
      fakeExec()
        .on(["git", "-C", WT, "rev-parse"], { stdout: `${TIP}\n` })
        .on(["git", "-C", WT, "merge-base"], { stdout: `${OTHER}\n` });
    const fetchFails = offTip().on(["git", "-C", WT, "fetch"], { code: 128, stderr: "no route" });
    await expect(checkRebase(fetchFails.exec, o)).rejects.toThrow(/fetch/);
    const logFails = offTip().on(["git", "-C", WT, "log"], { code: 128, stderr: "bad object" });
    await expect(checkRebase(logFails.exec, o)).rejects.toThrow(/log/);
    const empty = offTip().on(["git", "-C", WT, "log"], { stdout: "" });
    await expect(checkRebase(empty.exec, o)).rejects.toThrow("inconsistent rebase check");
  });
});

describe("probes from the repo root (the head worktree is gone)", () => {
  const ROOT = "/repo";
  const TIP = "3333333333333333333333333333333333333333";
  const at = { cwd: ROOT, fetch: "refs/pull/7/head" };
  it("checkRebase fetches the PR head into the repo root first, then answers as in the worktree", async () => {
    const f = fakeExec()
      .on(["git", "-C", ROOT, "rev-parse"], { stdout: `${TIP}\n` })
      .on(["git", "-C", ROOT, "merge-base"], { stdout: `${TIP}\n` });
    expect(await checkRebase(f.exec, { ...at, head: HEAD, release_branch: "release/w1" })).toEqual({
      release_sha: TIP,
      merge_base: TIP,
      behind: 0,
    });
    expect(f.argvs()).toEqual([
      ["git", "-C", ROOT, "fetch", "origin", "refs/pull/7/head"],
      ["git", "-C", ROOT, "fetch", "origin", "release/w1"],
      ["git", "-C", ROOT, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/release/w1"],
      ["git", "-C", ROOT, "merge-base", HEAD, TIP],
    ]);
  });

  it("probeLanded fetches the PR head into the repo root first; an ancestor head has landed", async () => {
    const f = fakeExec()
      .on(["git", "-C", ROOT, "rev-parse"], { stdout: `${TIP}\n` })
      .on(["git", "-C", ROOT, "merge-base", "--is-ancestor"], { code: 0 });
    expect(
      await probeLanded(f.exec, { ...at, head: HEAD, release_branch: "release/w1", pr: 7 }),
    ).toEqual({ ancestor: true, unmatched: [], subjects: [], release_sha: TIP });
    expect(f.argvs()[0]).toEqual(["git", "-C", ROOT, "fetch", "origin", "refs/pull/7/head"]);
    expect(f.argvs()).toContainEqual([
      "git",
      "-C",
      ROOT,
      "merge-base",
      "--is-ancestor",
      HEAD,
      "origin/release/w1",
    ]);
  });

  it("probeMovedHead fetches the gated head by sha when the repo root lacks it (a force-push), and not when it has it", async () => {
    const FROM = "4444444444444444444444444444444444444444";
    const moved = { ...at, branch: "b", from: FROM, to: TIP };
    const missing = fakeExec().on(["git", "-C", ROOT, "rev-parse", "--verify"], { code: 1 });
    await probeMovedHead(missing.exec, moved);
    expect(missing.argvs(["git", "-C", ROOT, "fetch"])).toContainEqual([
      "git",
      "-C",
      ROOT,
      "fetch",
      "origin",
      FROM,
    ]);
    const present = fakeExec();
    await probeMovedHead(present.exec, moved);
    expect(present.argvs(["git", "-C", ROOT, "fetch", "origin", FROM])).toEqual([]);
    // In the worktree the gated head is local: no check, no fetch.
    const wt = fakeExec();
    await probeMovedHead(wt.exec, { cwd: WT, branch: "b", from: FROM, to: TIP });
    expect(wt.argvs(["git", "-C", WT, "rev-parse"])).toEqual([]);
  });

  it("a failed PR-head fetch is named as such, not left to the next step's error", async () => {
    const failing = () =>
      fakeExec().on(["git", "-C", ROOT, "fetch", "origin", "refs/pull/7/head"], {
        code: 128,
        stderr: "fatal: couldn't find remote ref refs/pull/7/head\n",
      });
    const why =
      "git fetch origin refs/pull/7/head failed (128): fatal: couldn't find remote ref refs/pull/7/head";
    await expect(
      checkRebase(failing().exec, { ...at, head: HEAD, release_branch: "release/w1" }),
    ).rejects.toThrow(why);
    await expect(
      probeLanded(failing().exec, { ...at, head: HEAD, release_branch: "release/w1", pr: 7 }),
    ).rejects.toThrow(why);
    expect(
      await verifyOperatorMerge(failing().exec, {
        ...at,
        head: HEAD,
        sha: TIP,
        release_branch: "release/w1",
      }),
    ).toEqual({ ok: false, error: why });
  });
});

describe("moved head: a merge of the release branch only", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const X = "c".repeat(40);
  const MB = "d".repeat(40);
  /** B merges X (on the release branch) into A; the release branch changed two files since MB. */
  const releaseMerge = (moved: string) =>
    fakeExec()
      .on(["gh", "run", "list"], { stdout: fx("gh-run-list-green.json") })
      .on(["git", "-C", WT, "log", "-n", "1", "--format=%P", B], { stdout: `${A} ${X}\n` })
      .on(["git", "-C", WT, "merge-base", "--is-ancestor"], { code: 0 })
      .on(["git", "-C", WT, "merge-base", A, X], { stdout: `${MB}\n` })
      .on(["git", "-C", WT, "diff", "--name-only", A, B], { stdout: moved })
      .on(["git", "-C", WT, "diff", "--name-only", MB, X], {
        stdout: "CHANGELOG.md\nsrc/x.ts\n",
      });
  const probe = (fake: FakeExec) =>
    probeMovedHead(fake.exec, {
      cwd: WT,
      branch: BRANCH,
      from: A,
      to: B,
      release_branch: "release/w1",
    });

  it("touching only files the release branch changed → only_release", async () => {
    const fake = releaseMerge("CHANGELOG.md\n");
    const facts = await probe(fake);
    expect(facts.release_merge).toEqual({
      parent: X,
      moved_files: ["CHANGELOG.md"],
      release_files: ["CHANGELOG.md", "src/x.ts"],
      only_release: true,
    });
    expect(fake.argvs(["git", "-C", WT, "merge-base", "--is-ancestor"])).toEqual([
      ["git", "-C", WT, "merge-base", "--is-ancestor", X, "origin/release/w1"],
    ]);
    expect(fake.argvs(["git", "-C", WT, "fetch"])).toContainEqual([
      "git",
      "-C",
      WT,
      "fetch",
      "origin",
      "release/w1",
    ]);
  });

  it("a file of the PR's own in the move → not only_release", async () => {
    const facts = await probe(releaseMerge("CHANGELOG.md\nsrc/mine.ts\n"));
    expect(facts.release_merge).toMatchObject({
      moved_files: ["CHANGELOG.md", "src/mine.ts"],
      only_release: false,
    });
  });

  it("a single-parent head, or a parent off the release branch → no release_merge", async () => {
    const single = releaseMerge("CHANGELOG.md\n").on(
      ["git", "-C", WT, "log", "-n", "1", "--format=%P", B],
      { stdout: `${A}\n` },
    );
    expect((await probe(single)).release_merge).toBeUndefined();
    const elsewhere = releaseMerge("CHANGELOG.md\n").on(
      ["git", "-C", WT, "merge-base", "--is-ancestor"],
      { code: 1 },
    );
    expect((await probe(elsewhere)).release_merge).toBeUndefined();
    // The gated head is not a parent: not a merge into the PR as it was.
    const other = releaseMerge("CHANGELOG.md\n").on(
      ["git", "-C", WT, "log", "-n", "1", "--format=%P", B],
      { stdout: `${MB} ${X}\n` },
    );
    expect((await probe(other)).release_merge).toBeUndefined();
  });
});

describe("probeReleaseCi", () => {
  const RELEASE = { cwd: WT, release_branch: "release/w1" };

  it("the latest run per workflow on the release branch is red: its failing tests", async () => {
    const fake = fakeExec()
      .on(["gh", "run", "list"], { stdout: fx("gh-run-list-release-red.json") })
      .on(["gh", "run", "view"], { stdout: fx("gh-run-log-failed-flake.txt") });
    expect(await probeReleaseCi(fake.exec, RELEASE)).toEqual({
      state: "red",
      failing_tests: ["test/clock.test.ts > sleep > resolves on abort"],
    });
    expect(fake.argvs(["gh", "run", "list"])[0]?.slice(0, 7)).toEqual([
      "gh",
      "run",
      "list",
      "--branch",
      "release/w1",
      "--limit",
      "20",
    ]);
    // Only the latest CI run's log is read (the older green one and Docs are not red).
    expect(fake.argvs(["gh", "run", "view"])).toEqual([
      ["gh", "run", "view", "812", "--log-failed"],
    ]);
  });

  it("green, and unreadable", async () => {
    const green = fakeExec().on(["gh", "run", "list"], { stdout: fx("gh-run-list-green.json") });
    expect(await probeReleaseCi(green.exec, RELEASE)).toEqual({
      state: "green",
      failing_tests: [],
    });
    const broken = fakeExec().on(["gh", "run", "list"], { code: 1, stderr: "HTTP 502" });
    expect(await probeReleaseCi(broken.exec, RELEASE)).toEqual({
      state: "unknown",
      failing_tests: [],
      error: "HTTP 502",
    });
    const limited = fakeExec().on(["gh", "run", "list"], {
      code: 1,
      stderr: "HTTP 403: API rate limit exceeded for user ID 1.",
    });
    expect(await probeReleaseCi(limited.exec, RELEASE)).toEqual({
      state: "unknown",
      failing_tests: [],
      error: "HTTP 403: API rate limit exceeded for user ID 1.",
      rate_limited: {},
    });
  });

  it("prFiles: the PR's changed files, null when gh fails", async () => {
    const ok = fakeExec().on(["gh", "pr", "view"], { stdout: fx("gh-pr-view-files.json") });
    expect(await prFiles(ok.exec, WT, 7)).toContain("packages/volleyd/src/pipeline.ts");
    const broken = fakeExec().on(["gh", "pr", "view"], { code: 1 });
    expect(await prFiles(broken.exec, WT, 7)).toBeNull();
  });
});

describe("a running head's jobs (#415)", () => {
  const T = "2026-10-23T10:00:00Z";
  const job = (name: string, status: string, conclusion = "") => ({
    name,
    status,
    conclusion,
    startedAt: status === "queued" ? "0001-01-01T00:00:00Z" : T,
    completedAt: status === "completed" ? "2026-10-23T10:02:00Z" : "0001-01-01T00:00:00Z",
  });
  const running = () => {
    const runs = JSON.parse(fx("gh-run-list-green.json"));
    runs[0].status = "in_progress";
    runs[0].conclusion = "";
    return JSON.stringify(runs);
  };
  const thirteen = [
    job("lint", "completed", "success"),
    job("typecheck", "completed", "success"),
    job("Unit", "completed", "success"),
    job("Frontend", "in_progress"),
    ...[1, 2, 3, 4, 5, 6].map((n) => job(`Backend IT shard ${n}/6`, "in_progress")),
    job("e2e", "in_progress"),
    job("deploy-preview", "queued"),
    job("smoke", "queued"),
  ];

  it("one run of 13 jobs: 3 completed, 8 in progress, 2 queued", async () => {
    const fake = allGood()
      .on(["gh", "run", "list"], { stdout: running() })
      .on(["gh", "run", "view", "501", "--json", "jobs"], {
        stdout: JSON.stringify({ jobs: thirteen }),
      });
    const report = await verifyArtifacts(fake.exec, SPEC);
    expect(report).toMatchObject({ kind: "ok", ci: { state: "running" } });
    if (report.kind !== "ok") return;
    const jobs = report.ci.jobs ?? [];
    expect(jobs).toHaveLength(13);
    expect(jobs.filter((j) => j.status === "completed")).toHaveLength(3);
    expect(jobs.filter((j) => j.status === "in_progress").map((j) => j.name)).toHaveLength(8);
    expect(jobs[0]).toEqual({
      workflow: "CI",
      name: "lint",
      status: "completed",
      conclusion: "success",
      started_at: T,
      completed_at: "2026-10-23T10:02:00Z",
      run_done: false,
    });
    // GitHub's zero time is no time: a queued job has no start.
    expect(jobs.at(-1)?.started_at).toBeUndefined();
  });

  it("a failed job keeps its conclusion; an unreadable jobs answer is no job facts, not unknown CI", async () => {
    const failed = allGood()
      .on(["gh", "run", "list"], { stdout: running() })
      .on(["gh", "run", "view"], {
        stdout: JSON.stringify({
          jobs: [job("lint", "completed", "failure"), job("e2e", "in_progress")],
        }),
      });
    const r = await verifyArtifacts(failed.exec, SPEC);
    expect(r.kind === "ok" && r.ci.jobs?.[0]?.conclusion).toBe("failure");
    const bad = allGood()
      .on(["gh", "run", "list"], { stdout: running() })
      .on(["gh", "run", "view"], { code: 1, stderr: "HTTP 502: Bad Gateway" });
    const u = await verifyArtifacts(bad.exec, SPEC);
    expect(u).toMatchObject({ ci: { state: "running" } });
    expect(u.kind === "ok" && u.ci.jobs).toBeUndefined();
  });

  it("a green head's jobs are read for their durations (run_done)", async () => {
    const fake = allGood().on(["gh", "run", "view", "501", "--json", "jobs"], {
      stdout: JSON.stringify({ jobs: [job("lint", "completed", "success")] }),
    });
    const r = await verifyArtifacts(fake.exec, SPEC);
    expect(r.kind === "ok" && r.ci.jobs).toEqual([
      expect.objectContaining({ name: "lint", run_done: true }),
    ]);
  });
});

describe("a bundle's Closes lines", () => {
  it("missingCloses: one `Closes #<n>` line per issue, each on its own line", () => {
    expect(missingCloses("Fixes things.\n\nCloses #310\nCloses #312\n", [310, 312])).toEqual([]);
    // GitHub closes only the first issue of a shared line.
    expect(missingCloses("Closes #310, #312", [310, 312])).toEqual([312]);
    expect(missingCloses("closes #310\r\n  Closes #3120", [310, 312])).toEqual([312]);
    expect(missingCloses("", [310, 312])).toEqual([310, 312]);
    expect(missingCloses(undefined, [1, 2])).toEqual([1, 2]);
    // GitHub ignores closing keywords in code: an indented code block or a fence.
    expect(missingCloses("    Closes #310\n\tCloses #312", [310, 312])).toEqual([310, 312]);
    expect(missingCloses("```\nCloses #310\n```\nCloses #312", [310, 312])).toEqual([310]);
    expect(missingCloses("~~~md\nCloses #310\n~~~\n   Closes #312", [310, 312])).toEqual([310]);
  });

  it("verifyArtifacts reads the PR body with the PR", async () => {
    const pr = JSON.parse(fx("gh-pr-list-ok.json"));
    pr[0].body = "Closes #1\nCloses #2";
    const fake = allGood().on(["gh", "pr", "list"], { stdout: JSON.stringify(pr) });
    const report = await verifyArtifacts(fake.exec, SPEC);
    expect(report.kind === "ok" && report.pr.body).toBe("Closes #1\nCloses #2");
    const list = fake.argvs(["gh", "pr", "list"])[0] ?? [];
    expect(list[list.indexOf("--json") + 1]?.split(",")).toContain("body");
  });
});

describe("merge train probes (SPEC §4.6.23)", () => {
  const TIP = "3333333333333333333333333333333333333333";
  const M1 = "4444444444444444444444444444444444444444";
  const M2 = "5555555555555555555555555555555555555555";
  it("probeTrainHead: which members' gated heads the train head lacks, and whether it descends from the release sha", async () => {
    const x = fakeExec()
      .on(["git", "-C", WT, "merge-base", "--is-ancestor", M1, HEAD], { code: 0 })
      .on(["git", "-C", WT, "merge-base", "--is-ancestor", M2, HEAD], { code: 1 })
      .on(["git", "-C", WT, "merge-base", "--is-ancestor", TIP, HEAD], { code: 0 });
    expect(
      await probeTrainHead(x.exec, {
        cwd: WT,
        head: HEAD,
        release_sha: TIP,
        members: [
          { task: "T1", head: M1 },
          { task: "T2", head: M2 },
        ],
      }),
    ).toEqual({ missing: ["T2"], descends: true });
  });

  it("probeTrainHead: a member commit the worktree does not have is missing; any other failure throws", async () => {
    const unknown = fakeExec()
      .on(["git", "-C", WT, "merge-base", "--is-ancestor", M1, HEAD], {
        code: 128,
        stderr: `fatal: Not a valid commit name ${M1}`,
      })
      .on(["git", "-C", WT, "merge-base", "--is-ancestor", TIP, HEAD], { code: 1 });
    expect(
      await probeTrainHead(unknown.exec, {
        cwd: WT,
        head: HEAD,
        release_sha: TIP,
        members: [{ task: "T1", head: M1 }],
      }),
    ).toEqual({ missing: ["T1"], descends: false });
    const broken = fakeExec().on(["git", "-C", WT, "merge-base"], {
      code: 129,
      stderr: "usage",
    });
    await expect(
      probeTrainHead(broken.exec, {
        cwd: WT,
        head: HEAD,
        release_sha: TIP,
        members: [{ task: "T1", head: M1 }],
      }),
    ).rejects.toThrow(/merge-base --is-ancestor/);
  });

  it("probeReleaseTip: fetches the release branch and reads its tip; a failed fetch throws", async () => {
    const ok = fakeExec().on(["git", "-C", "/repo", "rev-parse"], { stdout: `${TIP}\n` });
    expect(await probeReleaseTip(ok.exec, { cwd: "/repo", release_branch: "release/w1" })).toBe(
      TIP,
    );
    expect(ok.argvs()).toEqual([
      ["git", "-C", "/repo", "fetch", "origin", "release/w1"],
      ["git", "-C", "/repo", "rev-parse", "--verify", "--quiet", "refs/remotes/origin/release/w1"],
    ]);
    const bad = fakeExec().on(["git", "-C", "/repo", "fetch"], { code: 128, stderr: "no route" });
    await expect(
      probeReleaseTip(bad.exec, { cwd: "/repo", release_branch: "release/w1" }),
    ).rejects.toThrow(/fetch/);
  });
});
