import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

describe("volleyd validate: the release branch", () => {
  let dir: string;
  let repo: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "volleyd-validate-")));
    repo = join(dir, "repo");
    mkdirSync(repo);
    git(repo, "init", "--quiet", "-b", "main");
    git(
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "init",
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const waveFile = (repoPath: string) => {
    const file = join(dir, "w.yaml");
    writeFileSync(
      file,
      `wave: w1\nrepo: ${repoPath}\nrelease_branch: release/x\nmodel: claude-opus-5-5\npipeline: [implement]\ntasks:\n  T1: { issue: 1 }\n`,
    );
    return file;
  };

  it("neither release/x nor origin/release/x → RELEASE_BRANCH_MISSING, exit 1", async () => {
    const r = await runCli(["validate", waveFile(repo)]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(
      `RELEASE_BRANCH_MISSING: ${repo} has neither release/x nor origin/release/x — push it first`,
    );
  });

  it("only origin/release/x (pushed from another clone) is enough", async () => {
    git(repo, "update-ref", "refs/remotes/origin/release/x", "HEAD");
    const r = await runCli(["validate", waveFile(repo)]);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
  });

  it("the local branch is enough", async () => {
    git(repo, "branch", "release/x");
    expect((await runCli(["validate", waveFile(repo)])).exitCode).toBe(0);
  });

  it("a repo that is not on this machine is noted, not refused (the daemon checks it at run)", async () => {
    const r = await runCli(["validate", waveFile(join(dir, "elsewhere"))]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("release branch not checked");
  });
});
