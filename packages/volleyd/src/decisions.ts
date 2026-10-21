import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomSuffix } from "volley-mcp/util";
import type { Budget, EscalateWhy } from "./autopilot/policy";
import type { Host } from "./hosts/host";
import type { WaveRecord } from "./reducer";
import type { NewEvent, TaskId, TaskStage, WaveId } from "./types";

/** The answer an archive closes every open decision with. */
export const ARCHIVED_ANSWER = "archived";

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
  "pr_closed",
  "pr_head_moved",
  "spawn_budget_exhausted",
  "account_limit",
  "machine_down",
  "merge_refused",
  "release_go",
  "stage_go",
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
  /** account_limit (claude/usage.ts): the account, its 5-hour window and the suggested target. */
  acct?: string;
  pct?: number;
  resets_at?: string | null;
  suggested?: string | null;
  /** machine_down: when the supervisor marked `host` down, and the wave's unfinished tasks there. */
  down_since?: string;
  tasks?: TaskId[];
  /** machine_down: what is wrong with `host` (absent: down). */
  machine?: MachineTrouble;
  /** stage_go: the release playbook stage that runs only on go (SPEC §4.6.19). */
  stage?: string;
  /** release_go: every release stage, verified, with where its evidence lives. */
  stages?: { name: string; evidence?: string }[];
}

/** What the reducer keeps per decision: the payload plus what resolving needs. */
export interface DecisionRecord extends DecisionPayload {
  /** The task's stage when the decision opened; restored when its last open decision resolves. */
  resume_stage?: TaskStage;
  /** `false`: opened with `park: false`, the task keeps running while it is open. */
  parks?: boolean;
  rationale?: string;
  /** Autopilot left it for the owner (`decision_escalated`, SPEC §4.6.16): why. */
  escalated?: { why: EscalateWhy; budget?: Budget };
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

export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export const decisionTopic = (wave: WaveId, id: string) => `volley/_waves/${wave}/decisions/${id}`;

export const newDecisionId = () => `d-${randomSuffix(8)}`;

/**
 * A deterministic decision id: `<kind>-<12 hex>`, hashed over its wave and `key` — the same on
 * every restart (so an open one is found again), and never shared by two waves (`resolve` without
 * `--wave` answers the first wave that has the id). Every fixed or derived id goes through here.
 */
export function waveDecisionId(kind: DecisionKind, wave: WaveId, ...key: string[]): string {
  const h = createHash("sha256")
    .update(JSON.stringify([wave, ...key]))
    .digest("hex");
  return `${kind}-${h.slice(0, 12)}`;
}

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
    // Parking a finished task would re-park dependents it has already released. A blocked agent
    // on one is still asked about, by a decision that does not park it.
    const blockedAside = input.kind === "agent_blocked" && input.park === false;
    if (SETTLED.has(task.stage) && !blockedAside)
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

/** What an escalated decision's retained question starts with (SPEC §4.6.16). */
export const escalatedPrefix = (why: string): string =>
  `Autopilot could not resolve this (${why}): `;

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
    acct?: unknown;
  };
  const str = (k: "host" | "target" | "repo" | "change" | "acct") =>
    typeof x[k] === "string" && x[k] !== "" ? { [k]: x[k] as string } : {};
  const limit =
    d.kind === "account_limit"
      ? {
          ...(typeof d.pct === "number" ? { pct: d.pct } : {}),
          ...(d.resets_at !== undefined ? { resets_at: d.resets_at } : {}),
          ...(d.suggested !== undefined ? { suggested: d.suggested } : {}),
        }
      : {};
  const down =
    d.kind === "machine_down"
      ? {
          ...(typeof d.down_since === "string" ? { down_since: d.down_since } : {}),
          ...(Array.isArray(d.tasks) ? { tasks: d.tasks } : {}),
          ...(typeof d.machine === "string" ? { machine: d.machine } : {}),
        }
      : {};
  const release = {
    ...(d.kind === "stage_go" && typeof d.stage === "string" ? { stage: d.stage } : {}),
    ...(d.kind === "release_go" && Array.isArray(d.stages) ? { stages: d.stages } : {}),
  };
  return {
    decision_id: d.decision_id,
    wave: d.wave,
    task: d.task,
    kind: d.kind,
    question:
      d.escalated !== undefined && d.resolved === undefined
        ? `${escalatedPrefix(d.escalated.why)}${d.question}`
        : d.question,
    ...(d.options !== undefined ? { options: d.options } : {}),
    pointers: d.pointers,
    opened_at: d.opened_at,
    ...(d.resolved !== undefined ? { resolved: d.resolved } : {}),
    ...str("host"),
    ...str("target"),
    ...str("repo"),
    ...str("change"),
    ...str("acct"),
    ...limit,
    ...down,
    ...release,
  };
}

// ---------------------------------------------------------------------------------------------
// Fleet (F6, SPEC §4.6.15): a machine that stays down
// ---------------------------------------------------------------------------------------------

/** A `machine_down` decision's options; `wait` is what happens when nobody answers. */
export const MACHINE_DOWN_OPTIONS = ["wait", "re-place queued tasks", "cancel"];
export const MACHINE_DOWN_WAIT = "wait";
export const MACHINE_DOWN_REPLACE = "re-place queued tasks";
export const MACHINE_DOWN_CANCEL = "cancel";

/**
 * Why a machine's tasks are asked about: it stayed `down`, it is `draining` (nothing new starts
 * there), it is being removed (`removing`), or it was `removed`.
 */
export type MachineTrouble = "down" | "draining" | "removing" | "removed";

/** What the supervisor knows when a machine's waiting tasks need the owner. */
export interface MachineDownFacts {
  host: string;
  /** What is wrong with it (default `down`). */
  machine?: MachineTrouble;
  /** Since when (epoch ms, the supervisor's own clock), and now. */
  downSince: number;
  now: number;
  /** Why it is down (`MachineHealth.whyDown`): `no heartbeat for 90 s`, `disconnected`. */
  why: string;
  /**
   * The wave's tasks there with no agent running (queued, or waiting for their next role: they
   * would be re-placed), and those with one.
   */
  queued: TaskId[];
  running: TaskId[];
  /** Where the first waiting task would go now (placement without `host`); null: nowhere yet. */
  best: string | null;
}

/** `T1`, `T1 and T2`, `T1, T2 and T3`. */
const listOf = (ids: readonly string[]): string =>
  ids.length <= 1 ? (ids[0] ?? "") : `${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}`;

/** `5 min`, `1 h 5 min`: how long a machine has been down. */
function duration(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  return min < 60
    ? `${min} min`
    : `${Math.floor(min / 60)} h${min % 60 > 0 ? ` ${min % 60} min` : ""}`;
}

/**
 * The wave-level `machine_down` decision (pure): its question says what happened, what each
 * option does and what happens if nobody answers; `data` is the facts the payload carries. A
 * machine being removed, or removed, offers no `wait`: nothing starts there again.
 */
export function machineDownInput(f: MachineDownFacts): {
  input: DecisionInput;
  data: { host: string; down_since: string; tasks: TaskId[]; machine: MachineTrouble };
} {
  const { host, queued, running } = f;
  const machine = f.machine ?? "down";
  const all = [...new Set([...running, ...queued])].sort();
  const one = queued.length === 1;
  const head = {
    down: `${host} has been down ${duration(f.now - f.downSince)} (${f.why}).`,
    draining: `${host} is draining: nothing new starts there.`,
    removing: `${host} is being removed: nothing new starts there, and the removal finishes once no agent runs there.`,
    removed: `${host} was removed.`,
  }[machine];
  const what =
    queued.length === 0
      ? "No task placed there is waiting for an agent."
      : `${queued.length} task${one ? "" : "s"} placed there ${one ? "has" : "have"} no agent running (queued, or waiting for ${one ? "its" : "their"} next role): ${listOf(queued)}.`;
  const live =
    running.length === 0
      ? ""
      : ` ${listOf(running)} ${running.length === 1 ? "is" : "are"} running there and ${running.length === 1 ? "is" : "are"} left alone: a running agent is never moved.`;
  const replace =
    queued.length === 0
      ? "re-place queued tasks: nothing is waiting there now."
      : `re-place queued tasks: place ${listOf(queued)} again without ${host} (${f.best !== null ? `best now for ${queued[0]}: ${f.best}` : `no other machine is eligible now: ${one ? "it waits" : "they wait"} for one and ${one ? "is" : "are"} placed as soon as one is`}).`;
  const wait =
    machine === "down"
      ? `wait: keep them parked until ${host} is back; this is what happens if nobody answers, and this question closes itself when ${host} returns.`
      : machine === "draining"
        ? `wait: keep them parked until ${host} takes new agents again (hosts.${host}.drain set back to false); this is what happens if nobody answers.`
        : `If nobody answers they stay parked: nothing starts on ${host} again.`;
  const stopped =
    running.length === 0
      ? ""
      : running.length === 1
        ? ` (${running[0]}'s running agent is told to stop)`
        : ` (the running agents of ${listOf(running)} are told to stop)`;
  const question = [
    head,
    `${what}${live}`,
    wait,
    replace,
    `cancel: cancel ${listOf(all)}${stopped}.`,
  ].join(" ");
  const options =
    machine === "down" || machine === "draining"
      ? [...MACHINE_DOWN_OPTIONS]
      : [MACHINE_DOWN_REPLACE, MACHINE_DOWN_CANCEL];
  return {
    input: { kind: "machine_down", task: null, question, options },
    data: { host, down_since: new Date(f.downSince).toISOString(), tasks: all, machine },
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

/** Where a task's decisions file goes in `dir` (its worktree, or its local task dir). */
export function decisionsFilePath(dir: string): string {
  return join(dir, ".volley", "decisions.md");
}

/** The supervisor's own disk, for a task with no worktree yet: written atomically. */
export const LOCAL_FILES: Pick<Host, "writeFile"> = {
  async writeFile(path, content) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.tmp`, content);
    await rename(`${path}.tmp`, path);
  },
};

/**
 * Write `<dir>/.volley/decisions.md` through `files` (the task's host: a remote task's worktree
 * is on its machine); returns its path. The mode makes the local adapter write a temp file and
 * rename it, so a reader never sees half a file; the ssh adapter writes in place, which is fine
 * because the file is read at the next stage's brief, not while it is written.
 */
export async function writeDecisionsFile(
  files: Pick<Host, "writeFile">,
  dir: string,
  content: string,
): Promise<string> {
  const path = decisionsFilePath(dir);
  await files.writeFile(path, content, 0o644);
  return path;
}
