import { type AutopilotRecord, emptyAutopilot, foldAutoResolved } from "./autopilot/budgets";
import { queueOf } from "./autopilot/merge-queue";
import { stepRelease } from "./autopilot/playbook";
import type { Budget, EscalateWhy } from "./autopilot/policy";
import { fixerOf } from "./autopilot/remediation";
import { ARCHIVED_ANSWER, type DecisionRecord, parksTask } from "./decisions";
import { LOCAL_HOST } from "./fleet-name";
import { type TaskPipeline, emptyPipeline, reducePipeline } from "./pipeline";
import { AUTO_HOST } from "./placement";
import { asGitHubRepo } from "./repo-visibility";
import { hygieneLevel } from "./reviews";
import type {
  FixerRemediation,
  JournalEvent,
  PublicHygiene,
  RepoVisibility,
  TaskAgents,
  TaskId,
  TaskPlacement,
  TaskStage,
  TaskState,
  TunablesPatch,
  Wave,
  WaveState,
  WaveStatus,
  WaveTask,
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
  /**
   * Per task: the last steering's `seq` (numbers the next one) and the last one a later steer may
   * supersede (`message_id`; an additive steer such as a merge nudge never becomes it).
   */
  steers: Record<TaskId, { seq: number; message_id?: string }>;
  /** Steers held for each task's next agent, in order (`steering_queued`), until sent or dropped. */
  queued_steers: Record<TaskId, QueuedSteer[]>;
  /** Each task's position in its pipeline (stage steps, role runs, reviews, verified head). */
  pipeline: Record<TaskId, TaskPipeline>;
  /**
   * Each task's unrecovered spawn failures, one per role (two roles of a step spawn at once):
   * `spawn_failed` until that role spawns (`agent_spawned`, `spawn_recovered`), the task is
   * cancelled or done.
   */
  spawnFailures: Record<TaskId, Record<string, SpawnFailure>>;
  /** Spawns added to the wave's budget by `raise by N` answers (spawn_budget_exhausted). */
  budget_raised?: number;
  /**
   * The agent last journaled as bound to the wave's coordinator-name owner (`owner_reconnected`),
   * so a daemon restart replaying the registry does not journal the same reconnect again; null
   * once a claim gave the wave another owner.
   */
  owner_agent?: string | null;
  /** What autopilot answered and escalated (SPEC §4.6.16); absent in older snapshots. */
  autopilot?: AutopilotRecord;
  /** When the wave last ended (`wave_stopped` / `wave_complete`); null after a resume. */
  ended_at?: string | null;
  /** Set by `wave_archived` (archive.ts): when, by whom, why, and how the wave had ended. */
  archived?: { at: string; by: string; reason: string; from: "stopped" | "complete" };
}

/** A steer journaled while its task had no live agent: delivered to the next one to register. */
export interface QueuedSteer {
  message_id: string;
  seq: number;
  supersedes?: string;
  /** Only an agent of this role takes it; absent: whichever role registers next. */
  role?: keyof TaskAgents;
  text: string;
  by: string;
  /** When it was queued. */
  at: string;
}

/** A role's latest failed spawn: what failed, how often in a row, and when it is retried. */
export interface SpawnFailure {
  role: string;
  code: string;
  message: string;
  at: string;
  /** The journal seq of the failure (orders a task's roles). */
  seq: number;
  /** Failed attempts in a row. */
  attempt: number;
  /** The agent attempt (its branch's `-<n>`) the failures are for; null in older journals. */
  spawn_attempt: number | null;
  /** The next automatic retry; null once retries stopped (`spawn_retry_max`). */
  next_retry_at: string | null;
}

/** A task's most recent unrecovered spawn failure, any role. */
export function latestSpawnFailure(rec: WaveRecord, task: TaskId): SpawnFailure | undefined {
  let latest: SpawnFailure | undefined;
  for (const f of Object.values(rec.spawnFailures[task] ?? {})) {
    if (latest === undefined || f.seq > latest.seq) latest = f;
  }
  return latest;
}

/** Forget `role`'s spawn failure on `task` (and the task's entry once it has none). */
function clearSpawnFailure(rec: WaveRecord, task: TaskId, role: string): void {
  const roles = rec.spawnFailures[task];
  if (roles === undefined) return;
  delete roles[role];
  if (Object.keys(roles).length === 0) delete rec.spawnFailures[task];
}

/** Take `ids` off `task`'s steer queue (and the task's entry once it is empty). */
function unqueue(rec: WaveRecord, task: TaskId, ids: readonly unknown[]): void {
  const left = (rec.queued_steers[task] ?? []).filter((q) => !ids.includes(q.message_id));
  if (left.length > 0) rec.queued_steers[task] = left;
  else delete rec.queued_steers[task];
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
    queued_steers: {},
    pipeline: {},
    spawnFailures: {},
    budget_raised: 0,
    autopilot: emptyAutopilot(),
  };
}

/**
 * Set task `id`'s host in the effective plan (copy on write: `wave` and `plan` may share task
 * objects, and the submitted plan keeps what the file said).
 */
function setTaskHost(rec: WaveRecord, id: TaskId, host: string): void {
  const def = rec.wave?.tasks[id];
  if (rec.wave == null || def === undefined || def.host === host) return;
  rec.wave = { ...rec.wave, tasks: { ...rec.wave.tasks, [id]: { ...def, host } } };
}

/**
 * A synthetic task (a flake's fixer, SPEC §4.6.16) joins the effective plan: the wave's pipeline,
 * issue 0, no `after`, its test's file. Copy on write, like setTaskHost; never in `plan` (the
 * submitted file).
 */
function addSynthetic(
  rec: WaveRecord,
  id: TaskId,
  data: Record<string, unknown>,
  at: string,
): void {
  const w = rec.wave;
  const r = data.remediation as FixerRemediation | undefined;
  if (w == null || r === undefined || w.tasks[id] !== undefined) return;
  // A request for the test reduced before the fixer existed (two back to back) joins it too.
  const blocked = [...r.for];
  for (const t of rec.state?.tasks ?? []) {
    const parked = rec.pipeline[t.id]?.remediation;
    if (
      t.id !== id &&
      t.stage !== "done" &&
      t.stage !== "cancelled" &&
      !blocked.includes(t.id) &&
      parked?.kind === "fix_flake" &&
      parked.test === r.test &&
      parked.landed !== true
    )
      blocked.push(t.id);
  }
  const def: WaveTask = {
    id,
    issue: 0,
    ...(typeof data.title === "string" ? { title: data.title } : {}),
    after: [],
    stages: w.stages,
    pipeline: w.pipeline,
    model: w.model,
    host: w.placement === AUTO_HOST ? AUTO_HOST : "local",
    files: r.test_file !== null ? [r.test_file] : [],
    synthetic: true,
    remediation: { ...r, for: blocked, since: at },
  };
  rec.wave = { ...w, tasks: { ...w.tasks, [id]: def }, task_order: [...w.task_order, id] };
}

/** Copy-on-write update of a synthetic task's remediation in the effective plan. */
function setFixer(rec: WaveRecord, id: TaskId, r: FixerRemediation): void {
  const def = rec.wave?.tasks[id];
  if (rec.wave == null || def === undefined) return;
  rec.wave = { ...rec.wave, tasks: { ...rec.wave.tasks, [id]: { ...def, remediation: r } } };
}

const WAVE_STATUS: Partial<Record<JournalEvent["type"], WaveStatus>> = {
  wave_paused: "paused",
  wave_resumed: "running",
  wave_stopped: "stopped",
  wave_complete: "complete",
  release_started: "releasing",
  release_done: "complete",
  release_cancelled: "complete",
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
      ...briefPrefaceOf(ev),
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
      const before = next.wave;
      // Synthetic tasks are journal-only: a plan version (built from the file) keeps them.
      const synthetic = (before?.task_order ?? []).filter(
        (id) => before?.tasks[id]?.synthetic === true && wave.tasks[id] === undefined,
      );
      next.wave =
        synthetic.length === 0
          ? wave
          : {
              ...wave,
              tasks: {
                ...wave.tasks,
                ...Object.fromEntries(synthetic.map((id) => [id, before?.tasks[id] as WaveTask])),
              },
              task_order: [...wave.task_order, ...synthetic],
            };
      // A task is placed once: a placed task the new version still leaves to placement keeps
      // its host.
      for (const t of state.tasks) {
        const placed = before?.tasks[t.id]?.host;
        if (
          t.placement !== undefined &&
          placed !== undefined &&
          wave.tasks[t.id]?.host === AUTO_HOST
        )
          setTaskHost(next, t.id, placed);
      }
      next.plan = plan;
      next.overrides = plan.config;
      state.version = plan.version;
      state.release_branch = plan.release_branch;
      state.spec = specOf(plan);
      Object.assign(state, briefPrefaceOf(ev));
      for (const t of state.tasks) {
        const issue = wave.tasks[t.id]?.issue;
        if (issue !== undefined) t.issue = issue;
      }
      break;
    }
    case "task_queued": {
      if (ev.task === undefined) break;
      if (ev.data.synthetic === true) addSynthetic(next, ev.task, ev.data, ev.at);
      const queued: TaskState = {
        id: ev.task,
        issue: (ev.data.issue as number | undefined) ?? next.wave?.tasks[ev.task]?.issue ?? 0,
        stage: "queued",
        agents: {},
        ...(next.wave?.tasks[ev.task]?.synthetic === true ? { synthetic: true as const } : {}),
      };
      if (task === undefined) state.tasks.push(queued);
      else if (task.stage === "cancelled") {
        // Re-added by a later plan version, or restarted on a new issue: starts over, on the
        // issue the event names, and is placed afresh when its plan leaves it to placement.
        state.tasks = state.tasks.map((t) => (t.id === ev.task ? queued : t));
        next.admitted = next.admitted.filter((id) => id !== ev.task);
        const asWritten = next.plan?.tasks[ev.task]?.host;
        if (task.placement !== undefined && asWritten === AUTO_HOST)
          setTaskHost(next, ev.task, AUTO_HOST);
        const def = next.wave?.tasks[ev.task];
        if (def !== undefined && typeof ev.data.issue === "number") def.issue = ev.data.issue;
      }
      break;
    }
    case "remediation_requested": {
      // A second request for a test whose fixer is running joins it (SPEC §4.6.16).
      const fixer = typeof ev.data.test === "string" ? fixerOf(next, ev.data.test) : undefined;
      const r = fixer?.remediation;
      if (
        fixer !== undefined &&
        r !== undefined &&
        r.outcome === undefined &&
        ev.task !== undefined &&
        ev.task !== fixer.id &&
        !r.for.includes(ev.task)
      )
        setFixer(next, fixer.id, { ...r, for: [...r.for, ev.task] });
      break;
    }
    case "remediation_closed": {
      const r = ev.task !== undefined ? next.wave?.tasks[ev.task]?.remediation : undefined;
      const outcome = ev.data.outcome;
      if (outcome !== "failed" && outcome !== "landed") break;
      if (ev.task !== undefined && r !== undefined) setFixer(next, ev.task, { ...r, outcome });
      // The fix is on the release branch: each released task's next advance takes it.
      const released = Array.isArray(ev.data.released) ? (ev.data.released as TaskId[]) : [];
      for (const id of outcome === "landed" ? released : []) {
        const parked = next.pipeline[id]?.remediation;
        if (parked !== undefined && parked.test === ev.data.test) parked.landed = true;
      }
      break;
    }
    case "task_admitted":
      if (ev.task !== undefined && !next.admitted.includes(ev.task)) next.admitted.push(ev.task);
      break;
    case "task_placed": {
      // Placement (SPEC §4.6.15): the effective plan runs every role of the task there (`local`
      // for the supervisor's own machine), and the state shows where and why.
      if (task === undefined || ev.task === undefined) break;
      const d = ev.data as Omit<TaskPlacement, "decided_at"> & { local?: boolean };
      task.placement = {
        host: d.host,
        by: d.by,
        score: d.score,
        decided_at: ev.at,
        candidates: d.candidates,
      };
      setTaskHost(next, ev.task, d.local === true ? LOCAL_HOST : d.host);
      break;
    }
    case "agent_spawned":
      next.spawns += 1;
      if (task !== undefined) {
        task.agents[ev.data.role as keyof TaskAgents] = ev.data.agent_id as string;
        // A worktree cut from the release branch (not a pipeline start ref): its base.
        if (typeof ev.data.base_sha === "string") task.base_sha = ev.data.base_sha;
      }
      // That spawn launched: its failures are over (spawn_recovered reports them).
      if (ev.task !== undefined) clearSpawnFailure(next, ev.task, String(ev.data.role));
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
      if (task.stage === "done") {
        delete next.spawnFailures[task.id];
        delete next.queued_steers[task.id];
      }
      break;
    case "spawn_failed":
      if (ev.task !== undefined) {
        const role = String(ev.data.role);
        next.spawnFailures[ev.task] = {
          ...next.spawnFailures[ev.task],
          [role]: {
            role,
            code: String(ev.data.code),
            message: String(ev.data.message ?? ""),
            at: ev.at,
            seq: ev.seq,
            attempt: Number(ev.data.attempt),
            spawn_attempt: typeof ev.data.spawn_attempt === "number" ? ev.data.spawn_attempt : null,
            next_retry_at: (ev.data.next_retry_at as string | null | undefined) ?? null,
          },
        };
      }
      break;
    case "spawn_recovered":
      if (ev.task !== undefined) clearSpawnFailure(next, ev.task, String(ev.data.role));
      break;
    case "task_cancelled":
      if (ev.task !== undefined) delete next.spawnFailures[ev.task];
      if (ev.task !== undefined) delete next.queued_steers[ev.task];
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
      // CI failed on a head (T6's ci_failed): the task's PR says so.
      const marker = ev.data.pipeline as { on?: string } | undefined;
      const failedPr = ev.data.pr as { number: number; url: string } | undefined;
      if (task !== undefined && marker?.on === "ci_failed" && (task.pr ?? failedPr) !== undefined) {
        const { checks: _c, ...pr } = (task.pr ?? failedPr) as NonNullable<TaskState["pr"]>;
        task.pr = {
          ...pr,
          ...(typeof ev.data.head_sha === "string" ? { head_sha: ev.data.head_sha } : {}),
          ci: "red",
        };
      }
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
        const raise =
          d.kind === "spawn_budget_exhausted" ? journaledRaise(String(ev.data.answer)) : null;
        if (raise !== null) next.budget_raised = (next.budget_raised ?? 0) + raise;
        // Only a parking decision keeps the task parked (one opened with `park: false` never does).
        const stillOpen = state.open_decisions.some((o) => {
          const x = next.decisions[o];
          return x !== undefined && x.task === d.task && parksTask(x);
        });
        const parked = task !== undefined && task.stage === "awaiting_decision";
        // An archive's close (SPEC §4.6.20) leaves the task parked: its wave has ended for good.
        const archiveClose =
          d.resolved.answer === ARCHIVED_ANSWER &&
          (state.status === "stopped" || state.status === "complete");
        if (task !== undefined && parked && parksTask(d) && !stillOpen && !archiveClose) {
          task.stage = d.resume_stage ?? "queued";
        }
      }
      break;
    }
    case "decision_auto_resolved":
      // The decision_resolved that follows resolves it; this counts the answer and its budget.
      next.autopilot = foldAutoResolved(
        next.autopilot ?? emptyAutopilot(),
        ev.data.budget as Budget | undefined,
      );
      break;
    case "decision_escalated": {
      const a = next.autopilot ?? emptyAutopilot();
      next.autopilot = { ...a, escalated: a.escalated + 1 };
      const d = next.decisions[ev.data.decision_id as string];
      if (d !== undefined) {
        const budget = ev.data.budget as Budget | undefined;
        d.escalated = {
          why: ev.data.why as EscalateWhy,
          ...(budget !== undefined ? { budget } : {}),
        };
      }
      break;
    }
    case "steering_sent":
      if (ev.task !== undefined && ev.data.type === "steering") {
        // A queued steer delivered late never moves the numbering back; an additive steer takes
        // the next seq but leaves what the next steer supersedes.
        const seq = ev.data.seq as number;
        if (seq >= (next.steers[ev.task]?.seq ?? 0)) {
          const prev = next.steers[ev.task]?.message_id;
          const id = isAdditiveSteer(ev.data.reason) ? prev : (ev.data.message_id as string);
          next.steers[ev.task] = { seq, ...(id !== undefined ? { message_id: id } : {}) };
        }
        unqueue(next, ev.task, [ev.data.message_id]);
      }
      break;
    case "steering_queued":
      if (ev.task !== undefined) {
        const d = ev.data;
        const q: QueuedSteer = {
          message_id: d.message_id as string,
          seq: d.seq as number,
          ...(typeof d.supersedes === "string" ? { supersedes: d.supersedes } : {}),
          ...(typeof d.role === "string" ? { role: d.role as keyof TaskAgents } : {}),
          text: d.text as string,
          by: d.by as string,
          at: ev.at,
        };
        next.queued_steers[ev.task] = [...(next.queued_steers[ev.task] ?? []), q];
        next.steers[ev.task] = { seq: q.seq, message_id: q.message_id };
      }
      break;
    case "steering_dropped":
      if (ev.task !== undefined) unqueue(next, ev.task, (ev.data.message_ids as unknown[]) ?? []);
      break;
    case "alarm_raised":
      // Gated without reviews: the wave file's pipeline for the task lists none.
      if (task !== undefined && ev.data.alarm === "reviews_skipped_by_plan")
        task.reviews_skipped_by_plan = true;
      break;
    case "repo_visibility_detected": {
      const visibility = (ev.data.visibility as RepoVisibility | null | undefined) ?? null;
      state.repo_visibility = visibility;
      state.hygiene_level = hygieneLevel(
        (ev.data.public_hygiene as PublicHygiene | undefined) ?? "auto",
        visibility,
      );
      const github = asGitHubRepo(ev.data.github);
      if (github !== undefined) state.github = github;
      else Reflect.deleteProperty(state, "github");
      break;
    }
    case "owner_claimed":
      state.owner = (ev.data.owner as string | null | undefined) ?? null;
      next.owner_agent = null;
      break;
    case "owner_reconnected":
      next.owner_agent = ev.data.agent_id as string;
      break;
    case "wave_archived":
      next.archived = {
        at: ev.at,
        by: String(ev.data.by),
        reason: String(ev.data.reason ?? ""),
        from: state.status === "complete" ? "complete" : "stopped",
      };
      state.status = "archived";
      break;
    default: {
      const status = WAVE_STATUS[ev.type];
      // A releasing wave that was paused resumes releasing (SPEC §4.6.19).
      if (status !== undefined)
        state.status =
          status === "running" && state.release !== undefined && ev.type === "wave_resumed"
            ? "releasing"
            : status;
      if (ev.type === "wave_stopped" || ev.type === "wave_complete") next.ended_at = ev.at;
      if (ev.type === "wave_resumed") next.ended_at = null;
    }
  }
  if (state.release !== undefined || ev.type === "release_started") {
    const release = stepRelease(state.release ?? null, ev);
    if (release !== null) state.release = release;
  }

  if (ev.task !== undefined && next.wave?.tasks[ev.task] !== undefined) {
    const decision =
      ev.type === "decision_resolved" ? next.decisions[ev.data.decision_id as string] : undefined;
    next.pipeline[ev.task] = reducePipeline(next.pipeline[ev.task] ?? emptyPipeline(), ev, {
      stages: next.wave.tasks[ev.task]?.stages ?? [],
      ...(decision !== undefined ? { decision } : {}),
    });
  }

  derive(state, next);
  return next;
}

/** wave-state `brief_preface` from a submit / version event (absent in older journals). */
function briefPrefaceOf(ev: JournalEvent): Pick<WaveState, "brief_preface"> {
  return Object.hasOwn(ev.data, "brief_preface")
    ? { brief_preface: (ev.data.brief_preface as WaveState["brief_preface"]) ?? null }
    : {};
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
 * Recompute the fields that follow from task stages, open decisions and spawn failures:
 * waiting_on/why_waiting, last_error/attempt/next_retry_at and gates. (A spawn failure's
 * why_waiting counts down to its retry, so the daemon adds it when it publishes.)
 */
function derive(state: WaveState, rec: WaveRecord): void {
  const stageOf = new Map(state.tasks.map((t) => [t.id, t.stage]));
  const openOn = (task: TaskId) =>
    state.open_decisions.filter((id) => rec.decisions[id]?.task === task);
  state.tasks = state.tasks.map(
    ({ last_error: _e, attempt: _a, next_retry_at: _n, ...t }): TaskState => {
      const f = latestSpawnFailure(rec, t.id);
      return f === undefined
        ? t
        : {
            ...t,
            last_error: { code: f.code, message: f.message, at: f.at },
            attempt: f.attempt,
            next_retry_at: f.next_retry_at,
          };
    },
  );
  state.tasks = state.tasks.map(({ queued_steers: _q, ...t }) => {
    const n = rec.queued_steers[t.id]?.length ?? 0;
    return n > 0 ? { ...t, queued_steers: n } : t;
  });
  state.tasks = state.tasks.map(({ stage_label: _l, stage_group: _g, ...t }) =>
    withStageGroup(t, rec.pipeline[t.id]),
  );
  state.tasks = state.tasks.map(({ remediation: _r, ...t }) => {
    // A fixer carries its remediation (SPEC §4.6.16); a task parked on a flake, until it lands.
    const f = rec.wave?.tasks[t.id];
    if (f?.synthetic === true && f.remediation !== undefined) {
      const { kind, test, test_file, run_urls, for: blocked, outcome, since } = f.remediation;
      return {
        ...t,
        remediation: {
          kind,
          test,
          since: since ?? state.updated_at,
          test_file,
          run_urls,
          for: blocked,
          ...(outcome !== undefined ? { outcome } : {}),
        },
      };
    }
    const r = rec.pipeline[t.id]?.remediation;
    return r === undefined || r.landed === true
      ? t
      : { ...t, remediation: { kind: r.kind, test: r.test, since: r.since } };
  });
  state.tasks = state.tasks.map(({ waiting_on: _w, why_waiting: _y, alarms: _a, ...t }) => {
    if (t.stage === "awaiting_decision") {
      const ids = openOn(t.id);
      return ids.length > 0
        ? { ...t, waiting_on: ids, why_waiting: `awaiting decision ${ids.join(", ")}` }
        : t;
    }
    // Blocked on purpose (a cancelled relaunch decision): its stage_entered says why.
    const blockedWhy = t.stage === "blocked" ? rec.pipeline[t.id]?.why : undefined;
    if (blockedWhy !== undefined) return { ...t, why_waiting: blockedWhy };
    // Held for CI on a pushed head (the agent is already retired): say so, with the PR's state.
    const hold = rec.pipeline[t.id]?.ci_hold;
    if (hold !== undefined && t.stage !== "done" && t.stage !== "cancelled") {
      const at = hold.sha.slice(0, 7);
      const infra = hold.reason === "infra_incident";
      const why = infra
        ? `CI infra incident: ${hold.incident ?? "infra-shaped failure"}; re-checking`
        : hold.checks.total === 0
          ? `CI pending on ${at} (no run yet)`
          : `CI pending on ${at} (${hold.checks.done}/${hold.checks.total} checks)`;
      const pr = hold.pr ?? t.pr;
      return {
        ...t,
        why_waiting: why,
        ...(pr !== undefined
          ? {
              pr: {
                number: pr.number,
                url: pr.url,
                head_sha: hold.sha,
                ci: infra
                  ? ("red" as const)
                  : hold.checks.total === 0
                    ? ("none" as const)
                    : ("running" as const),
                checks: hold.checks,
              },
            }
          : {}),
      };
    }
    // A red head awaiting its flake's fixer: say which test.
    // (A fixer's own remediation is what it fixes, not what it waits for: the pipeline's is.)
    const flake = rec.pipeline[t.id]?.remediation;
    if (
      flake !== undefined &&
      flake.landed !== true &&
      t.stage !== "done" &&
      t.stage !== "cancelled"
    )
      return { ...t, why_waiting: `CI flake in ${flake.test}: fixer pending` };
    const pending =
      t.stage === "queued"
        ? (rec.wave?.tasks[t.id]?.after ?? []).filter((d) => stageOf.get(d) !== "done")
        : [];
    if (pending.length === 0) {
      // A done task's merge that went in at another head than the gate saw (merged_unverified_head).
      const alarms = surfacedAlarms(rec.pipeline[t.id]);
      const first = alarms[0];
      if (first === undefined) return t;
      return { ...t, alarms, ...(t.stage === "done" ? { why_waiting: first.message } : {}) };
    }
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
  const queue = queueOf(rec).map(({ task, state, since }) => ({ task, state, since }));
  state.merge_queue = queue.length > 0 ? queue : undefined;
  // Autopilot's tally, once it has done anything (the daemon sets `enabled` from the effective
  // config when it publishes).
  const a = rec.autopilot;
  if (a !== undefined && a.resolved + a.escalated > 0) {
    state.autopilot = {
      enabled: state.autopilot?.enabled ?? rec.overrides.autopilot?.enabled ?? true,
      auto_resolved: a.resolved,
      escalated: a.escalated,
      budgets: structuredClone(a.budgets),
    };
  }
}

/**
 * A journaled `spawn_budget_exhausted` answer `raise by N` (N ≥ 1), or null. Strict: answers are
 * normalised to `raise by N` before they are journaled, and a `raise N` journaled before that
 * (#315) was ignored then, so a replay ignores it too.
 */
function journaledRaise(answer: string): number | null {
  const m = /^raise by (\d+)$/.exec(answer.trim().toLowerCase());
  const n = m !== null ? Number(m[1]) : 0;
  return n >= 1 ? n : null;
}

/**
 * A steer that adds to what the agent was told and replaces nothing: a merge nudge (SPEC
 * §4.6.15). It never carries `supersedes`, and no later steer supersedes it.
 */
export const isAdditiveSteer = (reason: unknown): boolean => reason === "merge_nudge";

/** Alarms the wave state carries per task (the Desk and `volleyd status` show them). */
function surfacedAlarms(p: TaskPipeline | undefined): NonNullable<TaskState["alarms"]> {
  const m = p?.alarms?.merged_unverified_head;
  if (m === undefined) return [];
  const short = (x: unknown) => (typeof x === "string" ? x.slice(0, 7) : "?");
  return [
    {
      alarm: "merged_unverified_head",
      message: `merged with an unverified head: gated ${short(m.gated)}, merged ${short(m.merged)}`,
    },
  ];
}

/** Role → its short name in a stage group's label. */
const GROUP_NAME: Record<string, string> = {
  spec_reviewer: "spec",
  quality_reviewer: "quality",
  fixup: "fixup",
  implementer: "implement",
};

/**
 * While a parallel stage group runs (more than one role in the step), the task carries the
 * group's label — `review (spec + quality)` — and each role with its agent and state. The
 * closed stage enum is unchanged: `stage` is the group's first stage.
 */
function withStageGroup(t: TaskState, p: TaskPipeline | undefined): TaskState {
  // A fixup whose only job is CI red on the pipeline's own head (a ci_failed answered `fixup`).
  const ci = p?.directive?.ci === "red" && p.directive.from === undefined;
  if (ci && t.stage === "fixup" && p?.roles.length === 1 && p.roles[0] === "fixup")
    return { ...t, stage_label: "fixup (CI directive)" };
  if (p === undefined || p.roles.length < 2 || p.rebasing) return t;
  const groupStages = new Set(["spec_review", "quality_review", "fixup", "implement"]);
  if (!groupStages.has(t.stage)) return t;
  const reviewing = p.roles.every((r) => r === "spec_reviewer" || r === "quality_reviewer");
  const names = p.roles.map((r) => GROUP_NAME[r] ?? r).join(" + ");
  return {
    ...t,
    stage_label: reviewing ? `review (${names})` : names,
    stage_group: p.roles.map((role) => {
      const run = p.runs[role];
      const state =
        run === undefined
          ? ("pending" as const)
          : run.accepted
            ? ("done" as const)
            : run.retired !== undefined
              ? ("retired" as const)
              : ("running" as const);
      return { role, ...(run !== undefined ? { agent_id: run.agent_id } : {}), state };
    }),
  };
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
