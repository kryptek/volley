import { describe, expect, it } from "vitest";
import { mergeArgv, trainMergeArgv } from "../../src/autopilot/merge";
import { mintMergeToken, mintTrainToken } from "../../src/fence";
import { fakeExec } from "../helpers/fake-exec";
import { HEAD_MOVED_STDERR, soakWorld } from "../helpers/soak-world";

/** The soak's git/GitHub world on its own: the reads the daemon makes agree with the writes. */

const REPO = "/soak/repo";
const RELEASE = "release/soak";
const FLAKE = {
  test: "test/clock.test.ts > sleep > resolves on abort",
  file: "test/clock.test.ts",
  rate: 0.5,
};

function world(o: { rate?: number; seed?: number } = {}) {
  const w = soakWorld({
    repo: REPO,
    release_branch: RELEASE,
    seed: o.seed ?? 1,
    flake: { ...FLAKE, rate: o.rate ?? FLAKE.rate },
  });
  // Every argv passes the real fence, as the daemon's would.
  const fx = fakeExec().on([], (argv, opts) => w.exec(argv, opts));
  const run = async (...argv: string[]) => fx.exec(argv);
  /** `gh pr merge` as autopilot runs it: the gate's token for exactly that PR and head. */
  const mergeAt = (pr: number, head: string) => {
    const merge = mintMergeToken({ wave: "soak", task: "A", pr, head, release_branch: RELEASE });
    return fx.exec(mergeArgv(merge, false), { merge });
  };
  return { w, run, mergeAt };
}

/** One task's PR: a commit on the release tip, pushed, a PR opened. */
function pr(w: ReturnType<typeof world>["w"], task: string) {
  const head = w.commit(w.tip(), { [`src/${task}.ts`]: `${task}-1` }, `feat: ${task}`);
  w.push(`soak/${task}-implementer-1`, head);
  return w.openPr(`soak/${task}-implementer-1`, `feat: ${task}`);
}

describe("the soak world", () => {
  it("names every git argv it does not model in unknown (fetch stays a silent no-op)", async () => {
    // Straight to the world: whatever verb the daemon starts relying on, past the fence.
    const { w } = world({ rate: 0 });
    w.exec(["git", "-C", REPO, "fetch", "origin"]);
    w.exec(["git", "-C", REPO, "cherry", "-v", w.tip()]);
    w.exec(["git", "-C", REPO, "show", "--stat", w.tip()]);
    expect(w.unknown).toEqual([
      ["git", "-C", REPO, "cherry", "-v", w.tip()],
      ["git", "-C", REPO, "show", "--stat", w.tip()],
    ]);
  });

  it("a git diff or gh call in a shape it does not model lands in unknown, not a throw", async () => {
    const { w } = world({ rate: 0 });
    const t = w.tip();
    expect(w.exec(["git", "-C", REPO, "diff", "--name-only", `${t}...${t}`]).code).toBe(0);
    expect(w.exec(["gh", "run", "list", "--json", "databaseId"]).code).toBe(0);
    expect(w.exec(["gh", "pr", "list", "--json", "number"]).code).toBe(0);
    expect(w.unknown).toEqual([
      ["git", "-C", REPO, "diff", "--name-only", `${t}...${t}`],
      ["gh", "run", "list", "--json", "databaseId"],
      ["gh", "pr", "list", "--json", "number"],
    ]);
  });

  it("a merge moves the release tip and makes the other PR heads behind it", async () => {
    const { w, run, mergeAt } = world({ rate: 0 });
    const a = pr(w, "A");
    const b = pr(w, "B");
    const before = w.tip();
    const merged = await mergeAt(a.number, a.headRefOid);
    expect(merged.code).toBe(0);
    expect(w.tip()).not.toBe(before);
    expect(a.state).toBe("MERGED");
    const view = JSON.parse(
      (await run("gh", "pr", "view", String(a.number), "--json", "mergeCommit,state")).stdout,
    );
    expect(view).toMatchObject({ state: "MERGED", mergeCommit: { oid: w.tip() } });
    // B forked before the merge: its merge-base with the release branch is the old tip.
    const mb = await run("git", "-C", REPO, "merge-base", b.headRefOid, w.tip());
    expect(mb.stdout.trim()).toBe(before);
    const behind = await run("git", "-C", REPO, "log", "--oneline", `${before}..${w.tip()}`);
    expect(behind.stdout.trim().split("\n")).toHaveLength(1);
    // A's change is on the release branch; its squash is A's whole diff.
    const files = await run("git", "-C", REPO, "diff", "--name-only", before, w.tip());
    expect(files.stdout.trim()).toBe("src/A.ts");
    const show = await run("git", "-C", REPO, "show", "--format=", w.tip());
    const whole = await run("git", "-C", REPO, "diff", before, a.headRefOid);
    expect(show.stdout).toBe(whole.stdout);
  });

  it("a merge train's --merge: a merge commit on the tip, and every member PR it contains reads MERGED", async () => {
    const { w, run } = world({ rate: 0 });
    const a = pr(w, "A");
    const b = pr(w, "B");
    const c = pr(w, "C");
    const before = w.tip();
    // The integrator: the train branch cut from the tip, A and B merged in with --no-ff.
    const t = w.merge(w.merge(before, a.headRefOid, "Merge A"), b.headRefOid, "Merge B");
    w.push("volley/train/soak-t1", t);
    const train = w.openPr("volley/train/soak-t1", "train: #1, #2");
    const token = mintTrainToken({
      train: "train-1",
      pr: train.number,
      head: t,
      release_branch: RELEASE,
      members: [
        { task: "A", head: a.headRefOid },
        { task: "B", head: b.headRefOid },
      ],
    });
    const fx = fakeExec().on([], (argv, opts) => w.exec(argv, opts));
    expect((await fx.exec(trainMergeArgv(token), { train: token })).code).toBe(0);
    expect(w.get(w.tip()).parents).toEqual([before, t]);
    expect(train.state).toBe("MERGED");
    for (const m of [a, b]) {
      expect(m.state).toBe("MERGED");
      const view = JSON.parse(
        (await run("gh", "pr", "view", String(m.number), "--json", "state,mergeCommit")).stdout,
      );
      expect(view).toMatchObject({ state: "MERGED", mergeCommit: { oid: w.tip() } });
    }
    expect(c.state).toBe("OPEN");
    expect(w.isAncestor(a.headRefOid, w.tip())).toBe(true);
    expect(w.merges.map((m) => m.pr)).toEqual([train.number]);
  });

  it("two tasks touching one file conflict at the second's update: the rebase resolves it, the world records the file", () => {
    const w = soakWorld({
      repo: REPO,
      release_branch: RELEASE,
      seed: 1,
      tree: { "src/shared.ts": 100, "src/a.ts": 10 },
    });
    // The tree's paths are on the root, so a footprint names files that exist.
    expect(Object.keys(w.get(w.root).files)).toEqual(
      expect.arrayContaining(["src/shared.ts", "src/a.ts"]),
    );
    const base = w.tip();
    const b = w.commit(base, { "src/shared.ts": "B-1" }, "feat: B");
    w.pushRelease({ "src/shared.ts": "A-1", "src/a.ts": "A-1" }, "feat: A (#1)");
    expect(w.conflicts).toEqual([]);
    const updated = w.rebase(b, w.tip(), "feat: B");
    expect(w.conflicts).toEqual([{ head: b, onto: w.tip(), files: ["src/shared.ts"] }]);
    // Resolved: B's side of the shared file, A's other change kept.
    expect(w.get(updated).files).toMatchObject({ "src/shared.ts": "B-1", "src/a.ts": "A-1" });
    // A disjoint update records nothing.
    const c = w.commit(base, { "src/c.ts": "C-1" }, "feat: C");
    w.rebase(c, w.tip(), "feat: C");
    expect(w.conflicts).toHaveLength(1);
  });

  it("--match-head-commit with a stale head refuses, and nothing moves", async () => {
    const { w, mergeAt } = world({ rate: 0 });
    const a = pr(w, "A");
    const gated = a.headRefOid;
    w.push(a.headRefName, w.commit(gated, { "src/A.ts": "A-2" }, "fix: A"));
    const tip = w.tip();
    const r = await mergeAt(a.number, gated);
    expect(r).toMatchObject({ code: 1, stderr: HEAD_MOVED_STDERR });
    expect(w.tip()).toBe(tip);
    expect(a.state).toBe("OPEN");
  });

  it("a flaky test fails per the seed on heads that do not touch it, with its id in the run log", async () => {
    const { w, run } = world({ rate: 0.5, seed: 7 });
    const heads = Array.from({ length: 40 }, (_, i) => pr(w, `T${i}`).headRefOid);
    const red: string[] = [];
    for (const h of heads) {
      const runs = JSON.parse(
        (
          await run(
            "gh",
            "run",
            "list",
            "--commit",
            h,
            "--json",
            "databaseId,name,status,conclusion,headSha,url",
          )
        ).stdout,
      );
      if (runs[0].conclusion === "failure") {
        red.push(h);
        const log = await run("gh", "run", "view", String(runs[0].databaseId), "--log-failed");
        expect(log.stdout).toContain(`FAIL  ${FLAKE.test}`);
      }
    }
    // Roughly half, and the same half for the same seed.
    expect(red.length).toBeGreaterThan(8);
    expect(red.length).toBeLessThan(32);
    const again = world({ rate: 0.5, seed: 7 });
    const heads2 = Array.from({ length: 40 }, (_, i) => pr(again.w, `T${i}`).headRefOid);
    expect(heads2.filter((h) => again.w.ci(h)[0]?.failing !== null)).toEqual(red);
    // A head that touches the flaky test's file never fails on it.
    const touching = w.commit(w.tip(), { [FLAKE.file]: "edited" }, "test: clock");
    expect(w.ci(touching)[0]?.failing).toBeNull();
  });

  it("release-branch runs reflect the flake until the fixer's merge removes it", async () => {
    const { w, run, mergeAt } = world({ rate: 1 });
    const list = async () =>
      JSON.parse(
        (
          await run(
            "gh",
            "run",
            "list",
            "--branch",
            RELEASE,
            "--limit",
            "20",
            "--json",
            "databaseId,name,status,conclusion,headSha,url",
          )
        ).stdout,
      );
    expect((await list())[0]).toMatchObject({ conclusion: "failure", headSha: w.tip() });
    const a = pr(w, "A");
    expect(w.ci(a.headRefOid)[0]?.failing).toBe(FLAKE.test);
    // The fixer's PR touches the test file: green; merged, the flake is gone.
    const fix = w.commit(w.tip(), { [FLAKE.file]: "fixed" }, "fix: flaky clock test");
    w.push("soak/fixer-implementer-1", fix);
    const f = w.openPr("soak/fixer-implementer-1", "fix: flaky clock test");
    expect(w.ci(fix)[0]?.failing).toBeNull();
    await mergeAt(f.number, fix);
    expect(w.fixedBy()).toBe(w.tip());
    expect((await list())[0]).toMatchObject({ conclusion: "success", headSha: w.tip() });
    // A head rebased onto the fix is green; A's old head (without it) stays red.
    const rebased = w.rebase(a.headRefOid, w.tip(), "feat: A");
    expect(w.ci(rebased)[0]?.failing).toBeNull();
    expect(w.ci(a.headRefOid)[0]?.failing).toBe(FLAKE.test);
  });
});
