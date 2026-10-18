import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
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
  candidates as admissible,
  admissionFor,
  cancelPayload,
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
import { Journal, WaveLog } from "./journal";
import { type IssueBodyFn, findOverlaps, formatOverlap, parseFilesSection } from "./overlap";
import { claimVerdict, guardMutation } from "./ownership";
import type { WaveRecord } from "./reducer";
import { type Admission, activeTasks, admit, spawnBudget, spawnsUsed } from "./scheduler";
import type {
  JournalEvent,
  NewEvent,
  TaskAgents,
  TaskId,
  TunablesPatch,
  WaveId,
  WaveState,
} from "./types";
import { SYSTEM_WAVE } from "./types";
import { WaveFileError, parseWaveFile } from "./wave-file";

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
   * Fetches a task issue's body at submit; its `Files` section feeds the overlap warning and the
   * task's files hint. Default: none (wave-file `files` only); `volleyd daemon` wires `gh`.
   */
  issueBody?: IssueBodyFn;
  /** Interrupts an agent's session on `stop` (e.g. Escape via cmux). Default: none. */
  interrupt?: (agentId: string) => Promise<void>;
  /** Where a task's `.volley/decisions.md` goes. Default `<home>/waves/<wave>/tasks/<task>`. */
  taskDir?: (wave: WaveId, task: TaskId) => string;
}

type HandlerResult = Omit<ControlResponse, "text" | "acked_type" | "op"> & {
  /** Sent as a second answer once it settles (steer's ack wait), off the serial queue. */
  defer?: Promise<Omit<ControlResponse, "text" | "acked_type" | "op">>;
};

const OPEN_ADMISSION: Admission = { allow: Number.POSITIVE_INFINITY, reasons: [] };
const LIVE_STATUS = new Set(["spawning", "registered", "working"]);

/**
 * The volleyd daemon: registers as agent `volleyd` (LWT armed), owns every wave journal, answers
 * control requests on its mailbox, and publishes retained wave state + the event mirror after
 * every journal append. All work (control ops, ticks) runs through one serial queue.
 */
export class Daemon {
  private readonly broker = new VolleyBroker();
  private readonly waves = new Map<WaveId, WaveLog>();
  /** Why ready tasks were not admitted on the last tick, per wave. */
  private readonly heldBack = new Map<WaveId, string[]>();
  private readonly config: ConfigStore;
  /** The `_system` journal (config changes, the kill switch); shared with the config store. */
  private readonly system: Journal;
  /** `stop --all` engaged: every wave admits nothing and `run` is refused until `resume --all`. */
  private killSwitch: boolean;
  private readonly acks = new AckTracker();
  /** Epoch ms of the last progress message seen per agent id (heartbeats, for `claim`). */
  private readonly lastSeen = new Map<string, number>();
  private readonly unsubscribers: (() => Promise<void>)[] = [];
  private readonly log: (line: string) => void;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => Promise<void>) | undefined;

  private constructor(private readonly opts: DaemonOptions) {
    this.log = opts.log ?? (() => {});
    this.system = Journal.open(join(opts.home, "waves", SYSTEM_WAVE));
    this.config = ConfigStore.load({ home: opts.home, system: this.system });
    this.killSwitch = killSwitchEngaged(this.system.readAll());
    for (const log of loadWaves(opts.home)) {
      const wave = log.record.state?.wave;
      if (wave === undefined) continue;
      this.waves.set(wave, log);
      this.config.setWaveOverrides(wave, log.record.overrides);
    }
  }

  static async start(opts: DaemonOptions): Promise<Daemon> {
    const d = new Daemon(opts);
    await d.connect();
    return d;
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

  private async connect(): Promise<void> {
    const { namespace } = this.opts;
    await this.broker.connect({
      url: this.opts.brokerUrl,
      agentId: DAEMON_AGENT_ID,
      willTopic: this.statusTopic,
      willPayload: JSON.stringify(this.envelope("status", "reaped", { reason: "disconnect" })),
    });
    const prior = await this.broker.queryRetained(this.statusTopic, DAEMON_DEFAULTS.probe_ms);
    const priorType = prior !== null ? parseEnvelope(prior)?.type : undefined;
    if (priorType !== undefined && LIVE_STATUS.has(priorType)) {
      await this.broker.disconnect();
      throw new Error(`volleyd already running (retained ${this.statusTopic} is '${priorType}')`);
    }

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

    // One client: every stream listener sees every message, so each filters on its topic.
    const mailbox = buildTopic(namespace, DAEMON_AGENT_ID, "mailbox");
    this.unsubscribe = await this.broker.subscribeStream(mailbox, ({ topic, payload }) => {
      if (topic === mailbox) void this.enqueue(() => this.onMailbox(payload));
    });
    const progress = /^volley\/[^/]+\/([^/]+)\/progress$/;
    this.unsubscribers.push(
      await this.broker.subscribeStream(buildTopic(namespace, "+", "progress"), ({ topic }) => {
        const agent = progress.exec(topic)?.[1];
        if (agent !== undefined && agent !== DAEMON_AGENT_ID) this.lastSeen.set(agent, Date.now());
      }),
    );

    this.config.onChange((c) => {
      this.log(`config v${c.version} by ${c.by}: ${JSON.stringify(c.patch)}`);
      // Hot-apply: re-publish config and every wave's effective_config, then re-run admission.
      void this.enqueue(async () => {
        await this.publishConfig();
        for (const wave of this.waves.keys()) await this.publishState(wave);
        await this.tickNow();
      });
    });

    await this.publishConfig();
    for (const wave of this.waves.keys()) await this.publishState(wave);
    for (const [wave, log] of this.waves) {
      for (const d of openDecisions(log.record)) await this.publishDecision(wave, d);
    }
    await this.tick();
    await this.publish(
      this.statusTopic,
      this.envelope("status", "working", { waves: this.waves.size }),
      true,
    );

    const tickMs = this.opts.tickMs ?? DAEMON_DEFAULTS.tick_ms;
    if (tickMs > 0) this.timer = setInterval(() => void this.tick(), tickMs);
    this.log(`volleyd up: ${this.waves.size} wave(s), broker ${this.opts.brokerUrl}`);
  }

  /** Publish a terminal status and disconnect cleanly (suppresses the LWT). */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.enqueue(async () => {});
    this.acks.clear();
    if (this.broker.connected) {
      await this.unsubscribe?.();
      this.unsubscribe = undefined;
      for (const u of this.unsubscribers.splice(0)) await u();
      await this.publish(
        this.statusTopic,
        this.envelope("status", "done", { reason: "shutdown" }),
        true,
      );
      await this.broker.disconnect();
    }
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
      await this.publish(
        buildTopic(this.opts.namespace, DAEMON_AGENT_ID, "progress"),
        this.envelope("progress", "blocked", attentionPayload(d)),
        false,
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
    await this.broker.publish(topic, "", { qos: 1, retain: true }); // clear the retained decision
    this.log(`resolved ${id} by ${r.by}: ${r.answer}`);
    if (d.task === null) return { decision: d, already_resolved: false };
    // The next stage's brief: every resolved decision of the task, in opening order.
    const all = Object.values(log.record.decisions).filter((x) => x.task === d.task);
    const dir =
      this.opts.taskDir?.(wave, d.task) ?? join(this.opts.home, "waves", wave, "tasks", d.task);
    const brief = writeDecisionsFile(dir, renderDecisionsMd(wave, d.task, all));
    return { decision: d, already_resolved: false, brief };
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
    // A T0 mailbox ack for a message the daemon sent (steer/cancel).
    if (req.type === "ack") {
      if (req.correlation_id !== null) this.acks.ack(req.correlation_id, req.agent_id);
      return;
    }
    if (req.type !== "query") return;
    const payload = (req.payload ?? {}) as Record<string, unknown>;
    const op = typeof payload.op === "string" ? payload.op : "";
    let res: HandlerResult;
    try {
      res = await this.handle(op, payload, req);
    } catch (e) {
      res = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const reply = async (r: Omit<ControlResponse, "text" | "acked_type" | "op">) => {
      const body: ControlResponse = {
        text: r.ok ? "ACKED" : "REJECTED",
        acked_type: "query",
        op,
        ...r,
      };
      await this.publish(
        buildTopic(this.opts.namespace, req.agent_id, "mailbox"),
        this.envelope("mailbox", "ack", body, req.correlation_id ?? undefined),
        false,
      );
    };
    const { defer, ...now } = res;
    // A deferred answer (steer waiting for its ack) must not hold the serial queue.
    if (defer !== undefined) {
      void defer.then(reply, (e: unknown) => this.log(`error: ${String(e)}`));
      return;
    }
    await reply(now);
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
        return this.claim(p, by);
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
        if (req.correlation_id === null)
          return { ok: false, error: "config_set requires a correlation_id" };
        const by = typeof p.by === "string" && p.by.length > 0 ? p.by : req.agent_id;
        const patch = (
          typeof p.patch === "object" && p.patch !== null ? p.patch : {}
        ) as TunablesPatch;
        const r = this.config.applyPatch(patch, by);
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
    if (this.killSwitch) {
      return {
        ok: false,
        error: `${KILL_SWITCH_REASON}: new runs are refused until \`volleyd resume --all\``,
      };
    }
    if (typeof p.wave_yaml !== "string")
      return { ok: false, error: "run requires payload.wave_yaml" };
    const owner = typeof p.owner === "string" && p.owner !== "" ? p.owner : null;
    if (owner !== null && !isValidAgentId(owner))
      return { ok: false, error: `owner '${owner}' is not a valid agent id` };
    let wave: ReturnType<typeof parseWaveFile>;
    try {
      wave = parseWaveFile(p.wave_yaml, typeof p.source === "string" ? p.source : undefined);
    } catch (e) {
      if (e instanceof WaveFileError) return { ok: false, error: e.message, errors: e.errors };
      throw e;
    }
    const existing = this.waves.get(wave.wave)?.record.state;
    if (existing != null) {
      if (existing.owner !== null && existing.owner !== owner) {
        return {
          ok: false,
          error: `wave '${wave.wave}' is already ${existing.status} under owner ${existing.owner}`,
        };
      }
      return {
        ok: false,
        error: `wave '${wave.wave}' already submitted (versioned re-submission is not supported yet)`,
      };
    }
    await this.addIssueFiles(wave);
    this.waves.set(wave.wave, WaveLog.open(join(this.opts.home, "waves", wave.wave)));
    this.config.setWaveOverrides(wave.wave, wave.config);
    await this.append(wave.wave, { type: "wave_submitted", data: { wave, owner } });
    for (const id of wave.task_order) {
      await this.append(wave.wave, {
        type: "task_queued",
        task: id,
        data: { issue: wave.tasks[id]?.issue },
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

  /** Merge each task issue's `Files` section into its files hint (best effort, in parallel). */
  private async addIssueFiles(wave: ReturnType<typeof parseWaveFile>): Promise<void> {
    const fetch = this.opts.issueBody;
    if (fetch === undefined) return;
    await Promise.all(
      Object.values(wave.tasks).map(async (t) => {
        const body = await fetch(wave.repo, t.issue).catch(() => null);
        if (body !== null) t.files = [...new Set([...t.files, ...parseFilesSection(body)])];
      }),
    );
  }

  /** Overlaps between `wave`'s tasks and the unsettled tasks of every other live wave. */
  private overlaps(wave: WaveId) {
    const files = (rec: WaveRecord, settled: boolean) =>
      (rec.state?.tasks ?? [])
        .filter((t) => !settled || (t.stage !== "done" && t.stage !== "cancelled"))
        .map((t) => ({ id: t.id, files: rec.wave?.tasks[t.id]?.files ?? [] }));
    const self = this.waves.get(wave)?.record;
    if (self === undefined) return [];
    const others = [...this.waves]
      .filter(([w, log]) => {
        const s = log.record.state?.status;
        return w !== wave && s !== undefined && s !== "complete" && s !== "stopped";
      })
      .map(([w, log]) => ({ wave: w, tasks: files(log.record, true) }));
    return findOverlaps({ wave, tasks: files(self, false) }, others);
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
        p.all === true ? Object.values(log.record.decisions ?? {}) : openDecisions(log.record),
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
        : [...this.waves].find(([, log]) => log.record.decisions?.[id] !== undefined)?.[0];
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
      heartbeatAt: owner !== null ? (this.lastSeen.get(owner) ?? null) : null,
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
    const waves: WaveId[] = [];
    for (const wave of this.waves.keys()) {
      if ((await this.stopWave(wave, by)) !== null) waves.push(wave);
    }
    await this.appendSystem({ type: "wave_stopped", data: { all: true, by, waves } });
    this.killSwitch = true;
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
    const role = typeof p.role === "string" ? (p.role as keyof TaskAgents) : undefined;
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
        ? p.wait_ack_ms
        : DAEMON_DEFAULTS.steer_wait_ack_ms;
    const acked = waitMs > 0 ? this.acks.wait(messageId, waitMs) : null;
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
      acked: false,
    };
    if (acked === null) return { ok: true, result };
    return {
      ok: true,
      defer: acked.then((ackedBy) => ({
        ok: true,
        result:
          ackedBy === null
            ? result
            : { ...result, delivery: "acked", acked: true, acked_by: ackedBy },
      })),
    };
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
