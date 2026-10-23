import { DAEMON_DEFAULTS } from "./config-defaults";
import type { ExecFn } from "./exec";
import type { GitHubRepo, RepoVisibility } from "./types";

/** What `gh repo view` says about a wave's repository: its visibility and, when read, its name. */
export interface RepoView {
  visibility: RepoVisibility;
  github?: GitHubRepo;
}

const SLUG = /^[^/\s]+\/[^/\s]+$/;

/**
 * `value` as a wave state's `github` (SPEC §4.6.1) when it is one: an `owner/repo` slug and an
 * http(s) URL. Undefined otherwise; nothing is ever guessed. Its twin is the Desk's `githubOf`
 * (packages/volley-desk/src/lib/github.ts): keep the two checks in step.
 */
export function asGitHubRepo(value: unknown): GitHubRepo | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { slug, url } = value as { slug?: unknown; url?: unknown };
  if (typeof slug !== "string" || !SLUG.test(slug)) return undefined;
  if (typeof url !== "string" || !/^https?:\/\//i.test(url) || !URL.canParse(url)) return undefined;
  return { slug, url };
}

/**
 * The repository's visibility, name and URL with `gh repo view --json nameWithOwner,url,visibility`,
 * run in the repo so gh picks its remote (read-only, through the fence). Visibility `unknown` and
 * no `github` when gh fails, times out or prints something else: the caller treats that as public.
 */
export async function readRepoView(exec: ExecFn, repo: string): Promise<RepoView> {
  try {
    const r = await exec(["gh", "repo", "view", "--json", "nameWithOwner,url,visibility"], {
      cwd: repo,
      timeoutMs: DAEMON_DEFAULTS.repo_visibility_ms,
    });
    if (r.code !== 0 || r.timedOut) return { visibility: "unknown" };
    const out = JSON.parse(r.stdout) as {
      nameWithOwner?: unknown;
      url?: unknown;
      visibility?: unknown;
    };
    const v = typeof out.visibility === "string" ? out.visibility.toLowerCase() : "";
    const visibility: RepoVisibility =
      v === "public" || v === "private" || v === "internal" ? v : "unknown";
    const github = asGitHubRepo({ slug: out.nameWithOwner, url: out.url });
    return github !== undefined ? { visibility, github } : { visibility };
  } catch {
    return { visibility: "unknown" };
  }
}

/** What `gh repo view <owner/name>` says of a repository being added (`repo_add`, D6). */
export interface SlugView {
  /** GitHub's canonical `nameWithOwner` (its spelling, whatever case was asked). */
  slug: string;
  url: string;
  visibility: RepoVisibility;
}

/**
 * `gh repo view <slug> --json nameWithOwner,url,visibility` on the supervisor (read-only, through
 * the fence): the repository exists and its canonical name; or why not, in gh's words.
 */
export async function readSlugView(exec: ExecFn, slug: string): Promise<SlugView | string> {
  let r: Awaited<ReturnType<ExecFn>>;
  try {
    r = await exec(["gh", "repo", "view", slug, "--json", "nameWithOwner,url,visibility"], {
      timeoutMs: DAEMON_DEFAULTS.repo_visibility_ms,
    });
  } catch (e) {
    return `gh repo view ${slug}: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (r.timedOut) return `gh repo view ${slug} timed out`;
  if (r.code !== 0) {
    const why = r.stderr.trim().split("\n")[0] ?? "";
    return `gh repo view ${slug}: ${why !== "" ? why : `exit ${r.code}`}`;
  }
  try {
    const out = JSON.parse(r.stdout) as { visibility?: unknown };
    const github = asGitHubRepo({
      slug: (out as { nameWithOwner?: unknown }).nameWithOwner,
      url: (out as { url?: unknown }).url,
    });
    if (github === undefined) return `gh repo view ${slug} printed no repository`;
    const v = typeof out.visibility === "string" ? out.visibility.toLowerCase() : "";
    const visibility: RepoVisibility =
      v === "public" || v === "private" || v === "internal" ? v : "unknown";
    return { slug: github.slug, url: github.url, visibility };
  } catch {
    return `gh repo view ${slug} printed no repository`;
  }
}
