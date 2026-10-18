import type { Sample } from "../admission";
import type { ExecFn, ExecOptions } from "../exec";

const RAW_MAX = 500;

/** Trimmed and cut to a size that is safe to log and publish. */
export const bounded = (s: string) => s.trim().slice(0, RAW_MAX);

/**
 * Run one fenced sampler command and parse its stdout. A spawn failure (no such program), a
 * timeout or a non-zero exit is an unknown sample, never an exception: a missing tool must not
 * stop the daemon, and an unmeasured signal never throttles.
 */
export async function runSampler(
  exec: ExecFn,
  argv: readonly string[],
  opts: ExecOptions,
  parse: (stdout: string) => Sample,
): Promise<Sample> {
  try {
    const r = await exec(argv, opts);
    if (r.timedOut) return { ok: false, raw: bounded(r.stdout), error: `${argv[0]} timed out` };
    const parsed = parse(r.stdout);
    if (r.code === 0) return parsed;
    // docker info prints its JSON (with ServerErrors) even when it exits non-zero.
    const why = bounded(r.stderr);
    if (!parsed.ok) return why === "" ? parsed : { ...parsed, error: `${parsed.error}: ${why}` };
    return { ok: false, raw: bounded(r.stdout), error: `${argv[0]} exited ${r.code}: ${why}` };
  } catch (e) {
    return { ok: false, raw: "", error: e instanceof Error ? e.message : String(e) };
  }
}
