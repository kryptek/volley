import { join } from "node:path";
import { buildEnvelope } from "volley-mcp/envelope";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import type { SessionEnd } from "./hosts/host";
import { type AgentCredentials, revokeCredentials } from "./identity";
import { TERMINAL_STATUS, readLock } from "./locks";
import { SpawnError } from "./spawn-error";
import type { NewEvent, TaskId } from "./types";

/** The retained per-agent records volleyd clears (registry + six per-agent channels). */
export function retainedTopics(namespace: string, agentId: string): string[] {
  return [
    registryTopic(agentId),
    ...["status", "progress", "result", "capability", "screen", "usage"].map((c) =>
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
 * disconnects it WITHOUT its will (measured on 2.0.22 and 2.1.2), so nobody else would say it is
 * gone: volleyd publishes its retained `status: reaped { reason: "credentials_deleted" }` first,
 * then clears its retained records itself (registry, status, progress, result, capability,
 * screen, usage), and only then deletes the login (batched with the other deletes of the moment).
 * A still connected agent can re-publish a record inside that window (a `stop` cancels it just
 * before), so once the login is gone, and the agent with it, the records are cleared once more.
 * Journaled as `agent_reaped_by_supervisor` and `credentials_revoked`. Returns whether the delete
 * succeeded.
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
  if (revoked)
    for (const topic of retainedTopics(namespace, agentId)) await deps.clearRetained(topic);
  await deps.journal({
    type: "credentials_revoked",
    ...(task !== undefined ? { task } : {}),
    data: { agent_id: agentId, ok: revoked },
  });
  return revoked;
}

/**
 * Run `jobs` so that the logins they delete go out together (`volleyd stop` deletes all of a
 * wave's logins at once). Each job runs alone until it finishes or asks to revoke a login; that
 * revoke is held. Once every job got that far, the held revokes are all sent in the same tick, so
 * the store's batch window carries them as one control message; then each held job finishes, one
 * at a time (a later revoke goes straight to the store). Rethrows the first job failure at the end.
 */
export async function withJointRevokes(
  credentials: AgentCredentials | undefined,
  jobs: readonly ((credentials: AgentCredentials | undefined) => Promise<unknown>)[],
): Promise<void> {
  const errors: unknown[] = [];
  const held: { id: string; done: (ok: boolean) => void; end: Promise<void> }[] = [];
  /** Set while a job runs in the first pass: where its revoke is parked. */
  let park: ((id: string, done: (ok: boolean) => void) => void) | null = null;
  const joint: AgentCredentials | undefined =
    credentials === undefined
      ? undefined
      : {
          mint: credentials.mint,
          revoke: (id) => {
            const p = park;
            return p === null ? credentials.revoke(id) : new Promise<boolean>((d) => p(id, d));
          },
        };
  for (const run of jobs) {
    let parked: { id: string; done: (ok: boolean) => void } | null = null;
    let onPark: () => void = () => {};
    const parkedNow = new Promise<void>((r) => {
      onPark = r;
    });
    park = (id, done) => {
      park = null;
      parked = { id, done };
      onPark();
    };
    const end = run(joint).then(
      () => {},
      (e: unknown) => {
        errors.push(e);
      },
    );
    await Promise.race([end, parkedNow]);
    park = null;
    const p = parked as { id: string; done: (ok: boolean) => void } | null;
    if (p !== null) held.push({ ...p, end });
  }
  if (credentials !== undefined && held.length > 0) {
    const results = await Promise.all(held.map((h) => credentials.revoke(h.id).catch(() => false)));
    for (const [i, h] of held.entries()) {
      h.done(results[i] === true);
      await h.end;
    }
  }
  if (errors.length > 0) throw errors[0];
}

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
  /** Whether a login was minted for it (no delete, and no `reaped`, otherwise). */
  minted: boolean;
  /** The terminal status envelope's payload (summary, pr_url, reason, …), kept in the journal. */
  terminal?: unknown;
  /** The agent's retained `result` payload, if it published one. */
  result?: unknown;
  /** The agent's workspace (cmux locally, its tmux session on an ssh host), closed on retire. */
  workspace?: string;
  /** The agent's worktree: where the retired marker goes, and whose processes are stopped. */
  worktree?: string;
}

/** `<worktree>/.volley/retired.json`: tells the agent's hooks that volleyd retired it (SPEC §4.6.4). */
export const retiredMarkerPath = (worktree: string): string =>
  join(worktree, ".volley", "retired.json");

export interface RetireDeps extends ReapDeps {
  /** Remove the lock file at `path` (only called when it names this agent). */
  releaseLock: (path: string) => void;
  /**
   * Write the retired marker (`{ agent_id, status }`, the caller adds `at`) at
   * retiredMarkerPath, on the agent's host, before its login is deleted.
   */
  writeMarker?: (worktree: string, marker: { agent_id: string; status: string }) => Promise<void>;
  /**
   * End the retired agent's session (through the fence, with its retire consent): close its
   * workspace and stop its processes. `workspace` in the answer: the ref actually closed, when it
   * is not the journaled one (re-found by name after a restart). `null`: the session is kept
   * (`retire_close_session: false`), journaled `workspace_closed: false`.
   */
  endSession?: SessionEnder | null;
}

/** Ends a retired agent's session: see RetireDeps.endSession. */
export type SessionEnder = (
  workspace: string | null,
  worktree: string | null,
) => Promise<SessionEnd & { workspace?: string | null }>;

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
 * Retire one agent after the daemon has consumed its terminal status: delete its broker login
 * through reapAndRevoke (or, for an agent with none, just clear its retained records), release
 * its worktree lock, journal `agent_retired`. Only this wave's own agents, only terminal (or
 * DAEMON_ENDED) ones. The retired marker is written first, so the agent's hooks stay quiet once
 * its login is gone; then its session is ended (`endSession`, the retire's own consent),
 * journaled `agent_session_closed` before `agent_retired`. The worktree and branch stay: removing
 * them is `volleyd cleanup <wave> --yes`.
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
  // Before the login goes: from here on a refused hook is the agent being retired, not broken.
  if (req.worktree !== undefined && deps.writeMarker !== undefined) {
    await deps
      .writeMarker(req.worktree, { agent_id: req.agentId, status: req.status })
      .catch(() => {});
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
  // Its session is over: close its workspace and stop its process (the worktree and branch stay).
  const workspace = req.workspace !== undefined && req.workspace !== "" ? req.workspace : null;
  let closed: boolean | null = null;
  if (deps.endSession === null) closed = workspace !== null ? false : null;
  else if (deps.endSession !== undefined && (workspace !== null || req.worktree !== undefined)) {
    const end: SessionEnd & { workspace?: string | null } = await deps
      .endSession(workspace, req.worktree ?? null)
      .catch(() => ({ closed: false, pids: [], how: "none" }));
    if (workspace !== null) closed = end.closed;
    await deps.journal({
      type: "agent_session_closed",
      task: req.task,
      data: {
        agent_id: req.agentId,
        workspace: end.workspace !== undefined ? end.workspace : workspace,
        how: end.how,
        pids: end.pids,
      },
    });
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
