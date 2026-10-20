import { parseEnvelope } from "volley-mcp/envelope";
import { type ActivityEvidence, NO_EVIDENCE, ownWorkReason } from "./activity-evidence";
import { screenHash, screenTail } from "./screen-tail";
import { classifyScreen } from "./screens";
import type { TaskId } from "./types";

/**
 * The activity model of one supervised agent, from its hooks' own signals (volley-hooks): every
 * hook event publishes `progress/heartbeat`; Stop publishes `idle` (with the last message text);
 * Notification publishes `awaiting_input` (`notification_type`, `class: "credit"` for
 * `quota_auto_resume_*`); the next tool call or prompt publishes `resumed`. Pure: every function
 * takes the state and one signal, tick sample or screen read and returns the next state plus the
 * actions the daemon carries out (open a decision, steer, read the screen once, close a decision).
 *
 *   awaiting_input permission_prompt | agent_needs_input → agent_question, no screen read;
 *                                                         `resumed` closes it
 *   idle (Stop), no terminal status, no `resumed` for idle_grace_s (an `idle_prompt` confirms it
 *     sooner) → one steer "continue…"; still idle another grace later → agent_stalled; each
 *     answered agent_stalled doubles the wait for the next (capped at stall_backoff_max_s)
 *   idle while waiting on its own work (activity-evidence.ts: the hooks' `background_wait`, a
 *     lease, running shells in the footer, a fresh worktree write) → no steer, no agent_stalled
 *   awaiting_input class credit                          → credit_exhausted
 *   no hook signal for heartbeat_alarm_s while the status is `working` → read the screen:
 *     the credit prompt → credit_exhausted · changing → hooks_silent · unchanged on a second read
 *     → screen_static · unreadable → crash_candidate (alarm only: wait for the LWT, never kill)
 */

export type Activity = "working" | "idle" | "awaiting_input";

/** One hook event (a `harness-hook` progress envelope), stamped with when it was received. */
export interface HookSignal {
  type: string;
  at: number;
  seq: number | null;
  hook_event: string | null;
  payload: Record<string, unknown>;
}

/** Which liveness decision an id belongs to (one of each may be open per agent). */
export type DecisionSlot = "question" | "stalled" | "credit" | "silent";

export interface AgentLiveness {
  agent_id: string;
  task: TaskId;
  /** When supervision began: silence counts from here until the first hook signal. */
  since: number;
  last_heartbeat: { at: number; seq: number | null; hook_event: string | null } | null;
  activity: Activity;
  /** When the current activity began. */
  activity_at: number;
  /** The last Stop text. */
  last_text: string | null;
  awaiting: { notification_type: string; class?: string; text?: string } | null;
  /** An `idle_prompt` arrived for the current idle. */
  idle_confirmed: boolean;
  /** The one "continue" steer of the current idle (or the last answered `agent_stalled`). */
  steered_at: number | null;
  /** The hooks said the idle waits on the agent's own background task (SPEC §4.3). */
  background_wait: { since: number } | null;
  /** `agent_stalled` decisions opened since the agent last resumed (the backoff exponent). */
  stalls: number;
  /** Why the idle agent was last seen waiting on its own work (`ownWorkReason`), else null. */
  own_work: string | null;
  /** Open liveness decisions; `pending` until the daemon has opened it and noted its id. */
  decisions: Partial<Record<DecisionSlot, string>>;
  /** The silence probe: screen reads since the last hook signal. */
  silence: {
    phase: "probing" | "decided" | "crash_candidate";
    started_at: number;
    /** Hash of the previous probe read's tail. */
    hash: string | null;
    /** A read is in flight: the next one waits for its result. */
    reading: boolean;
  } | null;
  /** The latest screen capture (T13 publisher) and when its content last changed. */
  screen: { hash: string; changed_at: number } | null;
}

export type LivenessAction =
  | {
      kind: "agent_question";
      question: string;
      last_text: string | null;
      notification_type: string;
      transcript?: string;
    }
  | { kind: "close"; decision_id: string; answer: string }
  | { kind: "steer"; text: string }
  | {
      kind: "agent_stalled";
      idle_s: number;
      last_text: string | null;
      /** How many times this idle cycle has asked, this one included. */
      asked: number;
      /** Seconds after an answer before the next decision. */
      next_s: number;
    }
  | { kind: "credit_exhausted"; source: "hook" | "screen"; text: string | null; screen?: string }
  | { kind: "read_screen" }
  | { kind: "hooks_silent"; silent_s: number; screen: string }
  | { kind: "screen_static"; silent_s: number; screen: string }
  | { kind: "crash_candidate"; silent_s: number };

export interface Step {
  state: AgentLiveness;
  actions: LivenessAction[];
}

export interface LivenessTunables {
  idle_grace_s: number;
  heartbeat_alarm_s: number;
  background_wait_max_s: number;
  stall_backoff_max_s: number;
}

export const PENDING = "pending";

const secondsMs = (s: number) => s * 1000;

/** The steer an idle agent gets once. */
export const CONTINUE_TEXT =
  "volleyd: your turn ended but the task is not finished. Continue; publish done/blocked/failed when finished.";

const QUESTION_TYPES = new Set(["permission_prompt", "agent_needs_input"]);
/** Statuses during which an idle agent is a stall (not: blocked, which waits on purpose). */
const STALLABLE = new Set(["spawning", "registered", "working"]);

/** A `harness-hook` progress envelope as a hook signal, else null (narration, junk, a clear). */
export function parseHookSignal(raw: string, now: number): HookSignal | null {
  if (raw === "") return null;
  const env = parseEnvelope(raw);
  if (env === null || env.channel !== "progress") return null;
  const p = env.payload;
  if (typeof p !== "object" || p === null || Array.isArray(p)) return null;
  const payload = p as Record<string, unknown>;
  if (payload.source !== "harness-hook") return null;
  return {
    type: env.type,
    at: now,
    seq: typeof payload.seq === "number" ? payload.seq : null,
    hook_event: typeof payload.hook_event === "string" ? payload.hook_event : null,
    payload,
  };
}

export function trackAgent(a: { agent_id: string; task: TaskId; now: number }): AgentLiveness {
  return {
    agent_id: a.agent_id,
    task: a.task,
    since: a.now,
    last_heartbeat: null,
    activity: "working",
    activity_at: a.now,
    last_text: null,
    awaiting: null,
    idle_confirmed: false,
    steered_at: null,
    background_wait: null,
    stalls: 0,
    own_work: null,
    decisions: {},
    silence: null,
    screen: null,
  };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** Close every open decision in `slots` (pending ones are only forgotten). */
function close(s: AgentLiveness, slots: DecisionSlot[], answer: string): LivenessAction[] {
  const out: LivenessAction[] = [];
  for (const slot of slots) {
    const id = s.decisions[slot];
    if (id === undefined) continue;
    delete s.decisions[slot];
    if (id !== PENDING) out.push({ kind: "close", decision_id: id, answer });
  }
  return out;
}

/** Fold one hook signal. Every signal is a sign of life and ends a silence. */
export function observeSignal(prev: AgentLiveness, sig: HookSignal): Step {
  const s = structuredClone(prev);
  const actions: LivenessAction[] = [];
  s.last_heartbeat = { at: sig.at, seq: sig.seq, hook_event: sig.hook_event };
  s.silence = null;
  actions.push(...close(s, ["silent"], "hook signals resumed"));
  const p = sig.payload;
  const text = str(p.text);
  const backgroundWait = p.background_wait === true;

  switch (sig.type) {
    case "idle":
      s.activity = "idle";
      s.activity_at = sig.at;
      s.last_text = text ?? s.last_text;
      s.awaiting = null;
      s.idle_confirmed = false;
      s.steered_at = null;
      s.background_wait = backgroundWait ? { since: sig.at } : null;
      s.own_work = null;
      break;
    case "awaiting_input": {
      const type = str(p.notification_type) ?? "";
      if (p.class === "credit") {
        s.activity = "awaiting_input";
        s.activity_at = sig.at;
        s.awaiting = { notification_type: type, class: "credit", ...(text ? { text } : {}) };
        if (s.decisions.credit === undefined) {
          s.decisions.credit = PENDING;
          actions.push({ kind: "credit_exhausted", source: "hook", text: text ?? null });
        }
      } else if (type === "idle_prompt") {
        // Claude Code's "waiting for your input" a minute after the turn ended: the idle is real.
        // It also fires a minute into an unanswered question or credit prompt: that stays a wait.
        if (s.awaiting !== null) break;
        if (s.activity !== "idle") {
          s.activity = "idle";
          s.activity_at = sig.at;
          s.steered_at = null;
        }
        s.idle_confirmed = true;
        // Older Stop hooks omit the flag; the Notification hook carries it onto the prompt.
        if (backgroundWait && s.background_wait === null) s.background_wait = { since: sig.at };
      } else if (QUESTION_TYPES.has(type)) {
        s.activity = "awaiting_input";
        s.activity_at = sig.at;
        s.awaiting = { notification_type: type, ...(text ? { text } : {}) };
        if (s.decisions.question === undefined) {
          s.decisions.question = PENDING;
          const transcript = str(p.transcript_path);
          actions.push({
            kind: "agent_question",
            question: s.last_text ?? text ?? "(no message text)",
            last_text: s.last_text,
            notification_type: type,
            ...(transcript !== undefined ? { transcript } : {}),
          });
        }
      }
      break;
    }
    case "resumed":
      s.activity = "working";
      s.activity_at = sig.at;
      s.last_text = null; // a new turn: an earlier Stop text is not what it asks next
      s.awaiting = null;
      s.idle_confirmed = false;
      s.steered_at = null;
      s.background_wait = null;
      s.stalls = 0;
      s.own_work = null;
      actions.push(...close(s, ["question", "stalled", "credit"], "resumed: the agent went on"));
      break;
    default:
      break;
  }
  return { state: s, actions };
}

/** The wait after an answer before the next `agent_stalled`: the grace doubled per ask, capped. */
function stallDelayMs(stalls: number, t: LivenessTunables): number {
  const grace = secondsMs(t.idle_grace_s);
  const doubled = grace * 2 ** stalls;
  return Math.max(grace, Math.min(doubled, secondsMs(t.stall_backoff_max_s)));
}

/**
 * One monitor tick: idle stalls and silence. `status` is the agent's retained status type;
 * `evidence` is what the daemon sees of the agent's own work (the hooks' `background_wait` is
 * read from the state when the evidence carries none).
 */
export function checkLiveness(
  prev: AgentLiveness,
  sample: {
    now: number;
    status: string | null;
    tunables: LivenessTunables;
    evidence?: ActivityEvidence;
  },
): Step {
  const { now, status, tunables } = sample;
  if (status === null || !STALLABLE.has(status)) return { state: prev, actions: [] };
  const s = structuredClone(prev);
  const actions: LivenessAction[] = [];
  const graceMs = secondsMs(tunables.idle_grace_s);

  // An open question or credit prompt is a wait on the human: never steered or called a stall.
  const waiting = s.decisions.question !== undefined || s.decisions.credit !== undefined;
  const evidence = sample.evidence ?? NO_EVIDENCE;
  s.own_work =
    s.activity === "idle"
      ? ownWorkReason(
          { ...evidence, background_wait: evidence.background_wait ?? s.background_wait },
          now,
          tunables,
          s.activity_at,
        )
      : null;
  // Waiting on its own work (the harness wakes it when that ends): neither nudged nor a stall.
  if (s.activity === "idle" && !waiting && s.own_work === null) {
    if (s.steered_at === null) {
      if (s.idle_confirmed || now - s.activity_at >= graceMs) {
        s.steered_at = now;
        actions.push({ kind: "steer", text: CONTINUE_TEXT });
      }
    } else if (
      s.decisions.stalled === undefined &&
      now - s.steered_at >= stallDelayMs(s.stalls, tunables)
    ) {
      s.decisions.stalled = PENDING;
      s.stalls += 1;
      actions.push({
        kind: "agent_stalled",
        idle_s: Math.floor((now - s.activity_at) / 1000),
        last_text: s.last_text,
        asked: s.stalls,
        next_s: stallDelayMs(s.stalls, tunables) / 1000,
      });
    }
  }

  // Silence: only a working agent is expected to keep its hooks firing.
  if (status === "working" && s.activity === "working" && s.decisions.silent === undefined) {
    const last = s.last_heartbeat?.at ?? s.since;
    if (now - last >= secondsMs(tunables.heartbeat_alarm_s)) {
      if (s.silence === null) {
        s.silence = { phase: "probing", started_at: now, hash: null, reading: true };
        actions.push({ kind: "read_screen" });
      } else if (s.silence.phase === "probing" && !s.silence.reading) {
        s.silence.reading = true;
        actions.push({ kind: "read_screen" });
      }
    }
  }
  return { state: s, actions };
}

/** The result of a `read_screen` (null = unreadable / pane gone). */
export function observeScreen(
  prev: AgentLiveness,
  r: { now: number; screen: string | null },
): Step {
  if (prev.silence?.phase !== "probing") return { state: prev, actions: [] };
  const s = structuredClone(prev);
  const silence = s.silence as NonNullable<AgentLiveness["silence"]>;
  silence.reading = false;
  const last = s.last_heartbeat?.at ?? s.since;
  const silent_s = Math.floor((r.now - last) / 1000);
  if (r.screen === null) {
    silence.phase = "crash_candidate";
    return { state: s, actions: [{ kind: "crash_candidate", silent_s }] };
  }
  if (classifyScreen(r.screen) === "credit_exhausted") {
    silence.phase = "decided";
    if (s.decisions.credit !== undefined) return { state: s, actions: [] };
    s.decisions.credit = PENDING;
    return {
      state: s,
      actions: [{ kind: "credit_exhausted", source: "screen", text: null, screen: r.screen }],
    };
  }
  const hash = screenHash(screenTail(r.screen, Number.POSITIVE_INFINITY));
  const changing =
    (s.screen !== null && s.screen.changed_at > last) ||
    (silence.hash !== null && silence.hash !== hash);
  if (changing) {
    silence.phase = "decided";
    s.decisions.silent = PENDING;
    return { state: s, actions: [{ kind: "hooks_silent", silent_s, screen: r.screen }] };
  }
  if (silence.hash === null) {
    silence.hash = hash; // compare with the next read
    return { state: s, actions: [] };
  }
  silence.phase = "decided";
  s.decisions.silent = PENDING;
  return { state: s, actions: [{ kind: "screen_static", silent_s, screen: r.screen }] };
}

/** A screen capture by the T13 publisher: tracks when the screen last changed. */
export function noteCapture(prev: AgentLiveness, c: { hash: string; at: number }): AgentLiveness {
  if (prev.screen?.hash === c.hash) return prev;
  // The first capture is not a change: when that content appeared is unknown.
  return { ...prev, screen: { hash: c.hash, changed_at: prev.screen === null ? 0 : c.at } };
}

/** The daemon opened the decision of `slot` under `id` (or failed to: `id` null frees the slot). */
export function noteDecision(
  prev: AgentLiveness,
  slot: DecisionSlot,
  id: string | null,
): AgentLiveness {
  const decisions = { ...prev.decisions };
  if (id === null) delete decisions[slot];
  else decisions[slot] = id;
  return { ...prev, decisions };
}

/**
 * A decision was resolved (by anyone) at `now`: free its slot. An answered `agent_stalled` counts
 * as the next nudge (the answer is steered to the agent): the next decision waits
 * `idle_grace_s × 2^stalls` from here (capped), never the next tick. The ask count is kept.
 */
export function noteResolved(prev: AgentLiveness, id: string, now: number): AgentLiveness {
  const entries = Object.entries(prev.decisions).filter(([, v]) => v !== id);
  if (entries.length === Object.keys(prev.decisions).length) return prev;
  const stalled = prev.decisions.stalled === id && prev.activity === "idle";
  return {
    ...prev,
    decisions: Object.fromEntries(entries),
    ...(stalled ? { steered_at: now } : {}),
  };
}

/**
 * After a host sleep the wall clock jumped: restart every liveness clock at `at`, so the sleep
 * itself never counts as silence or idleness.
 */
export function rebase(prev: AgentLiveness, at: number): AgentLiveness {
  const s = structuredClone(prev);
  s.since = Math.max(s.since, at);
  if (s.last_heartbeat !== null) s.last_heartbeat.at = Math.max(s.last_heartbeat.at, at);
  s.activity_at = Math.max(s.activity_at, at);
  if (s.steered_at !== null) s.steered_at = Math.max(s.steered_at, at);
  if (s.silence?.phase === "probing") s.silence = null;
  return s;
}

const minutes = (ms: number) => Math.floor(ms / 60_000);
const real = (id: string | undefined) => (id !== undefined && id !== PENDING ? id : undefined);

/** The task's `why_waiting` while this agent needs attention, else undefined. */
export function whyWaiting(s: AgentLiveness, now: number): string | undefined {
  const q = real(s.decisions.question);
  if (q !== undefined) return `question pending (decision ${q})`;
  const c = real(s.decisions.credit);
  if (c !== undefined) return `stalled: credit prompt (decision ${c})`;
  const last = s.last_heartbeat?.at ?? s.since;
  if (s.decisions.silent !== undefined) return `hooks silent ${minutes(now - last)} min`;
  if (s.silence?.phase === "crash_candidate")
    return `no hook signal for ${minutes(now - last)} min, screen unreadable: waiting for the LWT`;
  const st = real(s.decisions.stalled);
  if (st !== undefined) return `stalled: idle ${minutes(now - s.activity_at)} min (decision ${st})`;
  if (s.activity === "idle" && s.own_work !== null)
    return `idle ${minutes(now - s.activity_at)} min: ${s.own_work}`;
  if (s.activity === "idle" && s.steered_at !== null)
    return `idle ${minutes(now - s.activity_at)} min: nudged to continue`;
  return undefined;
}
