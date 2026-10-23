import { describe, expect, it } from "vitest";
import { mergeArgv, mergePr, mergeTrain, trainMergeArgv } from "../src/autopilot/merge";
import { mintMergeToken, mintTrainToken } from "../src/fence";
import { fakeExec } from "./helpers/fake-exec";

const H = "c".repeat(40);
const M = "d".repeat(40);
/** The PR as the gate left it: open, at H, into the token's release branch. */
const OPEN = JSON.stringify({ state: "OPEN", headRefOid: H, baseRefName: "release/w" });
const PRE = ["gh", "pr", "view", "7", "--json", "baseRefName,headRefOid,isDraft,state"];

const token = mintMergeToken({
  wave: "w",
  task: "T1",
  pr: 7,
  head: H,
  release_branch: "release/w",
});

describe("autopilot merge (the one module that builds gh pr merge)", () => {
  it("builds exactly the fenced argv", () => {
    expect(mergeArgv(token, false)).toEqual([
      "gh",
      "pr",
      "merge",
      "7",
      "--squash",
      "--match-head-commit",
      H,
    ]);
    expect(mergeArgv(token, true).at(-1)).toBe("--delete-branch");
  });

  it("merges with the token, then reads the merge commit back", async () => {
    const f = fakeExec()
      .on(["gh", "pr", "view"], {
        stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: M } }),
      })
      .on(PRE, { stdout: OPEN });
    const r = await mergePr(f.exec, token, "/wt");
    expect(r).toEqual({ ok: true, merge_sha: M });
    expect(f.argvs()).toEqual([
      PRE,
      ["gh", "pr", "merge", "7", "--squash", "--match-head-commit", H],
      ["gh", "pr", "view", "7", "--json", "mergeCommit,state"],
    ]);
    expect(f.calls[1]?.opts).toMatchObject({ merge: token, cwd: "/wt" });
  });

  it("a merge GitHub reports but whose commit cannot be read back is ok with a null sha", async () => {
    const f = fakeExec()
      .on(["gh", "pr", "view"], { code: 1, stderr: "rate limited" })
      .on(PRE, { stdout: OPEN });
    expect(await mergePr(f.exec, token)).toEqual({ ok: true, merge_sha: null });
  });

  it("a refused merge returns gh's stderr and reads nothing back", async () => {
    const f = fakeExec().on(PRE, { stdout: OPEN }).on(["gh", "pr", "merge"], {
      code: 1,
      stderr: "GraphQL: Head branch was modified. Review and try the merge again.",
    });
    const r = await mergePr(f.exec, token);
    expect(r).toEqual({
      ok: false,
      reason: "head_moved",
      stderr: "GraphQL: Head branch was modified. Review and try the merge again.",
    });
    expect(f.calls).toHaveLength(2);
  });
});

describe("autopilot merge classifies a refusal (#311)", () => {
  const refused = async (stderr: string) => {
    const f = fakeExec().on(PRE, { stdout: OPEN }).on(["gh", "pr", "merge"], { code: 1, stderr });
    return mergePr(f.exec, token);
  };
  it("required checks → checks: nothing about the release branch", async () => {
    const stderr = "Pull request is not mergeable: required checks";
    expect(await refused(stderr)).toEqual({ ok: false, reason: "checks", stderr });
  });
  it("out of date or conflicting → behind", async () => {
    for (const stderr of [
      "Pull request is not mergeable: the head branch is out of date",
      "Pull request is not mergeable: the merge commit cannot be cleanly created (conflicts)",
    ])
      expect(await refused(stderr)).toMatchObject({ ok: false, reason: "behind" });
  });
  it("the base branch moved during the merge → behind", async () => {
    const stderr = "GraphQL: Base branch was modified. Review and try the merge again.";
    expect(await refused(stderr)).toEqual({ ok: false, reason: "behind", stderr });
  });
  it("--match-head-commit refused → head_moved", async () => {
    const stderr = "GraphQL: Head sha didn't match expected head sha (match-head-commit)";
    expect(await refused(stderr)).toEqual({ ok: false, reason: "head_moved", stderr });
  });
  it("GitHub's own wording for reviews, status checks and rulesets → checks", async () => {
    for (const stderr of [
      "GraphQL: At least 1 approving review is required by reviewers with write access. (mergePullRequest)",
      'GraphQL: Required status check "ci" is expected. (mergePullRequest)',
      'GraphQL: Repository rule violations found\n\nRequired status check "ci" is expected.',
      "GraphQL: Changes must be made through a pull request. Protected branch rules not satisfied.",
    ])
      expect(await refused(stderr)).toEqual({ ok: false, reason: "checks", stderr });
  });
  it("a check whose name holds 'conflict' or 'behind' is still checks", async () => {
    for (const stderr of [
      'GraphQL: Required status check "merge-conflict-scan" is expected. (mergePullRequest)',
      'GraphQL: Required status check "not-behind-guard" is expected. (mergePullRequest)',
    ])
      expect(await refused(stderr)).toEqual({ ok: false, reason: "checks", stderr });
  });
  it("only double-quoted text is blanked: a single-quoted check name holding 'conflict' reads as behind (fails safe)", async () => {
    const stderr = "GraphQL: Required status check 'merge-conflict-scan' is expected.";
    expect(await refused(stderr)).toEqual({ ok: false, reason: "behind", stderr });
  });
  it("closed or merged, in any case → closed", async () => {
    for (const stderr of [
      "GraphQL: Pull request is closed (mergePullRequest)",
      "GraphQL: Pull Request is already merged",
      "Pull request #7 is MERGED",
      "Pull request #7 is Closed",
    ])
      expect(await refused(stderr)).toEqual({ ok: false, reason: "closed", stderr });
  });
  it("a draft PR → draft (#408)", async () => {
    const stderr = "GraphQL: Pull Request is still a draft (mergePullRequest)";
    expect(await refused(stderr)).toEqual({ ok: false, reason: "draft", stderr });
  });
  it("anything else → unknown", async () => {
    expect(await refused("GraphQL: something odd")).toMatchObject({ reason: "unknown" });
  });
  it("the pre-merge read: head moved, retargeted, closed, unreadable", async () => {
    const pre = async (stdout: string, code = 0) =>
      mergePr(fakeExec().on(PRE, { stdout, code, stderr: "rate limited" }).exec, token);
    const view = (v: object) =>
      JSON.stringify({ state: "OPEN", headRefOid: H, baseRefName: "release/w", ...v });
    expect(await pre(view({ headRefOid: M }))).toEqual({
      ok: false,
      reason: "head_moved",
      stderr: `not merged: PR #7 head is ${M}, not the gated ${H}`,
    });
    expect(await pre(view({ baseRefName: "main" }))).toMatchObject({ reason: "retargeted" });
    expect(await pre(view({ state: "CLOSED" }))).toMatchObject({ reason: "closed" });
    expect(await pre(view({ isDraft: true }))).toEqual({
      ok: false,
      reason: "draft",
      stderr: "not merged: PR #7 is still a draft",
    });
    expect(await pre("", 1)).toMatchObject({ reason: "unknown" });
  });
});

describe("autopilot merge re-reads the PR before merging", () => {
  it("refuses, without merging, a PR retargeted away from the token's release branch", async () => {
    const f = fakeExec().on(["gh", "pr", "view"], {
      stdout: JSON.stringify({ state: "OPEN", headRefOid: H, baseRefName: "main" }),
    });
    const r = await mergePr(f.exec, token, "/wt");
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.stderr).toContain("main");
    expect(f.argvs(["gh", "pr", "merge"])).toEqual([]);
  });

  it("refuses, without merging, a PR whose head moved since the gate", async () => {
    const f = fakeExec().on(["gh", "pr", "view"], {
      stdout: JSON.stringify({ state: "OPEN", headRefOid: M, baseRefName: "release/w" }),
    });
    const r = await mergePr(f.exec, token);
    expect(r.ok).toBe(false);
    expect(f.argvs(["gh", "pr", "merge"])).toEqual([]);
  });

  it("refuses, without merging, a draft PR (#408)", async () => {
    const f = fakeExec().on(["gh", "pr", "view"], {
      stdout: JSON.stringify({ ...JSON.parse(OPEN), isDraft: true }),
    });
    expect(await mergePr(f.exec, token)).toMatchObject({ ok: false, reason: "draft" });
    expect(f.argvs(["gh", "pr", "merge"])).toEqual([]);
  });

  it("refuses, without merging, when the PR cannot be read", async () => {
    const f = fakeExec().on(["gh", "pr", "view"], { code: 1, stderr: "rate limited" });
    const r = await mergePr(f.exec, token);
    expect(r).toMatchObject({ ok: false });
    expect(f.argvs(["gh", "pr", "merge"])).toEqual([]);
  });
});

describe("autopilot merge: the merge train's merge commit", () => {
  const T = "e".repeat(40);
  const TPRE = ["gh", "pr", "view", "9", "--json", "baseRefName,headRefOid,isDraft,state"];
  const TOPEN = JSON.stringify({ state: "OPEN", headRefOid: T, baseRefName: "release/w" });
  const train = mintTrainToken({
    train: "train-1",
    pr: 9,
    head: T,
    release_branch: "release/w",
    members: [
      { task: "T1", head: H },
      { task: "T2", head: M },
    ],
  });

  it("builds exactly the fenced merge-commit argv", () => {
    expect(trainMergeArgv(train)).toEqual([
      "gh",
      "pr",
      "merge",
      "9",
      "--merge",
      "--match-head-commit",
      T,
    ]);
  });

  it("merges with the train token, then reads the merge commit back", async () => {
    const f = fakeExec()
      .on(["gh", "pr", "view"], {
        stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: M } }),
      })
      .on(TPRE, { stdout: TOPEN });
    expect(await mergeTrain(f.exec, train, "/wt")).toEqual({ ok: true, merge_sha: M });
    expect(f.argvs()).toEqual([
      TPRE,
      ["gh", "pr", "merge", "9", "--merge", "--match-head-commit", T],
      ["gh", "pr", "view", "9", "--json", "mergeCommit,state"],
    ]);
    expect(f.calls[1]?.opts).toMatchObject({ train, cwd: "/wt" });
    expect(f.calls[1]?.opts).not.toHaveProperty("merge");
  });

  for (const [what, pr, reason] of [
    ["retargeted", { state: "OPEN", headRefOid: T, baseRefName: "main" }, "retargeted"],
    ["moved", { state: "OPEN", headRefOid: H, baseRefName: "release/w" }, "head_moved"],
    ["closed", { state: "CLOSED", headRefOid: T, baseRefName: "release/w" }, "closed"],
  ] as const) {
    it(`refuses a ${what} train PR before merging`, async () => {
      const f = fakeExec().on(TPRE, { stdout: JSON.stringify(pr) });
      const r = await mergeTrain(f.exec, train);
      expect(r).toMatchObject({ ok: false, reason });
      expect(f.argvs()).toEqual([TPRE]);
    });
  }

  it("a refused train merge is classified like any merge", async () => {
    const stderr = "Pull request is not mergeable: the base branch is out of date";
    const f = fakeExec().on(TPRE, { stdout: TOPEN }).on(["gh", "pr", "merge"], { code: 1, stderr });
    expect(await mergeTrain(f.exec, train)).toEqual({ ok: false, reason: "behind", stderr });
  });
});
