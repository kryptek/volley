import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flakeIssue } from "./autopilot/flake-brief";
import type { PlaybookStage } from "./autopilot/playbook";
import { releaseWaveTask, stageBriefVars } from "./autopilot/release-train";
import {
  BriefPrefaceTooLarge,
  NO_STAGE,
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
import { autoCompactWindowTokens } from "./claude/context-window";
import type { Ranked } from "./claude/usage";
import { systemClock } from "./clock";
import { DAEMON_DEFAULTS } from "./config-defaults";
import { ITS_RUNNING, ITS_RUNNING_HELP, waveDecisionId } from "./decisions";
import { mintConsentToken, sealLaunchScript } from "./fence";
import { lockFetches } from "./git-lock";
import type { Host, WorktreeResult } from "./hosts/host";
import {
  type AgentCredentials,
  type BrokerCredentials,
  agentIdFor,
  mintCredentials,
  releaseAgentId,
  revokeCredentials,
  writeAgentJson,
} from "./identity";
import { type IssueData, fetchIssue, renderIssueMd } from "./issue";
import {
  LAUNCH_COMMAND,
  allowedMcpServers,
  approvedProjectServers,
  launchScriptPath,
  mcpConfigPath,
  renderLaunchScript,
  renderMcpConfig,
  strayVolleyServers,
} from "./launch";
import { type AgentProbe, type WorktreeLock, acquireLock, lockPath } from "./locks";
import { reapAndRevoke, retainedTopics } from "./retire";
import { type HygieneLevel, hygieneText } from "./reviews";
import { classifyScreen, lastOutput, lastOutputNote } from "./screens";
import { SpawnError } from "./spawn-error";
import { isRepoTrusted, readClaudeJson, repoRoot, trustDecisionId, trustQuestion } from "./trust";
import type {
  AgentMcp,
  BranchUpdate,
  NewEvent,
  TaskId,
  Tunables,
  Wave,
  WaveId,
  WaveTask,
} from "./types";
import {
  type AgentWatch,
  type VerifyResult,
  hookSignalsArrived,
  verifyRegistration,
} from "./verify";
import { branchName, expandHome, releaseBranchName, worktreePath } from "./worktree";

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
 *   a launch whose outcome is unknown (reconcileLaunch)            → spawn_adopted, then
 *     agent_spawned { adopted }; or launch_orphan_closed / spawn_identity_burned, then the refusal
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
   * A rebase role's step under `branch_update: merge` (fixed when the step started): its brief is
   * the merge one (`briefs/rebase-merge.md.tmpl`). Absent: rebase.
   */
  branch_update?: BranchUpdate;
  /** The reviewer briefs' hygiene level (reviews.ts hygieneLevel). Absent: `p1`. */
  hygiene?: HygieneLevel;
  /**
   * The agent's MCP servers, when they must be the earlier agent's (a respawn of a moved or
   * vanished agent, from its `agent_spawned` record), not the tunable's current value.
   */
  agent_mcp?: AgentMcp;
  /** Likewise its `agent_mcp_allow` (under `inherit`; empty: every server). */
  agent_mcp_allow?: string[];
  /**
   * The Claude account profile the agent runs under (claude/profiles.ts selectAccount): `dir` is
   * its `CLAUDE_CONFIG_DIR`, null (or no `account`) the primary profile.
   */
  account?: { id: string; dir: string | null; machine?: string };
  /**
   * Why the spawn runs under its account (`account_chosen`, journaled right before
   * `agent_spawned`, whose `account_why` repeats `why`): without the attempt, which the spawn adds.
   */
  accountChosen?: {
    account: string;
    machine: string;
    source: string;
    why: string;
    candidates: readonly Ranked[];
  };
  /** Appended to the brief: an account move's resume note (claude/move.ts). */
  resumeNote?: string;
  /**
   * The earlier attempt whose per-attempt worktree (`start` set) this spawn continues in, not a
   * fresh one: an account move of a pipeline role (claude/move.ts moveRespawn).
   */
  worktreeAttempt?: number;
  /**
   * The release role's playbook stage (SPEC §4.6.19): its agent runs under the pseudo task
   * `_release` with no issue, as `<wave>-release-<stage>-<n>` on `<wave>/release-<stage>-<n>`,
   * cut from the release branch's tip; its brief is the stage's.
   */
  stage?: PlaybookStage;
  /**
   * An implementer respawn (F6): the branch an earlier attempt of the role was cut on. When
   * origin has it, this attempt continues on it (cut from origin's copy, the same name) and its
   * brief names the branch and the PR open from it, so no second branch or PR is started.
   */
  continueBranch?: string;
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
  /** volleyd's log (a spawn's warnings); absent: journal only. */
  log?: (line: string) => void;
  tunables: Pick<
    Tunables,
    | "worktree_root"
    | "spawn_timeout_s"
    | "heartbeat_alarm_s"
    | "brief_preface_max_bytes"
    | "agent_mcp"
    | "agent_auto_compact_pct"
  > &
    Partial<Pick<Tunables, "require_fresh_base" | "agent_mcp_allow">>;
  /** The wave owner: the agents' parent (default volleyd). */
  owner: string | null;
  journal: (ev: NewEvent) => unknown | Promise<unknown>;
  /** Decision ids open in the wave. */
  openDecisions: readonly string[];
  probe: AgentProbe;
  /**
   * Whether the wave's journal already has an event `match` accepts (a once-per-wave alarm).
   * Absent: none has, so such an alarm is raised at every spawn.
   */
  journaled?: (match: (ev: NewEvent) => boolean) => boolean;
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
  /** After a launch with an unknown outcome, how long its agent may take to register. */
  launchReconcileMs?: number;
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
  /** The box's folder trust: its `~/.claude.json`, or a profile's (`configDir`) there. */
  read: (configDir?: string) => Promise<Record<string, unknown> | null>;
}

const SPAWN_OPTIONS = ["relaunch", "cancel", ITS_RUNNING];
const SPAWN_OPTION_HELP = { [ITS_RUNNING]: ITS_RUNNING_HELP };

/** A decision a spawn opens; `id` is the base id (the store may suffix a re-opened one). */
export interface SpawnDecision {
  kind: DecisionKind;
  id: string;
  task: TaskId;
  question: string;
  options: string[];
  /** Hover text for some of `options`, by option. */
  option_help?: Record<string, string>;
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

/** The agent id of `req`'s attempt: a release stage's own shape, else the task role's. */
const agentIdOf = (req: SpawnRequest, attempt: number) =>
  req.stage !== undefined
    ? releaseAgentId(req.wave.wave, req.stage.name, attempt)
    : agentIdFor(req.wave.wave, req.task, req.role, attempt);

/** What a release stage has in place of an issue (no ISSUE.md is written for it). */
const stageIssue = (stage: PlaybookStage): IssueData => ({
  number: 0,
  title: `release stage ${stage.name}`,
  body: "",
  url: "",
});

/** Run the launch half of a spawn; `verified` carries the rest. Throws SpawnError on refusal. */
export async function spawnAgent(req: SpawnRequest, deps: SpawnDeps): Promise<SpawnResult> {
  const task =
    req.wave.tasks[req.task] ?? (req.stage !== undefined ? releaseWaveTask(req.wave) : undefined);
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
      req.stage !== undefined
        ? `${req.role}-${req.stage.name}-${req.attempt}`
        : req.start !== undefined
          ? `${req.role}-${req.worktreeAttempt ?? req.attempt}`
          : req.role,
    ),
  };
  try {
    // 0. Repo trust, before anything is created.
    ctx.root = await repoRoot(deps.host.exec, repo);
    const open = openDecisionFor(deps.openDecisions, trustId(ctx));
    const cfg =
      deps.remoteTrust !== undefined
        ? await deps.remoteTrust.read(remoteProfileOf(ctx.req))
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
    const agentId = agentIdOf(req, req.attempt);
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
    // A release stage is no issue's; a flake's fixer (SPEC §4.6.16) has none either: its
    // root-cause brief takes ISSUE.md's place.
    const issue =
      req.stage !== undefined
        ? stageIssue(req.stage)
        : task.synthetic === true && task.remediation !== undefined
          ? flakeIssue(task.remediation, task.id)
          : await fetchIssue(deps.host.exec, ctx.root, task.issue);
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

/** A profile on a paired machine: its dir there (nothing of it is on this machine). */
const remoteProfileOf = (req: SpawnRequest) =>
  (req.account?.machine ?? "local") !== "local" ? profileDirOf(req) : undefined;

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

/** A branch an earlier attempt pushed, and the PR open from it (if any). */
interface CarriedBranch {
  branch: string;
  pr?: { number: number; url: string };
}

/**
 * Whether origin has `branch` (fetched, then its remote-tracking ref read, as artifacts.ts
 * verifies a push), and the open PR from it. Null when it was never pushed: the attempt then
 * starts a fresh branch.
 */
async function pushedBranch(
  exec: Host["exec"],
  repo: string,
  branch: string,
): Promise<CarriedBranch | null> {
  const fetched = await exec(["git", "-C", repo, "fetch", "--quiet", "origin", branch]);
  if (fetched.code !== 0) return null;
  const ref = await exec([
    "git",
    "-C",
    repo,
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/remotes/origin/${branch}`,
  ]);
  if (ref.code !== 0 || ref.stdout.trim() === "") return null;
  const prs = await exec(
    ["gh", "pr", "list", "--head", branch, "--state", "open", "--json", "number,url,headRefName"],
    { cwd: repo },
  );
  let list: { number?: unknown; url?: unknown; headRefName?: unknown }[] = [];
  try {
    const parsed: unknown = prs.code === 0 ? JSON.parse(prs.stdout) : [];
    if (Array.isArray(parsed)) list = parsed;
  } catch {}
  // `gh pr list --head` can return another branch's PR: only an exact head match counts.
  const pr = list.find((p) => p.headRefName === branch);
  return typeof pr?.number === "number" && typeof pr.url === "string"
    ? { branch, pr: { number: pr.number, url: pr.url } }
    : { branch };
}

/** The brief's note for an attempt that continues an earlier one's pushed branch. */
function carriedNote(c: CarriedBranch, release: string): string {
  const pr =
    c.pr !== undefined
      ? `PR #${c.pr.number} (${c.pr.url}) is open from it: push your commits to \`${c.branch}\` and that PR picks them up. Do not open another PR.`
      : `No PR is open from it yet: open one from \`${c.branch}\` against \`${release}\` (gh pr create --base ${release}).`;
  return `An earlier attempt of this task pushed \`${c.branch}\`, and this worktree continues it: it is that branch, cut from origin's copy. Read what is already there (git log ${release}..HEAD) and carry on from it; do not start over on a new branch. ${pr}`;
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
  const carried =
    req.start === undefined && req.continueBranch !== undefined
      ? await pushedBranch(
          lockFetches(host.exec, host.name, ctx.repo),
          ctx.repo,
          req.continueBranch,
        )
      : null;
  const branch =
    carried?.branch ??
    (req.stage !== undefined
      ? releaseBranchName(req.wave.wave, req.stage.name, attempt)
      : branchName(req.wave.wave, req.task, req.role, attempt));
  const cut = await host.prepareWorktree({
    repo: ctx.repo,
    path: ctx.worktree,
    branch,
    // A carried branch is fetched and cut like the release branch: from origin's copy.
    base: carried?.branch ?? req.start?.ref ?? req.wave.release_branch,
    ...(req.start?.detach === true ? { detach: true } : {}),
    ...(req.start === undefined
      ? { releaseBase: true, requireFresh: deps.tunables.require_fresh_base !== false }
      : {}),
  });
  // A carried branch's tip is not the task's base: the first attempt's base_sha stands.
  const { base: _tip, ...carriedCut } = cut;
  const wt: WorktreeResult = carried !== null ? carriedCut : cut;
  // The fetch lost a ref-lock race to another git process and its retry went through.
  if (cut.fetch_retried !== undefined) {
    await deps.journal({
      type: "alarm_raised",
      task: req.task,
      data: {
        alarm: "fetch_retried",
        role: req.role,
        attempt,
        host: host.name,
        fetch_error: cut.fetch_retried,
      },
    });
  }
  // require_fresh_base off and the fetch failed: cut from the host's last copy, said out loud.
  if (wt.base !== undefined && !wt.base.fresh) {
    await deps.journal({
      type: "alarm_raised",
      task: req.task,
      data: {
        code: "BASE_STALE",
        severity: "warning",
        message: `${req.wave.release_branch} could not be fetched (${wt.base.fetch_error ?? "fetch failed"}); require_fresh_base is off, so ${branch} was cut from the last fetched copy at ${wt.base.sha.slice(0, 7)}`,
        role: req.role,
        attempt,
        host: host.name,
        base_sha: wt.base.sha,
        ...(wt.base.fetch_error !== undefined ? { fetch_error: wt.base.fetch_error } : {}),
      },
    });
  }

  // The quality reviewer reviews the diff only: it gets no copy of the issue and its plan. A
  // release stage is no issue's.
  if (req.role !== "quality_reviewer" && req.stage === undefined)
    await host.writeFile(
      join(ctx.worktree, "ISSUE.md"),
      task.synthetic === true ? issue.body : renderIssueMd(issue),
    );
  for (const [name, content] of Object.entries(req.files ?? {})) {
    await host.writeFile(join(ctx.worktree, ".volley", name), content);
  }

  const agentMcp = req.agent_mcp ?? deps.tunables.agent_mcp;
  const mcpAllow =
    agentMcp === "inherit" ? (req.agent_mcp_allow ?? deps.tunables.agent_mcp_allow ?? []) : [];
  let mcpExtra: Record<string, unknown> = {};
  if (agentMcp === "inherit") {
    const sources = await userMcpSources(ctx);
    if (mcpAllow.length > 0) {
      // Only the .mcp.json entries the profile approved: the strict copy skips Claude Code's ask.
      const [user, project, local] = sources;
      const allowed = allowedMcpServers(mcpAllow, [
        user,
        { ...project, config: approvedProjectServers(project.config, local.config) },
        local,
      ]);
      mcpExtra = allowed.servers;
      // In .mcp.json at all (of any shape) but filtered out by approvedProjectServers.
      const raw = allowedMcpServers(allowed.missing, [project]);
      const unapproved = [...Object.keys(raw.servers), ...raw.malformed];
      await alarmMissingAllowed(
        ctx,
        [...allowed.missing, ...allowed.malformed],
        new Set(unapproved),
        new Set(allowed.malformed),
      );
    }
    await warnStrayVolley(ctx, agentId, attempt, sources, mcpAllow);
  }

  const briefPath = join(ctx.worktree, ".volley", "brief.md");
  const preface = loadPreface(req.wave, deps);
  const variant =
    req.role === "rebase" && req.branch_update === "merge"
      ? "merge"
      : req.role === "implementer" && task.synthetic === true
        ? "flake"
        : undefined;
  const hygiene = hygieneText(req.hygiene ?? "p1", req.wave.release_branch);
  const rendered = renderBrief(loadTemplate(req.role, deps.briefsDir, variant), {
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
    hygiene_rule: hygiene.rule,
    hygiene_contract: hygiene.contract,
    ...(req.stage !== undefined ? stageBriefVars(req.stage, req.wave.release_branch) : NO_STAGE),
  });
  const brief = withPreface(preface, rendered);
  const notes = [
    ...(carried !== null ? [carriedNote(carried, req.wave.release_branch)] : []),
    ...(req.resumeNote !== undefined ? [req.resumeNote] : []),
  ];
  await host.writeFile(
    briefPath,
    notes.length > 0 ? `${brief.trimEnd()}\n\n---\n\n${notes.join("\n\n")}\n` : brief,
  );
  if (deps.briefGate !== null)
    await runBriefGate(host.exec, deps.briefGate, briefPath, ctx.worktree);

  const profile = profileDirOf(req);
  // Sharing and the MCP sync are this machine's: nothing is copied to a paired machine's profile.
  if (
    profile !== undefined &&
    remoteProfileOf(req) === undefined &&
    deps.prepareAccount !== undefined
  ) {
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
    // volleyd's own MCP server for the agent: this release's volley-mcp, on this broker (and the
    // user's servers agent_mcp_allow names). Owner-only: those copied entries hold the user's
    // secrets (env tokens, headers).
    await host.writeFile(
      mcpConfigPath(ctx.worktree),
      renderMcpConfig(deps.mcpEntry, mcpExtra),
      0o600,
    );
    const compactWindow = autoCompactWindowTokens(task.model, deps.tunables.agent_auto_compact_pct);
    const script = renderLaunchScript({
      hooksDir: deps.hooksDir,
      model: task.model,
      agentId,
      worktree: ctx.worktree,
      ...(profile !== undefined ? { claudeConfigDir: profile } : {}),
      ...(agentMcp === "inherit" ? { agentMcp } : {}),
      ...(mcpAllow.length > 0 ? { mcpAllow } : {}),
      ...(compactWindow !== undefined ? { autoCompactWindow: compactWindow } : {}),
      ...(host.launchEnv !== undefined
        ? { env: host.launchEnv({ agent_id: agentId, namespace: ctx.namespace }) }
        : {}),
    });
    // The fence starts (or types) the launch command only with this seal of what it runs; a
    // paired machine's profile is admitted for that machine's worktrees only.
    const machine = req.account?.machine ?? "local";
    const launch = sealLaunchScript(
      ctx.worktree,
      script,
      machine !== "local"
        ? { name: machine, worktree_root: deps.tunables.worktree_root }
        : undefined,
    );
    await host.writeFile(launchScriptPath(ctx.worktree), script, 0o700);

    // Subscribe before launching, so no hook signal can be missed.
    const watch = await deps.watch(ctx.namespace, agentId);
    // real clock: the hooks process stamps its error file with its own.
    const launchedAt = systemClock.now();
    let workspace: string;
    let adopted = false;
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
          name: launchName(req, attempt),
          command: LAUNCH_COMMAND,
          launch,
        }));
      }
    } catch (e) {
      const found =
        recovered === undefined && launchOutcomeUnknown(e)
          ? await reconcileLaunch(ctx, { agentId, attempt, watch, error: e })
          : null;
      if (found === null) {
        await watch.close();
        throw e;
      }
      workspace = found.workspace;
      adopted = true;
    }
    if (req.accountChosen !== undefined)
      await deps.journal({
        type: "account_chosen",
        task: req.task,
        data: { task: req.task, role: req.role, attempt, ...req.accountChosen },
      });
    await deps.journal({
      type: "agent_spawned",
      task: req.task,
      data: {
        agent_id: agentId,
        role: req.role,
        ...(req.stage !== undefined ? { stage: req.stage.name } : {}),
        attempt,
        host: host.name,
        workspace,
        worktree: ctx.worktree,
        branch: wt.branch,
        worktree_reused: wt.reused,
        ...(wt.base !== undefined ? { base_sha: wt.base.sha } : {}),
        ...(req.start !== undefined ? { start: req.start.ref, detached: req.start.detach } : {}),
        ...(req.worktreeAttempt !== undefined ? { worktree_attempt: req.worktreeAttempt } : {}),
        ...(req.branch_update === "merge" ? { branch_update: "merge" } : {}),
        ...(agentMcp === "inherit" ? { agent_mcp: "inherit" } : {}),
        ...(mcpAllow.length > 0 ? { agent_mcp_allow: [...mcpAllow] } : {}),
        ...(compactWindow !== undefined ? { auto_compact_window: compactWindow } : {}),
        issue: { number: issue.number, title: issue.title, url: issue.url },
        credentials: creds !== undefined ? "minted" : "none",
        claude_account: accountId(req),
        ...(req.accountChosen !== undefined ? { account_why: req.accountChosen.why } : {}),
        ...(ctx.lock !== undefined ? { lock: ctx.lock.path } : {}),
        ...(recovered !== undefined
          ? { recovered_from: recovered.from, recovery: recovered.reason }
          : {}),
        ...(adopted ? { adopted: true } : {}),
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

/** A launch that failed without saying nothing was created: the workspace may exist. */
const launchOutcomeUnknown = (e: unknown) =>
  e instanceof SpawnError && e.code === "LAUNCH_FAILED" && e.detail.outcome === "unknown";

/**
 * A launch whose outcome is unknown (a timed-out cmux may still have opened the workspace and
 * started the agent): reconcile before anything retries it, so no second session ever runs under
 * the same agent id. Look the workspace up by the name volleyd gave it, and wait (on the watch
 * subscribed before the launch) for the agent's hook signals:
 * - they arrived: adopt it (`spawn_adopted`) and resolve with its workspace, so the launch
 *   continues exactly like a normal one;
 * - none, and a workspace was found: close it (`launch_orphan_closed`) and resolve null (the
 *   launch fails; its retry may reuse the identity: that session is known gone);
 * - none, nothing found: resolve null;
 * - none, and the host could not be asked or the workspace not closed: `spawn_identity_burned`
 *   and resolve null; the retry takes the next attempt (daemon.ts agentAttempt).
 */
async function reconcileLaunch(
  ctx: Ctx,
  launch: { agentId: string; attempt: number; watch: AgentWatch; error: unknown },
): Promise<{ workspace: string } | null> {
  const { req, deps } = ctx;
  const { host } = deps;
  const { agentId, attempt, watch } = launch;
  const name = launchName(req, attempt);
  const candidate = launch.error instanceof SpawnError ? launch.error.detail.candidate : undefined;
  const find = () =>
    host.findWorkspace(name, typeof candidate === "string" ? candidate : undefined).then(
      (ws) => ({ ws }),
      (e: unknown) => ({ ws: null, error: e instanceof Error ? e.message : String(e) }),
    );
  const now = nowOf(deps);
  const started = now();
  const first = await find();
  const registered = await watch.waitFor(
    hookSignalsArrived,
    deps.launchReconcileMs ?? DAEMON_DEFAULTS.launch_reconcile_ms,
  );
  const last = first.ws === null ? await find() : first;
  const ws = last.ws ?? first.ws;
  if (registered) {
    await deps.journal({
      type: "spawn_adopted",
      task: req.task,
      data: {
        agent_id: agentId,
        role: req.role,
        attempt,
        workspace: ws ?? "unknown",
        after: "launch_unknown",
        waited_ms: now() - started,
      },
    });
    return { workspace: ws ?? "" };
  }
  const burn = async (why: string) => {
    await deps.journal({
      type: "spawn_identity_burned",
      task: req.task,
      data: {
        agent_id: agentId,
        role: req.role,
        ...(req.stage !== undefined ? { stage: req.stage.name } : {}),
        attempt,
        why,
      },
    });
    return null;
  };
  if (ws === null) {
    return "error" in last ? burn(`workspace lookup failed: ${last.error}`) : null;
  }
  try {
    // volleyd opened this workspace itself and no agent registered in it.
    await host.close(ws, mintConsentToken(`reconcile ${agentId}`));
  } catch (e) {
    return burn(`closing ${ws} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  await deps.journal({
    type: "launch_orphan_closed",
    task: req.task,
    data: { agent_id: agentId, role: req.role, attempt, workspace: ws },
  });
  return null;
}

/**
 * The workspace title a launch gives its terminal: `<wave> <task> <role>`, with the attempt
 * appended after the first (`… fixup 2`). One title per agent id, so a reconcile looking it up
 * never finds the workspace an earlier attempt left open.
 */
const launchName = (req: SpawnRequest, attempt: number) =>
  `${req.wave.wave} ${req.stage !== undefined ? `release ${req.stage.name}` : `${req.task} ${req.role}`}${attempt > 1 ? ` ${attempt}` : ""}`;

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
        decisionIdFor("mcp_not_registered", ctx.req.wave.wave, cur.agentId),
        {
          question: `Needs you: ${cur.agentId}'s hooks registered, but the agent's MCP server is not on this broker — version skew or wrong broker; see ${mcpConfigPath(ctx.worktree)}. Its status and progress will not reach volleyd. Relaunch it?`,
          options: SPAWN_OPTIONS,
          option_help: SPAWN_OPTION_HELP,
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
        decisionIdFor("hooks_auth_failed", ctx.req.wave.wave, cur.agentId),
        {
          question: `Needs you: the broker refused ${cur.agentId}'s hooks (AUTH_FAILED for ${who}); volleyd paused it. relaunch: retire it (its login deleted), mint a fresh login and start the ${ctx.req.role} again as attempt ${cur.attempt + 1}; or cancel (the task is blocked)?`,
          options: SPAWN_OPTIONS,
          option_help: SPAWN_OPTION_HELP,
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
    const last = lastOutput(result.screen);
    const decisionId = await openDecision(
      ctx,
      "unknown_screen",
      decisionIdFor("unknown_screen", ctx.req.wave.wave, cur.agentId),
      {
        question: `Needs you: ${cur.agentId} did not start (screen: ${result.screen_class}).${lastOutputNote(last, deps.host.name !== "local")} Look at its terminal?`,
        options: SPAWN_OPTIONS,
        option_help: SPAWN_OPTION_HELP,
        screen,
        data: {
          agent_id: cur.agentId,
          screen_class: result.screen_class,
          ...(last !== null ? { last_output: last } : {}),
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
  const agentId = agentIdOf(req, attempt);
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
      decisionIdFor("model_switch", ctx.req.wave.wave, cur.agentId),
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

export function decisionIdFor(kind: DecisionKind, wave: WaveId, agentId: string): string {
  return waveDecisionId(kind, wave, agentId);
}

/** Open a decision (the daemon's store when wired, else the journal); resolves with its id. */
async function openDecision(
  ctx: Ctx,
  kind: DecisionKind,
  decisionId: string,
  d: {
    question: string;
    options: string[];
    option_help?: Record<string, string>;
    screen?: string | undefined;
    data?: Record<string, unknown>;
  },
): Promise<string> {
  const help = d.option_help !== undefined ? { option_help: d.option_help } : {};
  const pointers = d.screen !== undefined ? { screen: d.screen } : {};
  if (ctx.deps.openDecision !== undefined) {
    return ctx.deps.openDecision({
      kind,
      id: decisionId,
      task: ctx.req.task,
      question: d.question,
      options: d.options,
      ...help,
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
      ...help,
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
 * The repo_untrusted decision id for the spawn's wave and repo root, on the machine it runs on, in
 * the Claude account profile it runs under (each profile has its own folder trust).
 */
const trustId = (ctx: Ctx) =>
  trustDecisionId(
    ctx.req.wave.wave,
    ctx.root,
    ctx.deps.remoteTrust !== undefined
      ? remoteProfileOf(ctx.req) !== undefined
        ? `${ctx.deps.remoteTrust.target}:claude-account:${accountId(ctx.req)}`
        : ctx.deps.remoteTrust.target
      : profileDirOf(ctx.req) !== undefined
        ? `claude-account:${accountId(ctx.req)}`
        : undefined,
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

type McpSource = { source: string; config: unknown };

/**
 * The MCP servers Claude Code would load for the agent under `agent_mcp: inherit`, lowest
 * precedence first: the profile's `.claude.json` user scope, the worktree's `.mcp.json` (project
 * scope), then the repository's local-scope entry in `.claude.json` (which also holds the
 * `.mcp.json` approvals). A paired machine's are its own. Their entries may hold the user's
 * secrets: only names ever leave this function's callers.
 */
async function userMcpSources(ctx: Ctx): Promise<[McpSource, McpSource, McpSource]> {
  const { deps } = ctx;
  const profilePath = deps.remoteTrust !== undefined ? "~/.claude.json" : claudeJsonOf(ctx);
  const profile =
    deps.remoteTrust !== undefined
      ? await deps.remoteTrust.read(remoteProfileOf(ctx.req))
      : readClaudeJson(profilePath);
  const local = (profile as { projects?: Record<string, unknown> } | null)?.projects?.[ctx.root];
  const mcpJson = join(ctx.worktree, ".mcp.json");
  const raw =
    deps.host.readFile !== undefined
      ? await deps.host.readFile(mcpJson)
      : existsSync(mcpJson)
        ? readFileSync(mcpJson, "utf-8")
        : null;
  let project: unknown = null;
  try {
    project = raw !== null ? JSON.parse(raw) : null;
  } catch {
    // Not JSON: Claude Code loads nothing from it either.
  }
  return [
    { source: profilePath, config: profile },
    { source: ".mcp.json", config: project },
    { source: `${profilePath} local scope`, config: local ?? null },
  ];
}

/**
 * `agent_mcp_allow` names no server the agent's config has: journal
 * `alarm_raised { alarm: "agent_mcp_allow_missing", name, host }` once per wave, name and machine
 * (each machine has its own config), and log it; the spawn goes on without it. `unapproved` are
 * names the worktree's `.mcp.json` has but the profile never approved for the repository, which
 * the message says rather than "no server";
 * `malformed` are names whose entry is of a shape volleyd does not copy (isMcpServerEntry).
 */
async function alarmMissingAllowed(
  ctx: Ctx,
  missing: readonly string[],
  unapproved: ReadonlySet<string>,
  malformed: ReadonlySet<string>,
): Promise<void> {
  const { deps, req } = ctx;
  if (missing.length === 0) return;
  // One journal scan for every name (it stops once all of them are found).
  const seen = new Set<string>();
  deps.journaled?.((e) => {
    if (
      e.type === "alarm_raised" &&
      e.data.alarm === "agent_mcp_allow_missing" &&
      e.data.host === deps.host.name &&
      typeof e.data.name === "string" &&
      missing.includes(e.data.name)
    )
      seen.add(e.data.name);
    return seen.size === missing.length;
  });
  for (const name of missing) {
    if (seen.has(name)) continue;
    const why = malformed.has(name)
      ? `volleyd cannot copy MCP server '${name}' (a string command with string args and env, or a string url with string headers)`
      : unapproved.has(name)
        ? `the repository's .mcp.json has '${name}' but it is not approved for this repository (enabledMcpjsonServers)`
        : `no MCP server '${name}' in the profile's .claude.json or the repository's .mcp.json`;
    const message = `agent_mcp_allow: ${why} on ${deps.host.name}; agents of wave ${req.wave.wave} start without it there`;
    deps.log?.(message);
    await deps.journal({
      type: "alarm_raised",
      data: { alarm: "agent_mcp_allow_missing", name, host: deps.host.name, message },
    });
  }
}

/**
 * Under `agent_mcp: inherit`, warn (journal + log) when the profile's `.claude.json` or the
 * worktree's `.mcp.json` runs volley-mcp under a name other than `volley`: volleyd's server does
 * not take that entry over, so a second Volley server starts in the agent's session. With
 * `agent_mcp_allow` only an allowed entry starts, so only one counts. The spawn goes on; the
 * entry is the owner's to rename or remove.
 */
async function warnStrayVolley(
  ctx: Ctx,
  agentId: string,
  attempt: number,
  sources: { source: string; config: unknown }[],
  allow: readonly string[],
): Promise<void> {
  const { deps, req } = ctx;
  const servers = strayVolleyServers(sources).filter(
    (s) => allow.length === 0 || allow.includes(s.name),
  );
  if (servers.length === 0) return;
  const message = `agent_mcp: inherit: ${agentId} also loads ${servers.map((s) => `'${s.name}' (${s.source})`).join(", ")}, which runs volley-mcp under a name other than 'volley'; rename it to 'volley' so volleyd's server takes it over, or remove it`;
  deps.log?.(message);
  await deps.journal({
    type: "alarm_raised",
    task: req.task,
    data: {
      alarm: "agent_mcp_stray_volley",
      role: req.role,
      attempt,
      agent_id: agentId,
      servers,
      message,
    },
  });
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
