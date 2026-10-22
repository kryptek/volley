import type { Role } from "../brief";
import type { AgentMcp, JournalEvent, NewEvent, TaskId } from "../types";

/**
 * `agent_move_account { agent, acct }`: move a running agent to another Claude account profile.
 * Never silent: the move is journaled (`agent_account_moved`, mirrored on the wave's events)
 * before anything happens, then the agent is cancelled (mailbox `cancel` + Escape), and once it
 * has stopped it is retired (`moved`) and respawned under the other profile — a new attempt in
 * the same worktree, with a resume note at the end of its brief. An agent that does not stop in
 * time is left alone (an alarm, no respawn): two sessions never share a worktree.
 */

export interface MoveRequest {
  wave: string;
  task: TaskId;
  role: Role;
  agentId: string;
  /** The account it runs under now. */
  from: string;
  to: { id: string; dir: string | null };
  by: string;
}

export interface MoveDeps {
  journal: (ev: NewEvent) => Promise<unknown>;
  /** Cancel the agent: the mailbox `cancel` with `text`, then interrupt it. */
  cancel: (text: string) => Promise<void>;
  /** Resolves true once the agent published a terminal status (or its session ended). */
  waitStopped: () => Promise<boolean>;
  retire: () => Promise<void>;
  respawn: (r: {
    account: { id: string; dir: string | null };
    resumeNote: string;
  }) => Promise<{ agentId: string | null; decision?: string }>;
}

export type MoveResult =
  | {
      ok: true;
      /** The new attempt; null when the respawn stopped at a decision (its profile's trust). */
      agent_id: string | null;
      decision?: string;
      from: string;
      to: string;
    }
  | { ok: false; error: string };

/** The note a moved agent's new session finds at the end of its brief. */
export function resumeNote(m: { agentId: string; from: string; to: string }): string {
  return [
    "## Resume after an account move",
    "",
    `This task was already in progress as \`${m.agentId}\` under Claude account \`${m.from}\`. The operator moved it to Claude account \`${m.to}\`; that session was stopped, and this one picks the work up.`,
    "",
    "Your worktree is as that session left it: start with `git status` and `git log --oneline` to see what is committed and what is not, read any notes it left, and continue from there. Do not start over, and do not redo work that is already committed.",
  ].join("\n");
}

export async function moveAgentAccount(m: MoveRequest, d: MoveDeps): Promise<MoveResult> {
  if (m.from === m.to.id)
    return { ok: false, error: `${m.agentId} already runs under Claude account '${m.to.id}'` };
  await d.journal({
    type: "agent_account_moved",
    task: m.task,
    data: { agent_id: m.agentId, role: m.role, from: m.from, to: m.to.id, by: m.by },
  });
  await d.cancel(
    `volleyd: the operator is moving you to Claude account ${m.to.id}. Stop now: do not push, open or merge anything further; commit nothing half-done, publish your terminal status and exit. A new session under that account continues the task.`,
  );
  if (!(await d.waitStopped())) {
    await d.journal({
      type: "alarm_raised",
      task: m.task,
      data: {
        code: "ACCOUNT_MOVE_STOP_TIMEOUT",
        agent_id: m.agentId,
        role: m.role,
        to: m.to.id,
        message: `${m.agentId} did not stop after the cancel; not respawned under '${m.to.id}'`,
      },
    });
    return {
      ok: false,
      error: `${m.agentId} did not stop in time; it was cancelled but not respawned under '${m.to.id}'`,
    };
  }
  await d.retire();
  const next = await d.respawn({
    account: m.to,
    resumeNote: resumeNote({ agentId: m.agentId, from: m.from, to: m.to.id }),
  });
  return {
    ok: true,
    agent_id: next.agentId,
    ...(next.decision !== undefined ? { decision: next.decision } : {}),
    from: m.from,
    to: m.to.id,
  };
}

/**
 * What a respawn of a moved or vanished agent carries over from its `agent_spawned` record: its
 * MCP servers (`agent_mcp` and, under `inherit`, `agent_mcp_allow`, whatever the tunables say
 * now), and for a pipeline role (reviewer,
 * fixup, rebase) its start point and its own per-attempt worktree, where its `.volley/` inputs
 * (review.md, findings.md, rebase.md, …) still are, plus a merge-mode rebase step's merge brief.
 * An implementer's worktree is per role, so it needs neither.
 */
export function moveRespawn(spawned: Record<string, unknown> | undefined): {
  start?: { ref: string; detach: boolean };
  worktreeAttempt?: number;
  branch_update?: "merge";
  agent_mcp?: AgentMcp;
  agent_mcp_allow?: string[];
} {
  if (spawned === undefined) return {};
  const allow = Array.isArray(spawned.agent_mcp_allow)
    ? spawned.agent_mcp_allow.filter((n): n is string => typeof n === "string")
    : [];
  const mcp =
    spawned.agent_mcp === "inherit"
      ? { agent_mcp: "inherit" as const, agent_mcp_allow: allow }
      : { agent_mcp: "strict" as const };
  if (typeof spawned.start !== "string") return mcp;
  return {
    ...mcp,
    start: { ref: spawned.start, detach: spawned.detached === true },
    // A moved agent moved again: its worktree is still the first attempt's.
    ...(typeof spawned.worktree_attempt === "number"
      ? { worktreeAttempt: spawned.worktree_attempt }
      : typeof spawned.attempt === "number"
        ? { worktreeAttempt: spawned.attempt }
        : {}),
    ...(spawned.branch_update === "merge" ? { branch_update: "merge" as const } : {}),
  };
}

/** Each task role's latest move (`<task>/<role>` → account id), replayed from a wave journal. */
export function accountMoves(events: readonly JournalEvent[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of events) {
    if (e.type !== "agent_account_moved" || e.task === undefined) continue;
    const { role, to } = e.data as { role?: unknown; to?: unknown };
    if (typeof role === "string" && typeof to === "string") out[`${e.task}/${role}`] = to;
  }
  return out;
}
