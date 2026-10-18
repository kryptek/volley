import type { PipelineStep, TaskId, Wave } from "./types";

/** What changed on one task present in both plan versions. Absent fields did not change. */
export interface TaskChange {
  task: TaskId;
  after?: { added: TaskId[]; removed: TaskId[] };
  issue?: { from: number; to: number };
  pipeline?: { from: PipelineStep[]; to: PipelineStep[] };
  model?: { from: string; to: string };
}

/**
 * The structural diff between two versions of a wave plan: tasks added (in the new file's order),
 * removed (in the old file's order) and changed (in the new file's order). Changes are compared on
 * the normalised tasks, so a wave-level `model:`/`pipeline:` change shows on every task that
 * inherits it. Titles, hosts and `files` hints are not structural.
 */
export interface PlanDiff {
  added: TaskId[];
  removed: TaskId[];
  changed: TaskChange[];
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

/** One line per change: `+ T6`, `- T3`, `~ T2  after +T6; model a -> b`. */
export function formatDiff(d: PlanDiff): string {
  if (isEmptyDiff(d)) return "no structural changes\n";
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
  return `${lines.join("\n")}\n`;
}
