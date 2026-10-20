#!/usr/bin/env bun
/**
 * CI's two changelog rules (see changes/README.md):
 *
 *   bun scripts/changelog-ci.ts fragment --base <sha> --head <sha> [--labels <a,b>]
 *     A PR whose diff touches packages/ or spec/ adds a fragment, changes/<issue>.<type>.md,
 *     unless it carries the `no-changelog` label.
 *   bun scripts/changelog-ci.ts untouched --base <sha> --head <sha>
 *     Every commit in base..head that changes CHANGELOG.md is a release commit (its subject
 *     starts with `release:` or `chore(release):`, as `bun run changelog --commit` writes).
 *     An all-zero base (the push that creates a branch) is skipped.
 *
 * Exit code: 0 when the rule holds; 1 with the reason when it does not; 2 on usage.
 */
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

export const NO_CHANGELOG_LABEL = "no-changelog";

/** The subjects of the commits allowed to change CHANGELOG.md. */
const RELEASE_SUBJECT = /^(release:|chore\(release\):)/;

/**
 * The one non-release commit allowed to change CHANGELOG.md: #231's, which moved its `## Unreleased`
 * section into changes/ fragments (squash-merged, so the subject carries `(#231)`).
 */
const MIGRATION_SUBJECT = /\(#231\)/;

export type CheckResult = { ok: true } | { ok: false; message: string };

/** True when `files` (the PR's changed paths) touch packages/ or spec/. */
export function needsFragment(files: string[]): boolean {
  return files.some((f) => f.startsWith("packages/") || f.startsWith("spec/"));
}

const FRAGMENT = /^changes\/[^/]+\.md$/;

/** `files` the PR changes, `added` the files it adds, `labels` the PR's labels. */
export function fragmentCheck({
  files,
  added,
  labels,
}: { files: string[]; added: string[]; labels: string[] }): CheckResult {
  if (!needsFragment(files) || labels.includes(NO_CHANGELOG_LABEL)) return { ok: true };
  if (added.some((f) => FRAGMENT.test(f) && f !== "changes/README.md")) return { ok: true };
  return {
    ok: false,
    message: [
      "This PR changes packages/ or spec/ but adds no changelog fragment. Add",
      "changes/<issue>.<type>.md (<type>: added | changed | fixed | removed | docs; see",
      `changes/README.md), or label the PR \`${NO_CHANGELOG_LABEL}\` when it needs no entry.`,
    ].join(" "),
  };
}

export interface Commit {
  subject: string;
  files: string[];
}

/** Fails when a non-release commit in the range changes CHANGELOG.md, naming each. */
export function changelogTouched(commits: Commit[]): CheckResult {
  const bad = commits.filter(
    (c) =>
      c.files.includes("CHANGELOG.md") &&
      !RELEASE_SUBJECT.test(c.subject) &&
      !MIGRATION_SUBJECT.test(c.subject),
  );
  if (bad.length === 0) return { ok: true };
  return {
    ok: false,
    message: [
      "CHANGELOG.md changes only in a release commit (subject `release:` or `chore(release):`).",
      "Record the change as a fragment in changes/ instead (see changes/README.md):",
      ...bad.map((c) => `  ${c.subject}`),
    ].join("\n"),
  };
}

/** `git log --format=%x1e%H%x1f%s --name-only` output → one Commit per record. */
export function parseLog(out: string): Commit[] {
  return out
    .split("\x1e")
    .filter((r) => r.trim() !== "")
    .map((record) => {
      const [head = "", ...files] = record.split("\n");
      return {
        subject: head.slice(head.indexOf("\x1f") + 1),
        files: files.filter((f) => f.trim() !== ""),
      };
    });
}

const USAGE =
  "usage: bun scripts/changelog-ci.ts fragment|untouched --base <sha> --head <sha> [--labels <a,b>]";

export interface MainDeps {
  cwd?: string;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

export function main(argv: string[], deps: MainDeps = {}): number {
  const out = deps.out ?? ((s) => console.log(s));
  const err = deps.err ?? ((s) => console.error(s));
  const git = (...args: string[]): string => {
    const r = spawnSync("git", args, { cwd: deps.cwd, encoding: "utf8", maxBuffer: 64 << 20 });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
    return r.stdout;
  };
  const lines = (s: string) => s.split("\n").filter((l) => l !== "");

  let check: string | undefined;
  let values: { base?: string; head?: string; labels?: string };
  try {
    const parsed = parseArgs({
      args: argv,
      options: { base: { type: "string" }, head: { type: "string" }, labels: { type: "string" } },
      strict: true,
      allowPositionals: true,
    });
    values = parsed.values;
    check = parsed.positionals[0];
  } catch (e) {
    err(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const { base, head } = values;
  if ((check !== "fragment" && check !== "untouched") || !base || !head) {
    err(USAGE);
    return 2;
  }

  let result: CheckResult;
  try {
    if (check === "fragment") {
      result = fragmentCheck({
        files: lines(git("diff", "--name-only", `${base}...${head}`)),
        added: lines(git("diff", "--name-only", "--diff-filter=A", `${base}...${head}`)),
        labels: (values.labels ?? "")
          .split(",")
          .map((l) => l.trim())
          .filter((l) => l !== ""),
      });
    } else {
      if (/^0+$/.test(base)) {
        out("changelog-ci: a new branch (all-zero base); nothing to check");
        return 0;
      }
      result = changelogTouched(
        parseLog(git("log", "--format=%x1e%H%x1f%s", "--name-only", `${base}..${head}`)),
      );
    }
  } catch (e) {
    err((e as Error).message);
    return 1;
  }
  if (!result.ok) {
    err(result.message);
    return 1;
  }
  out(`changelog-ci: ${check} ok`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
