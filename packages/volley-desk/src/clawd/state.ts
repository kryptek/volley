/**
 * Which Clawd an agent window shows, from what the window already knows: the
 * agent's status and attention, its task's stage, its attention tier, whether
 * it has no signal and whether it is a session. Rest states win over steps
 * (first match wins):
 *
 * 1. a `blocked` status: `needs_you` when the tier is `you`, else `dozing`
 *    (the classic ring shows `blocked` as failed; the character only asks
 *    for you when it is you it waits on). Only a live `blocked` status
 *    counts: once a blocked agent is reaped, `markStatus` reads the earlier
 *    `blocked` as failed and so does rule 2, like the classic ring;
 * 2. `markStatus` failed (a `failed` status, or reaped while working): `failed`;
 * 3. attention tier `you`: `needs_you`;
 * 4. waiting on a person who is not you (`attention` set, not a background
 *    wait): `dozing`;
 * 5. stage `merge_ready`: `merge_ready`;
 * 6. `markStatus` done or stage `done`: `done`;
 * 7. a held stage, nothing started yet, no signal, or a session whose hooks
 *    say idle: `dozing` (a `rebase` agent works outside the task's stage
 *    flow, so a held stage does not rest it: it falls through to its role);
 * 8. the stage's pipeline step (`STAGE_STEP`), else 9. the role's
 *    (`ROLE_STEP`), else 10. `implement`.
 */
import type { Tier } from "../attention";
import type { AgentView, Stage } from "../store/types";
import { ROLE_STEP, STAGE_STEP } from "../windows/agent/Pipeline";
import { markStatus } from "../windows/agent/markStatus";
import type { ClawdState } from "./variants";

export interface ClawdInput {
  agent: Pick<AgentView, "status" | "feed" | "attention" | "role" | "work">;
  /** The agent's task's stage; `null` without a task. */
  stage: Stage | null;
  tier: Tier;
  /** The agent has no signal (`noSignalFor` kind `mcp`). */
  noSignal: boolean;
  /** An interactive session (`isSession`): its hooks' work log says whether it works. */
  session: boolean;
}

const HELD: ReadonlySet<Stage> = new Set(["queued", "blocked", "awaiting_decision", "cancelled"]);
/** The pipeline steps that have a working sprite, by `STAGE_STEP` / `ROLE_STEP` index. */
const STEP_STATE: readonly ClawdState[] = ["implement", "review", "fixup"];

export function clawdState({ agent, stage, tier, noSignal, session }: ClawdInput): ClawdState {
  if (agent.status?.type === "blocked") return tier === "you" ? "needs_you" : "dozing";
  const mark = markStatus(agent);
  if (mark === "failed") return "failed";
  if (tier === "you") return "needs_you";
  if (agent.attention && !agent.attention.backgroundWait) return "dozing";
  if (stage === "merge_ready") return "merge_ready";
  if (mark === "done" || stage === "done") return "done";
  // A session reports no status of its own: its hooks say whether it works.
  const resting = session ? agent.work?.state === "idle" : mark === "pending";
  const held = stage !== null && HELD.has(stage) && agent.role !== "rebase";
  if (held || resting || noSignal) return "dozing";
  const step =
    (stage === null ? undefined : STAGE_STEP[stage]) ??
    (agent.role === null ? undefined : ROLE_STEP[agent.role]);
  return (step === undefined ? undefined : STEP_STATE[step]) ?? "implement";
}
