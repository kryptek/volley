import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exec } from "../src/exec";
import { SpawnError } from "../src/spawn-error";
import { addWorktree, checkReleaseBranch, resolveReleaseBase } from "../src/worktree";
import { fakeExec } from "./helpers/fake-exec";

const REPO = "/src/repo";
const B = "release/x";
const LOCAL = ["git", "-C", REPO, "rev-parse", "--verify", "--quiet", `refs/heads/${B}`];
const ORIGIN = ["git", "-C", REPO, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${B}`];
const MISSING = { code: 1, stdout: "" };
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("release base resolution", () => {
  it("a branch only on origin: fetch, create the tracking branch, cut from it", async () => {
    const fake = fakeExec()
      .on(LOCAL, MISSING)
      .on(ORIGIN, { stdout: `${SHA_A}\n` });
    expect(await resolveReleaseBase(fake.exec, REPO, B)).toEqual({
      ref: B,
      sha: SHA_A,
      fresh: true,
    });
    expect(fake.argvs(["git", "-C", REPO, "fetch"])).toEqual([
      ["git", "-C", REPO, "fetch", "--quiet", "origin", B],
    ]);
    expect(fake.argvs(["git", "-C", REPO, "branch"])).toEqual([
      ["git", "-C", REPO, "branch", "--track", B, `origin/${B}`],
    ]);
    // fetched before anything is resolved
    const order = fake.calls.map((c) => c.argv[3]);
    expect(order.indexOf("fetch")).toBeLessThan(order.indexOf("rev-parse"));
  });

  it("the tracking branch cannot be created: cut from origin's ref", async () => {
    const fake = fakeExec()
      .on(LOCAL, MISSING)
      .on(ORIGIN, { stdout: `${SHA_A}\n` })
      .on(["git", "-C", REPO, "branch", "--track"], { code: 128, stderr: "fatal: nope" });
    expect(await resolveReleaseBase(fake.exec, REPO, B)).toMatchObject({
      ref: `origin/${B}`,
      sha: SHA_A,
    });
  });

  it("a local branch behind origin: origin's ref is used", async () => {
    const fake = fakeExec()
      .on(LOCAL, { stdout: `${SHA_A}\n` })
      .on(ORIGIN, { stdout: `${SHA_B}\n` })
      .on(["git", "-C", REPO, "merge-base", "--is-ancestor"], { code: 1 });
    expect(await resolveReleaseBase(fake.exec, REPO, B)).toMatchObject({
      ref: `origin/${B}`,
      sha: SHA_B,
    });
    // the question asked: does the local branch contain origin's commit?
    expect(fake.argvs(["git", "-C", REPO, "merge-base"])).toEqual([
      ["git", "-C", REPO, "merge-base", "--is-ancestor", SHA_B, SHA_A],
    ]);
    expect(fake.argvs(["git", "-C", REPO, "branch"])).toEqual([]);
  });

  it("a local branch diverged from origin (a stray local commit, origin's newer ones missing): origin's ref", async () => {
    // neither commit contains the other
    const fake = fakeExec()
      .on(LOCAL, { stdout: `${SHA_A}\n` })
      .on(ORIGIN, { stdout: `${SHA_B}\n` })
      .on(["git", "-C", REPO, "merge-base", "--is-ancestor", SHA_A, SHA_B], { code: 1 })
      .on(["git", "-C", REPO, "merge-base", "--is-ancestor", SHA_B, SHA_A], { code: 1 });
    expect(await resolveReleaseBase(fake.exec, REPO, B)).toMatchObject({
      ref: `origin/${B}`,
      sha: SHA_B,
    });
  });

  it("a local branch level with (or ahead of) origin is used as it is", async () => {
    const level = fakeExec()
      .on(LOCAL, { stdout: `${SHA_A}\n` })
      .on(ORIGIN, { stdout: `${SHA_A}\n` });
    expect(await resolveReleaseBase(level.exec, REPO, B)).toMatchObject({ ref: B, sha: SHA_A });
    const ahead = fakeExec()
      .on(LOCAL, { stdout: `${SHA_A}\n` })
      .on(ORIGIN, { stdout: `${SHA_B}\n` })
      .on(["git", "-C", REPO, "merge-base", "--is-ancestor", SHA_B, SHA_A], { code: 0 });
    expect(await resolveReleaseBase(ahead.exec, REPO, B)).toMatchObject({ ref: B, sha: SHA_A });
  });

  it("the fetch is bounded and never prompts (a timeout counts as a failed fetch)", async () => {
    const fake = fakeExec()
      .on(["git", "-C", REPO, "fetch"], { code: -1, timedOut: true })
      .on(LOCAL, { stdout: `${SHA_A}\n` })
      .on(ORIGIN, MISSING);
    const err = await resolveReleaseBase(fake.exec, REPO, B).catch((e: unknown) => e);
    expect((err as SpawnError).code).toBe("BASE_STALE");
    expect(await resolveReleaseBase(fake.exec, REPO, B, { requireFresh: false })).toMatchObject({
      ref: B,
      fresh: false,
    });
    const fetch = fake.calls.find((c) => c.argv[3] === "fetch");
    expect(fetch?.opts.timeoutMs).toBeGreaterThan(0);
    expect(fetch?.opts.env?.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("an empty rev-parse answer is not a commit", async () => {
    const fake = fakeExec().on(LOCAL, { stdout: "" }).on(ORIGIN, { stdout: "\n" });
    expect(await checkReleaseBranch(fake.exec, REPO, B)).toBe(
      `RELEASE_BRANCH_MISSING: ${REPO} has neither ${B} nor origin/${B} — push it first`,
    );
  });

  it("require_fresh_base on: a failed fetch refuses with BASE_STALE, never the local branch", async () => {
    const fake = fakeExec()
      .on(["git", "-C", REPO, "fetch"], { code: 128, stderr: "fatal: no remote" })
      .on(LOCAL, { stdout: `${SHA_A}\n` })
      .on(ORIGIN, { stdout: `${SHA_A}\n` });
    for (const opts of [undefined, { requireFresh: true }]) {
      const err = await resolveReleaseBase(fake.exec, REPO, B, opts).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SpawnError);
      expect((err as SpawnError).code).toBe("BASE_STALE");
      expect((err as SpawnError).message).toContain("fatal: no remote");
      expect((err as SpawnError).detail).toMatchObject({ repo: REPO, branch: B });
    }
    // Refused before anything else is resolved or created.
    expect(fake.argvs(["git", "-C", REPO, "branch"])).toEqual([]);
  });

  it("a BASE_STALE refusal carries git's first line only, then what to do", async () => {
    const fake = fakeExec()
      .on(["git", "-C", REPO, "fetch"], {
        code: 128,
        stderr:
          "\nfatal: unable to access 'https://example.com/repo.git/': Could not resolve host\n\nPlease make sure you have the correct access rights\nand the repository exists.\n",
      })
      .on(LOCAL, { stdout: `${SHA_A}\n` });
    const err = (await resolveReleaseBase(fake.exec, REPO, B).catch(
      (e: unknown) => e,
    )) as SpawnError;
    expect(err.code).toBe("BASE_STALE");
    expect(err.message).not.toContain("\n");
    expect(err.message).not.toContain("access rights");
    expect(err.message).toContain("Could not resolve host");
    expect(err.message).toContain(
      `Fix: check that origin is reachable and has ${B}, or work from the local copy: \`volleyd config set require_fresh_base false\``,
    );
    expect(err.detail).toMatchObject({
      fetch_error:
        "fatal: unable to access 'https://example.com/repo.git/': Could not resolve host",
    });
  });

  it("require_fresh_base off: a failed fetch resolves what the repo has, marked not fresh", async () => {
    const fake = fakeExec()
      .on(["git", "-C", REPO, "fetch"], { code: 128, stderr: "fatal: no remote" })
      .on(LOCAL, { stdout: `${SHA_A}\n` })
      .on(ORIGIN, MISSING);
    expect(await resolveReleaseBase(fake.exec, REPO, B, { requireFresh: false })).toEqual({
      ref: B,
      sha: SHA_A,
      fresh: false,
      fetch_error: "fatal: no remote",
    });
  });

  it("neither the branch nor origin's: RELEASE_BRANCH_MISSING", async () => {
    const fake = fakeExec().on(LOCAL, MISSING).on(ORIGIN, MISSING);
    const err = await resolveReleaseBase(fake.exec, REPO, B).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpawnError);
    expect((err as SpawnError).code).toBe("RELEASE_BRANCH_MISSING");
    expect((err as SpawnError).message).toBe(
      `RELEASE_BRANCH_MISSING: ${REPO} has neither ${B} nor origin/${B} — push it first`,
    );
    expect(await checkReleaseBranch(fake.exec, REPO, B)).toBe(
      `RELEASE_BRANCH_MISSING: ${REPO} has neither ${B} nor origin/${B} — push it first`,
    );
  });

  it("checkReleaseBranch: either ref is enough, and it never fetches", async () => {
    const onlyOrigin = fakeExec()
      .on(LOCAL, MISSING)
      .on(ORIGIN, { stdout: `${SHA_A}\n` });
    expect(await checkReleaseBranch(onlyOrigin.exec, REPO, B)).toBeNull();
    const onlyLocal = fakeExec()
      .on(LOCAL, { stdout: `${SHA_A}\n` })
      .on(ORIGIN, MISSING);
    expect(await checkReleaseBranch(onlyLocal.exec, REPO, B)).toBeNull();
    expect(onlyOrigin.argvs(["git", "-C", REPO, "fetch"])).toEqual([]);
  });
});

describe("addWorktree", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "volleyd-wt-")));
    mkdirSync(join(dir, "repo"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a release base present only as origin/<b>: fetch, track, then worktree add from it", async () => {
    const repo = join(dir, "repo");
    const path = join(dir, "wt", "T1-implementer");
    const fake = fakeExec()
      .on(["git", "-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${B}`], MISSING)
      .on(["git", "-C", repo, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${B}`], {
        stdout: `${SHA_A}\n`,
      });
    const r = await addWorktree(fake.exec, {
      repo,
      path,
      branch: "w1/T1-implementer-1",
      base: B,
      releaseBase: true,
    });
    expect(r).toEqual({
      path,
      branch: "w1/T1-implementer-1",
      reused: false,
      base: { sha: SHA_A, fresh: true },
    });
    const steps = fake.calls.map((c) => c.argv.slice(3, 5).join(" "));
    expect(steps.indexOf("fetch --quiet")).toBeLessThan(steps.indexOf("branch --track"));
    expect(steps.indexOf("branch --track")).toBeLessThan(steps.indexOf("worktree add"));
    expect(fake.argvs(["git", "-C", repo, "worktree", "add"])).toEqual([
      ["git", "-C", repo, "worktree", "add", path, "-b", "w1/T1-implementer-1", B],
    ]);
  });

  it("a release base missing everywhere refuses before any worktree is added", async () => {
    const repo = join(dir, "repo");
    const fake = fakeExec().on(["git", "-C", repo, "rev-parse", "--verify"], MISSING);
    const err = await addWorktree(fake.exec, {
      repo,
      path: join(dir, "wt", "T1-implementer"),
      branch: "w1/T1-implementer-1",
      base: B,
      releaseBase: true,
    }).catch((e: unknown) => e);
    expect((err as SpawnError).code).toBe("RELEASE_BRANCH_MISSING");
    expect(fake.argvs(["git", "-C", repo, "worktree", "add"])).toEqual([]);
  });

  it("a failed fetch: refused (BASE_STALE) by default, cut from the local copy with requireFresh off", async () => {
    const repo = join(dir, "repo");
    const spec = {
      repo,
      path: join(dir, "wt", "T1-implementer"),
      branch: "w1/T1-implementer-1",
      base: B,
      releaseBase: true,
    };
    const fake = fakeExec()
      .on(["git", "-C", repo, "fetch"], { code: 128, stderr: "fatal: unable to access" })
      .on(["git", "-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${B}`], {
        stdout: `${SHA_A}\n`,
      })
      .on(["git", "-C", repo, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${B}`], {
        stdout: `${SHA_A}\n`,
      });
    const err = await addWorktree(fake.exec, spec).catch((e: unknown) => e);
    expect((err as SpawnError).code).toBe("BASE_STALE");
    expect(fake.argvs(["git", "-C", repo, "worktree", "add"])).toEqual([]);

    const r = await addWorktree(fake.exec, { ...spec, requireFresh: false });
    expect(r.base).toEqual({ sha: SHA_A, fresh: false, fetch_error: "fatal: unable to access" });
    expect(fake.argvs(["git", "-C", repo, "worktree", "add"])).toHaveLength(1);
  });

  it("a pipeline start ref (not the release branch) is used as given: no fetch", async () => {
    const repo = join(dir, "repo");
    const path = join(dir, "wt", "T1-spec_reviewer-1");
    const fake = fakeExec();
    await addWorktree(fake.exec, { repo, path, branch: "x", base: SHA_A, detach: true });
    expect(fake.argvs(["git", "-C", repo, "fetch"])).toEqual([]);
    expect(fake.argvs(["git", "-C", repo, "worktree", "add"])).toEqual([
      ["git", "-C", repo, "worktree", "add", "--detach", path, SHA_A],
    ]);
  });

  describe("a retry after a failed add (real git)", () => {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
        cwd,
        stdio: "pipe",
      })
        .toString()
        .trim();
    let repo: string;
    beforeEach(() => {
      repo = join(dir, "repo");
      git(repo, "init", "--quiet", "-b", "main");
      git(repo, "commit", "--quiet", "--allow-empty", "-m", "init");
      git(repo, "branch", "release/x");
      // An origin the release branch is fetched from (require_fresh_base is on by default).
      git(dir, "init", "--quiet", "--bare", "origin.git");
      git(repo, "remote", "add", "origin", join(dir, "origin.git"));
      git(repo, "push", "--quiet", "origin", "release/x");
    });

    it("a branch the failed add left behind (no commits of its own) is reset, and the retry succeeds", async () => {
      const path = join(dir, "wt", "T1-implementer");
      // What a failed `worktree add -b` (path in the way) leaves: the branch, at the base.
      git(repo, "branch", "w1/T1-implementer-1", "release/x");
      const r = await addWorktree(exec, {
        repo,
        path,
        branch: "w1/T1-implementer-1",
        base: "release/x",
        releaseBase: true,
      });
      expect(r).toMatchObject({ path, branch: "w1/T1-implementer-1", reused: false });
      expect(r.base).toEqual({ sha: git(repo, "rev-parse", "release/x"), fresh: true });
      expect(git(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("w1/T1-implementer-1");
    });

    it("a branch with commits of its own is never reset: the add fails visibly", async () => {
      git(repo, "branch", "w1/T1-implementer-1", "release/x");
      git(repo, "checkout", "--quiet", "w1/T1-implementer-1");
      git(repo, "commit", "--quiet", "--allow-empty", "-m", "work");
      const tip = git(repo, "rev-parse", "w1/T1-implementer-1");
      git(repo, "checkout", "--quiet", "main");
      const err = await addWorktree(exec, {
        repo,
        path: join(dir, "wt", "T1-implementer"),
        branch: "w1/T1-implementer-1",
        base: "release/x",
        releaseBase: true,
      }).catch((e: unknown) => e);
      expect((err as SpawnError).code).toBe("WORKTREE_FAILED");
      expect(git(repo, "rev-parse", "w1/T1-implementer-1")).toBe(tip);
    });
  });
});
