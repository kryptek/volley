import { createHash } from "node:crypto";
import { type PlanDiff, diffPlans } from "./plan-diff";
import type { WaveRecord } from "./reducer";
import type { JournalEvent, NewEvent, TaskId, TaskState, Wave, WaveTask } from "./types";

/**
 * Mid-wave plan changes. A new version of a running wave's file becomes journal events, applied
 * mechanically against the wave's current state:
 *
 *   added task               → task_queued (a task removed earlier and re-added is re-queued)
 *   removed, still queued    → task_cancelled
 *   removed, in flight       → untouched; decision plan_change "stop / let finish"
 *   deps changed             → the new `after` applies; only tasks not yet admitted wait on it
 *   issue changed, queued    → applies
 *   issue changed, in flight → the agents keep the old issue; decision plan_change "restart / let finish"
 *   pipeline / model changed → applies to stages not yet started (running agents keep theirs)
 *
 * The first event is `wave_versioned` carrying the submitted plan (`plan`), the effective plan the
 * scheduler and spawner use from now on (`wave`: the submitted plan, plus removed in-flight tasks
 * and in-flight tasks' old issues kept until decided) and the structural diff. A later version
 * that undoes a change withdraws its open decision.
 */

/** An in-flight task's role and when its current agent was spawned (see `taskActivity`). */
export interface TaskActivity {
  role: string;
  since: string;
}

export interface PlanContext {
  /** ISO timestamp: the decisions' `opened_at`, and "working N min" is measured to it. */
  now: string;
  activity: Record<TaskId, TaskActivity>;
  /** Where the version's file is stored (journaled on `wave_versioned`). */
  file?: string;
}

export interface PlanApplication {
  version: number;
  diff: PlanDiff;
  /** The plan the scheduler and spawner use from this version on. */
  effective: Wave;
  /** Events to journal, in order. Empty when `unchanged`. */
  events: NewEvent[];
  /** The file is the current plan again (re-submitted as is): nothing to journal. */
  unchanged: boolean;
}

/** A new version cannot apply to this wave (the message says why). */
export class PlanChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanChangeError";
  }
}

export type PlanChangeKind = "removed" | "issue";

/** One plan_change decision per task and kind, stable across versions. */
export function planDecisionId(wave: string, task: TaskId, change: PlanChangeKind): string {
  const h = createHash("sha256").update(`${wave}/${task}/${change}`).digest("hex").slice(0, 12);
  return `plan_change-${h}`;
}

/** Stages in which a task has finished its work (a plan change no longer touches it). */
const SETTLED = new Set(["done", "merge_ready"]);

type Phase = "absent" | "queued" | "in_flight" | "settled" | "cancelled";

function phaseOf(rec: WaveRecord, t: TaskState | undefined): Phase {
  if (t === undefined) return "absent";
  if (t.stage === "cancelled") return "cancelled";
  if (SETTLED.has(t.stage)) return "settled";
  if (t.stage === "queued" && !rec.admitted.includes(t.id)) return "queued";
  return "in_flight"; // admitted (a spawn may be under way), or past `queued`
}

/** The latest agent spawned per task, from a wave journal. */
export function taskActivity(events: Iterable<JournalEvent>): Record<TaskId, TaskActivity> {
  const out: Record<TaskId, TaskActivity> = {};
  for (const e of events) {
    if (e.type === "agent_spawned" && e.task !== undefined) {
      out[e.task] = { role: String(e.data.role ?? "agent"), since: e.at };
    }
  }
  return out;
}

function working(a: TaskActivity | undefined, now: string): string {
  if (a === undefined) return "admitted, not yet spawned";
  const min = Math.max(0, Math.floor((Date.parse(now) - Date.parse(a.since)) / 60_000));
  return `${a.role} working ${min} min`;
}

/** Normalised plans compared without their version number. */
export const samePlan = (a: Wave, b: Wave) =>
  JSON.stringify({ ...a, version: 0 }) === JSON.stringify({ ...b, version: 0 });

/**
 * Turn a new version of a wave's file into journal events (pure). Throws PlanChangeError when the
 * wave was never submitted or the new file is for another wave or repo.
 */
export function applyPlan(rec: WaveRecord, submitted: Wave, ctx: PlanContext): PlanApplication {
  const { state, wave: current } = rec;
  if (state === null || current === null) throw new PlanChangeError("wave not submitted");
  if (submitted.wave !== state.wave) {
    throw new PlanChangeError(`wave id '${submitted.wave}' is not '${state.wave}'`);
  }
  if (submitted.repo !== current.repo) {
    throw new PlanChangeError(
      `repo cannot change between versions (${current.repo} -> ${submitted.repo})`,
    );
  }
  const prevPlan = rec.plan ?? current;
  const diff = diffPlans(prevPlan, submitted);
  if (samePlan(prevPlan, submitted)) {
    return { version: state.version, diff, effective: current, events: [], unchanged: true };
  }

  const N = state.version + 1;
  const by = `plan v${N}`;
  const plan: Wave = { ...structuredClone(submitted), version: N };
  const taskState = new Map(state.tasks.map((t) => [t.id, t]));
  const phase = (id: TaskId) => phaseOf(rec, taskState.get(id));
  const pending = rec.planPending ?? {};
  const isOpen = (id: string) => state.open_decisions.includes(id);
  const tail: NewEvent[] = [];

  const resolve = (task: TaskId, decisionId: string, answer: string) =>
    tail.push({ type: "decision_resolved", task, data: { decision_id: decisionId, answer, by } });
  const open = (
    task: TaskId,
    change: PlanChangeKind,
    question: string,
    options: string[],
    data: Record<string, unknown>,
  ) =>
    tail.push({
      type: "decision_opened",
      task,
      data: {
        decision_id: planDecisionId(state.wave, task, change),
        kind: "plan_change",
        change,
        wave: state.wave,
        task,
        question,
        options,
        pointers: {},
        opened_at: ctx.now,
        plan_version: N,
        ...data,
      },
    });

  // Tasks the new plan no longer lists but that keep running (their agents need the definition).
  const retained: TaskId[] = current.task_order.filter(
    (id) => plan.tasks[id] === undefined && ["in_flight", "settled"].includes(phase(id)),
  );

  const tasks: Record<TaskId, WaveTask> = {};
  for (const id of plan.task_order) {
    const t = plan.tasks[id] as WaveTask;
    const cur = current.tasks[id];
    const p = phase(id);
    const keepIssue =
      cur !== undefined && cur.issue !== t.issue && (p === "in_flight" || p === "settled");
    tasks[id] = keepIssue ? { ...t, issue: cur.issue } : t;

    const issueId = planDecisionId(state.wave, id, "issue");
    if (p === "in_flight" && keepIssue) {
      const asked = pending[issueId];
      if (asked?.to_issue !== t.issue) {
        if (isOpen(issueId)) resolve(id, issueId, "superseded");
        const a = ctx.activity[id];
        open(
          id,
          "issue",
          `Needs you: ${by} re-points ${id} from #${cur.issue} to #${t.issue}, but it is ` +
            `working on #${cur.issue} (${working(a, ctx.now)}). Restart ${id} on #${t.issue}?`,
          ["restart", "let finish"],
          { from_issue: cur.issue, to_issue: t.issue },
        );
      }
    } else if (!keepIssue && isOpen(issueId) && pending[issueId] !== undefined) {
      resolve(id, issueId, "withdrawn");
    }

    const removedId = planDecisionId(state.wave, id, "removed");
    if (isOpen(removedId) && pending[removedId] !== undefined) resolve(id, removedId, "withdrawn");
  }
  for (const id of retained) {
    const cur = current.tasks[id] as WaveTask;
    tasks[id] = cur;
    const removedId = planDecisionId(state.wave, id, "removed");
    if (phase(id) === "in_flight" && !isOpen(removedId)) {
      open(
        id,
        "removed",
        `Needs you: ${by} removes ${id} (#${cur.issue}) — stop ${id} (${working(ctx.activity[id], ctx.now)})?`,
        ["stop", "let finish"],
        { issue: cur.issue },
      );
    }
  }
  const order = [...plan.task_order, ...retained];
  for (const id of retained) {
    const t = tasks[id] as WaveTask;
    tasks[id] = { ...t, after: t.after.filter((d) => order.includes(d)) };
  }

  const head: NewEvent[] = [];
  for (const id of diff.removed) {
    if (phase(id) === "queued") {
      head.push({
        type: "task_cancelled",
        task: id,
        data: { reason: `removed in ${by}`, plan_version: N },
      });
    }
  }
  for (const id of diff.added) {
    const p = phase(id);
    if (p === "absent" || p === "cancelled") {
      head.push({
        type: "task_queued",
        task: id,
        data: { issue: plan.tasks[id]?.issue, plan_version: N },
      });
    }
  }

  const effective: Wave = { ...plan, tasks, task_order: order };
  const versioned: NewEvent = {
    type: "wave_versioned",
    data: {
      version: N,
      previous_version: state.version,
      diff,
      plan,
      wave: effective,
      ...(ctx.file !== undefined ? { file: ctx.file } : {}),
    },
  };
  return { version: N, diff, effective, events: [versioned, ...head, ...tail], unchanged: false };
}
