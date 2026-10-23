import type { IssueData } from "../issue";
import type { WaveRecord } from "../reducer";
import type { TaskId, Wave, WaveId } from "../types";
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

/** A merge train's synthetic task id (`train-<n>`). */
export const TRAIN_ID = /^train-[1-9][0-9]{0,8}$/;

/** The integration branch of the wave's train `id` (`train-<n>`): `volley/train/<wave>-t<n>`. */
export const trainBranch = (wave: WaveId, id: TaskId): string =>
  `volley/train/${wave}-t${id.replace(/^train-/, "")}`;

/** The train task's title: `Train: #310, #312, #315` (each member's issues, in merge order). */
export const trainTitle = (issues: readonly number[]): string =>
  `Train: ${issues.map((n) => `#${n}`).join(", ")}`;

type Ready = { e: QueueEntry; member: TrainMember };

/** Code-unit order (ISO times compare as written, whatever the locale). */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Where an entry competes, as in nextToMerge: a refused one after the rest unless it keeps its place. */
const late = (e: QueueEntry): number => (e.state === "refused" && e.keepsPlace !== true ? 1 : 0);

/** A train forms or runs on the release branch (`<repo>#<release_branch>`), queued members or not. */
const trainRunning = (branch: string, waves: Record<WaveId, WaveRecord>): boolean =>
  Object.values(waves).some(
    (rec) =>
      rec.state != null &&
      `${rec.state.repo}#${rec.state.release_branch}` === branch &&
      (rec.state.trains ?? []).some((t) => t.state !== "merged" && t.state !== "failed"),
  );

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
 * front task's cluster first. A task dropped from an earlier train (its conflict) never
 * qualifies again. Fewer than two qualify: no train (the ordinary turn).
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
    if (trainRunning(branch, waves)) continue;
    const ready: Ready[] = [];
    for (const e of entries) {
      const p = waves[e.wave]?.pipeline[e.task];
      // A member dropped from an earlier train takes an ordinary turn instead (SPEC §4.6.23).
      if (!e.gated || p === undefined || p.merge_manual === true || p.train_dropped === true)
        continue;
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
      branch: trainBranch(front.e.wave, `train-${n}`),
      release_branch: rec.state.release_branch,
      members,
    };
  }
  return null;
}

/**
 * A train's `ISSUE.md` (no GitHub issue backs it): what it is and its members with their issues;
 * `.volley/integrate.md` carries the heads and the commands. The IssueData its integrator's spawn
 * uses in place of `gh issue view` (issue 0).
 */
export function trainIssue(wave: Wave, id: TaskId): IssueData {
  const def = wave.tasks[id];
  const members = def?.train?.members ?? [];
  const lines = members.map((m) => {
    const t = wave.tasks[m.task];
    const issues = t?.issues ?? (t !== undefined ? [t.issue] : []);
    return `- PR #${m.pr} (task \`${m.task}\`), closing ${issues.map((n) => `#${n}`).join(", ") || "no issue"}`;
  });
  const title = def?.title ?? `Train ${id}`;
  return {
    number: 0,
    title,
    url: "",
    body: `# ${title}

Synthetic task \`${id}\`, added by volleyd: a merge train (no GitHub issue backs it). This file is the issue.

Its members' gated PRs merge into \`${wave.release_branch}\` as one: integrated onto \`${trainBranch(wave.wave, id)}\`, gated once, merged with a merge commit. \`.volley/integrate.md\` names each member's branch and gated head, and the commands.

## Members, in merge order

${lines.join("\n")}
`,
  };
}

/** Every issue a train's members close, in merge order (its brief's `Closes` lines). */
export function trainIssues(wave: Wave, id: TaskId): number[] {
  return (wave.tasks[id]?.train?.members ?? []).flatMap((m) => {
    const t = wave.tasks[m.task];
    return t?.issues ?? (t !== undefined ? [t.issue] : []);
  });
}
