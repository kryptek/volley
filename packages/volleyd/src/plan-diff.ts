import type { PipelineStep, TaskId, Wave } from "./types";

/** What changed on one task present in both plan versions. Absent fields did not change. */
export interface TaskChange {
  task: TaskId;
  after?: { added: TaskId[]; removed: TaskId[] };
  issue?: { from: number; to: number };
  pipeline?: { from: PipelineStep[]; to: PipelineStep[] };
  model?: { from: string; to: string };
}

/** A started task the new version would move: it keeps the host it runs on (#323). */
export interface HostKept {
  task: TaskId;
  /** Where it runs (its `agent_spawned`'s host). */
  kept: string;
  /** What the new version writes for it. */
  planned: string;
  /** Still in flight (else settled: done or merge-ready). */
  running: boolean;
}

/**
 * The structural diff between two versions of a wave plan: tasks added (in the new file's order),
 * removed (in the old file's order) and changed (in the new file's order). Changes are compared on
 * the normalised tasks, so a wave-level `model:`/`pipeline:` change shows on every task that
 * inherits it. Titles, hosts and `files` hints are not structural; `hosts_kept` (set by
 * plan-apply.ts, which knows which tasks started) reports the host changes that did not apply.
 */
export interface PlanDiff {
  added: TaskId[];
  removed: TaskId[];
  changed: TaskChange[];
  hosts_kept?: HostKept[];
}

export function diffPlans(prev: Wave, next: Wave): PlanDiff {
  const added = next.task_order.filter((id) => prev.tasks[id] === undefined);
  const removed = prev.task_order.filter((id) => next.tasks[id] === undefined);
  const changed: TaskChange[] = [];
  for (const id of next.task_order) {
    const a = prev.tasks[id];
    const b = next.tasks[id];
    if (a === undefined || b === undefined) continue;
    const c: TaskChange = { task: id };
    const depsAdded = b.after.filter((d) => !a.after.includes(d));
    const depsRemoved = a.after.filter((d) => !b.after.includes(d));
    if (depsAdded.length > 0 || depsRemoved.length > 0) {
      c.after = { added: depsAdded, removed: depsRemoved };
    }
    if (a.issue !== b.issue) c.issue = { from: a.issue, to: b.issue };
    if (JSON.stringify(a.pipeline) !== JSON.stringify(b.pipeline)) {
      c.pipeline = { from: a.pipeline, to: b.pipeline };
    }
    if (a.model !== b.model) c.model = { from: a.model, to: b.model };
    if (Object.keys(c).length > 1) changed.push(c);
  }
  return { added, removed, changed };
}

export const isEmptyDiff = (d: PlanDiff) =>
  d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0;

const pipelineText = (p: PipelineStep[]): string =>
  `[${p.map((s) => (Array.isArray(s) ? `[${s.join(", ")}]` : s)).join(", ")}]`;

/** A host the new version did not apply: `T3: host kept local (already running; new plan says auto)`. */
const keptLine = (k: HostKept): string =>
  `${k.task}: host kept ${k.kept} (already ${k.running ? "running" : "ran"}; new plan says ${k.planned})`;

/** One line per change: `+ T6`, `- T3`, `~ T2  after +T6; model a -> b`, then each host kept. */
export function formatDiff(d: PlanDiff): string {
  const kept = (d.hosts_kept ?? []).map((k) => `${keptLine(k)}\n`).join("");
  if (isEmptyDiff(d)) return `no structural changes\n${kept}`;
  const lines = [...d.added.map((id) => `+ ${id}`), ...d.removed.map((id) => `- ${id}`)];
  for (const c of d.changed) {
    const parts: string[] = [];
    if (c.after !== undefined) {
      const deps = [...c.after.added.map((x) => `+${x}`), ...c.after.removed.map((x) => `-${x}`)];
      parts.push(`after ${deps.join(" ")}`);
    }
    if (c.issue !== undefined) parts.push(`issue #${c.issue.from} -> #${c.issue.to}`);
    if (c.pipeline !== undefined) {
      parts.push(`pipeline ${pipelineText(c.pipeline.from)} -> ${pipelineText(c.pipeline.to)}`);
    }
    if (c.model !== undefined) parts.push(`model ${c.model.from} -> ${c.model.to}`);
    lines.push(`~ ${c.task}  ${parts.join("; ")}`);
  }
  return `${lines.join("\n")}\n${kept}`;
}
