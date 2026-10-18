import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { VolleyBroker } from "volley-mcp/broker";
import type { BrokerAuth } from "volley-mcp/config";
import { type Envelope, buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { buildTopic, isValidAgentId, registryTopic } from "volley-mcp/topics";
import {
  type AdmissionState,
  type AdmissionSummary,
  type Sample,
  type Samples,
  type Verdict,
  allowJson,
  decide,
  summaryPayload,
} from "./admission";
import { authFields } from "./broker-auth";
import { DAEMON_DEFAULTS } from "./config-defaults";
import { ConfigStore } from "./config-store";
import {
  ADMISSION_TOPIC,
  CONFIG_TOPIC,
  type ControlResponse,
  DAEMON_AGENT_ID,
  LEASE_REQUESTS_FILTER,
  leasePoolTopic,
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
import {
  type DecisionInput,
  type DecisionPayload,
  type DecisionRecord,
  attentionPayload,
  decisionPayload,
  decisionTopic,
  describeDecision,
  openDecisions,
  openEvent,
  renderDecisionsMd,
  resolveEvent,
  writeDecisionsFile,
} from "./decisions";
import { type ExecFn, exec as realExec } from "./exec";
import type { Host } from "./hosts/host";
import { LocalCmuxHost } from "./hosts/local-cmux";
import {
  type RemoteHost,
  type RemoteHostSpec,
  SshTmuxHost,
  resolveRemoteHost,
} from "./hosts/ssh-tmux";
import {
  TunnelChecks,
  type TunnelExit,
  type TunnelStatus,
  TunnelSupervisor,
  tunnelKey,
} from "./hosts/tunnel";
import { grantAckTo, revokeCredentials } from "./identity";
import { Journal, WaveLog } from "./journal";
import {
  HOLDER_GONE,
  type LeaseBook,
  type LeaseInput,
  type LeaseRequest,
  step as leaseStep,
  poolPayload,
  replayLeases,
} from "./leases";
import { type IssueBodyFn, findOverlaps, formatOverlap, parseFilesSection } from "./overlap";
import { claimVerdict, guardMutation } from "./ownership";
import { PlanChangeError, applyPlan, planAnswer, samePlan, taskActivity } from "./plan-apply";
import { diffPlans } from "./plan-diff";
import { countApiSignals, isApiSignal } from "./pressure/api-signals";
import { sampleCiQueue } from "./pressure/ci-queue";
import { sampleCmuxPing } from "./pressure/cmux";
import { sampleContainers } from "./pressure/containers";
import { sampleMemory } from "./pressure/memory";
import type { WaveRecord } from "./reducer";
import { type Admission, activeTasks, admit, spawnBudget, spawnsUsed } from "./scheduler";
import { toPathErrors, validator } from "./schemas";
import type {
  CoordinatorAttention,
  JournalEvent,
  NewEvent,
  TaskAgents,
  TaskId,
  Tunables,
  TunablesPatch,
  Wave,
  WaveId,
  WaveState,
  WaveTask,
} from "./types";
import { SYSTEM_WAVE } from "./types";
import { WaveFileError, parseWaveFile } from "./wave-file";

import { PipelineDriver, type SpawnStart, roleSpawnHold } from "./pipeline";

import { type Role, briefGatePath, isRole } from "./brief";
import {
  type ClockSample,
  type ClockState,
  type PendingReap,
  heartbeatSuppresses,
  holdReap,
  inWakeGrace,
  initialClock,
  reapVerdict,
  sampleClock,
} from "./clock";
import { HOOKS_DIR } from "./launch";
import {
  type AgentLiveness,
  CONTINUE_TEXT,
  type DecisionSlot,
  type LivenessAction,
  type Step,
  checkLiveness,
  noteCapture,
  noteDecision,
  noteResolved,
  observeScreen,
  observeSignal,
  parseHookSignal,
  rebase,
  trackAgent,
  whyWaiting,
} from "./liveness";
import { type AgentProbe, FINAL_STATUS, lockPath, readLock } from "./locks";
import {
  type ReconcileProbes,
  type ReconcileTarget,
  type Reconciliation,
  type TaskFacts,
  execProbes,
  reconcileTargets,
  reconcileTask,
} from "./reconcile";
import {
  CREDIT_CLASS,
  LIMITED_CLASS,
  STOP_ANSWER,
  UNVERIFIED_CLASS,
  creditOccurrences,
  modelSwitchInput,
  parseSwitchAnswer,
  recoveryAllowed,
  switchModel,
  switchesSent,
} from "./recovery";
import { retireAgent } from "./retire";
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
import { expandHome, worktreePath } from "./worktree";

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
  /** Clock for the screen publisher's capture schedule (tests drive it with `tickScreens()`). */
  now?: () => number;
  /** Overrides of the screen publisher's slow/hard read bounds (tests; ms). */
  screenTimeouts?: { slowMs?: number; readTimeoutMs?: number };
  /** Monotonic + wall clock sampled every tick for sleep/wake detection (tests inject a jump). */
  clock?: () => ClockSample;
  /** Override of the model-switch verification window (tests; ms). */
  recoveryTimeouts?: { modelSwitchVerifyMs?: number };
  /** git/GitHub probes for restart reconciliation (default: `git`/`gh` through the fenced exec). */
  reconcile?: ReconcileProbes;
}

/** How the daemon spawns agents. Every field has a production default. */
export interface SpawnerOptions {
  /** The `local` host (default: cmux on this machine, through the fenced exec). */
  host?: Host;
  /** Claude Code's folder-trust file (default `~/.claude.json`). */
  claudeJsonPath?: string;
  /** `packages/volley-hooks` (default: the one in this checkout). */
  hooksDir?: string;
  /** Mint per-agent broker credentials with `volley auth add-agent` (default true). */
  mintCredentials?: boolean;
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
  reapTimer?: ReturnType<typeof setTimeout> | undefined;
  /** The `reaped` status being re-verified (clock.ts). */
  pendingReap?: PendingReap | undefined;
  /** `wall_time` of a `reaped` status a heartbeat suppressed: never accepted, even re-delivered. */
  suppressedReap?: string | undefined;
  /** `wall_time` of the final status last handed to the pipeline (a re-delivery is ignored). */
  finalSeen?: string | undefined;
  /** The latest status other than `reaped` (what liveness checks while a reap is suppressed). */
  liveStatus?: string | undefined;
  /** The hook-signal activity model (liveness.ts). */
  liveness: AgentLiveness;
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

const defaultClock = (): ClockSample => ({ mono: performance.now(), wall: Date.now() });

const secondsMs = (s: number) => s * 1000;

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
export function systemPressure(
  exec: ExecFn = realExec,
  now: () => number = Date.now,
): PressureSource {
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

/** A wave file's `repo` as a directory (`~/x` → `$HOME/x`). */
const repoDir = (repo: string) =>
  repo === "~" || repo.startsWith("~/") ? join(homedir(), repo.slice(1)) : repo;

/** The hysteresis key of the global (wave-independent) admission verdict. */
const GLOBAL = "";

/**
 * The daemon's MQTT clientId. Stable, so its persistent session (and mailbox subscription)
 * survives restarts and the broker queues control requests sent while it is down (SPEC §4.4).
 */
export const daemonClientId = (namespace: string) =>
  `volley-${DAEMON_AGENT_ID}-daemon-${namespace}`;

type Reply = Omit<ControlResponse, "text" | "acked_type" | "op">;

type HandlerResult = Reply & {
  /** Sent instead as the answer once it settles (steer's ack wait), off the serial queue. */
  defer?: Promise<Reply>;
};

const OPEN_ADMISSION: Admission = { allow: Number.POSITIVE_INFINITY, reasons: [] };
/** Before the first pressure sample nothing is known about load, so nothing starts. */
const AWAITING_SAMPLE: Admission = { allow: 0, reasons: ["waiting for the first pressure sample"] };
const LIVE_STATUS = new Set(["spawning", "registered", "working"]);

const LOCK_FILE = "volleyd.lock";

/** Owner statuses that make its `coordinator.state` `gone`. */
const OWNER_GONE = new Set(["reaped", "done", "failed"]);

/** The wave_complete decision's id (one per wave). */
const WAVE_COMPLETE_DECISION = "wave_complete";

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
  private readonly waves = new Map<WaveId, WaveLog>();
  /** Why ready tasks were not admitted on the last tick, per wave. */
  private readonly heldBack = new Map<WaveId, string[]>();
  /** Each task's issue-body `Files` list, per wave (journaled on `task_queued`; overlap only). */
  private readonly issueFiles = new Map<WaveId, Record<TaskId, string[]>>();
  private readonly config: ConfigStore;
  /** The `_system` journal (config changes, lease events, the kill switch); shared with the config store. */
  private readonly system: Journal;
  /** `stop --all` engaged: every wave admits nothing and `run` is refused until `resume --all`. */
  private killSwitch: boolean;
  private readonly acks = new AckTracker();
  /** Restart reconciliation, started by `start()` beside the queue (see `reconciled()`). */
  private reconciling: Promise<void> = Promise.resolve();
  /** Epoch ms of the last progress message seen per agent id (heartbeats, for `claim`). */
  private readonly lastSeen = new Map<string, number>();
  /**
   * When this process started. `lastSeen` is in memory only, so for `claim` every owner counts
   * as seen at least at daemon start: a restart never makes a live owner instantly claimable.
   */
  private readonly startedAt = Date.now();
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
  /** What each agent's progress says about its attention (a wave owner's `coordinator`). */
  private readonly attentionOf = new Map<
    string,
    Omit<CoordinatorAttention, "agent_id" | "last_seen">
  >();
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
  private timer: ReturnType<typeof setInterval> | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private screenTimer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** Spawns between start and launch, by `<wave>/<task>/<role>`. */
  private readonly spawning = new Set<string>();
  /** Automatic spawns refused this run: retried by the loop with backoff (`volleyd spawn` now). */
  private readonly refused = new Map<string, { n: number; until: number }>();
  /** Each wave's pipeline driver (T6), created on first use. */
  private readonly pipelines = new Map<WaveId, PipelineDriver>();
  /** Live spawned agents by agent id. */
  private readonly supervised = new Map<string, Supervised>();
  /** Answered control requests by `<sender>/<correlation_id>`, for QoS 1 redelivery. */
  private readonly answered = new Map<string, ControlResponse>();
  /** Requests whose answer is deferred (steer's ack wait), by the same key. */
  private readonly deferred = new Set<string>();
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
  /** Sleep/wake detection (T8): the last clock sample and the latest wake. */
  private clock: ClockState = initialClock();
  /** Liveness clock (epoch ms). */
  private readonly now: () => number;
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
    this.now = opts.now ?? Date.now;
    this.system = Journal.open(join(opts.home, "waves", SYSTEM_WAVE));
    this.config = ConfigStore.load({ home: opts.home, system: this.system });
    this.leases = replayLeases(this.system.readAll());
    this.killSwitch = killSwitchEngaged(this.system.readAll());
    this.screens = new ScreenPublisher({
      publish: (topic, payload) => this.broker.publish(topic, payload, { qos: 0, retain: true }),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
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
      now: opts.now ?? Date.now,
      onExit: (x) => this.onTunnelExit(x),
    });
    this.tunnelChecks = new TunnelChecks({
      now: opts.now ?? Date.now,
      log: this.log,
      onChange: (key, status) => {
        // A check that lands after shutdown changes nothing.
        if (this.running) void this.enqueue(() => this.onTunnel(key, status));
      },
    });
    // The capture feeds the silence fallback (single reader): when each screen last changed.
    this.screens.onCapture((c) => {
      const a = this.supervised.get(c.agentId);
      if (a !== undefined && c.tail !== null) {
        a.liveness = noteCapture(a.liveness, { hash: c.tail.hash, at: this.now() });
      }
    });
    for (const log of loadWaves(opts.home)) {
      const wave = log.record.state?.wave;
      if (wave === undefined) continue;
      this.waves.set(wave, log);
      this.config.setWaveOverrides(wave, log.record.overrides);
      this.issueFiles.set(wave, journaledIssueFiles(log.journal.readAll()));
    }
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
    this.running = true;

    await this.publish(this.statusTopic, this.envelope("status", "spawning", {}), true);
    await this.publish(
      registryTopic(DAEMON_AGENT_ID),
      {
        ...this.envelope("_system/registry", "registered", {
          capabilities: ["supervisor"],
          cwd: this.opts.home,
          started_at: new Date().toISOString(),
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
    for (const [wave, log] of this.waves) {
      await this.publishState(wave);
      // Re-publish open decisions; clear resolved ones, in case a crash came between journaling
      // the resolution and clearing its retained topic (a zero-length clear is idempotent).
      for (const d of Object.values(log.record.decisions)) {
        if (d.resolved === undefined) await this.publishDecision(wave, d);
        else await this.clearRetained(decisionTopic(wave, d.decision_id));
      }
    }
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
    void this.leaseRequestLoop();
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
      this.timer = setInterval(() => void this.tick(), tickMs);
      this.screenTimer = setInterval(() => void this.tickScreens(), DAEMON_DEFAULTS.screen_tick_ms);
    }
    this.watchdog = setInterval(() => {
      if (this.running && !this.broker.connected) this.fail(new Error("broker connection lost"));
    }, DAEMON_DEFAULTS.watchdog_ms);
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
    if (env !== null && isApiSignal(env)) this.apiSignals.push(Date.now());
    if (env !== null) this.noteAttention(agent, env);
    // A message queued while the daemon was down arrives late: count it from when it was sent.
    const sent = env !== null ? Date.parse(env.wall_time) : Number.NaN;
    this.lastSeen.set(agent, Number.isNaN(sent) ? Date.now() : Math.min(Date.now(), sent));
    // The topic names the sender (and is what broker ACLs authorise), so it identifies the acker.
    if (env?.type === "steering_acked" && env.correlation_id !== null) {
      this.acks.acked(env.correlation_id, agent);
    }
  }

  /**
   * The attention state an agent's progress implies (SPEC §4.3): `awaiting_input` (with its
   * question, session and workspace) until anything else but `idle` says it works again.
   */
  private noteAttention(agent: string, env: Envelope): void {
    if (env.type === "idle") return;
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
        : { state: "working" };
    const before = JSON.stringify(this.attentionOf.get(agent) ?? null);
    this.attentionOf.set(agent, next);
    if (before !== JSON.stringify(next)) this.ownerChanged(agent);
  }

  /** An agent's status or attention changed: re-publish the waves it owns (`coordinator`). */
  private ownerChanged(agent: string): void {
    if (!this.running) return;
    for (const [wave, log] of this.waves) {
      if (log.record.state?.owner === agent) void this.enqueue(() => this.publishState(wave));
    }
  }

  /** wave-state `coordinator` for `owner`; undefined until anything of it was seen. */
  private coordinatorFor(owner: string): CoordinatorAttention | undefined {
    const status = this.statusOf.get(owner);
    const attention = this.attentionOf.get(owner);
    if (status === undefined && attention === undefined) return undefined;
    const seen = [
      this.lastSeen.get(owner),
      status !== undefined ? Date.parse(status.at) : undefined,
    ]
      .filter((t): t is number => t !== undefined && !Number.isNaN(t))
      .sort((a, b) => b - a)[0];
    const last_seen = new Date(seen ?? this.now()).toISOString();
    if (status !== undefined && OWNER_GONE.has(status.type)) {
      return { agent_id: owner, state: "gone", last_seen };
    }
    return { agent_id: owner, ...(attention ?? { state: "working" }), last_seen };
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

  /** Stop timers and the mailbox loop; nothing is published. */
  private halt(): void {
    this.running = false;
    clearInterval(this.timer);
    clearInterval(this.watchdog);
    clearInterval(this.screenTimer);
    this.screens.clear();
    this.tunnelsStopped = this.tunnels.stop();
    for (const a of this.supervised.values()) {
      clearTimeout(a.reapTimer);
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
    this.halt();
    await this.tunnelsStopped;
    await this.enqueue(async () => {});
    this.acks.clear();
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
        reading = await (this.opts.pressure ?? systemPressure())({
          repos,
          config: this.config.effective(),
        });
      } catch (e) {
        this.log(`pressure sample failed: ${e instanceof Error ? e.message : String(e)}`);
        reading = { samples: {}, ci: {} };
      }
      await this.enqueue(async () => {
        this.lastReading = reading;
        this.sampledAt = new Date();
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
    const now = (this.sampledAt ?? new Date()).getTime();
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
    this.summary = summaryPayload(global, this.sampledAt ?? new Date(), waves);
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
          this.statusOf.set(holder, { type: env.type, at: env.wall_time });
          if (prev !== env.type) this.ownerChanged(holder);
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
    await this.runLeases({ kind: "request", pool, req });
  }

  /** Step the lease book: journal + mirror every event, re-publish the pools it touched. */
  private async runLeases(input: LeaseInput): Promise<void> {
    const pools = this.config.effective().lease_pools;
    const r = leaseStep(this.leases, input, {
      pools,
      now: new Date(),
      defaultTtlS: DAEMON_DEFAULTS.lease_default_ttl_s,
    });
    const touched = new Set<string>(input.kind === "request" ? [input.pool] : []);
    for (const ev of r.events) {
      const e = this.system.append(ev);
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
    await this.runLeases({ kind: "tick" });
    await this.monitor();
    for (const wave of this.waves.keys()) await this.completeIfSettled(wave);
    let live = 0;
    for (const log of this.waves.values()) live += activeTasks(log.record).length;
    for (const [wave, log] of this.waves) {
      const rec = log.record;
      const candidates = admissible(rec);
      if (candidates.length === 0 || rec.wave === null) {
        if (this.heldBack.delete(wave)) await this.publishState(wave);
        continue;
      }
      const eff = this.config.effective(wave);
      const verdict = admit(candidates, admissionFor(rec, this.killSwitch, this.pressure(wave)), {
        live,
        hardCeiling: eff.hard_ceiling,
        spawnsUsed: spawnsUsed(rec),
        spawnBudget: spawnBudget(rec.wave, eff.spawn_budget_multiplier),
      });
      live += verdict.admit.length;
      const before = JSON.stringify(this.heldBack.get(wave) ?? []);
      this.heldBack.set(wave, verdict.reasons);
      for (const task of verdict.admit)
        await this.append(wave, { type: "task_admitted", task, data: {} });
      if (verdict.admit.length === 0 && before !== JSON.stringify(verdict.reasons)) {
        await this.publishState(wave);
      }
    }
    if (this.opts.spawner !== undefined) {
      await this.resolveTrustedRepos();
      for (const wave of this.waves.keys()) this.spawnAdmitted(wave);
      // Level-triggered pipeline work: retry held role spawns, re-check pending CI, see merges.
      // Its git / gh checks run beside the queue; one wave's error never skips the others.
      for (const wave of this.waves.keys()) {
        if (this.waves.get(wave)?.record.state?.status !== "running") continue;
        try {
          await this.pipelineFor(wave).tick();
        } catch (e) {
          this.log(`pipeline ${wave}: ${e instanceof Error ? e.message : String(e)}`);
        }
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
    await this.append(wave, { type: "wave_complete", data: { done, cancelled } });
    if (rec.decisions[WAVE_COMPLETE_DECISION] === undefined) {
      const merged = done.length > 0 ? ` merged into ${state.release_branch}` : "";
      await this.openDecisionNow(wave, {
        kind: "wave_complete",
        task: null,
        id: WAVE_COMPLETE_DECISION,
        question: `Wave ${wave} is complete: ${done.length} task(s) done${merged}, ${cancelled.length} cancelled. Review and merge ${state.release_branch} when ready.`,
        options: ["acknowledged"],
      });
    }
    this.log(
      `wave ${wave} complete: done ${done.join(", ") || "-"}; cancelled ${cancelled.join(", ") || "-"}`,
    );
  }

  // -------------------------------------------------------------------------------------------
  // Spawning (T4): admitted tasks get an implementer; other roles are sequenced by the pipeline.
  // -------------------------------------------------------------------------------------------

  /** Start an implementer for every admitted task that has none (runs beside the queue). */
  private spawnAdmitted(wave: WaveId): void {
    const rec = this.waves.get(wave)?.record;
    if (this.killSwitch || rec?.state == null || rec.state.status !== "running") return;
    this.checkTunnels(wave);
    for (const id of rec.admitted) {
      const t = rec.state.tasks.find((x) => x.id === id);
      if (t === undefined || t.agents.implementer !== undefined || t.stage !== "queued") continue;
      const key = `${wave}/${id}/implementer`;
      if (this.spawning.has(key) || (this.refused.get(key)?.until ?? 0) > Date.now()) continue;
      if (this.parkOnTunnel(wave, id)) continue;
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
  private async startSpawn(
    wave: WaveId,
    task: string,
    role: Role,
    pipeline: { start?: SpawnStart; files?: Record<string, string> } = {},
  ): Promise<SpawnResult> {
    const log = this.waves.get(wave);
    const w = log?.record.wave;
    if (log === undefined || w == null) throw new Error(`unknown wave '${wave}'`);
    const t = w.tasks[task];
    if (t === undefined) throw new Error(`unknown task '${task}' in wave ${wave}`);
    const key = `${wave}/${task}/${role}`;
    let remote: RemoteHost | undefined;
    if (t.host !== "local") {
      try {
        remote = this.remoteHost(wave, t);
      } catch (e) {
        this.noteRefusal(key);
        const err =
          e instanceof SpawnError
            ? e
            : new SpawnError("LAUNCH_FAILED", e instanceof Error ? e.message : String(e));
        await this.append(wave, {
          type: "alarm_raised",
          task,
          data: { code: err.code, message: err.message, role, host: t.host, ...err.detail },
        });
        throw err;
      }
    }
    this.spawning.add(key);
    try {
      const attempt =
        log.journal
          .readAll()
          .filter((e) => e.type === "agent_spawned" && e.task === task && e.data.role === role)
          .length + 1;
      const deps = this.spawnDeps(wave);
      let req = { wave: w, task, role, attempt, ...pipeline };
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
        void res.verified.then(
          (outcome) => this.supervise(wave, task, role, outcome, res.lock.path, host, tunnel),
          (e: unknown) => this.log(`verify ${key}: ${e instanceof Error ? e.message : String(e)}`),
        );
      }
      return res;
    } catch (e) {
      this.noteRefusal(key);
      throw e;
    } finally {
      this.spawning.delete(key);
    }
  }

  /** Back off an automatic spawn that was refused: retried after 2^(n-1) × base, capped. */
  private noteRefusal(key: string): void {
    const n = (this.refused.get(key)?.n ?? 0) + 1;
    const wait = Math.min(
      DAEMON_DEFAULTS.spawn_retry_base_ms * 2 ** (n - 1),
      DAEMON_DEFAULTS.spawn_retry_max_ms,
    );
    this.refused.set(key, { n, until: Date.now() + wait });
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

  /** Where a task's `.volley/decisions.md` goes (its worktree once it has one). */
  private taskDirFor(wave: WaveId, task: TaskId): string {
    if (this.opts.taskDir !== undefined) return this.opts.taskDir(wave, task);
    const wt =
      this.opts.spawner !== undefined
        ? this.spawnedRecord((e) => e.task === task, wave)?.worktree
        : undefined;
    return typeof wt === "string" ? wt : join(this.opts.home, "waves", wave, "tasks", task);
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
        cfg ??= readClaudeJson(this.claudeJsonPath);
        if (!isRepoTrusted(cfg, expandHome(repo))) continue;
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
    const now = (this.opts.now ?? Date.now)();
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
    void remote
      .readTrust()
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
    );
    return rec.decision_id;
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
      mintCredentials: spawner.mintCredentials ?? true,
      tunables: eff,
      owner: log.record.state?.owner ?? null,
      journal: (ev) => this.append(wave, ev),
      get openDecisions() {
        return log.record.state?.open_decisions ?? [];
      },
      probe,
      watch: (ns, id) => watchAgent(this.broker, ns, id, Date.now, this.progressFeed),
      briefGate: briefGatePath(this.opts.home),
      ...(spawner.briefsDir !== undefined ? { briefsDir: spawner.briefsDir } : {}),
      clearRetained: (topic) => this.broker.publish(topic, "", { qos: 1, retain: true }),
      openDecision: (d) => this.openSpawnDecision(wave, d),
      resolveDecision: async (id, answer, by) => {
        await this.resolveNow(wave, id, { answer, by });
      },
    };
  }

  // -------------------------------------------------------------------------------------------
  // Remote hosts (T15): ssh + tmux on a second machine, broker through a reverse tunnel.
  // -------------------------------------------------------------------------------------------

  /** The task's remote host: config `hosts.<name>` ← its inline `host:`. Throws if unresolvable. */
  private remoteHost(wave: WaveId, t: WaveTask): RemoteHost {
    const spec = resolveRemoteHost(t.host, t.host_spec, this.config.effective(wave).hosts);
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
      const def = rec?.wave?.tasks[t.id];
      if (
        def === undefined ||
        def.host === "local" ||
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
        this.tunnelChecks.poke(key, () => this.startTunnel(h));
        continue;
      }
      this.tunnelChecks.poke(key, async (): Promise<TunnelStatus> => {
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
    const reason =
      status === "up"
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
    const decisionId = `remote_repo_missing-${createHash("sha256").update(`${spec.target}:${spec.repo}`).digest("hex").slice(0, 12)}`;
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
        // Trust is the box's own: read from its ~/.claude.json at every spawn, never mirrored.
        remoteTrust: { host: spec.name, target: spec.target, read: () => remote.readTrust() },
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
    this.screens.track({
      agentId,
      namespace: watch.namespace,
      workspace: outcome.workspace,
      host,
      intervalS: () => this.config.effective(wave).screen_tail_interval_s,
    });
    const check = (type: string) => {
      if (this.supervised.get(agentId) !== a) return;
      if (type === "reaped") {
        // A re-delivery (same wall_time) of a reap a heartbeat already suppressed changes nothing.
        if (a.watch.state.status?.wall_time === a.suppressedReap) return;
        a.suppressedReap = undefined;
        if (a.pendingReap === undefined) holdReaped();
        return;
      }
      clearTimeout(a.reapTimer);
      a.reapTimer = undefined;
      a.reapDeferred = false;
      a.pendingReap = undefined;
      a.suppressedReap = undefined;
      a.liveStatus = type;
      if (!FINAL_STATUS.has(type)) return;
      // A re-delivery (same wall_time) of a final status already handed over is not a new claim.
      const at = a.watch.state.status?.wall_time;
      if (at !== undefined && at === a.finalSeen) return;
      a.finalSeen = at;
      // A `done` is a claim: the pipeline checks it before the agent is retired (T6).
      void this.enqueue(() => this.onFinal(agentId, type));
    };
    watch.onStatus(check);
    if (watch.state.status !== null) check(watch.state.status.type);
  }

  private async retire(agentId: string, status: string): Promise<void> {
    const a = this.supervised.get(agentId);
    const log = a !== undefined ? this.waves.get(a.wave) : undefined;
    if (a === undefined || log === undefined) return;
    this.supervised.delete(agentId);
    clearTimeout(a.reapTimer);
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
    const waveAgents = new Set(
      log.journal
        .readAll()
        .filter((e) => e.type === "agent_spawned")
        .map((e) => e.data.agent_id as string),
    );
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
      },
      {
        exec: a.host.exec,
        clearRetained: (topic) => this.broker.publish(topic, "", { qos: 1, retain: true }),
        journal: (ev) => this.append(a.wave, ev),
        releaseLock: (path) => {
          try {
            unlinkSync(path);
          } catch {}
        },
      },
    );
  }

  // -------------------------------------------------------------------------------------------
  // Pipeline (T6): every role's `done` is verified before the next stage; volleyd never merges.
  // -------------------------------------------------------------------------------------------

  /** The pipeline driver of a wave, on this daemon's journal, spawner, steering and decisions. */
  private pipelineFor(wave: WaveId): PipelineDriver {
    let d = this.pipelines.get(wave);
    if (d !== undefined) return d;
    const log = this.waves.get(wave) as WaveLog;
    d = new PipelineDriver(wave, {
      exec: this.host.exec,
      // A task on a remote host (T15): its worktrees, and so its git / gh checks, are on the box.
      execFor: (task) => {
        const t = log.record.wave?.tasks[task];
        return t === undefined || t.host === "local"
          ? this.host.exec
          : this.remoteHost(wave, t).exec;
      },
      home: this.opts.home,
      record: () => log.record,
      journal: (ev) => this.append(wave, ev),
      spawn: async (task, role, req) => this.pipelineSpawn(wave, task, role, req),
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
      retire: (agentId) => this.retire(agentId, "done"),
      // Checks fold back in on the queue; after a stop there is nothing left to fold them into.
      enqueue: async (fn) => {
        if (this.running) await this.enqueue(fn);
      },
      log: (line) => this.log(line),
    });
    this.pipelines.set(wave, d);
    return d;
  }

  /**
   * A supervised agent's final status. `failed` (and an accepted `reaped`) retires it at once and
   * tells the pipeline it failed; `done` goes to the pipeline, which verifies the claim (steering
   * the agent while it is still live) and retires it.
   */
  private async onFinal(agentId: string, type: string): Promise<void> {
    const a = this.supervised.get(agentId);
    if (a === undefined) return;
    if (type !== "done") await this.retire(agentId, type);
    const raw = await this.broker
      .queryRetained(buildTopic(a.namespace, agentId, "result"), DAEMON_DEFAULTS.probe_ms)
      .catch(() => null);
    const result = raw !== null && raw !== "" ? parseEnvelope(raw)?.payload : undefined;
    await this.pipelineFor(a.wave).handle(a.task, {
      kind: "agent_done",
      role: a.role,
      agent_id: agentId,
      status: type === "done" ? "done" : "failed",
      ...(result !== undefined ? { result } : {}),
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
    req: { start?: SpawnStart; files: Record<string, string> },
  ): void {
    const rec = this.waves.get(wave)?.record;
    if (this.opts.spawner === undefined || rec?.wave == null) return;
    const key = `${wave}/${task}/${role}`;
    if (this.spawning.has(key) || (this.refused.get(key)?.until ?? 0) > Date.now()) return;
    const admission = admissionFor(rec, this.killSwitch, this.pressure(wave));
    const hold = roleSpawnHold({
      killSwitch: this.killSwitch,
      running: rec.state?.status === "running",
      admission: admission.allow,
      reasons: admission.reasons,
      used: spawnsUsed(rec),
      budget: spawnBudget(rec.wave, this.config.effective(wave).spawn_budget_multiplier),
    });
    if (hold !== null) {
      this.log(`spawn ${key}: held, ${hold}`);
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
    return (this.opts.clock ?? defaultClock)().wall;
  }

  /** (Re-)arm the timer that accepts a pending reap unless a heartbeat moved it. */
  private scheduleReap(agentId: string, a: Supervised): void {
    clearTimeout(a.reapTimer);
    const p = a.pendingReap;
    if (p === undefined) return;
    a.reapTimer = setTimeout(
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
    clearTimeout(a.reapTimer);
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
        clearTimeout(a.reapTimer);
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
    });
  }

  /** The monitor half of a tick: sleep/wake, then every supervised agent's liveness. */
  private async monitor(): Promise<void> {
    const r = sampleClock(this.clock, (this.opts.clock ?? defaultClock)());
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
      await this.applyLiveness(
        agentId,
        a,
        checkLiveness(a.liveness, { now, status, tunables: eff }),
      );
    }
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
        note(
          slot,
          (await this.openDecisionNow(wave, input, { agent_id: agentId, ...data })).decision_id,
        );
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
      case "agent_stalled":
        return open(
          "stalled",
          {
            kind: "agent_stalled",
            task,
            question: `Needs you: ${agentId} ended its turn without publishing done/blocked/failed and is still idle ${Math.floor(x.idle_s / 60)} min later, after a nudge.${x.last_text !== null ? ` Last message: ${clipText(x.last_text)}` : ""} Answer to steer it, or stop the task.`,
            options: ["nudge again", STOP_ANSWER],
            pointers: { screen: buildTopic(a.namespace, agentId, "screen") },
          },
          { class: "agent_stalled", idle_s: x.idle_s },
        );
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
                ? `Needs you: no hook signal from ${agentId} for ${min} min while its screen keeps changing: hooks may be broken by a harness update. Look at its terminal?`
                : `Needs you: no hook signal from ${agentId} for ${min} min and its screen is not changing. Look at its terminal?`,
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
      const timer = setTimeout(() => resolve(null), DAEMON_DEFAULTS.screen_read_timeout_ms);
      host.readScreen(workspace, DAEMON_DEFAULTS.screen_lines).then(
        (s) => {
          clearTimeout(timer);
          resolve(s);
        },
        () => {
          clearTimeout(timer);
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
   */
  private async onRecoveryResolved(wave: WaveId, d: DecisionRecord): Promise<void> {
    const x = d as unknown as Record<string, unknown>;
    const agentId = typeof x.agent_id === "string" ? x.agent_id : undefined;
    const cls = typeof x.class === "string" ? x.class : undefined;
    if (agentId === undefined || cls === undefined || d.resolved === undefined || d.task === null)
      return;
    const a = this.supervised.get(agentId);
    if (a !== undefined) a.liveness = noteResolved(a.liveness, d.decision_id, this.now());
    const { answer, by } = d.resolved;
    if (by === agentId) return;
    const why = `${by} stopped the task (decision ${d.decision_id})`;
    if (cls === "respawn_needed") {
      const a = answer.trim().toLowerCase();
      const respawn = a === "respawn" && isRole(String(x.role)) && this.opts.spawner !== undefined;
      if (a !== STOP_ANSWER && !respawn) return;
      // Either way the vanished agent is done with: retired, so no later restart reconciles it.
      await this.retireGone(wave, d.task, agentId, x);
      if (!respawn) {
        await this.append(wave, { type: "task_cancelled", task: d.task, data: { by, why } });
        return;
      }
      // Approved by the owner: a fresh spawn (its own lock check still applies).
      const role = String(x.role) as Role;
      const task = d.task;
      this.refused.delete(`${wave}/${task}/${role}`);
      void this.startSpawn(wave, task, role).catch((e: unknown) =>
        this.log(`respawn ${wave}/${task}: ${e instanceof Error ? e.message : String(e)}`),
      );
      return;
    }
    if (a === undefined) return;
    if (answer.trim().toLowerCase() === STOP_ANSWER)
      return this.cancelTask(wave, d.task, agentId, why);
    switch (cls) {
      case "agent_question":
        return this.steerAgent(agentId, a, answer, {
          reason: "answer",
          decision_id: d.decision_id,
        });
      case "agent_stalled":
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
    const revoked = d.minted === true ? await revokeCredentials(this.host.exec, agentId) : null;
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
        model,
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
    const watch = await watchAgent(this.broker, ns, id, this.now, this.progressFeed);
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
    });
  }

  /** The host (and a remote one's forward) a task's agents run on; local when unresolvable. */
  private hostOfTask(wave: WaveId, task: TaskId): [Host, string?] {
    const def = this.waves.get(wave)?.record.wave?.tasks[task];
    if (def === undefined || def.host === "local") return [this.host];
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

  /** Append to a wave journal, then mirror the event and re-publish the retained state. */
  private async append(wave: WaveId, ev: NewEvent): Promise<JournalEvent> {
    const log = this.waves.get(wave);
    if (log === undefined) throw new Error(`unknown wave '${wave}'`);
    const event = log.append(ev);
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

  /** The wave state as published: the reduced journal plus effective config and admission reasons. */
  snapshot(wave: WaveId): WaveState | null {
    const rec = this.waves.get(wave)?.record;
    if (rec?.state == null) return null;
    const state = structuredClone(rec.state);
    state.effective_config = this.config.effective(wave);
    const held = this.heldBack.get(wave) ?? [];
    const candidates = new Set(admissible(rec));
    for (const t of state.tasks) {
      const host = rec.wave?.tasks[t.id]?.host;
      if (host !== undefined && host !== "local") t.host = host;
    }
    for (const t of state.tasks) {
      if (t.stage !== "queued" || t.why_waiting !== undefined) continue;
      const parked = this.parked.get(`${wave}/${t.id}`);
      if (parked !== undefined) t.why_waiting = parked;
      else if (rec.admitted.includes(t.id)) t.why_waiting = "admitted: awaiting spawn";
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
    // queued behind one. Published only; internally the wave keeps running.
    if (state.status === "running" && state.open_decisions.length > 0) {
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

  /** The reduced record of a wave (undefined when unknown). */
  record(wave: WaveId) {
    return this.waves.get(wave)?.record;
  }

  /** Every journal event of a wave, oldest first. */
  journalEvents(wave: WaveId): JournalEvent[] {
    return this.waves.get(wave)?.journal.readAll() ?? [];
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

  /** `openDecision` without the queue; `extra` facts are kept on the decision (journal + topic). */
  private async openDecisionNow(
    wave: WaveId,
    input: DecisionInput,
    extra: Record<string, unknown> = {},
  ): Promise<DecisionRecord> {
    const log = this.waves.get(wave);
    if (log === undefined) throw new Error(`unknown wave '${wave}'`);
    const r = openEvent(log.record, input, new Date());
    if ("error" in r) throw new Error(r.error);
    await this.append(wave, { ...r.event, data: { ...extra, ...r.event.data } });
    const d = log.record.decisions[r.id] as DecisionRecord;
    await this.publishDecision(wave, d);
    // SPEC §4.1: progress is QoS 0, not retained.
    await this.broker.publish(
      buildTopic(this.opts.namespace, DAEMON_AGENT_ID, "progress"),
      JSON.stringify(this.envelope("progress", "blocked", attentionPayload(d))),
      { qos: 0, retain: false },
    );
    this.log(`opened ${describeDecision(d)}`);
    return d;
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
    r: { answer: string; by: string; rationale?: string },
  ): Promise<{ decision: DecisionRecord; already_resolved: boolean; brief?: string }> {
    const log = this.waves.get(wave);
    if (log === undefined) throw new Error(`unknown wave '${wave}'`);
    const ev = resolveEvent(log.record, id, r, new Date());
    if ("error" in ev) throw new Error(ev.error);
    if ("already" in ev) return { decision: ev.already, already_resolved: true };
    await this.append(wave, ev.event);
    const d = log.record.decisions[id] as DecisionRecord;
    const topic = decisionTopic(wave, id);
    await this.publish(
      topic,
      this.envelope("_waves/decisions", "decision_resolved", decisionPayload(d)),
      false,
    );
    await this.clearRetained(topic);
    this.log(`resolved ${id} by ${r.by}: ${r.answer}`);
    await this.onRecoveryResolved(wave, d);
    if (
      d.kind === "remote_repo_missing" &&
      d.task !== null &&
      r.answer.trim().toLowerCase() === "cancel"
    ) {
      await this.append(wave, {
        type: "task_cancelled",
        task: d.task,
        data: { by: r.by, why: `no clone on the remote host (decision ${id})` },
      });
    }
    if (d.task === null) return { decision: d, already_resolved: false };
    if ((d as { pipeline?: unknown }).pipeline !== undefined && this.opts.spawner !== undefined) {
      const task = d.task;
      void this.enqueue(() =>
        this.pipelineFor(wave).handle(task, { kind: "decision_resolved", decision: d }),
      );
    }
    // The next stage's brief: every resolved decision of the task, in opening order. The
    // resolution is already journaled, so a failed write is logged, not reported as a failure.
    const all = Object.values(log.record.decisions).filter((x) => x.task === d.task);
    let dir = `the brief for ${wave}/${d.task}`;
    try {
      dir = this.taskDirFor(wave, d.task);
      const brief = writeDecisionsFile(dir, renderDecisionsMd(wave, d.task, all));
      return { decision: d, already_resolved: false, brief };
    } catch (e) {
      this.log(`resolved ${id}, but writing ${dir}: ${e instanceof Error ? e.message : String(e)}`);
      return { decision: d, already_resolved: false };
    }
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
    // Answers go to the sender's mailbox in the namespace the request came from.
    // A SPEC §4.4 ack of a message the daemon sent (steer): the recipient received it.
    if (req.type === "ack") {
      if (req.correlation_id !== null) this.acks.received(req.correlation_id, req.agent_id);
      return;
    }
    if (req.type !== "query") return;
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
    const send = (reply: ControlResponse) =>
      this.publish(
        buildTopic(ns, req.agent_id, "mailbox"),
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

  private async handle(
    op: string,
    p: Record<string, unknown>,
    req: Envelope,
  ): Promise<HandlerResult> {
    const by = typeof p.by === "string" && p.by !== "" ? p.by : req.agent_id;
    switch (op) {
      case "decisions":
        return this.listDecisions(p);
      case "resolve":
        return this.resolveOp(p, by);
      case "claim":
        // Ownership must go to a stable identity, never the CLI's per-invocation agent id.
        if (typeof p.by !== "string" || p.by === "")
          return {
            ok: false,
            error: "claim needs an identity: pass --by <agent-id> or set VOLLEY_AGENT_ID",
          };
        // The new owner lands in the wave-state `owner` (agent id pattern): never a free-form name.
        if (!isValidAgentId(p.by))
          return {
            ok: false,
            error: `claim: "${p.by}" is not a valid agent id ([a-z0-9][a-z0-9_-]{0,62})`,
          };
        return this.claim(p, p.by);
      case "pause":
      case "resume":
      case "stop":
        return this.waveControl(op, p, by);
      case "steer":
        return this.steer(p, by);
      case "status": {
        if (typeof p.wave === "string") {
          const state = this.snapshot(p.wave);
          return state === null
            ? { ok: false, error: `unknown wave '${p.wave}'` }
            : { ok: true, result: state };
        }
        return {
          ok: true,
          result: {
            waves: [...this.waves.keys()].map((w) => this.snapshot(w)),
            ...(this.killSwitch ? { kill_switch: true } : {}),
          },
        };
      }
      case "run":
        return this.submit(p);
      case "diff":
        return this.planDiff(p);
      case "admission":
        return { ok: true, result: this.summary };
      case "spawn":
        return this.manualSpawn(p);
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
    if (first.existing !== undefined) {
      return this.resubmit(first.existing, first.wave, p.wave_yaml as string);
    }
    const text = p.wave_yaml as string;
    if (this.opts.issueBody === undefined)
      return this.commitSubmit(first.wave, first.owner, {}, text);
    // Fetching issue bodies can take seconds: do it off the serial queue (control ops and ticks,
    // the kill switch included, keep running), then commit inside it, re-checking what may have
    // changed meanwhile (the kill switch, a racing submit of the same wave id).
    return {
      ok: true,
      defer: this.fetchIssueFiles(first.wave).then((files) =>
        this.serial(async () => {
          // The daemon may have stopped (and released the home lock) while the fetch ran.
          if (!this.running) return { ok: false, error: "daemon stopping" };
          const again = this.checkSubmit(p);
          if ("refusal" in again) return again.refusal;
          if (again.existing !== undefined) return this.resubmit(again.existing, again.wave, text);
          return this.commitSubmit(again.wave, again.owner, files, text);
        }),
      ),
    };
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
    const log = this.waves.get(wave.wave);
    const existing = log?.record.state;
    if (log === undefined || existing == null) return { wave, owner };
    if (existing.owner !== null && existing.owner !== owner) {
      return refuse({
        ok: false,
        error: `wave '${wave.wave}' is already ${existing.status} under owner ${existing.owner}`,
      });
    }
    return { wave, owner, existing: log };
  }

  /** Parse a request's `wave_yaml`; a Reply when it is missing or invalid. */
  private parseRequestWave(p: Record<string, unknown>, op: string): Wave | Reply {
    if (typeof p.wave_yaml !== "string")
      return { ok: false, error: `${op} requires payload.wave_yaml` };
    try {
      return parseWaveFile(p.wave_yaml, typeof p.source === "string" ? p.source : undefined);
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
  ): Promise<Reply> {
    const wave: Wave = { ...submitted, version: 1 };
    this.waves.set(wave.wave, WaveLog.open(join(this.opts.home, "waves", wave.wave)));
    this.issueFiles.set(wave.wave, issueFiles);
    this.config.setWaveOverrides(wave.wave, wave.config);
    this.storeVersion(this.versionFile(wave.wave, 1), text);
    await this.append(wave.wave, { type: "wave_submitted", data: { wave, owner } });
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
    const log = this.waves.get(p.wave);
    return log === undefined ? { error: `unknown wave '${p.wave}'` } : { wave: p.wave, log };
  }

  /** `decisions`: open decisions (all with `all: true`), for one wave or every wave. */
  private listDecisions(p: Record<string, unknown>): HandlerResult {
    if (typeof p.wave === "string" && !this.waves.has(p.wave))
      return { ok: false, error: `unknown wave '${p.wave}'` };
    const decisions: DecisionPayload[] = [...this.waves]
      .filter(([w]) => typeof p.wave !== "string" || w === p.wave)
      .flatMap(([, log]) =>
        p.all === true ? Object.values(log.record.decisions) : openDecisions(log.record),
      )
      .map(decisionPayload);
    return { ok: true, result: { decisions } };
  }

  /** `resolve`: owner-only; finds the decision's wave when none is given. */
  private async resolveOp(p: Record<string, unknown>, by: string): Promise<HandlerResult> {
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
    const refused = guardMutation(state, by, "resolve");
    if (refused !== null) return { ok: false, error: refused };
    const trust = await this.trustAnswer(wave, id, p.answer);
    if (trust !== null) return { ok: false, error: trust };
    const r = await this.resolveNow(wave, id, {
      answer: p.answer,
      by,
      ...(typeof p.rationale === "string" ? { rationale: p.rationale } : {}),
    });
    if (!r.already_resolved) await this.applyPlanAnswer(wave, r.decision, by);
    return {
      ok: true,
      result: {
        wave,
        decision_id: id,
        already_resolved: r.already_resolved,
        resolved: r.decision.resolved,
        ...(r.brief !== undefined ? { brief: r.brief } : {}),
      },
    };
  }

  /** Carry out the owner's answer to a plan_change decision (plan-apply.ts `planAnswer`). */
  private async applyPlanAnswer(wave: WaveId, d: DecisionRecord, by: string): Promise<void> {
    const log = this.waves.get(wave) as WaveLog;
    const effect = planAnswer(log.record, d);
    if (effect.cancel !== undefined && d.task !== null) {
      const task = d.task;
      for (const a of runningAgents(log.record).filter((x) => x.task === task)) {
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
    try {
      if (typeof target === "string") {
        const remote = this.remoteForDecision(wave, d);
        if (remote === undefined) return `no configured host reaches ${target} to trust ${root}`;
        await remote.recordTrust(root);
      } else recordRepoTrust(this.claudeJsonPath, root);
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
    const info = owner !== null && owner !== by ? await this.ownerLiveness(owner) : null;
    const verdict = claimVerdict({
      owner,
      by,
      status: info?.status ?? null,
      registryAt: info?.registryAt ?? null,
      heartbeatAt: owner !== null ? (this.lastSeen.get(owner) ?? this.startedAt) : null,
      ownedSince: ownedSince(this.journalEvents(w.wave)),
      now: Date.now(),
      claimAfterS: this.config.effective(w.wave).claim_after_s,
    });
    if (!verdict.ok) return { ok: false, error: `wave '${w.wave}': ${verdict.reason}` };
    if (owner !== by) {
      await this.append(w.wave, {
        type: "owner_claimed",
        data: { owner: by, previous: owner, why: verdict.why },
      });
      this.log(`wave ${w.wave} claimed by ${by} from ${owner ?? "-"}: ${verdict.why}`);
      // Its live agents may now ack the new owner's steers; the grant runs beside the queue.
      void this.extendAckGrants(w.wave, by);
    }
    return { ok: true, result: { wave: w.wave, owner: by, previous: owner, why: verdict.why } };
  }

  /**
   * A wave changed owner: let each of its live agents with minted credentials ack the new owner
   * too (`volley auth grant`, password kept). A failure is journaled as an alarm.
   */
  private async extendAckGrants(wave: WaveId, owner: string): Promise<void> {
    for (const [agentId, a] of [...this.supervised]) {
      if (a.wave !== wave || !a.minted) continue;
      try {
        await grantAckTo(a.host.exec, agentId, [owner]);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this.log(`ack grant ${agentId} → ${owner}: ${message}`);
        if (!this.running) return;
        await this.recordEvent(wave, {
          type: "alarm_raised",
          task: a.task,
          data: {
            code: "ACK_GRANT_FAILED",
            message: `${agentId} cannot ack the new owner ${owner}: ${message}`,
            agent_id: agentId,
            owner,
          },
        }).catch(() => {});
      }
    }
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
    const refused = guardMutation(state, by, op);
    if (refused !== null) return { ok: false, error: refused };
    const done = (changed: boolean): HandlerResult => ({
      ok: true,
      result: { wave: w.wave, status: w.log.record.state?.status, changed },
    });
    if (op === "pause") {
      if (state.status === "paused") return done(false);
      if (state.status !== "running")
        return {
          ok: false,
          error: `wave '${w.wave}' is ${state.status}; only a running wave can be paused`,
        };
      await this.append(w.wave, { type: "wave_paused", data: { by } });
      await this.tickNow();
      return done(true);
    }
    if (op === "resume") {
      if (state.status === "running") return done(false);
      if (this.killSwitch)
        return { ok: false, error: `${KILL_SWITCH_REASON}: \`volleyd resume --all\` first` };
      if (state.status === "complete") return { ok: false, error: `wave '${w.wave}' is complete` };
      await this.append(w.wave, { type: "wave_resumed", data: { by } });
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
    for (const a of runningAgents(log.record)) {
      await this.cancelAgent(wave, a, by, cancelPayload(wave, a.task, by));
      cancelled.push(a.agent_id);
    }
    this.log(`wave ${wave} stopped by ${by}; cancelled ${cancelled.length} agent(s)`);
    return cancelled;
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
  private async appendSystem(ev: NewEvent): Promise<void> {
    const event = this.system.append(ev);
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
  ): Promise<void> {
    const log = this.waves.get(wave) as WaveLog;
    const { seq, supersedes } = nextSteer(log.record, task);
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
    const refused = guardMutation(w.log.record.state as WaveState, by, "steer");
    if (refused !== null) return { ok: false, error: refused };
    if (p.role !== undefined && (typeof p.role !== "string" || !isTaskRole(p.role)))
      return {
        ok: false,
        error: `unknown role '${String(p.role)}' (one of ${TASK_ROLES.join(", ")})`,
      };
    const role = p.role;
    const target = steerTarget(w.log.record, p.task, role);
    if (target === null) {
      return {
        ok: false,
        error: w.log.record.state?.tasks.some((t) => t.id === p.task)
          ? `task '${p.task}' has no agent${role !== undefined ? ` in role ${role}` : ""} to steer`
          : `unknown task '${p.task}' in wave '${w.wave}'`,
      };
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
    return {
      ok: true,
      defer: heard.then(({ received, acked }) => ({
        ok: true,
        result: {
          ...result,
          delivery: acked ? "acked" : received ? "received" : "delivered",
          received,
          acked,
          ...(acked ? { acked_by: target.agent_id } : {}),
        },
      })),
    };
  }

  /** A new version of a submitted wave: store the file, journal the plan change, re-admit. */
  private async resubmit(log: WaveLog, wave: Wave, text: string): Promise<Reply> {
    const rec = log.record;
    const state = rec.state;
    if (state === null) return { ok: false, error: `wave '${wave.wave}' has no state` };
    if (state.status === "complete" || state.status === "stopped") {
      return {
        ok: false,
        error: `wave '${wave.wave}' is ${state.status}; a new version applies only to a live wave`,
      };
    }
    const file = this.versionFile(wave.wave, state.version + 1);
    const now = new Date().toISOString();
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
    for (const ev of res.planEvents) await this.append(wave.wave, ev);
    // plan_change decisions go through the decision store: journal + retained decision topic.
    for (const d of res.decisions) {
      if (d.op === "resolve") {
        await this.resolveNow(wave.wave, d.decision_id, { answer: d.answer, by: d.by });
      } else await this.openDecisionNow(wave.wave, d.input, d.extra);
    }
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
function ownedSince(events: readonly JournalEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as JournalEvent;
    if (e.type === "owner_claimed" || e.type === "wave_submitted") return e.at;
  }
  return new Date().toISOString();
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
