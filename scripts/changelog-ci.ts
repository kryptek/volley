#!/usr/bin/env bun
/**
 * CI's two changelog rules (see changes/README.md):
 *
 *   bun scripts/changelog-ci.ts fragment --base <sha> --head <sha> [--labels <a,b>]
 *     A PR whose diff touches packages/ or spec/ adds a fragment, changes/<issue>.<type>.md,
 *     unless it carries the `no-changelog` label.
 *   bun scripts/changelog-ci.ts untouched --base <sha> --head <sha>
 *     When the PR's net diff (base...head) changes CHANGELOG.md, every commit in base..head that
 *     changes it is a release commit (its subject
 *     starts with `release:` or `chore(release):`, as `bun run changelog --commit` writes).
 *     An all-zero base (the push that creates a branch) is skipped.
 *   bun scripts/changelog-ci.ts labels --ensure
 *     Creates the `no-changelog` label in the current GitHub repository (through `gh`) when it is
 *     missing; a no-op when it exists. The release steps run it before labelling the release PR.
 *
 * Exit code: 0 when the rule holds; 1 with the reason when it does not; 2 on usage.
 */
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

export const NO_CHANGELOG_LABEL = "no-changelog";

/**
 * The subjects of the commits allowed to change CHANGELOG.md. Case-insensitive: a release PR
 * squash-merged under its title (`Release: <date> — <theme>`) is a release commit too.
 */
const RELEASE_SUBJECT = /^(release:|chore\(release\):)/i;

/**
 * The one non-release commit allowed to change CHANGELOG.md: #231's, which moved its `## Unreleased`
 * section into changes/ fragments. Pinned to that commit's subject, so a later commit that merely
 * names #231 is not exempt.
 */
const MIGRATION_SUBJECT = /^feat\(changelog\): per-PR fragments in changes\/.*\(#231\)/;

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

/**
 * The `untouched` rule judged on the PR's net change: when the diff from the merge base does not
 * touch CHANGELOG.md, it holds, whatever older commits on the branch did. A branch written before
 * the fragments rule may carry commits that edited CHANGELOG.md and later merged the release
 * branch over them; without a force-push that history stays, and it changes nothing on merge.
 */
export function untouchedCheck({
  netFiles,
  commits,
}: {
  netFiles: string[];
  commits: () => Commit[];
}): CheckResult {
  if (!netFiles.includes("CHANGELOG.md")) return { ok: true };
  return changelogTouched(commits());
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

const USAGE = [
  "usage: bun scripts/changelog-ci.ts fragment|untouched --base <sha> --head <sha> [--labels <a,b>]",
  "       bun scripts/changelog-ci.ts labels --ensure",
].join("\n");

/** Runs `gh <args>` and returns its stdout; throws with gh's stderr on failure. */
export type Gh = (...args: string[]) => string;

/** Creates the `no-changelog` label when the repository lacks it; true when it created it. */
export function ensureLabels(gh: Gh): boolean {
  const names = gh("label", "list", "--limit", "1000", "--json", "name", "--jq", ".[].name")
    .split("\n")
    .map((l) => l.trim());
  if (names.includes(NO_CHANGELOG_LABEL)) return false;
  gh(
    "label",
    "create",
    NO_CHANGELOG_LABEL,
    "--color",
    "ededed",
    "--description",
    "This PR needs no changes/ fragment (see changes/README.md)",
    "--force",
  );
  return true;
}

export interface MainDeps {
  cwd?: string;
  out?: (s: string) => void;
  err?: (s: string) => void;
  gh?: Gh;
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
  const gh: Gh =
    deps.gh ??
    ((...args) => {
      const r = spawnSync("gh", args, { cwd: deps.cwd, encoding: "utf8" });
      if (r.status !== 0)
        throw new Error(`gh ${args.join(" ")} failed: ${(r.stderr ?? "").trim()}`);
      return r.stdout;
    });

  let check: string | undefined;
  let values: { base?: string; head?: string; labels?: string; ensure?: boolean };
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        base: { type: "string" },
        head: { type: "string" },
        labels: { type: "string" },
        ensure: { type: "boolean" },
      },
      strict: true,
      allowPositionals: true,
    });
    values = parsed.values;
    check = parsed.positionals[0];
  } catch (e) {
    err(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  if (check === "labels") {
    if (!values.ensure) {
      err(USAGE);
      return 2;
    }
    try {
      const created = ensureLabels(gh);
      out(
        created
          ? `changelog-ci: created the \`${NO_CHANGELOG_LABEL}\` label`
          : `changelog-ci: the \`${NO_CHANGELOG_LABEL}\` label exists`,
      );
      return 0;
    } catch (e) {
      err((e as Error).message);
      return 1;
    }
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
      result = untouchedCheck({
        netFiles: lines(git("diff", "--name-only", `${base}...${head}`, "--", "CHANGELOG.md")),
        commits: () =>
          parseLog(git("log", "--format=%x1e%H%x1f%s", "--name-only", `${base}..${head}`)),
      });
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
