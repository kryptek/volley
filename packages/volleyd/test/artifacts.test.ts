import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ArtifactSpec,
  artifactOutcome,
  checkRebase,
  isInfraFailure,
  verifyArtifacts,
} from "../src/artifacts";
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
      "number,url,headRefName,baseRefName,headRefOid",
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
    expect(fake.argvs(["gh", "run", "view"])).toEqual([]);
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
      "Run https://github.com/example/repo/actions/runs/601 was cancelled and nothing replaced it: re-run it (or push again). volleyd never re-runs CI; fix or re-run it, then answer re-verify (or cancel).",
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
});
