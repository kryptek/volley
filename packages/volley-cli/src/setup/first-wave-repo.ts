import { isAbsolute } from "node:path";

/**
 * What the test wave (`volley setup`'s last step, first-wave.ts) makes on GitHub and in git, as
 * argv builders: a scratch private repository (`gh repo create volley-hello-<4> --private
 * --clone`), its README commit, the one issue, the release branch, and the wave file. The fence
 * (`isFirstWaveCommand`) allows exactly these shapes.
 */

/** The test wave's id: its state is `volley/_waves/hello/state`. */
export const HELLO_WAVE = "hello";
export const HELLO_ISSUE_TITLE = "Add HELLO.md";
export const HELLO_ISSUE_BODY =
  "Add a file HELLO.md at the repository root holding one line: `Hello from Volley.`\n\nFiled by `volley setup`'s test wave.";
export const HELLO_README =
  "# volley-hello\n\nA scratch repository `volley setup` made for its 1-issue test wave. Delete it\nwith `gh repo delete <owner>/<name> --yes` once you no longer want it.\n";

/** A scratch repository's name: `volley-hello-` and four characters [a-z0-9]. */
export const HELLO_NAME = /^volley-hello-[a-z0-9]{4}$/;
export const helloRepoName = (suffix: string) => `volley-hello-${suffix}`;

/** Four random characters [a-z0-9] (`random`: [0, 1), injected by tests). */
export function helloSuffix(random: () => number = Math.random): string {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 4 }, () => abc[Math.floor(random() * abc.length)] ?? "a").join("");
}

/** `release/<YYYY-MM-DD>-hello` (the UTC date). */
export const helloRelease = (now: Date) => `release/${now.toISOString().slice(0, 10)}-hello`;
const RELEASE = /^release\/\d{4}-\d{2}-\d{2}-hello$/;

export const ghRepoCreateArgv = (name: string) => [
  "gh",
  "repo",
  "create",
  name,
  "--private",
  "--clone",
];
/** The clone's repository on GitHub (run in the clone): its `owner/name`. */
export const GH_REPO_VIEW = [
  "gh",
  "repo",
  "view",
  "--json",
  "nameWithOwner",
  "--jq",
  ".nameWithOwner",
];
export const ghIssueCreateArgv = (slug: string) => [
  "gh",
  "issue",
  "create",
  "--repo",
  slug,
  "--title",
  HELLO_ISSUE_TITLE,
  "--body",
  HELLO_ISSUE_BODY,
];
/** `gh repo delete`: printed at the end, never run by setup. */
export const ghRepoDeleteLine = (slug: string) => `gh repo delete ${slug} --yes`;

export const gitOriginArgv = (clone: string) => ["git", "-C", clone, "remote", "get-url", "origin"];
export const gitAddReadmeArgv = (clone: string) => ["git", "-C", clone, "add", "README.md"];
export const gitCommitReadmeArgv = (clone: string) => [
  "git",
  "-C",
  clone,
  "commit",
  "-q",
  "-m",
  "Add README.md",
];
/** The scratch repository's first push: its default branch, tracked. */
export const gitPushDefaultArgv = (clone: string) => [
  "git",
  "-C",
  clone,
  "push",
  "-u",
  "origin",
  "HEAD",
];
/** The release branch, cut from the clone's HEAD on the origin (the clone's branches untouched). */
export const gitPushReleaseArgv = (clone: string, release: string) => [
  "git",
  "-C",
  clone,
  "push",
  "origin",
  `HEAD:refs/heads/${release}`,
];

const same = (argv: readonly string[], want: readonly string[]) =>
  argv.length === want.length && want.every((w, i) => argv[i] === w);

/** An absolute path with no newline or NUL (a clone). */
const absPath = (p: string | undefined) =>
  p !== undefined && isAbsolute(p) && !/[\n\0]/.test(p) ? p : null;

/** A GitHub `owner/name` as gh prints it. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/;

/** Whether `argv` is one of the gh and git commands the test wave runs (the fence's entries). */
export function isFirstWaveCommand(argv: readonly string[]): boolean {
  const [a0, a1, a2, a3] = argv;
  if (a0 === "gh") {
    if (a1 === "repo" && a2 === "create") {
      return HELLO_NAME.test(a3 ?? "") && same(argv, ghRepoCreateArgv(a3 as string));
    }
    if (same(argv, GH_REPO_VIEW)) return true;
    const slug = argv[4] ?? "";
    return SLUG.test(slug) && same(argv, ghIssueCreateArgv(slug));
  }
  if (a0 !== "git" || a1 !== "-C") return false;
  const clone = absPath(a2);
  if (clone === null) return false;
  const release = (argv[5] ?? "").replace(/^HEAD:refs\/heads\//, "");
  return (
    same(argv, gitOriginArgv(clone)) ||
    same(argv, gitAddReadmeArgv(clone)) ||
    same(argv, gitCommitReadmeArgv(clone)) ||
    same(argv, gitPushDefaultArgv(clone)) ||
    (RELEASE.test(release) && same(argv, gitPushReleaseArgv(clone, release)))
  );
}

/** The issue number at the end of `gh issue create`'s URL, or null. */
export function issueNumberOf(stdout: string): number | null {
  const m = /\/issues\/(\d+)\s*$/.exec(stdout.trim());
  return m?.[1] !== undefined ? Number(m[1]) : null;
}

/**
 * The test wave's file: one task on the issue, implemented and merged by the supervisor
 * (`merge: auto`), with no reviews: the shortest pipeline that still opens and merges a PR.
 */
export function helloWaveYaml(w: {
  repo: string;
  release: string;
  model: string;
  issue: number;
}): string {
  return [
    "# volley setup's 1-issue test wave (the first-wave step).",
    `wave: ${HELLO_WAVE}`,
    `repo: ${JSON.stringify(w.repo)}`,
    `release_branch: ${w.release}`,
    `model: ${w.model}`,
    "merge: auto",
    "pipeline: [implement, merge_ready]",
    "tasks:",
    `  T1: { issue: ${w.issue} }`,
    "",
  ].join("\n");
}
