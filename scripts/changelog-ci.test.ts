import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { changelogTouched, fragmentCheck, main, needsFragment, parseLog } from "./changelog-ci";
import { tempDir } from "./helpers/tmp";

describe("needsFragment", () => {
  test("a change under packages/ or spec/ needs one; the rest of the repo does not", () => {
    expect(needsFragment(["packages/volleyd/src/x.ts"])).toBe(true);
    expect(needsFragment(["spec/SPEC.md"])).toBe(true);
    expect(needsFragment(["README.md"])).toBe(false);
    expect(needsFragment([".github/workflows/ci.yml"])).toBe(false);
    expect(needsFragment(["README.md", "scripts/changelog.ts"])).toBe(false);
  });
});

describe("fragmentCheck", () => {
  const files = ["packages/volleyd/src/x.ts", "changes/194.fixed.md"];

  test("passes with an added fragment", () => {
    expect(fragmentCheck({ files, added: ["changes/194.fixed.md"], labels: [] }).ok).toBe(true);
  });

  test("passes with the no-changelog label", () => {
    expect(
      fragmentCheck({ files: ["spec/SPEC.md"], added: [], labels: ["bug", "no-changelog"] }).ok,
    ).toBe(true);
  });

  test("passes when nothing needs a fragment", () => {
    expect(fragmentCheck({ files: ["README.md"], added: [], labels: [] }).ok).toBe(true);
  });

  test("fails otherwise, naming the path pattern and the label", () => {
    for (const added of [[], ["changes/README.md"], ["changes/194.fixed.txt"]]) {
      const r = fragmentCheck({ files: ["packages/volleyd/src/x.ts"], added, labels: [] });
      expect(r.ok).toBe(false);
      const message = r.ok ? "" : r.message;
      expect(message).toContain("changes/<issue>.<type>.md");
      expect(message).toContain("no-changelog");
    }
  });
});

describe("changelogTouched", () => {
  const touch = (subject: string) => ({ subject, files: ["CHANGELOG.md", "x.ts"] });

  test("fails for CHANGELOG.md under an ordinary subject, naming the commit", () => {
    const r = changelogTouched([touch("feat(volleyd): x")]);
    expect(r.ok).toBe(false);
    const message = r.ok ? "" : r.message;
    expect(message).toContain("feat(volleyd): x");
    expect(message).toContain("changes/");
  });

  test("passes under a release commit's subject", () => {
    expect(changelogTouched([touch("release: changelog for 0.5.0")]).ok).toBe(true);
    expect(changelogTouched([touch("chore(release): 0.5.0")]).ok).toBe(true);
  });

  test("passes when CHANGELOG.md is not in any commit", () => {
    expect(changelogTouched([{ subject: "feat(volleyd): x", files: ["x.ts"] }]).ok).toBe(true);
    expect(changelogTouched([]).ok).toBe(true);
  });

  test("the migration to fragments (#231) is the one exempt non-release commit", () => {
    expect(changelogTouched([touch("feat(changelog): per-PR fragments (#231) (#240)")]).ok).toBe(
      true,
    );
    expect(changelogTouched([touch("feat(changelog): more (#2310)")]).ok).toBe(false);
  });
});

describe("parseLog", () => {
  test("splits git log output into commits with their files", () => {
    const out = "\x1eabc\x1ffeat: one\n\nCHANGELOG.md\na.ts\n\x1edef\x1fmerge\n\n";
    expect(parseLog(out)).toEqual([
      { subject: "feat: one", files: ["CHANGELOG.md", "a.ts"] },
      { subject: "merge", files: [] },
    ]);
  });
});

describe("main", () => {
  function git(cwd: string, ...args: string[]): string {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  }

  function commit(cwd: string, subject: string, files: Record<string, string>): string {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), text);
    }
    git(cwd, "add", "-A");
    git(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", subject);
    return git(cwd, "rev-parse", "HEAD");
  }

  function repo() {
    const cwd = tempDir("volley-changelog-ci-");
    git(cwd, "init", "-q");
    const base = commit(cwd, "chore: base", { "CHANGELOG.md": "# Changelog\n", "a.ts": "1" });
    return { cwd, base };
  }

  function run(argv: string[], cwd: string) {
    const err: string[] = [];
    const code = main(argv, { cwd, out: () => {}, err: (s) => err.push(s) });
    return { code, err: err.join("\n") };
  }

  test("fragment: a packages/ change without a fragment fails, with one passes", () => {
    const { cwd, base } = repo();
    const bare = commit(cwd, "feat: x", { "packages/p/src/x.ts": "x" });
    expect(run(["fragment", "--base", base, "--head", bare, "--labels", ""], cwd).code).toBe(1);
    expect(
      run(["fragment", "--base", base, "--head", bare, "--labels", "no-changelog"], cwd).code,
    ).toBe(0);
    const head = commit(cwd, "docs: fragment", { "changes/1.added.md": "- x." });
    expect(run(["fragment", "--base", base, "--head", head], cwd).code).toBe(0);
  });

  test("untouched: an ordinary commit editing CHANGELOG.md fails; a release commit passes", () => {
    const { cwd, base } = repo();
    const release = commit(cwd, "release: changelog for 0.5.0", {
      "CHANGELOG.md": "# C\n\n## 0.5.0\n",
    });
    expect(run(["untouched", "--base", base, "--head", release], cwd).code).toBe(0);
    const bad = commit(cwd, "fix(volleyd): y", { "CHANGELOG.md": "# C\n\n## Unreleased\n" });
    const r = run(["untouched", "--base", base, "--head", bad], cwd);
    expect(r.code).toBe(1);
    expect(r.err).toContain("fix(volleyd): y");
  });

  test("untouched: an all-zero base (a new branch) is skipped", () => {
    const { cwd, base } = repo();
    expect(run(["untouched", "--base", "0".repeat(40), "--head", base], cwd).code).toBe(0);
  });

  test("a missing --base / --head or an unknown check exits 2", () => {
    const { cwd, base } = repo();
    expect(run(["fragment", "--head", base], cwd).code).toBe(2);
    expect(run(["bogus", "--base", base, "--head", base], cwd).code).toBe(2);
  });
});
