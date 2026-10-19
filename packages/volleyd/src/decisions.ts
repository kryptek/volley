import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomSuffix } from "volley-mcp/util";
import type { WaveRecord } from "./reducer";
import type { NewEvent, TaskId, TaskStage, WaveId } from "./types";

/**
 * Decisions: questions only a human (or the owning coordinator) can answer, as first-class
 * journal events. Everything here is pure; the daemon journals the events these build, publishes
 * the retained `volley/_waves/<wave>/decisions/<id>` topic and writes the brief file.
 */

/** decision.schema.json payload.kind. */
export const DECISION_KINDS = [
  "reviewers_disagree",
  "merge_conflict",
  "agent_blocked",
  "agent_question",
  "agent_stalled",
  "unknown_screen",
  "hooks_auth_failed",
  "mcp_not_registered",
  "spawn_failed",
  "model_switch",
  "repo_untrusted",
  "remote_repo_missing",
  "ci_failed",
  "wave_complete",
  "plan_change",
] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

export interface DecisionPointers {
  diff?: string;
  transcript?: string;
  screen?: string;
  pr?: string;
}

/** The retained decision payload (decision.schema.json). */
export interface DecisionPayload {
  decision_id: string;
  wave: WaveId;
  task: TaskId | null;
  kind: DecisionKind;
  question: string;
  options?: string[];
  pointers: DecisionPointers;
  opened_at: string;
  resolved?: { answer: string; by: string; at: string };
  /** A remote host's decision (repo_untrusted, remote_repo_missing): its name and ssh target. */
  host?: string;
  target?: string;
  /** The repo path it is about (repo_untrusted, remote_repo_missing). */
  repo?: string;
  /** plan_change: what the new wave version changed about the task. */
  change?: string;
}

/** What the reducer keeps per decision: the payload plus what resolving needs. */
export interface DecisionRecord extends DecisionPayload {
  /** The task's stage when the decision opened; restored when its last open decision resolves. */
  resume_stage?: TaskStage;
  /** `false`: opened with `park: false`, the task keeps running while it is open. */
  parks?: boolean;
  rationale?: string;
}

/** What a caller (T6 reviewers, T8 recovery, a coordinator) supplies to open a decision. */
export interface DecisionInput {
  kind: DecisionKind;
  task: TaskId | null;
  question: string;
  pointers?: DecisionPointers;
  options?: string[];
  /** Optional caller-chosen id (idempotent re-open); default `d-<random>`. */
  id?: string;
  /**
   * `false`: a task-level decision that does not park its task (the work is untouched until the
   * answer — plan_change decisions about in-flight tasks). Default: the task parks.
   */
  park?: boolean;
}

/** Whether an open decision parks its task in `awaiting_decision` (all do unless opened with `park: false`). */
export const parksTask = (d: { parks?: boolean }): boolean => d.parks !== false;

/** Task stages a task-level decision may not park: their dependents already moved on. */
const SETTLED = new Set<TaskStage>(["done", "merge_ready", "cancelled"]);

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export const decisionTopic = (wave: WaveId, id: string) => `volley/_waves/${wave}/decisions/${id}`;

export const newDecisionId = () => `d-${randomSuffix(8)}`;

/** Decisions still open in a record, in opening order. */
export function openDecisions(rec: WaveRecord): DecisionRecord[] {
  const all = rec.decisions;
  return (rec.state?.open_decisions ?? []).flatMap((id) => (all[id] ? [all[id]] : []));
}

/** The `decision_opened` event for `input`, or an error message. Pure. */
export function openEvent(
  rec: WaveRecord,
  input: DecisionInput,
  now: Date,
): { event: NewEvent; id: string } | { error: string } {
  const wave = rec.state?.wave;
  if (wave === undefined) return { error: "wave has no state" };
  if (!(DECISION_KINDS as readonly string[]).includes(input.kind))
    return { error: `unknown decision kind '${input.kind}'` };
  if (typeof input.question !== "string" || input.question.trim() === "")
    return { error: "a decision needs a question" };
  if (input.task !== null) {
    const task = rec.state?.tasks.find((t) => t.id === input.task);
    if (task === undefined) return { error: `unknown task '${input.task}' in wave '${wave}'` };
    // Parking a finished task would re-park dependents it has already released.
    if (SETTLED.has(task.stage))
      return {
        error: `task '${input.task}' is ${task.stage}; open a wave-level decision (task: null) instead`,
      };
  }
  const id = input.id ?? newDecisionId();
  if (!ID_RE.test(id)) return { error: `decision id '${id}' does not match ${ID_RE.source}` };
  if (rec.decisions[id] !== undefined) return { error: `decision '${id}' already exists` };
  return {
    id,
    event: {
      type: "decision_opened",
      ...(input.task !== null ? { task: input.task } : {}),
      data: {
        decision_id: id,
        kind: input.kind,
        question: input.question,
        pointers: input.pointers ?? {},
        ...(input.options !== undefined && input.options.length > 0
          ? { options: input.options }
          : {}),
        opened_at: now.toISOString(),
        ...(input.park === false ? { parks: false } : {}),
      },
    },
  };
}

/**
 * The `decision_resolved` event, `{ already }` when the decision is resolved already (resolving
 * twice is a no-op), or an error for an unknown id. Pure.
 */
export function resolveEvent(
  rec: WaveRecord,
  id: string,
  r: { answer: string; by: string; rationale?: string },
  now: Date,
): { event: NewEvent } | { already: DecisionRecord } | { error: string } {
  const d = rec.decisions[id];
  if (d === undefined) return { error: `unknown decision '${id}' in wave '${rec.state?.wave}'` };
  if (d.resolved !== undefined) return { already: d };
  if (typeof r.answer !== "string" || r.answer.trim() === "")
    return { error: "resolve needs an answer" };
  return {
    event: {
      type: "decision_resolved",
      ...(d.task !== null ? { task: d.task } : {}),
      data: {
        decision_id: id,
        answer: r.answer,
        by: r.by,
        at: now.toISOString(),
        ...(r.rationale !== undefined && r.rationale !== "" ? { rationale: r.rationale } : {}),
      },
    },
  };
}

/**
 * The retained topic payload (decision.schema.json) for a decision record: the schema's fields
 * only. Facts the daemon keeps on the record for itself (agent_id, class, role, pipeline,
 * resume_stage, …) stay in the journal.
 */
export function decisionPayload(d: DecisionRecord): DecisionPayload {
  const x = d as DecisionRecord & {
    host?: unknown;
    target?: unknown;
    repo?: unknown;
    change?: unknown;
  };
  const str = (k: "host" | "target" | "repo" | "change") =>
    typeof x[k] === "string" && x[k] !== "" ? { [k]: x[k] as string } : {};
  return {
    decision_id: d.decision_id,
    wave: d.wave,
    task: d.task,
    kind: d.kind,
    question: d.question,
    ...(d.options !== undefined ? { options: d.options } : {}),
    pointers: d.pointers,
    opened_at: d.opened_at,
    ...(d.resolved !== undefined ? { resolved: d.resolved } : {}),
    ...str("host"),
    ...str("target"),
    ...str("repo"),
    ...str("change"),
  };
}

/** One-line human summary, used for the notify bridge and CLI output. */
export function describeDecision(d: DecisionPayload): string {
  const where = d.task !== null ? `${d.wave}/${d.task}` : d.wave;
  return `decision ${d.decision_id} (${d.kind}) on ${where}: ${d.question}`;
}

/**
 * The notify bridge: a progress envelope payload on the daemon's own topic. Its envelope type is
 * `blocked` — in `volley notify`'s default `--on` set — so an existing
 * `volley notify --pattern 'volley/<ns>/volleyd/progress'` rings for every new decision.
 */
export function attentionPayload(d: DecisionPayload): Record<string, unknown> {
  return {
    attention: "decision_opened",
    wave: d.wave,
    task: d.task,
    decision_id: d.decision_id,
    kind: d.kind,
    question: d.question,
    msg: `needs you: ${describeDecision(d)}`,
    text: describeDecision(d),
  };
}

/** `.volley/decisions.md`: every resolved decision for a task, for the next stage's brief. */
export function renderDecisionsMd(wave: WaveId, task: TaskId, decisions: DecisionRecord[]): string {
  const blocks = decisions
    .filter((d) => d.resolved !== undefined)
    .map((d) => {
      const lines = [`## ${d.decision_id} — ${d.kind}`, "", `**Q:** ${d.question}`, ""];
      lines.push(`**A:** ${d.resolved?.answer} _(by ${d.resolved?.by}, ${d.resolved?.at})_`);
      if (d.rationale !== undefined) lines.push("", `**Why:** ${d.rationale}`);
      const ptrs = Object.entries(d.pointers).map(([k, v]) => `${k}: ${v}`);
      if (ptrs.length > 0) lines.push("", `Evidence: ${ptrs.join(" · ")}`);
      return lines.join("\n");
    });
  return [
    `# Decisions for ${wave} / ${task}`,
    "",
    "Answers to questions raised while this task ran. They are binding for the next stage.",
    "",
    blocks.join("\n\n"),
    "",
  ].join("\n");
}

/** Write `<dir>/.volley/decisions.md` atomically; returns its path. */
export function writeDecisionsFile(dir: string, content: string): string {
  const volley = join(dir, ".volley");
  mkdirSync(volley, { recursive: true });
  const path = join(volley, "decisions.md");
  writeFileSync(`${path}.tmp`, content);
  renameSync(`${path}.tmp`, path);
  return path;
}
