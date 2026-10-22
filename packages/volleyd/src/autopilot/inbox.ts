import { DAEMON_AGENT_ID } from "../control";
import { type DecisionKind, type DecisionPayload, validateAnswer } from "../decisions";
import type { AutopilotConfig, JournalEvent, NewEvent, TaskId, WaveId } from "../types";

/**
 * The needs-you inbox (SPEC §4.6.18): one retained record per thing waiting for a person, on
 * `volley/_inbox/<id>`, published by volleyd only. volleyd is the referee: an answer names the
 * item version it answers, the first one at the current version wins (compare-and-set) and a
 * later one is refused with where the winner answered. Everything here is pure; the daemon
 * journals the events these build and publishes the records.
 */

export const INBOX_KINDS = ["decision", "picker", "handoff", "release"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export const WHERE_KINDS = ["desk", "terminal", "cli", "autopilot"] as const;
export type WhereKind = (typeof WHERE_KINDS)[number];

/** Where an answer was given: a Desk device, a machine's terminal, the CLI, or autopilot. */
export interface InboxWhere {
  kind: WhereKind;
  device?: string;
  machine?: string;
}

export interface InboxAnswered {
  answer: string;
  by: string;
  where: InboxWhere;
  at: string;
}

export interface InboxOption {
  label: string;
  description?: string;
}

/** The retained record (inbox-item.schema.json payload). */
export interface InboxItem {
  id: string;
  kind: InboxKind;
  version: number;
  owner_only: boolean;
  wave?: WaveId;
  task?: TaskId;
  agent_id: string;
  title: string;
  question: string;
  options?: InboxOption[];
  allow_other?: boolean;
  multi?: boolean;
  pointers: Record<string, string>;
  opened_at: string;
  source: Record<string, unknown>;
  answered?: InboxAnswered;
}

/** An answer offered to the referee (the `inbox_answer` op, or a CLI / autopilot resolve). */
export interface InboxAnswerRequest {
  version: number;
  answer: string;
  by: string;
  where: InboxWhere;
  /**
   * Set by the daemon only when the request arrived on the sender's own account-op topic, where
   * the broker names the sender, and the sender is a Desk login: the owner on another screen, so
   * the ownership checks do not apply. Never read from a payload.
   */
  desk_login?: true;
}

/**
 * Carries out an answer to an item that is not a decision, before it is recorded: a reason
 * returned refuses it (the item stays open).
 */
export type InboxHandler = (item: InboxItem, req: InboxAnswerRequest) => Promise<string | null>;

export const INBOX_CHANNEL = "_inbox";
export const INBOX_FILTER = "volley/_inbox/+";
export const inboxTopic = (id: string) => `volley/_inbox/${id}`;

/** The envelope type of an item's retained record. */
export const inboxEnvelopeType = (item: InboxItem): "inbox_item" | "inbox_answered" =>
  item.answered === undefined ? "inbox_item" : "inbox_answered";

/** The id of the item mirroring decision `id` of `wave`. */
export const decisionItemId = (wave: WaveId, id: string) => `d-${wave}-${id}`;

/** `reviewers_disagree` → `Reviewers disagree`. */
const humanize = (kind: string): string => {
  const s = kind.replaceAll("_", " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/**
 * The inbox item mirroring a decision, built from its payload when it opens: an escalation
 * journaled later does not refresh it, so an escalated decision's item lacks that prefix.
 * `owner_only` is the decision kind's place in `autopilot.owner_only`; a decision always takes a
 * free-text answer besides its options.
 */
export function itemForDecision(
  d: DecisionPayload & { agent_id?: unknown },
  cfg: Pick<AutopilotConfig, "owner_only">,
): InboxItem {
  const where = d.task !== null ? `${d.wave}/${d.task}` : d.wave;
  return {
    id: decisionItemId(d.wave, d.decision_id),
    kind: "decision",
    version: 1,
    owner_only: cfg.owner_only.includes(d.kind),
    wave: d.wave,
    ...(d.task !== null ? { task: d.task } : {}),
    agent_id: typeof d.agent_id === "string" && d.agent_id !== "" ? d.agent_id : DAEMON_AGENT_ID,
    title: `${humanize(d.kind)} · ${where}`,
    question: d.question,
    ...(d.options !== undefined && d.options.length > 0
      ? { options: d.options.map((label) => ({ label })) }
      : {}),
    allow_other: true,
    pointers: { ...d.pointers } as Record<string, string>,
    opened_at: d.opened_at,
    source: { decision_id: d.decision_id, decision_kind: d.kind },
  };
}

/** `desk·phone`, `<machine>·terminal`, `cli`, `autopilot`. */
export function whereLabel(w: InboxWhere): string {
  if (w.kind === "desk") return w.device !== undefined ? `desk·${w.device}` : "desk";
  if (w.kind === "terminal") return w.machine !== undefined ? `${w.machine}·terminal` : "terminal";
  return w.kind;
}

/** A `where` from untrusted input, or null when it is not one. */
export function parseWhere(v: unknown): InboxWhere | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (!(WHERE_KINDS as readonly unknown[]).includes(o.kind)) return null;
  const str = (k: "device" | "machine") =>
    typeof o[k] === "string" && o[k] !== "" ? { [k]: o[k] as string } : {};
  return { kind: o.kind as WhereKind, ...str("device"), ...str("machine") };
}

/** `whereLabel`'s inverse (`--where desk·phone`, `mbp·terminal`, `cli`); null for anything else. */
export function parseWhereLabel(label: string): InboxWhere | null {
  const [a, b, ...rest] = label.split("·");
  if (a === undefined || a === "" || rest.length > 0 || b === "") return null;
  if (b === undefined)
    return (WHERE_KINDS as readonly string[]).includes(a) ? { kind: a as WhereKind } : null;
  if (a === "desk") return { kind: "desk", device: b };
  if (b === "terminal") return { kind: "terminal", machine: a };
  return null;
}

/** The `inbox_opened` event for a new item (the whole record, so a restart rebuilds it). */
export function openedEvent(item: InboxItem): NewEvent {
  return { type: "inbox_opened", data: { item } };
}

/**
 * The referee (compare-and-set): the `inbox_answered` event and the item at its next version, or
 * why the answer is refused. An answered item takes no second answer, at any version.
 */
export function answerEvent(
  item: InboxItem,
  req: InboxAnswerRequest,
  now: Date,
): { event: NewEvent; item: InboxItem } | { refused: string } {
  if (item.answered !== undefined)
    return { refused: `already answered on ${whereLabel(item.answered.where)}` };
  if (req.version !== item.version)
    return { refused: `stale version ${req.version} (the item is at version ${item.version})` };
  if (typeof req.answer !== "string" || req.answer.trim() === "")
    return { refused: "an answer is required" };
  if (parseWhere(req.where) === null)
    return { refused: "where.kind must be desk, terminal, cli or autopilot" };
  const version = item.version + 1;
  const answered: InboxAnswered = {
    answer: req.answer,
    by: req.by,
    where: req.where,
    at: now.toISOString(),
  };
  return {
    event: {
      type: "inbox_answered",
      data: {
        id: item.id,
        kind: item.kind,
        answer: req.answer,
        by: req.by,
        where: req.where,
        version,
      },
    },
    item: { ...item, version, answered },
  };
}

/**
 * A person's answer to a decision item that its decision cannot apply (decisions.ts
 * `validateAnswer`), or null. The referee asks before the compare-and-set: a refused answer
 * changes nothing, whatever version it names. It skips `checkAnswer`'s exemption for
 * pipeline-marked decisions (the item does not carry the marker): `validateAnswer` checks only
 * supervisor-owned kinds, which no pipeline opens.
 */
export function decisionAnswerRefusal(item: InboxItem, answer: string): string | null {
  const kind = item.source.decision_kind;
  if (item.kind !== "decision" || typeof kind !== "string") return null;
  const r = validateAnswer(
    kind as DecisionKind,
    item.options?.map((o) => o.label),
    answer,
  );
  return "refused" in r ? r.refused : null;
}

/** An answered item whose `ttlS` has passed since its answer: its retained record is cleared. */
export function ttlExpired(item: InboxItem, now: number, ttlS: number): boolean {
  return item.answered !== undefined && now - Date.parse(item.answered.at) >= ttlS * 1000;
}

/** Fold journal events onto the inbox map (rebuilt on start from every journal). */
export function foldInbox(map: Map<string, InboxItem>, events: readonly JournalEvent[]) {
  for (const e of events) {
    if (e.type === "inbox_opened") {
      const item = e.data.item as InboxItem | undefined;
      if (item?.id !== undefined) map.set(item.id, item);
    } else if (e.type === "inbox_answered") {
      const item = map.get(e.data.id as string);
      if (item === undefined) continue;
      map.set(item.id, {
        ...item,
        version: e.data.version as number,
        answered: {
          answer: e.data.answer as string,
          by: e.data.by as string,
          where: e.data.where as InboxWhere,
          at: e.at,
        },
      });
    }
  }
  return map;
}

/** An item id (inbox-item.schema.json `id`): a tool use id is mixed-case. */
export const INBOX_ID = /^[dphr]-[A-Za-z0-9_-]{1,200}$/;

/** The id of the item for picker `toolUseId` in `agentId`'s session. */
export const pickerItemId = (agentId: string, toolUseId: string) => `p-${agentId}-${toolUseId}`;

/** The id of the item for the handoff `agentId`'s hook published as progress `seq`. */
export const handoffItemId = (agentId: string, seq: number) => `h-${agentId}-${seq}`;

/** One `AskUserQuestion` question, as the PreToolUse hook publishes it (`picker_opened`). */
export interface PickerQuestion {
  question: string;
  header?: string;
  options: InboxOption[];
  multiSelect?: boolean;
}

/** `picker_opened.questions`, or null when it is not a non-empty list of questions. */
export function parsePickerQuestions(v: unknown): PickerQuestion[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: PickerQuestion[] = [];
  for (const q of v) {
    if (typeof q !== "object" || q === null) return null;
    const o = q as Record<string, unknown>;
    if (typeof o.question !== "string" || o.question.trim() === "" || !Array.isArray(o.options))
      return null;
    const options: InboxOption[] = [];
    for (const opt of o.options) {
      const label = (opt as { label?: unknown } | null)?.label;
      if (typeof label !== "string" || label === "") return null;
      const description = (opt as { description?: unknown }).description;
      options.push({ label, ...(typeof description === "string" ? { description } : {}) });
    }
    out.push({
      question: o.question,
      ...(typeof o.header === "string" && o.header !== "" ? { header: o.header } : {}),
      options,
      ...(typeof o.multiSelect === "boolean" ? { multiSelect: o.multiSelect } : {}),
    });
  }
  return out;
}

/** Where a session's screen is, so an answer can be carried out on it. */
export interface SessionSurface {
  wave?: WaveId;
  task?: TaskId;
  /** The terminal workspace (cmux ref, tmux session); absent when volleyd cannot see it. */
  workspace?: string;
  /** The host's name in the wave file (`local`, or a paired machine's). */
  host?: string;
  /** The machine its terminal is on, for `where: { kind: "terminal", machine }`. */
  machine: string;
  /** volleyd supervises it (a wave's agent), rather than an interactive (coordinator) session. */
  supervised: boolean;
}

const surfaceFields = (s: SessionSurface) => ({
  ...(s.wave !== undefined ? { wave: s.wave } : {}),
  ...(s.task !== undefined ? { task: s.task } : {}),
});

const surfaceSource = (s: SessionSurface) => ({
  ...(s.workspace !== undefined ? { workspace: s.workspace } : {}),
  ...(s.host !== undefined ? { host: s.host } : {}),
  machine: s.machine,
});

/** `w1/T1`, or the agent id of a session no wave task names. */
const whoseLabel = (agentId: string, s: SessionSurface) =>
  s.wave !== undefined && s.task !== undefined ? `${s.wave}/${s.task}` : agentId;

/**
 * The item for a picker: one question's text and options (any number of questions is answered
 * in its terminal, so their item lists them all, without options). A coordinator's own question
 * is the owner's (`owner_only`); a wave agent's is anyone's who may steer.
 */
export function itemForPicker(
  agentId: string,
  toolUseId: string,
  questions: PickerQuestion[],
  surface: SessionSurface,
  openedAt: string,
): InboxItem {
  const [first] = questions as [PickerQuestion];
  const one = questions.length === 1;
  return {
    id: pickerItemId(agentId, toolUseId),
    kind: "picker",
    version: 1,
    owner_only: !surface.supervised,
    ...surfaceFields(surface),
    agent_id: agentId,
    title: `${one ? (first.header ?? "Question") : `${questions.length} questions`} · ${whoseLabel(agentId, surface)}`,
    question: one ? first.question : questions.map((q) => q.question).join("\n"),
    ...(one
      ? { options: first.options, allow_other: true, multi: first.multiSelect === true }
      : {}),
    pointers: {},
    opened_at: openedAt,
    source: { tool_use_id: toolUseId, questions, ...surfaceSource(surface) },
  };
}

/** The item for a coordinator turn that ended on `question` (Stop hook `awaiting_input`). */
export function itemForHandoff(
  agentId: string,
  seq: number,
  question: string,
  surface: SessionSurface,
  openedAt: string,
): InboxItem {
  return {
    id: handoffItemId(agentId, seq),
    kind: "handoff",
    version: 1,
    owner_only: !surface.supervised,
    ...surfaceFields(surface),
    agent_id: agentId,
    title: `Handoff · ${whoseLabel(agentId, surface)}`,
    question,
    allow_other: true,
    pointers: {},
    opened_at: openedAt,
    source: { seq, ...surfaceSource(surface) },
  };
}

/**
 * What a `picker_answered`'s `answers` (question → answer) say, as one answer: the answer itself
 * for one question, `question → answer` lines for several. Null when there is none.
 */
export function pickerAnswerText(answers: unknown): string | null {
  if (typeof answers !== "object" || answers === null) return null;
  const entries = Object.entries(answers as Record<string, unknown>).filter(
    (e): e is [string, string] => typeof e[1] === "string" && e[1] !== "",
  );
  if (entries.length === 0) return null;
  if (entries.length === 1) return (entries[0] as [string, string])[1];
  return entries.map(([q, a]) => `${q} → ${a}`).join("\n");
}
