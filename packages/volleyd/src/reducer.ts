import { type DecisionRecord, parksTask } from "./decisions";
import type {
  JournalEvent,
  TaskAgents,
  TaskId,
  TaskStage,
  TaskState,
  TunablesPatch,
  Wave,
  WaveState,
  WaveStatus,
} from "./types";

/**
 * Everything a wave's journal reduces to: the published wave state (T1 wave-state payload) plus
 * the bookkeeping the scheduler needs that the wire shape does not carry.
 */
export interface WaveRecord {
  /** Highest seq applied; events with seq ≤ this are no-ops (idempotent replay). */
  seq: number;
  /** null until `wave_submitted`. */
  state: WaveState | null;
  /**
   * The effective plan (normalised): what the scheduler and spawner use. Equal to `plan` until a
   * versioned re-submission keeps something of an older version running (plan-apply.ts).
   */
  wave: Wave | null;
  /** The latest submitted wave file (normalised). Absent in snapshots that predate versioning. */
  plan?: Wave | null;
  /** Tasks the scheduler has admitted, in admission order. */
  admitted: TaskId[];
  /** Agents spawned for this wave (retries and reviewers included) — counts against spawn_budget. */
  spawns: number;
  /** This wave's `config:` overrides. */
  overrides: TunablesPatch;
  /** Every decision opened in this wave (open and resolved), by id. */
  decisions: Record<string, DecisionRecord>;
  /** The last steering message sent per task — numbers the next one and fills `supersedes`. */
  steers: Record<TaskId, { seq: number; message_id: string }>;
}

/**
 * A snapshot record as read from disk, with fields added after it was written defaulted (e.g.
 * `decisions`/`steers` in snapshots from before decisions existed).
 */
export function normalizeRecord(rec: Partial<WaveRecord>): WaveRecord {
  return { ...emptyRecord(), ...rec };
}

export function emptyRecord(): WaveRecord {
  return {
    seq: 0,
    state: null,
    wave: null,
    plan: null,
    admitted: [],
    spawns: 0,
    overrides: {},
    decisions: {},
    steers: {},
  };
}

const WAVE_STATUS: Partial<Record<JournalEvent["type"], WaveStatus>> = {
  wave_paused: "paused",
  wave_resumed: "running",
  wave_stopped: "stopped",
  wave_complete: "complete",
};

/**
 * Apply one journal event. Pure: returns a new record, or the same record object when the event
 * is a duplicate (seq already applied) — re-applying an event is a no-op.
 */
export function apply(rec: WaveRecord, ev: JournalEvent): WaveRecord {
  if (ev.seq <= rec.seq) return rec;
  const next = structuredClone(rec);
  next.seq = ev.seq;

  if (ev.type === "wave_submitted") {
    const wave = ev.data.wave as Wave;
    next.wave = wave;
    next.plan = wave;
    next.overrides = wave.config;
    next.state = {
      wave: wave.wave,
      version: wave.version,
      owner: (ev.data.owner as string | null | undefined) ?? null,
      repo: wave.repo,
      release_branch: wave.release_branch,
      status: "running",
      tasks: [],
      open_decisions: [],
      gates: [],
      spec: specOf(wave),
      updated_at: ev.at,
    };
    return next;
  }

  const state = next.state;
  if (state === null) return next; // events before submission carry no wave state
  state.updated_at = ev.at;
  const task = ev.task !== undefined ? state.tasks.find((t) => t.id === ev.task) : undefined;

  switch (ev.type) {
    case "wave_versioned": {
      // plan-apply.ts: `plan` is the file as submitted, `wave` the effective plan.
      const wave = ev.data.wave as Wave;
      const plan = (ev.data.plan as Wave | undefined) ?? wave;
      next.wave = wave;
      next.plan = plan;
      next.overrides = plan.config;
      state.version = plan.version;
      state.release_branch = plan.release_branch;
      state.spec = specOf(plan);
      for (const t of state.tasks) {
        const issue = wave.tasks[t.id]?.issue;
        if (issue !== undefined) t.issue = issue;
      }
      break;
    }
    case "task_queued": {
      if (ev.task === undefined) break;
      const queued: TaskState = {
        id: ev.task,
        issue: (ev.data.issue as number | undefined) ?? next.wave?.tasks[ev.task]?.issue ?? 0,
        stage: "queued",
        agents: {},
      };
      if (task === undefined) state.tasks.push(queued);
      else if (task.stage === "cancelled") {
        // Re-added by a later plan version, or restarted on a new issue: starts over, on the
        // issue the event names.
        state.tasks = state.tasks.map((t) => (t.id === ev.task ? queued : t));
        next.admitted = next.admitted.filter((id) => id !== ev.task);
        const def = next.wave?.tasks[ev.task];
        if (def !== undefined && typeof ev.data.issue === "number") def.issue = ev.data.issue;
      }
      break;
    }
    case "task_admitted":
      if (ev.task !== undefined && !next.admitted.includes(ev.task)) next.admitted.push(ev.task);
      break;
    case "agent_spawned":
      next.spawns += 1;
      if (task !== undefined) {
        task.agents[ev.data.role as keyof TaskAgents] = ev.data.agent_id as string;
      }
      break;
    case "stage_entered":
      if (task === undefined) break;
      if (task.stage === "awaiting_decision" && ev.data.stage !== "awaiting_decision") {
        // Parked on a decision: the task stays parked; the stage is where it resumes once its
        // last open decision is resolved.
        for (const d of Object.values(next.decisions)) {
          if (d.task === task.id && d.resolved === undefined && parksTask(d)) {
            d.resume_stage = ev.data.stage as TaskStage;
          }
        }
        break;
      }
      task.stage = ev.data.stage as TaskStage;
      break;
    case "task_cancelled":
      if (task !== undefined) task.stage = "cancelled";
      // A cancelled task gives back its admission (it may have been admitted but not spawned).
      if (ev.task !== undefined) next.admitted = next.admitted.filter((id) => id !== ev.task);
      break;
    case "artifact_verified":
      if (task !== undefined) {
        if (ev.data.pr !== undefined) task.pr = ev.data.pr as NonNullable<TaskState["pr"]>;
        if (typeof ev.data.evidence_path === "string") task.evidence_path = ev.data.evidence_path;
      }
      break;
    case "decision_opened": {
      const id = ev.data.decision_id as string;
      if (!state.open_decisions.includes(id)) state.open_decisions.push(id);
      const d: DecisionRecord = {
        ...(ev.data as Omit<DecisionRecord, "wave" | "task">),
        decision_id: id,
        wave: state.wave,
        task: ev.task ?? null,
        pointers: (ev.data.pointers as DecisionRecord["pointers"] | undefined) ?? {},
        opened_at: (ev.data.opened_at as string | undefined) ?? ev.at,
      };
      if (task !== undefined && parksTask(d)) {
        // Park the task; a second open decision keeps the stage the first one saved.
        const parked = Object.values(next.decisions).find(
          (o) => o.task === task.id && o.resolved === undefined && o.resume_stage !== undefined,
        );
        d.resume_stage = parked?.resume_stage ?? task.stage;
        task.stage = "awaiting_decision";
      }
      next.decisions[id] = d;
      break;
    }
    case "decision_resolved": {
      const id = ev.data.decision_id as string;
      state.open_decisions = state.open_decisions.filter((d) => d !== id);
      const d = next.decisions[id];
      if (d !== undefined) {
        d.resolved = {
          answer: ev.data.answer as string,
          by: ev.data.by as string,
          at: (ev.data.at as string | undefined) ?? ev.at,
        };
        if (typeof ev.data.rationale === "string") d.rationale = ev.data.rationale;
        // Only a parking decision keeps the task parked (one opened with `park: false` never does).
        const stillOpen = state.open_decisions.some((o) => {
          const x = next.decisions[o];
          return x !== undefined && x.task === d.task && parksTask(x);
        });
        const parked = task !== undefined && task.stage === "awaiting_decision";
        if (task !== undefined && parked && parksTask(d) && !stillOpen) {
          task.stage = d.resume_stage ?? "queued";
        }
      }
      break;
    }
    case "steering_sent":
      if (ev.task !== undefined && ev.data.type === "steering") {
        next.steers[ev.task] = {
          seq: ev.data.seq as number,
          message_id: ev.data.message_id as string,
        };
      }
      break;
    case "owner_claimed":
      state.owner = (ev.data.owner as string | null | undefined) ?? null;
      break;
    case "config_changed":
      if (ev.data.overrides !== undefined) next.overrides = ev.data.overrides as TunablesPatch;
      break;
    default: {
      const status = WAVE_STATUS[ev.type];
      if (status !== undefined) state.status = status;
    }
  }

  derive(state, next);
  return next;
}

/** The wave-state `spec`: the submitted file's shape. */
function specOf(wave: Wave): NonNullable<WaveState["spec"]> {
  return {
    version: wave.version,
    release_branch: wave.release_branch,
    model: wave.model,
    pipeline: wave.pipeline,
    tasks: Object.fromEntries(
      wave.task_order.map((id) => {
        const t = wave.tasks[id];
        return [
          id,
          {
            issue: t?.issue ?? 0,
            ...(t?.title !== undefined ? { title: t.title } : {}),
            after: t?.after ?? [],
          },
        ];
      }),
    ),
  };
}

/**
 * Recompute the fields that follow from task stages and open decisions: waiting_on/why_waiting
 * and gates.
 */
function derive(state: WaveState, rec: WaveRecord): void {
  const stageOf = new Map(state.tasks.map((t) => [t.id, t.stage]));
  const openOn = (task: TaskId) =>
    state.open_decisions.filter((id) => rec.decisions[id]?.task === task);
  state.tasks = state.tasks.map(({ waiting_on: _w, why_waiting: _y, ...t }) => {
    if (t.stage === "awaiting_decision") {
      const ids = openOn(t.id);
      return ids.length > 0
        ? { ...t, waiting_on: ids, why_waiting: `awaiting decision ${ids.join(", ")}` }
        : t;
    }
    const pending =
      t.stage === "queued"
        ? (rec.wave?.tasks[t.id]?.after ?? []).filter((d) => stageOf.get(d) !== "done")
        : [];
    if (pending.length === 0) return t;
    // A dependency parked on a decision parks its dependents, naming the decision.
    const parked = pending.filter((d) => stageOf.get(d) === "awaiting_decision");
    const ids = parked.flatMap(openOn);
    const why =
      ids.length > 0
        ? `awaiting decision ${ids.join(", ")} (${parked.join(", ")})`
        : `after: ${pending.join(", ")}`;
    return { ...t, waiting_on: pending, why_waiting: why };
  });
  state.gates = state.tasks.filter((t) => t.stage === "merge_ready").map((t) => t.id);
}

/** Fold events onto a record (default: empty). */
export function replay(
  events: Iterable<JournalEvent>,
  from: WaveRecord = emptyRecord(),
): WaveRecord {
  let rec = from;
  for (const ev of events) rec = apply(rec, ev);
  return rec;
}

/** Reduce a wave journal to its wave state. Throws if the journal never submitted a wave. */
export function reduce(events: Iterable<JournalEvent>): WaveState {
  const { state } = replay(events);
  if (state === null) throw new Error("journal has no wave_submitted event");
  return state;
}
