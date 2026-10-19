import { buildEnvelope } from "volley-mcp/envelope";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import { type AgentCredentials, revokeCredentials } from "./identity";
import { TERMINAL_STATUS, readLock } from "./locks";
import { SpawnError } from "./spawn-error";
import type { NewEvent, TaskId } from "./types";

/** The retained per-agent records volleyd clears (registry + five per-agent channels). */
export function retainedTopics(namespace: string, agentId: string): string[] {
  return [
    registryTopic(agentId),
    ...["status", "progress", "result", "capability", "screen"].map((c) =>
      buildTopic(namespace, agentId, c),
    ),
  ];
}

/**
 * Retire statuses that are not the agent's own: `moved` is an account move (claude/move.ts),
 * whose cancel stopped the session before its respawn under another profile; `stopped` is
 * `volleyd stop`, which retires the wave's agents at once (finding 13: no login outlives it).
 */
const DAEMON_ENDED: ReadonlySet<string> = new Set(["moved", "stopped"]);

/** Why volleyd deleted an agent's login, in its `reaped` status. */
export const CREDENTIALS_DELETED = "credentials_deleted";

export interface ReapDeps {
  credentials: AgentCredentials | undefined;
  /** Publish a retained message (the `reaped` status). */
  publishRetained: (topic: string, payload: string) => Promise<void>;
  /** Publish an empty retained payload (clears the record). */
  clearRetained: (topic: string) => Promise<void>;
  journal: (ev: NewEvent) => unknown | Promise<unknown>;
}

/**
 * The one way volleyd deletes an agent's login (retire, sweep, stop). Deleting a client
 * disconnects it WITHOUT its will (measured on 2.0.22 and 2.1.2), so nobody else would say it is gone:
 * volleyd publishes its retained `status: reaped { reason: "credentials_deleted" }` first, then
 * clears its retained records itself (registry, status, progress, result, capability, screen),
 * and only then deletes the login (batched with the other deletes of the moment). Journaled as
 * `agent_reaped_by_supervisor` and `credentials_revoked`. Returns whether the delete succeeded.
 */
export async function reapAndRevoke(
  agentId: string,
  namespace: string,
  deps: ReapDeps,
  task?: TaskId,
): Promise<boolean> {
  const status = buildEnvelope({
    agentId,
    parentId: null,
    channel: "status",
    type: "reaped",
    payload: { reason: CREDENTIALS_DELETED, by: "volleyd" },
  });
  await deps.publishRetained(buildTopic(namespace, agentId, "status"), JSON.stringify(status));
  for (const topic of retainedTopics(namespace, agentId)) await deps.clearRetained(topic);
  await deps.journal({
    type: "agent_reaped_by_supervisor",
    ...(task !== undefined ? { task } : {}),
    data: { agent_id: agentId, reason: CREDENTIALS_DELETED },
  });
  const revoked = await revokeCredentials(deps.credentials, agentId);
  await deps.journal({
    type: "credentials_revoked",
    ...(task !== undefined ? { task } : {}),
    data: { agent_id: agentId, ok: revoked },
  });
  return revoked;
}

export interface RetireRequest {
  wave: string;
  task: TaskId;
  role: string;
  agentId: string;
  namespace: string;
  /** The agent's terminal status type as the daemon consumed it, or `moved`/`stopped`. */
  status: string | null;
  /** Agent ids this wave spawned (from its journal). */
  waveAgents: ReadonlySet<string>;
  /** The agent's worktree lock, released if it still names this agent. */
  lockPath?: string;
  /** Whether a login was minted for it (no delete, and no `reaped`, otherwise). */
  minted: boolean;
  /** The terminal status envelope's payload (summary, pr_url, reason, …), kept in the journal. */
  terminal?: unknown;
  /** The agent's retained `result` payload, if it published one. */
  result?: unknown;
}

export interface RetireDeps extends ReapDeps {
  /** Remove the lock file at `path` (only called when it names this agent). */
  releaseLock: (path: string) => void;
}

/**
 * Retire one agent after the daemon has consumed its terminal status: delete its broker login
 * through reapAndRevoke (or, for an agent with none, just clear its retained records), release
 * its worktree lock, journal `agent_retired`. Only this wave's own agents, only terminal (or
 * moved / stopped) ones. The worktree, branch and workspace stay: removing them is
 * `volleyd cleanup <wave> --yes`.
 */
export async function retireAgent(req: RetireRequest, deps: RetireDeps): Promise<void> {
  if (!req.waveAgents.has(req.agentId)) {
    throw new SpawnError("RETIRE_REFUSED", `${req.agentId} is not an agent of wave ${req.wave}`, {
      agent_id: req.agentId,
    });
  }
  if (req.status === null || !(TERMINAL_STATUS.has(req.status) || DAEMON_ENDED.has(req.status))) {
    throw new SpawnError(
      "RETIRE_REFUSED",
      `${req.agentId} is not terminal (status ${req.status ?? "none"})`,
      { agent_id: req.agentId, status: req.status },
    );
  }
  let revoked: boolean | null = null;
  if (req.minted) {
    revoked = await reapAndRevoke(req.agentId, req.namespace, deps, req.task);
  } else {
    for (const topic of retainedTopics(req.namespace, req.agentId)) await deps.clearRetained(topic);
  }
  let released = false;
  if (req.lockPath !== undefined && readLock(req.lockPath)?.agent_id === req.agentId) {
    deps.releaseLock(req.lockPath);
    released = true;
  }
  await deps.journal({
    type: "agent_retired",
    task: req.task,
    data: {
      agent_id: req.agentId,
      role: req.role,
      status: req.status,
      credentials_revoked: revoked,
      lock_released: released,
      // The retained status/result are cleared above; the journal keeps what they said.
      ...(req.terminal !== undefined ? { terminal: req.terminal } : {}),
      ...(req.result !== undefined ? { result: req.result } : {}),
    },
  });
}
