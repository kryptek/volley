import type { TaskPipeline } from "../pipeline";
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
  /**
   * A `refused` entry whose last refusal says nothing about the release branch (required
   * checks, unknown): it keeps its place, competing as a `queued` one does (#311).
   */
  keepsPlace?: boolean;
  /**
   * The merge train the entry is a member of while that train forms or runs (SPEC §4.6.23); the
   * entry shows `merging` meanwhile and never takes the ordinary turn.
   */
  train?: string;
}

/** Where an entry competes in nextToMerge. */
const rank = (e: QueueEntry): QueueState =>
  e.state === "refused" && e.keepsPlace === true ? "queued" : e.state;

/** Code-unit order (ISO times and ids compare as written, whatever the locale). */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** How many of the wave's tasks name `task` in their `after`. */
export function dependents(wave: Wave, task: TaskId): number {
  return Object.values(wave.tasks).filter((t) => t.after.includes(task)).length;
}

/**
 * The last refusal says the PR cannot merge into the release branch as it stands (behind it, its
 * head moved, retargeted away from it, or closed), or that it is a draft, which waits for the CI
 * that starts once it is marked ready (#408): the task gives up the merge turn. Any other
 * refusal (required checks, branch protection, unknown) keeps it, and the merge is tried again up
 * to `merge_retry_max` (#311). A refusal journaled before reasons were recorded counts as `behind`;
 * a late refusal of an older gated head counts for nothing (the reducer records only the current
 * head's reason).
 */
export function refusalEndsTurn(p: TaskPipeline): boolean {
  const reason = p.merge_refusal_reason;
  return (
    reason === undefined ||
    reason === "behind" ||
    reason === "head_moved" ||
    reason === "retargeted" ||
    reason === "closed" ||
    reason === "draft"
  );
}

/** The wave's queue in merge order. */
export function queueOf(rec: WaveRecord): QueueEntry[] {
  const state = rec.state;
  const wave = rec.wave;
  if (state == null || wave == null) return [];
  const inTrain = new Map<TaskId, string>();
  for (const tr of state.trains ?? [])
    if (tr.state !== "merged" && tr.state !== "failed")
      for (const task of tr.tasks) inTrain.set(task, tr.id);
  const entries: QueueEntry[] = [];
  for (const t of state.tasks) {
    const p = rec.pipeline[t.id];
    if (p?.queued_at === undefined || p.merge_manual === true) continue;
    const train = inTrain.get(t.id);
    const qs: QueueState =
      p.merge_inflight === true || train !== undefined
        ? "merging"
        : p.rebasing && t.stage !== "merge_ready"
          ? "updating"
          : (p.merge_refusals ?? 0) > 0
            ? "refused"
            : "queued";
    entries.push({
      wave: state.wave,
      task: t.id,
      state: qs,
      since: p.queued_at,
      gated: t.stage === "merge_ready",
      ...(qs === "refused" && !refusalEndsTurn(p) ? { keepsPlace: true } : {}),
      ...(train !== undefined ? { train } : {}),
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
 * only when no other waits, unless its refusal said nothing about the release branch
 * (`keepsPlace`: it competes as a queued one). Across waves sharing a branch, each wave's first
 * candidate competes by readiness. (Each pipeline driver passes its own wave only: across waves
 * the release-branch lock goes to whichever wave asks first.)
 *
 * A branch with an entry in a merge train gets no turn: the train merges its members and holds
 * the release branch as a merge in flight does (the driver asks formTrain first when
 * `autopilot.merge_train` is on, merge-train.ts).
 *
 * An ungated (updating) entry is skipped, so a gated entry behind it can go first: the "never
 * ahead of a task it comes after" order holds only because a dependent is admitted after its
 * dependency is done. Stacked PRs (a dependent gated while its dependency still queues) would
 * need this to stop at an ungated dependency instead.
 */
export function nextToMerge(
  queues: Record<string, QueueEntry[]>,
  inflight: ReadonlySet<string>,
): { branch: string; wave: WaveId; task: TaskId } | null {
  for (const [branch, entries] of Object.entries(queues)) {
    if (inflight.has(branch) || entries.some((e) => e.train !== undefined)) continue;
    for (const state of ["queued", "refused"] as const) {
      const firsts = new Map<WaveId, QueueEntry>();
      for (const e of entries)
        if (e.gated && rank(e) === state && !firsts.has(e.wave)) firsts.set(e.wave, e);
      const best = [...firsts.values()].sort((a, b) => cmp(a.since, b.since))[0];
      if (best !== undefined) return { branch, wave: best.wave, task: best.task };
    }
  }
  return null;
}
