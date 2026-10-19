import { buildTopic, registryTopic } from "volley-mcp/topics";
import type { ExecFn } from "./exec";
import { revokeCredentials } from "./identity";
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
 * `volleyd stop` (or a cancelled relaunch decision) retiring an agent that never acked;
 * `relaunched` is a spawn decision's `relaunch` replacing the agent with the next attempt.
 */
const DAEMON_ENDED: ReadonlySet<string> = new Set(["moved", "stopped", "relaunched"]);

export interface RetireRequest {
  wave: string;
  task: TaskId;
  role: string;
  agentId: string;
  namespace: string;
  /** The agent's terminal status type as the daemon consumed it, or a DAEMON_ENDED status. */
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
  /** The agent's workspace (cmux locally, its tmux session on an ssh host), closed on retire. */
  workspace?: string;
}

export interface RetireDeps {
  exec: ExecFn;
  /** Publish an empty retained payload (clears the record). */
  clearRetained: (topic: string) => Promise<void>;
  journal: (ev: NewEvent) => unknown | Promise<unknown>;
  /** Remove the lock file at `path` (only called when it names this agent). */
  releaseLock: (path: string) => void;
  /**
   * Close the retired agent's own workspace (through the fence, with its retire consent). `null`:
   * the ref cannot be trusted to still name it, so it is left for `volleyd cleanup --yes`
   * (journaled `workspace_closed: false`).
   */
  closeWorkspace?: ((workspace: string) => Promise<void>) | null;
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * May a workspace ref read back from the journal (an agent the daemon no longer supervises, e.g.
 * after a restart) still be closed? Only one that cannot have been handed to another session
 * meanwhile: a UUID, or the agent's own tmux session (`sessionName` of its `<wave> <task> <role>`
 * title, with free-name suffix `-<n>`). A short cmux ref (`workspace:<n>`) may since name anyone's
 * workspace — the owner's own included. Pure.
 */
export function closableAfterRestart(ref: string, session: string): boolean {
  return UUID.test(ref) || ref === session || new RegExp(`^${session}-\\d+$`).test(ref);
}

/**
 * Retire one agent after the daemon has consumed its terminal status: revoke its broker
 * credentials, clear its retained records, release its worktree lock, journal `agent_retired`.
 * Only this wave's own agents, only terminal (or DAEMON_ENDED) ones. Its workspace is closed
 * (`closeWorkspace`, the retire's own consent); the worktree and branch stay: removing them is
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
  const revoked = req.minted ? await revokeCredentials(deps.exec, req.agentId) : null;
  for (const topic of retainedTopics(req.namespace, req.agentId)) await deps.clearRetained(topic);
  let released = false;
  if (req.lockPath !== undefined && readLock(req.lockPath)?.agent_id === req.agentId) {
    deps.releaseLock(req.lockPath);
    released = true;
  }
  // Its session is over: close its workspace too (the worktree and branch stay for cleanup).
  let closed: boolean | null = null;
  if (req.workspace !== undefined && req.workspace !== "" && deps.closeWorkspace !== undefined) {
    try {
      if (deps.closeWorkspace === null) closed = false;
      else {
        await deps.closeWorkspace(req.workspace);
        closed = true;
      }
    } catch {
      closed = false;
    }
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
      ...(closed !== null ? { workspace: req.workspace, workspace_closed: closed } : {}),
      // The retained status/result are cleared above; the journal keeps what they said.
      ...(req.terminal !== undefined ? { terminal: req.terminal } : {}),
      ...(req.result !== undefined ? { result: req.result } : {}),
    },
  });
}
