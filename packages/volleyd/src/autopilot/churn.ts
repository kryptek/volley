import { DAEMON_DEFAULTS } from "../config-defaults";
import type { WaveRecord } from "../reducer";
import { IN_FLIGHT } from "../scheduler";
import type { JournalEvent, PlanCluster, TaskId } from "../types";

/**
 * The churn monitor (SPEC §4.6.22): how much the overlap plan's clusters churn at run time — each
 * task's branch updates and the re-reviews they cost, each cluster's gated members and merges —
 * reduced from the wave's journal, and the strategy a cluster that churns anyway switches to.
 * Pure: the daemon's tick journals the switch (`cluster_strategy_changed`).
 */

/**
 * One task's churn: branch updates (`stage_entered { rebase: true }`), in all and in the window
 * (`churn_window_ms`), and reviews after one. `updates` and `rereviews` are for observability
 * (status, the digest): `strategyFor` reads `updates_in_window` only.
 */
export interface TaskChurn {
  updates: number;
  updates_in_window: number;
  rereviews: number;
}

/**
 * One cluster's churn now: members gated and in flight, merges and updates in the window
 * (`churn_window_ms`). `in_flight` is for observability: `strategyFor` does not read it.
 */
export interface ClusterChurn {
  gated: number;
  in_flight: number;
  merges_in_window: number;
  updates_in_window: number;
}

export interface Churn {
  tasks: Record<TaskId, TaskChurn>;
  clusters: Record<string, ClusterChurn>;
  /** Tasks done or cancelled: their updates no longer put a cluster on hold. */
  settled: TaskId[];
}

/** How a cluster runs: as planned, on hold (one member at a time), or as a merge train. */
export type ClusterStrategy = PlanCluster["state"];

const REVIEW = new Set(["spec_review", "quality_review"]);
const MERGED = new Set(["merged_by_supervisor", "merged_by_operator"]);

/** The wave's churn from its journal `events` and record, its windows ending at `now` (epoch ms). */
export function churnOf(rec: WaveRecord, events: readonly JournalEvent[], now: number): Churn {
  const since = now - DAEMON_DEFAULTS.churn_window_ms;
  const tasks: Record<TaskId, TaskChurn> = {};
  for (const t of rec.state?.tasks ?? [])
    tasks[t.id] = { updates: 0, updates_in_window: 0, rereviews: 0 };
  /** Tasks whose branch was updated since their last review started. */
  const updated = new Set<TaskId>();
  const recentUpdates = new Map<TaskId, number>();
  const recentMerges = new Set<TaskId>();
  for (const e of events) {
    const id = e.task;
    if (id === undefined) continue;
    const recent = Date.parse(e.at) > since;
    if (e.type === "stage_entered" && e.data.rebase === true) {
      const t = tasks[id];
      if (t !== undefined) {
        t.updates++;
        if (recent) t.updates_in_window++;
      }
      updated.add(id);
      if (recent) recentUpdates.set(id, (recentUpdates.get(id) ?? 0) + 1);
    } else if (e.type === "stage_entered" && REVIEW.has(String(e.data.stage))) {
      const t = tasks[id];
      if (t !== undefined && updated.delete(id)) t.rereviews++;
    } else if (MERGED.has(e.type) && recent) {
      recentMerges.add(id);
    }
  }
  const stage = new Map(rec.state?.tasks.map((t) => [t.id, t.stage]) ?? []);
  const clusters: Record<string, ClusterChurn> = {};
  for (const c of rec.state?.overlap_plan?.clusters ?? []) {
    const at = c.tasks.map((id) => stage.get(id));
    clusters[c.id] = {
      gated: at.filter((s) => s === "merge_ready").length,
      in_flight: at.filter((s) => s !== undefined && IN_FLIGHT.has(s)).length,
      merges_in_window: c.tasks.filter((id) => recentMerges.has(id)).length,
      updates_in_window: c.tasks.reduce((n, id) => n + (recentUpdates.get(id) ?? 0), 0),
    };
  }
  const settled = [...stage].filter(([, s]) => s === "done" || s === "cancelled").map(([id]) => id);
  return { tasks, clusters, settled };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The churn window as a why says it: `the last 2 h` (whole hours), else in minutes. */
function lastWindow(): string {
  const min = DAEMON_DEFAULTS.churn_window_ms / 60_000;
  return min % 60 === 0 ? `the last ${min / 60} h` : `the last ${Math.round(min)} min`;
}

/**
 * The strategy `cluster` should run under now, and why. `hold` when a live member has updated its
 * branch `churn_updates_hold` times in the window, or `churn_gated_hold` members are gated and fewer than
 * `churn_merges_floor` merged in the window; else `train` with `churn_gated_train` gated; back to
 * `planned` once nothing is gated and no member updated in the window; else as it is.
 */
export function strategyFor(
  cluster: PlanCluster,
  churn: Churn,
): { strategy: ClusterStrategy; why: string } {
  const stats = churn.clusters[cluster.id];
  if (stats === undefined) return { strategy: cluster.state, why: "not in the plan" };
  const churning = cluster.tasks
    .filter((id) => !churn.settled.includes(id))
    .find((id) => (churn.tasks[id]?.updates_in_window ?? 0) >= DAEMON_DEFAULTS.churn_updates_hold);
  if (churning !== undefined)
    return {
      strategy: "hold",
      why: `${churning} updated its branch ${churn.tasks[churning]?.updates_in_window} times in ${lastWindow()}`,
    };
  if (
    stats.gated >= DAEMON_DEFAULTS.churn_gated_hold &&
    stats.merges_in_window < DAEMON_DEFAULTS.churn_merges_floor
  )
    return {
      strategy: "hold",
      why: `${stats.gated} gated, ${plural(stats.merges_in_window, "merge")} in ${lastWindow()}`,
    };
  if (stats.gated >= DAEMON_DEFAULTS.churn_gated_train)
    return { strategy: "train", why: `${stats.gated} gated` };
  if (stats.gated === 0 && stats.updates_in_window === 0)
    return { strategy: "planned", why: `nothing gated, no branch update in ${lastWindow()}` };
  return { strategy: cluster.state, why: "unchanged" };
}

/** The plan's own strategy for `cluster`, as `cluster_strategy_changed` names it. */
export function plannedName(cluster: PlanCluster): "collapse" | "chain" | "cap" | "independent" {
  const s = cluster.strategy;
  if (s.cap !== undefined) return "cap";
  if (s.chain !== undefined && s.chain.length > 0) return "chain";
  if (s.collapse !== undefined && s.collapse.length > 0) return "collapse";
  return "independent";
}

/**
 * The `cluster_strategy_changed` data to journal for `cluster` now, or null: none when its
 * strategy stays, or when it last changed less than `minIntervalMs` before `now` (hysteresis). A
 * `planned` strategy is named by the plan's own (`plannedName`).
 */
export function strategySwitch(
  cluster: PlanCluster,
  churn: Churn,
  events: readonly JournalEvent[],
  now: number,
  minIntervalMs: number,
): { from: string; to: string; why: string } | null {
  const next = strategyFor(cluster, churn);
  if (next.strategy === cluster.state) return null;
  const last = [...events]
    .reverse()
    .find((e) => e.type === "cluster_strategy_changed" && e.data.cluster === cluster.id);
  if (last !== undefined && now - Date.parse(last.at) < minIntervalMs) return null;
  const name = (s: ClusterStrategy) => (s === "planned" ? plannedName(cluster) : s);
  return { from: name(cluster.state), to: name(next.strategy), why: next.why };
}

/** What the churn fuse does now for a task (#387): hold its cluster, ask the owner, or nothing. */
export type FuseStep = "hold" | "decide" | null;

/**
 * The churn fuse (SPEC §4.6.16): churn spends no spawn budget, so a task whose churn spawns are
 * more than `churn_roles_multiple_max` × its pipeline `roles` (and more than `quietUntil`, the
 * churn it last acted on) puts its cluster on `hold`; churn that goes on while the cluster is held
 * opens one `churn_exhausted` decision, never a second while one is `open`. Pure.
 */
export function churnFuse(o: {
  churn: number;
  roles: number;
  held: boolean;
  quietUntil: number;
  open: boolean;
}): FuseStep {
  const limit = DAEMON_DEFAULTS.churn_roles_multiple_max * o.roles;
  if (o.churn <= limit || o.churn <= o.quietUntil || o.open) return null;
  return o.held ? "decide" : "hold";
}

/**
 * The churn up to which `task`'s fuse stays quiet: `limit` at first, then the churn the fuse last
 * acted on (its hold's `cluster_strategy_changed { churn }`, or its decision's), and `limit` more
 * once the owner answered that decision `continue`.
 */
export function fuseQuietUntil(
  events: readonly JournalEvent[],
  task: TaskId,
  limit: number,
): number {
  let quiet = limit;
  const asked = new Map<string, number>();
  for (const e of events) {
    if (e.task !== task) continue;
    const n = e.data.churn;
    if (e.type === "cluster_strategy_changed" && typeof n === "number") quiet = Math.max(quiet, n);
    else if (
      e.type === "decision_opened" &&
      e.data.kind === "churn_exhausted" &&
      typeof n === "number"
    ) {
      quiet = Math.max(quiet, n);
      asked.set(String(e.data.decision_id), n);
    } else if (e.type === "decision_resolved" && asked.has(String(e.data.decision_id))) {
      const at = asked.get(String(e.data.decision_id)) as number;
      if (String(e.data.answer).trim().toLowerCase() === "continue")
        quiet = Math.max(quiet, at + limit);
    }
  }
  return quiet;
}
