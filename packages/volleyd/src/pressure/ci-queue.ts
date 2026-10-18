import type { Sample } from "../admission";
import type { ExecFn } from "../exec";
import { bounded, runSampler } from "./run";

/**
 * Queued workflow runs of the repository in the working directory: gh resolves `{owner}` and
 * `{repo}` from that checkout's remote. A GET, so the fence allows it.
 */
export const CI_QUEUE_ARGV = [
  "gh",
  "api",
  "repos/{owner}/{repo}/actions/runs?status=queued&per_page=1",
] as const;

/** The `total_count` of a workflow-runs response. */
export function parseCiQueue(out: string): Sample {
  let body: { total_count?: unknown };
  try {
    body = JSON.parse(out) as typeof body;
  } catch {
    return { ok: false, raw: bounded(out), error: "gh api did not print JSON" };
  }
  const n = body.total_count;
  return typeof n === "number" && Number.isInteger(n) && n >= 0
    ? { ok: true, value: n, raw: `total_count: ${n}` }
    : { ok: false, raw: bounded(out), error: "gh api response has no total_count" };
}

export function sampleCiQueue(exec: ExecFn, repoDir: string, timeoutMs: number): Promise<Sample> {
  return runSampler(exec, CI_QUEUE_ARGV, { timeoutMs, cwd: repoDir }, parseCiQueue);
}
