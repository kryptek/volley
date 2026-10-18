import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Role, briefExtra, loadTemplate, renderBrief, runBriefGate } from "./brief";
import { DAEMON_DEFAULTS } from "./config-defaults";
import type { Host } from "./hosts/host";
import {
  type BrokerCredentials,
  agentIdFor,
  mintCredentials,
  revokeCredentials,
  writeAgentJson,
} from "./identity";
import { type IssueData, fetchIssue, renderIssueMd } from "./issue";
import { LAUNCH_COMMAND, launchScriptPath, renderLaunchScript } from "./launch";
import { type AgentProbe, type WorktreeLock, acquireLock, lockPath } from "./locks";
import { retainedTopics } from "./retire";
import { classifyScreen } from "./screens";
import { SpawnError } from "./spawn-error";
import { isRepoTrusted, readClaudeJson, repoRoot, trustDecisionId, trustQuestion } from "./trust";
import type { NewEvent, TaskId, Tunables, Wave, WaveTask } from "./types";
import {
  type AgentWatch,
  type VerifyResult,
  hookSignalsArrived,
  verifyRegistration,
} from "./verify";
import { branchName, expandHome, worktreePath } from "./worktree";

/**
 * One spawn, end to end: repo trust → lock → worktree → ISSUE.md → brief + gate → identity
 * (minted credentials, `.volley/agent.json`) → launch script → pre-subscribe → launch → verify
 * through the hook signals (screen fallback only before the hooks run). Every refusal is
 * journaled (`alarm_raised` with the code) before it is thrown, and releases the lock.
 *
 * The journal's event types are the closed wave-event enum, so the steps map onto it:
 *   refusals (SPAWN_LOCKED, SPAWN_BRIEF_REJECTED, ISSUE_MISMATCH, …) → alarm_raised { code }
 *   a launch (worktree, issue, credentials, workspace)            → agent_spawned
 *   the one relaunch after an update prompt (spawn_recovered)      → agent_retired { superseded }
 *     for the first attempt, then agent_spawned { recovered_from } (typed into the same workspace)
 *   hook signals verified                                           → agent_registered
 *   repo_untrusted / model_switch / unknown_screen                  → decision_opened
 */

export interface SpawnRequest {
  wave: Wave;
  task: TaskId;
  role: Role;
  attempt: number;
}

export interface SpawnDeps {
  host: Host;
  /** $VOLLEYD_HOME: locks, screen captures. */
  home: string;
  /** The daemon's namespace (a wave's `namespace:` overrides it). */
  namespace: string;
  brokerUrl: string;
  /** Claude Code's `~/.claude.json` (folder trust). */
  claudeJsonPath: string;
  /** `packages/volley-hooks` ($VOLLEY_HOOKS_DIR). */
  hooksDir: string;
  /** Mint per-agent broker credentials (`volley auth add-agent`); false for an open broker. */
  mintCredentials: boolean;
  tunables: Pick<Tunables, "worktree_root" | "spawn_timeout_s" | "heartbeat_alarm_s">;
  /** The wave owner: the agents' parent (default volleyd). */
  owner: string | null;
  journal: (ev: NewEvent) => unknown | Promise<unknown>;
  /** Decision ids open in the wave. */
  openDecisions: readonly string[];
  probe: AgentProbe;
  /** Subscribe to an agent's signals (called before its launch). */
  watch: (namespace: string, agentId: string) => Promise<AgentWatch>;
  /** `$VOLLEYD_HOME/brief-gate` when present. */
  briefGate: string | null;
  briefsDir?: string;
  /** Publish an empty retained payload (clears a superseded attempt's records). Default: none. */
  clearRetained?: (topic: string) => Promise<void>;
  /**
   * Open a decision through the daemon's decision store (published retained, notify bridge).
   * Resolves with the id it was opened under. Default: journal `decision_opened` as `d.id`.
   */
  openDecision?: (d: SpawnDecision) => Promise<string>;
  /** Resolve an open decision. Default: journal `decision_resolved` on the spawn's task. */
  resolveDecision?: (id: string, answer: string, by: string) => Promise<void>;
  /** After Enter on an update prompt, how long the original launch may take to continue. */
  relaunchSettleMs?: number;
}

export type DecisionKind = "repo_untrusted" | "model_switch" | "unknown_screen";

/** A decision a spawn opens; `id` is the base id (the store may suffix a re-opened one). */
export interface SpawnDecision {
  kind: DecisionKind;
  id: string;
  task: TaskId;
  question: string;
  options: string[];
  pointers: { screen?: string };
  /** Extra facts kept on the decision (`repo` for repo_untrusted, `agent_id`, models). */
  data: Record<string, unknown>;
}

/** The open decision opened under `base` (or a re-opened `base-<n>`), if any. */
export function openDecisionFor(open: readonly string[], base: string): string | undefined {
  return open.find((id) => id === base || id.startsWith(`${base}-`));
}

export type SpawnOutcome =
  | {
      kind: "registered";
      agentId: string;
      workspace: string;
      model: string | null;
      modelVerified: boolean;
      watch: AgentWatch;
      /** Whether broker credentials were minted for it (retire revokes them). */
      minted: boolean;
    }
  | {
      kind: "decision";
      decision: DecisionKind;
      decisionId: string;
      agentId: string;
      workspace: string;
      watch: AgentWatch;
      minted: boolean;
      screen?: string;
    };

export type SpawnResult =
  | { kind: "decision"; decision: "repo_untrusted"; decisionId: string; opened: boolean }
  | {
      kind: "launched";
      agentId: string;
      workspace: string;
      worktree: string;
      lock: WorktreeLock;
      /** Resolves once the hook signals arrived, or a decision was opened. */
      verified: Promise<SpawnOutcome>;
    };

const secondsMs = (s: number) => s * 1000;

/** The volleyd agent id, the parent of agents in a wave without an owner. */
const SUPERVISOR = "volleyd";

interface Ctx {
  req: SpawnRequest;
  deps: SpawnDeps;
  task: WaveTask;
  namespace: string;
  repo: string;
  root: string;
  worktree: string;
  lock?: WorktreeLock;
}

/** Run the launch half of a spawn; `verified` carries the rest. Throws SpawnError on refusal. */
export async function spawnAgent(req: SpawnRequest, deps: SpawnDeps): Promise<SpawnResult> {
  const task = req.wave.tasks[req.task];
  if (task === undefined) throw new Error(`unknown task '${req.task}' in wave ${req.wave.wave}`);
  const repo = expandHome(req.wave.repo);
  const ctx: Ctx = {
    req,
    deps,
    task,
    namespace: req.wave.namespace ?? deps.namespace,
    repo,
    root: repo,
    worktree: worktreePath(deps.tunables.worktree_root, req.wave.wave, req.task, req.role),
  };
  try {
    // 0. Repo trust, before anything is created.
    ctx.root = await repoRoot(deps.host.exec, repo);
    const open = openDecisionFor(deps.openDecisions, trustDecisionId(ctx.root));
    const trusted = isRepoTrusted(readClaudeJson(deps.claudeJsonPath), ctx.root);
    if (!trusted) {
      if (open !== undefined) {
        return { kind: "decision", decision: "repo_untrusted", decisionId: open, opened: false };
      }
      const decisionId = await openDecision(ctx, "repo_untrusted", trustDecisionId(ctx.root), {
        question: trustQuestion(ctx.root),
        options: ["trust", "cancel"],
        data: { repo: ctx.root },
      });
      return { kind: "decision", decision: "repo_untrusted", decisionId, opened: true };
    }
    if (open !== undefined) await resolveDecision(ctx, open, "trusted", "claude-trust-dialog");

    // 1. Lock first.
    const agentId = agentIdFor(req.wave.wave, req.task, req.role, req.attempt);
    ctx.lock = await acquireLock(
      lockPath(deps.home, ctx.worktree),
      {
        wave: req.wave.wave,
        task: req.task,
        role: req.role,
        attempt: req.attempt,
        agent_id: agentId,
        pid: process.pid,
        at: new Date().toISOString(),
      },
      deps.probe,
      { staleAfterMs: secondsMs(deps.tunables.heartbeat_alarm_s) },
    );

    // 2–5. Worktree, issue, brief, identity, launch.
    const issue = await fetchIssue(deps.host.exec, ctx.root, task.issue);
    const launched = await launchAttempt(ctx, req.attempt, agentId, issue);
    const lock = ctx.lock;
    return {
      kind: "launched",
      agentId,
      workspace: launched.workspace,
      worktree: ctx.worktree,
      lock,
      verified: verifyAndRecover(ctx, launched, issue),
    };
  } catch (e) {
    await refuse(ctx, e);
    throw e;
  }
}

interface Launched {
  agentId: string;
  attempt: number;
  workspace: string;
  watch: AgentWatch;
  minted: boolean;
}

/** Steps 2–5 for one attempt: everything up to a running terminal and a live watch. */
async function launchAttempt(
  ctx: Ctx,
  attempt: number,
  agentId: string,
  issue: IssueData,
  recovered?: { from: string; reason: string; workspace: string },
): Promise<Launched> {
  const { req, deps, task } = ctx;
  const { host } = deps;
  const branch = branchName(req.wave.wave, req.task, req.role, attempt);
  const wt = await host.prepareWorktree({
    repo: ctx.repo,
    path: ctx.worktree,
    branch,
    base: req.wave.release_branch,
  });

  await host.writeFile(join(ctx.worktree, "ISSUE.md"), renderIssueMd(issue));

  const briefPath = join(ctx.worktree, ".volley", "brief.md");
  const brief = renderBrief(loadTemplate(req.role, deps.briefsDir), {
    agent_id: agentId,
    namespace: ctx.namespace,
    wave: req.wave.wave,
    task: req.task,
    role: req.role,
    issue: issue.number,
    issue_title: issue.title,
    issue_url: issue.url,
    model: task.model,
    repo: ctx.root,
    release_branch: req.wave.release_branch,
    branch: wt.branch,
    worktree: ctx.worktree,
    extra: briefExtra(ctx.root),
  });
  await host.writeFile(briefPath, brief);
  if (deps.briefGate !== null)
    await runBriefGate(host.exec, deps.briefGate, briefPath, ctx.worktree);

  const parent = deps.owner ?? SUPERVISOR;
  let creds: BrokerCredentials | undefined;
  if (deps.mintCredentials) {
    creds = await mintCredentials(host.exec, agentId, [parent, SUPERVISOR]);
  }
  try {
    await writeAgentJson(host, ctx.worktree, {
      agent_id: agentId,
      namespace: ctx.namespace,
      parent_id: parent,
      wave: req.wave.wave,
      task: req.task,
      role: req.role,
      broker_url: deps.brokerUrl,
      ...(creds !== undefined ? { broker: creds } : {}),
    });
    await host.writeFile(
      launchScriptPath(ctx.worktree),
      renderLaunchScript({
        hooksDir: deps.hooksDir,
        model: task.model,
        agentId,
        ...(host.launchEnv !== undefined
          ? { env: host.launchEnv({ agent_id: agentId, namespace: ctx.namespace }) }
          : {}),
      }),
      0o700,
    );

    // Subscribe before launching, so no hook signal can be missed.
    const watch = await deps.watch(ctx.namespace, agentId);
    let workspace: string;
    try {
      if (recovered !== undefined) {
        // The relaunch reuses the workspace (never a second session in one worktree): its shell
        // is back at a bare prompt, so the launch command is typed there.
        workspace = recovered.workspace;
        await host.sendText(workspace, LAUNCH_COMMAND);
        await host.sendKeys(workspace, "Enter");
      } else {
        ({ workspace } = await host.launch({
          cwd: ctx.worktree,
          name: `${req.wave.wave} ${req.task} ${req.role}`,
          command: LAUNCH_COMMAND,
        }));
      }
    } catch (e) {
      await watch.close();
      throw e;
    }
    await deps.journal({
      type: "agent_spawned",
      task: req.task,
      data: {
        agent_id: agentId,
        role: req.role,
        attempt,
        host: host.name,
        workspace,
        worktree: ctx.worktree,
        branch: wt.branch,
        worktree_reused: wt.reused,
        issue: { number: issue.number, title: issue.title, url: issue.url },
        credentials: creds !== undefined ? "minted" : "none",
        ...(ctx.lock !== undefined ? { lock: ctx.lock.path } : {}),
        ...(recovered !== undefined
          ? { recovered_from: recovered.from, recovery: recovered.reason }
          : {}),
      },
    });
    if (req.role === "implementer" && attempt === 1) {
      await deps.journal({ type: "stage_entered", task: req.task, data: { stage: "implement" } });
    }
    return { agentId, attempt, workspace, watch, minted: creds !== undefined };
  } catch (e) {
    if (creds !== undefined) await revokeCredentials(host.exec, agentId);
    throw e;
  }
}

/**
 * Step 6: verify through the hook signals. On an update prompt: press Enter, and relaunch once
 * in the same workspace only if its shell is then back at a bare prompt.
 */
async function verifyAndRecover(
  ctx: Ctx,
  first: Launched,
  issue: IssueData,
): Promise<SpawnOutcome> {
  const { deps, task } = ctx;
  let cur = first;
  for (let recovered = false; ; recovered = true) {
    const result = await verifyRegistration({
      watch: cur.watch,
      host: deps.host,
      workspace: cur.workspace,
      expectedModel: task.model,
      timeoutMs: secondsMs(deps.tunables.spawn_timeout_s),
      screenLines: DAEMON_DEFAULTS.screen_lines,
    });
    if (result.kind === "registered") return registered(ctx, cur, result);

    const screen = saveScreen(ctx, cur.agentId, result.screen);
    if (result.screen_class === "trust_dialog") {
      const decisionId =
        openDecisionFor(deps.openDecisions, trustDecisionId(ctx.root)) ??
        (await openDecision(ctx, "repo_untrusted", trustDecisionId(ctx.root), {
          question: trustQuestion(ctx.root),
          options: ["trust", "cancel"],
          screen,
          data: { repo: ctx.root, agent_id: cur.agentId },
        }));
      return decision(cur, "repo_untrusted", decisionId, screen);
    }
    if (result.screen_class === "update_prompt" && !recovered) {
      try {
        cur = await answerUpdatePrompt(ctx, cur, issue);
      } catch (e) {
        await cur.watch.close();
        await refuse(ctx, e);
        throw e;
      }
      continue;
    }
    const decisionId = await openDecision(
      ctx,
      "unknown_screen",
      decisionIdFor("unknown_screen", cur.agentId),
      {
        question: `Needs you: ${cur.agentId} did not start (screen: ${result.screen_class}). Look at its terminal?`,
        options: ["relaunch", "cancel"],
        screen,
        data: { agent_id: cur.agentId, screen_class: result.screen_class },
      },
    );
    return decision(cur, "unknown_screen", decisionId, screen);
  }
}

/**
 * Enter on the update prompt, then: the original launch continued (its hook signals arrive, or
 * the screen is anything but a bare shell) → keep verifying it; the shell is back at a bare
 * prompt (the prompt ate the launch command) → the one relaunch, typed into the same workspace.
 */
async function answerUpdatePrompt(ctx: Ctx, cur: Launched, issue: IssueData): Promise<Launched> {
  const { host } = ctx.deps;
  await host.sendKeys(cur.workspace, "Enter");
  const settle = ctx.deps.relaunchSettleMs ?? DAEMON_DEFAULTS.relaunch_settle_ms;
  if (await cur.watch.waitFor(hookSignalsArrived, settle)) return cur;
  const after = await host.readScreen(cur.workspace, DAEMON_DEFAULTS.screen_lines);
  if (classifyScreen(after) !== "shell_prompt") return cur;
  return relaunch(ctx, cur, issue);
}

/**
 * The one relaunch after an update prompt: the first attempt is retired as `superseded`
 * (credentials revoked, retained records cleared, lock kept), then attempt+1 gets a new identity
 * in the same worktree, lock and workspace.
 */
async function relaunch(ctx: Ctx, prev: Launched, issue: IssueData): Promise<Launched> {
  const { req, deps } = ctx;
  await prev.watch.close();
  const revoked = prev.minted ? await revokeCredentials(deps.host.exec, prev.agentId) : null;
  if (deps.clearRetained !== undefined) {
    for (const topic of retainedTopics(ctx.namespace, prev.agentId))
      await deps.clearRetained(topic);
  }
  const attempt = prev.attempt + 1;
  const agentId = agentIdFor(req.wave.wave, req.task, req.role, attempt);
  await deps.journal({
    type: "agent_retired",
    task: req.task,
    data: {
      agent_id: prev.agentId,
      role: req.role,
      status: "superseded",
      superseded_by: agentId,
      credentials_revoked: revoked,
      lock_released: false,
    },
  });
  ctx.lock?.update({ attempt, agent_id: agentId });
  return launchAttempt(ctx, attempt, agentId, issue, {
    from: prev.agentId,
    reason: "update_prompt",
    workspace: prev.workspace,
  });
}

async function registered(
  ctx: Ctx,
  cur: Launched,
  r: Extract<VerifyResult, { kind: "registered" }>,
): Promise<SpawnOutcome> {
  const { deps, req, task } = ctx;
  await deps.journal({
    type: "agent_registered",
    task: req.task,
    data: {
      agent_id: cur.agentId,
      role: req.role,
      model: r.model,
      model_source: r.model_source,
      model_verified: r.model_verified,
      expected_model: task.model,
      screen_read: r.screen_read,
    },
  });
  if (r.model_mismatch) {
    const decisionId = await openDecision(
      ctx,
      "model_switch",
      decisionIdFor("model_switch", cur.agentId),
      {
        question: `Needs you: ${cur.agentId} runs ${r.model ?? "an unknown model"}, the wave asks for ${task.model}. Keep it running?`,
        options: ["keep", "cancel"],
        data: { agent_id: cur.agentId, model: r.model, expected_model: task.model },
      },
    );
    return decision(cur, "model_switch", decisionId);
  }
  return {
    kind: "registered",
    agentId: cur.agentId,
    workspace: cur.workspace,
    model: r.model,
    modelVerified: r.model_verified,
    watch: cur.watch,
    minted: cur.minted,
  };
}

function decision(
  cur: Launched,
  kind: DecisionKind,
  decisionId: string,
  screen?: string,
): SpawnOutcome {
  return {
    kind: "decision",
    decision: kind,
    decisionId,
    agentId: cur.agentId,
    workspace: cur.workspace,
    watch: cur.watch,
    minted: cur.minted,
    ...(screen !== undefined ? { screen } : {}),
  };
}

export function decisionIdFor(kind: DecisionKind, agentId: string): string {
  return `${kind}-${createHash("sha256").update(agentId).digest("hex").slice(0, 12)}`;
}

/** Open a decision (the daemon's store when wired, else the journal); resolves with its id. */
async function openDecision(
  ctx: Ctx,
  kind: DecisionKind,
  decisionId: string,
  d: {
    question: string;
    options: string[];
    screen?: string | undefined;
    data?: Record<string, unknown>;
  },
): Promise<string> {
  const pointers = d.screen !== undefined ? { screen: d.screen } : {};
  if (ctx.deps.openDecision !== undefined) {
    return ctx.deps.openDecision({
      kind,
      id: decisionId,
      task: ctx.req.task,
      question: d.question,
      options: d.options,
      pointers,
      data: d.data ?? {},
    });
  }
  await ctx.deps.journal({
    type: "decision_opened",
    task: ctx.req.task,
    data: {
      decision_id: decisionId,
      kind,
      question: d.question,
      options: d.options,
      pointers,
      opened_at: new Date().toISOString(),
      ...d.data,
    },
  });
  return decisionId;
}

async function resolveDecision(ctx: Ctx, id: string, answer: string, by: string): Promise<void> {
  if (ctx.deps.resolveDecision !== undefined) return ctx.deps.resolveDecision(id, answer, by);
  await ctx.deps.journal({
    type: "decision_resolved",
    task: ctx.req.task,
    data: { decision_id: id, answer, by, at: new Date().toISOString() },
  });
}

/** Keep the screen that triggered a decision under `$VOLLEYD_HOME/waves/<wave>/screens/`. */
function saveScreen(ctx: Ctx, agentId: string, screen: string | null): string | undefined {
  if (screen === null) return undefined;
  const dir = join(ctx.deps.home, "waves", ctx.req.wave.wave, "screens");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${agentId}-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`);
  writeFileSync(path, screen);
  return path;
}

/** Journal a refusal and release the lock (no agent holds the worktree). */
async function refuse(ctx: Ctx, e: unknown): Promise<void> {
  ctx.lock?.release();
  const err = e instanceof SpawnError ? e : null;
  await ctx.deps.journal({
    type: "alarm_raised",
    task: ctx.req.task,
    data: {
      code: err?.code ?? "SPAWN_FAILED",
      message: e instanceof Error ? e.message : String(e),
      role: ctx.req.role,
      attempt: ctx.lock?.info.attempt ?? ctx.req.attempt,
      ...err?.detail,
    },
  });
}
