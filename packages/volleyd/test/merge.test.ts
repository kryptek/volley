import { describe, expect, it } from "vitest";
import { mergeArgv, mergePr } from "../src/autopilot/merge";
import { mintMergeToken } from "../src/fence";
import { fakeExec } from "./helpers/fake-exec";

const H = "c".repeat(40);
const M = "d".repeat(40);
/** The PR as the gate left it: open, at H, into the token's release branch. */
const OPEN = JSON.stringify({ state: "OPEN", headRefOid: H, baseRefName: "release/w" });
const PRE = ["gh", "pr", "view", "7", "--json", "baseRefName,headRefOid,state"];

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
      stderr: "GraphQL: Head branch was modified. Review and try the merge again.",
    });
    expect(f.calls).toHaveLength(2);
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

  it("refuses, without merging, when the PR cannot be read", async () => {
    const f = fakeExec().on(["gh", "pr", "view"], { code: 1, stderr: "rate limited" });
    const r = await mergePr(f.exec, token);
    expect(r).toMatchObject({ ok: false });
    expect(f.argvs(["gh", "pr", "merge"])).toEqual([]);
  });
});
