import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  closeSync,
  existsSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import {
  availableParallelism,
  freemem,
  homedir,
  loadavg,
  arch as osArch,
  platform,
  totalmem,
  uptime,
} from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { BrokerVersionError } from "volley-cli/auth/version";
import { countLiveAgents } from "volley-cli/setup/broker";
import { VolleyBroker } from "volley-mcp/broker";
import type { BrokerAuth } from "volley-mcp/config";
import { type Envelope, buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { buildTopic, isValidAgentId, registryTopic } from "volley-mcp/topics";
import pkg from "../package.json";
import {
  AUTH_CHANNEL,
  AUTH_OPS_FILTER,
  type AuthOutcome,
  type AuthReply,
  DESK_OPS,
  TOKEN_REDEEM_FILTER,
  accountOp,
  adminRefusal,
  authReply,
  authReplyTopic,
  deskRefusal,
  isValidCorrelationId,
  listAccounts,
  redeemToken,
  tokenReplyTopic,
} from "./accounts";
import { type ActivityEvidence, newestWrite } from "./activity-evidence";
import {
  type AdmissionState,
  type AdmissionSummary,
  type CeilingCount,
  type CeilingView,
  type HostSamples,
  type HostThresholds,
  type Sample,
  type Samples,
  type Verdict,
  allowJson,
  decide,
  foldHost,
  hostSamples,
  machineReasons,
  summaryPayload,
} from "./admission";
import {
  ADMIN_REASON,
  ARCHIVED_ANSWER,
  MANUAL_REASON,
  archivable,
  archiveEvents,
  archiveFacts,
  archiveRefusal,
  endedAt,
  indexEntry,
  indexPayload,
} from "./archive";
import { ciStateOf } from "./artifacts";
import { budgetUsed } from "./autopilot/budgets";
import { carryHandoff, carryPicker } from "./autopilot/carry";
import { type Digest, type DigestTrigger, digestOf, summaryLine } from "./autopilot/digest";
import { type GithubStatus, githubStatusCache } from "./autopilot/github-status";
import {
  INBOX_CHANNEL,
  INBOX_ID,
  type InboxAnswerRequest,
  type InboxHandler,
  type InboxItem,
  type InboxKind,
  type InboxWhere,
  type SessionSurface,
  answerEvent,
  decisionAnswerRefusal,
  decisionItemId,
  foldInbox,
  inboxEnvelopeType,
  inboxTopic,
  itemForDecision,
  itemForHandoff,
  itemForPicker,
  openedEvent,
  parsePickerQuestions,
  parseWhere,
  parseWhereLabel,
  pickerAnswerText,
  pickerItemId,
  ttlExpired,
  whereLabel,
  withHeld,
} from "./autopilot/inbox";
import {
  DEFAULT_PLAYBOOK,
  PlaybookError,
  type PlaybookStage,
  type WavePlaybook,
  allVerified,
  playbookPath,
  releaseGoInput,
  wavePlaybook,
} from "./autopilot/playbook";
import {
  type Budget,
  type EscalateWhy,
  POLICY_TABLE,
  evaluate,
  renderPolicyTable,
} from "./autopilot/policy";
import {
  RELEASE_TASK,
  ReleaseTrain,
  STAGE_STEER_REASON,
  releaseView,
  releaseWaveTask,
  renderStageMd,
  stageOf,
} from "./autopilot/release-train";
import {
  type FixRequest,
  type FixerVerdict,
  autoHolds,
  fixerFor,
  fixers,
  isRedHead,
  releasedBy,
  requestOf,
} from "./autopilot/remediation";
import { authFields } from "./broker-auth";
import { lastAccountMove, moveAgentAccount, moveRespawn } from "./claude/move";
import {
  ClaudeAccountError,
  LOCAL_MACHINE,
  MOST_HEADROOM,
  type SelectedAccount,
  accountKey,
  claudeRoot,
} from "./claude/profiles";
import { ClaudeService, SIGNIN_CHANNEL } from "./claude/service";
import { type Sharing, readSharing } from "./claude/sharing";
import {
  type AgentLimitSeen,
  type AgentOnAccount,
  type LimitSeen,
  USAGE_FILTER,
  type UsageBook,
  accountRecords,
  agentLimitDecisions,
  bookState,
  emptyBook,
  foldProbe,
  foldUsage,
  forgetAgent,
  limitDecisions,
  parseAgentMoveAnswer,
  parseMoveAnswer,
  parseUsage,
  rankAccounts,
  restoreBook,
  sampleAccount,
  usageAccountTopic,
  waveAccount,
  waveAccountMoves,
} from "./claude/usage";
import { DAEMON_DEFAULTS, REMOTE_HOST_DEFAULTS } from "./config-defaults";
import { ConfigStore } from "./config-store";
import {
  ADMISSION_TOPIC,
  ARCHIVE_TOPIC,
  BAD_ANSWER,
  CONFIG_TOPIC,
  type ControlResponse,
  DAEMON_AGENT_ID,
  LEASE_REQUESTS_FILTER,
  leasePoolTopic,
  waveDigestTopic,
  waveEventsTopic,
  waveStateTopic,
} from "./control";
import {
  AckTracker,
  KILL_SWITCH_REASON,
  TASK_ROLES,
  candidates as admissible,
  admissionFor,
  cancelPayload,
  isTaskRole,
  killSwitchEngaged,
  nextSteer,
  runningAgents,
  steerTarget,
} from "./controls";
import { CredentialSweeper, recounted } from "./credential-sweep";
import {
  type DecisionInput,
  type DecisionPayload,
  type DecisionRecord,
  type Held,
  type HeldOn,
  ID_RE,
  LOCAL_FILES,
  MACHINE_DOWN_CANCEL,
  MACHINE_DOWN_REPLACE,
  MACHINE_DOWN_WAIT,
  attentionPayload,
  checkAnswer,
  decisionPayload,
  decisionTopic,
  decisionsFilePath,
  describeDecision,
  ghHoldReleased,
  heldLabel,
  heldOnFrom,
  holdEvent,
  machineDownInput,
  openDecisions,
  openEvent,
  releaseEvent,
  renderDecisionsMd,
  resolveEvent,
  taskHoldReleased,
  waveDecisionId,
  writeDecisionsFile,
} from "./decisions";
import { DynsecControl, DynsecCredentials, brokerControl } from "./dynsec";
import { type ExecFn, exec as realExec } from "./exec";
import { mintConsentToken, mintModelSwitchToken, mintWakeToken } from "./fence";
import { LOCAL_HOST } from "./fleet-name";
import { lockFetches } from "./git-lock";
import type { Host } from "./hosts/host";
import { LocalCmuxHost } from "./hosts/local-cmux";
import {
  type RemoteHost,
  type RemoteHostSpec,
  SshTmuxHost,
  resolveRemoteHost,
  sessionName,
} from "./hosts/ssh-tmux";
import {
  TunnelChecks,
  type TunnelExit,
  type TunnelStatus,
  TunnelSupervisor,
  tunnelKey,
} from "./hosts/tunnel";
import { type AgentCredentials, type CredentialStore, agentIdFor } from "./identity";
import { Journal, WaveLog, writeFileAtomic } from "./journal";
import {
  HOLDER_GONE,
  type LeaseBook,
  type LeaseInput,
  type LeaseRequest,
  capFor,
  heldOn,
  step as leaseStep,
  poolPayload,
  replayLeases,
} from "./leases";
import {
  type DoctorReport,
  MACHINES_FILTER,
  MACHINE_CHANNEL,
  MachineHealth,
  type MachineRecord,
  type MachineStatus,
  doctorFields,
  machineTopic,
  parseDoctorReport,
  parseMachineFrom,
} from "./machines";
import { type IssueBodyFn, findOverlaps, formatOverlap, parseFilesSection } from "./overlap";
import {
  type Binding,
  type RegistryEntry,
  bindOwner,
  claimVerdict,
  guardMutation,
  parseRegistryEntry,
} from "./ownership";
import { type DoctorRun, type PeerReply, PeerService } from "./peers";
import {
  AUTO_HOST,
  type FilterOptions,
  type MachineView,
  type PlaceOptions,
  type Placement,
  type Snapshot,
  type Unplaced,
  needsPlacement,
  overloadLoad,
  peerIdleUnderLoad,
  place,
  reserve,
} from "./placement";
import { PlanChangeError, applyPlan, planAnswer, samePlan, taskActivity } from "./plan-apply";
import { diffPlans } from "./plan-diff";
import { countApiSignals, isApiSignal } from "./pressure/api-signals";
import { sampleCiQueue } from "./pressure/ci-queue";
import { sampleCmuxPing } from "./pressure/cmux";
import { sampleContainers } from "./pressure/containers";
import { sampleMemory } from "./pressure/memory";
import {
  PATH_TOOLS,
  type PathProbe,
  READINESS_CHANNEL,
  type ReadinessInput,
  type ReadinessPayload,
  machineView,
  peerMaxAgents,
  readiness,
  readinessKey,
  readinessTopic,
} from "./readiness";
import { type SpawnFailure, type WaveRecord, isAdditiveSteer, latestSpawnFailure } from "./reducer";
import { readRepoView } from "./repo-visibility";
import {
  type Admission,
  admit,
  admitPlacing,
  budgetRaise,
  spawnBudget,
  spawnsOutstanding,
  spawnsUsed,
} from "./scheduler";
import { toPathErrors, validator } from "./schemas";
import { lastOutput, lastOutputNote } from "./screens";
import { SETUP_OPS, SetupOps, type SetupOpsOptions, type SetupOutcome } from "./setup-ops";
import type {
  AgentMcp,
  CoordinatorAttention,
  GitHubRepo,
  JournalEvent,
  MergeMode,
  NewEvent,
  NudgeOnMerge,
  PublicHygiene,
  RepoVisibility,
  TaskAgents,
  TaskId,
  TaskStage,
  TaskState,
  Tunables,
  TunablesPatch,
  Wave,
  WaveId,
  WaveState,
  WaveTask,
} from "./types";
import { SYSTEM_WAVE } from "./types";
import { type PlacementDefaults, WaveFileError, parseWaveFile } from "./wave-file";

import {
  BLOCKED_TASK_CANCELLED,
  FIX_FLAKE,
  FIX_LANDED,
  PipelineDriver,
  SUPERSEDED_BY_MERGE,
  type SpawnStart,
  type TaskPipeline,
  blockedReason,
  isAnswer,
  releaseLockOn,
  roleSpawnHold,
} from "./pipeline";

import {
  type BriefPrefaceInfo,
  BriefPrefaceTooLarge,
  type Role,
  briefGatePath,
  briefPrefacePath,
  isRole,
  prefaceInfo,
  readBriefPreface,
} from "./brief";
import {
  type Clock,
  type ClockState,
  type PendingReap,
  type TimerHandle,
  dateOf,
  heartbeatSuppresses,
  holdReap,
  inWakeGrace,
  initialClock,
  reapVerdict,
  sampleClock,
  sampleOf,
  systemClock,
  withNow,
} from "./clock";
import { HOOKS_DIR, MCP_ENTRY } from "./launch";
import {
  type AgentLiveness,
  CONTINUE_TEXT,
  type DecisionSlot,
  type LivenessAction,
  type Step,
  WAKE_TEXT,
  checkLiveness,
  noteCapture,
  noteDecision,
  noteResolved,
  observeScreen,
  observeSignal,
  parseHookSignal,
  rebase,
  stallable,
  trackAgent,
  whyWaiting,
} from "./liveness";
import { type AgentProbe, FINAL_STATUS, TERMINAL_STATUS, lockPath, readLock } from "./locks";
import {
  type ReconcileProbes,
  type ReconcileTarget,
  type Reconciliation,
  type TaskFacts,
  execProbes,
  reconcileSkip,
  reconcileTargets,
  reconcileTask,
} from "./reconcile";
import {
  CREDIT_CLASS,
  LIMITED_CLASS,
  STOP_ANSWER,
  UNVERIFIED_CLASS,
  creditOccurrences,
  isRespawnAnswer,
  modelSwitchInput,
  parseSwitchAnswer,
  recoveryAllowed,
  respawnTarget,
  switchModel,
  switchesSent,
  withRespawnOn,
} from "./recovery";
import {
  type ReapDeps,
  type SessionEnder,
  closableAfterRestart,
  reapAndRevoke,
  retireAgent,
  retiredMarkerPath,
  withJointRevokes,
} from "./retire";
import { ScreenPublisher } from "./screen-publisher";
import {
  type SpawnDecision,
  type SpawnDeps,
  type SpawnOutcome,
  type SpawnResult,
  openDecisionFor,
  spawnAgent,
} from "./spawn";
import { SpawnError } from "./spawn-error";
import { isRepoTrusted, readClaudeJson, recordRepoTrust } from "./trust";
import { type AgentWatch, type ProgressFeed, watchAgent } from "./verify";
import {
  BLOCKED_ALARM,
  TERMINAL_ALARM,
  type TerminalSeen,
  WATCHED_STATUS,
  decidedAgent,
  journaledSince,
  namedAgent,
  unjournaledTerminals,
} from "./watchdog";
import {
  AGENT_BRANCH,
  checkFreshBase,
  checkReleaseBranch,
  expandHome,
  fetchRelease,
  spawnsLocally,
  worktreePath,
} from "./worktree";

export interface DaemonOptions {
  brokerUrl: string;
  namespace: string;
  /**
   * The `volleyd` identity's broker credentials (`daemonAuth`: `$VOLLEYD_HOME/broker.json`, else
   * `VOLLEY_AUTH_*`), sent on every connect. Absent: anonymous (an open broker).
   */
  auth?: BrokerAuth;
  /** $VOLLEYD_HOME — journals live under `<home>/waves/<wave>/`, config at `<home>/config.yaml`. */
  home: string;
  /**
   * Admission/monitor tick interval; 0 disables the admission and screen timers (tests drive
   * `tick()` / `tickScreens()`).
   */
  tickMs?: number;
  /**
   * Override the spawn admission verdict per wave (tests). Default: the pressure-based verdict
   * from the last sample (`pressure`); nothing is admitted until the first sample is in.
   */
  admission?: (wave: WaveId) => Admission;
  /** Machine-pressure sampler, run once per tick. Default: the fenced src/pressure samplers. */
  pressure?: PressureSource;
  log?: (line: string) => void;
  /**
   * MQTT protocol for the daemon's persistent session. Default 5, so `mailbox.session_expiry_s`
   * applies; 4 keeps the session until the broker's own expiry policy (and is what the
   * in-process test broker speaks).
   */
  protocolVersion?: 4 | 5;
  /**
   * Spawn admitted tasks' implementers (T4). Absent: tasks are admitted but nothing is spawned
   * (and the `spawn` op is refused) — the default, so tests never launch anything by accident.
   */
  spawner?: SpawnerOptions;
  /**
   * Fetches a task issue's body at submit; its `Files` section feeds the overlap warning and the
   * task's files hint. Default: none (wave-file `files` only); `volleyd daemon` wires `gh`.
   */
  issueBody?: IssueBodyFn;
  /**
   * Interrupts an agent's session on `stop`. Default: with a spawner, Escape into the agent's
   * workspace (from its `agent_spawned`); without one, none.
   */
  interrupt?: (agentId: string) => Promise<void>;
  /**
   * Where a task's `.volley/decisions.md` goes. Default: with a spawner, the task's latest
   * worktree; otherwise (or before any spawn) `<home>/waves/<wave>/tasks/<task>`.
   */
  taskDir?: (wave: WaveId, task: TaskId) => string;
  /**
   * Every daemon timer and wall-clock read (clock.ts). Default: real timers. Tests pass a fake
   * one (test/helpers/fake-clock.ts) and move time by hand.
   */
  clock?: Clock;
  /**
   * The HTTP fetch for GitHub's status page, read when a red head is classified (SPEC §4.6.16).
   * Default `globalThis.fetch`; tests pass a fake.
   */
  fetch?: typeof fetch;
  /** Wall clock override on top of `clock` (tests that only fix the time). */
  now?: () => number;
  /** The config's bottom layer (default CONFIG_DEFAULTS; `volleyd daemon`: `defaultsFor` env). */
  configDefaults?: Tunables;
  /** Overrides of the screen publisher's slow/hard read bounds (tests; ms). */
  screenTimeouts?: { slowMs?: number; readTimeoutMs?: number };
  /** Override of the model-switch verification window (tests; ms). */
  recoveryTimeouts?: { modelSwitchVerifyMs?: number };
  /**
   * The broker's Dynamic Security admin login (`$VOLLEYD_HOME/dynsec-admin.json`): volleyd keeps
   * one control connection with it to mint, delete and sweep agent logins. Absent: no logins are
   * minted (a spawn that needs one fails with CREDENTIALS_FAILED) and nothing is swept.
   */
  dynsecAdmin?: BrokerAuth;
  /** The credential sweep's interval in ms (tests; default `credential_sweep_interval_s`). */
  credentialSweepMs?: number;
  /** The exec account ops run `volley auth` through (accounts.ts; default: the fenced exec). */
  authExec?: ExecFn;
  /**
   * The setup ops' planner context (setup-ops.ts; tests): the planners' deps, the auth dir, the
   * env and the broker they log in to. Default: the real machine, volleyd's own broker URL.
   */
  setup?: Partial<Omit<SetupOpsOptions, "exec">>;
  /**
   * How often to prune expired one-time token logins (`volley auth list --json`); 0 disables.
   * Default: `token_prune_ms` when the daemon has broker credentials (`auth`), else 0.
   */
  tokenPruneMs?: number;
  /** git/GitHub probes for restart reconciliation (default: `git`/`gh` through the fenced exec). */
  reconcile?: ReconcileProbes;
  /**
   * The Fleet (SPEC §4.6.15): the supervisor's own machine's doctor, given the running wave's
   * repo or null (default: none, so its machine is not ready; `volleyd daemon` passes
   * `realLocalDoctor`), the PATH probe of its own agents' environment (default: `PATH` resolved
   * here), and the version a machine must run (default: this package's).
   */
  fleet?: {
    /** Ends its run (its child process) once `signal` aborts: a stop waits for that. */
    localDoctor?: (repo: string | null, signal: AbortSignal) => Promise<DoctorReport | null>;
    localPath?: () => PathProbe;
    version?: string;
    /**
     * The own machine's OS readings for its record (default: `node:os`'s). On macOS its memory
     * figure is the own doctor's (`vm_stat`), not `freemem`.
     */
    os?: Partial<{
      platform: () => NodeJS.Platform;
      loadavg: () => number[];
      freemem: () => number;
      totalmem: () => number;
    }>;
  };
  /**
   * Claude account profiles (src/claude/): the profiles root (default `claudeRoot()`), the
   * primary profile's directory (default `~/.claude`), the exec sign-ins run through (default
   * the fenced exec) and the sign-in poll / timeout (tests).
   */
  claude?: {
    root?: string;
    primaryDir?: string;
    exec?: ExecFn;
    signinPollMs?: number;
    signinTimeoutMs?: number;
    /** How long a paired machine's sign-in forward must stay up (default: config-defaults). */
    forwardSettleMs?: number;
  };
}

/** How the daemon spawns agents. Every field has a production default. */
export interface SpawnerOptions {
  /** The `local` host (default: cmux on this machine, through the fenced exec). */
  host?: Host;
  /** Claude Code's folder-trust file (default `~/.claude.json`). */
  claudeJsonPath?: string;
  /** `packages/volley-hooks` (default: the one in this checkout). */
  hooksDir?: string;
  /** volley-mcp's entry point for `.volley/mcp.json` (default: the one in this checkout). */
  mcpEntry?: string;
  /** Mint per-agent broker logins (default true). */
  mintCredentials?: boolean;
  /**
   * Where agent logins come from (tests). Default: volleyd's Dynamic Security control
   * connection, when `DaemonOptions.dynsecAdmin` is set.
   */
  credentials?: CredentialStore;
  briefsDir?: string;
  /**
   * How long an agent whose status is `reaped` (its LWT) stays supervised before it is retired,
   * waiting for a fresh status or heartbeat. Default `heartbeat_alarm_s` (tests shorten it).
   */
  reapGraceMs?: number;
  /** A remote host for a resolved spec (default: SshTmuxHost over the fenced exec). */
  remoteHost?: (spec: RemoteHostSpec) => RemoteHost;
  /** The exec remote hosts and their tunnels run with (default: the fenced exec). */
  remoteExec?: ExecFn;
}

/**
 * `repo_visibility_detected` data: the repo's visibility for a wave version, and why, plus its
 * GitHub name and URL when `gh repo view` read them.
 */
interface VisibilityFacts {
  visibility: RepoVisibility | null;
  source: "gh" | "config";
  public_hygiene: PublicHygiene;
  github?: GitHubRepo;
}

/** How the pipeline (or an account move) starts a spawn (startSpawn). */
interface SpawnPipelineOptions {
  start?: SpawnStart;
  /** The release role's playbook stage (SPEC §4.6.19): spawned under the `_release` pseudo task. */
  stage?: PlaybookStage;
  files?: Record<string, string>;
  /** A merge-mode rebase step (`branch_update: merge`): the role gets the merge brief. */
  branch_update?: "merge";
  /** A respawn of a moved or vanished agent: its own MCP servers, not the tunable's now. */
  agent_mcp?: AgentMcp;
  agent_mcp_allow?: string[];
  /** An account move's resume note, appended to the brief. */
  resumeNote?: string;
  /** An account move of a pipeline role: the attempt whose worktree it continues in. */
  worktreeAttempt?: number;
}

/** A spawned agent the daemon watches until it is retired. */
interface Supervised {
  wave: WaveId;
  task: string;
  role: Role;
  host: Host;
  /** A remote agent's forward (tunnelKey): its reap waits while that tunnel is down. */
  tunnel?: string;
  /** Set once a reap was deferred for the tunnel (one alarm per outage). */
  reapDeferred?: boolean;
  namespace: string;
  watch: AgentWatch;
  lockPath: string;
  minted: boolean;
  workspace: string;
  /** Armed while the status is `reaped`: retires the agent unless it comes back first. */
  reapTimer?: TimerHandle | undefined;
  /** The `reaped` status being re-verified (clock.ts). */
  pendingReap?: PendingReap | undefined;
  /** `wall_time` of a `reaped` status a heartbeat suppressed: never accepted, even re-delivered. */
  suppressedReap?: string | undefined;
  /** `wall_time` of the final status last handed to the pipeline (a re-delivery is ignored). */
  finalSeen?: string | undefined;
  /** `wall_time` of the `blocked` status last handed to the pipeline (a re-delivery is ignored). */
  blockedSeen?: string | undefined;
  /** When that `blocked` was handed over (the invariant sweep asks itself a window later). */
  blockedAt?: number | undefined;
  /** `wall_time` of the `blocked` the daemon itself asked about (or tried to): asked once. */
  blockedAsked?: string | undefined;
  /** Blocked with no decision naming it since (liveness: an undecided block stalls). */
  undecidedSince?: number | undefined;
  /** The latest status other than `reaped` (what liveness checks while a reap is suppressed). */
  liveStatus?: string | undefined;
  /** The hook-signal activity model (liveness.ts). */
  liveness: AgentLiveness;
  /** Background shells the latest screen capture's footer counts (null: unreadable). */
  shellsRunning?: number | null;
  /** The agent's worktree from its `agent_spawned` record (null: none recorded), once looked up. */
  worktree?: string | null;
  /** Resumed after a restart: `workspace` is the journaled ref, which may name another now. */
  restored?: boolean;
}

/** The liveness decision slot a decision's `class` fills. */
const SLOT_OF: Record<string, DecisionSlot> = {
  agent_question: "question",
  agent_stalled: "stalled",
  [CREDIT_CLASS]: "credit",
  [UNVERIFIED_CLASS]: "credit",
  [LIMITED_CLASS]: "credit",
  hooks_silent: "silent",
  screen_static: "silent",
};

const secondsMs = (s: number) => s * 1000;
/**
 * An account op answered after a long run outside the daemon's queue (`peer_doctor`): `later`
 * resolves to the answer and the `_system` record to journal with it.
 */
interface DeferredAuth {
  later: () => Promise<AuthOutcome & { journal?: NewEvent }>;
}

/** Pairing ops only an admin may run: answered on the account-op topic (SPEC §4.6.14). */
const PEER_ADMIN_OPS: ReadonlySet<string> = new Set([
  "peer_invite",
  "peer_remove",
  "peer_doctor",
  // An admin archives any ended wave (SPEC §4.6.20), whoever owns it.
  "archive",
]);

/** A task's why_waiting while its spawn failure is unrecovered. */
function spawnFailedWhy(f: SpawnFailure, now: number): string {
  if (f.next_retry_at === null) {
    return `spawn failed: ${f.code} — retries stopped after ${f.attempt} attempt${f.attempt === 1 ? "" : "s"}`;
  }
  const s = Math.max(0, Math.ceil((Date.parse(f.next_retry_at) - now) / 1000));
  return `spawn failed: ${f.code} — retry in ${s}s (attempt ${f.attempt})`;
}

/** A `spawn_failed` decision's answers: retry at once (no backoff), or cancel the task. */
const SPAWN_FAILED_OPTIONS = ["retry now", "stop task"];
const SPAWN_STOP_ANSWER = "stop task";
/** The task a `spawn_failed` decision is about (a release stage's is wave-level: `_release`). */
function spawnFailedTask(d: DecisionRecord): TaskId | null {
  const on = (d as { pipeline?: { on?: unknown; task?: unknown } }).pipeline;
  return d.task ?? (on?.on === "spawn_failed" && on.task === RELEASE_TASK ? RELEASE_TASK : null);
}

/**
 * Whether a task's worktree is gone: a local task's worktree removed by `volleyd cleanup` (or by
 * hand), so its git checks move to the repo root. A remote box's worktree is never probed here.
 * `task` is the definition as ran (`ranTaskDef`); an unplaced `host: auto` task is local, as the
 * daemon's `execFor` falls back to its own host for one.
 */
export function worktreeGone(
  task: Pick<WaveTask, "host"> | undefined,
  path: string,
  exists: (path: string) => boolean = existsSync,
): boolean {
  const local = task === undefined || task.host === "local" || task.host === AUTO_HOST;
  return local && !exists(path);
}

/**
 * Task `id`'s definition in the effective plan, on the host its agents were spawned on (its
 * `host_actual`, #323): a plan version that writes another host for a started task never
 * moves it. The plan's inline `host:` names the plan's host, not that one: it is dropped.
 */
export function ranTaskDef(rec: WaveRecord | undefined, id: TaskId): WaveTask | undefined {
  const def = rec?.wave?.tasks[id];
  const actual = rec?.state?.tasks.find((t) => t.id === id)?.host_actual;
  if (def === undefined || actual === undefined || actual === def.host) return def;
  const { host_spec: _s, ...rest } = def;
  return { ...rest, host: actual };
}

/**
 * The id of a role's `spawn_failed` decision: hashed over its wave, task and role, so two waves
 * with the same task never share one (a `-<n>` suffix keeps a wave's later ones apart).
 */
export function spawnFailedDecisionId(wave: WaveId, task: TaskId, role: Role): string {
  return waveDecisionId("spawn_failed", wave, task, role);
}
/** How volleyd resolves the decision it supersedes once the automatic retries stop. */
const SPAWN_RETRIES_STOPPED = { answer: "retries_stopped", by: DAEMON_AGENT_ID };

/** The steering an agent whose hooks the broker refused gets (with an Escape) right away. */
const AUTH_FAILED_PAUSE =
  "stop: your broker login is being repaired. Do not continue working, push or open anything: volleyd relaunches this role with a fresh login (or cancels it) once the owner answers.";

/** What one pressure sample measured: machine-global signals, plus the CI queue per repo dir. */
export interface PressureReading {
  samples: Omit<Samples, "api_overload" | "ci_queue">;
  ci: Record<string, Sample>;
}

/** Samples machine pressure. `repos` are the running waves' repo directories (for the CI queue). */
export type PressureSource = (ctx: {
  repos: string[];
  config: Tunables;
}) => Promise<PressureReading>;

/**
 * The fenced samplers in src/pressure, run concurrently; a failing one is an unknown signal.
 * A repo's CI queue is re-sampled at most every `ci_queue_sample_ms` (it spends GitHub API
 * quota); ticks in between reuse its last sample.
 */
export function systemPressure(exec: ExecFn, now: () => number): PressureSource {
  const ciCache = new Map<string, { at: number; sample: Promise<Sample> }>();
  const ciQueue = (repo: string, timeout: number) => {
    const t = now();
    const hit = ciCache.get(repo);
    if (hit !== undefined && t - hit.at < DAEMON_DEFAULTS.ci_queue_sample_ms) return hit.sample;
    const sample = sampleCiQueue(exec, repo, timeout);
    ciCache.set(repo, { at: t, sample });
    return sample;
  };
  return async ({ repos, config }) => {
    const timeout = DAEMON_DEFAULTS.sampler_timeout_ms;
    for (const repo of ciCache.keys()) if (!repos.includes(repo)) ciCache.delete(repo);
    const [memory_pressure, cmux_ping, containers, ...ci] = await Promise.all([
      sampleMemory(exec, timeout),
      // Above the threshold, so a hung socket reads as over it rather than as unknown.
      sampleCmuxPing(exec, config.admission.cmux_ping_max_ms + timeout),
      sampleContainers(exec, timeout),
      ...repos.map((r) => ciQueue(r, timeout)),
    ]);
    return {
      samples: { memory_pressure, cmux_ping, containers },
      ci: Object.fromEntries(repos.map((r, i) => [r, ci[i] as Sample])),
    };
  };
}

/**
 * The supervisor's own doctor (SPEC §4.6.15): `volley peer doctor --json [--repo <repo>]` through
 * the fence. The supervisor is no peer (it has no `peer.json`), so the running wave's repo is the
 * clone it checks; with none, the report's `repo.*` checks only say that no repo was given.
 */
export function realLocalDoctor(
  exec: ExecFn = realExec,
): (repo: string | null, signal: AbortSignal) => Promise<DoctorReport | null> {
  return async (repo, signal) => {
    const argv = ["volley", "peer", "doctor", "--json", ...(repo !== null ? ["--repo", repo] : [])];
    const r = await exec(argv, {
      timeoutMs: DAEMON_DEFAULTS.local_doctor_timeout_ms,
      signal,
      // Its own children (`gh`, `bun`, …) write under $HOME too: a stop ends them with it.
      group: true,
    }).catch(() => null);
    // A failing block check exits 1 with the report on stdout.
    return r === null ? null : parseDoctorReport(r.stdout);
  };
}

/**
 * Whether `claude` and `bun` resolve on `path` (the daemon's own `PATH`, which its agent sessions
 * inherit): what `command -v` answers on a box, without a shell.
 */
export function pathProbe(path: string | undefined = process.env.PATH): PathProbe {
  const dirs = (path ?? "").split(delimiter).filter((d) => d !== "");
  const on = (tool: string) =>
    dirs.some((d) => {
      try {
        accessSync(join(d, tool), fsConstants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  return Object.fromEntries(PATH_TOOLS.map((t) => [t, on(t)])) as PathProbe;
}

/** A wave file's `repo` as a directory (`~/x` → `$HOME/x`). */
const repoDir = (repo: string) =>
  repo === "~" || repo.startsWith("~/") ? join(homedir(), repo.slice(1)) : repo;

/** The hysteresis key of the global (wave-independent) admission verdict. */
const GLOBAL = "";

/**
 * The daemon's MQTT clientId. Stable, so its persistent session (and mailbox subscription)
 * survives restarts and the broker queues control requests sent while it is down (SPEC §4.4).
 */
/** Agents the wave's journal retired (task.agents still names the last one per role). */
const retiredAgents = (log: WaveLog): Set<string> =>
  new Set(
    log.journal
      .readAll()
      .filter((e) => e.type === "agent_retired")
      .map((e) => e.data.agent_id as string),
  );

/** Task stages a steer is refused in: nothing will ever read it. */
const UNSTEERABLE: ReadonlySet<TaskStage> = new Set(["done", "cancelled", "blocked"]);
/** Stages whose task the pipeline no longer asks about: a blocked agent there is the daemon's. */
const SETTLED_STAGES: ReadonlySet<TaskStage> = new Set(["done", "merge_ready", "cancelled"]);
/** The daemon's own `agent_blocked` (blockedFallback): a block the pipeline could not own. */
const BLOCKED_CLASS = "blocked_unhandled";

/** An admitted task still waiting for its first implementer (spawnAdmitted, the hard ceiling). */
const awaitsImplementer = (t: TaskState): boolean =>
  t.stage === "queued" && t.agents.implementer === undefined;

/** Stages whose task, with no agent live, has a pipeline role still to spawn (the ceiling). */
const BETWEEN_ROLES: ReadonlySet<TaskStage> = new Set([
  "implement",
  "spec_review",
  "quality_review",
  "fixup",
]);

export const daemonClientId = (namespace: string) =>
  `volley-${DAEMON_AGENT_ID}-daemon-${namespace}`;

type Reply = Omit<ControlResponse, "text" | "acked_type" | "op">;

type HandlerResult = Reply & {
  /** Sent instead as the answer once it settles (steer's ack wait), off the serial queue. */
  defer?: Promise<Reply>;
};

const OPEN_ADMISSION: Admission = { allow: Number.POSITIVE_INFINITY, reasons: [] };
/** The per-host thresholds of `eff`: placement's minimums, admission's hysteresis. */
const hostThresholds = (eff: Tunables): HostThresholds => ({
  mem_available_min_pct: eff.placement.mem_available_min_pct,
  load_per_core_max: eff.placement.load_per_core_max,
  hysteresis_samples: eff.admission.hysteresis_samples,
});
/** Whether a wave places tasks (SPEC §4.6.15): `placement: auto`, or a task still `host: auto`. */
const placing = (w: Wave): boolean =>
  w.placement === AUTO_HOST ||
  w.task_order.some((id) => needsPlacement(w.tasks[id] ?? { host: "" }));

/** The alarm a `placement: local` wave raises once when the own machine is overloaded while a peer idles. */
const PEER_IDLE_ALARM = "peer_idle_under_load";

/** Where a wave's `peer_idle_under_load` alarm stands: raised at most once, then cleared. */
type PeerIdleAlarm = "none" | "raised" | "cleared";

/** The wave journal's last word on its `peer_idle_under_load` alarm. */
function peerIdleAlarmState(events: readonly JournalEvent[]): PeerIdleAlarm {
  let at: PeerIdleAlarm = "none";
  for (const e of events) {
    if (e.task !== undefined || e.data.alarm !== PEER_IDLE_ALARM) continue;
    if (e.type === "alarm_raised") at = "raised";
    else if (e.type === "alarm_cleared") at = "cleared";
  }
  return at;
}

/** Before the first pressure sample nothing is known about load, so nothing starts. */
const AWAITING_SAMPLE: Admission = { allow: 0, reasons: ["waiting for the first pressure sample"] };
const LIVE_STATUS = new Set(["spawning", "registered", "working"]);

const LOCK_FILE = "volleyd.lock";

/** Owner statuses that make its `coordinator.state` `gone`. */
const OWNER_GONE = new Set(["reaped", "done", "failed"]);

/** The wave_complete decision's id (one per wave, never shared with another wave). */
const waveCompleteDecisionId = (wave: WaveId) => waveDecisionId("wave_complete", wave);

/** Every agent's registry entry: the coordinator names they carry (SPEC §6.2). */
const REGISTRY_FILTER = "volley/_system/registry/+";
/** The `activity` line a UserPromptSubmit hook publishes for a new prompt (SPEC §4.3). */
const PROMPT_RECEIVED = "prompt received";
/** Every agent's progress, in every namespace: the daemon's ONE progress subscription. */
const PROGRESS_FILTER = "volley/+/+/progress";
/** The daemon's mailbox in every namespace (a wave's agents ack in the wave's namespace). */
const MAILBOX_FILTER = `volley/+/${DAEMON_AGENT_ID}/mailbox`;

/**
 * Take the exclusive `$VOLLEYD_HOME/volleyd.lock` (holding our pid) before touching any journal,
 * so a second daemon on the same home never opens — or truncates — a live daemon's files. A lock
 * whose pid is gone is stale and replaced. Returns the release function.
 */
function acquireHomeLock(home: string): () => void {
  mkdirSync(home, { recursive: true });
  const file = join(home, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = openSync(file, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let pid = Number.NaN;
      try {
        pid = Number.parseInt(readFileSync(file, "utf-8"), 10);
      } catch {}
      if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) {
        throw new Error(`volleyd already running (pid ${pid} holds ${file})`);
      }
      try {
        unlinkSync(file);
      } catch {}
      continue;
    }
    try {
      writeSync(fd, `${process.pid}\n`);
    } finally {
      closeSync(fd);
    }
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      try {
        unlinkSync(file);
      } catch {}
    };
  }
  throw new Error(`volleyd: cannot take ${file}`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Refuse to start while another daemon's retained status is live. Uses its own clean connection
 * with a random clientId: connecting with the daemon's fixed clientId would evict a live daemon.
 */
async function assertNotRunning(opts: DaemonOptions): Promise<void> {
  const topic = buildTopic(opts.namespace, DAEMON_AGENT_ID, "status");
  const probe = new VolleyBroker();
  await probe.connect({
    url: opts.brokerUrl,
    agentId: `${DAEMON_AGENT_ID}-probe`,
    ...authFields(opts.auth),
  });
  try {
    const prior = await probe.queryRetained(topic, DAEMON_DEFAULTS.probe_ms);
    const priorType = prior !== null ? parseEnvelope(prior)?.type : undefined;
    if (priorType !== undefined && LIVE_STATUS.has(priorType)) {
      throw new Error(`volleyd already running (retained ${topic} is '${priorType}')`);
    }
  } finally {
    await probe.disconnect();
  }
}

/**
 * The volleyd daemon: registers as agent `volleyd` (LWT armed), owns every wave journal, answers
 * control requests on its mailbox — kept in a persistent MQTT session on a stable clientId, so
 * requests sent while it is down are delivered on the next start — and publishes retained wave
 * state + the event mirror after every journal append. All work (control ops, ticks) runs
 * through one serial queue. A lost broker connection is fatal (`closed`): the service manager
 * restarts the process, which is simpler and safer than re-arming everything in-process.
 */
export class Daemon {
  private readonly broker = new VolleyBroker();
  /** The control connection to the broker's Dynamic Security plugin (dynsec.ts), if any. */
  private readonly dynsec: DynsecControl | undefined;
  /** Agent logins: minted on spawn, deleted on retire / stop / sweep. */
  private readonly credentials: CredentialStore | undefined;
  private readonly sweeper: CredentialSweeper | undefined;
  private sweepTimer: TimerHandle | undefined;
  /** Re-counts the agent logins for `status` (CredentialSweeper.refreshSoon). */
  private countTimer: TimerHandle | undefined;
  /** The namespace each swept candidate's records live in (found while judging liveness). */
  private readonly sweepNamespaces = new Map<string, string>();
  private readonly waves = new Map<WaveId, WaveLog>();
  /** GitHub's status page reader (githubStatus), made on first use. */
  private statusPageRead: (() => Promise<GithubStatus>) | undefined;
  /** The needs-you inbox (SPEC §4.6.18), by item id: rebuilt from the journals on start. */
  private readonly inbox = new Map<string, InboxItem>();
  /**
   * What carries out an answer to an item that is not a decision (a decision's answer resolves
   * it): pickers and handoffs (below), release stages, registered by their subsystems. It runs
   * after the referee's check and before the answer is recorded: a reason it returns (or throws)
   * refuses the answer and the item stays open.
   */
  readonly inboxHandlers = new Map<InboxKind, InboxHandler>([
    ["picker", (item, req) => this.carryInboxAnswer(item, req, carryPicker)],
    ["handoff", (item, req) => this.carryInboxAnswer(item, req, carryHandoff)],
  ]);
  /** Archived waves (archive.ts): out of the live set, kept for `status --all` and the index. */
  private readonly archived = new Map<WaveId, WaveLog>();
  /** When each legacy ended wave ended, read once from its journal (records before `ended_at`). */
  private readonly legacyEndedAt = new Map<WaveId, string | null>();
  /** Why ready tasks were not admitted on the last tick, per wave. */
  private readonly heldBack = new Map<WaveId, string[]>();
  /** The last "release playbook not run" reason logged per wave, so a tick does not repeat it. */
  private readonly playbookNotRun = new Map<WaveId, string>();
  /** Each task's issue-body `Files` list, per wave (journaled on `task_queued`; overlap only). */
  private readonly issueFiles = new Map<WaveId, Record<TaskId, string[]>>();
  private readonly config: ConfigStore;
  /** The `_system` journal (config changes, lease events, the kill switch); shared with the config store. */
  private readonly system: Journal;
  /** `stop --all` engaged: every wave admits nothing and `run` is refused until `resume --all`. */
  private killSwitch: boolean;
  private readonly acks: AckTracker;
  /**
   * Mailbox messages volleyd sent whose ack it waits for before waking an idle addressee, by
   * message id: armed by deliverSteer, dropped on the ack; `woken` once the wake line was typed.
   */
  private readonly wakes = new Map<
    string,
    {
      agent: string;
      wave: WaveId;
      task: TaskId;
      timer: TimerHandle;
      woken: boolean;
    }
  >();
  /** Epoch ms of each agent's last submitted wake: a wake drains every message sent before it. */
  private readonly lastWokenAt = new Map<string, number>();
  /** Agents whose wake line was typed but whose Enter failed: their next wake sends only Enter. */
  private readonly wakeTyped = new Set<string>();
  /** Restart reconciliation, started by `start()` beside the queue (see `reconciled()`). */
  private reconciling: Promise<void> = Promise.resolve();
  /** Epoch ms of the last progress message seen per agent id (heartbeats, for `claim`). */
  private readonly lastSeen = new Map<string, number>();
  /**
   * When this process started. `lastSeen` is in memory only, so for `claim` every owner counts
   * as seen at least at daemon start: a restart never makes a live owner instantly claimable.
   */
  private readonly startedAt: number;
  /** Subscriptions released on `stop` (never the mailbox: it lives in the persistent session). */
  private readonly unsubscribers: (() => Promise<void>)[] = [];
  private leases: LeaseBook;
  /** Pools this process has published a retained state for (so a removed one can be cleared). */
  private readonly publishedPools = new Set<string>();
  /** Arrival times (ms) of API overload / credit signals seen on agents' progress channels. */
  private apiSignals: number[] = [];
  /** Agent watches fed from the one progress subscription, by progress topic. */
  private readonly progressRoutes = new Map<
    string,
    Set<(m: { topic: string; payload: string }) => void>
  >();
  /** Digests of recent progress messages: a copy delivered twice is handled once. */
  private readonly seenProgress = new Set<string>();
  /** The latest status (type, wall_time) of every agent id, for a wave owner's `coordinator`. */
  private readonly statusOf = new Map<string, { type: string; at: string }>();
  /**
   * The terminal statuses `statusOf` forgot (agents owning no wave, with no coordinator name known),
   * the newest `dedupe_max`: the status replay can arrive before the registry replay, and a
   * named entry arriving later takes its status back from here.
   */
  private readonly endedStatusOf = new Map<string, { type: string; at: string }>();
  /** What each agent's progress says about its attention (a wave owner's `coordinator`). */
  private readonly attentionOf = new Map<
    string,
    Omit<CoordinatorAttention, "agent_id" | "last_seen">
  >();
  /**
   * When each wave owner's `coordinator` was last re-published for its attention (epoch ms): a
   * quiet but heard-from owner's `last_seen` is refreshed every `claim_after_s / 4`.
   */
  private readonly attentionPublishedAt = new Map<string, number>();
  /** Registry entries that carry a coordinator name (SPEC §6.2), by agent id. */
  private readonly namedEntries = new Map<string, RegistryEntry>();
  /** The workspace each registered session's entry names: whose screen a ref is (`carryInboxAnswer`). */
  private readonly registryWorkspaces = new Map<string, string>();
  /**
   * Coordinator name → the agent bound to it (`bindOwner`); `gone_at` (daemon ms) once that agent
   * went away with no other bound, which starts `autopilot.reconnect_grace_s`.
   */
  private readonly bindings = new Map<string, Binding & { gone_at?: number }>();
  /** Per coordinator name: the timer that turns its waves' `reconnecting` into `gone`. */
  private readonly reconnectTimers = new Map<string, TimerHandle>();
  /** Mailbox topics (one per namespace) whose stray retained message this process cleared. */
  private readonly clearedMailboxes = new Set<string>();
  private lastReading: PressureReading | null = null;
  private sampledAt: Date | null = null;
  /** Hysteresis state before the last sample, per wave (GLOBAL = machine-wide), for re-decides. */
  private prevAdmission = new Map<string, AdmissionState>();
  private readonly verdicts = new Map<string, Verdict>();
  private summary: AdmissionSummary | null = null;
  private sampling = false;
  private readonly log: (line: string) => void;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: TimerHandle | undefined;
  private watchdog: TimerHandle | undefined;
  private screenTimer: TimerHandle | undefined;
  private running = false;
  /** Spawn launch halves and journal appends (with their publishes) in flight: `settled`. */
  private readonly inflight = new Set<Promise<unknown>>();
  /** Spawns between start and launch, by `<wave>/<task>/<role>`. */
  private readonly spawning = new Set<string>();
  /** Automatic spawns refused this run: retried by the loop with backoff (`volleyd spawn` now). */
  private readonly refused = new Map<string, { n: number; until: number }>();
  /** Held decisions whose PR / issue gh is checking now (`<wave>/<id>`): one check at a time. */
  private readonly heldChecks = new Set<string>();
  /** When each held decision's PR / issue was last checked (`<wave>/<id>`): once per ci_poll_ms. */
  private readonly heldCheckedAt = new Map<string, number>();
  /** Each wave's pipeline driver (T6), created on first use. */
  private readonly pipelines = new Map<WaveId, PipelineDriver>();
  /** The release train's stage driver per releasing wave (SPEC §4.6.19). */
  private readonly releases = new Map<WaveId, ReleaseTrain>();
  /**
   * The merge queue's release-branch locks (SPEC §4.6.17), shared by every wave on this daemon:
   * `<repo>#<release_branch>` → the `<wave>/<task>` holding its merge turn. Two waves on one
   * release branch never merge at once.
   */
  private readonly releaseLocks = new Map<string, string>();
  /** Live spawned agents by agent id. */
  private readonly supervised = new Map<string, Supervised>();
  /** Terminal statuses received and not yet journaled about (watchdog.ts), by agent. */
  private readonly terminals = new Map<string, TerminalSeen & { wave: WaveId }>();
  /** Per agent: the seq of the latest wave journal event naming it (watchdog.ts namedAgent). */
  private readonly lastNamed = new Map<string, number>();
  /** Per agent: the seq of the latest decision, retire or relaunch naming it (decidedAgent). */
  private readonly lastDecided = new Map<string, number>();
  /** `<wave>/<task>` of each task whose host reached a resolver as `auto` (one alarm each per daemon run). */
  private readonly autoHostAlarmed = new Set<string>();
  /** `<agent>@<wall_time>` of each terminal status the watchdog has alarmed on. */
  private readonly terminalAlarmed = new Set<string>();
  /** Answered control requests by `<sender>/<correlation_id>`, for QoS 1 redelivery. */
  private readonly answered = new Map<string, ControlResponse>();
  /** Requests whose answer is deferred (steer's ack wait), by the same key. */
  private readonly deferred = new Set<string>();
  /** A stopped wave's grace timer (`stop_grace_s`): then its silent agents are force-retired. */
  private readonly stopGrace = new Map<WaveId, TimerHandle>();
  /** Answered auth requests by `<topic>/<correlation_id>`, for QoS 1 redelivery. */
  private readonly authAnswered = new Map<string, AuthReply>();
  /** When each account last sent an auth request (account_list's `last_seen`). */
  private readonly authSeen = new Map<string, string>();
  private pruneTimer: TimerHandle | undefined;
  /** The last token-prune failure logged, so a broker without `volley auth` logs it once. */
  private pruneError: string | null = null;
  /** Screen tails of supervised agents (T13); reads run beside the serial queue. */
  private readonly screens: ScreenPublisher;
  /** Remote hosts (T15) by resolved spec, their reverse tunnels and tunnel checks. */
  private readonly remotes = new Map<string, RemoteHost>();
  private readonly tunnels: TunnelSupervisor;
  private readonly tunnelChecks: TunnelChecks;
  /** Spawns parked on a remote host's tunnel, by `<wave>/<task>`: the why_waiting text. */
  private readonly parked = new Map<string, string>();
  /** Why a forward (tunnelKey) is down, when it is more than its check failing. */
  private readonly tunnelDownWhy = new Map<string, string>();
  /** The tunnels' shutdown, started by halt(); stop() waits for it. */
  private tunnelsStopped: Promise<void> = Promise.resolve();
  /** Remote trust re-reads for open repo_untrusted decisions: when each last started. */
  private readonly trustChecks = new Map<string, { at: number; inFlight: boolean }>();
  /** Claude account profiles: registry, sign-ins, sharing (src/claude/service.ts). */
  private readonly claude: ClaudeService;
  /** Paired machines (peers.ts) and their heartbeats (machines.ts). */
  private readonly peers: PeerService;
  /** `setup_plan` / `setup_apply` (setup-ops.ts), answered beside the serial queue. */
  private readonly setupOps: SetupOps;
  /** Setup requests being answered (topic/correlation id): a re-delivery waits for the answer. */
  private readonly setupInFlight = new Set<string>();
  private readonly machines: MachineHealth;
  /**
   * Usage metering (claude/usage.ts): every agent's latest sample, folded per account. The
   * accounts' windows are kept in `$VOLLEYD_HOME/claude-usage.json` across restarts.
   */
  private usage: UsageBook;
  /** Every spawned agent's wave and host (from `agent_spawned`): where its usage belongs. */
  private readonly spawnedAgents = new Map<string, { wave: WaveId; host: string }>();
  // --- Fleet (F6): down, drain and remove-now ---
  /** Agents launched and still being verified (not supervised yet), by id. */
  private readonly launching = new Map<string, { wave: WaveId; task: TaskId; role: Role }>();
  /** Decisions a launch's verification opened, settled once that launch is supervised. */
  private readonly unsettled = new Map<string, Array<{ wave: WaveId; id: string }>>();
  /** A remove-now's agents told to stop, by id: when (their grace counts from it). */
  private readonly evicted = new Map<string, number>();
  /** Since when a configured host has been seen draining (`hosts.<name>.drain`). */
  private readonly drainSeen = new Map<string, number>();
  /** When each paired machine was removed (`_system`'s `peer_removed`). */
  private readonly removedAt = new Map<string, number>();
  /**
   * A `respawn` approved while the task's machine was closed, by `<wave>/<task>`: its role and
   * how it continues the vanished agent (moveRespawn).
   */
  private readonly heldRespawn = new Map<string, { role: Role; pipeline: SpawnPipelineOptions }>();
  // --- Fleet (F2): the supervisor's own record, readiness verdicts, PATH probes ---
  /** The version a machine must run (its readiness `requirements.volley`). */
  private readonly version: string;
  /** The supervisor's own machine record, as last published (and when). */
  private ownRecord: MachineRecord | undefined;
  private ownRecordAt: number | null = null;
  /**
   * The supervisor's own doctor: its last report, the repo that run checked (null: none; undefined:
   * no run finished yet), when it last started, whether it runs now.
   */
  private localReport: DoctorReport | null = null;
  private localDoctorRepo: string | null | undefined = undefined;
  /** The repo the last run started with (a failed run is not retried before the next beat). */
  private localDoctorTried: string | null = null;
  private localDoctorAt: number | null = null;
  private localDoctorRunning = false;
  /** The run in flight (a stop awaits it) and what aborts it (halt). */
  private localDoctorRun: Promise<void> | null = null;
  private readonly localDoctorAbort = new AbortController();
  /**
   * Machines whose verdict has its inputs in this process (SPEC §4.6.15): until then a verdict is
   * neither published nor journaled, so a restart neither replaces the last retained verdict nor
   * journals a flip from inputs not gathered yet. `fleetSince`: when this process began, the
   * bound on the wait (`machine_down_after_ms`).
   */
  private readonly readinessSettled = new Set<string>();
  private fleetSince: number | null = null;
  /** Hosts a `peer_doctor` runs on now (one at a time per host), and the requests it answers. */
  private readonly doctoring = new Set<string>();
  private readonly authRunning = new Set<string>();
  /** Each peer's last PATH probe (`path` null: none yet; `error`: ssh failed), by name. */
  private readonly probes = new Map<
    string,
    { path: PathProbe | null; error?: string; at: number; running: boolean }
  >();
  /** Each machine's verdict as last published (`key`: readinessKey) and when. */
  private readonly published = new Map<string, { key: string; at: number }>();
  /** The own machine's last computed `local_agents` (its verdict's), for `volleyd status`. */
  private ownLocalAgents: ReadinessPayload["local_agents"];
  /** Each machine's `ready` / `reasons` as last journaled (`machine_readiness_changed`). */
  private readonly journaledReadiness = new Map<string, { ready: boolean; reasons: string[] }>();
  // --- Fleet (F3): placement ---
  /**
   * Each peer's last heartbeats (per-host admission), oldest first, at most the largest
   * `hysteresis_samples` in force; `last_seen` is the newest one's, so a re-delivered record (a
   * reconnect's retained copy, a QoS 1 duplicate) is not counted again.
   */
  private readonly hostHistory = new Map<string, { last_seen: string; samples: HostSamples[] }>();
  /** Where each running wave's `peer_idle_under_load` alarm stands (none, raised, cleared). */
  private readonly peerIdleWarned = new Map<WaveId, PeerIdleAlarm>();
  /** Why a ready task of a placing wave was not admitted (`<wave>/<task>`: no eligible machine). */
  private readonly heldTask = new Map<string, string>();
  /** The account records last published, by account (an unchanged one is not re-published). */
  private readonly publishedUsage = new Map<string, string>();
  /** Agents an `agent_move_account` is stopping: their final status is the move's, not the pipeline's. */
  private readonly moving = new Set<string>();
  /** Sleep/wake detection (T8): the last clock sample and the latest wake. */
  private clock: ClockState = initialClock();
  /** Each wave's digest as last published (SPEC §4.6.16); the retained topic after a restart. */
  private readonly digests = new Map<WaveId, Digest>();
  /** `onJournal` listeners. */
  private readonly journalListeners = new Set<(wave: WaveId, event: JournalEvent) => void>();
  /** Every timer and wall-clock read (DaemonOptions.clock). */
  private readonly time: Clock;
  /** Liveness clock (epoch ms): `time.now`. */
  private readonly now: () => number;
  /** The admission samplers (one CI-queue cache across ticks), on the daemon's clock. */
  private readonly samplePressure: PressureSource;
  private resolveClosed!: (e: Error) => void;
  /**
   * Resolves (never rejects) with the reason when the daemon dies on its own — today, a lost
   * broker connection. The process should exit non-zero so the service manager restarts it;
   * a restart resumes the persistent session and restores every wave from its journal.
   */
  readonly closed: Promise<Error> = new Promise((r) => {
    this.resolveClosed = r;
  });

  private constructor(
    private readonly opts: DaemonOptions,
    private readonly releaseLock: () => void,
  ) {
    this.log = opts.log ?? (() => {});
    // real clock: the default of DaemonOptions.clock
    this.time = withNow(opts.clock ?? systemClock, opts.now);
    this.now = this.time.now;
    this.samplePressure = opts.pressure ?? systemPressure(realExec, this.now);
    this.startedAt = this.now();
    this.acks = new AckTracker(this.time);
    this.system = Journal.open(join(opts.home, "waves", SYSTEM_WAVE));
    this.observeJournal(SYSTEM_WAVE, this.system);
    this.config = ConfigStore.load({
      home: opts.home,
      system: this.system,
      now: () => dateOf(this.time),
      ...(opts.configDefaults !== undefined ? { defaults: opts.configDefaults } : {}),
    });
    this.leases = replayLeases(this.system.readAll());
    this.version = opts.fleet?.version ?? pkg.version;
    for (const e of this.system.readAll()) {
      if (e.type !== "machine_readiness_changed") continue;
      const { name, ready, reasons } = e.data as {
        name: string;
        ready: boolean;
        reasons: string[];
      };
      this.journaledReadiness.set(name, { ready, reasons });
    }
    if (opts.spawner?.credentials !== undefined) {
      this.credentials = opts.spawner.credentials;
    } else if (opts.dynsecAdmin !== undefined) {
      this.dynsec = new DynsecControl({
        connect: brokerControl(opts.brokerUrl, opts.dynsecAdmin),
        batchMs: () => this.config.get("dynsec_batch_ms") as number,
        binaryVersion: async () => {
          const r = await realExec(["mosquitto", "-h"]).catch(() => null);
          return r === null ? null : `${r.stdout}\n${r.stderr}`;
        },
        log: this.log,
        clock: this.time,
      });
      this.credentials = new DynsecCredentials(this.dynsec, this.time);
    }
    if (this.credentials !== undefined && opts.spawner?.mintCredentials !== false) {
      const store = this.credentials;
      this.sweeper = new CredentialSweeper(
        {
          credentials: store,
          live: (candidates) => this.liveAgents(candidates),
          reap: (id) =>
            reapAndRevoke(id, this.sweepNamespaces.get(id) ?? this.opts.namespace, this.reapDeps()),
          journal: (ev) => this.appendSystem(ev),
          graceMs: () => secondsMs(this.config.get("spawn_timeout_s") as number),
          now: () => this.time.now(),
        },
        {
          live: 0,
          swept: this.system
            .readAll()
            .filter((e) => e.type === "credentials_swept")
            .reduce((n, e) => n + ((e.data.agent_ids as unknown[] | undefined)?.length ?? 0), 0),
        },
      );
      const sweeper = this.sweeper;
      this.credentials = recounted(store, () => sweeper.refreshSoon());
    }
    this.claude = new ClaudeService({
      root: opts.claude?.root ?? claudeRoot(),
      ...(opts.claude?.primaryDir !== undefined ? { primaryDir: opts.claude.primaryDir } : {}),
      primaryJson: this.claudeJsonPath,
      exec: opts.claude?.exec ?? realExec,
      clock: this.time,
      publish: (topic, e) => this.publish(topic, this.envelope(SIGNIN_CHANNEL, e.type, e), false),
      journal: (ev) => this.appendSystem(ev),
      log: this.log,
      ...(opts.claude?.signinPollMs !== undefined
        ? { signinPollMs: opts.claude.signinPollMs }
        : {}),
      ...(opts.claude?.signinTimeoutMs !== undefined
        ? { signinTimeoutMs: opts.claude.signinTimeoutMs }
        : {}),
      rank: (candidates, model) =>
        rankAccounts(accountRecords(this.usage), candidates, { model, now: this.now() }),
      // The primary's record carries its plan (describe) once claude_accounts has asked it.
      onPrimaryPlan: () => void this.enqueue(() => this.usagePass()),
      // --- Fleet (F8): a paired machine's sign-in (`primary@<name>`) and its forward ---
      remote: (name) => this.remoteFor(name),
      reservedPorts: () => [
        brokerAddress(opts.brokerUrl).port,
        ...Object.values(this.config.effective().hosts).map(
          (h) => h.tunnel?.remote_port ?? REMOTE_HOST_DEFAULTS.remote_port,
        ),
      ],
      ...(opts.claude?.forwardSettleMs !== undefined
        ? { forwardSettleMs: opts.claude.forwardSettleMs }
        : {}),
      // A paired machine's `primary@<name>` record and claude_accounts read its machine record.
      machineIdentity: (name) => {
        const auth = this.machines.record(name)?.auth;
        return {
          ...(auth?.claude_email !== undefined ? { email: auth.claude_email } : {}),
          ...(auth?.claude_org !== undefined ? { org: auth.claude_org } : {}),
        };
      },
      machines: () => this.machines.all(),
    });
    this.machines = new MachineHealth({
      now: this.now,
      onChange: (name, status, record) => {
        if (this.running) void this.enqueue(() => this.onMachine(name, status, record));
      },
    });
    this.setupOps = new SetupOps({
      exec: opts.authExec ?? realExec,
      volleydHome: opts.home,
      brokerUrl: opts.brokerUrl,
      env: process.env,
      now: () => dateOf(this.time),
      sleep: (ms) => new Promise((r) => this.time.setTimeout(r, ms)),
      liveAgents: () => this.liveAgentCount(),
      brokerVersion: () => this.dynsec?.version ?? null,
      ...opts.setup,
    });
    this.peers = new PeerService({
      exec: opts.authExec ?? realExec,
      now: this.now,
      file: join(opts.home, "peer-codes.json"),
      pairedFile: join(opts.home, "peers.json"),
      namespace: opts.namespace,
      broker: () => brokerAddress(opts.brokerUrl),
      hosts: () => this.config.effective().hosts,
      setHost: (name, host, by) => this.config.applyPatch({ hosts: { [name]: host } }, by),
      removeHost: (name, by) => this.config.removeHost(name, by),
      // --- Fleet (F6): drain and remove-now ---
      setDrain: (name, by) =>
        this.config.applyPatch({ hosts: { [name]: { drain: true } } } as TunablesPatch, by),
      liveAgents: (name) => this.agentsOn(name),
      clearMachine: async (name) => {
        this.machines.forget(name);
        await this.clearRetained(machineTopic(name));
        await this.clearReadiness(name);
      },
      localName: () => this.config.localName(),
      remote: (name) => this.remoteFor(name),
      machines: () => this.machines.all(),
      journal: (ev) => this.appendSystem(ev),
    });
    this.killSwitch = killSwitchEngaged(this.system.readAll());
    this.screens = new ScreenPublisher({
      publish: (topic, payload) => this.broker.publish(topic, payload, { qos: 0, retain: true }),
      clock: this.time,
      ...opts.screenTimeouts,
      onStale: (agentId) => {
        const a = this.supervised.get(agentId);
        if (a !== undefined) void this.enqueue(() => this.publishState(a.wave));
      },
      log: this.log,
    });
    this.tunnels = new TunnelSupervisor({
      exec: opts.spawner?.remoteExec ?? realExec,
      log: this.log,
      clock: this.time,
      onExit: (x) => this.onTunnelExit(x),
    });
    this.tunnelChecks = new TunnelChecks({
      now: this.now,
      log: this.log,
      onChange: (key, status) => {
        // A check that lands after shutdown changes nothing.
        if (this.running) void this.enqueue(() => this.onTunnel(key, status));
      },
    });
    // The capture feeds the silence fallback (single reader): when each screen last changed.
    this.screens.onCapture((c) => {
      const a = this.supervised.get(c.agentId);
      if (a === undefined) return;
      a.shellsRunning = c.footer.shells_running;
      if (c.tail !== null) {
        a.liveness = noteCapture(a.liveness, { hash: c.tail.hash, at: this.now() });
      }
    });
    this.usage = existsSync(this.usageFile)
      ? restoreBook(readFileSync(this.usageFile, "utf-8"))
      : emptyBook();
    for (const log of loadWaves(opts.home)) {
      const wave = log.record.state?.wave;
      if (wave === undefined) continue;
      // Archived: never observed, published or ticked again.
      if (log.record.state?.status === "archived") {
        this.archived.set(wave, log);
        continue;
      }
      this.waves.set(wave, log);
      this.observeJournal(wave, log.journal);
      this.config.setWaveOverrides(wave, log.record.overrides);
      this.issueFiles.set(wave, journaledIssueFiles(log.journal.readAll()));
      // The backoff carries over a restart: a retry is due when the journal said it was, and
      // stopped retries stay stopped.
      for (const [task, roles] of Object.entries(log.record.spawnFailures)) {
        for (const f of Object.values(roles)) {
          const until =
            f.next_retry_at === null ? Number.POSITIVE_INFINITY : Date.parse(f.next_retry_at);
          this.refused.set(`${wave}/${task}/${f.role}`, { n: f.attempt, until });
        }
      }
    }
    foldInbox(this.inbox, this.system.readAll());
    for (const [wave, log] of this.waves) foldInbox(this.inbox, log.journal.readAll(), wave);
  }

  /**
   * Start a daemon: take the home lock, refuse if another daemon is live on the broker, and only
   * then load config and journals and connect.
   */
  static async start(opts: DaemonOptions): Promise<Daemon> {
    const release = acquireHomeLock(opts.home);
    let d: Daemon | undefined;
    try {
      await assertNotRunning(opts);
      d = new Daemon(opts, release);
      await d.connect();
      return d;
    } catch (e) {
      if (d !== undefined) {
        d.halt();
        await d.broker.disconnect().catch(() => {});
      }
      release();
      throw e;
    }
  }

  private get usageFile(): string {
    return join(this.opts.home, "claude-usage.json");
  }

  private get statusTopic(): string {
    return buildTopic(this.opts.namespace, DAEMON_AGENT_ID, "status");
  }

  private envelope(
    channel: string,
    type: string,
    payload: unknown,
    correlationId?: string,
  ): Envelope {
    return buildEnvelope({
      agentId: DAEMON_AGENT_ID,
      parentId: null,
      channel,
      type,
      payload,
      ...(correlationId !== undefined ? { correlationId } : {}),
    });
  }

  private async publish(topic: string, env: Envelope, retain: boolean): Promise<void> {
    await this.broker.publish(topic, JSON.stringify(env), { qos: 1, retain });
  }

  /** Clear a retained topic (a zero-length retained payload, SPEC §4.6). */
  private async clearRetained(topic: string): Promise<void> {
    await this.broker.publish(topic, "", { qos: 1, retain: true });
  }

  private get mailboxTopic(): string {
    return buildTopic(this.opts.namespace, DAEMON_AGENT_ID, "mailbox");
  }

  private async connect(): Promise<void> {
    const { namespace } = this.opts;
    await this.broker.connect({
      url: this.opts.brokerUrl,
      agentId: DAEMON_AGENT_ID,
      clientId: daemonClientId(namespace),
      cleanSession: false,
      sessionExpirySeconds: this.config.get("mailbox.session_expiry_s") as number,
      protocolVersion: this.opts.protocolVersion ?? 5,
      willTopic: this.statusTopic,
      willPayload: JSON.stringify(this.envelope("status", "reaped", { reason: "disconnect" })),
      ...authFields(this.opts.auth),
    });
    if (this.dynsec !== undefined) {
      // Refuse a broker older than 2.1 at start (BrokerVersionError ends `start`). Any other
      // failure only delays minting: the control connection reconnects on next use.
      try {
        await this.dynsec.open();
        this.log(`dynsec: control connection up (mosquitto ${this.dynsec.version})`);
        // A broker initialised by an older Volley keeps its old shared roles (never edited at
        // runtime): its agents' publishes on a newer channel are dropped without an error.
        const drift = await this.dynsec.agentRoleDrift().catch(() => null);
        if (drift !== null) {
          this.log(
            `dynsec: warning: the broker's volley-agent role differs from this version's (${drift}); run \`volley auth migrate --roles --yes\``,
          );
        }
      } catch (e) {
        if (e instanceof BrokerVersionError) throw e;
        this.log(
          `dynsec: control connection failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    this.running = true;

    await this.publish(this.statusTopic, this.envelope("status", "spawning", {}), true);
    await this.publish(
      registryTopic(DAEMON_AGENT_ID),
      {
        ...this.envelope("_system/registry", "registered", {
          capabilities: ["supervisor"],
          cwd: this.opts.home,
          started_at: dateOf(this.time).toISOString(),
        }),
        namespace,
      },
      true,
    );
    await this.publish(this.statusTopic, this.envelope("status", "registered", {}), true);

    // Every namespace's progress through ONE filter: a wave's agents may live in the wave's own
    // namespace, and mosquitto delivers one copy per matching subscription.
    this.unsubscribers.push(
      await this.broker.subscribeStream(PROGRESS_FILTER, (m) =>
        this.onProgress(m.topic, m.payload),
      ),
    );
    // Every agent's retained usage sample (SPEC §4.6.12), folded per Claude account.
    this.unsubscribers.push(
      await this.broker.subscribeStream(USAGE_FILTER, (m) => {
        void this.enqueue(() => this.onUsage(m.topic, m.payload));
      }),
    );
    // The records restored from disk, also those no agent reports any more.
    void this.enqueue(() => this.usagePass());
    // Paired machines' retained health records (SPEC §4.6.14).
    this.unsubscribers.push(
      await this.broker.subscribeStream(MACHINES_FILTER, (m) => {
        const name = m.topic.split("/")[3] ?? "";
        // A cleared record (peer_remove) forgets the machine, so a late `down` cannot revive it.
        if (m.payload === "") {
          void this.enqueue(async () => {
            this.machines.forget(name);
            this.hostHistory.delete(name);
          });
          return;
        }
        const parsed = parseMachineFrom(m.topic, m.payload);
        // Every account may publish its own record: only a configured host's is a machine.
        if (parsed === null) return;
        const { record, by } = parsed;
        // Our own republish (a sweep's down, a Repair's fold) coming back is no heartbeat.
        const heard = by !== "volleyd";
        void this.enqueue(async () => {
          // A configured host is a peer whatever its record says (SPEC §4.6.15): never local.
          if (!Object.hasOwn(this.config.effective().hosts, name) || record.tunnel === "local") {
            return;
          }
          const keptNewer = this.machines.observe(record, { heard });
          if (record.tunnel === "up" && heard) this.sampleHost(name, record);
          // The box's beat still carries its service's older doctor run: re-assert the newer one
          // (a Repair's) over it, so clients never see the stale checks again.
          const held = this.machines.record(name);
          if (keptNewer && heard && held !== undefined) {
            await this.publish(
              machineTopic(name),
              this.envelope(MACHINE_CHANNEL, "machine", held),
              true,
            );
          }
          await this.publishReadiness(name);
          this.foldLogins(record, name);
          // `primary@<name>`'s usage record carries this record's identity, and its logins'
          // usage probe readings (unchanged: no-op).
          await this.usagePass();
        });
      }),
    );

    this.config.onChange((c) => {
      this.log(`config v${c.version} by ${c.by}: ${JSON.stringify(c.patch)}`);
      // Mirror the _system journal event, then hot-apply: re-publish config and every wave's
      // effective_config, then re-run admission.
      void this.enqueue(async () => {
        await this.publish(
          waveEventsTopic(SYSTEM_WAVE),
          this.envelope("_waves/events", "config_changed", {
            wave: SYSTEM_WAVE,
            seq: c.seq,
            at: c.at,
            data: { by: c.by, patch: c.patch, previous: c.previous, version: c.version },
          }),
          false,
        );
        await this.publishConfig();
        for (const wave of this.waves.keys()) await this.publishState(wave);
        // Lease pools and admission thresholds are hot: re-publish every pool, re-decide the
        // last sample with the new thresholds, then grant / admit on this tick.
        await this.publishAllPools();
        this.evaluate();
        await this.publishAdmission();
        await this.tickNow();
      });
    });

    await this.publishConfig();
    await this.publishArchiveIndex();
    // An archived wave's retained topics, in case a crash came between journaling wave_archived
    // and clearing them (a clear is not a re-publish, SPEC §4.6.20).
    for (const [wave, log] of this.archived) {
      await this.clearRetained(waveStateTopic(wave));
      await this.clearRetained(waveDigestTopic(wave));
      for (const id of Object.keys(log.record.decisions))
        await this.clearRetained(decisionTopic(wave, id));
      for (const id of foldInbox(new Map(), log.journal.readAll()).keys())
        await this.clearRetained(inboxTopic(id));
    }
    for (const [wave, log] of this.waves) {
      await this.publishState(wave);
      // Re-publish open decisions; clear resolved ones, in case a crash came between journaling
      // the resolution and clearing its retained topic (a zero-length clear is idempotent).
      for (const d of Object.values(log.record.decisions)) {
        if (d.resolved === undefined) await this.publishDecision(wave, d);
        else await this.clearRetained(decisionTopic(wave, d.decision_id));
        // A decision opened before the inbox existed gets its item now.
        if (d.resolved === undefined && !this.inbox.has(decisionItemId(wave, d.decision_id)))
          await this.openDecisionItem(wave, d);
        // Resolved without closing its item (a crash between the two): closed now, as answered.
        else if (d.resolved !== undefined)
          await this.closeDecisionItem(wave, d, { by: d.resolved.by });
      }
    }
    // The journal is the record: every item is re-published (an answered one until its ttl).
    await this.sweepInbox();
    for (const item of this.inbox.values()) await this.publishInboxItem(item);
    // The two replays arrive in either order: a terminal status replayed before its session's
    // registry entry is set aside (`endedStatusOf`) and taken back when the entry arrives.
    await this.subscribeRegistry();
    await this.subscribeLeaseInputs();
    await this.publishAllPools();
    // One pressure sample before the first admission (`tick` samples first): a daemon restarted
    // on an overloaded machine must not admit every ready task (admissions are journaled, so
    // they would stick).
    await this.tick();

    // Mailbox messages are never retained (SPEC §4.1); clear a stray retained one so it cannot be
    // replayed on every subscribe. Then drain: on a resumed session this first returns what the
    // broker queued while the daemon was down. Lease requests are drained the same way.
    await this.broker.publish(this.mailboxTopic, "", { qos: 1, retain: true });
    this.clearedMailboxes.add(this.mailboxTopic);
    void this.mailboxLoop();
    // A volleyd before the every-namespace drain held only its own namespace's filter, and the
    // persistent session keeps it: beside the `+` drain it would deliver every message twice.
    // Drop it; the drain (subscribed synchronously above) already covers the topic.
    await (await this.broker.subscribeStream(this.mailboxTopic, () => {}))();
    // Likewise its own-namespace progress filter: beside PROGRESS_FILTER it doubles the traffic.
    const legacyProgress = buildTopic(this.opts.namespace, "+", "progress");
    await (await this.broker.subscribeStream(legacyProgress, () => {}))();
    void this.leaseRequestLoop();
    void this.drainLoop(AUTH_OPS_FILTER, (m) => this.onAuthRequest(m.topic, m.payload));
    void this.drainLoop(TOKEN_REDEEM_FILTER, (m) => this.onAuthRequest(m.topic, m.payload));
    // Beside the queue: its broker/git/GitHub probes take seconds and control ops must not wait.
    this.reconciling = this.reconcileAll().catch((e: unknown) =>
      this.log(`reconcile: ${e instanceof Error ? e.message : String(e)}`),
    );

    await this.publish(
      this.statusTopic,
      this.envelope("status", "working", { waves: this.waves.size }),
      true,
    );

    const tickMs = this.opts.tickMs ?? DAEMON_DEFAULTS.tick_ms;
    if (tickMs > 0) {
      // Tracked: a stop waits for a tick or screen pass already past its timer.
      this.timer = this.time.setInterval(() => void this.track(this.tick()), tickMs);
      this.screenTimer = this.time.setInterval(
        () => void this.track(this.tickScreens()),
        DAEMON_DEFAULTS.screen_tick_ms,
      );
    }
    this.watchdog = this.time.setInterval(() => {
      if (this.running && !this.broker.connected) this.fail(new Error("broker connection lost"));
    }, DAEMON_DEFAULTS.watchdog_ms);
    const pruneMs =
      this.opts.tokenPruneMs ?? (this.opts.auth !== undefined ? DAEMON_DEFAULTS.token_prune_ms : 0);
    if (pruneMs > 0) {
      this.pruneTimer = this.time.setInterval(
        () => void this.enqueue(() => this.pruneTokens()),
        pruneMs,
      );
    }
    // The sweep is mandatory (no login ever expires): at start, then every interval.
    if (this.sweeper !== undefined) {
      this.scheduleSweep(0);
      const sweeper = this.sweeper;
      this.countTimer = this.time.setInterval(
        () => sweeper.refreshSoon(),
        DAEMON_DEFAULTS.login_count_refresh_ms,
      );
    }
    this.log(`volleyd up: ${this.waves.size} wave(s), broker ${this.opts.brokerUrl}`);
  }

  /**
   * A message on some agent's progress channel, in any namespace: it goes to that agent's watch
   * (liveness, heartbeats), is a sign of life (`claim`), a SPEC §4.3 `steering_acked` settles the
   * steer it names (`correlation_id` = the message id), and an API overload signal feeds
   * admission. A copy the broker delivers twice is handled once.
   */
  private onProgress(topic: string, raw: string): void {
    const [, ns, agent] = topic.split("/");
    if (ns === undefined || agent === undefined || ns.startsWith("_")) return;
    if (!this.firstSighting(topic, raw)) return;
    for (const deliver of [...(this.progressRoutes.get(topic) ?? [])]) {
      deliver({ topic, payload: raw });
    }
    if (agent === DAEMON_AGENT_ID) return;
    const env = parseEnvelope(raw);
    if (env !== null && isApiSignal(env)) this.apiSignals.push(this.now());
    // A message queued while the daemon was down arrives late: count it from when it was sent.
    const sent = env !== null ? Date.parse(env.wall_time) : Number.NaN;
    const now = this.now();
    this.lastSeen.set(agent, Number.isNaN(sent) ? now : Math.min(now, sent));
    if (env !== null) this.noteAttention(agent, env);
    if (env !== null) this.noteInboxSignal(agent, env);
    // The topic names the sender (and is what broker ACLs authorise), so it identifies the acker.
    if (env?.type === "steering_acked" && env.correlation_id !== null) {
      this.acks.acked(env.correlation_id, agent);
      this.mailboxHeard(env.correlation_id, agent);
    }
  }

  /**
   * The attention state an agent's progress implies (SPEC §4.3): `awaiting_input` (with its
   * question, session and workspace) until anything else but `idle` or `heartbeat` says it works
   * again. An unchanged state is re-published anyway once `claim_after_s / 4` has passed, so the
   * retained `coordinator.last_seen` of a coordinator that only heartbeats stays fresh for a cold
   * Desk.
   */
  private noteAttention(agent: string, env: Envelope): void {
    // Only wave owners have a `coordinator`: other agents' attention would just pile up.
    if (env.type === "idle" || !this.ownsAWave(agent)) return;
    const p = (
      typeof env.payload === "object" && env.payload !== null ? env.payload : {}
    ) as Record<string, unknown>;
    const next: Omit<CoordinatorAttention, "agent_id" | "last_seen"> =
      env.type === "awaiting_input"
        ? {
            state: "awaiting_input",
            ...(typeof p.question === "string" && p.question.trim() !== ""
              ? { question: firstLines(p.question) }
              : {}),
            ...(typeof p.session_url === "string" && URL.canParse(p.session_url)
              ? { session_url: p.session_url }
              : {}),
            ...(typeof p.workspace === "string" && p.workspace !== ""
              ? { workspace: p.workspace }
              : {}),
          }
        : // A heartbeat only says the session is alive: it leaves `awaiting_input` standing.
          env.type === "heartbeat"
          ? (this.attentionOf.get(agent) ?? { state: "working" })
          : { state: "working" };
    const before = JSON.stringify(this.attentionOf.get(agent) ?? null);
    this.attentionOf.set(agent, next);
    const now = this.now();
    const stale =
      now - (this.attentionPublishedAt.get(agent) ?? Number.NEGATIVE_INFINITY) >=
      this.lastSeenRefreshMs(agent);
    if (before !== JSON.stringify(next) || stale) {
      this.attentionPublishedAt.set(agent, now);
      this.ownerChanged(agent);
    }
  }

  /** `claim_after_s / 4` of the waves `agent` owns (the shortest), in ms. */
  private lastSeenRefreshMs(agent: string): number {
    let s = Number.POSITIVE_INFINITY;
    for (const [wave, log] of this.waves) {
      const owner = log.record.state?.owner;
      if (owner != null && this.actsAs(agent, owner))
        s = Math.min(s, this.config.effective(wave).claim_after_s);
    }
    return secondsMs(s) / 4;
  }

  /** Does `agent` own a wave itself, or as the agent bound to the coordinator name owning it? */
  private ownsAWave(agent: string): boolean {
    for (const log of this.waves.values()) {
      const owner = log.record.state?.owner;
      if (owner != null && this.actsAs(agent, owner)) return true;
    }
    return false;
  }

  /** `agent` is `owner`, or the agent bound to the coordinator name `owner`. */
  private actsAs(agent: string, owner: string): boolean {
    return owner === agent || this.bindings.get(owner)?.agent_id === agent;
  }

  /** An agent's status or attention changed: re-publish the waves it owns (`coordinator`). */
  private ownerChanged(agent: string): void {
    if (!this.running) return;
    for (const [wave, log] of this.waves) {
      const owner = log.record.state?.owner;
      if (owner != null && this.actsAs(agent, owner))
        void this.enqueue(() => this.publishState(wave));
    }
  }

  /**
   * wave-state `coordinator` for `owner` (through its binding when it is a coordinator name);
   * undefined until anything of it was seen. A bound agent that went away is `reconnecting` for
   * `autopilot.reconnect_grace_s`, then `gone`.
   */
  private coordinatorFor(owner: string): CoordinatorAttention | undefined {
    const binding = this.bindings.get(owner);
    const agent = binding?.agent_id ?? owner;
    const status = this.statusOf.get(agent);
    const attention = this.attentionOf.get(agent);
    if (status === undefined && attention === undefined && binding === undefined) return undefined;
    const seen = [
      this.lastSeen.get(agent),
      status !== undefined ? Date.parse(status.at) : undefined,
      binding !== undefined ? Date.parse(binding.since) : undefined,
    ]
      .filter((t): t is number => t !== undefined && !Number.isNaN(t))
      .sort((a, b) => b - a)[0];
    const last_seen = new Date(seen ?? this.now()).toISOString();
    if (status !== undefined && OWNER_GONE.has(status.type)) {
      // Not yet stamped: the status was just seen and its rebind is still queued.
      const away = binding?.gone_at ?? this.wentAwayAt(status.at);
      const grace = secondsMs(this.config.effective().autopilot.reconnect_grace_s);
      const state = binding !== undefined && this.now() - away < grace ? "reconnecting" : "gone";
      return { agent_id: agent, state, last_seen };
    }
    return { agent_id: agent, ...(attention ?? { state: "working" }), last_seen };
  }

  /**
   * When a bound agent went away: its terminal status's own time (a restart replays a long-past
   * `done` as if fresh), never later than now; now when unknown.
   */
  private wentAwayAt(at: string | undefined): number {
    const t = at !== undefined ? Date.parse(at) : Number.NaN;
    return Number.isNaN(t) ? this.now() : Math.min(t, this.now());
  }

  /** Every agent's registry entry: the coordinator names they carry feed `bindings`. */
  private async subscribeRegistry(): Promise<void> {
    this.unsubscribers.push(
      await this.broker.subscribeStream(REGISTRY_FILTER, (m) => {
        const id = m.topic.split("/")[3] ?? "";
        const entry = m.payload === "" ? null : parseRegistryEntry(m.payload);
        // Recorded on arrival, not on the queue: the status subscription reads it on arrival.
        const before = this.namedEntries.get(id)?.coordinator;
        if (entry?.workspace !== undefined && entry.agent_id === id)
          this.registryWorkspaces.set(id, entry.workspace);
        else this.registryWorkspaces.delete(id);
        if (entry?.coordinator !== undefined && entry.agent_id === id) {
          this.namedEntries.set(id, entry);
          // Its terminal status arrived first and was set aside: `bindOwner` needs it. Not when
          // the entry started after that status (the id registered anew: it is not its own).
          const ended = this.endedStatusOf.get(id);
          this.endedStatusOf.delete(id);
          const startedAfter =
            entry.started_at !== undefined &&
            ended !== undefined &&
            Date.parse(entry.started_at) > Date.parse(ended.at);
          if (ended !== undefined && !startedAfter && !this.statusOf.has(id))
            this.statusOf.set(id, ended);
        } else {
          this.namedEntries.delete(id);
        }
        for (const name of new Set([before, entry?.coordinator])) {
          if (name !== undefined) void this.enqueue(() => this.rebind(name));
        }
      }),
    );
  }

  /**
   * Re-bind coordinator name `name` to its newest live registry entry (`bindOwner`). A new agent
   * on a name that already had one is a reconnect: journaled `owner_reconnected` in each unfinished
   * wave the name owns (once: a replayed registry after a restart finds it journaled). With no live
   * entry the binding stays on its last agent, marked away (it no longer acts for the name), so
   * its waves read `reconnecting` until
   * `autopilot.reconnect_grace_s` passes. Runs on the queue.
   */
  private async rebind(name: string): Promise<void> {
    const statuses = new Map([...this.statusOf].map(([id, s]) => [id, s.type]));
    const prev = this.bindings.get(name);
    let next = bindOwner([...this.namedEntries.values()], statuses, name);
    // An older entry whose status was never seen is most likely a session long gone (its status
    // forgotten), not a coordinator coming back: the current binding keeps the name.
    const startedAt = (id: string | undefined) =>
      id !== undefined ? (this.namedEntries.get(id)?.started_at ?? "") : "";
    if (
      next !== null &&
      prev !== undefined &&
      !statuses.has(next) &&
      startedAt(next) < startedAt(prev.agent_id)
    )
      next = null;
    const owned = [...this.waves].filter(([, log]) => log.record.state?.owner === name);
    if (next !== null && next !== prev?.agent_id) {
      this.bindings.set(name, {
        agent_id: next,
        since: dateOf(this.time).toISOString(),
        status: statuses.get(next) ?? null,
      });
      this.time.clearTimeout(this.reconnectTimers.get(name));
      this.reconnectTimers.delete(name);
      // A binding made before its agent's status was known (a restart replays the registry before
      // the statuses), or to an agent already gone when it was bound, was never a live session:
      // moving off it is no reconnect, unless a wave journaled that agent as its owner.
      const left = prev !== undefined ? this.statusOf.get(prev.agent_id) : undefined;
      const provisional =
        prev !== undefined &&
        (left === undefined ||
          (OWNER_GONE.has(left.type) && Date.parse(left.at) < Date.parse(prev.since)));
      for (const [wave, log] of owned) {
        const waveStatus = log.record.state?.status;
        if (
          prev === undefined ||
          waveStatus === "complete" ||
          waveStatus === "stopped" ||
          log.record.owner_agent === next ||
          (provisional && log.record.owner_agent !== prev.agent_id)
        ) {
          await this.publishState(wave);
          continue;
        }
        await this.append(wave, {
          type: "owner_reconnected",
          data: { owner: name, agent_id: next, previous_agent_id: prev.agent_id },
        });
        this.log(`wave ${wave}: owner ${name} reconnected as ${next} (was ${prev.agent_id})`);
      }
      return;
    }
    // Never bound, every session carrying the name already ended (a restart replayed their
    // statuses before their entries): the newest stands bound and away, as it would have had its
    // entry come first.
    const last: (Binding & { gone_at?: number }) | undefined =
      prev ??
      [...this.namedEntries.values()]
        .filter((e) => e.coordinator === name && statuses.has(e.agent_id))
        .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""))
        .map((e) => ({
          agent_id: e.agent_id,
          since: dateOf(this.time).toISOString(),
          status: null,
        }))[0];
    if (last === undefined) return;
    const status = statuses.get(last.agent_id) ?? null;
    const away = OWNER_GONE.has(status ?? "");
    const { gone_at, ...binding } = last;
    const awayAt = gone_at ?? this.wentAwayAt(this.statusOf.get(last.agent_id)?.at);
    this.bindings.set(name, { ...binding, status, ...(away ? { gone_at: awayAt } : {}) });
    if (away && gone_at === undefined) {
      const grace = secondsMs(this.config.effective().autopilot.reconnect_grace_s);
      const left = Math.max(0, grace - (this.now() - awayAt));
      this.reconnectTimers.set(
        name,
        this.time.setTimeout(() => {
          this.reconnectTimers.delete(name);
          for (const [wave, log] of this.waves) {
            if (log.record.state?.owner === name) void this.enqueue(() => this.publishState(wave));
          }
        }, left),
      );
    } else if (!away) {
      this.time.clearTimeout(this.reconnectTimers.get(name));
      this.reconnectTimers.delete(name);
    }
    for (const [wave] of owned) await this.publishState(wave);
  }

  /** False for a progress message already handled (same topic and bytes); bounded memory. */
  private firstSighting(topic: string, raw: string): boolean {
    const key = createHash("sha256").update(topic).update("\n").update(raw).digest("base64");
    if (this.seenProgress.has(key)) return false;
    this.seenProgress.add(key);
    if (this.seenProgress.size > DAEMON_DEFAULTS.dedupe_max) {
      this.seenProgress.delete(this.seenProgress.values().next().value as string);
    }
    return true;
  }

  /** An agent watch's progress subscription, served from the daemon's one progress filter. */
  private readonly progressFeed: ProgressFeed = async (topic, deliver) => {
    let routes = this.progressRoutes.get(topic);
    if (routes === undefined) {
      routes = new Set();
      this.progressRoutes.set(topic, routes);
    }
    routes.add(deliver);
    return async () => {
      routes.delete(deliver);
      if (routes.size === 0 && this.progressRoutes.get(topic) === routes) {
        this.progressRoutes.delete(topic);
      }
    };
  };

  /**
   * Hand each mailbox message (the daemon's mailbox in any namespace) to the serial queue, one at
   * a time, until the daemon stops.
   */
  private async mailboxLoop(): Promise<void> {
    await this.drainLoop(MAILBOX_FILTER, (m) => this.onMailbox(m.topic, m.payload));
  }

  /**
   * Lease requests, drained like the mailbox: the subscription lives in the persistent session,
   * so a request sent while the daemon was down (a `release` from a command that finished
   * meanwhile) is queued by the broker and handled here on the next start.
   */
  private async leaseRequestLoop(): Promise<void> {
    await this.drainLoop(LEASE_REQUESTS_FILTER, (m) =>
      this.onLeaseRequest(m.topic.split("/")[3] ?? "", m.payload),
    );
  }

  private async drainLoop(
    filter: string,
    handle: (m: { topic: string; payload: string }) => Promise<void>,
  ): Promise<void> {
    while (this.running) {
      let msgs: { topic: string; payload: string }[];
      try {
        msgs = await this.broker.drainQueued(filter, {
          idleMs: DAEMON_DEFAULTS.mailbox_idle_ms,
          maxMessages: 1,
        });
      } catch (e) {
        if (this.running) this.fail(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      for (const m of msgs) void this.enqueue(() => handle(m));
    }
  }

  /** Run a credential sweep after `ms`, then again every `credential_sweep_interval_s`. */
  private scheduleSweep(ms: number): void {
    this.time.clearTimeout(this.sweepTimer);
    this.sweepTimer = this.time.setTimeout(async () => {
      await this.sweepCredentials().catch((e: unknown) =>
        this.log(`credential sweep: ${e instanceof Error ? e.message : String(e)}`),
      );
      if (this.running) {
        this.scheduleSweep(
          this.opts.credentialSweepMs ??
            secondsMs(this.config.get("credential_sweep_interval_s") as number),
        );
      }
    }, ms);
  }

  /** One credential sweep now (also the interval's body; tests call it). The swept agent ids. */
  async sweepCredentials(): Promise<string[]> {
    if (this.sweeper === undefined) return [];
    const swept = await this.sweeper.sweep();
    if (swept.length > 0) this.log(`credential sweep: deleted ${swept.join(", ")}`);
    return swept;
  }

  /** What the delete path (retire.ts reapAndRevoke) needs from the daemon. */
  private reapDeps(
    journal?: ReapDeps["journal"],
    credentials: AgentCredentials | undefined = this.credentials,
  ): ReapDeps {
    return {
      credentials,
      publishRetained: (topic, payload) =>
        this.broker.publish(topic, payload, { qos: 1, retain: true }),
      clearRetained: (topic) => this.broker.publish(topic, "", { qos: 1, retain: true }),
      journal: journal ?? ((ev) => this.appendSystem(ev)),
    };
  }

  /**
   * Which of `candidates` (agent logins) belong to a live agent: supervised; non-terminal in a
   * wave that is neither stopped nor complete; holding its worktree lock; or with any retained
   * status but a terminal one (spawning, registered, working, blocked…: also another supervisor's
   * agent on this broker). Records where each one's channels live.
   */
  private async liveAgents(candidates: readonly string[]): Promise<Set<string>> {
    const live = new Set<string>(this.supervised.keys());
    for (const [wave, log] of this.waves) {
      for (const e of log.journal.readAll()) {
        if (e.type !== "agent_spawned") continue;
        const id = e.data.agent_id as string;
        this.sweepNamespaces.set(id, this.agentNamespace(wave, id));
        const lock = e.data.lock;
        if (typeof lock === "string" && readLock(lock)?.agent_id === id) live.add(id);
      }
      const status = log.record.state?.status;
      if (status === "stopped" || status === "complete") continue;
      for (const a of runningAgents(log.record, retiredAgents(log))) live.add(a.agent_id);
    }
    const unknown = candidates.filter((id) => !live.has(id));
    await Promise.all(
      unknown.map(async (id) => {
        const got = await this.broker
          .subscribeCollect(`volley/+/${id}/status`, 1, DAEMON_DEFAULTS.probe_ms)
          .catch(() => []);
        const m = got.find((x) => x.payload !== "");
        if (m === undefined) return;
        const ns = m.topic.split("/")[1];
        if (ns !== undefined && !this.sweepNamespaces.has(id)) this.sweepNamespaces.set(id, ns);
        const type = parseEnvelope(m.payload)?.type;
        if (type !== undefined && !TERMINAL_STATUS.has(type)) live.add(id);
      }),
    );
    return live;
  }

  /**
   * Stop timers and the mailbox loop; nothing is published. A clean `stop()` passes false and
   * closes the control connection itself once its queue has drained (a queued retire still
   * deletes its login).
   */
  private halt(closeControl = true): void {
    this.running = false;
    this.time.clearInterval(this.timer);
    this.time.clearInterval(this.watchdog);
    this.time.clearInterval(this.screenTimer);
    this.time.clearInterval(this.pruneTimer);
    this.time.clearTimeout(this.sweepTimer);
    this.time.clearInterval(this.countTimer);
    // Its child process must not outlive the daemon (it writes under the daemon's $HOME).
    this.localDoctorAbort.abort();
    if (closeControl) void this.dynsec?.close();
    for (const t of this.stopGrace.values()) this.time.clearTimeout(t);
    this.stopGrace.clear();
    for (const t of this.reconnectTimers.values()) this.time.clearTimeout(t);
    this.reconnectTimers.clear();
    this.screens.clear();
    this.tunnelsStopped = this.tunnels.stop();
    for (const a of this.supervised.values()) {
      this.time.clearTimeout(a.reapTimer);
      void a.watch.close();
    }
    this.supervised.clear();
  }

  /** Die on our own: drop the dead connection, free the home lock, resolve `closed`. */
  private fail(reason: Error): void {
    if (!this.running) return;
    this.log(`fatal: ${reason.message}`);
    this.halt();
    this.broker.simulateCrash(); // the socket is already gone; this resets the client state
    this.releaseLock();
    this.resolveClosed(reason);
  }

  /** Publish a terminal status and disconnect cleanly (suppresses the LWT). */
  async stop(): Promise<void> {
    this.halt(false);
    try {
      await this.claude.stop();
      await this.tunnelsStopped;
      // Nothing may touch $VOLLEYD_HOME once stop resolves: the restart reconciliation, every
      // tick, screen pass and spawn still in flight beside the queue, the queue itself, then the
      // own doctor (no new one starts once halted; its child process group is being killed).
      await this.reconciling;
      await this.settled();
      await this.localDoctorRun;
    } finally {
      await this.dynsec?.close();
    }
    this.acks.clear();
    for (const w of this.wakes.values()) this.time.clearTimeout(w.timer);
    this.wakes.clear();
    this.lastWokenAt.clear();
    this.wakeTyped.clear();
    // The mailbox subscription is kept: it lives in the persistent session, so requests sent
    // while the daemon is down are queued for the next start. Only the progress watch goes.
    if (this.broker.connected) {
      for (const u of this.unsubscribers.splice(0)) await u();
      await this.publish(
        this.statusTopic,
        this.envelope("status", "done", { reason: "shutdown" }),
        true,
      );
      await this.broker.disconnect();
    }
    this.releaseLock();
  }

  /** Test helper: die like a killed process — no terminal status, no DISCONNECT (LWT fires). */
  _crashForTest(): void {
    this.halt();
    this.broker.simulateCrash();
    this.releaseLock();
  }

  /** Run `fn` after everything already queued; errors are logged, never break the queue. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const run = this.queue.then(fn).catch((e: unknown) => {
      this.log(`error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      return undefined;
    });
    this.queue = run;
    return run;
  }

  /** Like `enqueue`, but the caller sees `fn`'s result or error; the queue still never breaks. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Capture the screens of supervised agents that are due (beside the serial queue). */
  tickScreens(): Promise<void> {
    return this.screens.tick();
  }

  /** One tick: sample pressure (outside the queue: samplers can be slow), then lease + admission. */
  async tick(): Promise<void> {
    await this.sample();
    // A sample that outlived a stop starts nothing (the doctor, publishes, journal writes).
    if (!this.running) return;
    await this.enqueue(() => this.tickNow());
  }

  // -------------------------------------------------------------------------------------------
  // Pressure-based admission
  // -------------------------------------------------------------------------------------------

  private runningWaves(): [WaveId, WaveLog][] {
    return [...this.waves].filter(([, l]) => l.record.state?.status === "running" && l.record.wave);
  }

  /** Take one pressure sample (skipped while one is in flight), then decide and publish. */
  private async sample(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      const repos = [
        ...new Set(this.runningWaves().map(([, l]) => repoDir(l.record.wave?.repo ?? ""))),
      ].filter((r) => r !== "");
      let reading: PressureReading;
      try {
        reading = await this.samplePressure({
          repos,
          config: this.config.effective(),
        });
      } catch (e) {
        this.log(`pressure sample failed: ${e instanceof Error ? e.message : String(e)}`);
        reading = { samples: {}, ci: {} };
      }
      await this.enqueue(async () => {
        this.lastReading = reading;
        this.sampledAt = dateOf(this.time);
        // The state the new verdicts start from; kept so a config change can re-decide this
        // same sample with new thresholds without counting it twice for hysteresis.
        this.prevAdmission = new Map(
          [...this.verdicts].map(([k, v]): [string, AdmissionState] => [k, v.state]),
        );
        this.evaluate();
        await this.publishAdmission();
      });
    } finally {
      this.sampling = false;
    }
  }

  /** Decide the last sample: machine-wide, and per running wave (its overrides, its repo's CI). */
  private evaluate(): void {
    const reading = this.lastReading;
    if (reading === null) return;
    const now = (this.sampledAt ?? dateOf(this.time)).getTime();
    const windows: number[] = [];
    const samplesFor = (cfg: Tunables, ci: Sample | undefined): Samples => {
      windows.push(cfg.admission.api_overload_window_s);
      return {
        ...reading.samples,
        api_overload: countApiSignals(this.apiSignals, now, cfg.admission.api_overload_window_s),
        ...(ci !== undefined ? { ci_queue: ci } : {}),
      };
    };
    // A wave without its own history (submitted since the last sample) starts from the
    // machine-wide one, so a tripped signal is not forgotten by a new wave.
    const prev = (key: string) =>
      this.prevAdmission.get(key) ?? this.prevAdmission.get(GLOBAL) ?? {};
    const run = (key: string, cfg: Tunables, ci: Sample | undefined) =>
      this.verdicts.set(key, decide(samplesFor(cfg, ci), prev(key), cfg.admission));
    // Machine-wide: the busiest measured CI queue among the running waves' repos.
    const ci = Object.values(reading.ci);
    const busiest = ci.filter((c) => c.ok).sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0];
    run(GLOBAL, this.config.effective(), busiest ?? ci[0]);
    const live = new Set<string>([GLOBAL]);
    for (const [wave, log] of this.runningWaves()) {
      live.add(wave);
      run(wave, this.config.effective(wave), reading.ci[repoDir(log.record.wave?.repo ?? "")]);
    }
    for (const key of this.verdicts.keys()) if (!live.has(key)) this.verdicts.delete(key);
    const keep = now - Math.max(...windows) * 1000;
    this.apiSignals = this.apiSignals.filter((t) => t > keep);
  }

  private async publishAdmission(): Promise<void> {
    const global = this.verdicts.get(GLOBAL);
    if (global === undefined) return;
    const waves: Record<string, { allow: number | null; reasons: string[] }> = {};
    for (const [key, v] of this.verdicts) {
      if (key !== GLOBAL) waves[key] = { allow: allowJson(v.allow), reasons: v.reasons };
    }
    this.summary = {
      ...summaryPayload(global, this.sampledAt ?? dateOf(this.time), waves),
      ceiling: this.ceilingView(),
    };
    await this.publish(
      ADMISSION_TOPIC,
      this.envelope("_system/admission", "admission", this.summary),
      true,
    );
  }

  // -------------------------------------------------------------------------------------------
  // Leases
  // -------------------------------------------------------------------------------------------

  /**
   * Subscribe to every agent's status (a holder that turns reaped/done/failed loses its leases;
   * the retained statuses arrive on subscribe, so a holder that died while the daemon was down
   * is caught too). API overload signals come from the one progress subscription (`onProgress`);
   * lease requests themselves are drained by `leaseRequestLoop`.
   */
  private async subscribeLeaseInputs(): Promise<void> {
    this.unsubscribers.push(
      await this.broker.subscribeStream("volley/+/+/status", (m) => {
        const holder = m.topic.split("/")[2] ?? "";
        const env = parseEnvelope(m.payload);
        if (env !== null && !(m.topic.split("/")[1] ?? "").startsWith("_")) {
          const prev = this.statusOf.get(holder)?.type;
          const name = this.namedEntries.get(holder)?.coordinator;
          // A session carrying a coordinator name keeps its status: `bindOwner` needs it. Each
          // coordinator restart adds one; registry reaping (clearing `namedEntries`) bounds them.
          if (OWNER_GONE.has(env.type) && !this.ownsAWave(holder) && name === undefined) {
            // A finished agent that owns no wave needs no `coordinator`: forget it (bounded).
            this.statusOf.delete(holder);
            this.attentionOf.delete(holder);
            // Kept aside (bounded) for a registry entry naming a coordinator that arrives later.
            this.endedStatusOf.delete(holder);
            this.endedStatusOf.set(holder, { type: env.type, at: env.wall_time });
            if (this.endedStatusOf.size > DAEMON_DEFAULTS.dedupe_max)
              this.endedStatusOf.delete(this.endedStatusOf.keys().next().value as string);
          } else {
            this.endedStatusOf.delete(holder);
            this.statusOf.set(holder, { type: env.type, at: env.wall_time });
          }
          if (prev !== env.type) {
            this.ownerChanged(holder);
            if (name !== undefined) void this.enqueue(() => this.rebind(name));
          }
          // A session that ended answers none of its open pickers or handoffs any more.
          if (OWNER_GONE.has(env.type))
            void this.enqueue(async () => {
              await this.closeOpenItems(holder, "picker", "session ended");
              await this.closeOpenItems(holder, "handoff", "session ended");
            });
        }
        if (env === null || !HOLDER_GONE.has(env.type)) return;
        // Checked in queue order, so an `acquire` from this holder still waiting in the queue
        // is applied first and then freed here.
        void this.enqueue(async () => {
          const holds = Object.values(this.leases).some((p) =>
            [...p.held, ...p.queue].some((l) => l.holder === holder),
          );
          if (holds) await this.runLeases({ kind: "holder_status", holder, status: env.type });
        });
      }),
    );
  }

  private async onLeaseRequest(pool: string, raw: string): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const check = validator("lease-request.schema.json");
    if (!isValidAgentId(pool) || !check(msg)) {
      this.log(`ignored malformed lease request on pool '${pool}'`);
      return;
    }
    const env = msg as Envelope;
    const req = env.payload as LeaseRequest;
    // An agent may only acquire, renew or release its own leases (SPEC §4.6.5).
    if (req.holder !== env.agent_id) {
      this.log(`ignored lease request: holder ${req.holder} is not the sender ${env.agent_id}`);
      return;
    }
    // Machine-aware leases (F4): the holder's machine, from its `agent_spawned` (null: a
    // hand-run holder the daemon did not spawn), counted against the pool's `per_machine`.
    // The `local` token is the supervisor's own machine, held under its name (SPEC §4.6.15).
    const spawned = this.spawnedAgents.get(req.holder)?.host;
    const host =
      spawned === undefined ? null : spawned === LOCAL_HOST ? this.config.localName() : spawned;
    await this.runLeases({ kind: "request", pool, req, host });
  }

  /** Step the lease book: journal + mirror every event, re-publish the pools it touched. */
  private async runLeases(input: LeaseInput): Promise<void> {
    const pools = this.config.effective().lease_pools;
    const r = leaseStep(this.leases, input, {
      pools,
      now: dateOf(this.time),
      defaultTtlS: DAEMON_DEFAULTS.lease_default_ttl_s,
    });
    const touched = new Set<string>(input.kind === "request" ? [input.pool] : []);
    for (const ev of r.events) {
      const e = this.system.append(ev, dateOf(this.time));
      touched.add(String(e.data.pool));
      await this.publish(
        waveEventsTopic(SYSTEM_WAVE),
        this.envelope("_waves/events", e.type, {
          wave: SYSTEM_WAVE,
          seq: e.seq,
          at: e.at,
          data: e.data,
        }),
        false,
      );
    }
    this.leases = r.book;
    // `rejected <lease_id>: …` tells a waiting client its request is gone for good.
    const extra = new Map<string, string[]>();
    const reject = (pool: string, line: string) =>
      extra.set(pool, [...(extra.get(pool) ?? []), line]);
    if (input.kind === "request" && r.rejected !== undefined)
      reject(input.pool, `rejected ${input.req.lease_id}: ${r.rejected}`);
    for (const ev of r.events) {
      if (ev.data.reason === "pool removed")
        reject(
          String(ev.data.pool),
          `rejected ${ev.data.lease_id}: pool ${ev.data.pool} removed from config`,
        );
    }
    for (const pool of touched) await this.publishPool(pool, extra.get(pool) ?? []);
  }

  /**
   * Publish one pool's retained state. A pool that is neither configured nor holding anything
   * has no state: its topic is cleared if this process published it, and never created for a
   * name that only appeared in a request.
   */
  private async publishPool(pool: string, extraReasons: string[] = []): Promise<void> {
    const pools = this.config.effective().lease_pools;
    if (!Object.hasOwn(pools, pool) && this.leases[pool] === undefined) {
      if (this.publishedPools.delete(pool)) {
        await this.broker.publish(leasePoolTopic(pool), "", { qos: 1, retain: true });
      }
      return;
    }
    this.publishedPools.add(pool);
    await this.publish(
      leasePoolTopic(pool),
      this.envelope(
        "_system/leases",
        "lease_pool",
        poolPayload(pool, this.leases, pools, extraReasons),
      ),
      true,
    );
  }

  private async publishAllPools(): Promise<void> {
    const all = new Set([
      ...Object.keys(this.config.effective().lease_pools),
      ...Object.keys(this.leases),
      ...this.publishedPools,
    ]);
    for (const pool of all) await this.publishPool(pool);
  }

  /** T5's admission pressure for a wave (the injected verdict in tests). */
  private pressure(wave: WaveId): Admission {
    return (
      this.opts.admission?.(wave) ??
      this.verdicts.get(wave) ??
      (this.lastReading === null ? AWAITING_SAMPLE : OPEN_ADMISSION)
    );
  }

  /**
   * Admission: for each running wave (submission order), admit ready tasks within the admission
   * verdict, the hard ceiling (counted across all waves) and the wave's spawn budget. Limits are
   * read from the config store on every tick, so a config change applies here without restart;
   * lowering one never un-admits anything.
   */
  private async tickNow(): Promise<void> {
    await this.sweepInbox();
    await this.sweepMachines();
    await this.machineDownPass();
    await this.removalSweep();
    await this.fleetTick();
    await this.warnPeerIdle();
    await this.runLeases({ kind: "tick" });
    await this.monitor();
    await this.blockedInvariant();
    await this.watchTerminals();
    for (const wave of this.waves.keys()) {
      await this.settleFixers(wave);
      await this.holdPass(wave);
      await this.completeIfSettled(wave);
      await this.releaseGoIfVerified(wave);
    }
    await this.archivePass();
    let live = this.ceilingCount().live;
    for (const [wave, log] of this.waves) {
      const rec = log.record;
      const candidates = admissible(rec);
      if (candidates.length === 0 || rec.wave === null) {
        if (this.heldBack.delete(wave)) await this.publishState(wave);
        continue;
      }
      const eff = this.config.effective(wave);
      // --- Fleet (F3): a wave that places its tasks admits them one by one, each on its machine ---
      if (placing(rec.wave)) {
        const before = JSON.stringify(this.heldBack.get(wave) ?? []);
        const r = await this.admitPlaced(wave, rec, candidates, live, eff);
        live += r.admitted;
        this.heldBack.set(wave, r.reasons);
        if (r.budget) await this.budgetExhausted(wave, null);
        if (r.changed || (r.admitted === 0 && before !== JSON.stringify(r.reasons)))
          await this.publishState(wave);
        continue;
      }
      // --- end Fleet (F3) ---
      const verdict = admit(candidates, admissionFor(rec, this.killSwitch, this.pressure(wave)), {
        live,
        hardCeiling: eff.hard_ceiling,
        spawnsUsed: spawnsUsed(rec),
        spawnBudget: spawnBudget(rec.wave, eff.spawn_budget_multiplier, rec.budget_raised ?? 0),
      });
      live += verdict.admit.length;
      const before = JSON.stringify(this.heldBack.get(wave) ?? []);
      this.heldBack.set(wave, verdict.reasons);
      for (const task of verdict.admit)
        await this.append(wave, { type: "task_admitted", task, data: {} });
      // Ready tasks the budget holds back: never silent.
      if (
        verdict.admit.length < candidates.length &&
        verdict.reasons.some((r) => r.startsWith("spawn budget exhausted"))
      )
        await this.budgetExhausted(wave, null);
      if (verdict.admit.length === 0 && before !== JSON.stringify(verdict.reasons)) {
        await this.publishState(wave);
      }
    }
    if (this.opts.spawner !== undefined) {
      await this.resolveTrustedRepos();
      // Every wave, paused or stopped too: a running remote agent's reap waits on its tunnel's
      // check, which must not go stale.
      for (const wave of this.waves.keys()) this.checkTunnels(wave);
      for (const wave of this.waves.keys()) this.spawnAdmitted(wave);
      // Level-triggered pipeline work: retry held role spawns, re-check pending CI, see merges.
      // Its git / gh checks run beside the queue; one wave's error never skips the others.
      for (const wave of this.waves.keys()) await this.releaseAdvance(wave);
      for (const wave of this.waves.keys()) {
        if (this.waves.get(wave)?.record.state?.status !== "running") {
          // A wave that does not tick never ends its merge turn: it gives the branch up.
          this.pipelines.get(wave)?.releaseTurn();
          continue;
        }
        try {
          await this.pipelineFor(wave).tick();
        } catch (e) {
          this.log(`pipeline ${wave}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Fleet (F3, SPEC §4.6.15): placement at admission, per-host admission
  // -------------------------------------------------------------------------------------------

  /**
   * Admit a placing wave's ready tasks (`admitPlacing`): each placed, then admitted by its
   * machine, journaled `task_placed` then `task_admitted`. A task with no eligible machine stays
   * queued with the closest machine's reason, and is placed again next tick. With the gate closed
   * (paused, kill switch, a global signal) no task keeps a stale placement reason: the wave's own
   * reason is what `why_waiting` shows. The verdicts of the machines placed on are re-computed at
   * once (their `placed` and `heavy` count the reservations).
   */
  private async admitPlaced(
    wave: WaveId,
    rec: WaveRecord,
    candidates: TaskId[],
    live: number,
    eff: Tunables,
  ): Promise<{ admitted: number; reasons: string[]; budget: boolean; changed: boolean }> {
    const w = rec.wave as Wave;
    const prefix = `${wave}/`;
    const gate = admissionFor(rec, this.killSwitch, this.pressure(wave));
    const r = admitPlacing(
      candidates,
      w,
      this.placementSnapshot(gate, eff),
      this.placeOptions(eff),
      gate,
      (host) => this.hostVerdict(host, eff),
      {
        live,
        hardCeiling: eff.hard_ceiling,
        spawnsUsed: spawnsUsed(rec),
        spawnBudget: spawnBudget(w, eff.spawn_budget_multiplier, rec.budget_raised ?? 0),
      },
    );
    let changed = false;
    for (const k of [...this.heldTask.keys()]) {
      if (k.startsWith(prefix) && r.held[k.slice(prefix.length)] === undefined) {
        this.heldTask.delete(k);
        changed = true;
      }
    }
    for (const [id, why] of Object.entries(r.held)) {
      if (this.heldTask.get(`${prefix}${id}`) === why) continue;
      this.heldTask.set(`${prefix}${id}`, why);
      changed = true;
    }
    for (const { id, placement: p, placed } of r.admit) {
      if (placed && rec.state?.tasks.find((t) => t.id === id)?.placement === undefined) {
        await this.append(wave, {
          type: "task_placed",
          task: id,
          data: {
            task: id,
            host: p.host,
            score: p.score,
            candidates: p.candidates,
            by: p.by,
            ...(p.local ? { local: true } : {}),
          },
        });
      }
      await this.append(wave, { type: "task_admitted", task: id, data: {} });
    }
    if (r.admit.length > 0) {
      // The own machine counts every reservation; a peer its own.
      const hosts = new Set([this.config.localName(), ...r.admit.map((a) => a.placement.host)]);
      for (const host of hosts) await this.publishReadiness(host);
    }
    return { admitted: r.admit.length, reasons: r.reasons, budget: r.budget, changed };
  }

  /**
   * One machine's readiness input and verdict, and placement's view of it: one computation, so
   * the published `eligible` and placement read the same filter. `filter` and `held` come from
   * `eff` (a wave's effective config when placing for it; the supervisor's for the verdict) and
   * `gate` (the own machine's admission).
   */
  private machineState(
    name: string,
    isLocal: boolean,
    cfg: Tunables,
    extra: Pick<ReadinessInput, "bun" | "sharing">,
    eff: Tunables,
    gate: Admission,
  ): { verdict: ReadinessPayload; view: MachineView } {
    const input = this.readinessInput(name, isLocal, cfg, extra, eff, gate);
    const verdict = readiness(input);
    return { verdict, view: machineView(input, verdict, verdict.usage) };
  }

  /**
   * The machine filter's options under `eff`: placement's thresholds, the usage warning level and
   * the own machine's `fleet.local_agents` mode with its fallback profile (SPEC §4.6.15).
   */
  private filterOptions(eff: Tunables): FilterOptions {
    return {
      placement: eff.placement,
      warn_at_pct: eff.claude.warn_at_pct,
      local_agents: eff.fleet.local_agents ?? "always",
      fallback: eff.fleet.fallback,
      now: this.now(),
      down_grace_ms: secondsMs(eff.placement.down_decision_after_s),
    };
  }

  /** `place`'s options under `eff`: the machine filter's, and the own machine's name. */
  private placeOptions(eff: Tunables): PlaceOptions {
    return { ...this.filterOptions(eff), localName: this.config.localName() };
  }

  /** What placement knows now: the own machine and every configured host, with their verdicts. */
  private placementSnapshot(gate: Admission, eff: Tunables): Snapshot {
    const cfg = this.config.effective();
    const local = this.config.localName();
    const extra = this.requirementsExtra();
    const names = [local, ...Object.keys(cfg.hosts).filter((n) => n !== local)];
    return {
      machines: names.map(
        (name) => this.machineState(name, name === local, cfg, extra, eff, gate).view,
      ),
      reservations: {},
    };
  }

  /** Peer `name`'s own admission now, from its last heartbeats under `eff`'s thresholds. */
  private hostVerdict(name: string, eff: Tunables) {
    return foldHost(name, this.hostHistory.get(name)?.samples ?? [], hostThresholds(eff));
  }

  /**
   * A peer's heartbeat is one per-host admission sample (memory available, load per core). A
   * record whose `last_seen` is not newer than the last one counted is the same heartbeat again.
   */
  private sampleHost(name: string, record: MachineRecord): void {
    const prior = this.hostHistory.get(name);
    if (prior !== undefined && Date.parse(record.last_seen) <= Date.parse(prior.last_seen)) return;
    const keep = Math.max(
      this.config.effective().admission.hysteresis_samples,
      ...this.runningWaves().map(([w]) => this.config.effective(w).admission.hysteresis_samples),
    );
    this.hostHistory.set(name, {
      last_seen: record.last_seen,
      samples: [...(prior?.samples ?? []), hostSamples(record)].slice(-keep),
    });
  }

  /**
   * Whether task `t` of `rec` is a placement reserved on its machine: placed and admitted, and its
   * implementer not a live supervised agent (not spawned yet, or spawned and not supervised yet),
   * so no other count has it.
   */
  private isReserved(rec: WaveRecord, t: TaskState): boolean {
    if (t.placement === undefined || !rec.admitted.includes(t.id)) return false;
    if (t.stage !== "queued" && t.stage !== "implement") return false;
    const agent = t.agents.implementer;
    return agent === undefined || !this.supervised.has(agent);
  }

  /** Placements reserved on machine `name` (null: on any) that have no live agent yet. */
  private reservedOn(name: string | null): number {
    let n = 0;
    for (const log of this.waves.values()) {
      const rec = log.record;
      for (const t of rec.state?.tasks ?? []) {
        if (!this.isReserved(rec, t)) continue;
        if (name === null || t.placement?.host === name) n++;
      }
    }
    return n;
  }

  /**
   * Heavy placements reserved on machine `name` in lease pool `pool` (`isReserved`): each will
   * take a per-machine slot there, so placement counts it as held already.
   */
  private heavyReservedOn(name: string, pool: string): number {
    let n = 0;
    for (const log of this.waves.values()) {
      const rec = log.record;
      if (rec.wave?.heavy_pools.includes(pool) !== true) continue;
      for (const t of rec.state?.tasks ?? []) {
        if (t.placement?.host !== name || rec.wave.tasks[t.id]?.heavy !== true) continue;
        if (this.isReserved(rec, t)) n++;
      }
    }
    return n;
  }

  // -------------------------------------------------------------------------------------------
  // Fleet (F6, SPEC §4.6.15): a machine that stays down, re-placement, drain and remove-now
  // -------------------------------------------------------------------------------------------

  /** The machine task `id` runs on (its own machine under its name); undefined: not placed yet. */
  private machineOfTask(rec: WaveRecord, id: TaskId): string | undefined {
    const host = this.ranDef(rec, id)?.host;
    if (host === undefined || host === AUTO_HOST) return undefined;
    return host === LOCAL_HOST ? this.config.localName() : host;
  }

  /** Whether task `task` has a live agent: supervised, launched and being verified, or spawning. */
  private taskLive(wave: WaveId, task: TaskId): boolean {
    for (const a of this.supervised.values()) if (a.wave === wave && a.task === task) return true;
    for (const a of this.launching.values()) if (a.wave === wave && a.task === task) return true;
    for (const key of this.spawning) if (key.startsWith(`${wave}/${task}/`)) return true;
    return false;
  }

  /**
   * Why nothing new may start on paired machine `name` (SPEC §4.6.15), and since when: it was
   * `removed` (a `peer_removed`, and no host of that name since), is being removed (`removing`:
   * a pending `peer_remove`) or is `draining` (`hosts.<name>.drain`). Null: it may (a down
   * machine's spawns park on its tunnel instead).
   */
  private closedMachine(
    name: string,
  ): { machine: "draining" | "removing" | "removed"; since: number } | null {
    if (name === this.config.localName()) return null;
    const pending = this.peers.removals()[name];
    if (pending !== undefined) return { machine: "removing", since: Date.parse(pending.at) };
    const hosts = this.config.effective().hosts;
    if (Object.hasOwn(hosts, name)) {
      if (hosts[name]?.drain !== true) {
        this.drainSeen.delete(name);
        return null;
      }
      const since = this.drainSeen.get(name) ?? this.now();
      this.drainSeen.set(name, since);
      return { machine: "draining", since };
    }
    const removed = this.removedAt.get(name);
    return removed !== undefined ? { machine: "removed", since: removed } : null;
  }

  /** The line a task waiting on closed machine `name` shows. */
  private closedLine(name: string, machine: "draining" | "removing" | "removed"): string {
    return machine === "removed"
      ? `${name} was removed`
      : `${name} is ${machine === "draining" ? "draining" : "being removed"}: nothing new starts there`;
  }

  /** The closed machine task `task` is placed on (`closedMachine`); null for any other. */
  private closedFor(wave: WaveId, task: TaskId): { line: string; machine: string } | null {
    const def = this.waves.get(wave)?.record.wave?.tasks[task];
    if (def === undefined || def.host === LOCAL_HOST || def.host === AUTO_HOST) return null;
    // A task's own inline `host:` is no paired machine.
    if (def.host_spec !== undefined && !Object.hasOwn(this.config.effective().hosts, def.host))
      return null;
    const c = this.closedMachine(def.host);
    return c !== null ? { line: this.closedLine(def.host, c.machine), machine: def.host } : null;
  }

  /**
   * True (and the reason kept for why_waiting) when task `task`'s machine is closed to new
   * agents: its spawn waits for the owner's re-place answer (`machineDownPass` asks). Running
   * agents are never touched.
   */
  private parkClosed(wave: WaveId, task: TaskId): boolean {
    const closed = this.closedFor(wave, task);
    if (closed === null) return false;
    const key = `${wave}/${task}`;
    const reason = `${closed.line}; re-place or cancel ${task} (its machine_down decision)`;
    if (this.parked.get(key) !== reason) {
      this.parked.set(key, reason);
      void this.enqueue(() => this.publishState(wave));
    }
    return true;
  }

  /**
   * Where task `task` of `wave` would be placed now, never on `exclude`: F3's `place` with the
   * same machine filter and score, as if the task asked for placement. `snap` carries the
   * reservations of earlier re-placements in the same answer.
   */
  private placeAway(
    wave: WaveId,
    task: TaskId,
    exclude: string[],
    snap?: Snapshot,
  ): Placement | Unplaced | null {
    const rec = this.waves.get(wave)?.record;
    const w = rec?.wave;
    const def = w?.tasks[task];
    if (rec === undefined || w == null || def === undefined) return null;
    const eff = this.config.effective(wave);
    const gate = admissionFor(rec, this.killSwitch, this.pressure(wave));
    return place({ ...def, host: AUTO_HOST }, w, snap ?? this.placementSnapshot(gate, eff), {
      ...this.placeOptions(eff),
      exclude,
    });
  }

  /** Journal an owner's re-placement (`by: decision`, `from` the machine it leaves). */
  private async rePlace(wave: WaveId, task: TaskId, p: Placement, from: string): Promise<void> {
    await this.append(wave, {
      type: "task_placed",
      task,
      data: {
        task,
        host: p.host,
        score: p.score,
        candidates: p.candidates,
        by: "decision",
        from,
        ...(p.local ? { local: true } : {}),
      },
    });
    // It no longer waits on the machine it left; its next spawn goes where it now is.
    const key = `${wave}/${task}`;
    this.parked.delete(key);
    for (const k of this.refused.keys()) {
      if (k.startsWith(`${key}/`)) this.refused.delete(k);
    }
    // A respawn the owner approved while the machine was closed starts now.
    const held = this.heldRespawn.get(key);
    if (held !== undefined) {
      this.heldRespawn.delete(key);
      void this.startSpawn(wave, task, held.role, held.pipeline).catch((e: unknown) =>
        this.log(`respawn ${key}: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
  }

  /**
   * The wave's unfinished tasks on machine `name`: those with no live agent (queued, or between
   * roles: they would be re-placed) and those with one (never moved). A task whose own open
   * decision already offers `respawn on <machine>` is left to that question.
   */
  private tasksOn(wave: WaveId, name: string): { queued: TaskId[]; running: TaskId[] } {
    const rec = this.waves.get(wave)?.record;
    const queued: TaskId[] = [];
    const running: TaskId[] = [];
    if (rec === undefined) return { queued, running };
    const elsewhere = new Set(
      openDecisions(rec)
        .filter((d) => d.task !== null && (d.options ?? []).some((o) => respawnTarget(o, [o])))
        .map((d) => d.task),
    );
    for (const t of rec.state?.tasks ?? []) {
      if (t.stage === "done" || t.stage === "cancelled") continue;
      if (this.machineOfTask(rec, t.id) !== name) continue;
      if (this.taskLive(wave, t.id)) running.push(t.id);
      else if (!elsewhere.has(t.id)) queued.push(t.id);
    }
    return { queued, running };
  }

  /** What is wrong with machine `name` for its waiting tasks, since when; null: nothing. */
  private troubleOf(
    name: string,
  ): { machine: "down" | "draining" | "removing" | "removed"; since: number; why: string } | null {
    const closed = this.closedMachine(name);
    if (closed !== null) return { ...closed, why: "" };
    const since = this.machines.downSince(name);
    const record = this.machines.record(name);
    if (since === undefined || record === undefined) return null;
    return { machine: "down", since, why: this.machines.whyDown(record) };
  }

  /**
   * Every tick, per running wave and machine with trouble (SPEC §4.6.15): a machine down for
   * `placement.down_decision_after_s` with unfinished tasks of the wave, or one closed to new
   * agents (draining, being removed, removed) with tasks of the wave waiting for an agent there,
   * opens the wave's `machine_down` decision. Once answered it is asked again only when a waiting
   * task appears that the last question about the same trouble did not name (`wait` holds until
   * then). A `re-place queued tasks` answer keeps applying: a task it could not move yet moves as
   * soon as a machine is eligible. An open question whose trouble changed (the machine was
   * removed, or its drain lifted) closes itself. Nothing is re-placed without an answer.
   */
  private async machineDownPass(): Promise<void> {
    const now = this.now();
    const names = new Set(this.machines.all().map((m) => m.name));
    for (const [, log] of this.runningWaves()) {
      for (const t of log.record.state?.tasks ?? []) {
        const m = this.machineOfTask(log.record, t.id);
        if (m !== undefined) names.add(m);
      }
    }
    for (const name of names) {
      const trouble = this.troubleOf(name);
      for (const [wave, log] of this.runningWaves()) {
        const rec = log.record;
        const asked = Object.values(rec.decisions).filter(
          (d) => d.kind === "machine_down" && d.host === name,
        );
        await this.supersedeMachineDown(wave, name, asked, trouble?.machine ?? null);
        if (trouble === null) continue;
        const after = secondsMs(this.config.effective(wave).placement.down_decision_after_s);
        if (trouble.machine === "down" && now - trouble.since < after) continue;
        const current = asked.filter(
          (d) =>
            (d.machine ?? "down") === trouble.machine && Date.parse(d.opened_at) >= trouble.since,
        );
        await this.keepRePlacing(wave, name, current);
        const on = this.tasksOn(wave, name);
        const none =
          trouble.machine === "down" ? on.queued.length + on.running.length : on.queued.length;
        if (none === 0) continue;
        if (asked.some((d) => d.resolved === undefined)) continue;
        const last = current.sort((a, b) => a.opened_at.localeCompare(b.opened_at)).at(-1);
        if (last !== undefined && on.queued.every((t) => last.tasks?.includes(t) === true))
          continue;
        const probe = on.queued[0] ?? on.running[0] ?? "";
        const best = this.placeAway(wave, probe, [name]);
        const { input, data } = machineDownInput({
          host: name,
          machine: trouble.machine,
          downSince: trouble.since,
          now,
          why: trouble.why,
          queued: on.queued,
          running: on.running,
          best: best !== null && best.host !== null ? best.host : null,
        });
        let id = `machine_down-${name}`;
        for (let k = 2; rec.decisions[id] !== undefined; k++) id = `machine_down-${name}-${k}`;
        try {
          await this.openDecisionNow(wave, { ...input, ...(ID_RE.test(id) ? { id } : {}) }, data);
        } catch (e) {
          this.log(`machine_down ${wave}/${name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  /**
   * An open `machine_down` question about trouble machine `name` no longer has (`now`: what it
   * has, null: none) closes itself: answered `wait` when the machine takes new agents again,
   * `superseded` when its trouble changed (the question about the new trouble follows).
   */
  private async supersedeMachineDown(
    wave: WaveId,
    name: string,
    asked: DecisionRecord[],
    now: string | null,
  ): Promise<void> {
    for (const d of asked) {
      if (d.resolved !== undefined || (d.machine ?? "down") === now) continue;
      const what =
        now === null
          ? "takes new agents again"
          : now === "removed"
            ? "was removed"
            : now === "removing"
              ? "is being removed"
              : `is ${now}`;
      await this.resolveNow(wave, d.decision_id, {
        answer: now === null ? MACHINE_DOWN_WAIT : "superseded",
        by: DAEMON_AGENT_ID,
        rationale: `${name} ${what}`,
      });
    }
  }

  /**
   * The owner answered `re-place queued tasks` about this trouble (`asked`): each task it named
   * that is still waiting on machine `name` and could not be moved then is placed again as soon
   * as a machine is eligible (`by: decision`).
   */
  private async keepRePlacing(wave: WaveId, name: string, asked: DecisionRecord[]): Promise<void> {
    const rec = this.waves.get(wave)?.record;
    if (rec?.wave == null) return;
    const answered = asked.filter(
      (d) => d.resolved?.answer.trim().toLowerCase() === MACHINE_DOWN_REPLACE,
    );
    const ids = new Set(answered.flatMap((d) => d.tasks ?? []));
    if (ids.size === 0) return;
    const waiting = new Set(this.tasksOn(wave, name).queued);
    let snap: Snapshot | undefined;
    let moved = false;
    for (const id of ids) {
      if (!waiting.has(id)) continue;
      snap ??= this.placementSnapshot(
        admissionFor(rec, this.killSwitch, this.pressure(wave)),
        this.config.effective(wave),
      );
      const p = this.placeAway(wave, id, [name], snap);
      if (p === null || p.host === null) continue;
      await this.rePlace(wave, id, p, name);
      snap = reserve(snap, p.host, rec.wave.tasks[id], rec.wave);
      moved = true;
    }
    if (moved) await this.publishState(wave);
  }

  /** Machine `name` is back: its open `machine_down` questions about it being down close (`wait`). */
  private async machineBack(name: string): Promise<void> {
    for (const [wave, log] of this.waves) {
      for (const d of openDecisions(log.record)) {
        if (d.kind !== "machine_down" || d.host !== name || (d.machine ?? "down") !== "down")
          continue;
        await this.resolveNow(wave, d.decision_id, {
          answer: MACHINE_DOWN_WAIT,
          by: DAEMON_AGENT_ID,
          rationale: `${name} is back`,
        });
      }
    }
  }

  /**
   * A `machine_down` answer. `re-place queued tasks`: each listed task that still has no live
   * agent and still sits on the machine is placed again without it (journaled `by: decision`),
   * each placement reserved for the next; one with no eligible machine stays, says so, and moves
   * once one is (`keepRePlacing`). `cancel`: every listed task not finished is cancelled (a
   * running agent is told to stop). `wait`, or anything else: everything stays parked.
   */
  private async onMachineDownResolved(wave: WaveId, d: DecisionRecord): Promise<void> {
    const rec = this.waves.get(wave)?.record;
    const host = d.host;
    if (rec?.wave == null || d.resolved === undefined || host === undefined) return;
    const answer = d.resolved.answer.trim().toLowerCase();
    const listed = (d.tasks ?? []).flatMap((id) => {
      const t = rec.state?.tasks.find((x) => x.id === id);
      return t !== undefined && t.stage !== "done" && t.stage !== "cancelled" ? [t] : [];
    });
    if (answer === MACHINE_DOWN_REPLACE) {
      const eff = this.config.effective(wave);
      let snap = this.placementSnapshot(
        admissionFor(rec, this.killSwitch, this.pressure(wave)),
        eff,
      );
      const moved = new Set<string>();
      for (const t of listed) {
        if (this.taskLive(wave, t.id) || this.machineOfTask(rec, t.id) !== host) continue;
        const p = this.placeAway(wave, t.id, [host], snap);
        if (p === null) continue;
        if (p.host === null) {
          await this.append(wave, {
            type: "alarm_raised",
            task: t.id,
            data: {
              code: "NOT_REPLACED",
              message: `${t.id} stays queued for ${host}: ${p.why}; it is placed as soon as a machine is eligible`,
              host,
            },
          });
          continue;
        }
        await this.rePlace(wave, t.id, p, host);
        snap = reserve(snap, p.host, rec.wave.tasks[t.id], rec.wave);
        moved.add(p.host);
      }
      for (const name of [this.config.localName(), ...moved]) await this.publishReadiness(name);
      await this.publishState(wave);
      return;
    }
    if (answer === MACHINE_DOWN_CANCEL) {
      const why = `${d.resolved.by} cancelled it: ${host} ${(d.machine ?? "down") === "down" ? "stayed down" : `is ${d.machine}`} (decision ${d.decision_id})`;
      for (const t of listed) {
        const live = [...this.supervised].filter(([, a]) => a.wave === wave && a.task === t.id);
        const [first, ...rest] = live;
        if (first === undefined) {
          await this.append(wave, {
            type: "task_cancelled",
            task: t.id,
            data: { by: d.resolved.by, why },
          });
          continue;
        }
        for (const [id, a] of rest) {
          await this.cancelAgent(
            wave,
            { task: a.task, role: a.role, agent_id: id },
            DAEMON_AGENT_ID,
            {
              text: `volleyd: ${why}. Stop work on ${t.id} now and exit.`,
              from_agent_id: DAEMON_AGENT_ID,
              wave,
              task: t.id,
            },
          );
        }
        await this.cancelTask(wave, t.id, first[0], why);
      }
    }
  }

  /**
   * Why machine `host` should not take a respawn now: closed to new agents (draining, being
   * removed, removed: `closed`), down, or not eligible (readiness and placement's filter); null
   * when it may. The own machine is judged as a candidate like any (`local_agents: always`):
   * its `fleet.local_agents` mode steers where new work goes, it is no trouble with the machine.
   */
  private hostTrouble(host: string): { why: string; closed: boolean } | null {
    const closed = this.closedMachine(host);
    if (closed !== null) {
      const why = closed.machine === "removing" ? "being removed" : closed.machine;
      return { why, closed: true };
    }
    const record = this.machines.record(host);
    if (this.machines.status(host) === "down" && record !== undefined) {
      return { why: `down (${this.machines.whyDown(record)})`, closed: false };
    }
    const cfg = this.config.effective();
    const local = this.config.localName();
    if (host !== local && !Object.hasOwn(cfg.hosts, host)) return null;
    const eff: Tunables =
      host === local ? { ...cfg, fleet: { ...cfg.fleet, local_agents: "always" } } : cfg;
    const v = this.machineState(
      host,
      host === local,
      cfg,
      this.requirementsExtra(),
      eff,
      this.pressure(GLOBAL),
    ).verdict;
    return v.eligible
      ? null
      : { why: `not eligible (${v.ineligible_reason ?? "not ready"})`, closed: false };
  }

  /**
   * A decision that offers `respawn` for a task whose machine is down or not eligible also
   * offers `respawn on <best>` (SPEC §4.6.15); one whose machine is closed to new agents offers
   * only that. Asked again, the offer is made afresh (a new best, or plain `respawn` back once
   * the machine is fine). Unchanged when the machine is fine or nothing else is eligible.
   */
  private withRespawnElsewhere(
    wave: WaveId,
    input: DecisionInput,
    extra: Record<string, unknown>,
  ): DecisionInput {
    const rec = this.waves.get(wave)?.record;
    if (rec === undefined || input.task === null) return input;
    const offers = (input.options ?? []).some((o) => {
      const n = o.trim().toLowerCase();
      return n === "respawn" || respawnTarget(o, [o]) !== null;
    });
    if (!offers) return input;
    const host = this.machineOfTask(rec, input.task);
    if (host === undefined) return input;
    const trouble = this.hostTrouble(host);
    const best = trouble !== null ? this.placeAway(wave, input.task, [host]) : null;
    if (trouble === null || best === null || best.host === null) return withRespawnOn(input, null);
    const marker = extra.pipeline as { role?: unknown } | undefined;
    const role = typeof marker?.role === "string" ? marker.role : extra.role;
    return withRespawnOn(input, {
      host,
      why: trouble.why,
      best: best.host,
      closed: trouble.closed,
      ...(typeof role === "string" ? { role } : {}),
    });
  }

  /**
   * `respawn on <machine>` answered: the task is re-placed there first (journaled `by:
   * decision`), so the respawn the answer then triggers starts on it. Returns why the machine
   * cannot take it now (down, closed or not eligible since the question was asked: nothing is
   * re-placed), else null.
   */
  private async respawnOn(wave: WaveId, d: DecisionRecord, target: string): Promise<string | null> {
    const rec = this.waves.get(wave)?.record;
    if (rec === undefined || d.task === null) return null;
    const local = this.config.localName();
    if (target !== local && !Object.hasOwn(this.config.effective().hosts, target)) {
      return `no machine named "${target}" to respawn on`;
    }
    const from = this.machineOfTask(rec, d.task) ?? local;
    const trouble =
      target === from ? { why: "the machine it is leaving" } : this.hostTrouble(target);
    if (trouble !== null) return `${target} cannot take it now: it is ${trouble.why}`;
    const p = this.placeAway(wave, d.task, [from]);
    const candidates = p?.candidates ?? [];
    const row = candidates.find((c) => c.host === target);
    if (row === undefined || row.score === null) {
      const line = row?.line.replace(/^ineligible: /, "") ?? "not a candidate";
      return `${target} cannot take it now: ${line}`;
    }
    await this.rePlace(
      wave,
      d.task,
      { host: target, local: target === local, by: "auto", score: row.score, candidates },
      from,
    );
    return null;
  }

  /** A refused `respawn on <machine>` answer: the same question again, with a fresh offer. */
  private async askAgainRefused(
    wave: WaveId,
    d: DecisionRecord,
    answer: string,
    why: string,
  ): Promise<void> {
    const {
      decision_id: _id,
      wave: _wave,
      task,
      kind,
      question,
      options,
      pointers,
      opened_at: _at,
      resolved: _resolved,
      resume_stage: _stage,
      parks: _parks,
      rationale: _why,
      ...extra
    } = d;
    const base = question.replace(/^".*?" was refused: [^.]*\. /, "");
    try {
      await this.openDecisionNow(
        wave,
        {
          kind,
          task,
          question: `"${answer}" was refused: ${why}. ${base}`,
          pointers,
          ...(options !== undefined ? { options } : {}),
        },
        extra,
      );
    } catch (e) {
      this.log(`ask again ${d.decision_id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * The live agents on machine `name`: supervised, launched and still being verified, and the
   * spawns in flight for tasks there (a drain waits for all of them).
   */
  private agentsOn(name: string): string[] {
    const local = this.config.localName();
    const on = (id: string) => {
      const host = this.spawnedAgents.get(id)?.host ?? LOCAL_HOST;
      return (host === LOCAL_HOST ? local : host) === name;
    };
    const ids = [...this.supervised.keys(), ...this.launching.keys()].filter(on);
    for (const key of this.spawning) {
      const [wave = "", task = "", role = ""] = key.split("/");
      const rec = this.waves.get(wave)?.record;
      if (rec === undefined || this.machineOfTask(rec, task) !== name || !isRole(role)) continue;
      // Not journaled `agent_spawned` yet: the id its spawn is taking.
      const id = agentIdFor(wave, task, role, this.agentAttempt(wave, task, role));
      if (!ids.includes(id)) ids.push(id);
    }
    return [...new Set(ids)];
  }

  /** `peer_remove { now }`: tell supervised agent `id` on machine `name` to stop (once). */
  private async evictOne(name: string, id: string, a: Supervised, by: string): Promise<void> {
    this.evicted.set(id, this.now());
    await this.cancelAgent(a.wave, { task: a.task, role: a.role, agent_id: id }, by, {
      text: `volleyd: ${name} is being removed (by ${by}). Stop work on ${a.task} now: do not push, open or merge anything further, publish your terminal status and exit.`,
      from_agent_id: DAEMON_AGENT_ID,
      wave: a.wave,
      task: a.task,
    });
  }

  /** `peer_remove { now }`: tell every agent on the machine to stop (the sweep force-retires). */
  private async evict(name: string, by: string): Promise<void> {
    for (const id of this.agentsOn(name)) {
      const a = this.supervised.get(id);
      if (a !== undefined && !this.evicted.has(id)) await this.evictOne(name, id, a, by);
    }
  }

  /**
   * Every tick: a drain or remove-now whose machine has no live agent left (none supervised,
   * launched or spawning there) finishes (`peer_removed`). A remove-now tells each agent there to
   * stop, those that came up after it began too, and force-retires each one still live
   * `stop_grace_s` after it was told, which opens its respawn decision.
   */
  private async removalSweep(): Promise<void> {
    for (const [name, pending] of Object.entries(this.peers.removals())) {
      const live = this.agentsOn(name);
      if (live.length === 0) {
        for (const id of this.evicted.keys()) if (!this.supervised.has(id)) this.evicted.delete(id);
        const r = await this.peers.finishRemoval(name);
        if (!r.ok) this.log(`peer_remove ${name}: ${r.error}`);
        continue;
      }
      if (pending.mode !== "now") continue;
      const grace = secondsMs(this.config.effective().stop_grace_s);
      for (const id of live) {
        const a = this.supervised.get(id);
        // Launched but not verified yet: told to stop once it is supervised.
        if (a === undefined) continue;
        const told = this.evicted.get(id);
        if (told === undefined) {
          await this.evictOne(name, id, a, pending.by);
          continue;
        }
        if (this.now() < told + grace) continue;
        this.evicted.delete(id);
        await this.append(a.wave, {
          type: "agent_force_retired",
          task: a.task,
          data: { agent_id: id, role: a.role, reason: "peer_remove" },
        });
        await this.onFinal(id, "stopped", `was stopped: ${name} is being removed`);
      }
    }
  }

  /**
   * A running wave whose every task is done or cancelled is complete: journal `wave_complete`
   * (status `complete`; admission stops sampling its repo) and open the wave-level
   * `wave_complete` decision, so the owner is told (the Desk, the notify bridge).
   */
  private async completeIfSettled(wave: WaveId): Promise<void> {
    const rec = this.waves.get(wave)?.record;
    const state = rec?.state;
    if (rec === undefined || state == null || state.status !== "running") return;
    if (state.tasks.length === 0) return;
    if (!state.tasks.every((t) => t.stage === "done" || t.stage === "cancelled")) return;
    const done = state.tasks.filter((t) => t.stage === "done").map((t) => t.id);
    const cancelled = state.tasks.filter((t) => t.stage === "cancelled").map((t) => t.id);
    // The release train (SPEC §4.6.19): under autopilot, a repo with a playbook starts releasing
    // instead; the owner hears from release_go once every stage is verified.
    const train = this.releasePlaybook(wave);
    if (typeof train === "object" && train !== null) {
      const { path, sha256, playbook } = train;
      await this.append(wave, {
        type: "release_started",
        data: { done, cancelled, playbook: { path, sha256, stages: playbook.stages } },
      });
      this.log(`wave ${wave} releasing: ${playbook.stages.map((s) => s.name).join(", ")}`);
      await this.releaseAdvance(wave);
      return;
    }
    // The decision first: once wave_complete is journaled the wave is no longer `running` and no
    // later tick comes back here, so a failed open must leave the wave to retry.
    if (rec.decisions[waveCompleteDecisionId(wave)] === undefined) {
      const merged = done.length > 0 ? ` merged into ${state.release_branch}` : "";
      await this.openDecisionNow(wave, {
        kind: "wave_complete",
        task: null,
        id: waveCompleteDecisionId(wave),
        question: `Wave ${wave} is complete: ${done.length} task(s) done${merged}, ${cancelled.length} cancelled. Review and merge ${state.release_branch} when ready.${typeof train === "string" ? ` Its release playbook was not run: ${train}` : ""}`,
        options: ["acknowledged"],
      });
    }
    await this.append(wave, { type: "wave_complete", data: { done, cancelled } });
    this.log(
      `wave ${wave} complete: done ${done.join(", ") || "-"}; cancelled ${cancelled.join(", ") || "-"}`,
    );
  }

  /**
   * The playbook a settled wave releases with (SPEC §4.6.19): null when it has none or autopilot
   * is off for it; a string saying why when it no longer validates (the wave completes as
   * without one, and its wave_complete question says so on one line, naming the playbook as the
   * wave file does).
   */
  private releasePlaybook(wave: WaveId): WavePlaybook | string | null {
    const plan = this.waves.get(wave)?.record.wave;
    if (plan == null || !this.config.effective(wave).autopilot.enabled) return null;
    try {
      return wavePlaybook(plan);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (this.playbookNotRun.get(wave) !== msg) {
        this.playbookNotRun.set(wave, msg);
        this.log(`wave ${wave}: release playbook not run: ${msg}`);
      }
      const path = playbookPath(plan.repo, plan.playbook);
      const named = path === null ? msg : msg.replace(path, plan.playbook ?? DEFAULT_PLAYBOOK);
      return named.replace(/:\n\s*/, ": ").replace(/\n\s*/g, "; ");
    }
  }

  /**
   * Once every stage of a releasing wave is verified, ask the owner `release_go` (owner-only,
   * wave-level), unless one is open already. After a `hold` it is asked again (`class: held`), so
   * the Desk keeps showing it.
   */
  private async releaseGoIfVerified(wave: WaveId): Promise<void> {
    const log = this.waves.get(wave);
    const state = log?.record.state;
    if (log === undefined || state?.status !== "releasing" || state.release === undefined) return;
    if (!allVerified(state.release)) return;
    if (openDecisions(log.record).some((d) => d.kind === "release_go")) return;
    const asked = Object.values(log.record.decisions).filter((d) => d.kind === "release_go");
    // Answered go, but release_done was not journaled (it failed): journal it now.
    const go = asked.find((d) => d.resolved?.answer.trim().toLowerCase() === "go");
    if (go?.resolved !== undefined) {
      await this.append(wave, {
        type: "release_done",
        data: { by: go.resolved.by, decision_id: go.decision_id },
      });
      return;
    }
    const evidence = new Map<string, string>();
    for (const e of log.journal.readAll()) {
      if (e.type === "release_stage_verified" && typeof e.data.evidence === "string")
        evidence.set(String(e.data.stage), e.data.evidence);
    }
    const { input, stages } = releaseGoInput(wave, state.release, evidence);
    const id =
      asked.length === 0
        ? waveDecisionId("release_go", wave)
        : waveDecisionId("release_go", wave, String(asked.length));
    await this.openDecisionNow(
      wave,
      { ...input, id },
      { stages, ...(asked.length > 0 ? { class: "held" } : {}) },
    );
  }

  // -------------------------------------------------------------------------------------------
  // Archiving (archive.ts, SPEC §4.6.20): an ended wave leaves the live set; its files stay.
  // -------------------------------------------------------------------------------------------

  /** Why `wave` cannot be archived right now (it has ended, but its agents have not yet). */
  private archiveBusy(wave: WaveId): string | null {
    const live = [...this.supervised.values()].filter((a) => a.wave === wave).length;
    if (live > 0) return `wave '${wave}' still has ${live} live agent(s); archive it once they end`;
    const log = this.waves.get(wave);
    const running = log !== undefined ? runningAgents(log.record, retiredAgents(log)).length : 0;
    if (this.stopGrace.has(wave) && running > 0)
      return `wave '${wave}' has ${running} agent(s) in their stop grace (stop_grace_s); archive it once they end`;
    return null;
  }

  /**
   * Archive an ended wave: close its open decisions as `archived`, journal `wave_archived`,
   * publish the state once (status archived) then clear it and each closed decision's topic,
   * and move the wave out of the live set. Returns the closed decision ids, or the refusal.
   */
  private async archiveWave(
    wave: WaveId,
    by: string,
    reason: string,
  ): Promise<{ closed: string[] } | { error: string }> {
    const log = this.waves.get(wave);
    if (log === undefined)
      return {
        error: this.archived.has(wave)
          ? `wave '${wave}' is archived already`
          : `unknown wave '${wave}'`,
      };
    const why = archiveRefusal(log.record) ?? this.archiveBusy(wave);
    if (why !== null) return { error: why };
    const events = archiveEvents(log.record, by, reason, dateOf(this.time));
    const closed = (events.at(-1)?.data.closed_decisions as string[] | undefined) ?? [];
    // The needs-you inbox items of the decisions it closes are answered `archived` first
    // (SPEC §4.6.18), so `wave_archived` stays the wave's last event.
    for (const id of closed) {
      const item = this.inbox.get(decisionItemId(wave, id));
      if (item === undefined || item.answered !== undefined) continue;
      const where: InboxWhere = by === DAEMON_AGENT_ID ? { kind: "autopilot" } : { kind: "cli" };
      await this.recordInboxAnswer(item, { version: item.version, answer: "archived", by, where });
    }
    // Each append re-publishes the state; the last one carries status archived.
    for (const ev of events) await this.append(wave, ev);
    for (const id of closed) {
      const d = log.record.decisions[id];
      if (d !== undefined) await this.publishResolved(wave, d);
    }
    // Every inbox item of the wave goes: an archived wave's journal is not folded on start.
    for (const item of [...this.inbox.values()]) {
      if (item.wave !== wave) continue;
      this.inbox.delete(item.id);
      await this.clearRetained(inboxTopic(item.id));
    }
    await this.clearRetained(waveStateTopic(wave));
    await this.clearRetained(waveDigestTopic(wave));
    this.digests.delete(wave);
    this.time.clearTimeout(this.stopGrace.get(wave));
    this.stopGrace.delete(wave);
    this.waves.delete(wave);
    this.archived.set(wave, log);
    this.heldBack.delete(wave);
    this.issueFiles.delete(wave);
    this.legacyEndedAt.delete(wave);
    for (const key of this.autoHostAlarmed)
      if (key.startsWith(`${wave}/`)) this.autoHostAlarmed.delete(key);
    this.pipelines.delete(wave);
    this.peerIdleWarned.delete(wave);
    this.config.clearWave(wave);
    await this.publishArchiveIndex();
    this.log(`wave ${wave} archived by ${by} (${reason}); closed ${closed.length} decision(s)`);
    return { closed };
  }

  /** Archive `wave` when auto-archive says it is due (archive_on_ack, archive_ended_after_h). */
  private async archiveIfDue(wave: WaveId): Promise<void> {
    const log = this.waves.get(wave);
    if (log === undefined || this.archiveBusy(wave) !== null) return;
    // A record from before `ended_at`: its journal is read once, not on every tick.
    const facts = archiveFacts(log.record, () => {
      if (!this.legacyEndedAt.has(wave))
        this.legacyEndedAt.set(wave, endedAt(log.journal.readAll()));
      return this.legacyEndedAt.get(wave) ?? null;
    });
    const verdict = archivable(facts, this.now(), this.config.effective(wave));
    if (verdict.ok) await this.archiveWave(wave, DAEMON_AGENT_ID, verdict.reason);
  }

  /** The tick's auto-archive pass over every live wave. */
  private async archivePass(): Promise<void> {
    for (const wave of [...this.waves.keys()]) await this.archiveIfDue(wave);
  }

  /** `archive`: the owner (anyone for an ownerless wave) archives an ended wave; `dry_run` says what. */
  private async archiveOp(p: Record<string, unknown>, by: string): Promise<HandlerResult> {
    const w = this.waveOf(p);
    if ("error" in w) return { ok: false, error: w.error };
    const refused = guardMutation(w.log.record.state as WaveState, by, "archive");
    if (refused !== null) return { ok: false, error: refused };
    return this.archiveAs(w.wave, by, MANUAL_REASON, p.dry_run === true);
  }

  /** Archive (or, dry, say what archiving would close) once the caller is authorised. */
  private async archiveAs(
    wave: WaveId,
    by: string,
    reason: string,
    dry: boolean,
  ): Promise<HandlerResult> {
    const log = this.waves.get(wave);
    if (log === undefined) return { ok: false, error: `unknown wave '${wave}'` };
    if (dry) {
      const why = archiveRefusal(log.record) ?? this.archiveBusy(wave);
      if (why !== null) return { ok: false, error: why };
      return {
        ok: true,
        result: {
          wave,
          status: log.record.state?.status,
          would_close: openDecisions(log.record).map((d) => d.decision_id),
        },
      };
    }
    const r = await this.archiveWave(wave, by, reason);
    if ("error" in r) return { ok: false, error: r.error };
    return { ok: true, result: { wave, status: "archived", closed: r.closed } };
  }

  /** An archived wave as `status --all` shows it: its last state, and when, by whom and why. */
  private archivedSnapshot(wave: WaveId): WaveState | null {
    const rec = this.archived.get(wave)?.record;
    if (rec?.state == null) return null;
    const state = structuredClone(rec.state);
    state.effective_config = this.config.effectiveWith(rec.overrides);
    if (rec.archived !== undefined) {
      const { at, by, reason } = rec.archived;
      state.archived = { at, by, reason };
    }
    return state;
  }

  /** The retained `volley/_waves/_archive` index, newest first (archive_index_max entries). */
  private async publishArchiveIndex(): Promise<void> {
    const entries = [...this.archived.values()].flatMap((log) => indexEntry(log.record) ?? []);
    const payload = indexPayload(
      entries,
      DAEMON_DEFAULTS.archive_index_max,
      dateOf(this.time).toISOString(),
    );
    await this.publish(ARCHIVE_TOPIC, this.envelope("_waves/_archive", "archive", payload), true);
  }

  /** A resolved decision's one non-retained publish, then its retained topic cleared (§4.6.2). */
  private async publishResolved(wave: WaveId, d: DecisionRecord): Promise<void> {
    const topic = decisionTopic(wave, d.decision_id);
    await this.publish(
      topic,
      this.envelope("_waves/decisions", "decision_resolved", decisionPayload(d)),
      false,
    );
    await this.clearRetained(topic);
  }

  // -------------------------------------------------------------------------------------------
  // Spawning (T4): admitted tasks get an implementer; other roles are sequenced by the pipeline.
  // -------------------------------------------------------------------------------------------

  /**
   * Start an implementer for every admitted task that has none (runs beside the queue), while
   * the agents running or starting leave the hard ceiling room: a retry after a backoff or a
   * resumed wave's backlog waits for a free slot. Held slots are not counted here, so tasks
   * waiting on each other's slots never all wait.
   */
  private spawnAdmitted(wave: WaveId): void {
    const rec = this.waves.get(wave)?.record;
    if (this.killSwitch || rec?.state == null || rec.state.status !== "running") return;
    let room = this.config.effective(wave).hard_ceiling - this.ceilingCount(false).live;
    for (const id of rec.admitted) {
      if (room <= 0) return;
      const t = rec.state.tasks.find((x) => x.id === id);
      if (t === undefined || !awaitsImplementer(t)) continue;
      const key = `${wave}/${id}/implementer`;
      if (this.spawning.has(key) || (this.refused.get(key)?.until ?? 0) > this.now()) continue;
      if (this.parkOnTunnel(wave, id)) continue;
      room--;
      void this.startSpawn(wave, id, "implementer").catch((e: unknown) => {
        this.log(`spawn ${key}: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
  }

  /**
   * Run one spawn's launch half and hand its verification to `supervise`. Journal appends go
   * straight to the wave log (each is a synchronous fsync'd write), so a spawn never waits on the
   * serial queue and the queue never waits on a spawn's verification window.
   */
  private startSpawn(
    wave: WaveId,
    task: string,
    role: Role,
    pipeline: SpawnPipelineOptions = {},
  ): Promise<SpawnResult> {
    return this.track(this.launchSpawn(wave, task, role, pipeline));
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    const done = () => this.inflight.delete(p);
    void p.then(done, done);
    return p;
  }

  /**
   * Resolves once the serial queue is drained, no spawn's launch half is running and every journal
   * append (a wave's, or `_system`'s through appendSystem) has been published (a spawn's
   * verification waits on the agent, so it is not counted).
   * Tests await it before reading the published state or asserting that nothing happened.
   */
  async settled(): Promise<void> {
    for (let q = this.queue; ; q = this.queue) {
      await q;
      await Promise.allSettled([...this.inflight]);
      if (q === this.queue && this.inflight.size === 0) return;
    }
  }

  private async launchSpawn(
    wave: WaveId,
    task: string,
    role: Role,
    pipeline: SpawnPipelineOptions,
  ): Promise<SpawnResult> {
    const log = this.waves.get(wave);
    const w = log?.record.wave;
    if (log === undefined || w == null) throw new Error(`unknown wave '${wave}'`);
    const t = w.tasks[task] ?? (task === RELEASE_TASK ? releaseWaveTask(w) : undefined);
    if (t === undefined) throw new Error(`unknown task '${task}' in wave ${wave}`);
    const key = `${wave}/${task}/${role}`;
    // Its machine takes no new agents (draining, being removed, removed): it waits for the
    // owner's re-place answer, never a spawn that fails on a host that is gone.
    const closed = this.closedFor(wave, task);
    if (closed !== null) {
      this.parkClosed(wave, task);
      throw new Error(`${closed.line}: ${task}'s ${role} waits for its re-place question`);
    }
    let remote: RemoteHost | undefined;
    if (t.host !== "local") {
      try {
        remote = this.remoteHost(wave, t);
      } catch (e) {
        const err =
          e instanceof SpawnError
            ? e
            : new SpawnError("LAUNCH_FAILED", e instanceof Error ? e.message : String(e));
        await this.append(wave, {
          type: "alarm_raised",
          task,
          data: { code: err.code, message: err.message, role, host: t.host, ...err.detail },
        });
        await this.spawnFailed(wave, task, role, err);
        throw err;
      }
    }
    let account: SelectedAccount;
    try {
      account = this.accountFor(wave, w, t, role);
    } catch (e) {
      if (!(e instanceof ClaudeAccountError)) throw e;
      const err = new SpawnError("CLAUDE_ACCOUNT_UNAVAILABLE", e.message);
      await this.append(wave, {
        type: "alarm_raised",
        task,
        data: { code: err.code, message: err.message, role },
      });
      await this.spawnFailed(wave, task, role, err);
      throw err;
    }
    this.spawning.add(key);
    try {
      const attempt = this.agentAttempt(wave, task, role, pipeline.stage?.name);
      // agent_spawned clears the role's failures: what spawn_recovered reports is read first.
      const prior = log.record.spawnFailures[task]?.[role];
      const deps = this.spawnDeps(wave);
      const { resumeNote, ...rest } = pipeline;
      // An implementer respawn continues the branch (and PR) an earlier attempt pushed.
      const carried =
        role === "implementer" && rest.start === undefined && rest.worktreeAttempt === undefined
          ? this.lastBranch(wave, task, role)
          : undefined;
      let req = {
        wave: w,
        task,
        role,
        attempt,
        ...rest,
        account: { id: account.id, dir: account.dir, machine: account.machine },
        accountChosen: {
          account: account.id,
          machine: account.machine,
          source: account.source,
          why: account.why,
          candidates: account.candidates ?? [],
        },
        hygiene: log.record.state?.hygiene_level ?? "p1",
        ...(resumeNote !== undefined ? { resumeNote } : {}),
        ...(carried !== undefined ? { continueBranch: carried } : {}),
      };
      if (remote !== undefined) {
        const r = await this.remoteSpawn(wave, task, remote, deps);
        req = { ...req, wave: r.wave };
        Object.assign(deps, r.deps);
      }
      // spawnAgent journals its own refusals.
      const res = await spawnAgent(req, deps);
      const host = deps.host;
      const tunnel = remote !== undefined ? forwardOf(remote) : undefined;
      if (res.kind === "launched") {
        this.refused.delete(key);
        this.launching.set(res.agentId, { wave, task, role });
        void res.verified.then(
          (outcome) => {
            this.launching.delete(res.agentId);
            this.supervise(wave, task, role, outcome, res.lock.path, host, tunnel);
            // Refused by the broker: no work it does can be delivered. Pause it until the
            // decision's answer (relaunch / cancel) replaces or retires it.
            if (outcome.kind === "decision" && outcome.decision === "hooks_auth_failed")
              void this.enqueue(() => this.pauseAuthFailed(outcome.agentId));
            this.settleLaunch(res.agentId);
          },
          (e: unknown) => {
            this.launching.delete(res.agentId);
            this.log(`verify ${key}: ${e instanceof Error ? e.message : String(e)}`);
            this.settleLaunch(res.agentId);
          },
        );
        // Best effort, after supervision is attached: the agent is launched whatever it says.
        void this.spawnRecovered(wave, task, role, res.agentId, prior).catch((e: unknown) =>
          this.log(`spawn ${key}: ${e instanceof Error ? e.message : String(e)}`),
        );
      }
      return res;
    } catch (e) {
      await this.spawnFailed(wave, task, role, e);
      throw e;
    } finally {
      this.spawning.delete(key);
    }
  }

  /**
   * A spawn of a role no live agent holds was refused (spawnAgent journaled its alarm): journal
   * `spawn_failed` with the retry,
   * back off the automatic spawn — 2^(n-1) × 30 s, capped by `spawn_retry_max_s`, none after
   * `spawn_retry_max` failures in a row — and keep one `spawn_failed` decision open on the task
   * (not re-opened while open; superseded once, when the retries stop, by one that says so).
   */
  private async spawnFailed(wave: WaveId, task: TaskId, role: Role, e: unknown): Promise<void> {
    const key = `${wave}/${task}/${role}`;
    const rec = this.waves.get(wave)?.record;
    if (rec === undefined) return;
    // A live agent already holds the role (an extra `volleyd spawn` was refused — SPAWN_LOCKED
    // is exactly that, even while the agent is still being verified): the task itself is fine,
    // so nothing is recorded against it beyond the step's alarm.
    if (e instanceof SpawnError && e.code === "SPAWN_LOCKED") return;
    for (const a of this.supervised.values()) {
      if (a.wave === wave && a.task === task && a.role === role) return;
    }
    const eff = this.config.effective(wave);
    // Failures count per spawn: this role's, for the agent attempt it is trying to launch.
    // A failure that burned its attempt's identity moved the next one on: still the same run.
    const spawnAttempt = this.agentAttempt(wave, task, role);
    const prev = rec.spawnFailures[task]?.[role];
    const prevAttempt = prev?.spawn_attempt ?? spawnAttempt;
    const n =
      prev !== undefined &&
      (prevAttempt === spawnAttempt || this.burnedAttempts(wave, task, role).includes(prevAttempt))
        ? prev.attempt + 1
        : 1;
    // A refusal that can never succeed as is stops the retries at its first failure.
    const permanent = e instanceof SpawnError && e.permanent;
    const stopped = permanent || n >= eff.spawn_retry_max;
    const wait = Math.min(
      DAEMON_DEFAULTS.spawn_retry_base_ms * 2 ** (n - 1),
      secondsMs(eff.spawn_retry_max_s),
    );
    const until = stopped ? Number.POSITIVE_INFINITY : this.now() + wait;
    this.refused.set(key, { n, until });
    const code = e instanceof SpawnError ? e.code : "SPAWN_FAILED";
    const full = e instanceof Error ? e.message : String(e);
    // A SpawnError's message starts with its code, which is journaled beside it.
    const message = full.startsWith(`${code}: `) ? full.slice(code.length + 2) : full;
    const nextRetryAt = stopped ? null : new Date(until).toISOString();
    await this.append(wave, {
      type: "spawn_failed",
      task,
      data: {
        code,
        message,
        role,
        attempt: n,
        spawn_attempt: spawnAttempt,
        next_retry_at: nextRetryAt,
      },
    });
    this.log(
      `spawn ${key} failed (${code}), attempt ${n}: ${stopped ? "retries stopped" : `retry in ${wait / 1000}s`}`,
    );
    const open = this.openSpawnFailedDecision(wave, task);
    if (open !== undefined && (!stopped || open.stopped === true)) return;
    try {
      if (open !== undefined) await this.resolveNow(wave, open.decision_id, SPAWN_RETRIES_STOPPED);
      const question = permanent
        ? `Needs you: ${task}'s ${role} could not be spawned (${code}: ${message}); a retry can never succeed as is, so volleyd does not retry it. Fix the cause, then retry now — or stop the task?`
        : stopped
          ? `Needs you: ${task}'s ${role} could not be spawned after ${n} attempts (${code}: ${message}); volleyd's automatic retries stopped. Fix the cause, then retry now — or stop the task?`
          : `Needs you: ${task}'s ${role} could not be spawned (${code}: ${message}). volleyd retries on its own (next in ${wait / 1000}s, attempt ${n} of ${eff.spawn_retry_max}). Retry now, or stop the task?`;
      const base = spawnFailedDecisionId(wave, task, role);
      let id = base;
      for (let k = 2; rec.decisions[id] !== undefined; k++) id = `${base}-${k}`;
      await this.openDecisionNow(
        wave,
        { kind: "spawn_failed", task, question, options: SPAWN_FAILED_OPTIONS, id, park: false },
        {
          role,
          code,
          attempt: n,
          ...(stopped ? { stopped: true } : {}),
          // resolveNow acts on its answer; the marker names the run it is about.
          pipeline: { on: "spawn_failed", wave, task, role, attempt: spawnAttempt },
        },
      );
    } catch (err) {
      // A settled task (a role spawned at merge_ready) takes no task-level decision.
      this.log(`spawn ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The open `spawn_failed` decision on a task (`_release`'s is wave-level), if any. */
  private openSpawnFailedDecision(
    wave: WaveId,
    task: TaskId,
  ): (DecisionRecord & { stopped?: boolean }) | undefined {
    const rec = this.waves.get(wave)?.record;
    return (rec?.state?.open_decisions ?? [])
      .map((id) => rec?.decisions[id])
      .find((d) => d?.kind === "spawn_failed" && spawnFailedTask(d) === task);
  }

  /**
   * A spawn launched after failures (`prior`, the role's failure before the launch): journal
   * `spawn_recovered`, resolve the open `spawn_failed` decision once no role of the task is
   * still failing, and say so in the log (the failures were in it).
   */
  private async spawnRecovered(
    wave: WaveId,
    task: TaskId,
    role: Role,
    agentId: string,
    prior: SpawnFailure | undefined,
  ): Promise<void> {
    this.log(`spawned ${agentId} (${wave}/${task}/${role})`);
    if (prior === undefined) return;
    await this.append(wave, {
      type: "spawn_recovered",
      task,
      data: {
        role,
        agent_id: agentId,
        after_failures: prior.attempt,
        attempt: prior.attempt + 1,
      },
    });
    if (this.waves.get(wave)?.record.spawnFailures[task] !== undefined) return;
    const open = this.openSpawnFailedDecision(wave, task);
    if (open !== undefined) {
      await this.resolveNow(wave, open.decision_id, { answer: "recovered", by: DAEMON_AGENT_ID });
    }
  }

  /** The branch the latest agent of a task's role was cut on (`agent_spawned`), if any. */
  private lastBranch(wave: WaveId, task: TaskId, role: Role): string | undefined {
    const spawned = this.waves
      .get(wave)
      ?.journal.readAll()
      .filter((e) => e.type === "agent_spawned" && e.task === task && e.data.role === role)
      .at(-1)?.data.branch;
    return typeof spawned === "string" && AGENT_BRANCH.test(spawned) ? spawned : undefined;
  }

  /**
   * The attempt number the next agent spawned for a task's role gets (its branch's `-<n>`); a
   * release stage's (`stage`) counts that stage's agents only.
   */
  private agentAttempt(wave: WaveId, task: TaskId, role: Role, stage?: string): number {
    const journal = this.waves.get(wave)?.journal;
    if (journal === undefined) return 1;
    // A burned attempt (a launch whose outcome could not be decided) may still have a live
    // session: its identity is never reused, so it counts like a spawned one.
    return (
      journal
        .readAll()
        .filter(
          (e) =>
            (e.type === "agent_spawned" || e.type === "spawn_identity_burned") &&
            e.task === task &&
            e.data.role === role &&
            (stage === undefined || e.data.stage === stage),
        ).length + 1
    );
  }

  /** The attempts of a task's role whose identity was burned (`spawn_identity_burned`). */
  private burnedAttempts(wave: WaveId, task: TaskId, role: Role): number[] {
    return (this.waves.get(wave)?.journal.readAll() ?? [])
      .filter((e) => e.type === "spawn_identity_burned" && e.task === task && e.data.role === role)
      .map((e) => Number(e.data.attempt));
  }

  /**
   * The Claude account a task role runs under (SPEC §4.6.11): its last `agent_account_moved`
   * (`source: move`), else the task's `account:`, the wave's, `claude.default_account`, else the
   * balancing rule over the signed-in accounts of the machine it runs on (`primary`, the local
   * profiles here; `primary@<name>` and the profiles kept for it on a paired machine). Every pick
   * carries its `why` and the machine's candidates as ranked for the task's model.
   */
  private accountFor(wave: WaveId, w: Wave, t: WaveTask, role: Role): SelectedAccount {
    const events = this.waves.get(wave)?.journal.readAll() ?? [];
    const machine = t.host === "local" ? LOCAL_MACHINE : t.host;
    const model = t.model;
    const rank = () =>
      rankAccounts(accountRecords(this.usage), this.claude.candidates(machine), {
        model,
        now: this.now(),
      });
    const withCandidates = (sel: SelectedAccount): SelectedAccount =>
      sel.candidates !== undefined ? sel : { ...sel, candidates: rank() };
    const move = lastAccountMove(events, t.id, role);
    if (move !== undefined) {
      const sel = this.claude.select({ task: move.to, machine, model });
      return withCandidates({ ...sel, source: "move", why: move.why });
    }
    const sel = this.claude.select({
      ...(t.account !== undefined ? { task: t.account } : {}),
      ...(w.account !== undefined ? { wave: w.account } : {}),
      configDefault: this.config.effective(wave).claude.default_account,
      machine,
      model,
    });
    // An answered account_limit moved the wave: its new agents start under the other account
    // (an agent moved on its own keeps its own move).
    const to = machine === LOCAL_MACHINE ? waveAccount(sel.id, waveAccountMoves(events)) : sel.id;
    if (to === sel.id) return withCandidates(sel);
    return withCandidates({
      ...this.claude.select({ task: to }),
      source: sel.source,
      why: `wave ${wave} moved to ${to} (account_limit)`,
    });
  }

  /** Whether a wave's spawns balance: neither it nor a task names an account, nor the config. */
  private balanced(wave: WaveId): boolean {
    const w = this.waves.get(wave)?.record.wave;
    if (w === undefined || w === null) return false;
    if (w.account !== undefined && w.account !== MOST_HEADROOM) return false;
    const def = this.config.effective(wave).claude.default_account;
    if (def !== null && def !== MOST_HEADROOM) return false;
    return Object.values(w.tasks).every(
      (t) => t.account === undefined || t.account === MOST_HEADROOM,
    );
  }

  /**
   * A task role's agent names its account: the task, the wave or `claude.default_account` pins
   * one (D2: no agent move; the wave-level `account_limit` covers it).
   */
  private pinned(wave: WaveId, task: TaskId): boolean {
    const w = this.waves.get(wave)?.record.wave;
    const named = (a: string | null | undefined) =>
      a !== undefined && a !== null && a !== MOST_HEADROOM;
    return (
      named(w?.tasks[task]?.account) ||
      named(w?.account) ||
      named(this.config.effective(wave).claude.default_account)
    );
  }

  /** The `local` host agents run on. */
  private get host(): Host {
    this.localHost ??= this.opts.spawner?.host ?? new LocalCmuxHost(realExec);
    return this.localHost;
  }
  private localHost: Host | undefined;

  private get claudeJsonPath(): string {
    return this.opts.spawner?.claudeJsonPath ?? join(homedir(), ".claude.json");
  }

  /** The latest `agent_spawned` facts for an agent id (any wave), or for a wave's task. */
  private spawnedRecord(
    match: (e: JournalEvent) => boolean,
    wave?: WaveId,
  ): Record<string, unknown> | undefined {
    const logs = wave !== undefined ? [this.waves.get(wave)] : [...this.waves.values()];
    for (const log of logs) {
      const e = log?.journal
        .readAll()
        .filter((x) => x.type === "agent_spawned" && match(x))
        .at(-1);
      if (e !== undefined) return e.data;
    }
    return undefined;
  }

  /**
   * Interrupt an agent's session: the configured hook, else Escape into the agent's workspace
   * (on the host it runs on). Resolves false when there is nothing to interrupt with; rejects
   * when the interrupt failed.
   */
  private async interruptAgent(agentId: string): Promise<boolean> {
    if (this.opts.interrupt !== undefined) {
      await this.opts.interrupt(agentId);
      return true;
    }
    if (this.opts.spawner === undefined) return false;
    const a = this.supervised.get(agentId);
    const ws = a?.workspace ?? this.spawnedRecord((e) => e.data.agent_id === agentId)?.workspace;
    if (typeof ws !== "string") return false;
    await (a?.host ?? this.host).sendKeys(ws, "Escape");
    return true;
  }

  /**
   * Where a task's `.volley/decisions.md` goes, and through what: its worktree once it has one,
   * written by the task's host (a remote task's worktree is on its machine); else a local dir.
   */
  private taskDirAndHostFor(
    wave: WaveId,
    task: TaskId,
  ): { dir: string; files: Pick<Host, "writeFile"> } {
    if (this.opts.taskDir !== undefined)
      return { dir: this.opts.taskDir(wave, task), files: LOCAL_FILES };
    const wt =
      this.opts.spawner !== undefined
        ? this.spawnedRecord((e) => e.task === task, wave)?.worktree
        : undefined;
    if (typeof wt === "string") return { dir: wt, files: this.hostOfTask(wave, task)[0] };
    return { dir: join(this.opts.home, "waves", wave, "tasks", task), files: LOCAL_FILES };
  }

  /**
   * A `repo_untrusted` decision resolves itself once its repo is trusted: the owner accepted the
   * dialog by hand (in any worktree of it), or answered `trust`. Covers decisions opened before
   * a launch and those raised from a pane's trust dialog (whose task is no longer queued).
   */
  private async resolveTrustedRepos(): Promise<void> {
    let cfg: Record<string, unknown> | null | undefined;
    for (const [wave, log] of this.waves) {
      for (const d of openDecisions(log.record)) {
        if (d.kind !== "repo_untrusted") continue;
        const root = (d as { repo?: unknown }).repo;
        const repo = typeof root === "string" ? root : log.record.wave?.repo;
        if (repo === undefined) continue;
        if (typeof (d as { target?: unknown }).target === "string") {
          // Trusted on the box, in its own ~/.claude.json: read there, beside the queue.
          this.checkRemoteTrust(wave, d, repo);
          continue;
        }
        // A Claude account profile's own folder trust, else the primary's.
        const profile = (d as { claude_config_dir?: unknown }).claude_config_dir;
        let here: Record<string, unknown> | null;
        if (typeof profile === "string") here = readClaudeJson(join(profile, ".claude.json"));
        else {
          cfg ??= readClaudeJson(this.claudeJsonPath);
          here = cfg;
        }
        if (!isRepoTrusted(here, expandHome(repo))) continue;
        await this.resolveNow(wave, d.decision_id, {
          answer: "trusted",
          by: "claude-trust-dialog",
        });
      }
    }
  }

  /**
   * A remote repo_untrusted decision resolves itself once the box's own `~/.claude.json` trusts
   * the repo (the owner accepted the dialog there). Throttled per decision; the ssh read runs
   * beside the serial queue and only the resolution is queued.
   */
  private checkRemoteTrust(wave: WaveId, d: DecisionRecord, repo: string): void {
    const now = this.now();
    const c = this.trustChecks.get(d.decision_id);
    if (
      c?.inFlight === true ||
      (c !== undefined && now - c.at < DAEMON_DEFAULTS.remote_trust_check_ms)
    )
      return;
    const remote = this.remoteForDecision(wave, d);
    if (remote === undefined) return;
    const entry = { at: now, inFlight: true };
    this.trustChecks.set(d.decision_id, entry);
    const profile = (d as { claude_config_dir?: unknown }).claude_config_dir;
    void remote
      .readTrust(typeof profile === "string" ? profile : undefined)
      .then((cfg) => {
        if (!isRepoTrusted(cfg, repo) || !this.running) return;
        return this.enqueue(async () => {
          const cur = this.waves.get(wave)?.record.decisions[d.decision_id];
          if (cur === undefined || cur.resolved !== undefined) return;
          await this.resolveNow(wave, d.decision_id, {
            answer: "trusted",
            by: "claude-trust-dialog",
          });
        });
      })
      .catch((e: unknown) =>
        this.log(`trust check ${d.decision_id}: ${e instanceof Error ? e.message : String(e)}`),
      )
      .finally(() => {
        entry.inFlight = false;
      });
  }

  /** The remote host a decision's `target` names, through its task's host (null: none now). */
  private remoteForDecision(wave: WaveId, d: DecisionRecord): RemoteHost | undefined {
    const target = (d as { target?: unknown }).target;
    const def = d.task !== null ? this.waves.get(wave)?.record.wave?.tasks[d.task] : undefined;
    if (def === undefined || def.host === "local") return undefined;
    try {
      const h = this.remoteHost(wave, def);
      return h.spec.target === target ? h : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Open a spawn's decision through the decision store (outside the serial queue: spawns run
   * beside it). A base id already used by a resolved decision is re-opened as `<id>-<n>`.
   * Autopilot's answer (and the publish) runs on the queue, and for a launch still being
   * verified only once it is supervised, so a relaunch never retires an agent not yet watched.
   */
  private async openSpawnDecision(wave: WaveId, d: SpawnDecision): Promise<string> {
    const decisions = this.waves.get(wave)?.record.decisions ?? {};
    let id = d.id;
    for (let n = 2; decisions[id] !== undefined; n++) id = `${d.id}-${n}`;
    const rec = await this.openDecisionNow(
      wave,
      {
        kind: d.kind,
        task: d.task,
        question: d.question,
        options: d.options,
        pointers: d.pointers,
        id,
      },
      d.data,
      false,
    );
    const agent = d.data.agent_id;
    if (typeof agent === "string" && this.launching.has(agent)) {
      const pending = this.unsettled.get(agent) ?? [];
      pending.push({ wave, id: rec.decision_id });
      this.unsettled.set(agent, pending);
    } else void this.enqueue(() => this.settleDecision(wave, rec.decision_id));
    return rec.decision_id;
  }

  /** Settle, on the queue, the decisions a launch opened while it was verified. */
  private settleLaunch(agentId: string): void {
    const pending = this.unsettled.get(agentId) ?? [];
    this.unsettled.delete(agentId);
    for (const p of pending) void this.enqueue(() => this.settleDecision(p.wave, p.id));
  }

  private spawnDeps(wave: WaveId): SpawnDeps {
    const spawner = this.opts.spawner as SpawnerOptions;
    const log = this.waves.get(wave) as WaveLog;
    const eff = this.config.effective(wave);
    const host = this.host;
    const probe: AgentProbe = {
      status: async (id) => {
        const ns = this.supervised.get(id)?.namespace ?? log.record.wave?.namespace;
        const raw = await this.broker.queryRetained(
          buildTopic(ns ?? this.opts.namespace, id, "status"),
          DAEMON_DEFAULTS.probe_ms,
        );
        return raw === null || raw === "" ? null : (parseEnvelope(raw)?.type ?? null);
      },
      registered: async (id) => {
        const raw = await this.broker.queryRetained(registryTopic(id), DAEMON_DEFAULTS.probe_ms);
        return raw !== null && raw !== "";
      },
      lastHeartbeat: (id) => this.supervised.get(id)?.watch.state.lastHeartbeatAt ?? null,
    };
    return {
      host,
      home: this.opts.home,
      namespace: this.opts.namespace,
      brokerUrl: this.opts.brokerUrl,
      claudeJsonPath: this.claudeJsonPath,
      hooksDir: spawner.hooksDir ?? HOOKS_DIR,
      mcpEntry: spawner.mcpEntry ?? MCP_ENTRY,
      mintCredentials: spawner.mintCredentials ?? true,
      ...(this.credentials !== undefined ? { credentials: this.credentials } : {}),
      log: (line) => this.log(line),
      tunables: eff,
      owner: log.record.state?.owner ?? null,
      journal: (ev) => this.append(wave, ev),
      journaled: (match) => log.journal.readAll().some(match),
      now: this.now,
      get openDecisions() {
        return log.record.state?.open_decisions ?? [];
      },
      probe,
      watch: (ns, id) => watchAgent(this.broker, ns, id, this.time, this.progressFeed),
      briefGate: briefGatePath(this.opts.home),
      ...(spawner.briefsDir !== undefined ? { briefsDir: spawner.briefsDir } : {}),
      clearRetained: (topic) => this.broker.publish(topic, "", { qos: 1, retain: true }),
      publishRetained: (topic, payload) =>
        this.broker.publish(topic, payload, { qos: 1, retain: true }),
      openDecision: (d) => this.openSpawnDecision(wave, d),
      prepareAccount: async (a) => {
        await this.claude.prepare(a);
      },
      resolveDecision: async (id, answer, by) => {
        await this.resolveNow(wave, id, { answer, by });
      },
    };
  }

  // -------------------------------------------------------------------------------------------
  // Remote hosts (T15): ssh + tmux on a second machine, broker through a reverse tunnel.
  // -------------------------------------------------------------------------------------------

  /** Task `id`'s definition as ran: `ranTaskDef`. */
  private ranDef(rec: WaveRecord | undefined, id: TaskId): WaveTask | undefined {
    return ranTaskDef(rec, id);
  }

  /**
   * Task `t` reached a host resolver as `auto` (never placed, never spawned): an alarm, once per
   * task per daemon run (the set is in memory), and the caller falls back to the supervisor's own host.
   */
  private autoHostReached(wave: WaveId, t: WaveTask): boolean {
    if (t.host !== AUTO_HOST) return false;
    const key = `${wave}/${t.id}`;
    if (!this.autoHostAlarmed.has(key)) {
      this.autoHostAlarmed.add(key);
      this.append(wave, {
        type: "alarm_raised",
        task: t.id,
        data: {
          alarm: "host_auto_unresolved",
          message: `host 'auto' reached the host resolver for ${t.id}: its checks run on the supervisor's own host`,
        },
      }).catch((e: unknown) =>
        this.log(`host_auto_unresolved ${key}: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
    return true;
  }

  /** The task's remote host: config `hosts.<name>` ← its inline `host:`. Throws if unresolvable. */
  private remoteHost(wave: WaveId, t: WaveTask): RemoteHost {
    if (t.host === AUTO_HOST) throw new Error(`host 'auto' reached the host resolver for ${t.id}`);
    return this.remoteBySpec(
      resolveRemoteHost(t.host, t.host_spec, this.config.effective(wave).hosts),
    );
  }

  /** The configured host `name` (no task's inline `host:`), or why it cannot be reached. */
  private remoteFor(name: string): RemoteHost | string {
    try {
      return this.remoteBySpec(resolveRemoteHost(name, undefined, this.config.effective().hosts));
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  private remoteBySpec(spec: RemoteHostSpec): RemoteHost {
    const key = JSON.stringify(spec);
    let h = this.remotes.get(key);
    if (h === undefined) {
      const make =
        this.opts.spawner?.remoteHost ??
        ((s: RemoteHostSpec) => new SshTmuxHost(s, this.opts.spawner?.remoteExec ?? realExec));
      h = make(spec);
      this.remotes.set(key, h);
    }
    return h;
  }

  /**
   * Remote hosts of the wave's unfinished tasks (queued, parked or running): keep their tunnels
   * up and their checks fresh. Running agents need the check too: their reap waits while their
   * tunnel is down.
   */
  private checkTunnels(wave: WaveId): void {
    const rec = this.waves.get(wave)?.record;
    for (const t of rec?.state?.tasks ?? []) {
      const def = this.ranDef(rec, t.id);
      if (
        def === undefined ||
        def.host === "local" ||
        def.host === AUTO_HOST ||
        t.stage === "done" ||
        t.stage === "cancelled"
      )
        continue;
      let h: RemoteHost;
      try {
        h = this.remoteHost(wave, def);
      } catch {
        continue; // refused (and journaled) when its spawn is attempted
      }
      const { target, tunnel } = h.spec;
      const port = tunnel.remote_port;
      const key = forwardOf(h);
      if (tunnel.supervise && !this.tunnels.has(target, port)) {
        void this.track(this.tunnelChecks.poke(key, () => this.startTunnel(h)));
        continue;
      }
      const checked = this.tunnelChecks.poke(key, async (): Promise<TunnelStatus> => {
        // Only the supervised ssh having stayed up says the port is the tunnel: a forward whose
        // ssh keeps failing is down whatever answers there (the box's own broker, a stale
        // forward), and one still coming up is not known either way yet.
        const health = tunnel.supervise ? this.tunnels.health(target, port) : "ok";
        if (health === "failing") {
          this.tunnelDownWhy.set(key, "its ssh keeps exiting");
          return "down";
        }
        if (health === "settling") return "unknown";
        if (await h.tunnelUp()) return "up";
        this.tunnelDownWhy.delete(key);
        return "down";
      });
      void this.track(checked);
    }
  }

  /**
   * Start a supervised forward, unless something already answers on the box's port: before
   * the tunnel exists, a listener there is not it (the box's own broker, a forward left by an
   * earlier daemon), and agents sent to it would never reach this broker. sshd binds a loopback
   * forward on IPv4 and IPv6, so a listener on one of them does not make ssh's forward fail.
   */
  private async startTunnel(h: RemoteHost): Promise<TunnelStatus> {
    const { target, tunnel } = h.spec;
    const key = forwardOf(h);
    if (await h.tunnelUp()) {
      this.tunnelDownWhy.set(key, `port ${tunnel.remote_port} on ${target} is already in use`);
      return "down";
    }
    try {
      this.tunnels.ensure(target, tunnel.remote_port, this.opts.brokerUrl);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      this.log(`tunnel ${target}: ${why}`);
      this.tunnelDownWhy.set(key, why);
      return "down";
    }
    this.tunnelDownWhy.delete(key);
    return "unknown";
  }

  /**
   * True (and the reason kept for why_waiting) when the task's remote host has no working
   * tunnel: its spawn waits. Only new spawns wait; running agents are never touched.
   */
  private parkOnTunnel(wave: WaveId, task: string): boolean {
    if (this.parkClosed(wave, task)) return true;
    const key = `${wave}/${task}`;
    const def = this.waves.get(wave)?.record.wave?.tasks[task];
    let target: string | undefined;
    let forward: string | undefined;
    if (def !== undefined && def.host !== "local") {
      try {
        const h = this.remoteHost(wave, def);
        target = h.spec.target;
        forward = forwardOf(h);
      } catch {}
    }
    const status = forward !== undefined ? this.tunnelChecks.status(forward) : "up";
    const before = this.parked.get(key);
    const machine = def !== undefined ? this.machines.record(def.host) : undefined;
    const reason =
      machine?.tunnel === "down"
        ? `tunnel down to ${machine.name}: ${this.machines.whyDown(machine)}`
        : status === "up"
          ? undefined
          : status === "down"
            ? `tunnel down to ${target}`
            : `checking tunnel to ${target}`;
    if (reason === undefined) this.parked.delete(key);
    else this.parked.set(key, reason);
    if (reason !== before) void this.enqueue(() => this.publishState(wave));
    return reason !== undefined;
  }

  /** The wave's unfinished tasks whose remote host uses the forward `key`, with that host. */
  private tasksOnForward(wave: WaveId, key: string): { ids: string[]; host?: RemoteHost } {
    const rec = this.waves.get(wave)?.record;
    const ids: string[] = [];
    let host: RemoteHost | undefined;
    for (const t of rec?.state?.tasks ?? []) {
      const def = rec?.wave?.tasks[t.id];
      if (def === undefined || def.host === "local") continue;
      if (t.stage === "done" || t.stage === "cancelled") continue;
      try {
        const h = this.remoteHost(wave, def);
        if (forwardOf(h) !== key) continue;
        ids.push(t.id);
        host ??= h;
      } catch {}
    }
    return host !== undefined ? { ids, host } : { ids };
  }

  /** A tunnel check changed: journal a drop for the waves on that forward, then re-admit. */
  private async onTunnel(key: string, status: TunnelStatus): Promise<void> {
    if (!this.running) return;
    for (const wave of this.waves.keys()) {
      const { ids, host } = this.tasksOnForward(wave, key);
      if (host === undefined) continue;
      if (status === "down") {
        const { target, tunnel } = host.spec;
        const why = this.tunnelDownWhy.get(key);
        await this.append(wave, {
          type: "alarm_raised",
          data: {
            code: "TUNNEL_DOWN",
            message: `tunnel down to ${target} (port ${tunnel.remote_port}${why !== undefined ? `: ${why}` : ""}): spawns on it wait; running agents are left alone`,
            host: host.spec.name,
            target,
            remote_port: tunnel.remote_port,
            ...(why !== undefined ? { reason: why } : {}),
            tasks: ids,
          },
        });
      }
      await this.publishState(wave);
    }
    await this.tickNow();
  }

  /**
   * Paired machines (SPEC §4.6.14): mark those whose heartbeat stopped down, republishing their
   * retained record as volleyd (the machine's own LWT covers a clean disconnect).
   */
  private async sweepMachines(): Promise<void> {
    for (const record of this.machines.sweep()) {
      await this.publish(
        machineTopic(record.name),
        this.envelope(MACHINE_CHANNEL, "machine", record),
        true,
      );
    }
  }

  // -------------------------------------------------------------------------------------------
  // Fleet (F2, SPEC §4.6.15): the supervisor's own machine record, readiness, PATH probes
  // -------------------------------------------------------------------------------------------

  /**
   * Every tick: start the own doctor when one is due (outside the queue: it runs for seconds),
   * re-publish the own record every `machine_heartbeat_ms`, then re-compute every verdict.
   */
  private async fleetTick(): Promise<void> {
    const beat = DAEMON_DEFAULTS.machine_heartbeat_ms;
    const now = this.now();
    this.fleetSince ??= now;
    if (
      this.running &&
      this.opts.fleet?.localDoctor !== undefined &&
      !this.localDoctorRunning &&
      (this.localDoctorAt === null ||
        now - this.localDoctorAt >= beat ||
        this.localDoctorTried !== this.waveRepo())
    ) {
      this.localDoctorRun = this.runLocalDoctor();
    }
    if (
      this.ownRecordAt === null ||
      now - this.ownRecordAt >= beat ||
      this.ownRecord?.name !== this.config.localName()
    ) {
      await this.publishOwnRecord();
    }
    await this.publishReadiness();
  }

  /**
   * Once per wave (SPEC §4.6.15): a running `placement: local` wave, while the own machine's load
   * per core is over `placement.load_per_core_max` and a ready, undrained peer has free
   * `max_agents` slots, journals `alarm_raised { alarm: "peer_idle_under_load", peer, free,
   * message }` (`volleyd status` and the digest show it), and `alarm_cleared` once the own load
   * per core is back under the threshold (or the wave is `auto`); it is not raised again for the
   * wave. An `auto` wave places onto the peer itself.
   */
  private async warnPeerIdle(): Promise<void> {
    const cfg = this.config.effective();
    const own = this.ownRecord;
    if (own === undefined || !(own.cores > 0)) return;
    const perCore = overloadLoad(own) / own.cores;
    for (const [wave, log] of this.runningWaves()) {
      // After a restart the journal says whether it was raised, or raised and cleared, already.
      const known = this.peerIdleWarned.get(wave) ?? peerIdleAlarmState(log.journal.readAll());
      this.peerIdleWarned.set(wave, known);
      // Overloaded by the wave's own threshold (its `config:` may set one), as it was raised.
      const placement = this.config.effective(wave).placement;
      const hot = perCore > placement.load_per_core_max;
      if (known === "cleared" || (known === "none" && !hot)) continue;
      const local = (log.record.plan ?? log.record.wave)?.placement !== AUTO_HOST;
      // Only the load clears it: a peer's verdict settling after a restart is no all-clear.
      if (known === "raised") {
        if (hot && local) continue;
        this.peerIdleWarned.set(wave, "cleared");
        await this.append(wave, { type: "alarm_cleared", data: { alarm: PEER_IDLE_ALARM } });
        continue;
      }
      if (!local) continue;
      const gate = admissionFor(log.record, this.killSwitch, this.pressure(wave));
      const idle = peerIdleUnderLoad(this.placementSnapshot(gate, cfg), { placement });
      if (idle !== null) {
        this.peerIdleWarned.set(wave, "raised");
        await this.append(wave, {
          type: "alarm_raised",
          data: { alarm: PEER_IDLE_ALARM, peer: idle.peer, free: idle.free, message: idle.message },
        });
        this.log(`wave ${wave}: ${idle.message}`);
      }
    }
  }

  /**
   * The supervisor's own doctor (`volley peer doctor --json --repo <the running wave's repo>`); its
   * report fills the own record. Runs again at once when the running wave's repo changes.
   */
  private async runLocalDoctor(): Promise<void> {
    const doctor = this.opts.fleet?.localDoctor;
    if (doctor === undefined) return;
    this.localDoctorRunning = true;
    this.localDoctorAt = this.now();
    const repo = this.waveRepo();
    this.localDoctorTried = repo;
    try {
      const report = await doctor(repo, this.localDoctorAbort.signal).catch((e: unknown) => {
        this.log(`own doctor failed: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      });
      if (!this.running) return;
      // A failed run settles the verdict too (on the last report, or none).
      await this.enqueue(async () => {
        if (report !== null) {
          this.localReport = report;
          this.localDoctorRepo = repo;
        } else if (this.localDoctorRepo === undefined) {
          this.localDoctorRepo = null;
        }
        await this.publishOwnRecord();
        await this.publishReadiness(this.config.localName());
      });
    } finally {
      this.localDoctorRunning = false;
    }
  }

  /**
   * The own machine's record, as volleyd (`kind: supervisor`, `tunnel: local`): live load,
   * memory and agents from `os`, the rest from the own doctor's last report. A renamed machine
   * (`fleet.local_name`) clears the old name's record and verdict.
   */
  private async publishOwnRecord(): Promise<void> {
    const name = this.config.localName();
    const prior = this.ownRecord;
    if (prior !== undefined && prior.name !== name) {
      this.machines.forget(prior.name);
      await this.clearRetained(machineTopic(prior.name));
      await this.clearReadiness(prior.name);
    }
    const sys = this.opts.fleet?.os;
    const total = (sys?.totalmem ?? totalmem)();
    const round = (n: number) => Math.round(n * 100) / 100;
    const os = (sys?.platform ?? platform)();
    // Available memory has one definition on every machine (SPEC §4.6.15). Linux: `freemem()` is
    // MemAvailable. macOS: free pages alone under-count, so the figure is the own doctor's
    // (`vm_stat`, as every macOS peer reports it); none yet: unknown, never the free pages.
    const available =
      os === "darwin"
        ? (this.localReport?.memory?.available_pct ?? null)
        : round(((sys?.freemem ?? freemem)() / total) * 100);
    const memory =
      available === null
        ? undefined
        : { total_mb: Math.max(1, Math.round(total / (1024 * 1024))), available_pct: available };
    const base: MachineRecord = {
      name,
      kind: "supervisor",
      os,
      arch: osArch(),
      cores: Math.max(1, availableParallelism()),
      tunnel: "local",
      load: (sys?.loadavg ?? loadavg)().slice(0, 3).map(round) as [number, number, number],
      agents: this.placedOn(name),
      ...(memory !== undefined ? { memory } : {}),
      uptime_s: Math.floor(uptime()),
      last_seen: dateOf(this.time).toISOString(),
    };
    const report = this.localReport;
    let record: MachineRecord =
      report === null
        ? base
        : {
            ...base,
            ...doctorFields(report),
            ...(memory !== undefined ? { memory } : {}),
            ...(report.versions !== undefined
              ? { versions: { ...report.versions, volley: this.version } }
              : {}),
          };
    if (!validator("machine.schema.json")(this.envelope(MACHINE_CHANNEL, "machine", record))) {
      this.log("own doctor report does not fit machine.schema.json: published without it");
      record = base;
    }
    this.ownRecord = record;
    this.ownRecordAt = this.now();
    this.machines.observe(record);
    await this.publish(machineTopic(name), this.envelope(MACHINE_CHANNEL, "machine", record), true);
    if (this.foldLogins(record, LOCAL_MACHINE)) await this.usagePass();
  }

  /**
   * Fold a machine record's usage probe logins (SPEC §4.6.12) into their accounts: `machine` is
   * `local` for the own record, else the paired machine's name. A login the registry does not
   * have on that machine is skipped. True when the book changed (it is then kept on disk).
   */
  private foldLogins(record: MachineRecord, machine: string): boolean {
    if (record.claude_logins === undefined) return false;
    const before = bookState(this.usage);
    for (const login of record.claude_logins) {
      const account = this.claude.accountForLogin(machine, login.profile);
      if (account === null) continue;
      this.usage = foldProbe(this.usage, { account, machine: record.name, login });
    }
    const after = bookState(this.usage);
    if (after === before) return false;
    writeFileAtomic(this.usageFile, after);
    return true;
  }

  /** Live supervised agents on machine `name` (the `local` token is the own machine). */
  private placedOn(name: string): number {
    const local = this.config.localName();
    let n = 0;
    for (const id of this.supervised.keys()) {
      const host = this.spawnedAgents.get(id)?.host ?? LOCAL_HOST;
      if ((host === LOCAL_HOST ? local : host) === name) n++;
    }
    return n;
  }

  /**
   * Re-compute the verdict of every machine (or only `name`): the own machine and every
   * configured host. Published retained when it changed or is a heartbeat old; journaled as
   * `machine_readiness_changed` when `ready` or `reasons` change. A host no longer configured has
   * its verdict cleared.
   */
  private async publishReadiness(only?: string): Promise<void> {
    if (!this.running) return;
    const cfg = this.config.effective();
    const local = this.config.localName();
    const names = [local, ...Object.keys(cfg.hosts).filter((n) => n !== local)];
    for (const n of [...this.published.keys()])
      if (!names.includes(n)) await this.clearReadiness(n);
    const shared = this.requirementsExtra();
    // The own machine's verdict weighs every peer's (its `local_agents` mode), so a peer's
    // change re-computes it too.
    const which = only === undefined ? names : names.filter((n) => n === only || n === local);
    for (const name of which) {
      const isLocal = name === local;
      if (!isLocal) this.maybeProbe(name);
      // Inputs not gathered yet in this process: the last retained verdict stands.
      if (!this.isSettled(name, isLocal)) continue;
      const v = this.machineState(name, isLocal, cfg, shared, cfg, this.pressure(GLOBAL)).verdict;
      if (isLocal) this.ownLocalAgents = v.local_agents;
      const key = readinessKey(v);
      const now = this.now();
      const prior = this.published.get(name);
      if (
        prior === undefined ||
        prior.key !== key ||
        now - prior.at >= DAEMON_DEFAULTS.machine_heartbeat_ms
      ) {
        this.published.set(name, { key, at: now });
        await this.publish(
          readinessTopic(name),
          this.envelope(READINESS_CHANNEL, "readiness", v),
          true,
        );
      }
      // A machine's first settled verdict is its baseline (nothing changed yet); a restart
      // compares with the last journaled one.
      const was = this.journaledReadiness.get(name);
      if (was === undefined)
        this.journaledReadiness.set(name, { ready: v.ready, reasons: v.reasons });
      else if (was.ready !== v.ready || JSON.stringify(was.reasons) !== JSON.stringify(v.reasons)) {
        this.journaledReadiness.set(name, { ready: v.ready, reasons: v.reasons });
        await this.appendSystem({
          type: "machine_readiness_changed",
          data: { name, ready: v.ready, reasons: v.reasons },
        });
      }
    }
  }

  /**
   * Whether machine `name`'s verdict has its inputs: a peer's record has folded in and its first
   * PATH probe finished (none runs while its tunnel is not up); the own machine's first doctor run
   * finished. Either way at most `machine_down_after_ms` after this process began. Once settled,
   * a machine stays settled.
   */
  private isSettled(name: string, isLocal: boolean): boolean {
    if (this.readinessSettled.has(name)) return true;
    let warm: boolean;
    if (isLocal) {
      warm = this.opts.fleet?.localDoctor === undefined || this.localDoctorRepo !== undefined;
    } else {
      const r = this.machines.record(name);
      const probe = this.probes.get(name);
      warm = r !== undefined && (r.tunnel !== "up" || (probe !== undefined && !probe.running));
    }
    this.fleetSince ??= this.now();
    if (!warm && this.now() - this.fleetSince < DAEMON_DEFAULTS.machine_down_after_ms) {
      return false;
    }
    this.readinessSettled.add(name);
    return true;
  }

  /** A removed (or renamed) machine: its verdict cleared, its probe forgotten. */
  private async clearReadiness(name: string): Promise<void> {
    this.published.delete(name);
    this.probes.delete(name);
    this.readinessSettled.delete(name);
    await this.clearRetained(readinessTopic(name));
  }

  private readinessInput(
    name: string,
    isLocal: boolean,
    cfg: Tunables,
    extra: Pick<ReadinessInput, "bun" | "sharing">,
    eff: Tunables,
    gate: Admission,
  ): ReadinessInput {
    const h = Object.hasOwn(cfg.hosts, name) ? cfg.hosts[name] : undefined;
    const probe = this.probes.get(name);
    const downSince = isLocal ? undefined : this.machines.downSince(name);
    const records = accountRecords(this.usage);
    // Its best candidate (the balancing rule's pick there), so one fresh login keeps it eligible;
    // a config default that pins an account here is that account.
    const pin = cfg.claude.default_account;
    const account =
      isLocal && pin !== null && pin !== MOST_HEADROOM
        ? pin
        : (rankAccounts(records, this.claude.candidates(isLocal ? LOCAL_MACHINE : name), {
            now: this.now(),
          })[0]?.account ?? null);
    return {
      name,
      record: isLocal ? this.ownRecord : this.machines.record(name),
      local: isLocal,
      // The own machine is capped by hard_ceiling, which caps every supervised agent: its
      // headroom is the ceiling less all of them, wherever they run.
      host: isLocal
        ? { max_agents: cfg.hard_ceiling, drain: false }
        : {
            max_agents: peerMaxAgents(h?.max_agents, this.machines.record(name)),
            // A pending removal keeps it closed, whatever its drain says now.
            drain:
              (h?.drain ?? REMOTE_HOST_DEFAULTS.drain) ||
              Object.hasOwn(this.peers.removals(), name),
          },
      hostVersion: this.version,
      hostOrigin: this.waveOrigin(),
      ...(isLocal && this.localDoctorRepo === null ? { noRepo: true } : {}),
      probe: isLocal ? (this.opts.fleet?.localPath ?? pathProbe)() : (probe?.path ?? null),
      ...(!isLocal && probe?.error !== undefined ? { probeError: probe.error } : {}),
      placed: isLocal
        ? this.supervised.size + this.reservedOn(null)
        : this.placedOn(name) + this.reservedOn(name),
      ...(isLocal
        ? {
            // Its own agents alone, which its fallback profile counts (SPEC §4.6.15), and every
            // peer, whose eligibility its `local_agents` mode weighs. Each peer's view is built
            // again here (and placement's snapshot builds it once more): O(peers²) per tick,
            // deliberate at fleet sizes of a handful, for one source of each peer's view.
            localAgents: this.placedOn(name) + this.reservedOn(name),
            peers: Object.keys(cfg.hosts)
              .filter((n) => n !== name)
              .map((n) => this.machineState(n, false, cfg, extra, eff, gate).view),
          }
        : downSince !== undefined
          ? { downSince }
          : {}),
      heavy: Object.fromEntries(
        Object.entries(cfg.lease_pools).flatMap(([pool, c]) => {
          // The cap in force on this machine (its override, else the pool's); the own machine
          // also has a slot count in each pool its fallback profile names.
          const named = isLocal && Object.hasOwn(cfg.fleet.fallback.per_machine, pool);
          const cap = capFor(c, name) ?? (named ? c.capacity : undefined);
          return cap === undefined
            ? []
            : [
                [
                  pool,
                  {
                    held: heldOn(this.leases, pool, name) + this.heavyReservedOn(name, pool),
                    per_machine: cap,
                  },
                ],
              ];
        }),
      ),
      usage: {
        account,
        five_hour_pct: account !== null ? (records[account]?.five_hour?.pct ?? null) : null,
      },
      filter: this.filterOptions(eff),
      held: isLocal ? machineReasons(gate) : this.hostVerdict(name, eff).recovering,
      ...extra,
      checkedAt: dateOf(this.time),
    };
  }

  /**
   * The running wave's repo's origin (normalised), as the own doctor's last run on that clone
   * read it: what a peer's clone is compared with, and what Repair's clone clones. Null while no
   * wave runs, or no run has checked its clone yet (a failed run keeps an earlier wave's report).
   */
  private waveOrigin(): string | null {
    const repo = this.localDoctorRepo;
    return typeof repo === "string" && repo === this.waveRepo()
      ? (this.localReport?.repo?.origin ?? null)
      : null;
  }

  /**
   * The wave repo the supervisor's own clone is checked against: the running wave's (the first by
   * wave id when several run), as an absolute path; null when no wave runs.
   */
  private waveRepo(): string | null {
    const repos = this.runningWaves()
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, l]) => l.record.wave?.repo ?? "")
      .filter((r) => r !== "");
    return repos[0] !== undefined ? resolve(repoDir(repos[0])) : null;
  }

  /**
   * What every verdict's `requirements` adds to the version: the bun the running wave's repo
   * (`waveRepo`) asks for (`engines.bun`, else `packageManager`), and the own `sharing.yaml`
   * modes.
   */
  private requirementsExtra(): Pick<ReadinessInput, "bun" | "sharing"> {
    let sharing: Sharing | undefined;
    try {
      sharing = readSharing(this.opts.claude?.root ?? claudeRoot());
    } catch {
      sharing = undefined;
    }
    let bun: string | undefined;
    const dir = this.waveRepo();
    if (dir !== null) {
      try {
        const p = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as {
          engines?: { bun?: unknown };
          packageManager?: unknown;
        };
        const engines =
          typeof p.engines?.bun === "string" ? p.engines.bun.replace(/^[\s^~>=<]+/, "") : "";
        const pm =
          typeof p.packageManager === "string" && p.packageManager.startsWith("bun@")
            ? (p.packageManager.slice("bun@".length).split("+")[0] ?? "")
            : "";
        const v = engines !== "" ? engines : pm;
        if (/^[0-9][0-9A-Za-z.-]{0,63}$/.test(v)) bun = v;
      } catch {}
    }
    return {
      ...(bun !== undefined ? { bun } : {}),
      ...(sharing !== undefined ? { sharing } : {}),
    };
  }

  /**
   * The PATH probe of a peer whose record is up, at most every `path_probe_interval_ms`: run
   * beside the queue (it is an ssh round-trip), then re-compute that machine's verdict.
   */
  private maybeProbe(name: string): void {
    if (this.machines.record(name)?.tunnel !== "up") return;
    const prior = this.probes.get(name);
    const at = this.now();
    if (
      prior !== undefined &&
      (prior.running || at - prior.at < DAEMON_DEFAULTS.path_probe_interval_ms)
    ) {
      return;
    }
    const host = this.remoteFor(name);
    if (typeof host === "string") {
      this.probes.set(name, { path: null, error: host, at, running: false });
      return;
    }
    this.probes.set(name, { path: prior?.path ?? null, at, running: true });
    void Promise.resolve()
      .then(() => host.probePath())
      .then(
        (path) => ({ path }),
        (e: unknown) => ({ path: null, error: e instanceof Error ? e.message : String(e) }),
      )
      .then(async (r) => {
        if (!this.running) return;
        await this.enqueue(async () => {
          // A removed host (or a newer probe) is not overwritten by this one.
          if (this.probes.get(name)?.at !== at) return;
          this.probes.set(name, { ...r, at, running: false });
          await this.publishReadiness(name);
        });
      });
  }

  /**
   * `peer_doctor` (admin, peers.ts), checked inside the queue; its run (an ssh round-trip of up to
   * `peer_doctor_timeout_ms`) is awaited outside it, so ticks, control ops and record folds go on.
   * One run per host at a time: two `--fix` runs never overlap on one box. After a run the box's
   * PATH is probed again, its report is folded into the box's machine record (`foldDoctor`), and
   * `peer_doctor_run` is journaled.
   */
  private peerDoctor(p: Record<string, unknown>, sender: string): AuthOutcome | DeferredAuth {
    const req = this.peers.doctorRequest(p, this.waveOrigin());
    if (!("host" in req)) return { reply: authReply("peer_doctor", req) };
    if (this.doctoring.has(req.name)) {
      return {
        reply: authReply("peer_doctor", {
          ok: false,
          error: `a doctor run on "${req.name}" is already in progress`,
        }),
      };
    }
    this.doctoring.add(req.name);
    const run: DoctorRun = req;
    return {
      later: async () => {
        let r: PeerReply & { report?: DoctorReport };
        try {
          r = await this.peers.runDoctor(run);
        } finally {
          this.doctoring.delete(run.name);
        }
        const { report, ...reply } = r;
        if (r.ok) this.probes.delete(run.name);
        // Through the queue (record folds and verdicts are its), before the answer goes back.
        if (report !== undefined) await this.enqueue(() => this.foldDoctor(run.name, report));
        return {
          reply: authReply("peer_doctor", reply),
          journal: {
            type: "peer_doctor_run",
            data: { by: sender, name: run.name, fix: run.fix, clone: run.clone, ok: r.ok },
          },
        };
      },
    };
  }

  /**
   * A doctor run the supervisor started on a paired box: its report replaces the doctor fields of
   * the box's retained record (republished as volleyd, as the sweep does) and its verdict is
   * recomputed, so the Desk and readiness follow the run without waiting for the box's next
   * heartbeat (whose service re-runs its own doctor too). A box that never published a record
   * has nothing to fold into, and one whose tunnel is down keeps its record (a down box is not
   * ready whatever its checks say; its next `up` heartbeat brings the run).
   */
  private async foldDoctor(name: string, report: DoctorReport): Promise<void> {
    const prior = this.machines.record(name);
    if (!this.running || prior?.tunnel !== "up") return;
    const record: MachineRecord = { ...prior, ...doctorFields(report) };
    if (!validator("machine.schema.json")(this.envelope(MACHINE_CHANNEL, "machine", record))) {
      this.log(`${name}'s doctor report does not fit machine.schema.json: record left as it was`);
      return;
    }
    this.machines.observe(record, { heard: false });
    await this.publish(machineTopic(name), this.envelope(MACHINE_CHANNEL, "machine", record), true);
    await this.publishReadiness(name);
  }

  /**
   * A machine went down or came back: journal a drop for the waves with unfinished tasks on its
   * host, re-publish their state (their spawns park or resume), then re-admit.
   */
  private async onMachine(
    name: string,
    status: MachineStatus,
    record: MachineRecord,
  ): Promise<void> {
    if (!this.running) return;
    if (status === "up") await this.machineBack(name);
    for (const [wave, log] of this.waves) {
      const tasks = (log.record.state?.tasks ?? [])
        .filter((t) => t.stage !== "done" && t.stage !== "cancelled")
        .filter((t) => log.record.wave?.tasks[t.id]?.host === name);
      const ids = tasks.map((t) => t.id);
      if (ids.length === 0) continue;
      if (status === "down") {
        await this.append(wave, {
          type: "alarm_raised",
          data: {
            code: "MACHINE_DOWN",
            message: `machine ${name} is down (${this.machines.whyDown(record)}): spawns on it wait; running agents are left alone`,
            host: name,
            reason: record.reason ?? "disconnect",
            last_seen: record.last_seen,
            tasks: ids,
          },
        });
      }
      // Only spawns wait (spawnAdmitted parks them the same way); running agents are untouched.
      for (const t of tasks) {
        if (t.stage === "queued" && t.agents.implementer === undefined)
          this.parkOnTunnel(wave, t.id);
      }
      await this.publishState(wave);
    }
    await this.tickNow();
  }

  /**
   * A supervised tunnel's ssh exited (it restarts with backoff). Journaled on the waves that use
   * the forward, log-spaced (the 1st, 2nd, 4th, 8th … exit of a streak) so a flapping tunnel
   * cannot flood the journal; from the 2nd exit in a row the forward is failing (TunnelHealth),
   * and its check is re-run at once so spawns on it park.
   */
  private onTunnelExit(x: TunnelExit): void {
    if (!this.running) return;
    const key = tunnelKey(x.target, x.remotePort);
    this.tunnelChecks.invalidate(key);
    if ((x.streak & (x.streak - 1)) !== 0) return;
    const failing = x.streak >= 2;
    void this.enqueue(async () => {
      for (const wave of this.waves.keys()) {
        const { ids, host } = this.tasksOnForward(wave, key);
        if (host === undefined) continue;
        await this.append(wave, {
          type: "alarm_raised",
          data: {
            code: failing ? "TUNNEL_FORWARD_FAILED" : "TUNNEL_EXITED",
            message: failing
              ? `the tunnel to ${x.target} keeps failing (port ${x.remotePort} on the box may be taken): spawns on it wait`
              : `the tunnel to ${x.target} exited; restarting it`,
            host: host.spec.name,
            target: x.target,
            remote_port: x.remotePort,
            exit: x.code,
            stderr: x.stderr.trim().slice(-DAEMON_DEFAULTS.alarm_stderr_max_chars),
            restarts: x.streak,
            tasks: ids,
          },
        });
      }
    });
  }

  /**
   * The remote half of a spawn's setup: the box's clone must exist (else a
   * `remote_repo_missing` decision), its folder trust is mirrored (trust bits only) for the
   * trust check, and spawn runs with the box's repo, worktree root, hooks, broker URL and a lock
   * directory per target (`$VOLLEYD_HOME/hosts/<target>/locks`: the lock is keyed by target and
   * worktree path).
   */
  private async remoteSpawn(
    wave: WaveId,
    task: string,
    remote: RemoteHost,
    deps: SpawnDeps,
  ): Promise<{ wave: NonNullable<WaveLog["record"]["wave"]>; deps: Partial<SpawnDeps> }> {
    const log = this.waves.get(wave) as WaveLog;
    const w = log.record.wave as NonNullable<WaveLog["record"]["wave"]>;
    const { spec } = remote;
    const journal = deps.journal;
    const decisionId = waveDecisionId("remote_repo_missing", wave, `${spec.target}:${spec.repo}`);
    const openId = openDecisionFor(log.record.state?.open_decisions ?? [], decisionId);
    // An ssh failure is not a missing clone: it throws a transient LAUNCH_FAILED (backed off).
    const exists = await remote.repoExists().catch(async (e: unknown) => {
      const err =
        e instanceof SpawnError
          ? e
          : new SpawnError("LAUNCH_FAILED", e instanceof Error ? e.message : String(e));
      await this.append(wave, {
        type: "alarm_raised",
        task,
        data: { code: err.code, message: err.message, role: "implementer", ...err.detail },
      });
      throw err;
    });
    if (!exists) {
      // Through the decision store: retained topic (the Desk, notify) and the task parks.
      if (openId === undefined) {
        await this.openSpawnDecision(wave, {
          kind: "remote_repo_missing",
          id: decisionId,
          task,
          question: `Needs you: no clone of the repo at ${spec.repo} on ${spec.target}. Clone it there, then retry?`,
          options: ["retry", "cancel"],
          pointers: {},
          data: { host: spec.name, target: spec.target, repo: spec.repo },
        });
      }
      throw new SpawnError("REMOTE_REPO_MISSING", `no clone at ${spec.repo} on ${spec.target}`, {
        host: spec.name,
        target: spec.target,
        repo: spec.repo,
      });
    }
    // The clone appeared while the decision was still open: only a spawn that does not wait for
    // the task to be queued gets here (a manual `volleyd spawn`, or a later pipeline role).
    if (openId !== undefined) {
      await this.resolveNow(wave, openId, { answer: "found", by: DAEMON_AGENT_ID });
    }
    const lockHome = join(this.opts.home, "hosts", spec.target);
    mkdirSync(lockHome, { recursive: true, mode: 0o700 });
    return {
      wave: { ...w, repo: spec.repo },
      deps: {
        host: remote,
        lockHome,
        brokerUrl: remote.brokerUrl,
        hooksDir: remote.hooksDir,
        mcpEntry: remote.mcpEntry,
        // Trust is the box's own: read from its ~/.claude.json at every spawn, never mirrored.
        remoteTrust: { host: spec.name, target: spec.target, read: (dir) => remote.readTrust(dir) },
        tunables: { ...deps.tunables, worktree_root: spec.worktree_root },
        // cleanup reaches the box again from the journal: record where the agent runs.
        journal: (ev) =>
          journal(
            ev.type === "agent_spawned"
              ? { ...ev, data: { ...ev.data, remote: { target: spec.target, repo: spec.repo } } }
              : ev,
          ),
      },
    };
  }

  /**
   * Keep watching a spawned agent; retire it once it is gone: at once on `done`/`failed`, and on
   * `reaped` (its LWT, which a network blip also fires) only after a grace period in which no
   * fresh status or heartbeat arrived — an assigned identity may reconnect (SPEC §6.5).
   */
  private supervise(
    wave: WaveId,
    task: string,
    role: Role,
    outcome: SpawnOutcome,
    lock: string,
    host: Host,
    tunnel?: string,
  ): void {
    const { agentId, watch } = outcome;
    if (!this.running) {
      void watch.close();
      return;
    }
    const a: Supervised = {
      wave,
      task,
      role,
      host,
      ...(tunnel !== undefined ? { tunnel } : {}),
      namespace: watch.namespace,
      watch,
      lockPath: lock,
      minted: outcome.minted,
      workspace: outcome.workspace,
      liveness: this.restoreSlots(
        wave,
        agentId,
        trackAgent({ agent_id: agentId, task, now: this.now() }),
      ),
    };
    this.supervised.set(agentId, a);
    // The hooks' activity signals (liveness) and heartbeats (reap re-verification).
    watch.onProgress((raw) => this.onAgentProgress(agentId, a, raw));
    const holdReaped = () => {
      const g = this.reapGrace(wave);
      a.pendingReap = holdReap(agentId, this.now(), g.ms, g.wake);
      this.scheduleReap(agentId, a);
    };
    this.trackScreen(agentId, a);
    const check = (type: string, live = true) => {
      if (this.supervised.get(agentId) !== a) return;
      // The watchdog checks the status gets handled. A `blocked` already retained when the watch
      // attached (a fast agent, every agent after a restart) is checked too: it must have a
      // decision. A `done` / `failed` retained at re-attach was handled, or is re-handled below
      // as the same claim (e.g. a head still held for CI), which journals nothing new.
      if (live || type === "blocked") this.noteTerminal(agentId, a);
      if (type === "reaped") {
        // A re-delivery (same wall_time) of a reap a heartbeat already suppressed changes nothing.
        if (a.watch.state.status?.wall_time === a.suppressedReap) return;
        a.suppressedReap = undefined;
        if (a.pendingReap === undefined) holdReaped();
        return;
      }
      this.time.clearTimeout(a.reapTimer);
      a.reapTimer = undefined;
      a.reapDeferred = false;
      a.pendingReap = undefined;
      a.suppressedReap = undefined;
      a.liveStatus = type;
      if (type === "blocked") {
        // Not final (SPEC §5.2: it may wait for mailbox guidance): the pipeline asks the owner.
        const at = a.watch.state.status?.wall_time;
        if (at !== undefined && at === a.blockedSeen) return;
        a.blockedSeen = at;
        a.blockedAt = this.now();
        void this.enqueue(() => this.onBlocked(agentId));
        return;
      }
      if (!FINAL_STATUS.has(type)) {
        // An agent already up when a steer was queued: its next working/idle status delivers it.
        if (live && (type === "working" || type === "idle"))
          void this.enqueue(() => this.deliverQueued(wave, task, role, agentId));
        return;
      }
      // A re-delivery (same wall_time) of a final status already handed over is not a new claim.
      const at = a.watch.state.status?.wall_time;
      if (at !== undefined && at === a.finalSeen) return;
      a.finalSeen = at;
      // A `done` is a claim: the pipeline checks it before the agent is retired (T6).
      void this.enqueue(() => this.onFinal(agentId, type));
    };
    watch.onStatus((type) => check(type));
    if (watch.state.status !== null) check(watch.state.status.type, false);
    if (outcome.kind === "registered")
      void this.enqueue(() => this.deliverQueued(wave, task, role, agentId));
  }

  /**
   * An agent whose hooks the broker refused: Escape in its session and a steering that says why,
   * so it stops before doing work it cannot deliver (the relaunch decision is already open).
   */
  private async pauseAuthFailed(agentId: string): Promise<void> {
    const a = this.supervised.get(agentId);
    if (a === undefined) return;
    try {
      await a.host.sendKeys(a.workspace, "Escape");
    } catch (e) {
      this.log(`pause ${agentId}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await this.steerAgent(agentId, a, AUTH_FAILED_PAUSE, { reason: "auth_failed" });
  }

  /**
   * Retire one of the wave's agents however it is held: a supervised one through `retire`, one
   * the daemon is not watching (gone before a restart, never verified) from its journaled spawn
   * — the same delete path (retireAgent), its lock released, its retained records cleared.
   */
  private async retireAny(
    wave: WaveId,
    agentId: string,
    status: string,
    credentials: AgentCredentials | undefined = this.credentials,
  ): Promise<void> {
    if (this.supervised.has(agentId)) return this.retire(agentId, status, credentials);
    const log = this.waves.get(wave);
    if (log === undefined) return;
    const events = log.journal.readAll();
    if (events.some((e) => e.type === "agent_retired" && e.data.agent_id === agentId)) return;
    const spawned = events.find((e) => e.type === "agent_spawned" && e.data.agent_id === agentId);
    if (spawned?.task === undefined) return;
    const d = spawned.data;
    const [host] = this.hostOfTask(wave, spawned.task);
    const title = `${wave} ${spawned.task} ${String(d.role)}`;
    await this.screens.untrack(agentId);
    await retireAgent(
      {
        wave,
        task: spawned.task,
        role: String(d.role),
        agentId,
        namespace: this.agentNamespace(wave, agentId),
        status,
        waveAgents: new Set(
          events.filter((e) => e.type === "agent_spawned").map((e) => e.data.agent_id as string),
        ),
        ...(typeof d.lock === "string" ? { lockPath: d.lock } : {}),
        minted: d.credentials === "minted",
        ...(typeof d.workspace === "string" ? { workspace: d.workspace } : {}),
        ...(typeof d.worktree === "string" ? { worktree: d.worktree } : {}),
      },
      {
        ...this.reapDeps((ev) => this.append(wave, ev), credentials),
        releaseLock: (path) => {
          try {
            unlinkSync(path);
          } catch {}
        },
        writeMarker: this.markerWriter(host),
        // A ref from the journal is closed only if it still names this agent's workspace;
        // otherwise the workspace is re-found by its title.
        endSession: this.sessionEnder(wave, agentId, host, {
          title,
          trusted: closableAfterRestart(
            typeof d.workspace === "string" ? d.workspace : "",
            sessionName(title),
          ),
        }),
      },
    );
  }

  /** Writes a retire's marker on the agent's host (retiredMarkerPath, SPEC §4.6.4). */
  private markerWriter(
    host: Host,
  ): (worktree: string, m: { agent_id: string; status: string }) => Promise<void> {
    return (worktree, m) =>
      host.writeFile(
        retiredMarkerPath(worktree),
        `${JSON.stringify({ ...m, at: dateOf(this.time).toISOString() })}\n`,
      );
  }

  /**
   * How a retire ends the agent's session: null when the wave keeps finished sessions open
   * (`retire_close_session: false`). `trusted`: the ref still names the agent's own workspace;
   * otherwise it is re-found by its `<wave> <task> <role>` title, and is left alone (only the
   * processes are stopped) when it cannot be. Nothing is done to a workspace or worktree another
   * of the wave's live agents now holds (a relaunch into the same worktree, under the same title).
   */
  private sessionEnder(
    wave: WaveId,
    agentId: string,
    host: Host,
    ref: { title: string; trusted: boolean },
  ): SessionEnder | null {
    if (!this.config.effective(wave).retire_close_session) return null;
    return async (workspace, worktree) => {
      const events = this.journalEvents(wave);
      const retired = new Set(
        events.filter((e) => e.type === "agent_retired").map((e) => e.data.agent_id as string),
      );
      const others = events.filter(
        (e) =>
          e.type === "agent_spawned" &&
          e.data.agent_id !== agentId &&
          !retired.has(e.data.agent_id as string),
      );
      const shared = worktree !== null && others.some((e) => e.data.worktree === worktree);
      let ws = workspace;
      if (ws !== null && !ref.trusted) {
        const found = shared ? null : await host.findWorkspace(ref.title).catch(() => null);
        ws = found !== null && !others.some((e) => e.data.workspace === found) ? found : null;
      }
      const end = await host.endSession(
        ws,
        shared ? null : worktree,
        mintConsentToken(`retire ${agentId}`),
      );
      return ws !== workspace ? { ...end, workspace: ws } : end;
    };
  }

  /** Capture a supervised agent's terminal (screen-publisher.ts): at spawn, and on resume. */
  private trackScreen(agentId: string, a: Supervised): void {
    this.screens.track({
      agentId,
      namespace: a.namespace,
      workspace: a.workspace,
      host: a.host,
      intervalS: () => this.config.effective(a.wave).screen_tail_interval_s,
    });
  }

  private async retire(
    agentId: string,
    status: string,
    credentials: AgentCredentials | undefined = this.credentials,
  ): Promise<void> {
    const a = this.supervised.get(agentId);
    const log = a !== undefined ? this.waves.get(a.wave) : undefined;
    if (a === undefined || log === undefined) return;
    this.supervised.delete(agentId);
    this.lastWokenAt.delete(agentId);
    this.wakeTyped.delete(agentId);
    for (const [id, w] of this.wakes) if (w.agent === agentId) this.disarmWake(id);
    this.time.clearTimeout(a.reapTimer);
    const terminal = a.watch.state.status?.payload;
    await a.watch.close();
    // Stop capturing first, so no in-flight capture re-publishes the screen after retire clears it.
    // Bounded: untrack waits only for a publish in flight, never for a (possibly hung) read.
    await this.screens.untrack(agentId);
    const resultRaw = await this.broker
      .queryRetained(buildTopic(a.namespace, agentId, "result"), DAEMON_DEFAULTS.probe_ms)
      .catch(() => null);
    const result =
      resultRaw !== null && resultRaw !== "" ? parseEnvelope(resultRaw)?.payload : undefined;
    const spawnedAll = log.journal.readAll().filter((e) => e.type === "agent_spawned");
    const waveAgents = new Set(spawnedAll.map((e) => e.data.agent_id as string));
    const worktree =
      a.worktree ?? spawnedAll.filter((e) => e.data.agent_id === agentId).at(-1)?.data.worktree;
    await retireAgent(
      {
        wave: a.wave,
        task: a.task,
        role: a.role,
        agentId,
        namespace: a.namespace,
        status,
        waveAgents,
        lockPath: a.lockPath,
        minted: a.minted,
        ...(terminal !== undefined ? { terminal } : {}),
        ...(result !== undefined ? { result } : {}),
        workspace: a.workspace,
        ...(typeof worktree === "string" ? { worktree } : {}),
      },
      {
        writeMarker: this.markerWriter(a.host),
        endSession: this.sessionEnder(a.wave, agentId, a.host, {
          title: `${a.wave} ${a.task} ${a.role}`,
          trusted:
            a.restored !== true ||
            closableAfterRestart(a.workspace, sessionName(`${a.wave} ${a.task} ${a.role}`)),
        }),
        ...this.reapDeps((ev) => this.append(a.wave, ev), credentials),
        releaseLock: (path) => {
          try {
            unlinkSync(path);
          } catch {}
        },
      },
    );
  }

  // -------------------------------------------------------------------------------------------
  // Pipeline (T6): every role's `done` is verified before the next stage; volleyd merges only under `merge: auto` (SPEC §4.6.17).
  // -------------------------------------------------------------------------------------------

  // -------------------------------------------------------------------------------------------
  // Self-healing CI (2), SPEC §4.6.16: a flake's fixer is a synthetic task of the wave; its merge
  // releases every task it blocked, and its failure goes back to the owner once.
  // -------------------------------------------------------------------------------------------

  /** An append that asks for, joins, lands or fails a flake's fixer: handled on the queue. */
  private noteRemediation(wave: WaveId, e: JournalEvent): void {
    const rec = this.waves.get(wave)?.record;
    if (rec === undefined || e.task === undefined) return;
    if (e.type === "remediation_requested") {
      const req = requestOf(e);
      if (req !== null) void this.enqueue(() => this.requestFixer(wave, req));
      return;
    }
    if (e.type === "decision_resolved" && isAnswer(String(e.data.answer ?? ""), FIX_FLAKE)) {
      // The owner's `fix flake` (or autopilot's): the fixer is requested, if it is not yet.
      const req = this.parkedRequest(rec, e.task, e.data.decision_id as string);
      if (req !== null) void this.enqueue(() => this.requestFixer(wave, req));
      return;
    }
    // A fixer closed failed can still land: the owner unblocks it and its fix merges after all.
    const fixer = rec.wave?.tasks[e.task];
    const outcome = fixer?.remediation?.outcome;
    if (fixer?.synthetic !== true || outcome === "landed") return;
    const id = fixer.id;
    if (e.type === "stage_entered" && e.data.stage === "done")
      void this.enqueue(() => this.closeFixer(wave, id, null));
    const why = outcome === undefined ? fixerFailure(e) : null;
    if (why !== null) void this.enqueue(() => this.closeFixer(wave, id, why));
  }

  /**
   * Level-triggered backstop for noteRemediation (a restart between a fixer's end and its
   * `remediation_closed`): every fixer that is done (and not closed landed) or cancelled (and not
   * closed) is closed.
   */
  private async settleFixers(wave: WaveId): Promise<void> {
    const rec = this.waves.get(wave)?.record;
    for (const f of rec !== undefined ? fixers(rec) : []) {
      const outcome = f.remediation?.outcome;
      const stage = rec?.state?.tasks.find((t) => t.id === f.id)?.stage;
      if (stage === "done" && outcome !== "landed") await this.closeFixer(wave, f.id, null);
      else if (stage === "cancelled" && outcome === undefined)
        await this.closeFixer(wave, f.id, "cancelled");
    }
  }

  /** The fix_flake request a task parked on a flake stands for (null: it is not parked on one). */
  private parkedRequest(rec: WaveRecord, task: TaskId, decisionId: string): FixRequest | null {
    const r = rec.pipeline[task]?.remediation;
    if (r === undefined || r.landed === true) return null;
    const urls = (rec.decisions[decisionId] as { run_urls?: unknown } | undefined)?.run_urls;
    return {
      task,
      test: r.test,
      test_file: r.test_file,
      run_urls: Array.isArray(urls) ? urls.filter((u): u is string => typeof u === "string") : [],
      head: r.head,
    };
  }

  /** What autopilot's `fix flake` would get for a red head's decision (undefined: not a flake). */
  private fixerVerdict(wave: WaveId, d: DecisionRecord): FixerVerdict | undefined {
    const rec = this.waves.get(wave)?.record;
    if (rec === undefined || d.task === null || !isRedHead(d)) return undefined;
    const req = this.parkedRequest(rec, d.task, d.decision_id);
    if (req === null) return undefined;
    return fixerFor(rec, req, this.config.get("autopilot.fix_flake_max", wave) as number);
  }

  /** A fix_flake request: add its fixer (and admit it), join one, or leave the red head to the owner. */
  private async requestFixer(wave: WaveId, req: FixRequest): Promise<void> {
    const rec = this.waves.get(wave)?.record;
    const stage = rec?.state?.tasks.find((t) => t.id === req.task)?.stage;
    if (rec === undefined || stage === undefined || stage === "done" || stage === "cancelled")
      return;
    const max = this.config.get("autopilot.fix_flake_max", wave) as number;
    const v = fixerFor(rec, req, max);
    if ("reuse" in v) {
      this.log(`${wave}/${req.task}: flake ${req.test} waits for its fixer ${v.reuse}`);
      return;
    }
    if ("add" in v) {
      await this.append(wave, v.add);
      this.log(`${wave}: added ${v.add.task} to fix the flake ${req.test} (for ${req.task})`);
      this.evaluate();
      await this.tickNow();
      return;
    }
    if ("over_budget" in v) {
      await this.escalateRedHead(
        wave,
        req.task,
        "budget_exhausted",
        v.over_budget,
        `No fixer for the flake ${req.test}: ${wave} has autopilot.fix_flake_max (${max}) fixers already.`,
      );
      return;
    }
    await this.escalateRedHead(
      wave,
      req.task,
      "unattended_safety",
      undefined,
      `No fixer for the flake ${req.test}: ${v.refuse}.`,
    );
  }

  /**
   * A fixer settled. Merged (`why` null): `remediation_closed` releases the tasks still parked on
   * its test; their open red-head decisions are resolved `fix landed`, and each takes the fix from
   * the release branch (pipeline `fix_landed`). Failed: `remediation_closed { outcome: failed }`
   * and each blocked task's red head goes back to the owner, escalated, once. A fixer closed failed
   * that merges after all is closed again, landed.
   */
  private async closeFixer(wave: WaveId, fixer: TaskId, why: string | null): Promise<void> {
    const rec = this.waves.get(wave)?.record;
    const r = rec?.wave?.tasks[fixer]?.remediation;
    if (rec === undefined || r === undefined || r.outcome === "landed") return;
    if (why !== null && r.outcome === "failed") return;
    const blocked = releasedBy(rec, fixer);
    const base = { kind: r.kind, test: r.test, task: fixer };
    if (why === null) {
      await this.append(wave, {
        type: "remediation_closed",
        task: fixer,
        data: { ...base, outcome: "landed", released: blocked },
      });
      this.log(
        `${wave}: ${fixer} landed the fix for ${r.test}; released ${blocked.join(", ") || "-"}`,
      );
      for (const task of blocked) {
        const now = this.waves.get(wave)?.record ?? rec;
        for (const d of openDecisions(now)) {
          if (d.task !== task || !isRedHead(d)) continue;
          await this.resolveNow(wave, d.decision_id, {
            answer: FIX_LANDED,
            by: DAEMON_AGENT_ID,
            rationale: `${fixer} merged the fix for ${r.test}`,
          });
        }
        if (this.opts.spawner !== undefined)
          void this.enqueue(() =>
            this.pipelineFor(wave).handle(task, { kind: "fix_landed", test: r.test }),
          );
      }
      return;
    }
    await this.append(wave, {
      type: "remediation_closed",
      task: fixer,
      data: { ...base, outcome: "failed", why, released: [] },
    });
    this.log(`${wave}: ${fixer} did not land the fix for ${r.test} (${why})`);
    const t = rec.state?.tasks.find((x) => x.id === fixer);
    const evidence = [
      ...(t?.pr !== undefined ? [`PR ${t.pr.url}`] : []),
      ...Object.values(t?.agents ?? {}).filter((a): a is string => a !== undefined),
    ];
    for (const task of blocked)
      await this.escalateRedHead(
        wave,
        task,
        "unattended_safety",
        undefined,
        `The flake's fixer ${fixer} did not land a fix for ${r.test} (${why}${evidence.length > 0 ? `; ${evidence.join(", ")}` : ""}).`,
        fixer,
      );
  }

  /**
   * Put a task's red head to the owner, escalated (`why`): its open ci_failed / agent_blocked_ci
   * decision is escalated, or, once answered (`fix flake`), asked again — `note` first, without
   * `fix flake` — and escalated. A decision escalated for the same reason already stays as it is.
   * A hold on `failed` (the fixer that just failed) is lifted first; any other hold stands, and the
   * decision is not escalated.
   */
  private async escalateRedHead(
    wave: WaveId,
    task: TaskId,
    why: EscalateWhy,
    budget: Budget | undefined,
    note: string,
    failed?: TaskId,
  ): Promise<void> {
    const rec = this.waves.get(wave)?.record;
    const d = Object.values(rec?.decisions ?? {})
      .filter((x) => x.task === task && isRedHead(x))
      .at(-1);
    if (rec === undefined || d === undefined) {
      this.log(`${wave}/${task}: ${note} (no red-head decision to escalate)`);
      return;
    }
    // Each append replaces the record: the decision is read back from the current one.
    const current = (id: string) => this.waves.get(wave)?.record.decisions[id] as DecisionRecord;
    // Held on the fixer that just failed (autoHolds): the hold is lifted, or the owner never sees it.
    // Held on anything else (the owner's hold): a held decision never escalates.
    if (d.resolved === undefined && d.held !== undefined) {
      if (failed === undefined || d.held.on.task !== failed) {
        this.log(`${wave}/${task}: ${note} (${d.decision_id} stays held, not escalated)`);
        return;
      }
      await this.releaseNow(wave, d.decision_id, `escalated: ${why}`, DAEMON_AGENT_ID, {
        rerun: false,
      });
    }
    if (d.resolved === undefined) {
      if (d.escalated?.why === why) return;
      // current(): releaseNow above replaced the record, and `d` still carries the lifted hold.
      await this.escalate(wave, current(d.decision_id), why, budget);
      await this.ringDecision(wave, current(d.decision_id));
      return;
    }
    const facts = Object.fromEntries(
      Object.entries(d).filter(([k]) => !DECISION_RECORD_KEYS.has(k)),
    );
    const again = await this.openDecisionNow(
      wave,
      {
        kind: d.kind,
        task,
        question: `${note} ${d.question}`,
        options: (d.options ?? []).filter((o) => !isAnswer(o, FIX_FLAKE)),
        pointers: d.pointers,
      },
      facts,
      false,
    );
    await this.openDecisionItem(wave, again);
    await this.escalate(wave, again, why, budget);
    await this.ringDecision(wave, current(again.decision_id));
  }

  /** GitHub's status page through `DaemonOptions.fetch`, cached; one reader for every wave. */
  private githubStatus(): () => Promise<GithubStatus> {
    this.statusPageRead ??= githubStatusCache(this.opts.fetch ?? globalThis.fetch, () =>
      this.now(),
    );
    return this.statusPageRead;
  }

  /** The pipeline driver of a wave, on this daemon's journal, spawner, steering and decisions. */
  private pipelineFor(wave: WaveId): PipelineDriver {
    let d = this.pipelines.get(wave);
    if (d !== undefined) return d;
    const log = this.waves.get(wave) as WaveLog;
    d = new PipelineDriver(wave, {
      exec: this.host.exec,
      // A task on a remote host (T15): its worktrees, and so its git / gh checks, are on the box.
      // The artifact probes fetch in worktrees of the task's clone: one fetch into it at a time.
      execFor: (task) => {
        const t = this.ranDef(log.record, task);
        if (t === undefined || t.host === "local" || this.autoHostReached(wave, t)) {
          const w = log.record.wave;
          return w == null
            ? this.host.exec
            : lockFetches(this.host.exec, LOCAL_HOST, expandHome(w.repo));
        }
        const remote = this.remoteHost(wave, t);
        // Keyed like spawn's fetches into the same clone (spawn.ts: `expandHome(req.wave.repo)`).
        return lockFetches(remote.exec, remote.name, expandHome(remote.spec.repo));
      },
      worktreeGone: (task, path) => worktreeGone(this.ranDef(log.record, task), path),
      home: this.opts.home,
      record: () => log.record,
      journal: (ev) => this.append(wave, ev),
      spawn: async (task, role, req) => this.pipelineSpawn(wave, task, role, req),
      branchUpdate: () => this.config.effective(wave).branch_update,
      hygiene: () => log.record.state?.hygiene_level ?? "p1",
      steer: (task, role, agentId, text, reason) =>
        this.deliverSteer(
          wave,
          task,
          {
            role,
            agent_id: agentId,
            namespace:
              this.supervised.get(agentId)?.namespace ??
              log.record.wave?.namespace ??
              this.opts.namespace,
          },
          text,
          DAEMON_AGENT_ID,
          randomUUID(),
          { reason },
        ),
      decide: (input, extra) => this.openDecisionNow(wave, input, extra),
      // A PR merged on GitHub settles every open question about its task (already on the queue).
      // resolveNow only enqueues the pipeline's decision_resolved, so it runs after the task is
      // done and onResolved returns [] for it: a superseded decision is never asked again.
      resolveOpen: async (task, answer, rationale) => {
        for (const d of openDecisions(log.record)) {
          if (d.task !== task) continue;
          await this.resolveNow(wave, d.decision_id, { answer, by: DAEMON_AGENT_ID, rationale });
        }
      },
      // --- Fleet merge nudge (SPEC §4.6.15): the wave's nudge_on_merge, read at each merge. ---
      nudgeOnMerge: () => this.config.get("placement.nudge_on_merge", wave) as NudgeOnMerge,
      // --- Autopilot merging (SPEC §4.6.17): the wave file's merge:, else autopilot.merge. ---
      mergeMode: () =>
        log.record.wave?.merge ?? (this.config.get("autopilot.merge", wave) as MergeMode),
      mergeRetryMax: () => this.config.get("autopilot.merge_retry_max", wave) as number,
      // --- Self-healing CI (SPEC §4.6.16): an infra incident's wait, GitHub's status page. ---
      incidentWaitMaxS: () => this.config.get("autopilot.incident_wait_max_s", wave) as number,
      ciRateLimitBackoffMs: () => this.config.get("ci_rate_limit_backoff_ms", wave) as number,
      statusPage: this.githubStatus(),
      deleteBranch: () => this.config.get("autopilot.delete_branch", wave) as boolean,
      releaseLock: releaseLockOn(this.releaseLocks),
      retire: (agentId, status) => this.retireRole(wave, agentId, status),
      nextAgent: (task, role) => {
        const attempt = this.agentAttempt(wave, task, role);
        return { agent_id: agentIdFor(wave, task, role, attempt), attempt };
      },
      // Checks fold back in on the queue; after a stop there is nothing left to fold them into.
      enqueue: async (fn) => {
        if (this.running) await this.enqueue(fn);
      },
      log: (line) => this.log(line),
      now: this.now,
    });
    this.pipelines.set(wave, d);
    return d;
  }

  /**
   * A supervised agent's final status. `failed` (and an accepted `reaped`) retires it at once and
   * tells the pipeline it failed; `done` goes to the pipeline, which verifies the claim (steering
   * the agent while it is still live) and retires it.
   */
  private async onFinal(agentId: string, type: string, why?: string): Promise<void> {
    const a = this.supervised.get(agentId);
    if (a === undefined || this.moving.has(agentId)) return;
    if (type !== "done") await this.retire(agentId, type);
    const raw = await this.broker
      .queryRetained(buildTopic(a.namespace, agentId, "result"), DAEMON_DEFAULTS.probe_ms)
      .catch(() => null);
    const result = raw !== null && raw !== "" ? parseEnvelope(raw)?.payload : undefined;
    if (a.task === RELEASE_TASK) {
      await this.releaseFor(a.wave).handle({
        kind: "agent_done",
        agent_id: agentId,
        status: type === "done" ? "done" : "failed",
        ...(result !== undefined ? { result } : {}),
        ...(why !== undefined ? { why } : {}),
      });
      return;
    }
    await this.pipelineFor(a.wave).handle(a.task, {
      kind: "agent_done",
      role: a.role,
      agent_id: agentId,
      status: type === "done" ? "done" : "failed",
      ...(result !== undefined ? { result } : {}),
      ...(why !== undefined ? { why } : {}),
    });
  }

  /**
   * A supervised agent's `blocked` status: the pipeline opens its `agent_blocked` decision. The
   * agent is not retired. A status a decision already names (a re-delivery after a restart) is
   * not asked about twice. Nothing is asked while the agent is moving (the sweep asks after).
   * Where the pipeline cannot own it (a settled task, a stale or accepted run, an error) the
   * daemon journals `blocked_unhandled` and asks itself (`blockedFallback`): never silent.
   */
  private async onBlocked(agentId: string): Promise<void> {
    const a = this.supervised.get(agentId);
    const status = a?.watch.state.status;
    if (a === undefined || status?.type !== "blocked") return;
    if (this.moving.has(agentId)) {
      // Not handed over: the sweep hands it over once the move ends. The sweep skips a moving
      // agent, so this reset is what makes it hand the status over then (not every tick now).
      a.blockedSeen = undefined;
      return;
    }
    if (this.blockedDecided(a.wave, agentId, status.wall_time)) return;
    if (a.task === RELEASE_TASK) {
      await this.releaseFor(a.wave).handle({
        kind: "agent_done",
        agent_id: agentId,
        status: "blocked",
        why: `blocked: ${blockedReason(status.payload)}`,
      });
      return;
    }
    const log = this.waves.get(a.wave);
    if (log === undefined) return;
    const stage = log.record.state?.tasks.find((t) => t.id === a.task)?.stage;
    if (stage === undefined || SETTLED_STAGES.has(stage))
      return this.blockedFallback(
        agentId,
        a,
        stage === undefined ? "the task is not in the wave" : `the task is ${stage}`,
      );
    const before = log.record.seq;
    try {
      await this.pipelineFor(a.wave).handle(a.task, {
        kind: "agent_blocked",
        role: a.role,
        agent_id: agentId,
        reason: blockedReason(status.payload),
        payload: status.payload,
        at: status.wall_time,
      });
    } catch (e) {
      return this.blockedFallback(
        agentId,
        a,
        `the pipeline failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (this.blockedDecided(a.wave, agentId, status.wall_time)) return;
    // The pipeline said why it asks nothing: the daemon asks. Otherwise (a red head being
    // classified first) the sweep asks if no decision comes within the window.
    // Newest first, only the events the pipeline appended (seq > before).
    const events = this.journalEvents(a.wave);
    let dropped: JournalEvent | undefined;
    for (let i = events.length - 1; i >= 0 && (events[i]?.seq ?? 0) > before; i--) {
      const e = events[i];
      if (
        e?.type === "alarm_raised" &&
        e.data.alarm === BLOCKED_ALARM &&
        e.data.agent_id === agentId
      ) {
        dropped = e;
        break;
      }
    }
    // A stale or accepted run: the role's current run is healthy, so the task is not parked.
    // A cancelled stage normally reaches blockedFallback before the pipeline is asked, so the
    // BLOCKED_TASK_CANCELLED check only matters when the stage changed mid-handle (defensive).
    if (dropped !== undefined)
      await this.blockedFallback(agentId, a, null, dropped.data.why !== BLOCKED_TASK_CANCELLED);
  }

  /** Whether any decision (open or answered) names the agent and its status `at` (status_at). */
  private blockedDecided(wave: WaveId, agentId: string, at: string): boolean {
    const rec = this.waves.get(wave)?.record;
    return Object.values(rec?.decisions ?? {}).some((d) => {
      const x = d as unknown as Record<string, unknown>;
      return x.agent_id === agentId && x.status_at === at;
    });
  }

  /**
   * The daemon's own `agent_blocked` for a block the pipeline cannot own: `respawn | cancel`, or
   * `manual | cancel` (not parking it) for a settled task or a `stale` agent (not the role's
   * current run, or one already accepted), whose cancel stops only the agent. `why` journals
   * `blocked_unhandled` first (null: the pipeline already did). Asked once per status.
   */
  private async blockedFallback(
    agentId: string,
    a: Supervised,
    why: string | null,
    stale = false,
  ): Promise<void> {
    const status = a.watch.state.status;
    if (status?.type !== "blocked" || a.blockedAsked === status.wall_time) return;
    if (this.blockedDecided(a.wave, agentId, status.wall_time)) return;
    // Recorded before the open: should the open throw (logged below), this status is not asked
    // again here; the liveness backstop (blocked_undecided_stall_ms) still raises it as a stall.
    a.blockedAsked = status.wall_time;
    const rec = this.waves.get(a.wave)?.record;
    const stage = rec?.state?.tasks.find((t) => t.id === a.task)?.stage;
    const reason = blockedReason(status.payload);
    if (why !== null) {
      this.log(`blocked_unhandled ${agentId}: ${why}`);
      await this.append(a.wave, {
        type: "alarm_raised",
        ...(stage !== undefined ? { task: a.task } : {}),
        data: {
          alarm: BLOCKED_ALARM,
          agent_id: agentId,
          role: a.role,
          why,
          status_at: status.wall_time,
        },
      });
    }
    const settled = stage === undefined || SETTLED_STAGES.has(stage);
    const keep = settled || stale;
    const respawn = !keep && this.opts.spawner !== undefined;
    const options = keep ? ["manual", "cancel"] : respawn ? ["respawn", "cancel"] : ["cancel"];
    const what = settled
      ? `manual: you handle it yourself; or cancel: stop the agent (the task stays ${stage ?? "as it is"})`
      : stale
        ? `manual: you handle it yourself; or cancel: stop this agent (the ${a.role}'s current run goes on)`
        : `${respawn ? `respawn: stop it and start the ${a.role} again; or ` : ""}cancel the task`;
    try {
      await this.openDecisionNow(
        a.wave,
        {
          kind: "agent_blocked",
          task: stage !== undefined ? a.task : null,
          id: waveDecisionId("agent_blocked", a.wave, agentId, status.wall_time),
          question: `Needs you: ${agentId} (${a.task}) is blocked: ${clipText(reason)}. ${what}?`,
          options,
          ...(keep && stage !== undefined ? { park: false } : {}),
        },
        {
          class: BLOCKED_CLASS,
          agent_id: agentId,
          role: a.role,
          reason,
          payload: status.payload,
          status_at: status.wall_time,
          ...(stage !== undefined ? { stage } : {}),
          minted: a.minted,
          ...(stale ? { stale: true } : {}),
        },
      );
    } catch (e) {
      this.log(`blocked ${agentId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * The invariant, every tick: a supervised agent whose retained status is `blocked` has a
   * decision naming it and that status. One never handed over is handed over now; one handed
   * over a `terminal_unjournaled_alarm_ms` ago with still no decision, the daemon asks itself.
   */
  private async blockedInvariant(): Promise<void> {
    const now = this.now();
    for (const [agentId, a] of [...this.supervised]) {
      const st = a.watch.state.status;
      if (st?.type !== "blocked" || a.task === RELEASE_TASK || this.moving.has(agentId)) continue;
      const state = this.waves.get(a.wave)?.record.state;
      if (state == null || state.status === "stopped") continue;
      if (this.blockedDecided(a.wave, agentId, st.wall_time)) continue;
      if (a.blockedSeen !== st.wall_time) {
        a.blockedSeen = st.wall_time;
        a.blockedAt = now;
        await this.onBlocked(agentId);
        continue;
      }
      // A red head still being classified: its decision is to come; the window starts after.
      if (this.pipelineFor(a.wave).classifying(a.task, agentId)) {
        a.blockedAt = now;
        continue;
      }
      const waited = now - (a.blockedAt ?? now);
      if (waited < DAEMON_DEFAULTS.terminal_unjournaled_alarm_ms) continue;
      await this.blockedFallback(
        agentId,
        a,
        `no decision ${Math.round(waited / 1000)}s after the status was handed to the pipeline`,
      );
    }
  }

  /** Arm the watchdog for the agent's current status if it is a new terminal one. */
  private noteTerminal(agentId: string, a: Supervised): void {
    const st = a.watch.state.status;
    if (st === null || !WATCHED_STATUS.has(st.type)) return;
    // Decided before this watch attached (a restart): handled already.
    if (st.type === "blocked" && this.blockedDecided(a.wave, agentId, st.wall_time)) return;
    const prev = this.terminals.get(agentId);
    if (prev !== undefined && prev.wall_time === st.wall_time) return;
    this.terminals.set(agentId, {
      wave: a.wave,
      agent_id: agentId,
      role: a.role,
      task: a.task,
      status: st.type,
      wall_time: st.wall_time,
      seen_at: this.now(),
      after_seq: this.waves.get(a.wave)?.record.seq ?? 0,
    });
  }

  /**
   * The terminal-status watchdog (watchdog.ts): a terminal status nothing was journaled about
   * within `terminal_unjournaled_alarm_ms` raises one alarm; the first event naming the agent
   * afterwards clears it.
   */
  private async watchTerminals(): Promise<void> {
    const seen = [...this.terminals.values()];
    for (const t of seen) {
      if (!journaledSince(t, this.lastNamed, this.lastDecided)) continue;
      this.terminals.delete(t.agent_id);
      const key = `${t.agent_id}@${t.wall_time}`;
      if (!this.terminalAlarmed.delete(key) || !this.waves.has(t.wave)) continue;
      await this.append(t.wave, {
        type: "alarm_cleared",
        task: t.task,
        data: { alarm: TERMINAL_ALARM, agent_id: t.agent_id, status: t.status },
      });
    }
    const late = unjournaledTerminals(
      [...this.terminals.values()],
      this.lastNamed,
      this.now(),
      DAEMON_DEFAULTS.terminal_unjournaled_alarm_ms,
      this.lastDecided,
    );
    for (const u of late) {
      const t = this.terminals.get(u.agent_id);
      const key = `${u.agent_id}@${u.since}`;
      if (t === undefined || this.terminalAlarmed.has(key)) continue;
      if (!this.waves.has(t.wave)) {
        // The wave is gone: nothing will ever journal it, so stop watching.
        this.terminals.delete(u.agent_id);
        continue;
      }
      this.terminalAlarmed.add(key);
      this.log(
        `watchdog: ${u.agent_id} ${u.status} unjournaled for ${Math.round((this.now() - t.seen_at) / 1000)}s`,
      );
      await this.append(t.wave, {
        type: "alarm_raised",
        task: u.task,
        data: { alarm: TERMINAL_ALARM, ...u },
      });
    }
  }

  /**
   * The wave's spawn budget holds a spawn (a task's next role, or a ready task's admission):
   * open one `spawn_budget_exhausted` decision (`raise by <n>` | `cancel`) unless one is open.
   * With a task it parks that task (its why_waiting names the decision); without, it is wave-level.
   */
  private async budgetExhausted(wave: WaveId, task: TaskId | null, role?: Role): Promise<void> {
    const log = this.waves.get(wave);
    const rec = log?.record;
    if (rec?.wave == null || rec.state?.status !== "running") return;
    if (openDecisions(rec).some((d) => d.kind === "spawn_budget_exhausted")) return;
    const eff = this.config.effective(wave);
    const budget = spawnBudget(rec.wave, eff.spawn_budget_multiplier, rec.budget_raised ?? 0);
    const used = spawnsUsed(rec);
    // A hold queued behind a raise that already covers it (the same tick's other held spawns).
    if (used < budget) return;
    // Sized for the wave, not this one spawn: one raise lets every held spawn through.
    const n = budgetRaise({
      outstanding: spawnsOutstanding(rec.wave, rec),
      derived: spawnBudget(rec.wave, eff.spawn_budget_multiplier, 0),
      used,
      raiseMax: eff.autopilot.budget_raise_max,
    });
    const what = task !== null ? `${task}'s ${role ?? "next role"}` : "the next ready task";
    const base = waveDecisionId("spawn_budget_exhausted", wave);
    let id = base;
    for (let k = 2; rec.decisions[id] !== undefined; k++) id = `${base}-${k}`;
    try {
      await this.openDecisionNow(
        wave,
        {
          kind: "spawn_budget_exhausted",
          task,
          id,
          question: `Needs you: wave ${wave}'s spawn budget is exhausted (${used}/${budget} spawns), so ${what} cannot start. raise by <n>: allow n more spawns; or cancel ${task !== null ? "the task" : "(stop the wave)"}?`,
          options: [`raise by ${n}`, "cancel"],
        },
        { used, budget, ...(role !== undefined ? { role } : {}) },
      );
    } catch (e) {
      this.log(`spawn budget ${wave}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * Retire a pipeline (or release stage) agent. Replaced or cancelled without having ended itself
   * (`relaunched`, `stopped`, or `superseded` by its PR's merge): its session is stopped first, so
   * it does nothing next to (or instead of) the new attempt.
   */
  private async retireRole(wave: WaveId, agentId: string, status?: string): Promise<void> {
    const a = this.supervised.get(agentId);
    if (
      a !== undefined &&
      (status === "relaunched" || status === "stopped" || status === "superseded")
    )
      await this.cancelAgent(
        wave,
        { task: a.task, role: a.role, agent_id: agentId },
        DAEMON_AGENT_ID,
        {
          text: `volleyd: ${agentId} is being ${status === "relaunched" ? "replaced by a relaunch" : status === "superseded" ? "stopped: its PR merged" : "stopped"}. Stop work now: do not push, open or merge anything further, and exit.`,
          from_agent_id: DAEMON_AGENT_ID,
          wave,
          task: a.task,
        },
      );
    await this.retireAny(wave, agentId, status ?? "done");
  }

  // -------------------------------------------------------------------------------------------
  // Release train stages (SPEC §4.6.19): one `release` agent per stage, serially; volleyd only
  // verifies (read-only) and writes the evidence. The interpreter is autopilot/release-train.ts.
  // -------------------------------------------------------------------------------------------

  /** The release train driver of a wave, on this daemon's journal, spawner, steering and decisions. */
  private releaseFor(wave: WaveId): ReleaseTrain {
    let d = this.releases.get(wave);
    if (d !== undefined) return d;
    const log = this.waves.get(wave) as WaveLog;
    d = new ReleaseTrain(wave, {
      // A stage is verified in a worktree of the wave's clone: its fetch takes the clone's lock.
      exec: (argv, opts) => {
        const repo = log.record.wave?.repo;
        if (repo == null) return this.host.exec(argv, opts);
        return lockFetches(this.host.exec, LOCAL_HOST, expandHome(repo))(argv, opts);
      },
      home: this.opts.home,
      view: () => {
        const st = log.record.state;
        if (st == null) return null;
        return releaseView({
          wave,
          release_branch: st.release_branch,
          status: st.status,
          train: st.release,
          events: log.journal.readAll(),
          decisions: log.record.decisions,
        });
      },
      journal: (ev) => this.append(wave, ev),
      // The interpreter's `attempt` is advisory: releaseSpawn recomputes it (agentAttempt counts
      // burned identities and relaunches too), and the agent's `-<n>` is that one.
      spawn: (stage) => this.releaseSpawn(wave, stage),
      steer: (agentId, text) =>
        this.deliverSteer(
          wave,
          RELEASE_TASK,
          {
            role: "release",
            agent_id: agentId,
            namespace:
              this.supervised.get(agentId)?.namespace ?? this.agentNamespace(wave, agentId),
          },
          text,
          DAEMON_AGENT_ID,
          randomUUID(),
          { reason: STAGE_STEER_REASON },
        ),
      decide: (input, extra) => this.openDecisionNow(wave, input, extra),
      retire: (agentId, status) => this.retireRole(wave, agentId, status),
      enqueue: async (fn) => {
        if (this.running) await this.enqueue(fn);
      },
      now: this.now,
      log: (line) => this.log(line),
    });
    this.releases.set(wave, d);
    return d;
  }

  /** Level-triggered: a releasing wave's train enters its next stage, or retries a held spawn. */
  private async releaseAdvance(wave: WaveId): Promise<void> {
    if (this.opts.spawner === undefined) return;
    if (this.waves.get(wave)?.record.state?.status !== "releasing") return;
    try {
      await this.releaseFor(wave).handle({ kind: "advance" });
    } catch (e) {
      this.log(`release ${wave}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * What the hard ceiling counts (SPEC §4.6.4): the agents volleyd runs or is starting, in every
   * wave and on every machine — supervised, launched and being verified, spawning (a release
   * stage's agent too) — and one slot for each admitted task of a running wave that will spawn
   * its next agent: queued for its implementer (backed off too; not once refused for good), or
   * between roles in implement…fixup with a role still to come (`nextRoleComes`). A task's stage
   * counts nothing by itself otherwise: a task awaiting a decision, blocked, or in a paused,
   * stopped or ended wave holds a slot only while one of its agents is live. `launching` is the
   * part not supervised yet, held slots included. `held: false` counts only the agents running
   * or starting, no held slot: what a spawn checks (`spawnAdmitted`, a pipeline role's, a
   * release stage's), so tasks holding more slots than the ceiling never hold each other's
   * spawns. A parallel step holds one slot while it waits, though it runs an agent per role.
   */
  private ceilingCount(held = true): CeilingCount {
    const byWave: Record<string, number> = {};
    const add = (wave: WaveId) => {
      byWave[wave] = (byWave[wave] ?? 0) + 1;
    };
    const launched = new Set<string>();
    const liveTasks = new Set<string>();
    let launching = 0;
    const seen = (key: string) => liveTasks.add(key.slice(0, key.lastIndexOf("/")));
    for (const a of this.supervised.values()) {
      add(a.wave);
      seen(`${a.wave}/${a.task}/${a.role}`);
    }
    for (const a of this.launching.values()) {
      add(a.wave);
      launching++;
      launched.add(`${a.wave}/${a.task}/${a.role}`);
      seen(`${a.wave}/${a.task}/${a.role}`);
    }
    // A spawn's key is in `spawning` until its launch half returns, after it joined `launching`
    // (it leaves `spawning` before it can be supervised). A relaunch's spawn counts beside the
    // role's old agent while that one is still supervised.
    for (const key of this.spawning) {
      if (launched.has(key)) continue;
      seen(key);
      add(key.split("/")[0] ?? "");
      launching++;
    }
    for (const [wave, log] of held ? this.waves : []) {
      const rec = log.record;
      if (rec.state?.status !== "running") continue;
      const tasks = new Map(rec.state.tasks.map((x) => [x.id, x]));
      for (const id of rec.admitted) {
        const t = tasks.get(id);
        if (t === undefined || liveTasks.has(`${wave}/${id}`)) continue;
        if (awaitsImplementer(t)) {
          if (this.refused.get(`${wave}/${id}/implementer`)?.until === Number.POSITIVE_INFINITY)
            continue;
          add(wave);
          launching++;
        } else if (BETWEEN_ROLES.has(t.stage) && this.nextRoleComes(wave, id, rec.pipeline[id])) {
          add(wave);
          launching++;
        }
      }
    }
    const live = Object.values(byWave).reduce((a, b) => a + b, 0);
    return { live, launching, by_wave: byWave };
  }

  /**
   * A task between roles will spawn an agent of its current step: no role of it is refused for
   * good, and none retired unverified (a dead agent) unless its respawn is on its way. A step whose
   * roles are all accepted (implemented, waiting on CI before its reviewers) holds its slot for
   * the whole wait; it reads as `launching` and gates admission only, never a role's spawn.
   */
  private nextRoleComes(wave: WaveId, task: TaskId, p: TaskPipeline | undefined): boolean {
    if (p === undefined) return true;
    const respawning = this.heldRespawn.has(`${wave}/${task}`);
    return p.roles.every((role) => {
      const until = this.refused.get(`${wave}/${task}/${role}`)?.until;
      if (until === Number.POSITIVE_INFINITY) return false;
      const run = p.runs[role];
      return (
        run?.retired === undefined || // not run yet, or its agent still live
        run.accepted || // its agent finished and was accepted
        until !== undefined || // a backed-off respawn of this role is pending
        respawning // a held respawn will re-place the dead agent
      );
    });
  }

  /** The hard ceiling's count against its global limit (the admission topic, `volleyd admission`). */
  private ceilingView(): CeilingView {
    return { ...this.ceilingCount(), max: this.config.effective().hard_ceiling };
  }

  /**
   * A release stage's spawn, through the same lock, launch and verification as any role's, while
   * the wave is releasing, under the kill switch, T5's pressure verdict and the hard ceiling (a
   * stage agent counts like a task). Not the spawn budget: a stage runs again only on the
   * owner's `respawn`. A hold is silent: the next tick asks again.
   */
  private releaseSpawn(wave: WaveId, stage: PlaybookStage): void {
    const rec = this.waves.get(wave)?.record;
    if (this.opts.spawner === undefined || rec?.wave == null || rec.state == null) return;
    const key = `${wave}/${RELEASE_TASK}/release`;
    if (this.spawning.has(key) || (this.refused.get(key)?.until ?? 0) > this.now()) return;
    if (this.taskLive(wave, RELEASE_TASK)) return;
    const live = this.ceilingCount(false).live;
    const max = this.config.effective(wave).hard_ceiling;
    const pressure = this.pressure(wave);
    const hold = this.killSwitch
      ? "kill switch engaged"
      : rec.state.status !== "releasing"
        ? "wave not releasing"
        : pressure.allow < 1
          ? `admission closed: ${(pressure.reasons ?? []).join(", ") || "no capacity"}`
          : live >= max
            ? `hard ceiling reached (${live}/${max})`
            : null;
    if (hold !== null) {
      this.log(`spawn ${key} (${stage.name}): held, ${hold}`);
      return;
    }
    const attempt = this.agentAttempt(wave, RELEASE_TASK, "release", stage.name);
    const files = {
      "stage.md": renderStageMd(stage, {
        wave,
        release_branch: rec.state.release_branch,
        attempt,
      }),
    };
    void this.startSpawn(wave, RELEASE_TASK, "release", { stage, files }).catch((e: unknown) => {
      this.log(`spawn ${key} (${stage.name}): ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  /**
   * A pipeline role spawn, through the same lock, launch and verification as the implementer's,
   * under T5's admission verdict, within the wave's spawn budget and only while the wave runs. A
   * hold is silent: the pipeline's next tick asks again.
   */
  private pipelineSpawn(
    wave: WaveId,
    task: TaskId,
    role: Role,
    req: { start?: SpawnStart; files: Record<string, string>; branch_update?: "merge" },
  ): void {
    const rec = this.waves.get(wave)?.record;
    if (this.opts.spawner === undefined || rec?.wave == null) return;
    const key = `${wave}/${task}/${role}`;
    if (this.spawning.has(key) || (this.refused.get(key)?.until ?? 0) > this.now()) return;
    // Its machine takes no new agents: parked until the owner's re-place answer (silent too).
    if (this.parkClosed(wave, task)) return;
    const admission = admissionFor(rec, this.killSwitch, this.pressure(wave));
    const hold = roleSpawnHold({
      killSwitch: this.killSwitch,
      running: rec.state?.status === "running",
      admission: admission.allow,
      reasons: admission.reasons,
      live: this.ceilingCount(false).live,
      ceiling: this.config.effective(wave).hard_ceiling,
      used: spawnsUsed(rec),
      budget: spawnBudget(
        rec.wave,
        this.config.effective(wave).spawn_budget_multiplier,
        rec.budget_raised ?? 0,
      ),
    });
    if (hold !== null) {
      this.log(`spawn ${key}: held, ${hold}`);
      // The budget is the one hold that never lifts by itself: ask the owner.
      if (hold.startsWith("spawn budget exhausted"))
        void this.enqueue(() => this.budgetExhausted(wave, task, role));
      return;
    }
    void this.startSpawn(wave, task, role, req).catch((e: unknown) => {
      this.log(`spawn ${key}: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Recovery (T8): hook-signal liveness, approval-gated model switch, sleep/wake, reconciliation.
  // The decisions live in liveness.ts / recovery.ts / clock.ts / reconcile.ts (pure); this is
  // where their actions meet the broker, the journal and the host.
  // -------------------------------------------------------------------------------------------

  /** Re-link the agent's open liveness decisions (after a restart) to its liveness slots. */
  private restoreSlots(wave: WaveId, agentId: string, fresh: AgentLiveness): AgentLiveness {
    let s = fresh;
    const rec = this.waves.get(wave)?.record;
    if (rec === undefined) return s;
    for (const d of openDecisions(rec)) {
      const x = d as unknown as Record<string, unknown>;
      const slot = typeof x.class === "string" ? SLOT_OF[x.class] : undefined;
      if (x.agent_id === agentId && slot !== undefined) s = noteDecision(s, slot, d.decision_id);
    }
    return s;
  }

  /**
   * The reap grace that applies now: the normal one, at least `wake_grace_s` right after a wake.
   * A wake never shortens it: the LWT flood a sleep causes is exactly what must not be rushed.
   */
  private reapGrace(wave: WaveId): { ms: number; wake: boolean } {
    const eff = this.config.effective(wave);
    const ms = this.opts.spawner?.reapGraceMs ?? secondsMs(eff.heartbeat_alarm_s);
    if (inWakeGrace(this.clock, this.wallNow(), eff.wake_grace_s))
      return { ms: Math.max(secondsMs(eff.wake_grace_s), ms), wake: true };
    return { ms, wake: false };
  }

  private wallNow(): number {
    return this.now();
  }

  /** (Re-)arm the timer that accepts a pending reap unless a heartbeat moved it. */
  private scheduleReap(agentId: string, a: Supervised): void {
    this.time.clearTimeout(a.reapTimer);
    const p = a.pendingReap;
    if (p === undefined) return;
    a.reapTimer = this.time.setTimeout(
      () => {
        a.reapTimer = undefined;
        if (!this.acceptReap(agentId, a)) this.scheduleReap(agentId, a);
      },
      Math.max(0, p.until - this.now()),
    );
  }

  /** Retire the agent if its pending reap is due (the timer, and every monitor tick, ask). */
  private acceptReap(agentId: string, a: Supervised): boolean {
    const pending = a.pendingReap;
    if (this.supervised.get(agentId) !== a || pending === undefined) return true;
    if (a.watch.state.status?.type !== "reaped") return true;
    if (reapVerdict(pending, this.now()) !== "accept") return false;
    // A remote agent cut off by its tunnel is still working on the box: no heartbeat can arrive
    // until the tunnel is back, so its reap is held for another grace while it is down.
    if (a.tunnel !== undefined && this.tunnelChecks.status(a.tunnel) !== "up") {
      if (a.reapDeferred !== true) {
        a.reapDeferred = true;
        void this.enqueue(() =>
          this.append(a.wave, {
            type: "alarm_raised",
            task: a.task,
            data: {
              code: "REAP_DEFERRED",
              message: `${agentId} lost its broker connection while its tunnel is down: not retired until the tunnel is back`,
              agent_id: agentId,
              forward: a.tunnel,
            },
          }),
        );
      }
      a.pendingReap = { ...pending, until: this.now() + this.reapGrace(a.wave).ms };
      return false;
    }
    this.time.clearTimeout(a.reapTimer);
    a.reapTimer = undefined;
    a.pendingReap = undefined;
    // Through the pipeline, like `failed`: a reaped role opens its respawn / cancel decision.
    void this.enqueue(() => this.onFinal(agentId, "reaped"));
    return true;
  }

  /** A message on a supervised agent's progress channel. */
  private onAgentProgress(agentId: string, a: Supervised, raw: string): void {
    if (this.supervised.get(agentId) !== a || raw === "") return;
    const env = parseEnvelope(raw);
    if (env === null || env.agent_id !== agentId) return;
    const now = this.now();
    const sig = parseHookSignal(raw, now);
    // A heartbeat after the LWT: the session is alive (its MCP server may be reconnecting). The
    // reap is dropped for good; the agent's next status (or the liveness silence path) decides.
    const p = a.pendingReap;
    if (p !== undefined && (sig !== null || env.type === "heartbeat")) {
      if (heartbeatSuppresses(p, now)) {
        this.time.clearTimeout(a.reapTimer);
        a.reapTimer = undefined;
        a.pendingReap = undefined;
        a.suppressedReap = a.watch.state.status?.wall_time;
        a.reapDeferred = false;
        void this.enqueue(() =>
          this.append(a.wave, {
            type: "reap_suppressed",
            task: a.task,
            data: {
              agent_id: agentId,
              reaped_at: new Date(p.reaped_at).toISOString(),
              heartbeat_at: new Date(now).toISOString(),
              wake: p.wake,
            },
          }),
        );
      }
    }
    if (sig === null) return;
    void this.enqueue(async () => {
      if (this.supervised.get(agentId) !== a) return;
      await this.applyLiveness(agentId, a, observeSignal(a.liveness, sig));
      // Out of idle, the prompt was submitted or cleared: no wake line is left typed.
      if (a.liveness.activity !== "idle") this.wakeTyped.delete(agentId);
      // An agent already up when a steer was queued (no registration will deliver it): its next
      // hook signal does.
      if (this.supervised.get(agentId) === a)
        await this.deliverQueued(a.wave, a.task, a.role, agentId);
    });
  }

  /** The monitor half of a tick: sleep/wake, then every supervised agent's liveness. */
  private async monitor(): Promise<void> {
    const r = sampleClock(this.clock, sampleOf(this.time));
    this.clock = r.state;
    const now = this.now();
    if (r.wake !== null) {
      this.log(`wake detected: the wall clock jumped ${Math.round(r.wake.jump_ms / 1000)} s`);
      for (const a of this.supervised.values()) a.liveness = rebase(a.liveness, now);
      await this.appendSystem({
        type: "wake_detected",
        data: { jump_ms: r.wake.jump_ms, at: new Date(r.wake.at).toISOString() },
      });
    }
    for (const [agentId, a] of [...this.supervised]) {
      if (a.pendingReap !== undefined) {
        this.acceptReap(agentId, a);
        continue;
      }
      const eff = this.config.effective(a.wave);
      if (inWakeGrace(this.clock, this.wallNow(), eff.wake_grace_s)) continue;
      // A stopped wave's agents were cancelled: never nudge them back to work.
      const state = this.waves.get(a.wave)?.record.state;
      const stage = state?.tasks.find((t) => t.id === a.task)?.stage;
      if (this.killSwitch || state?.status === "stopped" || stage === "cancelled") continue;
      // A suppressed reap leaves the retained status at `reaped` (only the agent may change it):
      // liveness goes on from the status before it, so silence still raises its alarms.
      const retained = a.watch.state.status;
      const status =
        retained?.type === "reaped" && retained.wall_time === a.suppressedReap
          ? (a.liveStatus ?? "working")
          : (retained?.type ?? null);
      // Only an agent that can stall needs evidence: a finished one's worktree is never walked.
      const evidence =
        a.liveness.activity === "idle" && stallable(status)
          ? await this.evidence(a, now)
          : undefined;
      if (this.supervised.get(agentId) !== a) continue; // retired during the worktree walk
      // Blocked: since when no decision names it (an undecided block is a stall). One open, or
      // one answered for this very status (`manual` leaves it blocked), is a decision. Under a
      // suppressed reap that status is the `blocked` before the `reaped`, not the retained one.
      const blockedAt = this.blockedAt(a);
      if (status !== "blocked") a.undecidedSince = undefined;
      else if (
        this.openNaming(a.wave, agentId) ||
        (blockedAt !== undefined && this.blockedDecided(a.wave, agentId, blockedAt))
      )
        a.undecidedSince = undefined;
      else a.undecidedSince ??= now;
      await this.applyLiveness(
        agentId,
        a,
        checkLiveness(a.liveness, {
          now,
          status,
          tunables: eff,
          ...(evidence !== undefined ? { evidence } : {}),
          ...(status === "blocked" ? { undecided_since: a.undecidedSince ?? null } : {}),
        }),
      );
    }
  }

  /**
   * The wall_time of the blocked status liveness judges: the retained one, or under a suppressed
   * reap the `blocked` before the `reaped`.
   */
  private blockedAt(a: Supervised): string | undefined {
    const retained = a.watch.state.status;
    return retained?.type === "blocked" ? retained.wall_time : a.blockedSeen;
  }

  /** Whether an open decision of the wave names the agent. */
  private openNaming(wave: WaveId, agentId: string): boolean {
    const rec = this.waves.get(wave)?.record;
    return (rec !== undefined ? openDecisions(rec) : []).some(
      (d) => (d as unknown as Record<string, unknown>).agent_id === agentId,
    );
  }

  /**
   * What an idle agent shows of its own work (activity-evidence.ts): the hooks' flag, a lease it
   * holds or waits on, the running shells its terminal footer counts, and, only when none of
   * those says so, the newest write under its worktree (a local agent's only).
   */
  private async evidence(a: Supervised, now: number): Promise<ActivityEvidence> {
    const id = a.liveness.agent_id;
    const mine = (l: { holder: string }) => l.holder === id;
    const held = Object.entries(this.leases).find(([, p]) => p.held.some(mine))?.[0];
    const queued = Object.entries(this.leases).find(([, p]) => p.queue.some(mine))?.[0];
    const pool = held ?? queued;
    const e: ActivityEvidence = {
      background_wait: a.liveness.background_wait,
      lease_held: pool !== undefined,
      ...(pool !== undefined ? { lease_pool: pool } : {}),
      ...(held === undefined && queued !== undefined ? { lease_queued: true } : {}),
      shells_running: a.shellsRunning ?? null,
      worktree_write_at: null,
    };
    if (e.background_wait !== null || e.lease_held || (e.shells_running ?? 0) > 0) return e;
    if (a.host.name !== "local") return e;
    const eff = this.config.effective(a.wave);
    // Past background_wait_max_s of idle no evidence counts (ownWorkReason): skip the walk.
    if (now - a.liveness.activity_at >= secondsMs(eff.background_wait_max_s)) return e;
    if (a.worktree === undefined) {
      const spawned = this.journalEvents(a.wave)
        .reverse()
        .find((ev) => ev.type === "agent_spawned" && ev.data.agent_id === id);
      a.worktree = typeof spawned?.data.worktree === "string" ? spawned.data.worktree : null;
    }
    const worktree = a.worktree;
    if (worktree === null) return e;
    e.worktree_write_at = await newestWrite(worktree, {
      now,
      freshMs: secondsMs(eff.idle_grace_s),
      maxEntries: DAEMON_DEFAULTS.worktree_scan_max_entries,
    });
    return e;
  }

  /** Adopt a liveness step and carry out its actions (inside the serial queue). */
  private async applyLiveness(agentId: string, a: Supervised, step: Step): Promise<void> {
    const before = whyWaiting(a.liveness, this.now());
    a.liveness = step.state;
    for (const action of step.actions) {
      try {
        await this.livenessAction(agentId, a, action);
      } catch (e) {
        this.log(
          `recovery ${agentId} ${action.kind}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    if (whyWaiting(a.liveness, this.now()) !== before) await this.publishState(a.wave);
  }

  private async livenessAction(agentId: string, a: Supervised, x: LivenessAction): Promise<void> {
    const { wave, task } = a;
    const note = (slot: DecisionSlot, id: string | null) => {
      a.liveness = noteDecision(a.liveness, slot, id);
    };
    const open = async (
      slot: DecisionSlot,
      input: DecisionInput,
      data: Record<string, unknown>,
    ): Promise<void> => {
      try {
        const d = await this.openDecisionNow(wave, input, { agent_id: agentId, ...data });
        note(slot, d.decision_id);
        // Answered by autopilot before the slot was noted: free it as onRecoveryResolved would.
        if (d.resolved !== undefined)
          a.liveness = noteResolved(a.liveness, d.decision_id, this.now());
      } catch (e) {
        note(slot, null);
        throw e;
      }
    };
    switch (x.kind) {
      case "agent_question":
        return open(
          "question",
          {
            kind: "agent_question",
            task,
            question: `Needs you: ${agentId} asks: ${clipText(x.question)}`,
            pointers: {
              screen: buildTopic(a.namespace, agentId, "screen"),
              ...(x.transcript !== undefined ? { transcript: x.transcript } : {}),
            },
          },
          {
            class: "agent_question",
            notification_type: x.notification_type,
            ...(x.last_text !== null ? { last_text: x.last_text } : {}),
          },
        );
      case "steer":
        return this.steerAgent(agentId, a, x.text, { reason: "idle" });
      case "agent_stalled": {
        // A respawn is the pipeline's (its relaunch): offered where a pipeline spawns the role.
        const respawn = this.opts.spawner !== undefined;
        const attempt = this.spawnedRecord((e) => e.data.agent_id === agentId, wave)?.attempt;
        const said = x.last_text !== null ? ` Last message: ${clipText(x.last_text)}` : "";
        const mins = Math.floor(x.idle_s / 60);
        // A blocked agent nobody was asked about: respawn or stop (no nudge: it is waiting).
        const blockedAsk = {
          question: `Needs you: ${agentId} is blocked and nobody has been asked about it for ${mins} min.${said} ${respawn ? `respawn: stop it and start the ${a.role} again; or ` : ""}stop the task?`,
          options: respawn ? ["respawn", STOP_ANSWER] : [STOP_ANSWER],
        };
        const idleAsk = {
          question: `Needs you: ${agentId} ended its turn without publishing done/blocked/failed and is still idle ${mins} min later, after a nudge.${said} Answer to steer it${respawn ? `, respawn: stop it and start the ${a.role} again (${a.role === "implementer" ? "on the branch it pushed" : "from the head, with the same inputs"})` : ""}, or stop the task.${x.asked > 1 ? ` (Asked ${x.asked} times; next in ${Math.round(x.next_s / 60)} min.)` : ""}`,
          options: respawn ? ["nudge again", "respawn", STOP_ANSWER] : ["nudge again", STOP_ANSWER],
        };
        return open(
          "stalled",
          {
            kind: "agent_stalled",
            task,
            ...(x.blocked === true ? blockedAsk : idleAsk),
            pointers: { screen: buildTopic(a.namespace, agentId, "screen") },
          },
          {
            class: "agent_stalled",
            idle_s: x.idle_s,
            asked: x.asked,
            // A block's stall names its status: answered (a steer leaves it blocked), it is decided.
            ...(x.blocked === true && this.blockedAt(a) !== undefined
              ? { status_at: this.blockedAt(a) }
              : {}),
            ...(respawn
              ? {
                  pipeline: {
                    on: "liveness",
                    role: a.role,
                    agent_id: agentId,
                    ...(typeof attempt === "number" ? { attempt } : {}),
                  },
                }
              : {}),
          },
        );
      }
      case "credit_exhausted": {
        const now = this.now();
        const allowed = recoveryAllowed(creditOccurrences(this.journalEvents(wave), agentId, now));
        const screen =
          x.screen !== undefined ? this.saveCapture(wave, agentId, x.screen) : undefined;
        const m = modelSwitchInput({
          task,
          agent_id: agentId,
          fallback_model: this.config.effective(wave).fallback_model,
          allowed,
          source: x.source,
          text: x.text,
          ...(screen !== undefined ? { screen } : {}),
        });
        return open("credit", m.input, m.data);
      }
      case "read_screen":
        void this.probeScreen(agentId, a);
        return;
      case "hooks_silent":
      case "screen_static": {
        const screen = this.saveCapture(wave, agentId, x.screen);
        const min = Math.floor(x.silent_s / 60);
        return open(
          "silent",
          {
            kind: "unknown_screen",
            task,
            question:
              x.kind === "hooks_silent"
                ? `Needs you: no hook signal from ${agentId} for ${min} min while its screen keeps changing: hooks may be broken by a harness update.${lastOutputNote(lastOutput(x.screen), false)} Look at its terminal?`
                : `Needs you: no hook signal from ${agentId} for ${min} min and its screen is not changing.${lastOutputNote(lastOutput(x.screen), false)} Look at its terminal?`,
            options: ["keep running", STOP_ANSWER],
            pointers: { screen },
          },
          { class: x.kind, silent_s: x.silent_s },
        );
      }
      case "crash_candidate":
        // Never killed on a missing pane or process: the LWT (or the agent) has the last word.
        await this.append(wave, {
          type: "alarm_raised",
          task,
          data: { alarm: "crash_candidate", agent_id: agentId, silent_s: x.silent_s },
        });
        return;
      case "close": {
        const d = this.waves.get(wave)?.record.decisions[x.decision_id];
        if (d === undefined || d.resolved !== undefined) return;
        await this.resolveNow(wave, x.decision_id, { answer: x.answer, by: agentId });
        return;
      }
    }
  }

  /** One silence probe: a bounded screen read beside the queue, folded back in through it. */
  private async probeScreen(agentId: string, a: Supervised): Promise<void> {
    const screen = await this.readScreenBounded(a.workspace, a.host);
    await this.enqueue(async () => {
      if (this.supervised.get(agentId) !== a) return;
      await this.applyLiveness(agentId, a, observeScreen(a.liveness, { now: this.now(), screen }));
    });
  }

  private readScreenBounded(workspace: string, host: Host = this.host): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = this.time.setTimeout(
        () => resolve(null),
        DAEMON_DEFAULTS.screen_read_timeout_ms,
      );
      host.readScreen(workspace, DAEMON_DEFAULTS.screen_lines).then(
        (s) => {
          this.time.clearTimeout(timer);
          resolve(s);
        },
        () => {
          this.time.clearTimeout(timer);
          resolve(null);
        },
      );
    });
  }

  /** `<home>/waves/<wave>/screens/<agent>-<time>.txt`, the evidence a decision points at. */
  private saveCapture(wave: WaveId, agentId: string, screen: string): string {
    const dir = join(this.opts.home, "waves", wave, "screens");
    mkdirSync(dir, { recursive: true });
    const path = join(
      dir,
      `${agentId}-${new Date(this.now()).toISOString().replace(/[:.]/g, "-")}.txt`,
    );
    writeFileSync(path, screen);
    return path;
  }

  /** Steer one supervised agent as volleyd (its acks are tracked like any steer's). */
  private async steerAgent(
    agentId: string,
    a: Supervised,
    text: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    const messageId = randomUUID();
    const heard = this.acks.wait(messageId, agentId, DAEMON_DEFAULTS.steer_wait_ack_ms);
    await this.deliverSteer(
      a.wave,
      a.task,
      { role: a.role, agent_id: agentId, namespace: a.namespace },
      text,
      DAEMON_AGENT_ID,
      messageId,
      extra,
    );
    void heard.then(({ acked, received }) =>
      this.log(
        `steer ${messageId} to ${agentId}: ${acked ? "acked" : received ? "received" : "delivered"}`,
      ),
    );
  }

  /** Where an agent's channels live: where it was spawned (its wave's `namespace:`), else ours. */
  private agentNamespace(wave: WaveId, agentId: string): string {
    return (
      this.supervised.get(agentId)?.namespace ??
      this.waves.get(wave)?.record.wave?.namespace ??
      this.opts.namespace
    );
  }

  /** Stop one task on the owner's answer: cancel its agent, interrupt it, journal the cancel. */
  private async cancelTask(
    wave: WaveId,
    task: TaskId,
    agentId: string,
    why: string,
  ): Promise<void> {
    const a = this.supervised.get(agentId);
    const messageId = randomUUID();
    await this.publish(
      buildTopic(this.agentNamespace(wave, agentId), agentId, "mailbox"),
      this.envelope(
        "mailbox",
        "cancel",
        {
          text: `volleyd: ${why}. Stop work on ${task} now: do not push, open or merge anything further, publish your terminal status and exit.`,
          from_agent_id: DAEMON_AGENT_ID,
          wave,
          task,
        },
        messageId,
      ),
      false,
    );
    await this.append(wave, {
      type: "steering_sent",
      task,
      data: {
        agent_id: agentId,
        role: a?.role,
        type: "cancel",
        message_id: messageId,
        by: DAEMON_AGENT_ID,
      },
    });
    await this.interruptAgent(agentId).catch((e: unknown) => {
      this.log(`interrupt ${agentId} failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    await this.append(wave, { type: "task_cancelled", task, data: { by: DAEMON_AGENT_ID, why } });
  }

  /**
   * A recovery decision was resolved: free the agent's liveness slot, then act on the answer.
   * The agent closing its own decision (`resumed`) needs nothing more. A question's answer is
   * steered to the agent; `stop task` cancels it; a model switch is only typed here, on approval.
   * A release stage agent's decision is wave-level (no task): answered the same, except that
   * stopping or respawning it is the train's (the stage fails, or runs again).
   */
  private async onRecoveryResolved(wave: WaveId, d: DecisionRecord): Promise<void> {
    const x = d as unknown as Record<string, unknown>;
    const agentId = typeof x.agent_id === "string" ? x.agent_id : undefined;
    const cls = typeof x.class === "string" ? x.class : undefined;
    const a = agentId !== undefined ? this.supervised.get(agentId) : undefined;
    const task = d.task ?? (a?.task === RELEASE_TASK || x.role === "release" ? RELEASE_TASK : null);
    if (agentId === undefined || cls === undefined || d.resolved === undefined) return;
    if (task === null) {
      // The daemon's agent_blocked for a task not in the wave: cancel stops the agent.
      if (cls !== BLOCKED_CLASS || a === undefined) return;
      a.liveness = noteResolved(a.liveness, d.decision_id, this.now());
      if (d.resolved.by === agentId) return;
      if (d.resolved.answer.trim().toLowerCase() === "cancel")
        await this.retireRole(wave, agentId, "stopped");
      return;
    }
    if (a !== undefined) a.liveness = noteResolved(a.liveness, d.decision_id, this.now());
    const { answer, by } = d.resolved;
    if (by === agentId) return;
    // Closed because the PR merged: not an answer for the agent, whose run the merge retires.
    if (by === DAEMON_AGENT_ID && answer === SUPERSEDED_BY_MERGE) return;
    const why = `${by} stopped the task (decision ${d.decision_id})`;
    if (cls === "respawn_needed") {
      const a = answer.trim().toLowerCase();
      if (task === RELEASE_TASK) {
        const respawn = isRespawnAnswer(answer, d.options);
        // The train acts only with a spawner: without one the agent stays, its stage recorded.
        if ((a !== STOP_ANSWER && !respawn) || this.opts.spawner === undefined) return;
        await this.retireGone(wave, task, agentId, x);
        return this.releaseRecovery(wave, agentId, respawn ? "respawn" : "stop", why);
      }
      const respawn =
        isRespawnAnswer(answer, d.options) &&
        isRole(String(x.role)) &&
        this.opts.spawner !== undefined;
      if (a !== STOP_ANSWER && !respawn) return;
      // Either way the vanished agent is done with: retired, so no later restart reconciles it.
      await this.retireGone(wave, task, agentId, x);
      if (!respawn) {
        await this.append(wave, { type: "task_cancelled", task, data: { by, why } });
        return;
      }
      return this.respawnRole(wave, task, agentId, String(x.role) as Role);
    }
    if (cls === BLOCKED_CLASS) {
      // The daemon's own agent_blocked (blockedFallback): manual is the owner's, nothing to do.
      const ans = answer.trim().toLowerCase();
      const stage = this.waves.get(wave)?.record.state?.tasks.find((t) => t.id === task)?.stage;
      const settled = stage === undefined || SETTLED_STAGES.has(stage) || x.stale === true;
      if (ans === "cancel") {
        if (!settled) return this.cancelTask(wave, task, agentId, why);
        // A settled task (or a stale agent's) stays as it is: only the blocked agent is stopped.
        if (a !== undefined) await this.retireRole(wave, agentId, "stopped");
        return;
      }
      if (settled && isRespawnAnswer(answer, d.options)) {
        // Offered while the task was active; it settled before the answer: nothing to relaunch.
        this.log(
          `${wave}/${task}: respawn of ${agentId} (decision ${d.decision_id}) ignored: the task is ${stage ?? "gone"}`,
        );
        return;
      }
      const respawn =
        !settled &&
        isRespawnAnswer(answer, d.options) &&
        isRole(String(x.role)) &&
        this.opts.spawner !== undefined;
      if (!respawn) return;
      if (a !== undefined) await this.retireRole(wave, agentId, "relaunched");
      else await this.retireGone(wave, task, agentId, x);
      return this.respawnRole(wave, task, agentId, String(x.role) as Role);
    }
    if (a === undefined) return;
    if (answer.trim().toLowerCase() === STOP_ANSWER)
      return task === RELEASE_TASK
        ? this.releaseRecovery(wave, agentId, "stop", why)
        : this.cancelTask(wave, task, agentId, why);
    switch (cls) {
      case "agent_question":
        return this.steerAgent(agentId, a, answer, {
          reason: "answer",
          decision_id: d.decision_id,
        });
      case "agent_stalled":
        // respawn: the pipeline relaunches the role (its liveness marker), a stage's the train.
        if (isRespawnAnswer(answer, d.options))
          return task === RELEASE_TASK
            ? this.releaseRecovery(
                wave,
                agentId,
                "respawn",
                `${by} asked for a respawn (decision ${d.decision_id})`,
              )
            : undefined;
        return this.steerAgent(
          agentId,
          a,
          answer.trim().toLowerCase() === "nudge again" ? CONTINUE_TEXT : answer,
          { reason: "stalled", decision_id: d.decision_id },
        );
      case CREDIT_CLASS:
      case UNVERIFIED_CLASS:
      case LIMITED_CLASS: {
        const sw = parseSwitchAnswer(answer, x);
        if (sw.kind === "switch") void this.runModelSwitch(agentId, a, sw.model, d.decision_id);
        return;
      }
    }
  }

  /** The train acts on a recovery answer about a stage agent, after the current op (its queue). */
  private releaseRecovery(
    wave: WaveId,
    agentId: string,
    answer: "stop" | "respawn",
    why: string,
  ): void {
    if (this.opts.spawner === undefined) return;
    void this.enqueue(() =>
      this.releaseFor(wave).handle({ kind: "agent_recovery", agent_id: agentId, answer, why }),
    );
  }

  /**
   * Approved by the owner: a fresh spawn of `role` after `agentId` (its own lock check still
   * applies). A pipeline role continues where the old agent was, as it was launched: its start
   * point, worktree and `.volley/` inputs, a merge-mode rebase step's merge brief, its MCP servers.
   */
  private respawnRole(wave: WaveId, task: TaskId, agentId: string, role: Role): void {
    const spawned = this.spawnedRecord((e) => e.data.agent_id === agentId, wave);
    this.refused.delete(`${wave}/${task}/${role}`);
    const pipeline = moveRespawn(spawned);
    // Its machine takes no new agents: it starts once the task is re-placed.
    if (this.parkClosed(wave, task)) {
      this.heldRespawn.set(`${wave}/${task}`, { role, pipeline });
      return;
    }
    void this.startSpawn(wave, task, role, pipeline).catch((e: unknown) =>
      this.log(`respawn ${wave}/${task}: ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  /** Journal `agent_retired` for an agent reconciliation found gone (its credentials revoked). */
  private async retireGone(
    wave: WaveId,
    task: TaskId,
    agentId: string,
    d: Record<string, unknown>,
  ): Promise<void> {
    const done = this.journalEvents(wave).some(
      (e) => e.type === "agent_retired" && e.data.agent_id === agentId,
    );
    if (done) return;
    const revoked =
      d.minted === true
        ? await reapAndRevoke(
            agentId,
            this.agentNamespace(wave, agentId),
            this.reapDeps((ev) => this.append(wave, ev)),
            task,
          )
        : null;
    await this.append(wave, {
      type: "agent_retired",
      task,
      data: {
        agent_id: agentId,
        role: d.role,
        status: "gone",
        credentials_revoked: revoked,
        lock_released: false,
      },
    });
  }

  /**
   * The approved model switch, beside the queue: `/model <m>` + Enter, then up to
   * `model_switch_verify_ms` for the PostModelSwitch registry re-publish. Unverified → the
   * decision is re-opened with the screen capture.
   */
  private async runModelSwitch(
    agentId: string,
    a: Supervised,
    model: string,
    decisionId: string,
  ): Promise<void> {
    const { wave, task } = a;
    const fallback = this.config.effective(wave).fallback_model;
    const reopen = async (
      data: Record<string, unknown>,
      allowed: boolean,
      cls: typeof UNVERIFIED_CLASS | typeof LIMITED_CLASS = UNVERIFIED_CLASS,
    ) => {
      const raw = await this.readScreenBounded(a.workspace, a.host);
      const screen = raw !== null ? this.saveCapture(wave, agentId, raw) : undefined;
      await this.serial(async () => {
        if (this.supervised.get(agentId) !== a) return;
        await this.append(wave, { type: "alarm_raised", task, data });
        const m = modelSwitchInput({
          task,
          agent_id: agentId,
          fallback_model: fallback,
          allowed,
          source: "screen",
          text: null,
          class: cls,
          tried: model,
          ...(screen !== undefined ? { screen } : {}),
        });
        const d = await this.openDecisionNow(wave, m.input, m.data);
        a.liveness = noteDecision(a.liveness, "credit", d.decision_id);
      });
    };
    try {
      const sent = switchesSent(this.journalEvents(wave), agentId, this.now());
      if (!recoveryAllowed(sent)) {
        await reopen(
          { alarm: "recovery_limited", agent_id: agentId, model, decision_id: decisionId },
          false,
          LIMITED_CLASS,
        );
        return;
      }
      await this.serial(() =>
        this.append(wave, {
          type: "alarm_raised",
          task,
          data: { alarm: "model_switch_sent", agent_id: agentId, model, decision_id: decisionId },
        }),
      );
      const r = await switchModel({
        host: a.host,
        workspace: a.workspace,
        watch: a.watch,
        // The decision approved this switch: the fence types `/model` only with its token.
        token: mintModelSwitchToken(model, decisionId),
        timeoutMs:
          this.opts.recoveryTimeouts?.modelSwitchVerifyMs ?? DAEMON_DEFAULTS.model_switch_verify_ms,
      });
      if (r.ok) {
        await this.serial(() =>
          this.append(wave, {
            type: "alarm_raised",
            task,
            data: {
              alarm: "model_switch_verified",
              agent_id: agentId,
              model,
              decision_id: decisionId,
            },
          }),
        );
        return;
      }
      await reopen(
        { alarm: "model_switch_unverified", agent_id: agentId, model, decision_id: decisionId },
        recoveryAllowed(sent + 1),
      );
    } catch (e) {
      this.log(`model switch ${agentId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Resolves once the restart reconciliation `start()` began has journaled every task. */
  reconciled(): Promise<void> {
    return this.reconciling;
  }

  /**
   * Restart reconciliation: every unsettled task's agent is compared with the broker, its lock,
   * git and GitHub (reconcile.ts), journaled as `reconciled`, and watched again — except one that
   * is gone without a trace, which opens a `respawn_needed` decision (once: not again while one is
   * open). Never respawns by itself. The targets are probed concurrently, outside the queue; only
   * the journaling and the supervision run inside it.
   */
  private async reconcileAll(): Promise<void> {
    const probes = this.opts.reconcile ?? execProbes(this.host.exec);
    const jobs: Promise<void>[] = [];
    for (const [wave, log] of this.waves) {
      const rec = log.record;
      const skipped = reconcileSkip(rec);
      if (skipped !== null) {
        jobs.push(
          this.serial(async () => {
            for (const t of reconcileTargets(rec, log.journal.readAll()))
              await this.append(wave, {
                type: "reconciled",
                task: t.task,
                data: { agent_id: t.agent_id, drift: [], skipped },
              });
            // A stopped wave's agents get what is left of the stop's grace (none, if it ran out
            // while the daemon was down); then nothing of the wave lives on.
            if (rec.state?.status === "stopped") {
              const stop = log.journal
                .readAll()
                .filter((e) => e.type === "wave_stopped" && e.data.all !== true)
                .at(-1);
              const at = stop !== undefined ? Date.parse(stop.at) : Number.NaN;
              const left = Number.isNaN(at)
                ? 0
                : at + secondsMs(this.config.effective(wave).stop_grace_s) - this.now();
              if (left > 0) this.armStopGrace(wave, left);
              else await this.forceRetireWave(wave, "stop");
            }
          }).catch((e: unknown) =>
            this.log(`reconcile ${wave}: ${e instanceof Error ? e.message : String(e)}`),
          ),
        );
        continue;
      }
      const repo = rec.wave?.repo !== undefined ? expandHome(rec.wave.repo) : undefined;
      const ns = rec.wave?.namespace ?? this.opts.namespace;
      for (const t of reconcileTargets(rec, log.journal.readAll())) {
        jobs.push(
          this.reconcileOne(wave, t, ns, repo, probes).catch((e: unknown) =>
            this.log(`reconcile ${wave}/${t.task}: ${e instanceof Error ? e.message : String(e)}`),
          ),
        );
      }
    }
    await Promise.all(jobs);
  }

  private async reconcileOne(
    wave: WaveId,
    t: ReconcileTarget,
    ns: string,
    repo: string | undefined,
    probes: ReconcileProbes,
  ): Promise<void> {
    const id = t.agent_id;
    // Watching first: a heartbeat during the probes is the one heartbeat a restart can know of.
    const watch = await watchAgent(this.broker, ns, id, this.time, this.progressFeed);
    const lockFile = typeof t.spawned.lock === "string" ? t.spawned.lock : undefined;
    const branchName = typeof t.spawned.branch === "string" ? t.spawned.branch : undefined;
    const role =
      typeof t.spawned.role === "string" && isRole(t.spawned.role) ? t.spawned.role : "implementer";
    let r: Reconciliation;
    let branch: TaskFacts["branch"];
    try {
      const [statusRaw, regRaw, b] = await Promise.all([
        this.broker.queryRetained(buildTopic(ns, id, "status"), DAEMON_DEFAULTS.probe_ms),
        this.broker.queryRetained(registryTopic(id), DAEMON_DEFAULTS.probe_ms),
        repo !== undefined && branchName !== undefined
          ? probes.branch(repo, branchName)
          : Promise.resolve({ name: branchName ?? "(unknown)", exists: null, head: null }),
      ]);
      branch = b;
      const status =
        statusRaw !== null && statusRaw !== "" ? (parseEnvelope(statusRaw)?.type ?? null) : null;
      // The PR only decides anything for an agent that finished while the daemon was down.
      const pr =
        status === "done" && repo !== undefined && branchName !== undefined
          ? await probes.pr(repo, branchName)
          : null;
      r = reconcileTask(
        {
          task: t.task,
          stage: t.stage,
          agent_id: id,
          role,
          registered: regRaw !== null && regRaw !== "",
          status,
          heartbeat_at: watch.state.lastHeartbeatAt,
          lock: lockFile !== undefined && readLock(lockFile)?.agent_id === id,
          branch,
          pr,
        },
        this.now(),
        secondsMs(this.config.effective(wave).heartbeat_alarm_s),
      );
    } catch (e) {
      await watch.close();
      throw e;
    }
    const gone = r.action === "respawn_needed";
    if (gone) await watch.close();
    await this.serial(async () => {
      if (!this.running) {
        await watch.close();
        return;
      }
      await this.append(wave, {
        type: "reconciled",
        task: t.task,
        data: {
          agent_id: id,
          drift: r.drift,
          ...(r.action !== undefined ? { action: r.action } : {}),
          ...(r.pr !== undefined ? { pr: r.pr } : {}),
          branch,
        },
      });
      if (r.drift.length > 0)
        this.log(`reconciled ${wave}/${t.task}: ${r.action} (${r.drift.join("; ")})`);
      if (r.action === "mark_done_verified") {
        await this.append(wave, {
          type: "artifact_verified",
          task: t.task,
          data: { pr: r.pr, source: "reconcile" },
        });
      }
      if (gone) {
        const rec = this.waves.get(wave)?.record;
        const open = rec !== undefined ? openDecisions(rec) : [];
        const already = open.some((d) => {
          const x = d as unknown as Record<string, unknown>;
          return x.class === "respawn_needed" && x.agent_id === id;
        });
        if (already) return;
        const canSpawn = this.opts.spawner !== undefined;
        await this.openDecisionNow(
          wave,
          {
            kind: "agent_blocked",
            task: t.task,
            question: `Needs you: ${id} (${t.task}) is gone after a volleyd restart: ${r.drift.join("; ")}. ${canSpawn ? "Respawn it?" : "Spawning is disabled on this daemon: stop the task, or respawn it from a daemon that spawns."}`,
            options: canSpawn ? ["respawn", STOP_ANSWER] : [STOP_ANSWER],
          },
          {
            class: "respawn_needed",
            agent_id: id,
            role,
            minted: t.spawned.credentials === "minted",
          },
        );
        return;
      }
      this.supervise(
        wave,
        t.task,
        role,
        {
          kind: "registered",
          agentId: id,
          workspace: typeof t.spawned.workspace === "string" ? t.spawned.workspace : "",
          model: null,
          modelVerified: false,
          watch,
          minted: t.spawned.credentials === "minted",
        },
        lockFile ?? "",
        ...this.hostOfTask(wave, t.task),
      );
      const resumed = this.supervised.get(id);
      if (resumed !== undefined) resumed.restored = true;
    });
  }

  /** The host (and a remote one's forward) a task's agents run on; local when unresolvable. */
  private hostOfTask(wave: WaveId, task: TaskId): [Host, string?] {
    const def = this.ranDef(this.waves.get(wave)?.record, task);
    if (def === undefined || def.host === "local" || this.autoHostReached(wave, def))
      return [this.host];
    try {
      const remote = this.remoteHost(wave, def);
      return [remote, forwardOf(remote)];
    } catch {
      return [this.host];
    }
  }

  /** `spawn` op (`volleyd spawn`): spawn one task's agent now, outside admission. */
  private async manualSpawn(p: Record<string, unknown>): Promise<Reply> {
    if (this.opts.spawner === undefined) return { ok: false, error: "spawning is disabled" };
    if (this.killSwitch)
      return {
        ok: false,
        error: `${KILL_SWITCH_REASON}: spawns are refused until \`volleyd resume --all\``,
      };
    const wave = typeof p.wave === "string" ? p.wave : "";
    const task = typeof p.task === "string" ? p.task : "";
    const role = typeof p.role === "string" ? p.role : "implementer";
    if (!this.waves.has(wave)) return { ok: false, error: `unknown wave '${wave}'` };
    if (this.waves.get(wave)?.record.wave?.tasks[task] === undefined)
      return { ok: false, error: `unknown task '${task}' in wave ${wave}` };
    if (!isRole(role)) return { ok: false, error: `unknown role '${role}'` };
    // A release stage's agent is the release train's to spawn (SPEC §4.6.19), never a task's.
    if (role === "release")
      return { ok: false, error: "role 'release' is spawned by the release train only" };
    if (this.waves.get(wave)?.record.wave?.tasks[task]?.host === AUTO_HOST)
      return {
        ok: false,
        error: `task ${task} is not placed yet (host: auto): it is placed when the scheduler admits it`,
      };
    this.refused.delete(`${wave}/${task}/${role}`);
    try {
      const res = await this.startSpawn(wave, task, role);
      return {
        ok: true,
        result:
          res.kind === "launched"
            ? {
                kind: res.kind,
                agent_id: res.agentId,
                workspace: res.workspace,
                worktree: res.worktree,
              }
            : { kind: res.kind, decision: res.decision, decision_id: res.decisionId },
      };
    } catch (e) {
      const eff = this.config.effective(wave);
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        result: {
          code: e instanceof SpawnError ? e.code : "SPAWN_FAILED",
          lock: this.lockFor(wave, task, role, eff.worktree_root),
        },
      };
    }
  }

  /**
   * `agent_move_account { agent, acct }` (claude/move.ts): journal, cancel, wait for the stop,
   * retire (`moved`), respawn the role under the other profile with a resume note.
   */
  private async moveAccount(
    p: Record<string, unknown>,
    by: string,
    /** An `agent_account_limit` answer: its decision and the move's one-line reason. */
    asked?: { decisionId: string; why: string },
  ): Promise<Reply> {
    if (this.opts.spawner === undefined) return { ok: false, error: "spawning is disabled" };
    const agentId = typeof p.agent === "string" ? p.agent : "";
    const acct = typeof p.acct === "string" ? p.acct : "";
    const a = this.supervised.get(agentId);
    if (a === undefined) return { ok: false, error: `no supervised agent '${agentId}'` };
    if (this.moving.has(agentId)) return { ok: false, error: `${agentId} is already moving` };
    // The agent's own machine: a profile there (`work`, or its record key `work@<name>`).
    const machine = a.host.name === "local" ? LOCAL_MACHINE : a.host.name;
    const at = acct.indexOf("@");
    if (at !== -1 && acct.slice(at + 1) !== machine)
      return {
        ok: false,
        error: `${agentId} runs on ${machine}: Claude account '${acct}' is not one of its machine's (profiles on other machines cannot take it)`,
      };
    let to: SelectedAccount;
    try {
      to = this.claude.select({ task: at === -1 ? acct : acct.slice(0, at), machine });
    } catch (e) {
      if (!(e instanceof ClaudeAccountError)) throw e;
      return machine === LOCAL_MACHINE
        ? { ok: false, error: e.message }
        : {
            ok: false,
            error: `${agentId} runs on ${machine}: ${e.message} (profiles on other machines cannot take it)`,
          };
    }
    const spawned = this.spawnedRecord((e) => e.data.agent_id === agentId, a.wave);
    const from = typeof spawned?.claude_account === "string" ? spawned.claude_account : "primary";
    const stopped = new Set([...TERMINAL_STATUS, "blocked"]);
    this.moving.add(agentId);
    try {
      return await moveAgentAccount(
        {
          wave: a.wave,
          task: a.task,
          role: a.role,
          agentId,
          from,
          to,
          by,
          ...(asked !== undefined ? { decisionId: asked.decisionId, why: asked.why } : {}),
        },
        {
          journal: (ev) => this.serial(() => this.append(a.wave, ev)),
          cancel: (text) =>
            this.serial(() =>
              this.cancelAgent(a.wave, { task: a.task, role: a.role, agent_id: agentId }, by, {
                text,
                from_agent_id: DAEMON_AGENT_ID,
                wave: a.wave,
                task: a.task,
              }),
            ),
          waitStopped: () =>
            a.watch.waitFor(
              (s) => stopped.has(s.status?.type ?? ""),
              DAEMON_DEFAULTS.account_move_stop_ms,
            ),
          retire: () => this.serial(() => this.retire(agentId, "moved")),
          respawn: async (r) => {
            const res = await this.serial(() =>
              this.startSpawn(a.wave, a.task, a.role, {
                ...moveRespawn(spawned),
                resumeNote: r.resumeNote,
              }),
            );
            return res.kind === "launched"
              ? { agentId: res.agentId }
              : { agentId: null, decision: res.decisionId };
          },
        },
      );
    } finally {
      this.moving.delete(agentId);
    }
  }

  /** The worktree lock a spawn of `task`/`role` takes (per target for a remote host). */
  private lockFor(wave: WaveId, task: string, role: Role, worktreeRoot: string): string {
    const def = this.waves.get(wave)?.record.wave?.tasks[task];
    if (def !== undefined && def.host !== "local") {
      try {
        const { spec } = this.remoteHost(wave, def);
        return lockPath(
          join(this.opts.home, "hosts", spec.target),
          worktreePath(spec.worktree_root, wave, task, role),
        );
      } catch {}
    }
    return lockPath(this.opts.home, worktreePath(worktreeRoot, wave, task, role));
  }

  /**
   * Observe every journal append (any wave, `_system` included) as it is made durable; returns
   * the unsubscribe. Tests await the event they expect through it instead of polling.
   */
  onJournal(fn: (wave: WaveId, event: JournalEvent) => void): () => void {
    this.journalListeners.add(fn);
    return () => this.journalListeners.delete(fn);
  }

  private observeJournal(wave: WaveId, journal: Journal): void {
    for (const e of journal.readAll()) {
      if (wave !== SYSTEM_WAVE) this.noteSpawn(wave, e);
      else this.noteRemoved(e);
    }
    journal.onAppend((event) => {
      if (wave !== SYSTEM_WAVE) this.noteSpawn(wave, event);
      else this.noteRemoved(event);
      for (const fn of this.journalListeners) fn(wave, event);
    });
  }

  /** An `agent_spawned`: the agent's wave and host, known before it is supervised. */
  private noteSpawn(wave: WaveId, e: JournalEvent): void {
    const { agent_id: id, host } = e.data as { agent_id?: unknown; host?: unknown };
    if (e.type !== "agent_spawned" || typeof id !== "string") return;
    this.spawnedAgents.set(id, { wave, host: typeof host === "string" ? host : "local" });
  }

  /** A `peer_removed` (F6): when the machine went, for the tasks still placed on it. */
  private noteRemoved(e: JournalEvent): void {
    if (e.type === "peer_removed" && typeof e.data.name === "string")
      this.removedAt.set(e.data.name, Date.parse(e.at));
  }

  /** Append to a wave journal, then mirror the event and re-publish the retained state. */
  private async append(wave: WaveId, ev: NewEvent): Promise<JournalEvent> {
    const log = this.waves.get(wave);
    if (log === undefined) throw new Error(`unknown wave '${wave}'`);
    const queued = log.record.queued_steers;
    const event = log.append(ev, dateOf(this.time));
    const named = namedAgent(event);
    if (named !== undefined) this.lastNamed.set(named, event.seq);
    const decided = decidedAgent(event);
    if (decided !== undefined) this.lastDecided.set(decided, event.seq);
    const published = this.track(this.publishAppended(wave, event));
    this.noteRemediation(wave, event);
    // A task that ends (cancelled, done) or a wave that stops drops the steers held for it.
    const ended =
      event.type === "wave_stopped"
        ? Object.keys(queued)
        : event.task !== undefined &&
            (event.type === "task_cancelled" ||
              (event.type === "stage_entered" && event.data.stage === "done"))
          ? [event.task]
          : [];
    // The last stage of the release train verified: the owner's release_go (SPEC §4.6.19).
    if (event.type === "release_stage_verified" || event.type === "release_stage_skipped")
      await this.releaseGoIfVerified(wave);
    if (event.type === "release_cancelled")
      this.log(
        `wave ${wave}: release train cancelled at ${String(event.data.stage)} by ${String(event.data.by)}`,
      );
    // The morning digest (SPEC §4.6.16): the wave ended, its release_go opened, or it needs its owner.
    const trigger = this.digestTrigger(wave, event);
    if (trigger !== null) await this.publishDigest(wave, trigger);
    for (const task of ended) {
      const ids = (queued[task] ?? []).map((q) => q.message_id);
      if (ids.length === 0) continue;
      const reason =
        event.type === "wave_stopped"
          ? "wave stopped"
          : `task ${event.type === "task_cancelled" ? "cancelled" : "done"}`;
      await this.append(wave, {
        type: "steering_dropped",
        task,
        data: { message_ids: ids, reason },
      });
    }
    return published;
  }

  /**
   * The digest an appended event publishes (SPEC §4.6.16), or null: none for it, or one with the
   * same trigger went out less than `autopilot.digest_min_interval_s` ago. A release_go's own
   * escalation is the release_go digest's, not another.
   */
  private digestTrigger(wave: WaveId, event: JournalEvent): DigestTrigger | null {
    const trigger: DigestTrigger | null =
      event.type === "wave_complete" || event.type === "release_done"
        ? "wave_complete"
        : event.type === "wave_stopped"
          ? "stopped"
          : event.type === "decision_opened" && event.data.kind === "release_go"
            ? "release_go"
            : event.type === "decision_escalated" && event.data.kind !== "release_go"
              ? "escalation"
              : null;
    if (trigger === null) return null;
    const last = this.journalEvents(wave)
      .filter((e) => e.type === "digest_published" && e.data.trigger === trigger)
      .at(-1);
    const minMs = secondsMs(this.config.get("autopilot.digest_min_interval_s", wave) as number);
    return last !== undefined && this.now() - Date.parse(last.at) < minMs ? null : trigger;
  }

  /**
   * Publish the wave's digest retained on `volley/_waves/<wave>/digest`, journal
   * `digest_published { trigger }`, and push its summary line once: a `progress` envelope of
   * type `digest` on volleyd's own topic (the notify bridge rings for it). Never fails the append
   * that triggered it.
   */
  private async publishDigest(wave: WaveId, trigger: DigestTrigger): Promise<void> {
    try {
      const state = this.snapshot(wave);
      if (state === null) return;
      const digest = digestOf(
        this.journalEvents(wave),
        state,
        dateOf(this.time).toISOString(),
        trigger,
      );
      const msg = summaryLine(digest);
      await this.publish(
        waveDigestTopic(wave),
        this.envelope("_waves/digest", "digest", digest),
        true,
      );
      this.digests.set(wave, digest);
      await this.append(wave, { type: "digest_published", data: { trigger } });
      // SPEC §4.1: progress is QoS 0, not retained.
      await this.broker.publish(
        buildTopic(this.opts.namespace, DAEMON_AGENT_ID, "progress"),
        JSON.stringify(this.envelope("progress", "digest", { msg, wave, trigger })),
        { qos: 0, retain: false },
      );
      this.log(`digest ${wave} (${trigger}): ${msg}`);
    } catch (e) {
      this.log(
        `digest ${wave} (${trigger}) not published: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** `digest`: the wave's digest as last published (SPEC §4.6.16). */
  private async digestOp(p: Record<string, unknown>): Promise<HandlerResult> {
    const wave = typeof p.wave === "string" ? p.wave : "";
    // Archiving clears the retained digest, so an archived wave has none to answer with.
    if (this.archived.has(wave))
      return { ok: false, error: `wave '${wave}' is archived; its digest was cleared` };
    if (!this.waves.has(wave)) return { ok: false, error: `unknown wave '${wave}'` };
    const cached = this.digests.get(wave);
    if (cached !== undefined) return { ok: true, result: cached };
    const raw = await this.broker.queryRetained(waveDigestTopic(wave), DAEMON_DEFAULTS.probe_ms);
    let env: { payload?: Digest } | null = null;
    try {
      env = raw !== null && raw !== "" ? (JSON.parse(raw) as { payload?: Digest }) : null;
    } catch {
      return { ok: false, error: `wave '${wave}' has a malformed retained digest` };
    }
    if (env?.payload !== undefined) return { ok: true, result: env.payload };
    return {
      ok: false,
      error: `wave '${wave}' has no digest yet (one is published when it completes, releases, stops or first needs its owner)`,
    };
  }

  /** An appended event's `/events` mirror, then the wave state it changed. */
  private async publishAppended(wave: WaveId, event: JournalEvent): Promise<JournalEvent> {
    await this.publish(
      waveEventsTopic(wave),
      this.envelope("_waves/events", event.type, {
        wave,
        seq: event.seq,
        at: event.at,
        ...(event.task !== undefined ? { task: event.task } : {}),
        data: event.data,
      }),
      false,
    );
    await this.publishState(wave);
    return event;
  }

  /** The agents whose terminals are being captured (screen-publisher.ts). */
  capturing(): string[] {
    return this.screens.tracked();
  }

  /** The wave state as published: the reduced journal plus effective config and admission reasons. */
  snapshot(wave: WaveId): WaveState | null {
    const rec = this.waves.get(wave)?.record;
    if (rec?.state == null) return null;
    const state = structuredClone(rec.state);
    state.effective_config = this.config.effective(wave);
    const ap = rec.autopilot ?? { resolved: 0, escalated: 0, budgets: {} };
    state.autopilot = {
      enabled: state.effective_config.autopilot?.enabled ?? true,
      auto_resolved: ap.resolved,
      escalated: ap.escalated,
      budgets: structuredClone(ap.budgets),
    };
    const held = this.heldBack.get(wave) ?? [];
    const candidates = new Set(admissible(rec));
    for (const t of state.tasks) {
      const host = rec.wave?.tasks[t.id]?.host;
      if (host !== undefined && host !== "local" && host !== AUTO_HOST) t.host = host;
      // A paired machine that is down: its running agents too (SPEC §4.6.14).
      const machine = t.host !== undefined ? this.machines.record(t.host) : undefined;
      if (machine?.tunnel === "down" && t.stage !== "done" && t.stage !== "cancelled") {
        t.host_down = this.machines.whyDown(machine);
      }
    }
    // A failed spawn says so, with its countdown, ahead of anything a queued task waits on.
    for (const t of state.tasks) {
      const f = latestSpawnFailure(rec, t.id);
      if (f === undefined || t.stage === "done" || t.stage === "cancelled") continue;
      if (t.stage !== "queued" && t.why_waiting !== undefined) continue;
      t.why_waiting = spawnFailedWhy(f, this.now());
    }
    // On a machine that takes no new agents (F6): what it waits for, whatever its stage.
    for (const t of state.tasks) {
      if (t.stage === "done" || t.stage === "cancelled" || t.why_waiting !== undefined) continue;
      if (this.taskLive(wave, t.id)) continue;
      const closed = this.closedFor(wave, t.id);
      if (closed !== null)
        t.why_waiting = `${closed.line}; re-place or cancel ${t.id} (its machine_down decision)`;
    }
    for (const t of state.tasks) {
      if (t.stage !== "queued" || t.why_waiting !== undefined) continue;
      const parked = this.parked.get(`${wave}/${t.id}`);
      if (parked !== undefined) t.why_waiting = parked;
      else if (rec.admitted.includes(t.id)) t.why_waiting = "admitted: awaiting spawn";
      else if (candidates.has(t.id) && this.heldTask.has(`${wave}/${t.id}`))
        t.why_waiting = this.heldTask.get(`${wave}/${t.id}`) as string;
      else if (candidates.has(t.id) && held.length > 0) t.why_waiting = held.join("; ");
    }
    for (const t of state.tasks) {
      if (Object.values(t.agents).some((id) => id !== undefined && this.screens.isStale(id))) {
        t.screen_stale = true;
      }
    }
    // Recovery (T8): what the task's agent is stuck on, more precise than "awaiting decision".
    const now = this.now();
    for (const a of this.supervised.values()) {
      if (a.wave !== wave) continue;
      const why = whyWaiting(a.liveness, now);
      const t = state.tasks.find((x) => x.id === a.task);
      if (why !== undefined && t !== undefined) t.why_waiting = why;
    }
    // Nothing can move without an answer: every unsettled task is parked on a decision or
    // queued behind one. Published only; internally the wave keeps running. Held decisions wait
    // on a blocker, not on the owner, so a wave with only held ones open stays `running`.
    if (
      state.status === "running" &&
      state.open_decisions.some((id) => rec.decisions[id]?.held === undefined)
    ) {
      const unsettled = state.tasks.filter((t) => t.stage !== "done" && t.stage !== "cancelled");
      const stuck = (t: (typeof unsettled)[number]) =>
        t.stage === "awaiting_decision" ||
        (t.stage === "queued" && t.why_waiting?.startsWith("awaiting decision") === true);
      if (unsettled.length > 0 && unsettled.every(stuck)) state.status = "awaiting_decision";
    }
    const coordinator = state.owner !== null ? this.coordinatorFor(state.owner) : undefined;
    if (coordinator !== undefined) state.coordinator = coordinator;
    return state;
  }

  private async publishState(wave: WaveId): Promise<void> {
    const state = this.snapshot(wave);
    if (state === null) return;
    await this.publish(
      waveStateTopic(wave),
      this.envelope("_waves/state", "wave_state", state),
      true,
    );
  }

  private async publishConfig(): Promise<void> {
    await this.publish(
      CONFIG_TOPIC,
      this.envelope("_waves/_config", "config", this.config.retainedPayload()),
      true,
    );
  }

  /**
   * The reduced record of a wave, live or archived (undefined when unknown). An archived wave's
   * journal is closed to `append`: a subsystem that journals after reading it checks `waves` first.
   */
  record(wave: WaveId) {
    return (this.waves.get(wave) ?? this.archived.get(wave))?.record;
  }

  /** Every journal event of a wave, oldest first. */
  journalEvents(wave: WaveId): JournalEvent[] {
    return (this.waves.get(wave) ?? this.archived.get(wave))?.journal.readAll() ?? [];
  }

  /** Journal one event (serially, mirrored and re-published) — for in-daemon subsystems. */
  recordEvent(wave: WaveId, ev: NewEvent): Promise<JournalEvent> {
    return this.serial(() => this.append(wave, ev));
  }

  /**
   * Open a decision: journal `decision_opened` (the task parks in `awaiting_decision`, its
   * dependents wait, independent tasks keep running — unless opened with `park: false`), publish it retained, and ring the notify bridge. Throws on an unknown wave/task or a bad input.
   */
  openDecision(wave: WaveId, input: DecisionInput): Promise<DecisionRecord> {
    return this.serial(() => this.openDecisionNow(wave, input));
  }

  /**
   * `openDecision` without the queue; `extra` facts are kept on the decision (journal + topic).
   * `settle: false` only journals it: the caller settles it (`settleDecision`) later.
   */
  private async openDecisionNow(
    wave: WaveId,
    input: DecisionInput,
    extra: Record<string, unknown> = {},
    settle = true,
  ): Promise<DecisionRecord> {
    const log = this.waves.get(wave);
    if (log === undefined) throw new Error(`unknown wave '${wave}'`);
    // A release stage agent's question (liveness, a spawn's) is wave-level: `_release` is no task.
    const asked = input.task === RELEASE_TASK ? { ...input, task: null } : input;
    const r = openEvent(
      log.record,
      this.withRespawnElsewhere(wave, asked, extra),
      dateOf(this.time),
    );
    if ("error" in r) throw new Error(r.error);
    await this.append(wave, { ...r.event, data: { ...extra, ...r.event.data } });
    this.log(`opened ${describeDecision(log.record.decisions[r.id] as DecisionRecord)}`);
    if (settle) await this.settleDecision(wave, r.id);
    return log.record.decisions[r.id] as DecisionRecord;
  }

  /**
   * Autopilot answers a just-opened decision (resolveNow publishes and clears its topic), or
   * journals why it is the owner's; only a decision still open is published and rings.
   */
  private async settleDecision(wave: WaveId, id: string): Promise<void> {
    const log = this.waves.get(wave);
    const opened = log?.record.decisions[id];
    if (log === undefined || opened === undefined) return;
    // Its inbox item first (SPEC §4.6.18): an autopilot answer closes it like any other.
    if (opened.resolved === undefined) await this.openDecisionItem(wave, opened);
    if (!(await this.autopilot(wave, opened))) return;
    await this.ringDecision(wave, log.record.decisions[id] as DecisionRecord);
  }

  /** Publish an open decision retained and ring the notify bridge (its attention envelope). */
  private async ringDecision(wave: WaveId, d: DecisionRecord): Promise<void> {
    await this.publishDecision(wave, d);
    // SPEC §4.1: progress is QoS 0, not retained.
    await this.broker.publish(
      buildTopic(this.opts.namespace, DAEMON_AGENT_ID, "progress"),
      JSON.stringify(this.envelope("progress", "blocked", attentionPayload(decisionPayload(d)))),
      { qos: 0, retain: false },
    );
  }

  /**
   * Autopilot (SPEC §4.6.16): answer a just-opened decision from the policy table (journal
   * `decision_auto_resolved`, then resolve it as volleyd), or journal `decision_escalated` with
   * why it is the owner's. Returns whether the decision is still open. Disabled for the wave:
   * nothing is journaled and the decision waits, as before autopilot. A decision a resolution
   * opens (a re-ask) comes back through here, bounded by its budget.
   */
  private async autopilot(
    wave: WaveId,
    d: DecisionRecord,
    opts: { again?: boolean } = {},
  ): Promise<boolean> {
    const rec = this.waves.get(wave)?.record;
    if (rec === undefined || d.resolved !== undefined) return d.resolved === undefined;
    const eff = this.config.effective(wave);
    const v = evaluate(d, {
      autopilot: eff.autopilot,
      used: (key) => budgetUsed(rec, key),
      task: d.task !== null ? rec.state?.tasks.find((t) => t.id === d.task) : undefined,
      derived_budget:
        rec.wave != null ? spawnBudget(rec.wave, eff.spawn_budget_multiplier, 0) : undefined,
      fixer: this.fixerVerdict(wave, d),
    });
    if ("off" in v) return true;
    // Asked again (a released hold): an escalation it already carries is not journaled twice.
    if ("escalate" in v && opts.again === true && d.escalated?.why === v.escalate) return true;
    if ("escalate" in v) return this.escalate(wave, d, v.escalate, v.budget);
    // Journaled once the answer is accepted, immediately before its decision_resolved: a refused
    // answer leaves no decision_auto_resolved and spends no budget.
    const answered = () =>
      this.append(wave, {
        type: "decision_auto_resolved",
        ...(d.task !== null ? { task: d.task } : {}),
        data: {
          decision_id: d.decision_id,
          kind: d.kind,
          policy: v.policy,
          answer: v.answer,
          rationale: v.rationale,
          evidence: v.evidence,
          ...(v.budget !== undefined ? { budget: v.budget } : {}),
        },
      }).then(() => undefined);
    try {
      await this.resolveNow(
        wave,
        d.decision_id,
        {
          answer: v.answer,
          by: DAEMON_AGENT_ID,
          rationale: `autopilot ${v.policy}: ${v.rationale}`,
        },
        answered,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Resolved, then a later step failed: the answer stands, the decision is not reopened.
      if (this.waves.get(wave)?.record.decisions[d.decision_id]?.resolved !== undefined) {
        this.log(`autopilot answered ${d.decision_id}, but after it: ${msg}`);
        return false;
      }
      // The answer was refused (an account that cannot take the wave, …): the owner's, now.
      // Nothing was spent, so no budget is journaled.
      this.log(`autopilot ${d.decision_id}: ${msg}`);
      return this.escalate(wave, d, "unattended_safety", undefined);
    }
    this.log(`autopilot answered ${d.decision_id} (${v.policy}): ${v.answer}`);
    return false;
  }

  /** Journal `decision_escalated`: the decision stays open, its question says why. */
  private async escalate(
    wave: WaveId,
    d: DecisionRecord,
    why: EscalateWhy,
    budget: Budget | undefined,
  ): Promise<boolean> {
    await this.append(wave, {
      type: "decision_escalated",
      ...(d.task !== null ? { task: d.task } : {}),
      data: {
        decision_id: d.decision_id,
        kind: d.kind,
        why,
        ...(budget !== undefined ? { budget } : {}),
      },
    });
    this.log(`autopilot left ${d.decision_id} (${d.kind}) for the owner: ${why}`);
    return true;
  }

  /** Resolve a decision (no ownership check — the control op does that). Idempotent. */
  resolveDecision(
    wave: WaveId,
    id: string,
    r: { answer: string; by: string; rationale?: string },
  ): Promise<{ decision: DecisionRecord; already_resolved: boolean; brief?: string }> {
    return this.serial(() => this.resolveNow(wave, id, r));
  }

  private async resolveNow(
    wave: WaveId,
    id: string,
    r: { answer: string; by: string; rationale?: string; where?: InboxWhere },
    beforeResolved?: () => Promise<void>,
  ): Promise<{ decision: DecisionRecord; already_resolved: boolean; brief?: string }> {
    const log = this.waves.get(wave);
    if (log === undefined) throw new Error(`unknown wave '${wave}'`);
    let ev = resolveEvent(log.record, id, r, dateOf(this.time));
    if ("error" in ev) throw new Error(ev.error);
    if ("already" in ev) return { decision: ev.already, already_resolved: true };
    // `respawn on <machine>` (F6): the task moves there before the respawn the answer triggers.
    // A machine that cannot take it now refuses the answer: journaled as not offered, so the
    // question is asked again with a fresh best.
    const asked = log.record.decisions[id];
    const target =
      asked !== undefined && asked.task !== null ? respawnTarget(r.answer, asked.options) : null;
    const refused =
      asked !== undefined && target !== null ? await this.respawnOn(wave, asked, target) : null;
    if (refused !== null) {
      const again = resolveEvent(
        log.record,
        id,
        { ...r, answer: `${r.answer} (refused: ${refused})` },
        dateOf(this.time),
      );
      if ("error" in again) throw new Error(again.error);
      if ("already" in again) return { decision: again.already, already_resolved: true };
      ev = again;
    }
    const move = this.accountLimitMove(wave, log.record.decisions[id], r.answer);
    const agentMove = this.agentLimitMove(wave, log.record.decisions[id], r.answer, r.by);
    // The answer is accepted: what must come right before decision_resolved (autopilot's event).
    await beforeResolved?.();
    await this.append(wave, ev.event);
    const d = log.record.decisions[id] as DecisionRecord;
    // Every answer closes the decision's inbox item through the referee (SPEC §4.6.18).
    await this.closeDecisionItem(wave, d, r);
    if (move !== null) {
      await this.append(wave, {
        type: "wave_account_moved",
        data: { from: move.from, to: move.to, by: r.by, decision_id: id },
      });
      this.log(`wave ${wave}: new agents start under Claude account ${move.to} (was ${move.from})`);
    }
    // The move waits for the agent to stop: it runs beside the serial queue, as the op's does.
    if (agentMove !== null)
      void this.moveAccount({ agent: agentMove.agent, acct: agentMove.to }, r.by, {
        decisionId: id,
        why: agentMove.why,
      }).then(
        (res) => {
          if (!res.ok) this.log(`agent_account_limit ${id}: ${res.error ?? "move refused"}`);
        },
        (e: unknown) =>
          this.log(`agent_account_limit ${id}: ${e instanceof Error ? e.message : String(e)}`),
      );
    await this.publishResolved(wave, d);
    this.log(`resolved ${id} by ${r.by}: ${r.answer}`);
    await this.onRecoveryResolved(wave, d);
    // The pipeline asks its own questions again; a supervisor's is asked again here.
    if (refused !== null && (d as { pipeline?: unknown }).pipeline === undefined)
      await this.askAgainRefused(wave, d, r.answer, refused);
    if (d.kind === "machine_down") await this.onMachineDownResolved(wave, d);
    if (d.kind === "release_go") {
      // go: the release is the owner's, and done. Anything else holds it: asked again.
      if (r.answer.trim().toLowerCase() === "go")
        await this.append(wave, { type: "release_done", data: { by: r.by, decision_id: id } });
      else await this.releaseGoIfVerified(wave);
    }
    if (d.kind === "remote_repo_missing" && d.task !== null) {
      if (r.answer.trim().toLowerCase() === "cancel") {
        await this.append(wave, {
          type: "task_cancelled",
          task: d.task,
          data: { by: r.by, why: `no clone on the remote host (decision ${id})` },
        });
      } else {
        // Any other answer requeues the task: the refusal's backoff must not delay the retry.
        for (const key of this.refused.keys()) {
          if (key.startsWith(`${wave}/${d.task}/`)) this.refused.delete(key);
        }
      }
    }
    if (d.kind === "spawn_budget_exhausted") {
      if (r.answer.trim().toLowerCase() === "cancel") {
        if (d.task !== null)
          await this.append(wave, {
            type: "task_cancelled",
            task: d.task,
            data: { by: r.by, why: `spawn budget exhausted (decision ${id})` },
          });
        else await this.stopWave(wave, r.by);
      }
      // `raise by N` is folded into the budget by the reducer; the next tick spawns.
    }
    const failedTask = d.kind === "spawn_failed" ? spawnFailedTask(d) : null;
    if (failedTask !== null && r.by !== DAEMON_AGENT_ID) {
      // Either answer lifts the backoff (or a stop): a retry spawns now, a respawn after a stop too.
      for (const key of this.refused.keys()) {
        if (key.startsWith(`${wave}/${failedTask}/`)) this.refused.delete(key);
      }
      const stop = r.answer.trim().toLowerCase() === SPAWN_STOP_ANSWER;
      if (failedTask === RELEASE_TASK) {
        // A stage's spawn is the train's: stop fails the stage (the owner is asked what next).
        const why = `${r.by} stopped the stage's spawn retries (decision ${id})`;
        if (this.opts.spawner !== undefined)
          void this.enqueue(() =>
            stop
              ? this.releaseFor(wave).handle({ kind: "spawn_stopped", why })
              : this.releaseAdvance(wave),
          );
      } else if (stop) {
        await this.append(wave, {
          type: "task_cancelled",
          task: failedTask,
          data: { by: r.by, why: `spawn failed (decision ${id})` },
        });
      }
      // "retry now" on a task: the next tick spawns it.
    }
    // A release stage's question (stage_go, a failed stage's agent_blocked): the train's answer.
    if (stageOf(d) !== undefined && this.opts.spawner !== undefined)
      void this.enqueue(() =>
        this.releaseFor(wave).handle({ kind: "decision_resolved", decision: d }),
      );
    // archive_on_ack: an answered wave_complete retires the wave now, not on the next tick.
    if (d.kind === "wave_complete" && r.answer !== ARCHIVED_ANSWER) await this.archiveIfDue(wave);
    if (d.task === null) return { decision: d, already_resolved: false };
    if ((d as { pipeline?: unknown }).pipeline !== undefined && this.opts.spawner !== undefined) {
      const task = d.task;
      void this.enqueue(() =>
        this.pipelineFor(wave).handle(task, { kind: "decision_resolved", decision: d }),
      );
    }
    // The next stage's brief: every resolved decision of the task, in opening order. The
    // resolution is already journaled, so a failed write is an alarm, not a failed resolve.
    const all = Object.values(log.record.decisions).filter((x) => x.task === d.task);
    const { dir, files } = this.taskDirAndHostFor(wave, d.task);
    try {
      const brief = await writeDecisionsFile(files, dir, renderDecisionsMd(wave, d.task, all));
      return { decision: d, already_resolved: false, brief };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      const path = decisionsFilePath(dir);
      this.log(`resolved ${id}, but writing ${path}: ${error}`);
      // Once per decision: a second resolve returns `already_resolved` before it gets here.
      await this.append(wave, {
        type: "alarm_raised",
        task: d.task,
        data: { alarm: "decisions_file_unwritten", decision_id: id, path, error },
      });
      return { decision: d, already_resolved: false };
    }
  }

  /**
   * The wave move an `account_limit` answer asks for (`move wave <w> to <acct>`), or null for
   * any other answer. Throws, before anything is journaled, for a move of another wave or to an
   * account a spawn could not use, so the decision stays open.
   */
  private accountLimitMove(
    wave: WaveId,
    d: DecisionRecord | undefined,
    answer: string,
  ): { from: string; to: string } | null {
    if (d?.kind !== "account_limit" || typeof d.acct !== "string") return null;
    const m = parseMoveAnswer(answer);
    if (m === null) return null;
    if (m.wave !== wave)
      throw new Error(`decision ${d.decision_id} is about wave ${wave}, not ${m.wave}`);
    const to = this.claude.select({ task: m.to }).id;
    if (to === d.acct) throw new Error(`wave ${wave} is already on Claude account '${to}'`);
    return { from: d.acct, to };
  }

  /**
   * The agent move an `agent_account_limit` answer asks for (`move <agent> to <acct>`), or null
   * for any other answer (`not now`: it stays, and the next decision waits for the reset). Throws,
   * before anything is journaled, for another agent than the decision's or one no longer
   * supervised or already moving, so the decision stays open.
   */
  private agentLimitMove(
    wave: WaveId,
    d: DecisionRecord | undefined,
    answer: string,
    by: string,
  ): { agent: string; to: string; why: string } | null {
    if (d?.kind !== "agent_account_limit" || typeof d.agent_id !== "string") return null;
    const m = parseAgentMoveAnswer(answer);
    if (m === null) return null;
    if (m.agent !== d.agent_id)
      throw new Error(`decision ${d.decision_id} is about ${d.agent_id}, not ${m.agent}`);
    const a = this.supervised.get(m.agent);
    if (a === undefined || a.wave !== wave) throw new Error(`no supervised agent '${m.agent}'`);
    if (this.moving.has(m.agent)) throw new Error(`${m.agent} is already moving`);
    // An account the agent's machine cannot take refuses the answer (the decision stays open).
    const machine = a.host.name === "local" ? LOCAL_MACHINE : a.host.name;
    const at = m.to.indexOf("@");
    if (at !== -1 && m.to.slice(at + 1) !== machine)
      throw new Error(`Claude account '${m.to}' is not one of ${machine}'s`);
    this.claude.select({ task: at === -1 ? m.to : m.to.slice(0, at), machine });
    const pct =
      typeof d.pct === "number" ? ` (${windowShort(d.window)} ${Math.round(d.pct)}%)` : "";
    return { agent: m.agent, to: m.to, why: `moved off ${d.acct ?? "its account"}${pct} by ${by}` };
  }

  /**
   * One agent's retained usage sample (or its clearing): fold it into its account's record,
   * re-publish the records that changed, then open any `account_limit` decision it calls for.
   * A sample is the agent's own (the envelope's `agent_id` is the topic's); its wave and host are
   * its spawn's (journaled, so known after a restart and before it is supervised), and its account
   * record the one `sampleAccount` names for that host.
   */
  private async onUsage(topic: string, raw: string): Promise<void> {
    const [, ns, agent] = topic.split("/");
    if (ns === undefined || ns.startsWith("_") || agent === undefined) return;
    if (raw === "") {
      this.usage = forgetAgent(this.usage, agent);
    } else {
      const env = parseEnvelope(raw);
      const p = env?.agent_id === agent ? parseUsage(env.payload) : null;
      const spawn = this.spawnedAgents.get(agent);
      const account =
        p === null
          ? null
          : sampleAccount(p, spawn?.host ?? "local", (dir) => this.claude.accountForDir(dir));
      if (p === null || account === null) return;
      const before = bookState(this.usage);
      this.usage = foldUsage(this.usage, { agent, wave: spawn?.wave ?? null, account, payload: p });
      const after = bookState(this.usage);
      if (after !== before) writeFileAtomic(this.usageFile, after);
    }
    await this.usagePass();
  }

  /** Re-publish the account records that changed, then open the `account_limit`s they call for. */
  private async usagePass(): Promise<void> {
    const records = accountRecords(this.usage);
    for (const rec of Object.values(records)) {
      const payload = { ...rec, ...this.claude.describe(rec.account) };
      const text = JSON.stringify(payload);
      if (this.publishedUsage.get(rec.account) === text) continue;
      this.publishedUsage.set(rec.account, text);
      await this.publish(
        usageAccountTopic(rec.account),
        this.envelope("_system/claude-accounts", "claude_account", payload),
        true,
      );
    }
    const existing: LimitSeen[] = [...this.waves].flatMap(([w, log]) =>
      Object.values(log.record.decisions).flatMap((d) =>
        d.kind === "account_limit" && typeof d.acct === "string"
          ? [
              {
                wave: w,
                acct: d.acct,
                resets_at: d.resets_at ?? null,
                open: d.resolved === undefined,
              },
            ]
          : [],
      ),
    );
    for (const lim of limitDecisions({
      accounts: records,
      // The lowest threshold any wave has; each wave's own is applied below.
      warnAtPct: Math.min(
        this.config.effective().claude.warn_at_pct,
        ...[...this.waves.keys()].map((w) => this.config.effective(w).claude.warn_at_pct),
      ),
      candidates: this.claude.candidates(),
      peers: Object.fromEntries(
        Object.keys(this.config.effective().hosts).map((n) => [n, this.claude.candidates(n)]),
      ),
      balanced: (w) => this.balanced(w),
      existing,
      now: this.now(),
    })) {
      const status = this.waves.get(lim.wave)?.record.state?.status;
      if (status === undefined || status === "complete" || status === "stopped") continue;
      const warnAt = this.config.effective(lim.wave).claude.warn_at_pct;
      if (lim.extra.pct < warnAt) continue;
      await this.openDecisionNow(lim.wave, lim.input, lim.extra).catch((e: unknown) =>
        this.log(`account_limit for ${lim.wave}: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
    await this.agentLimitPass(records);
  }

  /**
   * D2: an `agent_account_limit` decision for each supervised agent whose account is at the warn
   * level in a window that counts for it (claude/usage.ts agentLimitDecisions), once per task
   * role, account, window and reset. It does not park the task; autopilot answers it.
   */
  private async agentLimitPass(records: ReturnType<typeof accountRecords>): Promise<void> {
    const agents: AgentOnAccount[] = [];
    for (const [id, a] of this.supervised) {
      const status = this.waves.get(a.wave)?.record.state?.status;
      if (status === undefined || status === "complete" || status === "stopped") continue;
      const machine = a.host.name === "local" ? LOCAL_MACHINE : a.host.name;
      const seen = this.usage.agents[id];
      const def = this.waves.get(a.wave)?.record.wave?.tasks[a.task];
      // Before its first sample: the account its spawn journaled.
      const own = () => {
        const spawned = this.spawnedRecord((e) => e.data.agent_id === id, a.wave);
        return typeof spawned?.claude_account === "string" ? spawned.claude_account : "primary";
      };
      agents.push({
        agent_id: id,
        wave: a.wave,
        task: a.task,
        role: a.role,
        acct: seen?.account ?? accountKey(own(), machine),
        model: seen?.model ?? def?.model ?? null,
        machine,
        pinned: this.pinned(a.wave, a.task),
        moving: this.moving.has(id),
      });
    }
    if (agents.length === 0) return;
    const existing: AgentLimitSeen[] = [...this.waves].flatMap(([w, log]) =>
      Object.values(log.record.decisions).flatMap((d) =>
        d.kind === "agent_account_limit" && d.task !== null && typeof d.acct === "string"
          ? [
              {
                wave: w,
                task: d.task,
                role: d.role ?? "",
                acct: d.acct,
                window: d.window ?? "",
                resets_at: d.resets_at ?? null,
              },
            ]
          : [],
      ),
    );
    for (const lim of agentLimitDecisions({
      accounts: records,
      agents,
      candidates: (m) => this.claude.candidates(m),
      warnAtPct: (w) => this.config.effective(w).claude.warn_at_pct,
      existing,
      now: this.now(),
    })) {
      await this.openDecisionNow(lim.wave, lim.input, lim.extra).catch((e: unknown) =>
        this.log(
          `agent_account_limit for ${lim.extra.agent_id}: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  }

  // -------------------------------------------------------------------------------------------
  // The needs-you inbox (SPEC §4.6.18): volleyd is the referee
  // -------------------------------------------------------------------------------------------

  /** The agent coordinator name `name` is bound to, if any. */
  bindingOf(name: string): string | undefined {
    return this.bindings.get(name)?.agent_id;
  }

  /** One inbox item (open, or answered and not yet cleared). */
  inboxItem(id: string): InboxItem | undefined {
    return this.inbox.get(id);
  }

  /**
   * Open an inbox item (pickers, handoffs, release stages): journal `inbox_opened` in its wave
   * (else `_system`) and publish it retained. Opening an id that exists returns that item.
   */
  openInboxItem(
    input: Omit<InboxItem, "version" | "opened_at" | "answered"> & { opened_at?: string },
  ): Promise<InboxItem> {
    return this.serial(() =>
      this.openInboxItemNow({
        ...input,
        version: 1,
        opened_at: input.opened_at ?? dateOf(this.time).toISOString(),
      }),
    );
  }

  /**
   * Answer an inbox item through the referee: the first answer at the item's current version wins;
   * a decision's answer resolves it, any other kind's goes to its `inboxHandlers` entry. The
   * screen carry stays on the queue (a slow remote holds it for its bounded duration) so a
   * terminal pick or prompt arriving meanwhile only confirms it: carry and record are one step.
   */
  answerInboxItem(
    id: string,
    req: InboxAnswerRequest,
  ): Promise<{ item: InboxItem } | { refused: string }> {
    return this.serial(() => this.answerInboxItemNow(id, req));
  }

  private async openInboxItemNow(item: InboxItem): Promise<InboxItem> {
    const prior = this.inbox.get(item.id);
    if (prior !== undefined) return prior;
    this.inbox.set(item.id, item);
    await this.journalInbox(item, openedEvent(item));
    await this.publishInboxItem(item);
    return item;
  }

  private async answerInboxItemNow(
    id: string,
    req: InboxAnswerRequest,
  ): Promise<{ item: InboxItem } | { refused: string; code?: typeof BAD_ANSWER }> {
    const item = this.inbox.get(id);
    if (item === undefined) return { refused: `unknown inbox item '${id}'` };
    // The owner check `resolve` applies: the inbox is no way around it. A Desk login is the
    // owner on another screen: the broker named it on its own account-op topic. It comes
    // before the answer's own check, so a non-owner hears it is not theirs to answer.
    if (item.kind === "decision" && item.wave !== undefined && req.desk_login !== true) {
      const state = this.waves.get(item.wave)?.record.state;
      const refused =
        state != null ? guardMutation(state, req.by, "inbox_answer", this.bindings) : null;
      if (refused !== null) return { refused };
    }
    // An answer its decision cannot apply is refused before the compare-and-set (#315).
    // A decision already resolved (a crash before its item closed) answers "already answered".
    const decided =
      item.wave !== undefined &&
      typeof item.source.decision_id === "string" &&
      this.waves.get(item.wave)?.record.decisions[item.source.decision_id]?.resolved !== undefined;
    const bad =
      item.answered === undefined && !decided ? decisionAnswerRefusal(item, req.answer) : null;
    if (bad !== null) return { refused: bad, code: BAD_ANSWER };
    const check = answerEvent(item, req, dateOf(this.time));
    if ("refused" in check) return check;
    if (item.kind === "decision") {
      const wave = item.wave;
      const decision = item.source.decision_id;
      if (wave === undefined || typeof decision !== "string" || !this.waves.has(wave))
        return { refused: `inbox item '${id}' names no open decision` };
      const r = await this.answerDecision(wave, decision, req);
      if ("refused" in r) return r;
      if (r.already_resolved) {
        // Resolved without closing its item (a crash between the two): closed now, as answered.
        const first = r.decision.resolved;
        if (first !== undefined) await this.closeDecisionItem(wave, r.decision, { by: first.by });
        const now = this.inbox.get(id)?.answered;
        return {
          refused: `already answered on ${now !== undefined ? whereLabel(now.where) : "cli"}`,
        };
      }
    } else {
      // Keys in a wave agent's session steer it: the owner check `steer` applies. A Desk login
      // is the owner on another screen (the broker named it on its own account-op topic): the
      // screen-carry rules still apply to it, the ownership checks do not.
      if (req.desk_login !== true) {
        const refused = this.guardSessionAnswer(item, req.by);
        if (refused !== null) return { refused };
        const state = item.wave !== undefined ? this.waves.get(item.wave)?.record.state : undefined;
        const notOwner =
          state != null ? guardMutation(state, req.by, "inbox_answer", this.bindings) : null;
        if (notOwner !== null) return { refused: notOwner };
      }
      const handler = this.inboxHandlers.get(item.kind);
      if (handler === undefined) this.log(`inbox ${id}: no handler for ${item.kind} answers`);
      else {
        const refused = await handler(item, req).catch(
          (e: unknown) =>
            `could not carry out the answer: ${e instanceof Error ? e.message : String(e)}`,
        );
        if (typeof refused === "string") {
          this.log(`inbox ${id}: answer '${req.answer}' refused: ${refused}`);
          return { refused };
        }
      }
      await this.recordInboxAnswer(item, req);
    }
    return { item: this.inbox.get(id) as InboxItem };
  }

  /**
   * null when `by` may answer a picker or handoff; else the refusal. A coordinator session's own
   * (`owner_only`) is answered only by that session's owner: its agent id, or the coordinator
   * name (VOLLEY_COORDINATOR) bound to it, as `guardMutation` reads a wave's owner.
   */
  private guardSessionAnswer(item: InboxItem, by: string): string | null {
    if (!item.owner_only || (item.kind !== "picker" && item.kind !== "handoff")) return null;
    if (this.actsAs(item.agent_id, by)) return null;
    return `inbox item '${item.id}' is ${item.agent_id}'s own: only its owner answers it, not ${by}`;
  }

  /**
   * Resolve a decision with an answer given anywhere (the resolve op, the Desk, a terminal): the
   * trust check, the resolution (which closes its inbox item), then what a plan answer applies.
   */
  private async answerDecision(
    wave: WaveId,
    id: string,
    given: { answer: string; by: string; rationale?: string; where?: InboxWhere },
  ): Promise<
    | { refused: string; code?: typeof BAD_ANSWER }
    | { decision: DecisionRecord; already_resolved: boolean; brief?: string }
  > {
    // An answer the decision cannot apply is refused, and nothing is journaled (#315).
    const asked = this.waves.get(wave)?.record.decisions[id];
    const checked =
      asked !== undefined && asked.resolved === undefined
        ? checkAnswer(asked, given.answer)
        : { answer: given.answer };
    if ("refused" in checked) return { refused: checked.refused, code: BAD_ANSWER };
    const r = { ...given, answer: checked.answer };
    const trust = await this.trustAnswer(wave, id, r.answer);
    if (trust !== null) return { refused: trust };
    const res = await this.resolveNow(wave, id, r);
    if (!res.already_resolved) await this.applyPlanAnswer(wave, res.decision, r.by);
    return res;
  }

  /**
   * A session's hooks say a person is needed, or was answered there (SPEC §4.6.18): a picker
   * opened (`picker_opened`, any session) or answered (`picker_answered`), a coordinator turn that
   * ended on a question (`awaiting_input` with `question`, a session volleyd does not supervise),
   * the next prompt it was given (`activity` `prompt received`, or the `resumed` of that
   * UserPromptSubmit), or a turn's end (`idle`: no picker is open any more). Runs on the queue.
   */
  private noteInboxSignal(agent: string, env: Envelope): void {
    const p = (
      typeof env.payload === "object" && env.payload !== null ? env.payload : {}
    ) as Record<string, unknown>;
    const at = Number.isNaN(Date.parse(env.wall_time))
      ? dateOf(this.time).toISOString()
      : env.wall_time;
    if (env.type === "picker_opened") {
      const questions = parsePickerQuestions(p.questions);
      if (typeof p.tool_use_id !== "string" || questions === null) return;
      const toolUseId = p.tool_use_id;
      if (!INBOX_ID.test(pickerItemId(agent, toolUseId))) return;
      void this.enqueue(() =>
        this.openInboxItemNow(
          itemForPicker(agent, toolUseId, questions, this.sessionSurface(agent, p), at),
        ),
      );
    } else if (env.type === "picker_answered") {
      const answer = pickerAnswerText(p.answers);
      if (typeof p.tool_use_id !== "string" || answer === null) return;
      const id = pickerItemId(agent, p.tool_use_id);
      void this.enqueue(() => this.closeInTerminal(id, answer));
    } else if (env.type === "awaiting_input") {
      const seq = p.seq;
      if (typeof p.question !== "string" || p.question.trim() === "") return;
      if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) return;
      if (this.supervised.has(agent)) return; // a wave agent's question is a decision (liveness)
      // Only the Stop hook's: a Notification repeats it (idle_prompt) or asks for a permission.
      if (p.hook_event !== "Stop") return;
      const question = p.question;
      void this.enqueue(() =>
        this.openInboxItemNow(
          itemForHandoff(agent, seq, question, this.sessionSurface(agent, p), at),
        ),
      );
    } else if (
      (env.type === "activity" && p.msg === PROMPT_RECEIVED) ||
      (env.type === "resumed" && p.hook_event === "UserPromptSubmit")
    ) {
      void this.enqueue(async () => {
        await this.closeOpenItems(agent, "handoff", "answered in its terminal");
        // A picker interrupted with Esc / Ctrl-C ends no turn: the next prompt is past it.
        await this.closeOpenItems(agent, "picker", "dismissed in its terminal");
      });
    } else if (env.type === "idle" && p.hook_event === "Stop") {
      // Only a turn's end: a Notification's idle (agent_completed) is a background subagent.
      void this.enqueue(() => this.closeOpenItems(agent, "picker", "dismissed in its terminal"));
    }
  }

  /**
   * Where `agent`'s screen is: a supervised agent's workspace on its host, else the workspace
   * its hooks name (a coordinator session, on this machine).
   */
  private sessionSurface(agent: string, p: Record<string, unknown>): SessionSurface {
    const a = this.supervised.get(agent);
    if (a !== undefined) {
      return {
        wave: a.wave,
        task: a.task,
        workspace: a.workspace,
        host: a.host.name,
        machine: a.host.name === LOCAL_HOST ? this.config.localName() : a.host.name,
        supervised: true,
      };
    }
    return {
      ...(typeof p.workspace === "string" && p.workspace !== "" ? { workspace: p.workspace } : {}),
      machine: this.config.localName(),
      supervised: false,
    };
  }

  /** Close an open item with what its session's terminal answered (`where: terminal`). */
  private async closeInTerminal(id: string, answer: string): Promise<void> {
    const item = this.inbox.get(id);
    if (item === undefined) return;
    if (item.answered !== undefined) {
      // Answered here: confirmed. The hook is what the session received; a difference is logged.
      if (item.answered.answer !== answer)
        this.log(
          `inbox ${id}: answered '${item.answered.answer}' on ${whereLabel(item.answered.where)}, but its terminal reports '${answer}'`,
        );
      return;
    }
    const machine = typeof item.source.machine === "string" ? item.source.machine : undefined;
    await this.recordInboxAnswer(item, {
      version: item.version,
      answer,
      by: item.agent_id,
      where: { kind: "terminal", ...(machine !== undefined ? { machine } : {}) },
    });
  }

  /** Close `agent`'s open items of `kind` as answered in its terminal. */
  private async closeOpenItems(agent: string, kind: InboxKind, answer: string): Promise<void> {
    for (const item of [...this.inbox.values()]) {
      if (item.agent_id === agent && item.kind === kind && item.answered === undefined)
        await this.closeInTerminal(item.id, answer);
    }
  }

  /**
   * Carry out an inbox answer on its session's screen (autopilot/carry.ts), or why not: volleyd
   * cannot see a session whose workspace it does not know.
   */
  private async carryInboxAnswer(
    item: InboxItem,
    req: InboxAnswerRequest,
    carry: typeof carryPicker,
  ): Promise<string | null> {
    const a = this.supervised.get(item.agent_id);
    const source = typeof item.source.workspace === "string" ? item.source.workspace : undefined;
    let workspace = a?.workspace ?? this.registryWorkspaces.get(item.agent_id) ?? source;
    if (workspace === undefined)
      return "volleyd cannot see this session's screen: answer it in its terminal";
    if (a === undefined) {
      const holder = this.workspaceHolder(workspace, item.agent_id);
      if (holder !== null) {
        // The registry can name another session's screen (#392); the workspace the question was
        // asked from is the session's own, unless that one is someone else's too.
        const asked =
          source !== undefined &&
          source !== workspace &&
          this.workspaceHolder(source, item.agent_id) === null
            ? source
            : undefined;
        if (asked === undefined) {
          const from =
            source !== undefined && source !== workspace
              ? `; ${item.agent_id} asked from ${source}`
              : "";
          return `${workspace} is ${holder}'s screen, not ${item.agent_id}'s${from}: send the answer to its mailbox, or answer it in its terminal`;
        }
        workspace = asked;
      }
    }
    const host = a?.host ?? this.host;
    return carry(
      {
        host,
        workspace,
        readScreen: (ws) => this.readScreenBounded(ws, host),
        sleep: (ms) => new Promise((r) => this.time.setTimeout(r, ms)),
      },
      item,
      req.answer,
    );
  }

  /**
   * Who else's screen `workspace` on this machine is: a supervised agent's, or the one another
   * session's registry entry names; null when no one's. An unsupervised session names its own
   * workspace, so it must not name someone else's and have its answer typed there.
   */
  private workspaceHolder(workspace: string, agent: string): string | null {
    for (const [id, a] of this.supervised) {
      if (a.host.name === LOCAL_HOST && a.workspace === workspace) return id;
    }
    for (const [id, ws] of this.registryWorkspaces) {
      // Registry entries outlive their sessions: a gone session's workspace is free again.
      const status = this.statusOf.get(id)?.type;
      if (id !== agent && ws === workspace && (status === undefined || !OWNER_GONE.has(status)))
        return id;
    }
    return null;
  }

  /** The referee accepted an answer: journal `inbox_answered`, keep and publish the record. */
  private async recordInboxAnswer(item: InboxItem, req: InboxAnswerRequest): Promise<InboxItem> {
    const r = answerEvent(item, req, dateOf(this.time));
    if ("refused" in r) throw new Error(r.refused);
    this.inbox.set(item.id, r.item);
    await this.journalInbox(item, r.event);
    await this.publishInboxItem(r.item);
    this.log(`inbox ${item.id} answered on ${whereLabel(req.where)} by ${req.by}: ${req.answer}`);
    return r.item;
  }

  /** An inbox event goes to the item's wave journal, else `_system`. */
  private async journalInbox(item: InboxItem, ev: NewEvent): Promise<void> {
    if (item.wave !== undefined && this.waves.has(item.wave)) await this.append(item.wave, ev);
    else await this.appendSystem(ev);
  }

  private async publishInboxItem(item: InboxItem): Promise<void> {
    await this.publish(
      inboxTopic(item.id),
      this.envelope(INBOX_CHANNEL, inboxEnvelopeType(item), item),
      true,
    );
  }

  /** The inbox item mirroring a decision; `owner_only` from the wave's `autopilot.owner_only`. */
  private async openDecisionItem(wave: WaveId, d: DecisionRecord): Promise<void> {
    const agent = (d as { agent_id?: unknown }).agent_id;
    await this.openInboxItemNow(
      itemForDecision(
        { ...decisionPayload(d), ...(typeof agent === "string" ? { agent_id: agent } : {}) },
        this.config.effective(wave).autopilot,
      ),
    );
  }

  /**
   * A decision was resolved: its open item is answered at its current version. `where` is
   * autopilot for volleyd's own answers, else the request's (default: the CLI).
   */
  private async closeDecisionItem(
    wave: WaveId,
    d: DecisionRecord,
    r: { by: string; where?: InboxWhere },
  ): Promise<void> {
    const item = this.inbox.get(decisionItemId(wave, d.decision_id));
    if (item === undefined || item.answered !== undefined || d.resolved === undefined) return;
    const where: InboxWhere =
      r.by === DAEMON_AGENT_ID ? { kind: "autopilot" } : (r.where ?? { kind: "cli" });
    await this.recordInboxAnswer(item, {
      version: item.version,
      answer: d.resolved.answer,
      by: r.by,
      where,
    });
  }

  /** Clear the answered items whose `autopilot.inbox_answered_ttl_s` has passed. */
  private async sweepInbox(): Promise<void> {
    for (const item of [...this.inbox.values()]) {
      const wave = item.wave !== undefined && this.waves.has(item.wave) ? item.wave : undefined;
      const ttl = this.config.effective(wave).autopilot.inbox_answered_ttl_s;
      if (!ttlExpired(item, this.now(), ttl)) continue;
      this.inbox.delete(item.id);
      await this.clearRetained(inboxTopic(item.id));
    }
  }

  /** `inbox`: the open items (with `all: true`, answered ones not yet cleared too), oldest first. */
  private listInbox(p: Record<string, unknown>): HandlerResult {
    const items = [...this.inbox.values()]
      .filter((i) => p.all === true || i.answered === undefined)
      .sort((a, b) => a.opened_at.localeCompare(b.opened_at));
    return { ok: true, result: { items, now: dateOf(this.time).toISOString() } };
  }

  /**
   * `inbox_answer { id, version, answer, where }`: on the mailbox, the owner (or its bound
   * session); on a Desk login's own account-op topic, that login (`opts.desk_login`, never read
   * from the payload).
   */
  private async inboxAnswerOp(
    p: Record<string, unknown>,
    by: string,
    opts: { desk_login?: true } = {},
  ): Promise<HandlerResult> {
    if (typeof p.id !== "string" || p.id === "")
      return { ok: false, error: "inbox_answer requires payload.id" };
    if (typeof p.version !== "number" || !Number.isInteger(p.version))
      return { ok: false, error: "inbox_answer requires an integer payload.version" };
    if (typeof p.answer !== "string")
      return { ok: false, error: "inbox_answer requires payload.answer" };
    const where = parseWhere(p.where);
    if (where === null)
      return { ok: false, error: "where.kind must be desk, terminal, cli or autopilot" };
    // Only volleyd answers as autopilot.
    if (where.kind === "autopilot")
      return { ok: false, error: "only the supervisor answers as autopilot" };
    const r = await this.answerInboxItemNow(p.id, {
      version: p.version,
      answer: p.answer,
      by,
      where,
      ...(opts.desk_login === true ? { desk_login: true as const } : {}),
    });
    if ("refused" in r)
      return {
        ok: false,
        error: r.refused,
        ...(r.code !== undefined ? { code: r.code } : {}),
      };
    return { ok: true, result: r.item };
  }

  private async publishDecision(wave: WaveId, d: DecisionRecord): Promise<void> {
    await this.publish(
      decisionTopic(wave, d.decision_id),
      this.envelope("_waves/decisions", "decision_opened", decisionPayload(d)),
      true,
    );
  }

  // -------------------------------------------------------------------------------------------
  // Control ops
  // -------------------------------------------------------------------------------------------

  private async onMailbox(topic: string, raw: string): Promise<void> {
    const ns = topic.split("/")[1] ?? "";
    if (ns.startsWith("_")) return; // `+` also matches the reserved levels; no mailbox lives there
    // Mailbox messages are never retained (SPEC §4.1): clear a stray one in each namespace once,
    // so it is not replayed on every start (the daemon's own namespace is cleared in connect()).
    if (!this.clearedMailboxes.has(topic)) {
      this.clearedMailboxes.add(topic);
      await this.broker.publish(topic, "", { qos: 1, retain: true });
    }
    const req = parseEnvelope(raw);
    if (req === null || !isValidAgentId(req.agent_id)) return;
    // A SPEC §4.4 ack of a message the daemon sent (steer): the recipient received it, in
    // whichever namespace its wave put it.
    if (req.type === "ack") {
      if (req.correlation_id !== null) {
        this.acks.received(req.correlation_id, req.agent_id);
        this.mailboxHeard(req.correlation_id, req.agent_id);
      }
      return;
    }
    // Control queries only from our own namespace: another daemon on this broker answers its own.
    if (req.type !== "query" || ns !== this.opts.namespace) return;
    // An ack MUST carry the request's correlation_id (SPEC §4.4); without one there is no
    // answer the sender could match, so the request is dropped.
    if (req.correlation_id === null) {
      this.log(`dropped control query from ${req.agent_id}: no correlation_id`);
      return;
    }
    const key = `${req.agent_id}/${req.correlation_id}`;
    const correlationId = req.correlation_id;
    const payload = (req.payload ?? {}) as Record<string, unknown>;
    const op = typeof payload.op === "string" ? payload.op : "";
    // The answer goes to the sender's mailbox in our namespace (where the request came from).
    const send = (reply: ControlResponse) =>
      this.publish(
        buildTopic(this.opts.namespace, req.agent_id, "mailbox"),
        this.envelope("mailbox", "ack", reply, correlationId),
        false,
      );
    // A redelivery of a request whose deferred answer is still pending gets that answer.
    if (this.deferred.has(key)) return;
    const prior = this.answered.get(key);
    if (prior !== undefined) return send(prior);
    let res: HandlerResult;
    try {
      res = await this.handle(op, payload, req);
    } catch (e) {
      res = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    // "ACKED" means received, not obeyed (SPEC §4.4); the outcome is in ok/applied/error.
    const answer = (r: Reply): ControlResponse => {
      const reply: ControlResponse = { text: "ACKED", acked_type: "query", op, ...r };
      this.answered.set(key, reply);
      if (this.answered.size > DAEMON_DEFAULTS.dedupe_max) {
        this.answered.delete(this.answered.keys().next().value as string);
      }
      return reply;
    };
    const { defer, ...now } = res;
    if (defer === undefined) return send(answer(now));
    // A deferred answer (steer waiting for its ack) must not hold the serial queue.
    this.deferred.add(key);
    void defer
      .catch(
        (e: unknown): Reply => ({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      )
      .then(async (r) => {
        this.deferred.delete(key);
        if (this.running) await send(answer(r));
      })
      .catch((e: unknown) => this.log(`error: ${String(e)}`));
  }

  /**
   * The newest `wall_time` of every agent id's retained registry entry and retained status (where
   * its LWT lands), by agent id: account_list's `last_seen`.
   */
  private async registrySeen(): Promise<Map<string, string>> {
    const scan = (filter: string) =>
      this.broker.subscribeCollect(
        filter,
        Number.POSITIVE_INFINITY,
        DAEMON_DEFAULTS.registry_scan_ms,
      );
    const msgs = (
      await Promise.all([scan("volley/_system/registry/+"), scan("volley/+/+/status")])
    ).flat();
    const seen = new Map<string, string>();
    for (const m of msgs) {
      const env = m.payload === "" ? null : parseEnvelope(m.payload);
      if (env === null) continue;
      const prior = seen.get(env.agent_id);
      if (prior === undefined || env.wall_time > prior) seen.set(env.agent_id, env.wall_time);
    }
    return seen;
  }

  /**
   * Drop expired one-time token logins: `volley auth list` prunes them before it lists. Runs on a
   * timer because a token nobody redeems would otherwise stay a broker login (that can read the
   * whole tree) until the next `volley auth` command.
   */
  private async pruneTokens(): Promise<void> {
    const r = await listAccounts(this.opts.authExec ?? realExec);
    const error = typeof r === "string" ? r : null;
    if (error !== null && error !== this.pruneError) this.log(`token prune: ${error}`);
    this.pruneError = error;
  }

  /**
   * An account op (`volley/_system/auth/ops/<username>`, answered on
   * `volley/_system/auth/replies/<correlation_id>`) or a token redemption
   * (`volley-auth/redeem/<id>`, answered on `volley-auth/redeem/<id>/reply`, the one topic that
   * token's login may read). The broker ACL lets only an admin account or a Desk login write its
   * own ops topic, so the topic names the sender; accounts.ts checks that account's role again,
   * per op.
   */
  private async onAuthRequest(topic: string, raw: string): Promise<void> {
    if (raw === "") return; // our own clear (below), or anyone's
    // Requests are never retained: clear the topic after each one (auth ops are rare), or a
    // request published retained would be replayed at every daemon start (an `account_rotate`
    // would rotate that password again each time). Anything live on it was delivered already.
    await this.broker.publish(topic, "", { qos: 1, retain: true });
    const req = parseEnvelope(raw);
    if (req === null || req.type !== "query") return;
    const cid = req.correlation_id;
    if (cid === null || !isValidCorrelationId(cid)) {
      this.log(`dropped auth request on ${topic}: no usable correlation_id`);
      return;
    }
    const tokenId = topic.startsWith("volley-auth/") ? (topic.split("/")[2] ?? "") : null;
    const replyTo = tokenId !== null ? tokenReplyTopic(tokenId) : authReplyTopic(cid);
    const send = (r: AuthReply) =>
      this.publish(replyTo, this.envelope(AUTH_CHANNEL, "ack", r, cid), false);
    const key = `${topic}/${cid}`;
    const prior = this.authAnswered.get(key);
    if (prior !== undefined) return send(prior);
    // A redelivery of a request still running (peer_doctor): its answer comes when the run ends.
    if (this.authRunning.has(key)) return;
    const payload = (req.payload ?? {}) as Record<string, unknown>;
    if (tokenId === null && SETUP_OPS.has(payload.op as string)) {
      // A step can take minutes (the Desk build): answered beside the queue, never blocking it.
      if (this.setupInFlight.has(key)) return;
      this.setupInFlight.add(key);
      void this.answerSetup(topic.split("/")[4] ?? "", payload, key, send)
        .catch((e: unknown) => this.log(`setup op: ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => this.setupInFlight.delete(key));
      return;
    }
    const exec = this.opts.authExec ?? realExec;
    const failed = (e: unknown): AuthOutcome => ({
      reply: {
        text: "ACKED",
        acked_type: "query",
        op: typeof payload.op === "string" ? payload.op : "",
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      },
    });
    const finish = async (o: AuthOutcome & { journal?: NewEvent }) => {
      if (o.event !== undefined) this.system.append(o.event, dateOf(this.time));
      if (o.journal !== undefined) await this.appendSystem(o.journal);
      if (!o.reply.ok) this.log(`refused ${o.reply.op || "auth request"}: ${o.reply.error}`);
      this.authAnswered.set(key, o.reply);
      if (this.authAnswered.size > DAEMON_DEFAULTS.dedupe_max) {
        this.authAnswered.delete(this.authAnswered.keys().next().value as string);
      }
      await send(o.reply);
    };
    let out: AuthOutcome | DeferredAuth;
    try {
      if (tokenId !== null) {
        out = await redeemToken(exec, tokenId, payload);
      } else {
        const sender = topic.split("/")[4] ?? "";
        this.authSeen.set(sender, dateOf(this.time).toISOString());
        const registry = payload.op === "account_list" ? await this.registrySeen() : new Map();
        // The later of the account's last auth request and its registry entry (an agent id).
        const lastSeen = (name: string) =>
          [this.authSeen.get(name), registry.get(name)]
            .filter((t): t is string => t !== undefined)
            .sort()
            .pop();
        out = DESK_OPS.has(payload.op as string)
          ? await this.deskOp(exec, sender, payload)
          : PEER_ADMIN_OPS.has(payload.op as string)
            ? await this.peerAdminOp(exec, sender, payload)
            : await accountOp(
                exec,
                sender,
                payload,
                lastSeen,
                new Date(this.startedAt).toISOString(),
              );
      }
    } catch (e) {
      out = failed(e);
    }
    if ("later" in out) {
      // Outside the queue: only the answer (and its journal record) goes back through it.
      const { later } = out;
      this.authRunning.add(key);
      void later()
        .catch(failed)
        .then((o) =>
          this.enqueue(async () => {
            this.authRunning.delete(key);
            if (this.running) await finish(o);
          }),
        );
      return;
    }
    await finish(out);
  }

  /**
   * `setup_plan` / `setup_apply` from `sender`: answered, journaled, remembered for a
   * re-delivery like every account op; then what runs after the answer (a broker restart).
   */
  private async answerSetup(
    sender: string,
    payload: Record<string, unknown>,
    key: string,
    send: (r: AuthReply) => Promise<void>,
  ): Promise<void> {
    this.authSeen.set(sender, dateOf(this.time).toISOString());
    let out: SetupOutcome;
    try {
      out = await this.setupOps.handle(sender, payload);
    } catch (e) {
      out = {
        reply: authReply(String(payload.op), {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        }),
      };
    }
    if (out.event !== undefined) this.system.append(out.event, dateOf(this.time));
    if (!out.reply.ok) this.log(`refused ${out.reply.op}: ${out.reply.error}`);
    this.authAnswered.set(key, out.reply);
    if (this.authAnswered.size > DAEMON_DEFAULTS.dedupe_max) {
      this.authAnswered.delete(this.authAnswered.keys().next().value as string);
    }
    try {
      await send(out.reply);
    } finally {
      // The restart drops every connection, ours included: only once the answer is out.
      if (out.after !== undefined) {
        this.log("setup: restarting the broker after the answer");
        await out.after();
      }
    }
  }

  /** Agents with a live (non-terminal) retained status: the setup detect step's count. */
  private async liveAgentCount(): Promise<number | null> {
    try {
      const msgs = await this.broker.subscribeCollect(
        "volley/+/+/status",
        Number.POSITIVE_INFINITY,
        DAEMON_DEFAULTS.registry_scan_ms,
      );
      return countLiveAgents(msgs);
    } catch {
      return null;
    }
  }

  /**
   * A Desk login's Needs-you answer (`inbox_answer`, `resolve`; SPEC §4.6.18) from `sender`, the
   * username the account-op topic names: refused unless it is a Desk login, then answered as the
   * owner's, `by` the sender, with no ownership check.
   */
  private async deskOp(
    exec: ExecFn,
    sender: string,
    p: Record<string, unknown>,
  ): Promise<AuthOutcome> {
    const op = p.op as string;
    // The fixed `desk` identity has no account entry: no lookup, so a failing tool cannot refuse it.
    if (sender !== "desk") {
      const accounts = await listAccounts(exec);
      const why = typeof accounts === "string" ? accounts : deskRefusal(accounts, sender);
      if (why !== undefined) return { reply: authReply(op, { ok: false, error: why }) };
    }
    const desk = { desk_login: true } as const;
    const r =
      op === "inbox_answer"
        ? await this.inboxAnswerOp(p, sender, desk)
        : op === "hold"
          ? await this.holdOp(p, sender, desk)
          : op === "release"
            ? await this.releaseOp(p, sender, desk)
            : await this.resolveOp(p, sender, desk);
    return { reply: authReply(op, r) };
  }

  /**
   * `peer_invite` / `peer_remove` (SPEC §4.6.14) from `sender`, the username the account-op topic
   * names: the account ops' admin check, then peers.ts (which journals them itself).
   */
  private async peerAdminOp(
    exec: ExecFn,
    sender: string,
    p: Record<string, unknown>,
  ): Promise<AuthOutcome | DeferredAuth> {
    const op = p.op as string;
    const accounts = await listAccounts(exec);
    const why = typeof accounts === "string" ? accounts : adminRefusal(accounts, sender);
    if (why !== undefined) return { reply: authReply(op, { ok: false, error: why }) };
    if (op === "peer_doctor") return this.peerDoctor(p, sender);
    if (op === "archive") {
      const wave = typeof p.wave === "string" ? p.wave : "";
      const r = this.archived.has(wave)
        ? { ok: false, error: `wave '${wave}' is archived already` }
        : await this.archiveAs(wave, sender, ADMIN_REASON, p.dry_run === true);
      return { reply: authReply(op, r) };
    }
    const r =
      op === "peer_invite"
        ? await this.peers.invite(p, sender)
        : await this.peers.remove(p, sender);
    // remove-now (F6): its agents are told to stop now; the sweep finishes the removal.
    if (op === "peer_remove" && r.ok && (r.result as { removing?: string }).removing === "now")
      await this.evict(p.name as string, sender);
    const { rejected: _r, ...answer } = r;
    return { reply: authReply(op, answer) };
  }

  private async handle(
    op: string,
    p: Record<string, unknown>,
    req: Envelope,
  ): Promise<HandlerResult> {
    const by = typeof p.by === "string" && p.by !== "" ? p.by : req.agent_id;
    switch (op) {
      case "decisions":
        return this.listDecisions(p);
      case "policy":
        return this.policyOp(p);
      case "digest":
        return this.digestOp(p);
      case "resolve":
        return this.resolveOp(p, by);
      case "inbox":
        return this.listInbox(p);
      case "inbox_answer":
        return this.inboxAnswerOp(p, by);
      case "hold":
        return this.holdOp(p, by);
      case "release":
        return this.releaseOp(p, by);
      case "claim":
        // Ownership must go to a stable identity, never the CLI's per-invocation agent id.
        if (typeof p.by !== "string" || p.by === "")
          return {
            ok: false,
            error:
              "claim needs an identity: pass --by <name|agent-id> or set VOLLEY_COORDINATOR or VOLLEY_AGENT_ID",
          };
        // The new owner lands in the wave-state `owner` (agent id pattern): never a free-form name.
        if (!isValidAgentId(p.by))
          return {
            ok: false,
            error: `"${p.by}" is not a valid agent id ([a-z0-9][a-z0-9_-]{0,62})`,
          };
        return this.claim(p, p.by);
      case "pause":
      case "resume":
      case "stop":
        return this.waveControl(op, p, by);
      case "archive":
        return this.archiveOp(p, by);
      case "steer":
        return this.steer(p, by);
      case "merged":
        return this.mergedOp(p, by);
      case "merge":
        return this.mergeOp(p, by);
      case "status": {
        if (typeof p.wave === "string") {
          const state = this.snapshot(p.wave) ?? this.archivedSnapshot(p.wave);
          return state === null
            ? { ok: false, error: `unknown wave '${p.wave}'` }
            : { ok: true, result: state };
        }
        return {
          ok: true,
          result: {
            waves: [
              ...[...this.waves.keys()].map((w) => this.snapshot(w)),
              // `--all`: archived waves too, after the live ones.
              ...(p.all === true
                ? [...this.archived.keys()].map((w) => this.archivedSnapshot(w))
                : []),
            ],
            ...(this.killSwitch ? { kill_switch: true } : {}),
            ceiling: { live: this.ceilingCount().live, max: this.config.effective().hard_ceiling },
            // The cached count: status never waits on the broker's control connection.
            ...(this.sweeper !== undefined ? { agent_logins: { ...this.sweeper.counts } } : {}),
            // The own machine's local_agents mode, as its last verdict said (SPEC §4.6.15),
            // once it has a peer to weigh (a lone machine has no fallback to speak of).
            ...(this.ownLocalAgents !== undefined &&
            Object.keys(this.config.effective().hosts).length > 0
              ? { local_agents: this.ownLocalAgents }
              : {}),
          },
        };
      }
      case "run":
        return this.submit(p);
      case "diff":
        return this.planDiff(p);
      case "admission":
        if (typeof p.wave === "string" && !this.waves.has(p.wave))
          return { ok: false, error: `unknown wave '${p.wave}'` };
        return {
          ok: true,
          result: this.summary === null ? null : { ...this.summary, ceiling: this.ceilingView() },
        };
      case "spawn":
        return this.manualSpawn(p);
      // Claude account profiles (src/claude/service.ts); a sign-in answers once its URL is known.
      case "claude_accounts":
        return { ok: true, defer: this.claude.list() };
      case "claude_balance":
        return this.claude.balance(p, Object.keys(this.config.effective().hosts));
      case "claude_account_add":
        return { ok: true, defer: this.claude.add(p, by) };
      case "claude_signin":
        return { ok: true, defer: this.claude.signin(p, by) };
      case "claude_sync":
        return this.claude.sync(p, by);
      case "agent_move_account":
        return { ok: true, defer: this.moveAccount(p, by) };
      // Machines + pairing (peers.ts): the code is a join's credential; the reply_key's holder
      // gets the secret. Invite and remove are admin ops, answered only on the account-op topic.
      case "peer_join":
        return this.peers.join(p, by);
      case "peers":
        return this.peers.list();
      case "config_get": {
        const wave = typeof p.wave === "string" ? p.wave : undefined;
        if (wave !== undefined && !this.waves.has(wave))
          return { ok: false, error: `unknown wave '${wave}'` };
        const path = typeof p.path === "string" ? p.path : undefined;
        const value = this.config.get(path, wave);
        if (value === undefined) return { ok: false, error: `unknown config path '${path}'` };
        return {
          ok: true,
          result: path === undefined && wave === undefined ? this.config.retainedPayload() : value,
        };
      }
      case "config_set": {
        // The whole request must match config-set-request.schema.json (text, by, a non-empty
        // patch); patch errors are reported relative to the patch, like applyPatch's.
        const check = validator("config-set-request.schema.json");
        if (!check(req)) {
          const rejected = toPathErrors(check.errors).map((e) => ({
            ...e,
            path: e.path.startsWith("payload.patch.")
              ? e.path.slice("payload.patch.".length)
              : e.path === "payload.patch"
                ? "(root)"
                : e.path,
          }));
          return { ok: false, applied: false, rejected };
        }
        const r = this.config.applyPatch(p.patch as TunablesPatch, p.by as string);
        return {
          ok: r.applied,
          applied: r.applied,
          rejected: r.rejected,
          result: { version: r.version },
        };
      }
      case "account_list":
      case "account_create":
      case "account_rotate":
      case "account_revoke":
      case "signin_link":
      case "token_redeem":
      case "peer_invite":
      case "peer_remove":
      case "peer_doctor":
        // The mailbox does not name its sender (anyone who steers can write it).
        return {
          ok: false,
          error: `${op} is answered only on volley/_system/auth/ops/<your username> (token_redeem: volley-auth/redeem/<token id>)`,
        };
      default:
        return { ok: false, error: `unknown op '${op}'` };
    }
  }

  /**
   * `run`: validate the wave file again (the daemon is authoritative), journal it, queue tasks.
   * For a wave already submitted, the file is its next version (`resubmit`).
   */
  private async submit(p: Record<string, unknown>): Promise<HandlerResult> {
    const first = this.checkSubmit(p);
    if ("refusal" in first) return first.refusal;
    const preface = this.briefPreface(first.wave);
    if ("refusal" in preface) return preface.refusal;
    const playbook = this.playbookRefusal(first.wave);
    if (playbook !== null) return playbook;
    const missing = await this.releaseBranchMissing(first.wave);
    if (missing !== null) return { ok: false, error: missing };
    const text = p.wave_yaml as string;
    const fetchFiles = first.existing === undefined && this.opts.issueBody !== undefined;
    if (!fetchFiles && !this.readsRepo()) {
      const visibility = await this.repoVisibility(first.wave);
      return first.existing !== undefined
        ? this.resubmit(first.existing, first.wave, text, preface, visibility)
        : this.commitSubmit(first.wave, first.owner, {}, text, preface, visibility);
    }
    // Fetching issue bodies and the repo's visibility can take seconds: do it off the serial
    // queue (control ops and ticks, the kill switch included, keep running), then commit inside
    // it, re-checking what may have changed meanwhile (the kill switch, a racing submit of the
    // same wave id).
    return {
      ok: true,
      defer: Promise.all([
        fetchFiles ? this.fetchIssueFiles(first.wave) : {},
        this.repoVisibility(first.wave),
      ]).then(([files, visibility]) =>
        this.serial(async () => {
          // The daemon may have stopped (and released the home lock) while the fetch ran.
          if (!this.running) return { ok: false, error: "daemon stopping" };
          const again = this.checkSubmit(p);
          if ("refusal" in again) return again.refusal;
          if (again.existing !== undefined)
            return this.resubmit(again.existing, again.wave, text, preface, visibility);
          return this.commitSubmit(again.wave, again.owner, files, text, preface, visibility);
        }),
      ),
    };
  }

  /** The wave's `public_hygiene` as submitted: its `config:` override, else the global value. */
  private publicHygiene(wave: Wave): PublicHygiene {
    return wave.config.public_hygiene ?? this.config.effective().public_hygiene;
  }

  /**
   * Whether submitting a wave runs `gh repo view`: on a daemon that spawns agents (one that
   * spawns none writes no reviewer briefs and links nothing).
   */
  private readsRepo(): boolean {
    return this.opts.spawner !== undefined;
  }

  /**
   * The `repo_visibility_detected` facts for a wave version, read with `gh repo view`: under
   * `auto` the visibility (`unknown` on any failure), under `on` / `off` the visibility from
   * config; in every mode the repository's `github` name and URL when gh gave them. Null: not
   * recorded (a daemon without a spawner); the wave's hygiene level is then p1.
   */
  private async repoVisibility(wave: Wave): Promise<VisibilityFacts | null> {
    if (!this.readsRepo()) return null;
    const mode = this.publicHygiene(wave);
    const view = await readRepoView(this.host.exec, expandHome(wave.repo));
    const github = view.github !== undefined ? { github: view.github } : {};
    if (mode !== "auto")
      return { visibility: null, source: "config", public_hygiene: mode, ...github };
    return { visibility: view.visibility, source: "gh", public_hygiene: mode, ...github };
  }

  /** Journal a wave version's visibility, and the alarm when it could not be read. */
  private async journalVisibility(wave: WaveId, facts: VisibilityFacts | null): Promise<void> {
    if (facts === null) return;
    await this.append(wave, { type: "repo_visibility_detected", data: { ...facts } });
    if (facts.visibility === "unknown") {
      await this.append(wave, {
        type: "alarm_raised",
        data: { alarm: "repo_visibility_unknown" },
      });
    }
  }

  /**
   * The wave's brief preface as its agents will get it (`info: null`: no file, `path` says where
   * it was looked for), or BRIEF_PREFACE_TOO_LARGE over `brief_preface_max_bytes` (the wave's
   * `config:` override, else the global value).
   */
  private briefPreface(
    wave: Wave,
  ): { info: BriefPrefaceInfo | null; path: string } | { refusal: Reply } {
    const path = briefPrefacePath(wave.repo, wave.brief_preface);
    const max =
      wave.config.brief_preface_max_bytes ?? this.config.effective().brief_preface_max_bytes;
    try {
      return { info: prefaceInfo(readBriefPreface(path, max)), path };
    } catch (e) {
      if (e instanceof BriefPrefaceTooLarge) return { refusal: { ok: false, error: e.message } };
      throw e;
    }
  }

  /**
   * RELEASE_PLAYBOOK_INVALID (with its path-qualified errors) when the wave's release playbook
   * (SPEC §4.6.19) does not validate, or is configured and missing; null when it is fine or none.
   */
  private playbookRefusal(wave: Wave): Reply | null {
    try {
      wavePlaybook(wave);
      return null;
    } catch (e) {
      if (e instanceof PlaybookError) return { ok: false, error: e.message, errors: e.errors };
      throw e;
    }
  }

  /**
   * RELEASE_BRANCH_MISSING when the wave's repo has its release branch neither locally nor as
   * `origin/<branch>` once it is fetched (a branch pushed from another clone counts), so a wave
   * whose every spawn would fail is refused before any task is admitted. Checked only where
   * volleyd spawns into that repo: with a spawner, and a task on the local host (a remote host's
   * clone is fetched and checked on the box). With require_fresh_base on, also BASE_STALE when no
   * spawn could get a fresh base (no `origin` remote, or a branch origin does not have), instead
   * of admitting tasks that would each retry a refusal for the whole spawn backoff.
   */
  private async releaseBranchMissing(wave: Wave): Promise<string | null> {
    if (this.opts.spawner === undefined || !spawnsLocally(wave)) return null;
    const repo = expandHome(wave.repo);
    const fetchError = await fetchRelease(this.host.exec, repo, wave.release_branch);
    const missing = await checkReleaseBranch(this.host.exec, repo, wave.release_branch);
    if (missing !== null) return missing;
    // --- Fleet fresh base (SPEC §4.6.15): no origin, or a branch never pushed, is refused now. ---
    const fresh = wave.config.require_fresh_base ?? this.config.effective().require_fresh_base;
    return fresh ? checkFreshBase(this.host.exec, repo, wave.release_branch, fetchError) : null;
  }

  /**
   * `run`'s validation: the parsed wave, its owner and — for a wave id already submitted — its
   * log (the file is then a new version), or the refusal.
   */
  private checkSubmit(
    p: Record<string, unknown>,
  ): { wave: Wave; owner: string | null; existing?: WaveLog } | { refusal: Reply } {
    const refuse = (r: Reply) => ({ refusal: r });
    if (this.killSwitch) {
      return refuse({
        ok: false,
        error: `${KILL_SWITCH_REASON}: new runs are refused until \`volleyd resume --all\``,
      });
    }
    const owner = typeof p.owner === "string" && p.owner !== "" ? p.owner : null;
    if (owner !== null && !isValidAgentId(owner))
      return refuse({ ok: false, error: `owner '${owner}' is not a valid agent id` });
    const wave = this.parseRequestWave(p, "run");
    if ("ok" in wave) return refuse(wave);
    const merged = this.config.waveOverrideErrors(wave.config);
    if (merged.length > 0) {
      return refuse({
        ok: false,
        error: merged.map((e) => `${e.path}: ${e.reason}`).join("; "),
        errors: merged,
      });
    }
    // Its journal is kept: a second wave_submitted would be appended to an archived wave.
    if (this.archived.has(wave.wave))
      return refuse({ ok: false, error: `wave '${wave.wave}' is archived; pick another id` });
    const log = this.waves.get(wave.wave);
    const existing = log?.record.state;
    if (log === undefined || existing == null) return { wave, owner };
    if (existing.owner !== null && owner !== null && this.actsAs(owner, existing.owner))
      return { wave, owner: existing.owner, existing: log };
    if (existing.owner !== null && existing.owner !== owner) {
      return refuse({
        ok: false,
        error: `wave '${wave.wave}' is already ${existing.status} under owner ${existing.owner}`,
      });
    }
    return { wave, owner, existing: log };
  }

  /**
   * What a wave file without `placement:` takes: `placement.default` once a machine is paired
   * (SPEC §4.6.15). Decided when the wave is first submitted: a later plan version of a known
   * wave keeps the placement its current plan has, so pairing or unpairing a machine mid-wave
   * never moves a running task's next role. (`paired: 1` only lets that kept placement resolve
   * as `auto`; a version's own `placement:` still wins over it, its `config: placement.default`
   * does not.)
   */
  private placementDefaults(wave?: WaveId): PlacementDefaults {
    const rec = wave === undefined ? undefined : this.waves.get(wave)?.record;
    const current = rec?.plan ?? rec?.wave;
    if (current != null) return { default: current.placement ?? "local", paired: 1, kept: true };
    const cfg = this.config.effective();
    const local = this.config.localName();
    return {
      default: cfg.placement.default,
      paired: Object.keys(cfg.hosts).filter((n) => n !== local).length,
    };
  }

  /** Parse a request's `wave_yaml`; a Reply when it is missing or invalid. */
  private parseRequestWave(p: Record<string, unknown>, op: string): Wave | Reply {
    if (typeof p.wave_yaml !== "string")
      return { ok: false, error: `${op} requires payload.wave_yaml` };
    const source = typeof p.source === "string" ? p.source : undefined;
    try {
      const wave = parseWaveFile(p.wave_yaml, source, this.placementDefaults());
      // A known wave: parsed again under its own placement (the file's own placement: still wins).
      return this.waves.get(wave.wave)?.record.wave == null
        ? wave
        : parseWaveFile(p.wave_yaml, source, this.placementDefaults(wave.wave));
    } catch (e) {
      if (e instanceof WaveFileError) return { ok: false, error: e.message, errors: e.errors };
      throw e;
    }
  }

  /** Where version N of a wave file is stored: `<home>/waves/<wave>/v<N>.yaml`. */
  private versionFile(wave: WaveId, version: number): string {
    return join(this.opts.home, "waves", wave, `v${version}.yaml`);
  }

  private storeVersion(file: string, text: string): void {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }

  /**
   * Journal a checked wave as plan v1 (the daemon numbers versions; the file's own `version:` is
   * informational), its tasks (with their issues' Files lists) and overlap warnings.
   */
  private async commitSubmit(
    submitted: Wave,
    owner: string | null,
    issueFiles: Record<TaskId, string[]>,
    text: string,
    preface: { info: BriefPrefaceInfo | null; path: string },
    visibility: VisibilityFacts | null,
  ): Promise<Reply> {
    const wave: Wave = { ...submitted, version: 1 };
    const log = WaveLog.open(join(this.opts.home, "waves", wave.wave));
    this.waves.set(wave.wave, log);
    this.observeJournal(wave.wave, log.journal);
    this.issueFiles.set(wave.wave, issueFiles);
    this.config.setWaveOverrides(wave.wave, wave.config);
    this.storeVersion(this.versionFile(wave.wave, 1), text);
    await this.append(wave.wave, {
      type: "wave_submitted",
      data: { wave, owner, brief_preface: preface.info },
    });
    await this.journalVisibility(wave.wave, visibility);
    if (preface.info === null) {
      await this.append(wave.wave, {
        type: "alarm_raised",
        data: { alarm: "brief_preface_missing", path: preface.path },
      });
    }
    for (const id of wave.task_order) {
      const files = issueFiles[id];
      await this.append(wave.wave, {
        type: "task_queued",
        task: id,
        data: {
          issue: wave.tasks[id]?.issue,
          ...(files !== undefined && files.length > 0 ? { issue_files: files } : {}),
        },
      });
    }
    const warnings: string[] = [];
    for (const w of this.overlaps(wave.wave)) {
      await this.append(wave.wave, {
        type: "alarm_raised",
        task: w.tasks[0].task,
        data: { alarm: "overlap_warning", paths: w.paths, tasks: w.tasks },
      });
      warnings.push(formatOverlap(w));
    }
    this.evaluate(); // its verdict from the last sample, before its first admission
    await this.tickNow();
    this.log(
      `submitted wave ${wave.wave} (${wave.task_order.length} tasks, owner ${owner ?? "-"})`,
    );
    for (const w of warnings) this.log(w);
    return {
      ok: true,
      result: this.snapshot(wave.wave),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  /**
   * Each task issue's `Files` section (best effort, in parallel). Advisory: it feeds the overlap
   * warning only, and is journaled on `task_queued` — never written into the wave definition.
   */
  private async fetchIssueFiles(
    wave: ReturnType<typeof parseWaveFile>,
  ): Promise<Record<TaskId, string[]>> {
    const fetch = this.opts.issueBody;
    const out: Record<TaskId, string[]> = {};
    if (fetch === undefined) return out;
    await Promise.all(
      Object.entries(wave.tasks).map(async ([id, t]) => {
        const body = await fetch(wave.repo, t.issue).catch(() => null);
        if (body !== null) out[id] = parseFilesSection(body);
      }),
    );
    return out;
  }

  /** Overlaps between `wave`'s tasks and the unsettled tasks of every other live wave. */
  private overlaps(wave: WaveId) {
    const files = (w: WaveId, rec: WaveRecord, unsettledOnly: boolean) =>
      (rec.state?.tasks ?? [])
        .filter((t) => !unsettledOnly || (t.stage !== "done" && t.stage !== "cancelled"))
        .map((t) => ({
          id: t.id,
          files: [
            ...new Set([
              ...(rec.wave?.tasks[t.id]?.files ?? []),
              ...(this.issueFiles.get(w)?.[t.id] ?? []),
            ]),
          ],
        }));
    const self = this.waves.get(wave)?.record;
    if (self === undefined) return [];
    const others = [...this.waves]
      .filter(([w, log]) => {
        const s = log.record.state?.status;
        return w !== wave && s !== undefined && s !== "complete" && s !== "stopped";
      })
      .map(([w, log]) => ({ wave: w, tasks: files(w, log.record, true) }));
    return findOverlaps({ wave, tasks: files(wave, self, false) }, others);
  }

  /** The wave a control op names, or a refusal. */
  private waveOf(p: Record<string, unknown>): { wave: WaveId; log: WaveLog } | { error: string } {
    if (typeof p.wave !== "string") return { error: "this op requires payload.wave" };
    if (this.archived.has(p.wave)) return { error: `wave '${p.wave}' is archived` };
    const log = this.waves.get(p.wave);
    return log === undefined ? { error: `unknown wave '${p.wave}'` } : { wave: p.wave, log };
  }

  /** `decisions`: open decisions (all with `all: true`), for one wave or every wave. */
  private listDecisions(p: Record<string, unknown>): HandlerResult {
    if (typeof p.wave === "string" && !this.waves.has(p.wave)) {
      const w = this.waveOf(p);
      return { ok: false, error: "error" in w ? w.error : `unknown wave '${p.wave}'` };
    }
    const decisions: DecisionPayload[] = [...this.waves]
      .filter(([w]) => typeof p.wave !== "string" || w === p.wave)
      .flatMap(([, log]) =>
        p.all === true ? Object.values(log.record.decisions) : openDecisions(log.record),
      )
      .map(decisionPayload);
    return { ok: true, result: { decisions } };
  }

  /** `policy`: autopilot's effective table, for the global config or one wave's (SPEC §4.6.16). */
  private policyOp(p: Record<string, unknown>): HandlerResult {
    const wave = typeof p.wave === "string" ? p.wave : undefined;
    if (wave !== undefined && !this.waves.has(wave))
      return { ok: false, error: `unknown wave '${wave}'` };
    const config = this.config.effective(wave).autopilot;
    return {
      ok: true,
      result: {
        ...(wave !== undefined ? { wave } : {}),
        config,
        rules: renderPolicyTable(POLICY_TABLE, config),
      },
    };
  }

  /**
   * `resolve`: owner-only (a Desk login on its own account-op topic is the owner: `desk_login`,
   * never read from the payload); finds the decision's wave when none is given.
   */
  private async resolveOp(
    p: Record<string, unknown>,
    by: string,
    opts: { desk_login?: true } = {},
  ): Promise<HandlerResult> {
    const id = p.decision_id;
    if (typeof id !== "string") return { ok: false, error: "resolve requires payload.decision_id" };
    if (typeof p.answer !== "string" || p.answer.trim() === "")
      return { ok: false, error: "resolve requires a non-empty payload.answer" };
    const wave =
      typeof p.wave === "string"
        ? p.wave
        : [...this.waves].find(([, log]) => log.record.decisions[id] !== undefined)?.[0];
    const state = wave !== undefined ? this.waves.get(wave)?.record.state : undefined;
    if (wave === undefined || state == null)
      return {
        ok: false,
        error: `unknown decision '${id}'${wave !== undefined ? ` in wave '${wave}'` : ""}`,
      };
    const refused =
      opts.desk_login === true ? null : guardMutation(state, by, "resolve", this.bindings);
    if (refused !== null) return { ok: false, error: refused };
    let where: InboxWhere = { kind: "cli" };
    if (p.where !== undefined) {
      const w = typeof p.where === "string" ? parseWhereLabel(p.where) : parseWhere(p.where);
      if (w === null || w.kind === "autopilot")
        return { ok: false, error: `resolve: unknown --where '${String(p.where)}'` };
      where = w;
    }
    const r = await this.answerDecision(wave, id, {
      answer: p.answer,
      by,
      where,
      ...(typeof p.rationale === "string" ? { rationale: p.rationale } : {}),
    });
    if ("refused" in r)
      return { ok: false, error: r.refused, ...(r.code !== undefined ? { code: r.code } : {}) };
    // Resolving twice stays a no-op; the answer says where the first one was given.
    const first = this.inbox.get(decisionItemId(wave, id))?.answered;
    return {
      ok: true,
      result: {
        wave,
        decision_id: id,
        already_resolved: r.already_resolved,
        resolved: r.decision.resolved,
        ...(r.already_resolved && first !== undefined
          ? { already_answered: `already answered on ${whereLabel(first.where)}` }
          : {}),
        ...(r.brief !== undefined ? { brief: r.brief } : {}),
      },
    };
  }

  // -------------------------------------------------------------------------------------------
  // Held decisions (#335): "waiting on <task|PR|issue>", never escalated, released when it lands
  // -------------------------------------------------------------------------------------------

  /**
   * The decision a hold / release op names: `decision_id` (its wave found when not given), or an
   * inbox `item` id; owner-guarded like `resolve` (a Desk login is the owner).
   */
  private heldTarget(
    op: "hold" | "release",
    p: Record<string, unknown>,
    by: string,
    opts: { desk_login?: true },
  ): { wave: WaveId; id: string } | { error: string } {
    let id = typeof p.decision_id === "string" ? p.decision_id : undefined;
    let wave = typeof p.wave === "string" ? p.wave : undefined;
    if (id === undefined && typeof p.item === "string") {
      const item = this.inbox.get(p.item);
      const source = item?.kind === "decision" ? item.source.decision_id : undefined;
      if (typeof source !== "string" || item?.wave === undefined)
        return { error: `unknown decision item '${p.item}'` };
      id = source;
      wave = item.wave;
    }
    if (id === undefined) return { error: `${op} requires payload.decision_id or payload.item` };
    const key = id;
    wave ??= [...this.waves].find(([, log]) => log.record.decisions[key] !== undefined)?.[0];
    const state = wave !== undefined ? this.waves.get(wave)?.record.state : undefined;
    if (
      wave === undefined ||
      state == null ||
      this.waves.get(wave)?.record.decisions[id] === undefined
    )
      return { error: `unknown decision '${id}'${wave !== undefined ? ` in wave '${wave}'` : ""}` };
    const refused = opts.desk_login === true ? null : guardMutation(state, by, op, this.bindings);
    return refused !== null ? { error: refused } : { wave, id };
  }

  /** `hold { decision_id | item, on, note?, wave? }`: the decision waits on `on`, held. */
  private async holdOp(
    p: Record<string, unknown>,
    by: string,
    opts: { desk_login?: true } = {},
  ): Promise<HandlerResult> {
    const t = this.heldTarget("hold", p, by, opts);
    if ("error" in t) return { ok: false, error: t.error };
    const on = heldOnFrom(p.on);
    if (on === null)
      return { ok: false, error: "hold requires payload.on: a task, #<pr> or issue#<n>" };
    const note = typeof p.note === "string" ? p.note : undefined;
    const r = await this.holdNow(t.wave, t.id, { on, by, ...(note !== undefined ? { note } : {}) });
    if ("error" in r) return { ok: false, error: r.error };
    const rec = this.waves.get(t.wave)?.record;
    return {
      ok: true,
      result: {
        wave: t.wave,
        decision_id: t.id,
        held: r.held,
        label: heldLabel(on, rec?.state?.tasks),
      },
    };
  }

  /** `release { decision_id | item, wave? }`: lift a hold by hand. */
  private async releaseOp(
    p: Record<string, unknown>,
    by: string,
    opts: { desk_login?: true } = {},
  ): Promise<HandlerResult> {
    const t = this.heldTarget("release", p, by, opts);
    if ("error" in t) return { ok: false, error: t.error };
    const r = await this.releaseNow(t.wave, t.id, `released by ${by}`, by);
    if ("error" in r) return { ok: false, error: r.error };
    return { ok: true, result: { wave: t.wave, decision_id: t.id, released: r.released } };
  }

  /** Journal `decision_held`; the decision's retained topic and inbox item carry the hold. */
  private async holdNow(
    wave: WaveId,
    id: string,
    h: { on: HeldOn; note?: string; by: string },
  ): Promise<{ held: Held } | { error: string }> {
    const log = this.waves.get(wave);
    if (log === undefined) return { error: `unknown wave '${wave}'` };
    const r = holdEvent(log.record, id, h);
    if ("error" in r) return r;
    await this.append(wave, r.event);
    const d = log.record.decisions[id] as DecisionRecord;
    await this.mirrorHeld(wave, d);
    this.log(`held ${id} on ${heldLabel(h.on, log.record.state?.tasks)} by ${h.by}`);
    return { held: d.held as Held };
  }

  /**
   * Journal `decision_released`: the decision is open in its normal tier again, and autopilot's
   * rule for its kind runs again (it may answer it now; an escalation it repeats is not journaled
   * twice), a red head's once its PR head is read again (`recheckRedHead`). `rerun: false` (an
   * escalation lifting the hold) runs nothing. `released: false` when it was not held.
   */
  private async releaseNow(
    wave: WaveId,
    id: string,
    why: string,
    by: string,
    opts: { rerun?: false } = {},
  ): Promise<{ released: boolean } | { error: string }> {
    const log = this.waves.get(wave);
    if (log === undefined) return { error: `unknown wave '${wave}'` };
    const r = releaseEvent(log.record, id, { why, by });
    if ("error" in r) return r;
    if ("not_held" in r) return { released: false };
    await this.append(wave, r.event);
    this.heldCheckedAt.delete(`${wave}/${id}`);
    const d = log.record.decisions[id] as DecisionRecord;
    await this.mirrorHeld(wave, d);
    this.log(`released ${id}: ${why}`);
    if (opts.rerun === false) return { released: true };
    const pr =
      isRedHead(d) && d.task !== null
        ? log.record.state?.tasks.find((t) => t.id === d.task)?.pr?.number
        : undefined;
    if (pr !== undefined) this.recheckRedHead(wave, id, pr);
    else await this.rerunAutopilot(wave, id);
    return { released: true };
  }

  /**
   * Autopilot's rule for a released decision, again; its retained topic follows an escalation,
   * and a new one rings the notify bridge as settleDecision's does.
   */
  private async rerunAutopilot(wave: WaveId, id: string): Promise<void> {
    const d = this.waves.get(wave)?.record.decisions[id];
    if (d === undefined || d.resolved !== undefined || d.held !== undefined) return;
    const before = d.escalated;
    if (!(await this.autopilot(wave, d, { again: true }))) return;
    const now = this.waves.get(wave)?.record.decisions[id] as DecisionRecord;
    if (now.escalated?.why !== before?.why) await this.ringDecision(wave, now);
    else await this.publishDecision(wave, now);
  }

  /**
   * A released red head (ci_failed / agent_blocked_ci) re-verifies its head first: its PR's head
   * and the CI on it are read beside the queue (as the pipeline's CI check reads them). Green now
   * (the blocker's fix landed and CI was re-run): answered `re-verify`, when it offers it, so the
   * pipeline verifies the head as it is. Otherwise autopilot's rule runs again.
   */
  private recheckRedHead(wave: WaveId, id: string, pr: number): void {
    const repo = this.waves.get(wave)?.record.wave?.repo;
    const cwd = repo !== undefined ? repoDir(repo) : process.cwd();
    void (async () => {
      const view = await this.host
        .exec(["gh", "pr", "view", String(pr), "--json", "headRefOid"], { cwd })
        .catch(() => null);
      let head: string | undefined;
      try {
        const v = view?.code === 0 ? (JSON.parse(view.stdout) as { headRefOid?: unknown }) : {};
        head = typeof v.headRefOid === "string" ? v.headRefOid : undefined;
      } catch {
        head = undefined;
      }
      const ci =
        head !== undefined
          ? await ciStateOf(this.host.exec, cwd, head).catch(() => "none" as const)
          : "none";
      await this.enqueue(async () => {
        const d = this.waves.get(wave)?.record.decisions[id];
        // Answered or held again meanwhile: not this check's.
        if (d === undefined || d.resolved !== undefined || d.held !== undefined) return;
        if (ci === "green" && (d.options ?? []).some((o) => isAnswer(o, "re-verify"))) {
          await this.resolveNow(wave, id, {
            answer: "re-verify",
            by: DAEMON_AGENT_ID,
            rationale: `released, and CI on PR #${pr}'s head ${head?.slice(0, 12)} is green now`,
          });
          return;
        }
        await this.rerunAutopilot(wave, id);
      });
    })();
  }

  /** A hold set or lifted: the decision's retained topic and its inbox item follow it. */
  private async mirrorHeld(wave: WaveId, d: DecisionRecord): Promise<void> {
    await this.publishDecision(wave, d);
    const item = this.inbox.get(decisionItemId(wave, d.decision_id));
    if (item === undefined || item.answered !== undefined) return;
    const next = withHeld(item, d.held);
    this.inbox.set(item.id, next);
    await this.publishInboxItem(next);
  }

  /**
   * On every tick, per wave: autopilot holds each red head waiting on its flake's fixer
   * (`autoHolds`), a hold on a task that is done or cancelled is released, and holds on PRs and
   * issues are checked with gh beside the queue on the merge-check cadence (once per ci_poll_ms
   * each), released on the queue when the PR merged or closed or the issue closed.
   */
  private async holdPass(wave: WaveId): Promise<void> {
    const log = this.waves.get(wave);
    if (log === undefined || log.record.state?.status !== "running") return;
    for (const h of autoHolds(log.record))
      await this.holdNow(wave, h.decision_id, { on: h.on, note: h.note, by: DAEMON_AGENT_ID });
    for (const d of openDecisions(log.record)) {
      if (d.held === undefined) continue;
      const why = taskHoldReleased(log.record, d.held.on);
      if (why !== null) {
        await this.releaseNow(wave, d.decision_id, why, DAEMON_AGENT_ID);
        continue;
      }
      if (d.held.on.pr !== undefined || d.held.on.issue !== undefined)
        this.checkHeldOnGitHub(wave, d.decision_id, d.held);
    }
    // A hold answered or archived while held: its last check is no one's.
    for (const key of this.heldCheckedAt.keys()) {
      if (!key.startsWith(`${wave}/`)) continue;
      const d = log.record.decisions[key.slice(wave.length + 1)];
      if (d === undefined || d.resolved !== undefined || d.held === undefined)
        this.heldCheckedAt.delete(key);
    }
  }

  /** gh's `state` of a held decision's PR / issue, beside the queue; a landed one is released. */
  private checkHeldOnGitHub(wave: WaveId, id: string, held: Held): void {
    const key = `${wave}/${id}`;
    if (this.heldChecks.has(key)) return;
    const last = this.heldCheckedAt.get(key);
    if (last !== undefined && this.now() - last < DAEMON_DEFAULTS.ci_poll_ms) return;
    this.heldCheckedAt.set(key, this.now());
    this.heldChecks.add(key);
    const repo = this.waves.get(wave)?.record.wave?.repo;
    const cwd = repo !== undefined ? { cwd: repoDir(repo) } : {};
    const state = async (argv: string[]) => {
      const r = await this.host.exec(argv, cwd).catch(() => null);
      let v: unknown;
      try {
        v = r?.code === 0 ? (JSON.parse(r.stdout) as { state?: unknown }).state : undefined;
      } catch {
        v = undefined;
      }
      if (typeof v === "string") return v;
      // Still held; the owner can release it by hand.
      this.log(`${wave}: ${id} stays held: \`${argv.slice(0, 4).join(" ")}\` read no state`);
      return undefined;
    };
    void (async () => {
      const { pr, issue } = held.on;
      const states = {
        ...(pr !== undefined
          ? { pr: await state(["gh", "pr", "view", String(pr), "--json", "state"]) }
          : {}),
        ...(issue !== undefined
          ? { issue: await state(["gh", "issue", "view", String(issue), "--json", "state"]) }
          : {}),
      } as { pr?: string; issue?: string };
      const why = ghHoldReleased(held.on, states);
      if (why === null) return;
      await this.enqueue(async () => {
        // Still the same hold: one set or lifted meanwhile is not this check's to release.
        const d = this.waves.get(wave)?.record.decisions[id];
        if (d?.held?.at !== held.at || d.resolved !== undefined) return;
        await this.releaseNow(wave, id, why, DAEMON_AGENT_ID);
      });
    })().finally(() => this.heldChecks.delete(key));
  }

  /**
   * `merged`: the owner says a gated task landed outside GitHub's merge button. Verified off the
   * queue (read-only git); then, on the queue, an open `pr_closed` decision is answered `landed`
   * and the pipeline journals `merged_by_operator` and the merge.
   */
  private mergedOp(p: Record<string, unknown>, by: string): HandlerResult {
    const w = this.waveOf(p);
    if ("error" in w) return { ok: false, error: w.error };
    const state = w.log.record.state as WaveState;
    const task = p.task;
    const sha = p.sha;
    if (typeof task !== "string" || !state.tasks.some((t) => t.id === task))
      return { ok: false, error: `unknown task '${String(task)}' in wave '${w.wave}'` };
    if (typeof sha !== "string" || !/^[0-9a-f]{7,40}$/.test(sha))
      return { ok: false, error: "merged requires payload.sha (7 to 40 lowercase hex digits)" };
    const refused = guardMutation(state, by, "merged", this.bindings);
    if (refused !== null) return { ok: false, error: refused };
    const driver = this.pipelineFor(w.wave);
    const defer = (async (): Promise<Reply> => {
      const r = await driver.verifyMerge(task, sha);
      if (!r.ok) return { ok: false, error: r.error };
      const full = r.sha;
      // The record describes the commit that merged, and its own CI.
      const merged_ci = await driver.ciOf(task, full);
      const moved = await this.serial(async () => {
        // The head moved while it was verified: the check describes a head the task left.
        const now = driver.headOf(task);
        if (now !== r.head) return now ?? "none";
        // The merge settles every open question about the task (a pr_closed is answered
        // landed; any other is superseded, and a done task acts on no answer).
        for (const d of openDecisions(w.log.record)) {
          if (d.task !== task) continue;
          const marker = (d as { pipeline?: { on?: string } }).pipeline;
          await this.resolveNow(w.wave, d.decision_id, {
            answer: marker?.on === "pr_closed" ? "landed" : "superseded",
            by,
            rationale: `volleyd merged --sha ${full}`,
          });
        }
        await driver.handle(task, {
          kind: "operator_merged",
          sha: full,
          by,
          how: r.how,
          head: r.head as string,
          merged_ci,
        });
        return null;
      });
      if (moved !== null)
        return {
          ok: false,
          error: `the PR head moved from ${r.head} to ${moved} while ${full} was verified; run \`volleyd merged\` again`,
        };
      return { ok: true, result: { wave: w.wave, task, sha: full, how: r.how } };
    })();
    return { ok: true, defer };
  }

  /**
   * `merge` (SPEC §4.6.17): the owner merges one gated task now, through the merge queue's verb
   * (`gh pr merge --squash --match-head-commit`, behind the fence), under `merge: manual` too.
   * Checked here and again on the queue; the merge runs off it and is answered when it ends.
   */
  private mergeOp(p: Record<string, unknown>, by: string): HandlerResult {
    const w = this.waveOf(p);
    if ("error" in w) return { ok: false, error: w.error };
    const state = w.log.record.state as WaveState;
    const task = p.task;
    const t = state.tasks.find((x) => x.id === task);
    if (typeof task !== "string" || t === undefined)
      return { ok: false, error: `unknown task '${String(task)}' in wave '${w.wave}'` };
    const refused = guardMutation(state, by, "merge", this.bindings);
    if (refused !== null) return { ok: false, error: refused };
    if (t.stage !== "merge_ready") return { ok: false, error: `task '${task}' is not merge_ready` };
    const driver = this.pipelineFor(w.wave);
    const defer = (async (): Promise<Reply> => {
      const r = await driver.mergeNow(task, by);
      return r.ok
        ? { ok: true, result: { wave: w.wave, task, merge_sha: r.merge_sha } }
        : { ok: false, error: r.error };
    })();
    return { ok: true, defer };
  }

  /** Carry out the owner's answer to a plan_change decision (plan-apply.ts `planAnswer`). */
  private async applyPlanAnswer(wave: WaveId, d: DecisionRecord, by: string): Promise<void> {
    const log = this.waves.get(wave);
    if (log === undefined) return; // archived by the answer (archive_on_ack)
    const effect = planAnswer(log.record, d);
    if (effect.cancel !== undefined && d.task !== null) {
      const task = d.task;
      for (const a of runningAgents(log.record, retiredAgents(log)).filter(
        (x) => x.task === task,
      )) {
        await this.cancelAgent(wave, a, by, {
          ...cancelPayload(wave, task, by),
          text: effect.cancel,
        });
      }
    }
    for (const ev of effect.events) await this.append(wave, ev);
    if (effect.events.length > 0) await this.tickNow();
  }

  /**
   * The owner's explicit `trust` answer to an open `repo_untrusted` decision records the dialog's
   * acceptance in `~/.claude.json` (that key only) before the decision resolves: the daemon
   * machine's, or for a decision with a `target` the remote host's own, over ssh. Returns an
   * error message when that write fails, else null. No other answer, and nothing else, ever
   * writes it.
   */
  private async trustAnswer(wave: WaveId, id: string, answer: string): Promise<string | null> {
    const d = this.waves.get(wave)?.record.decisions[id];
    if (d?.kind !== "repo_untrusted" || d.resolved !== undefined) return null;
    if (answer.trim().toLowerCase() !== "trust" || this.opts.spawner === undefined) return null;
    const root = (d as { repo?: unknown }).repo;
    if (typeof root !== "string") return `decision '${id}' names no repo to trust`;
    const target = (d as { target?: unknown }).target;
    const profile = (d as { claude_config_dir?: unknown }).claude_config_dir;
    try {
      if (typeof target === "string") {
        const remote = this.remoteForDecision(wave, d);
        if (remote === undefined) return `no configured host reaches ${target} to trust ${root}`;
        await remote.recordTrust(root, typeof profile === "string" ? profile : undefined);
      } else
        recordRepoTrust(
          typeof profile === "string" ? join(profile, ".claude.json") : this.claudeJsonPath,
          root,
        );
      return null;
    } catch (e) {
      const where = typeof target === "string" ? ` on ${target}` : "";
      return `recording trust for ${root}${where}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /** `claim`: take a wave over when its owner is gone (status, registry age, heartbeats). */
  private async claim(p: Record<string, unknown>, by: string): Promise<HandlerResult> {
    const w = this.waveOf(p);
    if ("error" in w) return { ok: false, error: w.error };
    const owner = w.log.record.state?.owner ?? null;
    // A coordinator name is measured by its newest binding, never by an agent id it left.
    const bound = owner !== null ? this.bindings.get(owner)?.agent_id : undefined;
    const agent = bound ?? owner;
    const info = agent !== null && agent !== by ? await this.ownerLiveness(agent) : null;
    const verdict = claimVerdict({
      owner,
      by,
      ...(bound !== undefined ? { bound } : {}),
      status: info?.status ?? null,
      registryAt: info?.registryAt ?? null,
      heartbeatAt: agent !== null ? (this.lastSeen.get(agent) ?? this.startedAt) : null,
      ownedSince: ownedSince(this.journalEvents(w.wave), this.now()),
      now: this.now(),
      claimAfterS: this.config.effective(w.wave).claim_after_s,
    });
    if (!verdict.ok) return { ok: false, error: `wave '${w.wave}': ${verdict.reason}` };
    // The agent bound to a coordinator-name owner already acts for it: the name keeps the wave.
    if (bound !== undefined && bound === by)
      return { ok: true, result: { wave: w.wave, owner, previous: owner, why: verdict.why } };
    if (owner !== by) {
      await this.append(w.wave, {
        type: "owner_claimed",
        data: { owner: by, previous: owner, why: verdict.why },
      });
      this.log(`wave ${w.wave} claimed by ${by} from ${owner ?? "-"}: ${verdict.why}`);
    }
    return { ok: true, result: { wave: w.wave, owner: by, previous: owner, why: verdict.why } };
  }

  /** The owner's retained status and registry timestamps. */
  private async ownerLiveness(owner: string) {
    if (!isValidAgentId(owner)) return { status: null, registryAt: null };
    const [st, reg] = await Promise.all([
      this.broker.queryRetained(
        buildTopic(this.opts.namespace, owner, "status"),
        DAEMON_DEFAULTS.probe_ms,
      ),
      this.broker.queryRetained(registryTopic(owner), DAEMON_DEFAULTS.probe_ms),
    ]);
    const status = st !== null && st !== "" ? parseEnvelope(st) : null;
    const entry = reg !== null && reg !== "" ? parseEnvelope(reg) : null;
    const started = (entry?.payload as { started_at?: unknown } | undefined)?.started_at;
    const times = [entry?.wall_time, typeof started === "string" ? started : undefined].filter(
      (t): t is string => t !== undefined,
    );
    return {
      status: status !== null ? { type: status.type, at: status.wall_time } : null,
      registryAt: times.length > 0 ? (times.sort().at(-1) ?? null) : null,
    };
  }

  /** `pause` / `resume` / `stop`, for one wave (owner-only) or every wave (`all: true`). */
  private async waveControl(
    op: "pause" | "resume" | "stop",
    p: Record<string, unknown>,
    by: string,
  ): Promise<HandlerResult> {
    if (p.all === true) {
      if (op === "pause")
        return { ok: false, error: "pause --all is not supported; use stop --all" };
      return op === "stop" ? this.stopAll(by) : this.resumeAll(by);
    }
    const w = this.waveOf(p);
    if ("error" in w) return { ok: false, error: w.error };
    const state = w.log.record.state as WaveState;
    const refused = guardMutation(state, by, op, this.bindings);
    if (refused !== null) return { ok: false, error: refused };
    const done = (changed: boolean): HandlerResult => ({
      ok: true,
      result: { wave: w.wave, status: w.log.record.state?.status, changed },
    });
    if (op === "pause") {
      if (state.status === "paused") return done(false);
      // A releasing wave pauses too, and resumes releasing (SPEC §4.6.19).
      if (state.status !== "running" && state.status !== "releasing")
        return {
          ok: false,
          error: `wave '${w.wave}' is ${state.status}; only a running or releasing wave can be paused`,
        };
      await this.append(w.wave, { type: "wave_paused", data: { by } });
      await this.tickNow();
      return done(true);
    }
    if (op === "resume") {
      if (state.status === "running" || state.status === "releasing") return done(false);
      if (this.killSwitch)
        return { ok: false, error: `${KILL_SWITCH_REASON}: \`volleyd resume --all\` first` };
      if (state.status === "complete") return { ok: false, error: `wave '${w.wave}' is complete` };
      await this.append(w.wave, { type: "wave_resumed", data: { by } });
      this.time.clearTimeout(this.stopGrace.get(w.wave));
      this.stopGrace.delete(w.wave);
      // Resumed within the grace: its agents live on, and so does their screen capture.
      for (const [id, a] of this.supervised)
        if (a.wave === w.wave && !this.screens.tracked().includes(id)) this.trackScreen(id, a);
      await this.tickNow();
      return done(true);
    }
    const stopped = await this.stopWave(w.wave, by);
    return {
      ok: true,
      result: {
        wave: w.wave,
        status: w.log.record.state?.status,
        changed: stopped !== null,
        cancelled: stopped ?? [],
      },
    };
  }

  /**
   * Stop one wave: journal `wave_stopped` (no more admissions), then send `cancel` to every
   * running agent and interrupt its session. Returns the cancelled agents, null if already stopped.
   */
  private async stopWave(wave: WaveId, by: string): Promise<string[] | null> {
    const log = this.waves.get(wave) as WaveLog;
    const status = log.record.state?.status;
    if (status === "stopped" || status === "complete") return null;
    await this.append(wave, { type: "wave_stopped", data: { by } });
    const cancelled: string[] = [];
    for (const a of runningAgents(log.record, retiredAgents(log))) {
      await this.cancelAgent(wave, a, by, cancelPayload(wave, a.task, by));
      // A stopped wave's terminals are no longer supervised: nobody reads them again.
      await this.screens.untrack(a.agent_id);
      cancelled.push(a.agent_id);
    }
    this.log(`wave ${wave} stopped by ${by}; cancelled ${cancelled.length} agent(s)`);
    this.armStopGrace(wave, secondsMs(this.config.effective(wave).stop_grace_s));
    return cancelled;
  }

  /** Force-retire a stopped wave's remaining agents once `ms` have passed (the daemon clock). */
  private armStopGrace(wave: WaveId, ms: number): void {
    this.time.clearTimeout(this.stopGrace.get(wave));
    this.stopGrace.set(
      wave,
      this.time.setTimeout(
        () => {
          this.stopGrace.delete(wave);
          void this.enqueue(() => this.forceRetireWave(wave, "stop"));
        },
        Math.max(0, ms),
      ),
    );
  }

  /**
   * The agents of `wave` that never published a terminal status (stop's grace ran out, or the
   * daemon restarted into a stopped wave): each is retired through the delete path — retained
   * registry/status/progress/result/capability/screen/usage cleared, its login deleted, its lock
   * released — after `agent_force_retired { reason }`. No ack is needed.
   */
  private async forceRetireWave(wave: WaveId, reason: string): Promise<void> {
    const log = this.waves.get(wave);
    // Resumed meanwhile: its agents carry on.
    if (log === undefined || !this.running || log.record.state?.status !== "stopped") return;
    // Their logins are deleted together: one control message for the whole wave.
    await withJointRevokes(
      this.credentials,
      runningAgents(log.record, retiredAgents(log)).map((a) => async (credentials) => {
        await this.append(wave, {
          type: "agent_force_retired",
          task: a.task,
          data: { agent_id: a.agent_id, role: a.role, reason },
        });
        try {
          await this.retireAny(wave, a.agent_id, "stopped", credentials);
        } catch (e) {
          this.log(`force-retire ${a.agent_id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }),
    );
  }

  /** Send one running agent a mailbox `cancel` (journaled) and interrupt its session. */
  private async cancelAgent(
    wave: WaveId,
    a: { task: TaskId; role: string; agent_id: string },
    by: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const messageId = randomUUID();
    await this.publish(
      buildTopic(this.agentNamespace(wave, a.agent_id), a.agent_id, "mailbox"),
      this.envelope("mailbox", "cancel", payload, messageId),
      false,
    );
    await this.append(wave, {
      type: "steering_sent",
      task: a.task,
      data: { agent_id: a.agent_id, role: a.role, type: "cancel", message_id: messageId, by },
    });
    await this.interruptAgent(a.agent_id).catch((e: unknown) => {
      this.log(`interrupt ${a.agent_id} failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  /** `steer --urgent`'s interrupt; false when none is wired or it failed (never rejects). */
  private async tryInterrupt(agentId: string): Promise<boolean> {
    try {
      return await this.interruptAgent(agentId);
    } catch (e) {
      this.log(`interrupt ${agentId} failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /** The kill switch: stop every wave, then refuse `run` until `resume --all`. Anyone may pull it. */
  private async stopAll(by: string): Promise<HandlerResult> {
    // Engage (and journal) the switch first: a crash part-way through still refuses `run` after
    // the restart, and the waves not yet stopped admit nothing.
    await this.appendSystem({ type: "wave_stopped", data: { all: true, by } });
    this.killSwitch = true;
    const waves: WaveId[] = [];
    for (const wave of this.waves.keys()) {
      if ((await this.stopWave(wave, by)) !== null) waves.push(wave);
    }
    this.log(`kill switch engaged by ${by}: stopped ${waves.length} wave(s)`);
    return { ok: true, result: { kill_switch: true, stopped: waves } };
  }

  /** Release the kill switch. Stopped waves stay stopped (resume each one explicitly). */
  private async resumeAll(by: string): Promise<HandlerResult> {
    if (this.killSwitch) {
      await this.appendSystem({ type: "wave_resumed", data: { all: true, by } });
      this.killSwitch = false;
      this.log(`kill switch released by ${by}`);
      await this.tickNow();
    }
    return { ok: true, result: { kill_switch: false } };
  }

  /** Journal a global event in `_system` and mirror it on `volley/_waves/_system/events`. */
  private appendSystem(ev: NewEvent): Promise<void> {
    return this.track(this.publishSystem(this.system.append(ev, dateOf(this.time))));
  }

  private async publishSystem(event: JournalEvent): Promise<void> {
    await this.publish(
      waveEventsTopic(SYSTEM_WAVE),
      this.envelope("_waves/events", event.type, {
        wave: SYSTEM_WAVE,
        seq: event.seq,
        at: event.at,
        data: event.data,
      }),
      false,
    );
  }

  /**
   * Publish one numbered `steering` to `target`'s mailbox in its namespace (the wave's, for an
   * agent spawned with `namespace:`) and journal it (`steer`, and recovery's own).
   */
  private async deliverSteer(
    wave: WaveId,
    task: TaskId,
    target: { role: keyof TaskAgents; agent_id: string; namespace: string },
    text: string,
    by: string,
    messageId: string,
    extra: Record<string, unknown> = {},
    numbered?: { seq: number; supersedes?: string },
  ): Promise<void> {
    const log = this.waves.get(wave) as WaveLog;
    // A merge nudge is additive: it never supersedes an earlier (owner or pipeline) steer.
    const { seq, supersedes } =
      numbered ?? nextSteer(log.record, task, { additive: isAdditiveSteer(extra.reason) });
    // Armed before the publish (dropped if it fails): the hooks may ack while steering_sent is
    // still being journaled, and an ack finds only a wake that already exists. An agent whose
    // hooks the broker refused is paused, not prompted: a wake would submit a prompt whose work
    // it cannot deliver.
    if (extra.reason !== "auth_failed") this.armWake(wave, task, target.agent_id, messageId);
    try {
      await this.publish(
        buildTopic(target.namespace, target.agent_id, "mailbox"),
        this.envelope(
          "mailbox",
          "steering",
          {
            text,
            from_agent_id: DAEMON_AGENT_ID,
            seq,
            ...(supersedes !== undefined ? { supersedes } : {}),
            wave,
            task,
            by,
          },
          messageId,
        ),
        false,
      );
    } catch (e) {
      this.disarmWake(messageId);
      throw e;
    }
    await this.append(wave, {
      type: "steering_sent",
      task,
      data: {
        agent_id: target.agent_id,
        role: target.role,
        type: "steering",
        message_id: messageId,
        seq,
        ...(supersedes !== undefined ? { supersedes } : {}),
        text,
        by,
        ...extra,
      },
    });
  }

  /**
   * Wake `agentId` for `messageId` if its hooks do not ack it within `mailbox_wake_after_ms`: the
   * hooks drain the mailbox only at a hook, never while the session waits at its prompt.
   */
  private armWake(wave: WaveId, task: TaskId, agentId: string, messageId: string): void {
    if (!this.supervised.has(agentId)) return;
    // One message per agent is watched after its wake: a newer one supersedes it.
    for (const [id, w] of this.wakes) if (w.agent === agentId && w.woken) this.wakes.delete(id);
    const ms = this.config.effective(wave).mailbox_wake_after_ms;
    const timer = this.time.setTimeout(
      () => void this.enqueue(() => this.wakeIfUnacked(messageId)),
      ms,
    );
    this.wakes.set(messageId, { agent: agentId, wave, task, timer, woken: false });
  }

  /** Drop `messageId`'s pending wake, if any. */
  private disarmWake(messageId: string): void {
    const w = this.wakes.get(messageId);
    if (w === undefined) return;
    this.time.clearTimeout(w.timer);
    this.wakes.delete(messageId);
  }

  /**
   * `by` acked `messageId`: no wake; one that was woken is journaled as received at last. The
   * journal's `woken` mark decides, not the timer map: a newer message, or a restart, drops the
   * woken message's entry there before its ack comes.
   */
  private mailboxHeard(messageId: string, by: string): void {
    if (this.wakes.get(messageId)?.agent === by) this.disarmWake(messageId);
    // In the queue: a wake being typed journals its agent_woken first.
    void this.enqueue(async () => {
      for (const [wave, log] of this.waves)
        for (const [task, m] of Object.entries(log.record.woken ?? {}))
          if (m.message_id === messageId && m.agent_id === by)
            await this.append(wave, {
              type: "steering_received",
              task,
              data: { agent_id: by, message_id: messageId },
            });
    });
  }

  /**
   * The wake window ended with no ack: an idle agent gets WAKE_TEXT and Enter (its
   * UserPromptSubmit hook drains the mailbox), once; a working one reads it at its next hook. An
   * agent awaiting input has a picker open (a question, a permission, credit) that the Enter
   * would answer: never typed into either.
   */
  private async wakeIfUnacked(messageId: string): Promise<void> {
    const w = this.wakes.get(messageId);
    if (w === undefined || w.woken) return;
    const a = this.supervised.get(w.agent);
    // A wake typed within the window drains this message too: liveness has not left idle yet.
    const window = this.config.effective(w.wave).mailbox_wake_after_ms;
    const last = this.lastWokenAt.get(w.agent);
    const recent = last !== undefined && this.time.now() - last < window;
    if (a === undefined || a.liveness.activity !== "idle" || recent) {
      if (a !== undefined && recent) this.log(`wake ${w.agent}: skipped, woken ${window} ms ago`);
      // Nothing journaled: status shows no `steer unacked` for this message, only for the woken one.
      this.wakes.delete(messageId);
      return;
    }
    // A line left typed by a failed Enter is the wake line: submitting it is the wake.
    if (!this.wakeTyped.has(w.agent)) {
      try {
        await a.host.sendText(a.workspace, WAKE_TEXT, { wake: mintWakeToken() });
      } catch (e) {
        this.log(`wake ${w.agent}: ${e instanceof Error ? e.message : String(e)}`);
        this.wakes.delete(messageId);
        return;
      }
    }
    let enterFailed = false;
    try {
      await a.host.sendKeys(a.workspace, "Enter");
      this.wakeTyped.delete(w.agent);
    } catch (e) {
      // The line stays typed: journaled, so status shows the agent unwoken-but-typed-into.
      this.log(
        `wake ${w.agent}: Enter failed, wake line left typed: ${e instanceof Error ? e.message : String(e)}`,
      );
      this.wakeTyped.add(w.agent);
      enterFailed = true;
    }
    w.woken = true;
    // Only a submitted wake drains: after a failed Enter the next message still wakes.
    if (!enterFailed) this.lastWokenAt.set(w.agent, this.time.now());
    await this.append(w.wave, {
      type: "agent_woken",
      task: w.task,
      data: {
        agent_id: w.agent,
        reason: "mailbox",
        message_id: messageId,
        ...(enterFailed ? { enter_failed: true } : {}),
      },
    });
  }

  /** Journal a steer for `task`'s next agent (of `role`, when given); the steer op's answer. */
  private async queueSteer(
    wave: WaveId,
    task: TaskId,
    text: string,
    by: string,
    role: keyof TaskAgents | undefined,
  ): Promise<Record<string, unknown>> {
    const log = this.waves.get(wave) as WaveLog;
    const { seq, supersedes } = nextSteer(log.record, task);
    const messageId = randomUUID();
    await this.append(wave, {
      type: "steering_queued",
      task,
      data: {
        ...(role !== undefined ? { role } : {}),
        message_id: messageId,
        seq,
        ...(supersedes !== undefined ? { supersedes } : {}),
        text,
        by,
      },
    });
    this.log(`steer ${wave}/${task} #${seq} queued for its next ${role ?? "agent"} by ${by}`);
    return {
      wave,
      task,
      message_id: messageId,
      seq,
      ...(supersedes !== undefined ? { supersedes } : {}),
      delivery: "queued",
      queued_for: role ?? "next agent",
      received: false,
      acked: false,
    };
  }

  /**
   * An agent of `task` registered, or one already up sent a hook signal (its hooks drain the
   * mailbox): every steer queued for the task's next agent, or for its role, goes to it in order,
   * with the id and seq it was queued with.
   */
  private async deliverQueued(wave: WaveId, task: TaskId, role: Role, agentId: string) {
    const a = this.supervised.get(agentId);
    const queue = this.waves.get(wave)?.record.queued_steers[task] ?? [];
    if (a === undefined) return;
    for (const q of queue.filter((x) => x.role === undefined || x.role === role)) {
      await this.deliverSteer(
        wave,
        task,
        { role, agent_id: agentId, namespace: a.namespace },
        q.text,
        q.by,
        q.message_id,
        { queued: true, queued_at: q.at },
        { seq: q.seq, ...(q.supersedes !== undefined ? { supersedes: q.supersedes } : {}) },
      );
    }
  }

  /**
   * `steer`: a T0 mailbox `steering` to the task's current agent with `seq` and `supersedes` (the
   * previous steer to the task), journaled; the answer waits up to `wait_ack_ms` for the ack.
   */
  private async steer(p: Record<string, unknown>, by: string): Promise<HandlerResult> {
    const w = this.waveOf(p);
    if ("error" in w) return { ok: false, error: w.error };
    if (typeof p.task !== "string") return { ok: false, error: "steer requires payload.task" };
    // `escape_only` interrupts the session and delivers nothing: the caller (the Desk) publishes
    // its own mailbox message after the answer, so the agent never gets a second steer.
    const escapeOnly = p.escape_only === true;
    const urgent = escapeOnly || p.urgent === true;
    if (!escapeOnly && (typeof p.text !== "string" || p.text.trim() === ""))
      return { ok: false, error: "steer requires a non-empty payload.text" };
    const refused = guardMutation(w.log.record.state as WaveState, by, "steer", this.bindings);
    if (refused !== null) return { ok: false, error: refused };
    if (p.role !== undefined && (typeof p.role !== "string" || !isTaskRole(p.role)))
      return {
        ok: false,
        error: `unknown role '${String(p.role)}' (one of ${TASK_ROLES.join(", ")})`,
      };
    const role = p.role;
    const t = w.log.record.state?.tasks.find((x) => x.id === p.task);
    // `_release`: the release train's stage agents (steer _release --role release).
    if (t === undefined && p.task !== RELEASE_TASK)
      return { ok: false, error: `unknown task '${p.task}' in wave '${w.wave}'` };
    if (t !== undefined && UNSTEERABLE.has(t.stage))
      return { ok: false, error: `task '${p.task}' is ${t.stage}` };
    const target = steerTarget(w.log.record, p.task, w.log.journal.readAll(), role);
    if (target === null) {
      // No live agent (between stages, or not spawned yet): held for the task's next one.
      if (urgent) return { ok: false, error: "no live agent to interrupt" };
      if (typeof p.text !== "string") return { ok: false, error: "steer requires payload.text" };
      const status = w.log.record.state?.status;
      if (status === "stopped" || status === "complete")
        return { ok: false, error: `wave '${w.wave}' is ${status}: task '${p.task}' has no agent` };
      return { ok: true, result: await this.queueSteer(w.wave, p.task, p.text, by, role) };
    }
    // Urgent: interrupt (Escape) before delivering, so the message lands in a stopped session.
    const interrupted = urgent ? await this.tryInterrupt(target.agent_id) : undefined;
    if (escapeOnly) {
      this.log(`steer --escape-only ${w.wave}/${p.task} → ${target.agent_id} by ${by}`);
      return {
        ok: true,
        result: {
          wave: w.wave,
          task: p.task,
          agent_id: target.agent_id,
          role: target.role,
          escape_only: true,
          interrupted,
        },
      };
    }
    if (typeof p.text !== "string") return { ok: false, error: "steer requires payload.text" };
    const { seq, supersedes } = nextSteer(w.log.record, p.task);
    const messageId = randomUUID();
    const waitMs =
      typeof p.wait_ack_ms === "number" && p.wait_ack_ms >= 0
        ? Math.min(p.wait_ack_ms, DAEMON_DEFAULTS.steer_wait_ack_max_ms)
        : DAEMON_DEFAULTS.steer_wait_ack_ms;
    const heard = waitMs > 0 ? this.acks.wait(messageId, target.agent_id, waitMs) : null;
    const namespace = this.agentNamespace(w.wave, target.agent_id);
    await this.deliverSteer(w.wave, p.task, { ...target, namespace }, p.text, by, messageId);
    const result = {
      wave: w.wave,
      task: p.task,
      agent_id: target.agent_id,
      role: target.role,
      message_id: messageId,
      seq,
      ...(supersedes !== undefined ? { supersedes } : {}),
      delivery: "delivered",
      received: false,
      acked: false,
      ...(interrupted !== undefined ? { interrupted } : {}),
    };
    if (heard === null) return { ok: true, result };
    const wave = w.wave;
    return {
      ok: true,
      defer: heard.then(({ received, acked }) => {
        const woke = (this.waves.get(wave)?.journal.readAll() ?? []).some(
          (e) => e.type === "agent_woken" && e.data.message_id === messageId,
        );
        return {
          ok: true,
          result: {
            ...result,
            delivery: acked ? "acked" : received ? "received" : "delivered",
            received,
            acked,
            ...(acked ? { acked_by: target.agent_id } : {}),
            ...(woke ? { woke: true } : {}),
          },
        };
      }),
    };
  }

  /** A new version of a submitted wave: store the file, journal the plan change, re-admit. */
  private async resubmit(
    log: WaveLog,
    wave: Wave,
    text: string,
    preface: { info: BriefPrefaceInfo | null; path: string },
    visibility: VisibilityFacts | null,
  ): Promise<Reply> {
    const rec = log.record;
    const state = rec.state;
    if (state === null) return { ok: false, error: `wave '${wave.wave}' has no state` };
    if (state.status === "complete" || state.status === "stopped" || state.status === "releasing") {
      return {
        ok: false,
        error: `wave '${wave.wave}' is ${state.status}; a new version applies only to a live wave`,
      };
    }
    const file = this.versionFile(wave.wave, state.version + 1);
    const now = dateOf(this.time).toISOString();
    let res: ReturnType<typeof applyPlan>;
    try {
      const spawning = [...this.spawning]
        .filter((k) => k.startsWith(`${wave.wave}/`))
        .map((k) => k.split("/")[1] as TaskId);
      res = applyPlan(rec, wave, {
        now,
        activity: taskActivity(log.journal.readAll()),
        spawning,
        file,
      });
    } catch (e) {
      if (e instanceof PlanChangeError) return { ok: false, error: e.message };
      throw e;
    }
    if (res.unchanged) {
      return {
        ok: false,
        error: `wave '${wave.wave}' already submitted as v${state.version}; the file has no changes`,
        plan: { version: res.version, diff: res.diff, unchanged: true },
      };
    }
    this.storeVersion(file, text);
    this.config.setWaveOverrides(wave.wave, wave.config);
    // Which preface this version's agents get; missing is journaled once per wave.
    const journaledMissing = log.journal
      .readAll()
      .some((e) => e.type === "alarm_raised" && e.data.alarm === "brief_preface_missing");
    for (const ev of res.planEvents) {
      const versioned = ev.type === "wave_versioned";
      await this.append(
        wave.wave,
        versioned ? { ...ev, data: { ...ev.data, brief_preface: preface.info } } : ev,
      );
      if (versioned && preface.info === null && !journaledMissing) {
        await this.append(wave.wave, {
          type: "alarm_raised",
          data: { alarm: "brief_preface_missing", path: preface.path },
        });
      }
    }
    await this.journalVisibility(wave.wave, visibility);
    // plan_change decisions go through the decision store: journal + retained decision topic.
    for (const d of res.decisions) {
      if (d.op === "resolve") {
        await this.resolveNow(wave.wave, d.decision_id, { answer: d.answer, by: d.by });
      } else await this.openDecisionNow(wave.wave, d.input, d.extra);
    }
    this.evaluate(); // the new version's admission overrides, on the last sample
    await this.tickNow();
    this.log(`wave ${wave.wave} v${res.version}: ${JSON.stringify(res.diff)}`);
    return {
      ok: true,
      result: this.snapshot(wave.wave),
      plan: {
        version: res.version,
        diff: res.diff,
        unchanged: false,
        decisions: openDecisions(log.record)
          .filter((d) => d.kind === "plan_change")
          .map(decisionPayload),
      },
    };
  }

  /** `diff`: the structural diff between a wave's current plan and a file, without submitting. */
  private planDiff(p: Record<string, unknown>): Reply {
    const name = typeof p.wave === "string" ? p.wave : "";
    const rec = this.waves.get(name)?.record;
    const current = rec?.plan ?? rec?.wave;
    if (rec?.state == null || current == null)
      return { ok: false, error: `unknown wave '${name}'` };
    const wave = this.parseRequestWave(p, "diff");
    if ("ok" in wave) return wave;
    if (wave.wave !== name) {
      return { ok: false, error: `the file is for wave '${wave.wave}', not '${name}'` };
    }
    const diff = diffPlans(current, wave);
    return {
      ok: true,
      result: diff,
      plan: { version: rec.state.version, diff, unchanged: samePlan(current, wave) },
    };
  }
}

/** The `issue_files` each `task_queued` carries, by task. */
function journaledIssueFiles(events: readonly JournalEvent[]): Record<TaskId, string[]> {
  const out: Record<TaskId, string[]> = {};
  for (const e of events) {
    const files = e.data.issue_files;
    if (e.type === "task_queued" && e.task !== undefined && Array.isArray(files)) {
      out[e.task] = files.filter((f): f is string => typeof f === "string");
    }
  }
  return out;
}

/** A coordinator's question as SPEC §4.3 publishes it: its first one or two lines. */
function firstLines(text: string): string {
  return text.trim().split("\n").slice(0, 2).join("\n");
}

/** A message quoted in a decision question: one line, at most `decision_text_max` characters. */
function clipText(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  const max = DAEMON_DEFAULTS.decision_text_max;
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** When the current owner got the wave: the latest `owner_claimed`, else `wave_submitted`. */
function ownedSince(events: readonly JournalEvent[], now: number): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as JournalEvent;
    if (e.type === "owner_claimed" || e.type === "wave_submitted") return e.at;
  }
  return new Date(now).toISOString();
}

/** Open every wave journal under `<home>/waves/`, oldest submission first. */
function loadWaves(home: string): WaveLog[] {
  const dir = join(home, "waves");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (d) =>
        d.isDirectory() && d.name !== SYSTEM_WAVE && existsSync(join(dir, d.name, "journal.jsonl")),
    )
    .map((d) => WaveLog.open(join(dir, d.name)))
    .filter((log) => log.record.state !== null)
    .map((log) => ({ log, at: log.journal.readAll()[0]?.at ?? "" }))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .map(({ log }) => log);
}

/** A remote host's forward (tunnelKey): what its tunnel and tunnel check are keyed by. */
const forwardOf = (h: RemoteHost) => tunnelKey(h.spec.target, h.spec.tunnel.remote_port);

/** The broker's host and port as this machine reaches it (a paired machine's tunnel target). */
function brokerAddress(url: string): { host: string; port: number } {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port !== "" ? Number(u.port) : DAEMON_DEFAULTS.mqtt_default_port,
  };
}

/** A decision record's own fields: the rest are the facts a re-ask carries over. */
const DECISION_RECORD_KEYS: ReadonlySet<string> = new Set([
  "decision_id",
  "wave",
  "task",
  "kind",
  "question",
  "options",
  "pointers",
  "opened_at",
  "resolved",
  "escalated",
  "held",
  "released",
  "resume_stage",
  "parks",
  "rationale",
]);

/**
 * Why a fixer task's event means it will not land its fix (SPEC §4.6.16): cancelled, blocked (its
 * agent's `blocked` opens an agent_blocked decision), or one of its decisions escalated. Any
 * escalation counts, as SPEC §4.6.16 says: the fixer is then waiting on the owner, so the tasks it
 * holds go to the owner too rather than wait unseen; if it lands after all it closes again `landed`.
 * null: it does not.
 */
function fixerFailure(e: JournalEvent): string | null {
  if (e.type === "task_cancelled")
    return typeof e.data.by === "string" ? `cancelled by ${e.data.by}` : "cancelled";
  if (e.type === "stage_entered" && e.data.stage === "blocked")
    return typeof e.data.why === "string" ? `blocked: ${e.data.why}` : "blocked";
  if (e.type === "decision_opened" && e.data.kind === "agent_blocked")
    return typeof e.data.question === "string" ? `blocked: ${e.data.question}` : "blocked";
  if (e.type === "decision_escalated")
    return `its ${String(e.data.kind)} decision escalated (${String(e.data.why)})`;
  return null;
}

/** A limit window as a move's `why` names it: `5h`, `7d`, or the model family (`Fable`). */
function windowShort(window: string | undefined): string {
  if (window === "five_hour") return "5h";
  if (window === "weekly") return "7d";
  const f = window?.startsWith("model_weekly:") ? window.slice("model_weekly:".length) : "";
  return f !== "" ? `${f.charAt(0).toUpperCase()}${f.slice(1)}` : "window";
}
