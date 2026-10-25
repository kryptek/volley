/**
 * Links to a wave's work on GitHub (pure). The wave state's `github` (SPEC §4.6.1) is the
 * repository as the supervisor read it; an issue URL is derived from it, a PR's comes from the
 * task's own `pr.url`. Nothing is derived from `repo` (a local path) or guessed.
 */
import type { GitHubRepo, WaveTask } from "../store/types";

const SLUG = /^[^/\s]+\/[^/\s]+$/;

/**
 * `value` when it is a well-formed `github` (`owner/repo` slug, http(s) URL), else undefined.
 * Its twin is volleyd's `asGitHubRepo` (packages/volleyd/src/repo-visibility.ts): keep the two
 * checks in step.
 */
export function githubOf(value: unknown): GitHubRepo | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { slug, url } = value as { slug?: unknown; url?: unknown };
  if (typeof slug !== "string" || !SLUG.test(slug)) return undefined;
  if (typeof url !== "string" || !/^https?:\/\//i.test(url) || !URL.canParse(url)) return undefined;
  return { slug, url };
}

/** True for an issue or PR number: a positive safe integer. */
export const isIssueNumber = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n > 0;

/** Issue `n` on the wave's repository; null without a `github` or a number. */
export function issueHref(github: unknown, n: unknown): string | null {
  const gh = githubOf(github);
  return gh && isIssueNumber(n) ? `${gh.url.replace(/\/+$/, "")}/issues/${n}` : null;
}

/** The task's PR URL when it has one (http(s) only); never derived from a number. */
export function prHref(task: Pick<WaveTask, "pr"> | undefined): string | null {
  const url = task?.pr?.url;
  return typeof url === "string" && /^https?:\/\//i.test(url) && URL.canParse(url) ? url : null;
}

/** The accessible name of an issue link (`Issue #104 on GitHub`). */
export const issueLabel = (n: number | string): string => `Issue #${n} on GitHub`;

/**
 * The release PR `n` on the wave's repository (wave-state `release.pr`, which carries a number
 * only); null without a `github` or a number.
 */
export function releasePrHref(github: unknown, n: unknown): string | null {
  const gh = githubOf(github);
  return gh && isIssueNumber(n) ? `${gh.url.replace(/\/+$/, "")}/pull/${n}` : null;
}

/** The accessible name of a PR link (`PR #7 on GitHub`). */
export const prLabel = (n: number | string): string => `PR #${n} on GitHub`;

/**
 * A repository's GitHub `owner/name` as config and the doctor name it (machine.schema.json `slug`):
 * never a URL, a host or a `.git` suffix. Its twin is volleyd's `isSlug` (packages/volleyd/src/repos.ts).
 */
const REPO_SLUG =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)(?![A-Za-z0-9_.-]*\.git$)[A-Za-z0-9_.-]{1,100}$/;

export const isRepoSlug = (v: unknown): v is string => typeof v === "string" && REPO_SLUG.test(v);

/** The repository's page on GitHub; null for anything that is not an `owner/name`. */
export function repoHref(slug: unknown): string | null {
  return isRepoSlug(slug) ? `https://github.com/${slug}` : null;
}
