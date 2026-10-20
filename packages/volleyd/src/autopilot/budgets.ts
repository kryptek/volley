import type { DecisionRecord } from "../decisions";
import type { WaveRecord } from "../reducer";
import type { TaskState } from "../types";
import type { Budget, BudgetScope, CountedBudget } from "./policy";

/**
 * Autopilot's remediation budgets (SPEC §4.6.16), reduced from the wave's
 * `decision_auto_resolved` events: each answer journals its budget key with what it used. Pure.
 */

/** What a wave's journal says autopilot did: answers, escalations and each budget's use. */
export interface AutopilotRecord {
  resolved: number;
  escalated: number;
  budgets: Record<string, { used: number; max: number }>;
}

export const emptyAutopilot = (): AutopilotRecord => ({ resolved: 0, escalated: 0, budgets: {} });

/** Automatic answers (or, for the spawn budget, spawns allowed) used under `key` in the wave. */
export function budgetUsed(rec: WaveRecord, key: string): number {
  return rec.autopilot?.budgets[key]?.used ?? 0;
}

/** Fold one `decision_auto_resolved` (its `budget`, when it has one) into the record. */
export function foldAutoResolved(a: AutopilotRecord, budget: Budget | undefined): AutopilotRecord {
  const budgets =
    budget === undefined
      ? a.budgets
      : { ...a.budgets, [budget.key]: { used: budget.used, max: budget.max } };
  return { ...a, resolved: a.resolved + 1, budgets };
}

/** A decision's pipeline marker (`pipeline: { on, role, attempt, … }`), if it has one. */
export function markerOf(d: DecisionRecord): Record<string, unknown> | undefined {
  const m = (d as { pipeline?: unknown }).pipeline;
  return typeof m === "object" && m !== null ? (m as Record<string, unknown>) : undefined;
}

/** The agent role a decision is about: its marker's, its own, or the role running its agent. */
function roleOf(d: DecisionRecord, task: TaskState | undefined): string | undefined {
  const x = d as DecisionRecord & { role?: unknown; agent_id?: unknown };
  const m = markerOf(d)?.role;
  if (typeof m === "string") return m;
  if (typeof x.role === "string") return x.role;
  if (typeof x.agent_id !== "string" || task === undefined) return undefined;
  return Object.entries(task.agents).find(([, id]) => id === x.agent_id)?.[0];
}

/**
 * A counted budget's key: `<name>:<task>`, `<name>:<task>/<role>` or
 * `<name>:<task>/<role>/<attempt>` (the attempt from the marker, else the role's current agent).
 */
export function budgetKey(
  b: { name: CountedBudget; per: BudgetScope },
  d: DecisionRecord,
  task?: TaskState,
): string {
  const agent = (d as { agent_id?: unknown }).agent_id;
  const t = d.task ?? "_wave";
  if (b.per === "task") return `${b.name}:${t}`;
  const role = roleOf(d, task) ?? (typeof agent === "string" ? `agent-${agent}` : "unknown");
  if (b.per === "task_role") return `${b.name}:${t}/${role}`;
  const attempt =
    markerOf(d)?.attempt ??
    task?.agents[role as keyof TaskState["agents"]] ??
    (typeof agent === "string" ? agent : "unknown");
  return `${b.name}:${t}/${role}/${String(attempt)}`;
}
