import { DAEMON_DEFAULTS } from "./config-defaults";
import type { ExecFn } from "./exec";
import type { WaveRecord } from "./reducer";
import type { JournalEvent, TaskId, TaskStage, TaskState } from "./types";

/**
 * Restart reconciliation. On start the daemon has no live watch on any agent, so for every task
 * that is not settled and has an agent it compares what the journal says (stage, agent) with the
 * broker (retained registry entry + status, and a heartbeat seen while reconciling: the daemon
 * keeps none across a restart), the worktree lock, git (does the branch exist, its head) and
 * GitHub (a PR for the branch, its CI), and journals one
 * `reconciled { agent_id, drift, action?, branch }` per task:
 *
 *   consistent                                      → drift: [] (the agent is watched again)
 *   the agent reported done meanwhile + PR + CI green → mark_done_verified (PR recorded)
 *   anything that may still be alive, or done
 *     without a verified PR                         → re_wait (watched again; the normal
 *                                                     status path takes it from there)
 *   no registry, no status, no heartbeat, no lock   → respawn_needed → a decision
 *
 * Nothing is respawned automatically (the worktree locks make that impossible anyway). Pure.
 */

export type ReconcileAction = "mark_done_verified" | "re_wait" | "respawn_needed";

export interface TaskFacts {
  task: TaskId;
  stage: TaskStage;
  agent_id: string;
  role: string;
  /** A retained registry entry exists. */
  registered: boolean;
  /** The retained status type, or null when there is none. */
  status: string | null;
  /** Latest heartbeat (epoch ms), or null when none is known. */
  heartbeat_at: number | null;
  /** The worktree lock names this agent. */
  lock: boolean;
  /** `exists`/`head` are null when git could not be asked. */
  branch: { name: string; exists: boolean | null; head: string | null };
  pr: TaskState["pr"] | null;
}

export interface Reconciliation {
  task: TaskId;
  agent_id: string;
  drift: string[];
  action?: ReconcileAction;
  pr?: NonNullable<TaskState["pr"]>;
}

const LIVE = new Set(["spawning", "registered", "working", "blocked"]);
const SETTLED = new Set<TaskStage>(["done", "merge_ready", "cancelled"]);

export function reconcileTask(f: TaskFacts, now: number, staleMs: number): Reconciliation {
  const drift: string[] = [];
  const base = { task: f.task, agent_id: f.agent_id };
  if (f.branch.exists === false) drift.push(`branch ${f.branch.name} does not exist`);

  if (f.status === "done") {
    drift.push(`journal says ${f.stage}, but ${f.agent_id} reported done while volleyd was down`);
    if (f.pr != null && f.pr.ci === "green")
      return { ...base, drift, action: "mark_done_verified", pr: f.pr };
    drift.push(f.pr == null ? "no PR for its branch" : `PR #${f.pr.number} CI is ${f.pr.ci}`);
    return { ...base, drift, action: "re_wait" };
  }
  if (f.status === "failed") {
    drift.push(`${f.agent_id} reported failed while volleyd was down`);
    return { ...base, drift, action: "re_wait" };
  }

  const beat = f.heartbeat_at !== null && now - f.heartbeat_at < staleMs;
  const live = f.status !== null && LIVE.has(f.status);
  if (!f.registered) drift.push(`${f.agent_id} has no registry entry`);
  if (!live) drift.push(`${f.agent_id} status is ${f.status ?? "missing"}`);
  if (!f.lock) drift.push(`no lock names ${f.agent_id}`);

  if (!f.registered && !live && !beat && !f.lock) {
    if (f.heartbeat_at === null) drift.push(`no heartbeat from ${f.agent_id}`);
    return { ...base, drift, action: "respawn_needed" };
  }
  return drift.length === 0 ? { ...base, drift } : { ...base, drift, action: "re_wait" };
}

/** A task's current agent: the latest `agent_spawned` of its current role not yet retired. */
export interface ReconcileTarget {
  task: TaskId;
  stage: TaskStage;
  agent_id: string;
  /** The `agent_spawned` data (role, workspace, branch, lock, credentials, …). */
  spawned: Record<string, unknown>;
}

/**
 * Every unsettled task's current agents: per (task, role) the latest `agent_spawned` (an earlier
 * one was superseded), unless it was retired. In the journal order of each role's first spawn.
 */
export function reconcileTargets(
  rec: WaveRecord,
  events: readonly JournalEvent[],
): ReconcileTarget[] {
  const retired = new Set(
    events.filter((e) => e.type === "agent_retired").map((e) => e.data.agent_id as string),
  );
  const latest = new Map<string, JournalEvent & { task: TaskId }>();
  for (const e of events) {
    if (e.type !== "agent_spawned" || e.task === undefined) continue;
    latest.set(`${e.task}/${String(e.data.role)}`, { ...e, task: e.task });
  }
  const out: ReconcileTarget[] = [];
  for (const e of latest.values()) {
    const id = e.data.agent_id as string;
    if (retired.has(id)) continue;
    const t = rec.state?.tasks.find((x) => x.id === e.task);
    if (t === undefined || SETTLED.has(t.stage)) continue;
    out.push({ task: e.task, stage: t.stage, agent_id: id, spawned: e.data });
  }
  return out;
}

/** git and GitHub, as reconciliation asks them. Each answer may be null: unknown. */
export interface ReconcileProbes {
  branch(repo: string, branch: string): Promise<TaskFacts["branch"]>;
  pr(repo: string, branch: string): Promise<TaskState["pr"] | null>;
}

/** The probes over a fenced exec: `git rev-parse --verify`, `gh pr list --head`, `gh pr checks`. */
export function execProbes(exec: ExecFn): ReconcileProbes {
  return {
    async branch(repo, branch) {
      const r = await exec(
        ["git", "-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
        { timeoutMs: DAEMON_DEFAULTS.reconcile_probe_ms },
      ).catch(() => null);
      if (r === null || r.timedOut) return { name: branch, exists: null, head: null };
      const head = r.stdout.trim();
      if (r.code !== 0) return { name: branch, exists: false, head: null };
      return { name: branch, exists: head !== "" ? true : null, head: head !== "" ? head : null };
    },
    async pr(repo, branch) {
      const list = await exec(
        [
          "gh",
          "pr",
          "list",
          "--head",
          branch,
          "--state",
          "all",
          "--json",
          "number,url,headRefName,headRefOid",
        ],
        { cwd: repo, timeoutMs: DAEMON_DEFAULTS.reconcile_probe_ms },
      ).catch(() => null);
      if (list === null || list.code !== 0) return null;
      let prs: { number?: unknown; url?: unknown; headRefName?: unknown; headRefOid?: unknown }[];
      try {
        prs = JSON.parse(list.stdout);
      } catch {
        return null;
      }
      // gh has returned another branch's PR for --head: match the name exactly.
      const pr = Array.isArray(prs) ? prs.find((p) => p.headRefName === branch) : undefined;
      if (pr === undefined || typeof pr.number !== "number" || typeof pr.url !== "string")
        return null;
      const checks = await exec(["gh", "pr", "checks", String(pr.number), "--json", "bucket"], {
        cwd: repo,
        timeoutMs: DAEMON_DEFAULTS.reconcile_probe_ms,
      }).catch(() => null);
      return {
        number: pr.number,
        url: pr.url,
        ...(typeof pr.headRefOid === "string" ? { head_sha: pr.headRefOid } : {}),
        ci: ciOf(checks?.stdout ?? ""),
      };
    },
  };
}

/** `gh pr checks --json bucket` → the wave-state CI value. */
export function ciOf(stdout: string): "green" | "red" | "running" | "none" {
  let checks: { bucket?: unknown }[];
  try {
    checks = JSON.parse(stdout);
  } catch {
    return "none";
  }
  if (!Array.isArray(checks) || checks.length === 0) return "none";
  const buckets = checks.map((c) => c.bucket);
  if (buckets.some((b) => b === "fail" || b === "cancel")) return "red";
  if (buckets.some((b) => b === "pending")) return "running";
  return "green";
}
