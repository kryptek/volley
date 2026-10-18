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
import { type ExecFn, exec as realExec } from "./exec";
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
import { countApiSignals, isApiSignal } from "./pressure/api-signals";
import { sampleCiQueue } from "./pressure/ci-queue";
import { sampleCmuxPing } from "./pressure/cmux";
import { sampleContainers } from "./pressure/containers";
import { sampleMemory } from "./pressure/memory";
import { type Admission, activeTasks, admit, ready, spawnBudget, spawnsUsed } from "./scheduler";
import { toPathErrors, validator } from "./schemas";
import type { JournalEvent, NewEvent, Tunables, TunablesPatch, WaveId, WaveState } from "./types";
import { SYSTEM_WAVE } from "./types";
import { WaveFileError, parseWaveFile } from "./wave-file";

export interface DaemonOptions {
  brokerUrl: string;
  namespace: string;
  /** $VOLLEYD_HOME — journals live under `<home>/waves/<wave>/`, config at `<home>/config.yaml`. */
  home: string;
  /** Admission/monitor tick interval; 0 disables the timer (tests drive `tick()`). */
  tickMs?: number;
  /**
   * Override the spawn admission verdict per wave (tests). Default: the pressure-based verdict
   * from the last sample (`pressure`), open until the first sample.
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
}

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

/** The fenced samplers in src/pressure, run concurrently; a failing one is an unknown signal. */
export function systemPressure(exec: ExecFn = realExec): PressureSource {
  return async ({ repos, config }) => {
    const timeout = DAEMON_DEFAULTS.sampler_timeout_ms;
    const [memory_pressure, cmux_ping, containers, ...ci] = await Promise.all([
      sampleMemory(exec, timeout),
      // Above the threshold, so a hung socket reads as over it rather than as unknown.
      sampleCmuxPing(exec, config.admission.cmux_ping_max_ms + timeout),
      sampleContainers(exec, timeout),
      ...repos.map((r) => sampleCiQueue(exec, r, timeout)),
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

type Reply = Omit<ControlResponse, "text" | "acked_type" | "op">;

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
  private readonly config: ConfigStore;
  /** The `_system` journal: config changes and lease events (shared with the config store). */
  private readonly system: Journal;
  private leases: LeaseBook;
  /** Pools this process has published a retained state for (so a removed one can be cleared). */
  private readonly publishedPools = new Set<string>();
  /** Arrival times (ms) of API overload / credit signals seen on agents' progress channels. */
  private apiSignals: number[] = [];
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
  private running = false;
  /** Answered control requests by `<sender>/<correlation_id>`, for QoS 1 redelivery. */
  private readonly answered = new Map<string, ControlResponse>();
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
    this.leases = replayLeases(this.system.readAll());
    for (const log of loadWaves(opts.home)) {
      const wave = log.record.state?.wave;
      if (wave === undefined) continue;
      this.waves.set(wave, log);
      this.config.setWaveOverrides(wave, log.record.overrides);
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
    for (const wave of this.waves.keys()) await this.publishState(wave);
    await this.subscribeLeaseInputs();
    await this.publishAllPools();
    await this.enqueue(() => this.tickNow());

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
    if (tickMs > 0) {
      this.timer = setInterval(() => void this.tick(), tickMs);
      void this.tick(); // first pressure sample now, not one interval from now
    }
    this.watchdog = setInterval(() => {
      if (this.running && !this.broker.connected) this.fail(new Error("broker connection lost"));
    }, DAEMON_DEFAULTS.watchdog_ms);
    this.log(`volleyd up: ${this.waves.size} wave(s), broker ${this.opts.brokerUrl}`);
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
    // The mailbox subscription is kept: it lives in the persistent session, so requests sent
    // while the daemon is down are queued for the next start.
    if (this.broker.connected) {
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
   * Subscribe (in the persistent session, so requests sent while the daemon is down are
   * delivered on restart) to lease requests, to every agent's status (a holder that turns
   * reaped/done/failed loses its leases; the retained statuses arrive on subscribe, so a holder
   * that died while the daemon was down is caught too) and to every agent's progress (the
   * hooks' API overload signals).
   */
  private async subscribeLeaseInputs(): Promise<void> {
    await this.broker.subscribeStream(LEASE_REQUESTS_FILTER, (m) => {
      const pool = m.topic.split("/")[3] ?? "";
      void this.enqueue(() => this.onLeaseRequest(pool, m.payload));
    });
    await this.broker.subscribeStream("volley/+/+/status", (m) => {
      const holder = m.topic.split("/")[2] ?? "";
      const holds = Object.values(this.leases).some((p) =>
        [...p.held, ...p.queue].some((l) => l.holder === holder),
      );
      if (!holds) return;
      const env = parseEnvelope(m.payload);
      if (env === null || !HOLDER_GONE.has(env.type)) return;
      void this.enqueue(() => this.runLeases({ kind: "holder_status", holder, status: env.type }));
    });
    await this.broker.subscribeStream("volley/+/+/progress", (m) => {
      const env = parseEnvelope(m.payload);
      if (env !== null && isApiSignal(env)) this.apiSignals.push(Date.now());
    });
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
    let req = env.payload as LeaseRequest;
    // An agent may only acquire, renew or release its own leases (SPEC §4.6.5).
    if (req.holder !== env.agent_id) {
      this.log(`ignored lease request: holder ${req.holder} is not the sender ${env.agent_id}`);
      return;
    }
    // Pools are machine-global, so capacity is the global one; a wave's override of a pool's
    // ttl_s applies to the leases its own agents take.
    if (req.op === "acquire" && req.ttl_s === undefined) {
      const wave = this.holderWave(req.holder);
      const ttl =
        wave !== undefined ? this.config.effective(wave).lease_pools[pool]?.ttl_s : undefined;
      if (ttl !== undefined) req = { ...req, ttl_s: ttl };
    }
    await this.runLeases({ kind: "request", pool, req });
  }

  /** The wave one of whose tasks has `agentId` as an agent. */
  private holderWave(agentId: string): WaveId | undefined {
    for (const [wave, log] of this.waves) {
      if (log.record.state?.tasks.some((t) => Object.values(t.agents).includes(agentId)))
        return wave;
    }
    return undefined;
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
    for (const pool of touched) {
      const extra =
        input.kind === "request" && pool === input.pool && r.rejected !== undefined
          ? [`rejected ${input.req.lease_id}: ${r.rejected}`]
          : [];
      await this.publishPool(pool, extra);
    }
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

  /**
   * Admission: for each running wave (submission order), admit ready tasks within the admission
   * verdict, the hard ceiling (counted across all waves) and the wave's spawn budget. Limits are
   * read from the config store on every tick, so a config change applies here without restart;
   * lowering one never un-admits anything.
   */
  private async tickNow(): Promise<void> {
    await this.runLeases({ kind: "tick" });
    let live = 0;
    for (const log of this.waves.values()) live += activeTasks(log.record).length;
    for (const [wave, log] of this.waves) {
      const rec = log.record;
      const candidates = ready(rec);
      if (candidates.length === 0 || rec.wave === null) {
        if (this.heldBack.delete(wave)) await this.publishState(wave);
        continue;
      }
      const eff = this.config.effective(wave);
      const pressure = this.opts.admission?.(wave) ?? this.verdicts.get(wave) ?? OPEN_ADMISSION;
      const verdict = admit(candidates, pressure, {
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
    const candidates = new Set(ready(rec));
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

  // -------------------------------------------------------------------------------------------
  // Control ops
  // -------------------------------------------------------------------------------------------

  private async onMailbox(raw: string): Promise<void> {
    const req = parseEnvelope(raw);
    if (req === null || req.type !== "query" || !isValidAgentId(req.agent_id)) return;
    // An ack MUST carry the request's correlation_id (SPEC §4.4); without one there is no
    // answer the sender could match, so the request is dropped.
    if (req.correlation_id === null) {
      this.log(`dropped control query from ${req.agent_id}: no correlation_id`);
      return;
    }
    const key = `${req.agent_id}/${req.correlation_id}`;
    const payload = (req.payload ?? {}) as Record<string, unknown>;
    const op = typeof payload.op === "string" ? payload.op : "";
    let reply = this.answered.get(key);
    if (reply === undefined) {
      let res: Reply;
      try {
        res = await this.handle(op, payload, req);
      } catch (e) {
        res = { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
      // "ACKED" means received, not obeyed (SPEC §4.4); the outcome is in ok/applied/error.
      reply = { text: "ACKED", acked_type: "query", op, ...res };
      this.answered.set(key, reply);
      if (this.answered.size > DAEMON_DEFAULTS.dedupe_max) {
        this.answered.delete(this.answered.keys().next().value as string);
      }
    }
    await this.publish(
      buildTopic(this.opts.namespace, req.agent_id, "mailbox"),
      this.envelope("mailbox", "ack", reply, req.correlation_id),
      false,
    );
  }

  private async handle(op: string, p: Record<string, unknown>, req: Envelope): Promise<Reply> {
    switch (op) {
      case "status": {
        if (typeof p.wave === "string") {
          const state = this.snapshot(p.wave);
          return state === null
            ? { ok: false, error: `unknown wave '${p.wave}'` }
            : { ok: true, result: state };
        }
        return { ok: true, result: { waves: [...this.waves.keys()].map((w) => this.snapshot(w)) } };
      }
      case "run":
        return this.submit(p);
      case "admission":
        return { ok: true, result: this.summary };
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
  private async submit(p: Record<string, unknown>): Promise<Reply> {
    if (typeof p.wave_yaml !== "string")
      return { ok: false, error: "run requires payload.wave_yaml" };
    let wave: ReturnType<typeof parseWaveFile>;
    try {
      wave = parseWaveFile(p.wave_yaml, typeof p.source === "string" ? p.source : undefined);
    } catch (e) {
      if (e instanceof WaveFileError) return { ok: false, error: e.message, errors: e.errors };
      throw e;
    }
    if (this.waves.has(wave.wave)) {
      return {
        ok: false,
        error: `wave '${wave.wave}' already submitted (versioned re-submission is not supported yet)`,
      };
    }
    this.waves.set(wave.wave, WaveLog.open(join(this.opts.home, "waves", wave.wave)));
    this.config.setWaveOverrides(wave.wave, wave.config);
    await this.append(wave.wave, { type: "wave_submitted", data: { wave, owner: null } });
    for (const id of wave.task_order) {
      await this.append(wave.wave, {
        type: "task_queued",
        task: id,
        data: { issue: wave.tasks[id]?.issue },
      });
    }
    this.evaluate(); // its verdict from the last sample, before its first admission
    await this.tickNow();
    this.log(`submitted wave ${wave.wave} (${wave.task_order.length} tasks)`);
    return { ok: true, result: this.snapshot(wave.wave) };
  }
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
