import { DAEMON_DEFAULTS } from "./config-defaults";
import type { ExecFn } from "./exec";
import type { RepoVisibility } from "./types";

/**
 * The repository's visibility with `gh repo view --json visibility`, run in the repo so gh picks
 * its remote (read-only, through the fence). `unknown` when gh fails, times out or prints
 * something else: the caller treats that as public.
 */
export async function readRepoVisibility(exec: ExecFn, repo: string): Promise<RepoVisibility> {
  try {
    const r = await exec(["gh", "repo", "view", "--json", "visibility"], {
      cwd: repo,
      timeoutMs: DAEMON_DEFAULTS.repo_visibility_ms,
    });
    if (r.code !== 0 || r.timedOut) return "unknown";
    const v = (JSON.parse(r.stdout) as { visibility?: unknown }).visibility;
    const s = typeof v === "string" ? v.toLowerCase() : "";
    return s === "public" || s === "private" || s === "internal" ? s : "unknown";
  } catch {
    return "unknown";
  }
}
