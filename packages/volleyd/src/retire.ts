import { buildTopic, registryTopic } from "volley-mcp/topics";
import type { ExecFn } from "./exec";
import { revokeCredentials } from "./identity";
import { TERMINAL_STATUS, readLock } from "./locks";
import { SpawnError } from "./spawn-error";
import type { NewEvent, TaskId } from "./types";

/** The retained per-agent records a retire clears (registry + four retained channels). */
export function retainedTopics(namespace: string, agentId: string): string[] {
  return [
    registryTopic(agentId),
    ...["status", "result", "capability", "screen"].map((c) => buildTopic(namespace, agentId, c)),
  ];
}

export interface RetireRequest {
  wave: string;
  task: TaskId;
  role: string;
  agentId: string;
  namespace: string;
  /** The agent's terminal status type as the daemon consumed it. */
  status: string | null;
  /** Agent ids this wave spawned (from its journal). */
  waveAgents: ReadonlySet<string>;
  /** The agent's worktree lock, released if it still names this agent. */
  lockPath?: string;
  /** Whether credentials were minted for it (`volley auth rm-agent` is skipped otherwise). */
  minted: boolean;
  /** The terminal status envelope's payload (summary, pr_url, reason, …), kept in the journal. */
  terminal?: unknown;
  /** The agent's retained `result` payload, if it published one. */
  result?: unknown;
}

export interface RetireDeps {
  exec: ExecFn;
  /** Publish an empty retained payload (clears the record). */
  clearRetained: (topic: string) => Promise<void>;
  journal: (ev: NewEvent) => unknown | Promise<unknown>;
  /** Remove the lock file at `path` (only called when it names this agent). */
  releaseLock: (path: string) => void;
}

/**
 * Retire one agent after the daemon has consumed its terminal status: revoke its broker
 * credentials, clear its retained records, release its worktree lock, journal `agent_retired`.
 * Only this wave's own agents, only terminal ones. The worktree, branch and workspace stay:
 * removing them is `volleyd cleanup <wave> --yes`.
 */
export async function retireAgent(req: RetireRequest, deps: RetireDeps): Promise<void> {
  if (!req.waveAgents.has(req.agentId)) {
    throw new SpawnError("RETIRE_REFUSED", `${req.agentId} is not an agent of wave ${req.wave}`, {
      agent_id: req.agentId,
    });
  }
  if (req.status === null || !TERMINAL_STATUS.has(req.status)) {
    throw new SpawnError(
      "RETIRE_REFUSED",
      `${req.agentId} is not terminal (status ${req.status ?? "none"})`,
      { agent_id: req.agentId, status: req.status },
    );
  }
  const revoked = req.minted ? await revokeCredentials(deps.exec, req.agentId) : null;
  for (const topic of retainedTopics(req.namespace, req.agentId)) await deps.clearRetained(topic);
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
