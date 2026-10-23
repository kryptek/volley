import type { WaveRecord } from "../reducer";
import type { TaskId, WaveId } from "../types";
import type { QueueEntry } from "./merge-queue";

/**
 * The merge train (SPEC §4.6.23): which of a release branch's gated tasks merge as one. Pure.
 *
 * The merge queue merges one gated PR at a time and updates the next after each merge, so N
 * merges cost N−1 update rounds. A train instead integrates up to `train_size_max` gated heads
 * onto one branch, gates it once and merges it once with a merge commit, which marks every member
 * PR merged. A train forms whenever at least two gated tasks wait on a branch with no merge in
 * flight; a single gated task takes the ordinary turn (nextToMerge, merge-queue.ts).
 */

export interface TrainMember {
  wave: WaveId;
  task: TaskId;
  pr: number;
  /** The member's gated head, which the train integrates. */
  head: string;
}

export interface Train {
  /** `train-<n>`: the train's synthetic task in its wave; n counts the wave's trains from 1. */
  id: TaskId;
  /** The integration branch: `volley/train/<wave>-t<n>`. */
  branch: string;
  release_branch: string;
  /** In merge order: the front task's cluster first, then queue order. */
  members: TrainMember[];
}

type Ready = { e: QueueEntry; member: TrainMember };

/** Code-unit order (ISO times compare as written, whatever the locale). */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Where an entry competes, as in nextToMerge: a refused one after the rest unless it keeps its place. */
const late = (e: QueueEntry): number => (e.state === "refused" && e.keepsPlace !== true ? 1 : 0);

/** One past the highest `train-<n>` the wave has started (`state.trains`, one per train_started). */
function nextTrain(rec: WaveRecord): number {
  let n = 0;
  for (const t of rec.state?.trains ?? []) {
    const m = /^train-(\d+)$/.exec(t.id);
    if (m !== null) n = Math.max(n, Number(m[1]));
  }
  return n + 1;
}

/**
 * The train to form next, on the first release branch (`<repo>#<release_branch>`) that has one:
 * none on a branch with a merge in flight (`inflight`, an entry merging, or a train forming or
 * running). Its members are the first up to `size` qualifying entries of the front task's wave:
 * at `merge_ready`, gated at their current head, with a PR, not handed to a human
 * (`merge_manual`) and in no train, ordered as nextToMerge orders them, with the entries of the
 * front task's cluster first. Fewer than two qualify: no train (the ordinary turn).
 */
export function formTrain(
  queues: Record<string, QueueEntry[]>,
  inflight: ReadonlySet<string>,
  waves: Record<WaveId, WaveRecord>,
  opts: { size: number; enabled: boolean },
): Train | null {
  if (!opts.enabled) return null;
  for (const [branch, entries] of Object.entries(queues)) {
    if (inflight.has(branch)) continue;
    if (entries.some((e) => e.state === "merging" || e.train !== undefined)) continue;
    const ready: Ready[] = [];
    for (const e of entries) {
      const p = waves[e.wave]?.pipeline[e.task];
      if (!e.gated || p === undefined || p.merge_manual === true) continue;
      if (p.pr === undefined || p.head === undefined || !p.gated.includes(p.head)) continue;
      ready.push({ e, member: { wave: e.wave, task: e.task, pr: p.pr.number, head: p.head } });
    }
    // Stable: queue order within each rank.
    ready.sort((a, b) => late(a.e) - late(b.e));
    // The front, as nextToMerge picks it: each wave's first of a rank, the earliest queued.
    const front = [0, 1]
      .map((rank) => {
        const firsts = new Map<WaveId, Ready>();
        for (const r of ready)
          if (late(r.e) === rank && !firsts.has(r.e.wave)) firsts.set(r.e.wave, r);
        return [...firsts.values()].sort((a, b) => cmp(a.e.since, b.e.since))[0];
      })
      .find((r) => r !== undefined);
    if (front === undefined) continue;
    const rec = waves[front.e.wave] as WaveRecord;
    const own = ready.filter((r) => r.e.wave === front.e.wave);
    const clusterOf = (task: TaskId) => rec.state?.tasks.find((t) => t.id === task)?.cluster;
    const cluster = clusterOf(front.e.task);
    const members = [
      ...own.filter((r) => cluster !== undefined && clusterOf(r.e.task) === cluster),
      ...own.filter((r) => cluster === undefined || clusterOf(r.e.task) !== cluster),
    ]
      .slice(0, opts.size)
      .map((r) => r.member);
    if (members.length < 2 || rec.state == null) continue;
    const n = nextTrain(rec);
    return {
      id: `train-${n}`,
      branch: `volley/train/${front.e.wave}-t${n}`,
      release_branch: rec.state.release_branch,
      members,
    };
  }
  return null;
}
