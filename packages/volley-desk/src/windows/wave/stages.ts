/**
 * The prototype's task `Stage` set, `STAGE_LABEL`/`STAGE_WEIGHT` and
 * `wavePct`, plus the mapping from volleyd's wave-state stages
 * (wave-state.schema.json `$defs/stage`) onto that set. The two parallel
 * reviews collapse into `review`; `blocked` and `awaiting_decision` both need
 * a human, so both show as `decision`.
 */
import type { Stage } from "../../store/types";

export type DeskStage =
  | "queued"
  | "implement"
  | "review"
  | "fixup"
  | "merge_ready"
  | "merged"
  | "decision";

export const DESK_STAGES: readonly DeskStage[] = [
  "queued",
  "implement",
  "review",
  "fixup",
  "merge_ready",
  "merged",
  "decision",
];

const FROM_VOLLEYD: Record<Stage, DeskStage> = {
  queued: "queued",
  implement: "implement",
  spec_review: "review",
  quality_review: "review",
  fixup: "fixup",
  merge_ready: "merge_ready",
  done: "merged",
  blocked: "decision",
  awaiting_decision: "decision",
  // A cancelled task never progresses; it reads as not started.
  cancelled: "queued",
};

/** Desk stage for a volleyd stage; an unknown (newer) stage reads as `queued`. */
export function deskStage(s: Stage): DeskStage {
  return FROM_VOLLEYD[s] ?? "queued";
}

export const STAGE_LABEL: Record<DeskStage, string> = {
  queued: "queued",
  implement: "implementing",
  review: "in review",
  fixup: "fixup",
  merge_ready: "merge-ready",
  merged: "merged",
  decision: "needs decision",
};

/** How far along a task in each stage is, 0–1; `wavePct` averages these. */
export const STAGE_WEIGHT: Record<DeskStage, number> = {
  queued: 0,
  implement: 0.3,
  review: 0.55,
  fixup: 0.7,
  merge_ready: 0.9,
  merged: 1,
  decision: 0.45,
};

/** Wave completion as a whole percentage: the mean task stage weight. */
export function wavePct(stages: readonly DeskStage[]): number {
  if (stages.length === 0) return 0;
  const sum = stages.reduce((n, s) => n + STAGE_WEIGHT[s], 0);
  return Math.round((sum / stages.length) * 100);
}
