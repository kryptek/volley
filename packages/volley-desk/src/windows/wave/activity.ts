/**
 * What a task is doing now, for its graph node and its task line (#451). The stage alone
 * misleads: `implement` lasts until CI is green, long after the implementer pushed and retired.
 * First match wins: an agent running (`implementing`, `reviewing`, `fixing`, `rebasing`); no agent
 * and a CI hold (`waiting for CI · 21/22 jobs`); a merge turn; a decision; merged or cancelled
 * (checked first, they are final); else the stage label. Pure, no React.
 */
import { ciPending } from "../../attention";
import type { AgentView, MergeQueueEntry, Role, WaveTask } from "../../store/types";
import { STAGE_LABEL, deskStage } from "./stages";

export type Activity = {
  kind: "agent" | "ci" | "merge" | "decision" | "ended" | "stage";
  /** The task line: `waiting for CI · 21/22 jobs`. */
  label: string;
  /** The graph node (132 px, ~15 chars beside the issue number): `waiting for CI · 21/22`, `merge turn`, `decision`; else the label. */
  node: string;
};

export interface ActivityCtx {
  /** The Desk's record for an agent id, if it has one. */
  agent: (id: string) => AgentView | undefined;
  queue?: readonly MergeQueueEntry[];
}

/** Terminal statuses (SPEC §5.2): the agent is gone. */
const ENDED = new Set(["done", "failed", "reaped"]);

/** A record the Desk holds whose last status is not done / failed / reaped (no status yet = alive). */
export function agentAlive(a: AgentView | undefined): boolean {
  return !!a && !ENDED.has(a.status?.type ?? "");
}

/** The latest role first: a fixup or a rebase runs after the implementer's record is kept. */
const ROLE_ORDER: readonly [Role, string][] = [
  ["rebase", "rebasing"],
  ["fixup", "fixing"],
  ["quality_reviewer", "reviewing"],
  ["spec_reviewer", "reviewing"],
  ["implementer", "implementing"],
];

const QUEUE_LABEL: Partial<Record<MergeQueueEntry["state"], [label: string, node: string]>> = {
  merging: ["merging", "merging"],
  updating: ["updating", "updating"],
  queued: ["waiting for a merge turn", "merge turn"],
};

const same = (kind: Activity["kind"], label: string): Activity => ({ kind, label, node: label });

export function taskActivity(t: WaveTask, ctx: ActivityCtx): Activity {
  if (t.stage === "done") return same("ended", "merged");
  if (t.stage === "cancelled") return same("ended", "cancelled");
  for (const [role, label] of ROLE_ORDER) {
    const id = t.agents[role];
    if (id !== undefined && agentAlive(ctx.agent(id))) return same("agent", label);
  }
  if (ciPending(t)) {
    const j = t.pr?.jobs;
    if (j && j.total > 0) {
      const node = `waiting for CI · ${j.done}/${j.total}`;
      return { kind: "ci", label: `${node} jobs`, node };
    }
    return same("ci", "waiting for CI");
  }
  const turn = ctx.queue?.find((e) => e.task === t.id);
  const q = turn && QUEUE_LABEL[turn.state];
  if (q) return { kind: "merge", label: q[0], node: q[1] };
  const stage = deskStage(t.stage);
  if (stage === "decision")
    return { kind: "decision", label: "waiting for a decision", node: "decision" };
  return same("stage", STAGE_LABEL[stage]);
}
