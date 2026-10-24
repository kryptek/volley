/**
 * The agent window's pipeline list: implement → review → fixup → merge-ready.
 * The current step comes from the task's stage in the wave state; a stage
 * that is not a pipeline step (queued, blocked, awaiting a decision,
 * cancelled) falls back to the agent's own role step, marked `held`.
 * Classes follow the prototype: `done` before the current step, `cur` on it.
 * Beside them the depth classes of `styles/stepfx.css`: `fx-done`, `fx-cur`
 * (drawn with the chosen current-step effect) and `fx-future`.
 */
import type { Role, Stage } from "../../store/types";

export const PIPELINE_STEPS = ["implement", "review", "fixup", "merge-ready"] as const;

export const STAGE_STEP: Partial<Record<Stage, number>> = {
  implement: 0,
  spec_review: 1,
  quality_review: 1,
  fixup: 2,
  merge_ready: 3,
  done: PIPELINE_STEPS.length,
};

export const ROLE_STEP: Record<Role, number> = {
  implementer: 0,
  spec_reviewer: 1,
  quality_reviewer: 1,
  fixup: 2,
  // The rebase agent fixes the branch up after the release branch moved: the fixup step.
  rebase: 2,
  // A merge train's integrator implements its train task.
  integrator: 0,
};

export function Pipeline({
  stage,
  agentRole: role,
}: { stage: Stage | null; agentRole: Role | null }) {
  const fromStage = stage === null ? undefined : STAGE_STEP[stage];
  const held = fromStage === undefined;
  const cur = fromStage ?? (role === null ? -1 : ROLE_STEP[role]);
  return (
    <ol className="pipe" aria-label="Pipeline stage">
      {PIPELINE_STEPS.map((step, i) => {
        const cls = [
          i < cur && "done fx-done",
          i === cur && "cur fx-cur",
          i === cur && held && "held",
          i > cur && "fx-future",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <li
            key={step}
            className={cls}
            aria-label={step}
            aria-current={i === cur ? "step" : undefined}
          >
            {step}
          </li>
        );
      })}
    </ol>
  );
}
