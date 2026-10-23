import { RELEASE_TASK } from "./autopilot/release-train";
import type { ChurnBy, JournalEvent, TaskId } from "./types";

/**
 * Productive versus churn spawns (#387). A spawn is churn when it only pays for an overlap or a
 * failure: a branch update (`rebase`), a merge train (`integrator`, and its own task's roles), a
 * review round (and its fixup) a branch update caused, or a relaunch, respawn or retry of a role
 * that already ran in its step. Everything else is productive: a role's run in its pipeline,
 * including a fixup of findings and the review round after it. Churn is journaled
 * (`agent_spawned { churn: true, cause }`), counted apart and never spends the spawn budget. Pure.
 */

/** Why a churn spawn ran (`agent_spawned.data.cause`). */
export type ChurnCause = "branch_update" | "rereview" | "train" | "retry";

export const emptyChurnBy = (): ChurnBy => ({
  branch_updates: 0,
  rereviews: 0,
  retries: 0,
  trains: 0,
});

/** Each cause's key in `ChurnBy`. */
export const CHURN_BY_KEY: Record<ChurnCause, keyof ChurnBy> = {
  branch_update: "branch_updates",
  rereview: "rereviews",
  retry: "retries",
  train: "trains",
};

export const isChurnCause = (x: unknown): x is ChurnCause =>
  typeof x === "string" && Object.hasOwn(CHURN_BY_KEY, x);

/**
 * A spawn's churn cause, or null when it is productive: the pipeline's own `cause` (a re-review,
 * a train's role), else its role's (`rebase`, `integrator`), else `retry` when it repeats a run
 * (`repeatsRun`, or a launch after failures).
 */
export function churnCause(spawn: {
  role: string;
  cause?: ChurnCause | undefined;
  retry?: boolean;
}): ChurnCause | null {
  if (spawn.cause !== undefined) return spawn.cause;
  if (spawn.role === "rebase") return "branch_update";
  if (spawn.role === "integrator") return "train";
  return spawn.retry === true ? "retry" : null;
}

/**
 * Whether a spawn of `role` for `task` repeats a run: the role already spawned since the step it
 * belongs to started (a `stage_entered` naming it in `roles`). An implementer's step is the
 * task's start, so any earlier implementer of the task is a repeat. The release train's stages
 * are not pipeline steps and never repeat here.
 */
export function repeatsRun(events: readonly JournalEvent[], task: TaskId, role: string): boolean {
  if (task === RELEASE_TASK) return false;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as JournalEvent;
    if (e.task !== task) continue;
    if (e.type === "agent_spawned" && e.data.role === role) return true;
    if (
      e.type === "stage_entered" &&
      Array.isArray(e.data.roles) &&
      (e.data.roles as unknown[]).includes(role)
    )
      return false;
  }
  return false;
}
