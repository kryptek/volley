/**
 * The agent window's pipeline list: implement → review → fixup → merge-ready.
 * The current step comes from the task's stage in the wave state; a stage
 * that is not a pipeline step (queued, blocked, awaiting a decision,
 * cancelled) falls back to the agent's own role step, marked `is-held`.
 */
import type { Role, Stage } from "../../store/types";

export const PIPELINE_STEPS = ["implement", "review", "fixup", "merge-ready"] as const;

const STAGE_STEP: Partial<Record<Stage, number>> = {
  implement: 0,
  spec_review: 1,
  quality_review: 1,
  fixup: 2,
  merge_ready: 3,
  done: PIPELINE_STEPS.length,
};

const ROLE_STEP: Record<Role, number> = {
  implementer: 0,
  spec_reviewer: 1,
  quality_reviewer: 1,
  fixup: 2,
};

export function Pipeline({
  stage,
  agentRole: role,
}: { stage: Stage | null; agentRole: Role | null }) {
  const fromStage = stage === null ? undefined : STAGE_STEP[stage];
  const held = fromStage === undefined;
  const cur = fromStage ?? (role === null ? -1 : ROLE_STEP[role]);
  const mine = role === null ? -1 : ROLE_STEP[role];
  return (
    <ol className="pipe">
      {PIPELINE_STEPS.map((step, i) => {
        const cls = [
          "pipe-step",
          i < cur && "is-done",
          i === cur && "is-cur",
          i === cur && held && "is-held",
          i === mine && "is-mine",
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
            <i />
            {step}
          </li>
        );
      })}
    </ol>
  );
}
