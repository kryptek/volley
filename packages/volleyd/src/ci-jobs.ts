/**
 * A CI hold's jobs (#415): how many of a head's jobs are done, which are running or failed, and
 * how long the rest should take, from the last duration of each job in an earlier completed run
 * of the same workflow (the driver keeps those per wave). Pure: no I/O, no clock of its own.
 */

/** One job of a head's run, as `gh run view <id> --json jobs` reports it. */
export interface CiJob {
  /** Its run's workflow name: with `name`, the key of its last duration. */
  workflow: string;
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string;
  completed_at?: string;
  /** Its run has completed: only such a run's durations are an estimate for a later run. */
  run_done: boolean;
}

/** What a `ci_pending` hold says about its jobs (`ci_pending.jobs` and `eta_s`). */
export interface HoldJobs {
  done: number;
  total: number;
  running: string[];
  failed: string[];
  /** The last job's completion; while none is done, the first job's start. */
  last_done_at?: string;
  /** The longest last duration among this head's jobs (the Desk's `possibly stuck` yardstick). */
  slowest_s?: number;
  eta_s?: number;
}

/** A job failed: its conclusion is one of these. */
const FAILED = new Set(["failure", "timed_out", "cancelled", "startup_failure"]);

/** At most this many running job names (after ranges collapse) in a why_waiting line. */
const SHOWN = 4;

const key = (j: CiJob) => `${j.workflow}/${j.name}`;
const secs = (j: CiJob) =>
  (Date.parse(j.completed_at ?? "") - Date.parse(j.started_at ?? "")) / 1000;

/** Fold the durations of `jobs` whose run completed into `last` (`<workflow>/<job>` → seconds). */
export function noteJobTimes(last: Map<string, number>, jobs: CiJob[]): void {
  for (const j of jobs) {
    if (!j.run_done || j.status !== "completed") continue;
    const s = secs(j);
    if (Number.isFinite(s) && s >= 0) last.set(key(j), Math.round(s));
  }
}

/** The hold's job facts at `now`, estimated from `last` (noteJobTimes). */
export function holdJobs(jobs: CiJob[], last: Map<string, number>, now: number): HoldJobs {
  const done = jobs.filter((j) => j.status === "completed");
  const open = jobs.filter((j) => j.status !== "completed");
  const known = jobs.flatMap((j) => (last.has(key(j)) ? [last.get(key(j)) as number] : []));
  const lefts = open.flatMap((j) => {
    const s = last.get(key(j));
    if (s === undefined) return [];
    const started = Date.parse(j.started_at ?? "");
    return [s - (Number.isNaN(started) ? 0 : (now - started) / 1000)];
  });
  const latest = (xs: (string | undefined)[], pick: (a: number, b: number) => number) =>
    xs
      .map((x) => Date.parse(x ?? ""))
      .filter((x) => !Number.isNaN(x))
      .reduce<number | undefined>((a, b) => (a === undefined ? b : pick(a, b)), undefined);
  const lastDone =
    latest(
      done.map((j) => j.completed_at),
      Math.max,
    ) ??
    latest(
      jobs.map((j) => j.started_at),
      Math.min,
    );
  return {
    done: done.length,
    total: jobs.length,
    running: open.filter((j) => j.status === "in_progress").map((j) => j.name),
    failed: done.filter((j) => FAILED.has(j.conclusion ?? "")).map((j) => j.name),
    ...(lastDone !== undefined ? { last_done_at: new Date(lastDone).toISOString() } : {}),
    ...(known.length > 0 ? { slowest_s: Math.max(...known) } : {}),
    ...(lefts.length > 0 ? { eta_s: Math.max(0, Math.round(Math.max(...lefts))) } : {}),
  };
}

/** `Backend IT shard 2/6` … `6/6` → `Backend IT shard 2–6/6`; other names as they are, in order. */
export function collapseJobNames(names: string[]): string[] {
  const shard = /^(.*?)(\d+)\/(\d+)$/;
  const groups = new Map<string, number[]>();
  for (const n of names) {
    const m = shard.exec(n);
    if (m === null) continue;
    const g = `${m[1]}\u0000${m[3]}`;
    groups.set(g, [...(groups.get(g) ?? []), Number(m[2])]);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of names) {
    const m = shard.exec(n);
    if (m === null) {
      out.push(n);
      continue;
    }
    const g = `${m[1]}\u0000${m[3]}`;
    if (seen.has(g)) continue;
    seen.add(g);
    const nums = [...new Set(groups.get(g))].sort((a, b) => a - b);
    for (let i = 0; i < nums.length; ) {
      let k = i;
      while (k + 1 < nums.length && nums[k + 1] === (nums[k] as number) + 1) k++;
      const span = k > i ? `${nums[i]}–${nums[k]}` : `${nums[i]}`;
      out.push(`${m[1]}${span}/${m[3]}`);
      i = k + 1;
    }
  }
  return out;
}

/** The hold's why_waiting: `CI 3/13 · running: Backend IT shard 2–6/6 · ~8 min left`. */
export function jobsWhy(j: HoldJobs): string {
  const names = collapseJobNames(j.running);
  const more = names.length > SHOWN ? ` +${names.length - SHOWN} more` : "";
  const running =
    names.length > 0 ? `running: ${names.slice(0, SHOWN).join(", ")}${more}` : "queued";
  const failed = j.failed.length > 0 ? ` · failed: ${collapseJobNames(j.failed).join(", ")}` : "";
  const left =
    j.eta_s === undefined
      ? ""
      : j.eta_s < 60
        ? " · <1 min left"
        : ` · ~${Math.round(j.eta_s / 60)} min left`;
  return `CI ${j.done}/${j.total} · ${running}${failed}${left}`;
}
