import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BriefPrefaceTooLarge,
  type Role,
  briefExtra,
  briefExtraFrom,
  briefExtraPath,
  briefPrefacePath,
  loadTemplate,
  readBriefPreface,
  renderBrief,
  runBriefGate,
  withPreface,
} from "./brief";
import { systemClock } from "./clock";
import { DAEMON_DEFAULTS } from "./config-defaults";
import { sealLaunchScript } from "./fence";
import type { Host } from "./hosts/host";
import {
  type AgentCredentials,
  type BrokerCredentials,
  agentIdFor,
  mintCredentials,
  revokeCredentials,
  writeAgentJson,
} from "./identity";
import { type IssueData, fetchIssue, renderIssueMd } from "./issue";
import {
  LAUNCH_COMMAND,
  launchScriptPath,
  mcpConfigPath,
  renderLaunchScript,
  renderMcpConfig,
} from "./launch";
import { type AgentProbe, type WorktreeLock, acquireLock, lockPath } from "./locks";
import { reapAndRevoke, retainedTopics } from "./retire";
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
 * One spawn, end to end: repo trust → lock → worktree (cut from the release branch as origin
 * has it) → ISSUE.md → brief + gate → identity (minted credentials, `.volley/agent.json`) →
 * `.volley/mcp.json` + launch script → pre-subscribe → launch → verify through the hook signals
 * and the agent's own MCP status (screen fallback only before the hooks run). Every refusal is
 * journaled (`alarm_raised` with the code) before it is thrown, and releases the lock.
 *
 * The journal's event types are the closed wave-event enum, so the steps map onto it:
 *   refusals (SPAWN_LOCKED, SPAWN_BRIEF_REJECTED, ISSUE_MISMATCH, …) → alarm_raised { code }
 *   a launch (worktree, issue, credentials, workspace)            → agent_spawned
 *   the one relaunch after an update prompt (spawn_recovered)      → agent_retired { superseded }
 *     for the first attempt, then agent_spawned { recovered_from } (typed into the same workspace)
 *   hook signals verified                                           → agent_registered
 *   hooks verified, the MCP server's status missing                 → verify_failed, then
 *     decision_opened (mcp_not_registered)
 *   repo_untrusted / model_switch / unknown_screen / hooks_auth_failed → decision_opened
 */

export interface SpawnRequest {
  wave: Wave;
  task: TaskId;
  role: Role;
  attempt: number;
  /**
   * A pipeline role's starting point (T6): its worktree is cut from this commit — detached for
   * reviewers, a fresh branch otherwise — and is its own per attempt, so a re-run starts clean.
   */
  start?: { ref: string; detach: boolean };
  /** Inputs written to `<worktree>/.volley/<name>` before launch (review.md, findings.md, …). */
  files?: Record<string, string>;
  /**
   * The Claude account profile the agent runs under (claude/profiles.ts selectAccount): `dir` is
   * its `CLAUDE_CONFIG_DIR`, null (or no `account`) the primary profile.
   */
  account?: { id: string; dir: string | null };
  /** Appended to the brief: an account move's resume note (claude/move.ts). */
  resumeNote?: string;
  /**
   * The earlier attempt whose per-attempt worktree (`start` set) this spawn continues in, not a
   * fresh one: an account move of a pipeline role (claude/move.ts moveRespawn).
   */
  worktreeAttempt?: number;
}

export interface SpawnDeps {
  host: Host;
  /** $VOLLEYD_HOME: locks, screen captures. */
  home: string;
  /** Where the worktree locks live, if not `home` (a remote host's: per target). */
  lockHome?: string;
  /** The daemon's namespace (a wave's `namespace:` overrides it). */
  namespace: string;
  brokerUrl: string;
  /** Claude Code's `~/.claude.json` (folder trust). */
  claudeJsonPath: string;
  /**
   * A remote host's folder trust, read from its own `~/.claude.json` instead of
   * `claudeJsonPath`; its repo_untrusted decisions carry `host` and `target`.
   */
  remoteTrust?: RemoteTrust;
  /** `packages/volley-hooks` ($VOLLEY_HOOKS_DIR). */
  hooksDir: string;
  /** `packages/volley-mcp/src/index.ts` on the agent's host: its `.volley/mcp.json` server. */
  mcpEntry: string;
  /** Mint per-agent broker logins; false for an open broker. */
  mintCredentials: boolean;
  /** Where the logins come from: volleyd's Dynamic Security control connection (dynsec.ts). */
  credentials?: AgentCredentials;
  tunables: Pick<
    Tunables,
    "worktree_root" | "spawn_timeout_s" | "heartbeat_alarm_s" | "brief_preface_max_bytes"
  >;
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
  /** Publish a retained message (a superseded attempt's `reaped` status). Default: none. */
  publishRetained?: (topic: string, payload: string) => Promise<void>;
  /**
   * Open a decision through the daemon's decision store (published retained, notify bridge).
   * Resolves with the id it was opened under. Default: journal `decision_opened` as `d.id`.
   */
  openDecision?: (d: SpawnDecision) => Promise<string>;
  /** Resolve an open decision. Default: journal `decision_resolved` on the spawn's task. */
  resolveDecision?: (id: string, answer: string, by: string) => Promise<void>;
  /** After Enter on an update prompt, how long the original launch may take to continue. */
  relaunchSettleMs?: number;
  /**
   * Bring a Claude account profile in line before its agent launches (sharing.yaml, the MCP
   * servers sync). A rejection refuses the spawn (CLAUDE_ACCOUNT_PREPARE_FAILED).
   */
  prepareAccount?: (account: { id: string; dir: string }) => Promise<void>;
  /**
   * The daemon's clock (epoch ms): lock staleness, lock and decision stamps, so they compare
   * against the agent heartbeats the daemon records on it. Default: the system clock.
   */
  now?: () => number;
}

/** The spawn's "now" on the daemon's clock (SpawnDeps.now). */
// real clock: the default when no daemon clock is injected
const nowOf = (deps: Pick<SpawnDeps, "now">): (() => number) => deps.now ?? systemClock.now;
const stampOf = (deps: Pick<SpawnDeps, "now">): string => new Date(nowOf(deps)()).toISOString();

export type DecisionKind =
  | "repo_untrusted"
  | "model_switch"
  | "unknown_screen"
  | "hooks_auth_failed"
  | "mcp_not_registered"
  /** Opened by the daemon's remote setup before spawnAgent runs (daemon.ts remoteSpawn). */
  | "remote_repo_missing";

export interface RemoteTrust {
  host: string;
  target: string;
  read: () => Promise<Record<string, unknown> | null>;
}

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
    worktree: worktreePath(
      deps.tunables.worktree_root,
      req.wave.wave,
      req.task,
      req.start !== undefined ? `${req.role}-${req.worktreeAttempt ?? req.attempt}` : req.role,
    ),
  };
  try {
    // 0. Repo trust, before anything is created.
    ctx.root = await repoRoot(deps.host.exec, repo);
    const open = openDecisionFor(deps.openDecisions, trustId(ctx));
    const cfg =
      deps.remoteTrust !== undefined
        ? await deps.remoteTrust.read()
        : readClaudeJson(claudeJsonOf(ctx));
    const trusted = isRepoTrusted(cfg, ctx.root);
    if (!trusted) {
      if (open !== undefined) {
        return { kind: "decision", decision: "repo_untrusted", decisionId: open, opened: false };
      }
      const decisionId = await openDecision(ctx, "repo_untrusted", trustId(ctx), {
        question: trustAsk(ctx),
        options: ["trust", "cancel"],
        data: trustData(ctx),
      });
      return { kind: "decision", decision: "repo_untrusted", decisionId, opened: true };
    }
    if (open !== undefined) await resolveDecision(ctx, open, "trusted", "claude-trust-dialog");

    // 1. Lock first.
    const agentId = agentIdFor(req.wave.wave, req.task, req.role, req.attempt);
    ctx.lock = await acquireLock(
      lockPath(deps.lockHome ?? deps.home, ctx.worktree),
      {
        wave: req.wave.wave,
        task: req.task,
        role: req.role,
        attempt: req.attempt,
        agent_id: agentId,
        pid: process.pid,
        at: stampOf(deps),
      },
      deps.probe,
      { staleAfterMs: secondsMs(deps.tunables.heartbeat_alarm_s), now: nowOf(deps) },
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
  /** Epoch ms just before the launch (an older hooks-error.json is stale). */
  launchedAt: number;
}

/** The Claude account the spawn runs under, `primary` when none is selected. */
const accountId = (req: SpawnRequest) => req.account?.id ?? "primary";

/** A Claude account profile's directory, or undefined for the primary. */
const profileDirOf = (req: SpawnRequest) => req.account?.dir ?? undefined;

/** Folder trust is per profile: its own `.claude.json` (the primary's is `claudeJsonPath`). */
const claudeJsonOf = (ctx: Ctx) => {
  const dir = profileDirOf(ctx.req);
  return dir !== undefined ? join(dir, ".claude.json") : ctx.deps.claudeJsonPath;
};

/**
 * The wave's brief preface, read at each spawn on the supervisor's host (the wave state shows
 * the one read at submit). Over `brief_preface_max_bytes` refuses the spawn.
 */
function loadPreface(wave: Wave, deps: SpawnDeps) {
  const path = briefPrefacePath(wave.repo, wave.brief_preface);
  try {
    return readBriefPreface(path, deps.tunables.brief_preface_max_bytes);
  } catch (e) {
    if (!(e instanceof BriefPrefaceTooLarge)) throw e;
    throw new SpawnError("BRIEF_PREFACE_TOO_LARGE", e.message, e.detail);
  }
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
    base: req.start?.ref ?? req.wave.release_branch,
    ...(req.start?.detach === true ? { detach: true } : {}),
    ...(req.start === undefined ? { releaseBase: true } : {}),
  });

  // The quality reviewer reviews the diff only: it gets no copy of the issue and its plan.
  if (req.role !== "quality_reviewer")
    await host.writeFile(join(ctx.worktree, "ISSUE.md"), renderIssueMd(issue));
  for (const [name, content] of Object.entries(req.files ?? {})) {
    await host.writeFile(join(ctx.worktree, ".volley", name), content);
  }

  const briefPath = join(ctx.worktree, ".volley", "brief.md");
  const preface = loadPreface(req.wave, deps);
  const rendered = renderBrief(loadTemplate(req.role, deps.briefsDir), {
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
    extra:
      host.readFile !== undefined
        ? briefExtraFrom(await host.readFile(briefExtraPath(ctx.root)))
        : briefExtra(ctx.root),
  });
  const brief = withPreface(preface, rendered);
  await host.writeFile(
    briefPath,
    req.resumeNote !== undefined ? `${brief.trimEnd()}\n\n---\n\n${req.resumeNote}\n` : brief,
  );
  if (deps.briefGate !== null)
    await runBriefGate(host.exec, deps.briefGate, briefPath, ctx.worktree);

  const profile = profileDirOf(req);
  if (profile !== undefined && deps.prepareAccount !== undefined) {
    try {
      await deps.prepareAccount({ id: accountId(req), dir: profile });
    } catch (e) {
      throw new SpawnError(
        "CLAUDE_ACCOUNT_PREPARE_FAILED",
        `Claude account '${accountId(req)}': ${e instanceof Error ? e.message : String(e)}`,
        { claude_account: accountId(req) },
      );
    }
  }

  const parent = deps.owner ?? SUPERVISOR;
  let creds: BrokerCredentials | undefined;
  if (deps.mintCredentials) {
    // Its acks reach volleyd and the Desk through the shared agent role: nothing per agent.
    creds = await mintCredentials(deps.credentials, agentId);
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
      claude_account: accountId(req),
      ...(creds !== undefined ? { broker: creds } : {}),
    });
    // volleyd's own MCP server for the agent: this release's volley-mcp, on this broker.
    await host.writeFile(mcpConfigPath(ctx.worktree), renderMcpConfig(deps.mcpEntry));
    const script = renderLaunchScript({
      hooksDir: deps.hooksDir,
      model: task.model,
      agentId,
      worktree: ctx.worktree,
      ...(profile !== undefined ? { claudeConfigDir: profile } : {}),
      ...(host.launchEnv !== undefined
        ? { env: host.launchEnv({ agent_id: agentId, namespace: ctx.namespace }) }
        : {}),
    });
    // The fence starts (or types) the launch command only with this seal of what it runs.
    const launch = sealLaunchScript(ctx.worktree, script);
    await host.writeFile(launchScriptPath(ctx.worktree), script, 0o700);

    // Subscribe before launching, so no hook signal can be missed.
    const watch = await deps.watch(ctx.namespace, agentId);
    // real clock: the hooks process stamps its error file with its own.
    const launchedAt = systemClock.now();
    let workspace: string;
    try {
      if (recovered !== undefined) {
        // The relaunch reuses the workspace (never a second session in one worktree): its shell
        // is back at a bare prompt, so the launch command is typed there.
        workspace = recovered.workspace;
        await host.sendText(workspace, LAUNCH_COMMAND, { launch });
        await host.sendKeys(workspace, "Enter");
      } else {
        ({ workspace } = await host.launch({
          cwd: ctx.worktree,
          name: `${req.wave.wave} ${req.task} ${req.role}`,
          command: LAUNCH_COMMAND,
          launch,
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
        ...(req.start !== undefined ? { start: req.start.ref, detached: req.start.detach } : {}),
        ...(req.worktreeAttempt !== undefined ? { worktree_attempt: req.worktreeAttempt } : {}),
        issue: { number: issue.number, title: issue.title, url: issue.url },
        credentials: creds !== undefined ? "minted" : "none",
        claude_account: accountId(req),
        ...(ctx.lock !== undefined ? { lock: ctx.lock.path } : {}),
        ...(recovered !== undefined
          ? { recovered_from: recovered.from, recovery: recovered.reason }
          : {}),
      },
    });
    if (req.role === "implementer" && attempt === 1) {
      await deps.journal({ type: "stage_entered", task: req.task, data: { stage: "implement" } });
    }
    return { agentId, attempt, workspace, watch, minted: creds !== undefined, launchedAt };
  } catch (e) {
    // A bare revoke, not the delete path: this is almost always a failure before or at the
    // launch, when no session holds the login. (A journal failure right after a launch is the rare
    // exception, and its retained records are not cleared here.)
    if (creds !== undefined) await revokeCredentials(deps.credentials, agentId);
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
      launchedAt: cur.launchedAt,
      // Only a local worktree's file is readable here; a remote host falls back to its screen.
      ...(deps.host.name === "local"
        ? { hooksErrorPath: join(ctx.worktree, ".volley", "hooks-error.json") }
        : {}),
    });
    if (result.kind === "registered") return registered(ctx, cur, result);
    if (result.kind === "mcp_not_registered") {
      await deps.journal({
        type: "verify_failed",
        task: ctx.req.task,
        data: { agent_id: cur.agentId, role: ctx.req.role, reason: "mcp_not_registered" },
      });
      const decisionId = await openDecision(
        ctx,
        "mcp_not_registered",
        decisionIdFor("mcp_not_registered", cur.agentId),
        {
          question: `Needs you: ${cur.agentId}'s hooks registered, but the agent's MCP server is not on this broker — version skew or wrong broker; see ${mcpConfigPath(ctx.worktree)}. Its status and progress will not reach volleyd. Relaunch it?`,
          options: ["relaunch", "cancel"],
          data: { agent_id: cur.agentId, pipeline: relaunchMarker(ctx, cur) },
        },
      );
      return decision(cur, "mcp_not_registered", decisionId);
    }
    if (result.kind === "hooks_auth_failed") {
      const who = result.username ?? "anonymous";
      const decisionId = await openDecision(
        ctx,
        "hooks_auth_failed",
        decisionIdFor("hooks_auth_failed", cur.agentId),
        {
          question: `Needs you: the broker refused ${cur.agentId}'s hooks (AUTH_FAILED for ${who}); volleyd paused it. relaunch: retire it (its login deleted), mint a fresh login and start the ${ctx.req.role} again as attempt ${cur.attempt + 1}; or cancel (the task is blocked)?`,
          options: ["relaunch", "cancel"],
          data: {
            agent_id: cur.agentId,
            username: result.username,
            hook_event: result.hook_event,
            pipeline: relaunchMarker(ctx, cur),
          },
        },
      );
      return decision(cur, "hooks_auth_failed", decisionId);
    }

    const screen = saveScreen(ctx, cur.agentId, result.screen);
    if (result.screen_class === "trust_dialog") {
      const decisionId =
        openDecisionFor(deps.openDecisions, trustId(ctx)) ??
        (await openDecision(ctx, "repo_untrusted", trustId(ctx), {
          question: trustAsk(ctx),
          options: ["trust", "cancel"],
          screen,
          data: { ...trustData(ctx), agent_id: cur.agentId },
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
        data: {
          agent_id: cur.agentId,
          screen_class: result.screen_class,
          pipeline: relaunchMarker(ctx, cur),
        },
      },
    );
    return decision(cur, "unknown_screen", decisionId, screen);
  }
}

/**
 * The pipeline marker of a relaunch decision (pipeline.ts PipelineMarker): `relaunch` retires
 * exactly this run and spawns its role at the next attempt; `cancel` retires it and blocks the task.
 */
function relaunchMarker(ctx: Ctx, cur: Launched): Record<string, unknown> {
  return {
    on: "relaunch",
    wave: ctx.req.wave.wave,
    task: ctx.req.task,
    role: ctx.req.role,
    attempt: cur.attempt,
    agent_id: cur.agentId,
  };
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
  // A stalled attempt may still be connected: delete its login through the delete path (`reaped`
  // first, records cleared before and after the delete), as every other delete does.
  let revoked: boolean | null = null;
  if (prev.minted && deps.publishRetained !== undefined && deps.clearRetained !== undefined) {
    revoked = await reapAndRevoke(
      prev.agentId,
      ctx.namespace,
      {
        credentials: deps.credentials,
        publishRetained: deps.publishRetained,
        clearRetained: deps.clearRetained,
        journal: deps.journal,
      },
      req.task,
    );
  } else {
    if (prev.minted) revoked = await revokeCredentials(deps.credentials, prev.agentId);
    if (deps.clearRetained !== undefined) {
      for (const topic of retainedTopics(ctx.namespace, prev.agentId))
        await deps.clearRetained(topic);
    }
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
      opened_at: stampOf(ctx.deps),
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
    data: { decision_id: id, answer, by, at: stampOf(ctx.deps) },
  });
}

/**
 * The repo_untrusted decision id for the spawn's repo root, on the machine it runs on, in the
 * Claude account profile it runs under (each profile has its own folder trust).
 */
const trustId = (ctx: Ctx) =>
  trustDecisionId(
    ctx.root,
    ctx.deps.remoteTrust?.target ??
      (profileDirOf(ctx.req) !== undefined ? `claude-account:${accountId(ctx.req)}` : undefined),
  );

/** The repo_untrusted question, naming the host and the Claude account where it is answered. */
const trustAsk = (ctx: Ctx) =>
  trustQuestion(
    ctx.root,
    ctx.deps.remoteTrust?.target,
    profileDirOf(ctx.req) !== undefined ? accountId(ctx.req) : undefined,
  );

/** A repo_untrusted decision's facts: the root, and for a remote host where it is trusted. */
const trustData = (ctx: Ctx): Record<string, unknown> => {
  const r = ctx.deps.remoteTrust;
  const profile = profileDirOf(ctx.req);
  return {
    repo: ctx.root,
    ...(r !== undefined ? { host: r.host, target: r.target } : {}),
    // Answered in that profile's own .claude.json (daemon.ts trustAnswer).
    ...(profile !== undefined ? { claude_config_dir: profile } : {}),
  };
};

/** Keep the screen that triggered a decision under `$VOLLEYD_HOME/waves/<wave>/screens/`. */
function saveScreen(ctx: Ctx, agentId: string, screen: string | null): string | undefined {
  if (screen === null) return undefined;
  const dir = join(ctx.deps.home, "waves", ctx.req.wave.wave, "screens");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${agentId}-${stampOf(ctx.deps).replace(/[:.]/g, "-")}.txt`);
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
