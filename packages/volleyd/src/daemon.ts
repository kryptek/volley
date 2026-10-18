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
import { exec } from "./exec";
import type { Host } from "./hosts/host";
import { LocalCmuxHost } from "./hosts/local-cmux";
import { Journal, WaveLog } from "./journal";
import { type Admission, activeTasks, admit, ready, spawnBudget, spawnsUsed } from "./scheduler";
import { toPathErrors, validator } from "./schemas";
import type { JournalEvent, NewEvent, TunablesPatch, WaveId, WaveState } from "./types";
import { SYSTEM_WAVE } from "./types";
import { WaveFileError, parseWaveFile } from "./wave-file";

import { type Role, briefGatePath, isRole } from "./brief";
import { HOOKS_DIR } from "./launch";
import { type AgentProbe, TERMINAL_STATUS, lockPath } from "./locks";
import { retireAgent } from "./retire";
import { ScreenPublisher } from "./screen-publisher";
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
  /** Clock for the screen publisher's capture schedule (tests drive it with `tickScreens()`). */
  now?: () => number;
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
  workspace: string;
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
  private readonly log: (line: string) => void;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private screenTimer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  /** Spawns between start and launch, by `<wave>/<task>/<role>`. */
  private readonly spawning = new Set<string>();
  /** Automatic spawns refused this run (not retried by the loop; `volleyd spawn` retries). */
  private readonly refused = new Set<string>();
  /** Live spawned agents by agent id. */
  private readonly supervised = new Map<string, Supervised>();
  /** Answered control requests by `<sender>/<correlation_id>`, for QoS 1 redelivery. */
  private readonly answered = new Map<string, ControlResponse>();
  /** Screen tails of supervised agents (T13); reads run beside the serial queue. */
  private readonly screens: ScreenPublisher;
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
    this.screens = new ScreenPublisher({
      publish: (topic, payload) => this.broker.publish(topic, payload, { qos: 0, retain: true }),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      onStale: (agentId) => {
        const a = this.supervised.get(agentId);
        if (a !== undefined) void this.enqueue(() => this.publishState(a.wave));
      },
      log: this.log,
    });
    this.config = ConfigStore.load({
      home: opts.home,
      system: Journal.open(join(opts.home, "waves", SYSTEM_WAVE)),
    });
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
        await this.tickNow();
      });
    });

    await this.publishConfig();
    for (const wave of this.waves.keys()) await this.publishState(wave);
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
    if (tickMs > 0) {
      this.timer = setInterval(() => void this.tick(), tickMs);
      this.screenTimer = setInterval(() => void this.tickScreens(), DAEMON_DEFAULTS.screen_tick_ms);
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
    clearInterval(this.screenTimer);
    this.screens.clear();
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

  /** Capture the screens of supervised agents that are due (beside the serial queue). */
  tickScreens(): Promise<void> {
    return this.screens.tick();
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
      const candidates = ready(rec);
      if (candidates.length === 0 || rec.wave === null) {
        if (this.heldBack.delete(wave)) await this.publishState(wave);
        continue;
      }
      const eff = this.config.effective(wave);
      const verdict = admit(candidates, (this.opts.admission ?? (() => OPEN_ADMISSION))(wave), {
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
    const host = this.host();
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

  /** The `local` host agents are spawned on (and their screens read from). */
  private host(): Host {
    return this.opts.spawner?.host ?? new LocalCmuxHost(exec);
  }

  /** Keep watching a spawned agent (and its screen); retire it once its terminal status arrives. */
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
      workspace: outcome.workspace,
      watch,
      lockPath: lock,
      minted,
    });
    const host = this.host();
    this.screens.track({
      agentId,
      namespace: watch.namespace,
      workspace: outcome.workspace,
      host,
      source: host.name === "local" ? "cmux" : "tmux",
      intervalS: () => this.config.effective(wave).screen_tail_interval_s,
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
    // Stop capturing first, so no in-flight capture re-publishes the screen after retire clears it.
    await this.screens.untrack(agentId);
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
        exec: this.host().exec,
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
    const candidates = new Set(ready(rec));
    for (const t of state.tasks) {
      if (t.stage !== "queued" || t.why_waiting !== undefined) continue;
      if (rec.admitted.includes(t.id)) t.why_waiting = "admitted: awaiting spawn";
      else if (candidates.has(t.id) && held.length > 0) t.why_waiting = held.join("; ");
    }
    for (const t of state.tasks) {
      if (Object.values(t.agents).some((id) => id !== undefined && this.screens.isStale(id))) {
        t.screen_stale = true;
      }
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
