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

/** The wave's spawn budget: its own `spawn_budget`, else ceil(multiplier × task count). */
export function spawnBudget(wave: Wave, multiplier: number): number {
  return wave.spawn_budget ?? Math.ceil(multiplier * wave.task_order.length);
}

/** Spawns a wave has used or committed to: actual spawns plus admitted tasks not yet spawned. */
export function spawnsUsed(rec: WaveRecord): number {
  const spawned = new Set(
    rec.state?.tasks.filter((t) => Object.keys(t.agents).length > 0).map((t) => t.id) ?? [],
  );
  return rec.spawns + rec.admitted.filter((id) => !spawned.has(id)).length;
}
