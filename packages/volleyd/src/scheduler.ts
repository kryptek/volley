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
import type {
  PipelineStage,
  PlanCluster,
  TaskAgents,
  TaskId,
  TaskStage,
  TaskState,
  Wave,
} from "./types";

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
  /** The overlap plan's clusters and their room (`clusterRooms`); absent: no cluster cap. */
  clusters?: ClusterRooms;
}

/** Stages in which an admitted task no longer holds an agent slot. */
const SETTLED: ReadonlySet<TaskStage> = new Set(["merge_ready", "done", "cancelled"]);

/**
 * Longest dependency chain starting at each task (counting the task itself). A synthetic task (a
 * flake's fixer, SPEC §4.6.16) blocks tasks that wait on no dependency: it counts as one longer
 * than the longest chain, so it is scheduled first.
 */
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
  const synthetic = wave.task_order.filter((id) => wave.tasks[id]?.synthetic === true);
  if (synthetic.length > 0) {
    const longest = Math.max(
      0,
      ...wave.task_order.filter((id) => !synthetic.includes(id)).map((id) => memo[id] ?? 0),
    );
    for (const id of synthetic) memo[id] = longest + 1;
  }
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
 * critical path length (longest first), then by id. Tasks sharing files are kept apart by their
 * cluster's cap (`clusterRooms`), not by the order.
 */
export function ready(rec: WaveRecord): TaskId[] {
  const { wave, state } = rec;
  if (wave === null || state === null || state.status !== "running") return [];
  const stage = new Map(state.tasks.map((t) => [t.id, t.stage]));
  const cp = criticalPaths(wave);
  return state.tasks
    .filter(
      (t) =>
        t.stage === "queued" &&
        !rec.admitted.includes(t.id) &&
        (wave.tasks[t.id]?.after ?? []).every((d) => stage.get(d) === "done"),
    )
    .map((t) => t.id)
    .sort((a, b) => (cp[b] ?? 0) - (cp[a] ?? 0) || (a < b ? -1 : a > b ? 1 : 0));
}

/** Stages in which a cluster member holds one of its cluster's slots (SPEC §4.6.22). */
export const IN_FLIGHT: ReadonlySet<TaskStage> = new Set([
  "implement",
  "spec_review",
  "quality_review",
  "fixup",
]);

/** Each cluster of the overlap plan: who holds its slots, how many it has, how it runs now. */
export interface ClusterRooms {
  /** Each clustered task's cluster. */
  of: Record<TaskId, string>;
  clusters: Record<string, { cap: number; holding: TaskId[]; state: PlanCluster["state"] }>;
}

/**
 * Whether cluster member `t` holds a slot: in a stage from `implement` to `fixup`, admitted and
 * not spawned yet, or parked (blocked, awaiting a decision) after its implementer started. Under
 * `hold` a gated member (`merge_ready`) holds one too: queued members wait until it merges.
 */
function holdsSlot(rec: WaveRecord, t: TaskState, hold: boolean): boolean {
  if (IN_FLIGHT.has(t.stage)) return true;
  if (t.stage === "queued") return rec.admitted.includes(t.id);
  if (t.stage === "merge_ready") return hold;
  if (t.stage === "blocked" || t.stage === "awaiting_decision")
    return t.agents.implementer !== undefined;
  return false;
}

/**
 * The overlap plan's clusters with their effective cap: the plan's `cap` (none: unbounded), 1
 * under `hold`; `train` keeps the plan's. Empty without a plan.
 */
export function clusterRooms(rec: WaveRecord): ClusterRooms {
  const out: ClusterRooms = { of: {}, clusters: {} };
  const tasks = new Map(rec.state?.tasks.map((t) => [t.id, t]) ?? []);
  for (const c of rec.state?.overlap_plan?.clusters ?? []) {
    const hold = c.state === "hold";
    const cap = hold ? 1 : (c.strategy.cap ?? Number.POSITIVE_INFINITY);
    const holding = c.tasks.filter((id) => {
      const t = tasks.get(id);
      return t !== undefined && holdsSlot(rec, t, hold);
    });
    for (const id of c.tasks) out.of[id] = c.id;
    out.clusters[c.id] = { cap, holding, state: c.state };
  }
  return out;
}

/** How many more of `cluster`'s members may start now (unbounded: no cap, or no such cluster). */
export function clusterRoom(rec: WaveRecord, cluster: string): number {
  const c = clusterRooms(rec).clusters[cluster];
  return c === undefined ? Number.POSITIVE_INFINITY : Math.max(0, c.cap - c.holding.length);
}

/**
 * A gate over the ready tasks in order: `check(id)` is null when the task's cluster has room,
 * else why it holds the task (`cluster A: 4 in flight (…)`); `take(id)` gives an admitted task
 * its slot.
 */
function clusterGate(rooms: ClusterRooms | undefined): {
  check: (id: TaskId) => string | null;
  take: (id: TaskId) => void;
} {
  const holding = new Map(
    Object.entries(rooms?.clusters ?? {}).map(([c, r]) => [c, [...r.holding]]),
  );
  return {
    check: (id) => {
      const c = rooms?.of[id];
      const r = c === undefined ? undefined : rooms?.clusters[c];
      const held = c === undefined ? undefined : holding.get(c);
      if (c === undefined || r === undefined || held === undefined || held.length < r.cap)
        return null;
      const ids = [...held].sort().join(", ");
      return r.state === "hold"
        ? `cluster ${c} (hold): ${held.length} in flight or gated (${ids})`
        : `cluster ${c}: ${held.length} in flight (${ids})`;
    },
    take: (id) => {
      const c = rooms?.of[id];
      if (c !== undefined) holding.get(c)?.push(id);
    },
  };
}

/**
 * Pick which ready tasks to start: at most `admission.allow`, never past the hard ceiling or the
 * wave's spawn budget. Lowering a limit below current use admits nothing and preempts nothing.
 * `reasons` explains every limit that held a ready task back; `held` names each ready task its
 * cluster holds (`clusterRooms`), with why.
 */
export function admit(
  readyTasks: TaskId[],
  admission: Admission,
  ctx: AdmitContext,
): { admit: TaskId[]; held: Record<TaskId, string>; reasons: string[] } {
  const ceilingRoom = Math.max(0, ctx.hardCeiling - ctx.live);
  const budgetRoom = Math.max(0, ctx.spawnBudget - ctx.spawnsUsed);
  const limit = Math.min(Math.max(0, admission.allow), ceilingRoom, budgetRoom);
  // A member of a cluster with no room is held with why; the tasks after it are not. Only an
  // admitted task takes a slot: one the limits trim holds none, so no member is held in its name.
  const room = clusterGate(ctx.clusters);
  const held: Record<TaskId, string> = {};
  const admitted: TaskId[] = [];
  let eligible = 0;
  for (const id of readyTasks) {
    const why = room.check(id);
    if (why !== null) {
      held[id] = why;
      continue;
    }
    eligible++;
    if (admitted.length < limit) {
      room.take(id);
      admitted.push(id);
    }
  }
  const n = admitted.length;
  const reasons = [...admission.reasons];
  if (n < eligible) {
    if (ceilingRoom <= n) {
      reasons.push(`hard ceiling reached: ${ctx.live + n}/${ctx.hardCeiling} live agents`);
    }
    if (budgetRoom <= n) {
      reasons.push(`spawn budget exhausted: ${ctx.spawnsUsed + n}/${ctx.spawnBudget} spawns`);
    }
  }
  return { admit: admitted, held, reasons };
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
 * whose cluster has no room (`clusterRooms`, checked before placement), with no eligible machine,
 * or whose machine holds starts, is `held` with why, and does not stop the tasks after it. A
 * closed gate (paused, kill switch, a global signal) admits nothing.
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
  const room = clusterGate(ctx.clusters);
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
    // The cluster first: a task its cluster holds is not placed (nor held twice).
    const why = room.check(id);
    if (why !== null) {
      held[id] = why;
      continue;
    }
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
    room.take(id);
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

/** The agent a pipeline stage spawns (the gate spawns none). */
const STAGE_AGENT: Partial<Record<PipelineStage, keyof TaskAgents>> = {
  implement: "implementer",
  spec_review: "spec_reviewer",
  quality_review: "quality_reviewer",
  fixup: "fixup",
};

/**
 * Task stages that spawn nothing more. A `blocked` task can still come back through a respawn
 * decision; it counts 0 here like a rereview does (the min-share floor cushions both).
 */
const FINISHED = new Set<TaskStage>(["done", "merge_ready", "cancelled", "blocked"]);

/**
 * Spawns the wave's unfinished tasks still need to finish their pipelines: per task, every
 * implement and review stage from the one it is at (a parked task: where it resumes) that has
 * no agent yet, plus one fixup allowance. A queued task counts its whole pipeline.
 */
export function spawnsOutstanding(wave: Wave, rec: WaveRecord): number {
  let n = 0;
  for (const t of rec.state?.tasks ?? []) {
    const stages = wave.tasks[t.id]?.stages;
    if (stages === undefined) continue;
    let stage = t.stage;
    if (stage === "awaiting_decision")
      stage =
        Object.values(rec.decisions).find(
          (d) => d.task === t.id && d.resolved === undefined && d.resume_stage !== undefined,
        )?.resume_stage ?? "queued";
    if (FINISHED.has(stage)) continue;
    // A stage outside the stage groups (`fixup`, `rebase`, `queued`) finds -1 and counts the
    // whole pipeline from 0, on purpose: after a fixup the reviewers run again.
    const at = Math.max(
      0,
      stages.findIndex((g) => g.includes(stage as PipelineStage)),
    );
    for (const [i, group] of stages.entries()) {
      if (i < at) continue;
      for (const s of group) {
        const agent = STAGE_AGENT[s];
        if (agent === undefined || s === "fixup") continue;
        // Only the current group's agents count as spawned: a later group has none yet, and a
        // task back at review after a fixup reuses its role keys from round 1, so a rereview
        // counts 0 here and the raise comes out low (the min-share floor cushions it).
        if (i === at && t.agents[agent] !== undefined) continue;
        n++;
      }
    }
    n++; // the fixup allowance
  }
  return n;
}

/**
 * The `raise by <n>` a spawn_budget_exhausted decision offers: what the wave still needs
 * (`spawnsOutstanding`), at least `spawn_budget_raise_min_share` of the derived budget, capped
 * so `used + n` stays within `derived × raiseMax` (autopilot's `budget_raise_max`) while that
 * leaves room for one. Never less than 1. Once `used` is past that cap the owner is offered the
 * full need (not a raise by 0); autopilot's own `budget_raise_max` check still escalates it.
 */
export function budgetRaise(o: {
  outstanding: number;
  derived: number;
  used: number;
  raiseMax: number;
}): number {
  const want = Math.max(
    1,
    o.outstanding,
    Math.ceil(o.derived * DAEMON_DEFAULTS.spawn_budget_raise_min_share),
  );
  const room = Math.floor(o.derived * o.raiseMax) - o.used;
  return room >= 1 ? Math.min(want, room) : want;
}

/** Spawns a wave has used or committed to: actual spawns plus admitted tasks not yet spawned. */
export function spawnsUsed(rec: WaveRecord): number {
  const spawned = new Set(
    rec.state?.tasks.filter((t) => Object.keys(t.agents).length > 0).map((t) => t.id) ?? [],
  );
  return rec.spawns + rec.admitted.filter((id) => !spawned.has(id)).length;
}
