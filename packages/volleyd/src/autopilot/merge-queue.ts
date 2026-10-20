import type { WaveRecord } from "../reducer";
import type { TaskId, Wave, WaveId } from "../types";

/**
 * The merge queue (SPEC §4.6.17): which of a wave's gated tasks volleyd merges next. Pure.
 *
 * A task enters the queue when it is gated under `merge: auto` (`merge_queued`) and leaves it
 * merged, cancelled or handed to a human (`merge_dequeued`). The queue is ordered by dependency
 * (tasks with more dependents first; a task never ahead of one it comes after), then readiness
 * (queued earliest first). At most one task per release branch holds the merge turn: it is
 * updated from the release branch if it is behind, then merged; only then does the next one go.
 */

export type QueueState = "merging" | "updating" | "queued" | "refused";

export interface QueueEntry {
  wave: WaveId;
  task: TaskId;
  state: QueueState;
  /** When the task entered the queue (its `merge_queued`). */
  since: string;
  /** At merge_ready now: the only entries that can take the merge turn. */
  gated: boolean;
}

/** Code-unit order (ISO times and ids compare as written, whatever the locale). */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** How many of the wave's tasks name `task` in their `after`. */
export function dependents(wave: Wave, task: TaskId): number {
  return Object.values(wave.tasks).filter((t) => t.after.includes(task)).length;
}

/** The wave's queue in merge order. */
export function queueOf(rec: WaveRecord): QueueEntry[] {
  const state = rec.state;
  const wave = rec.wave;
  if (state == null || wave == null) return [];
  const entries: QueueEntry[] = [];
  for (const t of state.tasks) {
    const p = rec.pipeline[t.id];
    if (p?.queued_at === undefined || p.merge_manual === true) continue;
    entries.push({
      wave: state.wave,
      task: t.id,
      state:
        p.merge_inflight === true
          ? "merging"
          : p.rebasing && t.stage !== "merge_ready"
            ? "updating"
            : (p.merge_refusals ?? 0) > 0
              ? "refused"
              : "queued",
      since: p.queued_at,
      gated: t.stage === "merge_ready",
    });
  }
  const score = new Map(entries.map((e) => [e.task, dependents(wave, e.task)]));
  entries.sort(
    (a, b) =>
      (score.get(b.task) ?? 0) - (score.get(a.task) ?? 0) ||
      cmp(a.since, b.since) ||
      cmp(a.task, b.task),
  );
  return afterFirst(entries, wave);
}

/**
 * Stable fix-up of the order: an entry moves behind every queued entry it comes after
 * (transitively), keeping the rest of the order.
 */
function afterFirst(entries: QueueEntry[], wave: Wave): QueueEntry[] {
  const queued = new Set(entries.map((e) => e.task));
  const out: QueueEntry[] = [];
  const placed = new Set<TaskId>();
  const place = (e: QueueEntry, seen: Set<TaskId>) => {
    if (placed.has(e.task) || seen.has(e.task)) return;
    seen.add(e.task);
    for (const dep of wave.tasks[e.task]?.after ?? []) {
      const d = queued.has(dep) ? entries.find((x) => x.task === dep) : undefined;
      if (d !== undefined) place(d, seen);
    }
    placed.add(e.task);
    out.push(e);
  };
  for (const e of entries) place(e, new Set());
  return out;
}

/**
 * The task that takes the merge turn next, per release branch (`<repo>#<release_branch>`): none
 * on a branch with a merge in flight. A branch's candidates are its gated entries; a refused one
 * only when no other waits. Across waves sharing a branch, each wave's first candidate competes
 * by readiness. (Each pipeline driver passes its own wave only: across waves the release-branch
 * lock goes to whichever wave asks first.)
 */
export function nextToMerge(
  queues: Record<string, QueueEntry[]>,
  inflight: ReadonlySet<string>,
): { branch: string; wave: WaveId; task: TaskId } | null {
  for (const [branch, entries] of Object.entries(queues)) {
    if (inflight.has(branch)) continue;
    for (const state of ["queued", "refused"] as const) {
      const firsts = new Map<WaveId, QueueEntry>();
      for (const e of entries)
        if (e.gated && e.state === state && !firsts.has(e.wave)) firsts.set(e.wave, e);
      const best = [...firsts.values()].sort((a, b) => cmp(a.since, b.since))[0];
      if (best !== undefined) return { branch, wave: best.wave, task: best.task };
    }
  }
  return null;
}
