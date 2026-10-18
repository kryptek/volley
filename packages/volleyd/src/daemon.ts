import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { VolleyBroker } from "volley-mcp/broker";
import { type Envelope, buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { buildTopic, isValidAgentId, registryTopic } from "volley-mcp/topics";
import { DAEMON_DEFAULTS } from "./config-defaults";
import { ConfigStore } from "./config-store";
import {
  CONFIG_TOPIC,
  type ControlResponse,
  DAEMON_AGENT_ID,
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
import { exec } from "./exec";
import type { Host } from "./hosts/host";
import { LocalCmuxHost } from "./hosts/local-cmux";
import { Journal, WaveLog } from "./journal";
import { type IssueBodyFn, findOverlaps, formatOverlap, parseFilesSection } from "./overlap";
import { claimVerdict, guardMutation } from "./ownership";
import type { WaveRecord } from "./reducer";
import { type Admission, activeTasks, admit, spawnBudget, spawnsUsed } from "./scheduler";
import { toPathErrors, validator } from "./schemas";
import type { JournalEvent, NewEvent, TaskId, TunablesPatch, WaveId, WaveState } from "./types";
import { SYSTEM_WAVE } from "./types";
import { WaveFileError, parseWaveFile } from "./wave-file";

import { type Role, briefGatePath, isRole } from "./brief";
import { HOOKS_DIR } from "./launch";
import { type AgentProbe, TERMINAL_STATUS, lockPath } from "./locks";
import { retireAgent } from "./retire";
import { type SpawnDeps, type SpawnOutcome, type SpawnResult, spawnAgent } from "./spawn";
import { SpawnError } from "./spawn-error";
import { type AgentWatch, watchAgent } from "./verify";
import { worktreePath } from "./worktree";

export interface DaemonOptions {
  brokerUrl: string;
  namespace: string;
  /** $VOLLEYD_HOME — journals live under `<home>/waves/<wave>/`, config at `<home>/config.yaml`. */
  home: string;
  /** Admission/monitor tick interval; 0 disables the timer (tests drive `tick()`). */
  tickMs?: number;
  /** Spawn admission verdict per wave. T5 supplies the pressure-based one; default is open. */
  admission?: (wave: WaveId) => Admission;
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
  /** Interrupts an agent's session on `stop` (e.g. Escape via cmux). Default: none. */
  interrupt?: (agentId: string) => Promise<void>;
  /** Where a task's `.volley/decisions.md` goes. Default `<home>/waves/<wave>/tasks/<task>`. */
  taskDir?: (wave: WaveId, task: TaskId) => string;
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
}

/** A spawned agent the daemon watches until it is retired. */
interface Supervised {
  wave: WaveId;
  task: string;
  role: Role;
  namespace: string;
  watch: AgentWatch;
  lockPath: string;
  minted: boolean;
}

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
const LIVE_STATUS = new Set(["spawning", "registered", "working"]);

const LOCK_FILE = "volleyd.lock";

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
  await probe.connect({ url: opts.brokerUrl, agentId: `${DAEMON_AGENT_ID}-probe` });
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
  /** The `_system` journal (config changes, the kill switch); shared with the config store. */
  private readonly system: Journal;
  /** `stop --all` engaged: every wave admits nothing and `run` is refused until `resume --all`. */
  private killSwitch: boolean;
  private readonly acks = new AckTracker();
  /** Epoch ms of the last progress message seen per agent id (heartbeats, for `claim`). */
  private readonly lastSeen = new Map<string, number>();
  /**
   * When this process started. `lastSeen` is in memory only, so for `claim` every owner counts
   * as seen at least at daemon start: a restart never makes a live owner instantly claimable.
   */
  private readonly startedAt = Date.now();
  /** Subscriptions released on `stop` (never the mailbox: it lives in the persistent session). */
  private readonly unsubscribers: (() => Promise<void>)[] = [];
  private readonly log: (line: string) => void;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** Spawns between start and launch, by `<wave>/<task>/<role>`. */
  private readonly spawning = new Set<string>();
  /** Automatic spawns refused this run (not retried by the loop; `volleyd spawn` retries). */
  private readonly refused = new Set<string>();
  /** Live spawned agents by agent id. */
  private readonly supervised = new Map<string, Supervised>();
  /** Answered control requests by `<sender>/<correlation_id>`, for QoS 1 redelivery. */
  private readonly answered = new Map<string, ControlResponse>();
  /** Requests whose answer is deferred (steer's ack wait), by the same key. */
  private readonly deferred = new Set<string>();
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
    this.system = Journal.open(join(opts.home, "waves", SYSTEM_WAVE));
    this.config = ConfigStore.load({ home: opts.home, system: this.system });
    this.killSwitch = killSwitchEngaged(this.system.readAll());
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

    const progress = /^volley\/[^/]+\/([^/]+)\/progress$/;
    this.unsubscribers.push(
      await this.broker.subscribeStream(buildTopic(namespace, "+", "progress"), (m) =>
        this.onProgress(progress.exec(m.topic)?.[1], m.payload),
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
    await this.tick();

    // Mailbox messages are never retained (SPEC §4.1); clear a stray retained one so it cannot be
    // replayed on every subscribe. Then drain: on a resumed session this first returns what the
    // broker queued while the daemon was down.
    await this.broker.publish(this.mailboxTopic, "", { qos: 1, retain: true });
    void this.mailboxLoop();

    await this.publish(
      this.statusTopic,
      this.envelope("status", "working", { waves: this.waves.size }),
      true,
    );

    const tickMs = this.opts.tickMs ?? DAEMON_DEFAULTS.tick_ms;
    if (tickMs > 0) this.timer = setInterval(() => void this.tick(), tickMs);
    this.watchdog = setInterval(() => {
      if (this.running && !this.broker.connected) this.fail(new Error("broker connection lost"));
    }, DAEMON_DEFAULTS.watchdog_ms);
    this.log(`volleyd up: ${this.waves.size} wave(s), broker ${this.opts.brokerUrl}`);
  }

  /**
   * A message on some agent's progress channel: any of them is a sign of life (`claim`), and a
   * SPEC §4.3 `steering_acked` settles the steer it names (`correlation_id` = the message id).
   */
  private onProgress(agent: string | undefined, raw: string): void {
    if (agent === undefined || agent === DAEMON_AGENT_ID) return;
    const env = parseEnvelope(raw);
    // A message queued while the daemon was down arrives late: count it from when it was sent.
    const sent = env !== null ? Date.parse(env.wall_time) : Number.NaN;
    this.lastSeen.set(agent, Number.isNaN(sent) ? Date.now() : Math.min(Date.now(), sent));
    // The topic names the sender (and is what broker ACLs authorise), so it identifies the acker.
    if (env?.type === "steering_acked" && env.correlation_id !== null) {
      this.acks.acked(env.correlation_id, agent);
    }
  }

  /** Hand each mailbox message to the serial queue, one at a time, until the daemon stops. */
  private async mailboxLoop(): Promise<void> {
    while (this.running) {
      let msgs: { payload: string }[];
      try {
        msgs = await this.broker.drainQueued(this.mailboxTopic, {
          idleMs: DAEMON_DEFAULTS.mailbox_idle_ms,
          maxMessages: 1,
        });
      } catch (e) {
        if (this.running) this.fail(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      for (const m of msgs) void this.enqueue(() => this.onMailbox(m.payload));
    }
  }

  /** Stop timers and the mailbox loop; nothing is published. */
  private halt(): void {
    this.running = false;
    clearInterval(this.timer);
    clearInterval(this.watchdog);
    for (const a of this.supervised.values()) void a.watch.close();
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

  /** One admission tick, queued behind in-flight work. */
  tick(): Promise<void> {
    return this.enqueue(() => this.tickNow()).then(() => {});
  }

  /**
   * Admission: for each running wave (submission order), admit ready tasks within the admission
   * verdict, the hard ceiling (counted across all waves) and the wave's spawn budget. Limits are
   * read from the config store on every tick, so a config change applies here without restart;
   * lowering one never un-admits anything.
   */
  private async tickNow(): Promise<void> {
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
      const base = (this.opts.admission ?? (() => OPEN_ADMISSION))(wave);
      const verdict = admit(candidates, admissionFor(rec, this.killSwitch, base), {
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
      for (const wave of this.waves.keys()) this.spawnAdmitted(wave);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Spawning (T4): admitted tasks get an implementer; other roles are sequenced by the pipeline.
  // -------------------------------------------------------------------------------------------

  /** Start an implementer for every admitted task that has none (runs beside the queue). */
  private spawnAdmitted(wave: WaveId): void {
    const rec = this.waves.get(wave)?.record;
    if (rec?.state == null || rec.state.status !== "running") return;
    for (const id of rec.admitted) {
      const t = rec.state.tasks.find((x) => x.id === id);
      if (t === undefined || t.agents.implementer !== undefined || t.stage !== "queued") continue;
      const key = `${wave}/${id}/implementer`;
      if (this.spawning.has(key) || this.refused.has(key)) continue;
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
  private async startSpawn(wave: WaveId, task: string, role: Role): Promise<SpawnResult> {
    const log = this.waves.get(wave);
    const w = log?.record.wave;
    if (log === undefined || w == null) throw new Error(`unknown wave '${wave}'`);
    const t = w.tasks[task];
    if (t === undefined) throw new Error(`unknown task '${task}' in wave ${wave}`);
    const key = `${wave}/${task}/${role}`;
    if (t.host !== "local") {
      // Remote hosts plug in behind the same Host interface; none is configured yet.
      this.refused.add(key);
      const e = new SpawnError("LAUNCH_FAILED", `host '${t.host}' is not configured`, {
        host: t.host,
      });
      await this.append(wave, {
        type: "alarm_raised",
        task,
        data: { code: e.code, message: e.message, role, ...e.detail },
      });
      throw e;
    }
    this.spawning.add(key);
    try {
      const attempt =
        log.journal
          .readAll()
          .filter((e) => e.type === "agent_spawned" && e.task === task && e.data.role === role)
          .length + 1;
      // spawnAgent journals its own refusals.
      const res = await spawnAgent({ wave: w, task, role, attempt }, this.spawnDeps(wave));
      if (res.kind === "launched") {
        void res.verified.then(
          (outcome) => this.supervise(wave, task, role, outcome, res.lock.path),
          (e: unknown) => this.log(`verify ${key}: ${e instanceof Error ? e.message : String(e)}`),
        );
      }
      return res;
    } catch (e) {
      this.refused.add(key);
      throw e;
    } finally {
      this.spawning.delete(key);
    }
  }

  private spawnDeps(wave: WaveId): SpawnDeps {
    const spawner = this.opts.spawner as SpawnerOptions;
    const log = this.waves.get(wave) as WaveLog;
    const eff = this.config.effective(wave);
    const host = spawner.host ?? new LocalCmuxHost(exec);
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
      claudeJsonPath: spawner.claudeJsonPath ?? join(homedir(), ".claude.json"),
      hooksDir: spawner.hooksDir ?? HOOKS_DIR,
      mintCredentials: spawner.mintCredentials ?? true,
      tunables: eff,
      owner: log.record.state?.owner ?? null,
      journal: (ev) => this.append(wave, ev),
      get openDecisions() {
        return log.record.state?.open_decisions ?? [];
      },
      probe,
      watch: (ns, id) => watchAgent(this.broker, ns, id),
      briefGate: briefGatePath(this.opts.home),
      ...(spawner.briefsDir !== undefined ? { briefsDir: spawner.briefsDir } : {}),
    };
  }

  /** Keep watching a spawned agent; retire it once its terminal status arrives. */
  private supervise(
    wave: WaveId,
    task: string,
    role: Role,
    outcome: SpawnOutcome,
    lock: string,
  ): void {
    const { agentId, watch } = outcome;
    if (!this.running) {
      void watch.close();
      return;
    }
    const minted =
      this.waves
        .get(wave)
        ?.journal.readAll()
        .find((e) => e.type === "agent_spawned" && e.data.agent_id === agentId)?.data
        .credentials === "minted";
    this.supervised.set(agentId, {
      wave,
      task,
      role,
      namespace: watch.namespace,
      watch,
      lockPath: lock,
      minted,
    });
    const check = (type: string) => {
      if (TERMINAL_STATUS.has(type)) void this.enqueue(() => this.retire(agentId, type));
    };
    watch.onStatus(check);
    if (watch.state.status !== null) check(watch.state.status.type);
  }

  private async retire(agentId: string, status: string): Promise<void> {
    const a = this.supervised.get(agentId);
    const log = a !== undefined ? this.waves.get(a.wave) : undefined;
    if (a === undefined || log === undefined) return;
    this.supervised.delete(agentId);
    await a.watch.close();
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
      },
      {
        exec: (this.opts.spawner?.host ?? new LocalCmuxHost(exec)).exec,
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

  /** `spawn` op (`volleyd spawn`): spawn one task's agent now, outside admission. */
  private async manualSpawn(p: Record<string, unknown>): Promise<Reply> {
    if (this.opts.spawner === undefined) return { ok: false, error: "spawning is disabled" };
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
          lock: lockPath(this.opts.home, worktreePath(eff.worktree_root, wave, task, role)),
        },
      };
    }
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
      if (t.stage !== "queued" || t.why_waiting !== undefined) continue;
      if (rec.admitted.includes(t.id)) t.why_waiting = "admitted: awaiting spawn";
      else if (candidates.has(t.id) && held.length > 0) t.why_waiting = held.join("; ");
    }
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
   * dependents wait, independent tasks keep running), publish it retained, and ring the notify
   * bridge. Throws on an unknown wave/task or a bad input.
   */
  openDecision(wave: WaveId, input: DecisionInput): Promise<DecisionRecord> {
    return this.serial(async () => {
      const log = this.waves.get(wave);
      if (log === undefined) throw new Error(`unknown wave '${wave}'`);
      const r = openEvent(log.record, input, new Date());
      if ("error" in r) throw new Error(r.error);
      await this.append(wave, r.event);
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
    });
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
    if (d.task === null) return { decision: d, already_resolved: false };
    // The next stage's brief: every resolved decision of the task, in opening order. The
    // resolution is already journaled, so a failed write is logged, not reported as a failure.
    const all = Object.values(log.record.decisions).filter((x) => x.task === d.task);
    let dir = `the brief for ${wave}/${d.task}`;
    try {
      dir =
        this.opts.taskDir?.(wave, d.task) ?? join(this.opts.home, "waves", wave, "tasks", d.task);
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

  private async onMailbox(raw: string): Promise<void> {
    const req = parseEnvelope(raw);
    if (req === null || !isValidAgentId(req.agent_id)) return;
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

  /** `run`: validate the wave file again (the daemon is authoritative), journal it, queue tasks. */
  private async submit(p: Record<string, unknown>): Promise<HandlerResult> {
    const first = this.checkSubmit(p);
    if ("refusal" in first) return first.refusal;
    if (this.opts.issueBody === undefined) return this.commitSubmit(first.wave, first.owner, {});
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
          return this.commitSubmit(again.wave, again.owner, files);
        }),
      ),
    };
  }

  /** `run`'s validation: the parsed wave and its owner, or the refusal. */
  private checkSubmit(
    p: Record<string, unknown>,
  ): { wave: ReturnType<typeof parseWaveFile>; owner: string | null } | { refusal: Reply } {
    const refuse = (r: Reply) => ({ refusal: r });
    if (this.killSwitch) {
      return refuse({
        ok: false,
        error: `${KILL_SWITCH_REASON}: new runs are refused until \`volleyd resume --all\``,
      });
    }
    if (typeof p.wave_yaml !== "string")
      return refuse({ ok: false, error: "run requires payload.wave_yaml" });
    const owner = typeof p.owner === "string" && p.owner !== "" ? p.owner : null;
    if (owner !== null && !isValidAgentId(owner))
      return refuse({ ok: false, error: `owner '${owner}' is not a valid agent id` });
    let wave: ReturnType<typeof parseWaveFile>;
    try {
      wave = parseWaveFile(p.wave_yaml, typeof p.source === "string" ? p.source : undefined);
    } catch (e) {
      if (e instanceof WaveFileError)
        return refuse({ ok: false, error: e.message, errors: e.errors });
      throw e;
    }
    const existing = this.waves.get(wave.wave)?.record.state;
    if (existing != null) {
      if (existing.owner !== null && existing.owner !== owner) {
        return refuse({
          ok: false,
          error: `wave '${wave.wave}' is already ${existing.status} under owner ${existing.owner}`,
        });
      }
      return refuse({
        ok: false,
        error: `wave '${wave.wave}' already submitted (versioned re-submission is not supported yet)`,
      });
    }
    return { wave, owner };
  }

  /** Journal a checked wave, its tasks (with their issues' Files lists) and overlap warnings. */
  private async commitSubmit(
    wave: ReturnType<typeof parseWaveFile>,
    owner: string | null,
    issueFiles: Record<TaskId, string[]>,
  ): Promise<Reply> {
    this.waves.set(wave.wave, WaveLog.open(join(this.opts.home, "waves", wave.wave)));
    this.issueFiles.set(wave.wave, issueFiles);
    this.config.setWaveOverrides(wave.wave, wave.config);
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
    const r = await this.resolveNow(wave, id, {
      answer: p.answer,
      by,
      ...(typeof p.rationale === "string" ? { rationale: p.rationale } : {}),
    });
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
      const messageId = randomUUID();
      await this.publish(
        buildTopic(this.opts.namespace, a.agent_id, "mailbox"),
        this.envelope("mailbox", "cancel", cancelPayload(wave, a.task, by), messageId),
        false,
      );
      await this.append(wave, {
        type: "steering_sent",
        task: a.task,
        data: { agent_id: a.agent_id, role: a.role, type: "cancel", message_id: messageId, by },
      });
      await this.opts.interrupt?.(a.agent_id).catch((e: unknown) => {
        this.log(`interrupt ${a.agent_id} failed: ${e instanceof Error ? e.message : String(e)}`);
      });
      cancelled.push(a.agent_id);
    }
    this.log(`wave ${wave} stopped by ${by}; cancelled ${cancelled.length} agent(s)`);
    return cancelled;
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
   * `steer`: a T0 mailbox `steering` to the task's current agent with `seq` and `supersedes` (the
   * previous steer to the task), journaled; the answer waits up to `wait_ack_ms` for the ack.
   */
  private async steer(p: Record<string, unknown>, by: string): Promise<HandlerResult> {
    const w = this.waveOf(p);
    if ("error" in w) return { ok: false, error: w.error };
    if (typeof p.task !== "string") return { ok: false, error: "steer requires payload.task" };
    if (typeof p.text !== "string" || p.text.trim() === "")
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
    const { seq, supersedes } = nextSteer(w.log.record, p.task);
    const messageId = randomUUID();
    const waitMs =
      typeof p.wait_ack_ms === "number" && p.wait_ack_ms >= 0
        ? Math.min(p.wait_ack_ms, DAEMON_DEFAULTS.steer_wait_ack_max_ms)
        : DAEMON_DEFAULTS.steer_wait_ack_ms;
    const heard = waitMs > 0 ? this.acks.wait(messageId, target.agent_id, waitMs) : null;
    await this.publish(
      buildTopic(this.opts.namespace, target.agent_id, "mailbox"),
      this.envelope(
        "mailbox",
        "steering",
        {
          text: p.text,
          from_agent_id: DAEMON_AGENT_ID,
          seq,
          ...(supersedes !== undefined ? { supersedes } : {}),
          wave: w.wave,
          task: p.task,
          by,
        },
        messageId,
      ),
      false,
    );
    await this.append(w.wave, {
      type: "steering_sent",
      task: p.task,
      data: {
        agent_id: target.agent_id,
        role: target.role,
        type: "steering",
        message_id: messageId,
        seq,
        ...(supersedes !== undefined ? { supersedes } : {}),
        text: p.text,
        by,
      },
    });
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
