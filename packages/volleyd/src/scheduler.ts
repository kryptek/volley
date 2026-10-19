import { forHost } from "./admission";
import { DAEMON_DEFAULTS } from "./config-defaults";
import {
  AUTO_HOST,
  type PlaceOptions,
  type Placement,
  type Snapshot,
  needsPlacement,
  place,
  reserve,
} from "./placement";
import type { WaveRecord } from "./reducer";
import type { TaskId, TaskStage, Wave } from "./types";

/**
 * An admission verdict: how many more agents may start right now, and why not more.
 * `decide` (src/admission.ts) computes it from measured pressure; open is `allow: Infinity`.
 */
export interface Admission {
  allow: number;
  reasons: string[];
}

/** The runaway fuse around any admission verdict. */
export interface AdmitContext {
  /** Live supervised agents across all waves. */
  live: number;
  hardCeiling: number;
  /** Spawns this wave has used or committed to. */
  spawnsUsed: number;
  spawnBudget: number;
}

/** Stages in which an admitted task no longer holds an agent slot. */
const SETTLED: ReadonlySet<TaskStage> = new Set(["merge_ready", "done", "cancelled"]);

/** Longest dependency chain starting at each task (counting the task itself). */
export function criticalPaths(wave: Wave): Record<TaskId, number> {
  const dependents = new Map<TaskId, TaskId[]>(wave.task_order.map((id) => [id, []]));
  for (const id of wave.task_order) {
    for (const dep of wave.tasks[id]?.after ?? []) dependents.get(dep)?.push(id);
  }
  const memo: Record<TaskId, number> = {};
  const len = (id: TaskId): number => {
    const known = memo[id];
    if (known !== undefined) return known;
    const below = (dependents.get(id) ?? []).map(len);
    const v = 1 + (below.length > 0 ? Math.max(...below) : 0);
    memo[id] = v;
    return v;
  };
  for (const id of wave.task_order) len(id);
  return memo;
}

/** Tasks admitted and not yet settled — the ones currently holding an agent slot. */
export function activeTasks(rec: WaveRecord): TaskId[] {
  const stage = new Map(rec.state?.tasks.map((t) => [t.id, t.stage]) ?? []);
  return rec.admitted.filter((id) => {
    const s = stage.get(id);
    return s !== undefined && !SETTLED.has(s);
  });
}

/**
 * Tasks that may start: queued, not yet admitted, every `after` dependency done. Ordered by
 * critical path length (longest first), then by how many active tasks share a `files` hint
 * (fewest first), then by id.
 */
export function ready(rec: WaveRecord): TaskId[] {
  const { wave, state } = rec;
  if (wave === null || state === null || state.status !== "running") return [];
  const stage = new Map(state.tasks.map((t) => [t.id, t.stage]));
  const cp = criticalPaths(wave);
  const activeFiles = activeTasks(rec).map((id) => new Set(wave.tasks[id]?.files ?? []));
  const overlap = (id: TaskId) =>
    activeFiles.filter((files) => (wave.tasks[id]?.files ?? []).some((f) => files.has(f))).length;

  return state.tasks
    .filter(
      (t) =>
        t.stage === "queued" &&
        !rec.admitted.includes(t.id) &&
        (wave.tasks[t.id]?.after ?? []).every((d) => stage.get(d) === "done"),
    )
    .map((t) => t.id)
    .sort(
      (a, b) =>
        (cp[b] ?? 0) - (cp[a] ?? 0) || overlap(a) - overlap(b) || (a < b ? -1 : a > b ? 1 : 0),
    );
}

/**
 * Pick which ready tasks to start: at most `admission.allow`, never past the hard ceiling or the
 * wave's spawn budget. Lowering a limit below current use admits nothing and preempts nothing.
 * `reasons` explains every limit that held a ready task back.
 */
export function admit(
  readyTasks: TaskId[],
  admission: Admission,
  ctx: AdmitContext,
): { admit: TaskId[]; reasons: string[] } {
  const ceilingRoom = Math.max(0, ctx.hardCeiling - ctx.live);
  const budgetRoom = Math.max(0, ctx.spawnBudget - ctx.spawnsUsed);
  const n = Math.min(readyTasks.length, Math.max(0, admission.allow), ceilingRoom, budgetRoom);
  const reasons = [...admission.reasons];
  if (n < readyTasks.length) {
    if (ceilingRoom <= n) {
      reasons.push(`hard ceiling reached: ${ctx.live + n}/${ctx.hardCeiling} live agents`);
    }
    if (budgetRoom <= n) {
      reasons.push(`spawn budget exhausted: ${ctx.spawnsUsed + n}/${ctx.spawnBudget} spawns`);
    }
  }
  return { admit: readyTasks.slice(0, n), reasons };
}

/** One task `admitPlacing` admitted, and where. */
export interface PlacedAdmission {
  id: TaskId;
  placement: Placement;
  /** A placement to journal (`task_placed`): the wave places, or the task is `host: auto`. */
  placed: boolean;
}

/**
 * Admission for a wave that places its tasks (SPEC §4.6.15), as a pure function: the ready tasks
 * in order, each within the hard ceiling and the spawn budget, placed (`place`), then admitted by
 * its machine: the supervisor's own by the wave's verdict `gate` (its local allowance counted
 * down), a peer by the global signals of `gate` plus its own verdict (`hostGate`). Each admission
 * is reserved in the snapshot, so the next placement sees it (a heavy one takes its slots). A task
 * with no eligible machine, or whose machine holds starts, is `held` with why, and does not stop
 * the tasks after it. A closed gate (paused, kill switch, a global signal) admits nothing.
 */
export function admitPlacing(
  readyTasks: TaskId[],
  wave: Wave,
  snap: Snapshot,
  o: PlaceOptions,
  gate: Admission,
  hostGate: (host: string) => Admission,
  ctx: AdmitContext,
): {
  admit: PlacedAdmission[];
  held: Record<TaskId, string>;
  reasons: string[];
  budget: boolean;
  snapshot: Snapshot;
} {
  const global = forHost(gate, { allow: Number.POSITIVE_INFINITY, reasons: [] });
  const reasons = new Set(global.reasons);
  const admitted: PlacedAdmission[] = [];
  const held: Record<TaskId, string> = {};
  if (global.allow <= 0) {
    return { admit: admitted, held, reasons: [...reasons], budget: false, snapshot: snap };
  }
  let s = snap;
  let localLeft = gate.allow;
  let budget = false;
  for (const id of readyTasks) {
    const live = ctx.live + admitted.length;
    if (live >= ctx.hardCeiling) {
      reasons.add(`hard ceiling reached: ${live}/${ctx.hardCeiling} live agents`);
      break;
    }
    const used = ctx.spawnsUsed + admitted.length;
    if (used >= ctx.spawnBudget) {
      reasons.add(`spawn budget exhausted: ${used}/${ctx.spawnBudget} spawns`);
      budget = true;
      break;
    }
    const def = wave.tasks[id];
    if (def === undefined) continue;
    const p = place(def, wave, s, o);
    if (p.host === null) {
      held[id] = p.why;
      continue;
    }
    // A placement (not a task of a wave that does not opt in) is admitted by its machine.
    const placed = needsPlacement(def) || wave.placement === AUTO_HOST;
    const local = !placed || p.local;
    const v = local ? gate : forHost(gate, hostGate(p.host));
    if (v.allow <= 0 || (local && localLeft <= 0)) {
      held[id] = v.reasons.join("; ") || `${p.host}: no start allowed now`;
      continue;
    }
    s = reserve(s, p.host, def, wave);
    admitted.push({ id, placement: p, placed });
    if (local) localLeft--;
  }
  return { admit: admitted, held, reasons: [...reasons], budget, snapshot: s };
}

/** Agents one run of a task's pipeline spawns with no retry: one per stage (the gate spawns none). */
export function pipelineRoles(wave: Wave, task: TaskId): number {
  return (wave.tasks[task]?.stages ?? []).flat().filter((s) => s !== "merge_ready").length;
}

/**
 * The wave's spawn budget: its own `spawn_budget` (the hard override), else enough for every
 * role of every task's pipeline plus retry headroom (`spawn_budget_retry_headroom` of it, at
 * least `spawn_budget_retry_min`), or ceil(multiplier × task count) when that is more — so the
 * default always lets a wave finish with no retry at all, and the multiplier only raises it.
 * `raised` is what `raise by N` answers added (reducer `budget_raised`).
 */
export function spawnBudget(wave: Wave, multiplier: number, raised = 0): number {
  if (wave.spawn_budget !== undefined) return wave.spawn_budget + raised;
  const roles = wave.task_order.reduce((n, id) => n + pipelineRoles(wave, id), 0);
  const headroom = Math.max(
    DAEMON_DEFAULTS.spawn_budget_retry_min,
    Math.ceil(roles * DAEMON_DEFAULTS.spawn_budget_retry_headroom),
  );
  return Math.max(roles + headroom, Math.ceil(multiplier * wave.task_order.length)) + raised;
}

/** Spawns a wave has used or committed to: actual spawns plus admitted tasks not yet spawned. */
export function spawnsUsed(rec: WaveRecord): number {
  const spawned = new Set(
    rec.state?.tasks.filter((t) => Object.keys(t.agents).length > 0).map((t) => t.id) ?? [],
  );
  return rec.spawns + rec.admitted.filter((id) => !spawned.has(id)).length;
}
