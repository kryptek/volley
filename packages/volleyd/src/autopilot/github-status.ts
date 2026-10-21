import { DAEMON_DEFAULTS } from "../config-defaults";

/**
 * GitHub's status page, read when a red head is classified (ci-classify.ts): a non-operational
 * Actions or API component makes the red an infra incident, which the pipeline waits out instead
 * of asking for a fix. An HTTP read through the injected `fetch`, not a child process, so the
 * fence is not involved. An unreachable or unreadable page is `unknown` and never an incident:
 * a status page that is down itself never holds a wave.
 */

export const GITHUB_STATUS_URL = "https://www.githubstatus.com/api/v2/components.json";

/** The components whose incident is a CI incident. */
const CI_COMPONENTS: ReadonlySet<string> = new Set(["Actions", "API Requests"]);

export interface GithubStatus {
  incident: boolean;
  /** The CI components that are not `operational`. */
  components: { name: string; status: string }[];
  /** The page could not be read (a timeout, a non-2xx, junk). */
  unknown?: true;
}

/** What an unreadable status page reads as (and a driver given no status page). */
export const STATUS_UNKNOWN: GithubStatus = { incident: false, components: [], unknown: true };

export async function fetchGithubStatus(
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<GithubStatus> {
  try {
    const r = await fetchFn(GITHUB_STATUS_URL, {
      // real clock: an HTTP read's own deadline, not daemon timing
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return STATUS_UNKNOWN;
    const body = (await r.json()) as { components?: { name?: unknown; status?: unknown }[] };
    if (!Array.isArray(body.components)) return STATUS_UNKNOWN;
    const components = body.components
      .filter(
        (c): c is { name: string; status: string } =>
          typeof c.name === "string" && typeof c.status === "string",
      )
      .filter((c) => CI_COMPONENTS.has(c.name) && c.status !== "operational")
      .map((c) => ({ name: c.name, status: c.status }));
    return { incident: components.length > 0, components };
  } catch {
    return STATUS_UNKNOWN;
  }
}

/** `fetchGithubStatus`, each result reused for `status_page_cache_ms` (a wave of red heads reads it once). */
export function githubStatusCache(
  fetchFn: typeof fetch,
  now: () => number,
): () => Promise<GithubStatus> {
  let last: { at: number; status: Promise<GithubStatus> } | undefined;
  return () => {
    const t = now();
    if (last === undefined || t - last.at >= DAEMON_DEFAULTS.status_page_cache_ms)
      last = { at: t, status: fetchGithubStatus(fetchFn, DAEMON_DEFAULTS.status_page_timeout_ms) };
    return last.status;
  };
}
