import { createHash } from "node:crypto";
import { type DecisionInput, type DecisionRecord, openEvent, resolveEvent } from "./decisions";
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
 * "Queued" means not started: still `queued` with no agent spawned and no spawn under way (an
 * admitted task waiting for its spawn slot is still queued, and gives its admission back).
 *
 * The first event is `wave_versioned` carrying the submitted plan (`plan`), the effective plan the
 * scheduler and spawner use from now on (`wave`: the submitted plan, plus removed in-flight tasks
 * and in-flight tasks' old issues kept until decided) and the structural diff. plan_change
 * decisions are T7 decisions (decisions.ts `openEvent`/`resolveEvent`): the daemon opens and
 * resolves them through its decision store, so they reach `volley/_waves/<wave>/decisions/<id>`.
 * They are opened with `park: false`: the task keeps running. A question is asked once: an open or answered decision is not
 * asked again by a later version (a new issue target is a new question, with a new id). A later
 * version that undoes a change withdraws its open decision; one that asks a new question about the
 * same change supersedes it.
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
  /** Tasks whose spawn is under way (not yet journaled `agent_spawned`): in flight. */
  spawning?: TaskId[];
  /** Where the version's file is stored (journaled on `wave_versioned`). */
  file?: string;
}

/** One decision step, run through the daemon's decision store (open/resolve + topic) in order. */
export type PlanDecisionOp =
  | {
      op: "resolve";
      decision_id: string;
      task: TaskId;
      answer: "withdrawn" | "superseded";
      by: string;
    }
  | {
      op: "open";
      input: DecisionInput & { id: string; task: TaskId };
      extra: Record<string, unknown>;
    };

export interface PlanApplication {
  version: number;
  diff: PlanDiff;
  /** The plan the scheduler and spawner use from this version on. */
  effective: Wave;
  /** The plan's own journal events (`wave_versioned`, cancels, queues), in order. */
  planEvents: NewEvent[];
  /** The plan_change decisions to resolve and open, after `planEvents`. */
  decisions: PlanDecisionOp[];
  /** Every event, in order: `planEvents` then the decisions' events (T7's open/resolve events). */
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

/** The id of the plan_change decision a version opens about one task and kind. */
export function planDecisionId(
  wave: string,
  task: TaskId,
  change: PlanChangeKind,
  version: number,
): string {
  const h = createHash("sha256")
    .update(`${wave}/${task}/${change}/v${version}`)
    .digest("hex")
    .slice(0, 12);
  return `plan_change-${h}`;
}

/** Answers a plan version gives when it closes its own question (not the owner's answer). */
const PLAN_ANSWERS = new Set(["withdrawn", "superseded"]);

/** The latest plan_change decision on `task` about `change`, if any (opening order). */
export function latestPlanDecision(
  rec: WaveRecord,
  task: TaskId,
  change: PlanChangeKind,
): (DecisionRecord & { change?: string; to_issue?: number }) | undefined {
  let last: (DecisionRecord & { change?: string; to_issue?: number }) | undefined;
  for (const d of Object.values(rec.decisions) as (DecisionRecord & { change?: string })[]) {
    if (d.kind === "plan_change" && d.task === task && d.change === change) last = d;
  }
  return last;
}

/** Stages in which a task has finished its work (a plan change no longer touches it). */
const SETTLED = new Set(["done", "merge_ready"]);

type Phase = "absent" | "queued" | "in_flight" | "settled" | "cancelled";

function phaseOf(t: TaskState | undefined, ctx: PlanContext): Phase {
  if (t === undefined) return "absent";
  if (t.stage === "cancelled") return "cancelled";
  if (SETTLED.has(t.stage)) return "settled";
  const started =
    ctx.activity[t.id] !== undefined ||
    (ctx.spawning ?? []).includes(t.id) ||
    Object.keys(t.agents).length > 0;
  if (t.stage === "queued" && !started) return "queued";
  return "in_flight"; // an agent was spawned (or is being spawned), or past `queued`
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
  if (a === undefined) return "spawning";
  const min = Math.max(0, Math.floor((Date.parse(now) - Date.parse(a.since)) / 60_000));
  return `${a.role} working ${min} min`;
}

/** JSON with object keys sorted: key order (task order included) is not part of a plan. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x !== null && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  );
}

/** Normalised plans compared without their version number or the order of their keys. */
export const samePlan = (a: Wave, b: Wave) =>
  canonical({ ...a, version: 0, task_order: [] }) ===
  canonical({ ...b, version: 0, task_order: [] });

/** Wave-level fields a new version may not change: running agents work against them. */
const FIXED = ["repo", "release_branch", "namespace"] as const;

/**
 * Turn a new version of a wave's file into journal events and decision steps (pure). Throws
 * PlanChangeError when the wave was never submitted or the new file is for another wave, repo,
 * release branch or namespace.
 */
export function applyPlan(rec: WaveRecord, submitted: Wave, ctx: PlanContext): PlanApplication {
  const { state, wave: current } = rec;
  if (state === null || current === null) throw new PlanChangeError("wave not submitted");
  if (submitted.wave !== state.wave) {
    throw new PlanChangeError(`wave id '${submitted.wave}' is not '${state.wave}'`);
  }
  for (const k of FIXED) {
    if (submitted[k] !== current[k]) {
      throw new PlanChangeError(
        `${k} cannot change between versions (${current[k] ?? "-"} -> ${submitted[k] ?? "-"})`,
      );
    }
  }
  const prevPlan = rec.plan ?? current;
  const diff = diffPlans(prevPlan, submitted);
  if (samePlan(prevPlan, submitted)) {
    return {
      version: state.version,
      diff,
      effective: current,
      planEvents: [],
      decisions: [],
      events: [],
      unchanged: true,
    };
  }

  const N = state.version + 1;
  const by = `plan v${N}`;
  const plan: Wave = { ...structuredClone(submitted), version: N };
  const taskState = new Map(state.tasks.map((t) => [t.id, t]));
  const phase = (id: TaskId) => phaseOf(taskState.get(id), ctx);
  const isOpen = (d: DecisionRecord | undefined): d is DecisionRecord =>
    d !== undefined && d.resolved === undefined;
  /** Open, or answered by the owner (not closed by a plan version). */
  const asked = <D extends DecisionRecord>(d: D | undefined): d is D =>
    d !== undefined && (d.resolved === undefined || !PLAN_ANSWERS.has(d.resolved.answer));
  const decisions: PlanDecisionOp[] = [];

  const resolve = (task: TaskId, d: DecisionRecord, answer: "withdrawn" | "superseded") =>
    decisions.push({ op: "resolve", decision_id: d.decision_id, task, answer, by });
  const open = (
    task: TaskId,
    change: PlanChangeKind,
    question: string,
    options: string[],
    extra: Record<string, unknown>,
  ) =>
    decisions.push({
      op: "open",
      input: {
        id: planDecisionId(state.wave, task, change, N),
        kind: "plan_change",
        task,
        question,
        options,
        pointers: {},
        park: false, // the plan rule: in-flight work is untouched until the answer
      },
      extra: { change, plan_version: N, ...extra },
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

    const issueD = latestPlanDecision(rec, id, "issue");
    if (p === "in_flight" && keepIssue) {
      // Asked (or answered) about this very target already: not asked again.
      if (!(asked(issueD) && issueD.to_issue === t.issue)) {
        if (isOpen(issueD)) resolve(id, issueD, "superseded");
        open(
          id,
          "issue",
          `Needs you: ${by} re-points ${id} from #${cur.issue} to #${t.issue}, but it is ` +
            `working on #${cur.issue} (${working(ctx.activity[id], ctx.now)}). Restart ${id} on #${t.issue}?`,
          ["restart", "let finish"],
          { from_issue: cur.issue, to_issue: t.issue },
        );
      }
    } else if (!keepIssue && isOpen(issueD)) {
      resolve(id, issueD, "withdrawn");
    }

    const removedD = latestPlanDecision(rec, id, "removed");
    if (isOpen(removedD)) resolve(id, removedD, "withdrawn");
  }
  for (const id of retained) {
    const cur = current.tasks[id] as WaveTask;
    tasks[id] = cur;
    if (phase(id) !== "in_flight") continue;
    // The plan no longer lists the task: a pending "restart on #new?" no longer applies.
    const issueD = latestPlanDecision(rec, id, "issue");
    if (isOpen(issueD)) resolve(id, issueD, "withdrawn");
    if (!asked(latestPlanDecision(rec, id, "removed"))) {
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
  const planEvents = [versioned, ...head];
  return {
    version: N,
    diff,
    effective,
    planEvents,
    decisions,
    events: [...planEvents, ...decisionEvents(rec, decisions, new Date(ctx.now))],
    unchanged: false,
  };
}

/**
 * The journal events of `ops`, built with T7's `openEvent`/`resolveEvent` against `rec` (pure;
 * what the daemon's decision store journals for them). Throws if T7 refuses one.
 */
export function decisionEvents(rec: WaveRecord, ops: PlanDecisionOp[], now: Date): NewEvent[] {
  return ops.map((o) => {
    if (o.op === "resolve") {
      const r = resolveEvent(rec, o.decision_id, { answer: o.answer, by: o.by }, now);
      if ("error" in r) throw new PlanChangeError(r.error);
      if ("already" in r) throw new PlanChangeError(`decision '${o.decision_id}' already resolved`);
      return r.event;
    }
    const r = openEvent(rec, o.input, now);
    if ("error" in r) throw new PlanChangeError(r.error);
    return { ...r.event, data: { ...o.extra, ...r.event.data } };
  });
}

/** What the owner's answer to a plan_change decision does. */
export interface PlanAnswer {
  /** Cancel the task's running agents (mailbox `cancel` + interrupt) with this text. */
  cancel?: string;
  /** Events to journal after the resolution. */
  events: NewEvent[];
}

/**
 * The effect of a resolved plan_change decision (pure): `stop` on a removed task cancels it;
 * `restart` on a re-pointed task cancels its agents and queues it again on the new issue (when the
 * current plan still points it there). `let finish`, and anything on a task that already finished,
 * does nothing.
 */
export function planAnswer(rec: WaveRecord, d: DecisionRecord): PlanAnswer {
  const none: PlanAnswer = { events: [] };
  const answer = d.resolved?.answer.trim().toLowerCase();
  const t = rec.state?.tasks.find((x) => x.id === d.task);
  if (d.kind !== "plan_change" || t === undefined || answer === undefined) return none;
  if (t.stage === "cancelled" || SETTLED.has(t.stage)) return none;
  const x = d as DecisionRecord & { change?: string; to_issue?: number; plan_version?: number };
  const v = `plan v${x.plan_version ?? rec.state?.version}`;
  if (x.change === "removed" && answer === "stop") {
    return {
      cancel: `volleyd: ${v} removed ${t.id} and the owner answered stop. Stop work on ${t.id} now: do not push, open or merge anything further, publish your terminal status and exit.`,
      events: [
        { type: "task_cancelled", task: t.id, data: { reason: `stopped: removed in ${v}` } },
      ],
    };
  }
  const to = x.to_issue;
  if (x.change === "issue" && answer === "restart" && to !== undefined) {
    if (rec.plan?.tasks[t.id]?.issue !== to) return none; // a later version moved it again
    return {
      cancel: `volleyd: ${v} re-pointed ${t.id} from #${t.issue} to #${to} and the owner answered restart. Stop work on #${t.issue} now: do not push, open or merge anything further, publish your terminal status and exit.`,
      events: [
        { type: "task_cancelled", task: t.id, data: { reason: `restart on #${to} (${v})` } },
        { type: "task_queued", task: t.id, data: { issue: to, restart_of: t.issue } },
      ],
    };
  }
  return none;
}
