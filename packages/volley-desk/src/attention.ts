/**
 * The Desk's attention model (pure). Every wave and agent window gets a tier:
 *
 * - **you** — the wave's coordinator is `awaiting_input` (on a person: not idle
 *   with a background wait armed, see below) or `gone` (reaped,
 *   or silent for longer than `claim_after_s`, the same rule `volleyd claim`
 *   uses); an open decision on a wave this browser owns; a stuck agent
 *   (`blocked`, or awaiting input) with no live coordinator. A wave the Desk
 *   claimed (owner = the Desk's `identity`) has no coordinator session: the
 *   person here coordinates it, so its decisions, gates and stuck agents are
 *   theirs.
 * - **coordinator** — an open decision or a merge-ready gate on a wave with a
 *   live coordinator, or a stuck agent with one. Items left unresolved for
 *   `escalate_after_min` are promoted to **you**.
 * - **info** — notable but nobody's job yet: an open PR, a lease wait, an
 *   agent with no signal (below). A no-signal implementer in stage
 *   `implement` under a live coordinator is that coordinator's: **coordinator**.
 * - **none** — nothing to see.
 *
 * **No signal** (the MCP hint): a live (not finished, blocked or waiting)
 * agent whose registry entry is here but no status is, or whose task has an
 * open `mcp_not_registered` decision. Typically its Volley MCP server is
 * connected to another broker, so it only looks idle. **Quiet**: a registered
 * agent with a status whose last status, progress or heartbeat is older than
 * `quiet_after_s` (default 120 s; `no_signal_after_s` is still read; neither is
 * a SPEC §4.6.4 tunable yet) shows `quiet for Nm`, neutral: it reaches a stall
 * tier only through the wave state's `why_waiting` for its task (volleyd owns
 * stall detection).
 *
 * **Idle with a background wait**: an `awaiting_input` the hooks flagged
 * `background_wait: true` (the session ended its turn with a background task
 * armed) waits on the wave's events, not on a person: a coordinator in that
 * state is `working` and the wave is info `idle — waiting on wave events`
 * unless a decision or gate is open. A `permission_prompt` always needs you.
 *
 * **No progress reported**: a dispatched agent (not a session) that has been
 * `working` for `STALE_PROGRESS_MS` (10 min) without a `progress` message of
 * its own (its hooks' work log does not count) gets an amber badge and an info
 * item, and so does whoever runs it: its wave, else its parent session. The
 * clock starts no earlier than this page first heard of the agent, and stops
 * while its hooks say its turn ended (`idle`).
 *
 * **Ended waves** (`stopped`, `complete`) and their agents get no attention.
 * **Syncing**: during the grace window after a (re)connect or the page coming
 * back to the foreground (`AttentionCtx.syncing`), nothing is judged quiet or
 * without signal: the retained replay alone says nothing about liveness.
 *
 * `claim_after_s` comes from the wave's `effective_config`, else the retained
 * global config, else volleyd's default. `escalate_after_min` is read the same
 * way, but it is not yet a SPEC §4.6.4 tunable (nor in `config.schema.json` or
 * volleyd's defaults), so in practice it is the fixed 15 min below until it is
 * added there.
 *
 * Silence (staleness) is measured only over time this browser was connected
 * and settled: while the Desk is offline nothing can refresh `lastSeen`, so
 * offline spans (`AttentionCtx.offline`) do not count towards `claim_after_s`.
 */
import { UNASSIGNED, isEndedWave, isSession, waitsOnPerson } from "./store/reducer";
import type {
  AgentView,
  ConfigPayload,
  CoordinatorState,
  CoordinatorView,
  DecisionPayload,
  DeskState,
  LeasePoolPayload,
  RegistryPayload,
  Tunables,
  WaveTask,
  WaveView,
} from "./store/types";
import { purposeOf } from "./windows/agent/purpose";

export type Tier = "you" | "coordinator" | "info" | "none";

/** volleyd's default `claim_after_s` (30 min). */
export const DEFAULT_CLAIM_AFTER_S = 1800;
/** The prototype's default `escalate_after_min`. */
export const DEFAULT_ESCALATE_AFTER_MIN = 15;
/** Silence after which a live agent is quiet (`quiet_after_s`, formerly `no_signal_after_s`). */
export const DEFAULT_QUIET_AFTER_S = 120;
export const DEFAULT_NO_SIGNAL_AFTER_S = DEFAULT_QUIET_AFTER_S;
export const NO_SIGNAL_LABEL = "no signal — MCP not on this broker?";
/** The wave's reason while its coordinator idles with a background wait armed. */
export const IDLE_WAIT_REASON = "idle — waiting on wave events";
/** The message of Claude Code's `idle_prompt` Notification: no question, the turn just ended. */
const GENERIC_IDLE_PROMPT = /^claude is waiting for your input\.?$/i;
/** Shown instead of any liveness judgement during the reconnect / resume grace window. */
export const SYNCING_LABEL = "syncing…";
/** A dispatched agent working this long with no progress of its own is flagged. */
export const STALE_PROGRESS_MS = 10 * 60_000;

export interface AttentionCtx {
  now: number;
  /** This browser's coordinator agent id (`?me=`). */
  me?: string | null;
  /** The Desk's broker identity: a wave it owns, it claimed. */
  identity?: string | null;
  config?: ConfigPayload | null;
  coordinators?: Record<string, CoordinatorView>;
  agents?: Record<string, AgentView>;
  leases?: Record<string, LeasePoolPayload>;
  /** When this browser first saw each merge-ready gate (`<wave>/<task>` → ms); gates carry no time. */
  gateSince?: Record<string, number>;
  /** Spans the Desk was offline or still settling after a reconnect; excluded from silence. */
  offline?: readonly OfflineSpan[];
  /** The reconnect / resume grace window is open: nobody is judged quiet or without signal. */
  syncing?: boolean;
}

/** A span (ms) the Desk could not hear the broker; `to: null` while it still can't. */
export interface OfflineSpan {
  from: number;
  to: number | null;
}

/** `now - since`, minus the parts of that interval the Desk spent offline. */
export function connectedSilence(
  since: number,
  now: number,
  offline: readonly OfflineSpan[] = [],
): number {
  let away = 0;
  for (const o of offline) {
    const from = Math.max(o.from, since);
    const to = Math.min(o.to ?? now, now);
    if (to > from) away += to - from;
  }
  return Math.max(0, now - since - away);
}

export interface Attn {
  tier: Tier;
  /** One line for the window: the question, the gate, the lease… */
  reason?: string;
}

/** The wave's coordinator as the Desk should treat it, staleness applied. */
export interface EffectiveCoordinator {
  id: string | null;
  state: CoordinatorState;
  question?: string;
  text?: string;
  sessionUrl?: string;
  workspace?: string;
  /** ms of the coordinator's last sign of life, when known. */
  lastSeen?: number;
  /** Idle with a background wait armed (`state` is `working`). */
  waitingOnEvents?: boolean;
  /** `reconnecting`: ms the bound agent went away (the supervisor's `coordinator.last_seen`). */
  since?: number;
}

const NONE: Attn = { tier: "none" };
const STUCK_STATUS = new Set(["blocked"]);
/** Terminal statuses (SPEC §5.2) other than `blocked`: a leftover awaiting_input no longer counts. */
const ENDED_STATUS = new Set(["done", "failed", "reaped"]);

function num(...vs: unknown[]): number | undefined {
  return vs.find((v): v is number => typeof v === "number" && Number.isFinite(v));
}

function tunables(w: WaveView | undefined, ctx: AttentionCtx) {
  const local: Tunables = w?.state?.effective_config ?? {};
  const global: Partial<Tunables> = ctx.config ?? {};
  return {
    claimMs: (num(local.claim_after_s, global.claim_after_s) ?? DEFAULT_CLAIM_AFTER_S) * 1000,
    escalateMs:
      (num(local.escalate_after_min, global.escalate_after_min) ?? DEFAULT_ESCALATE_AFTER_MIN) *
      60_000,
    quietMs:
      (num(
        local.quiet_after_s,
        local.no_signal_after_s,
        global.quiet_after_s,
        global.no_signal_after_s,
      ) ?? DEFAULT_QUIET_AFTER_S) * 1000,
  };
}

const mins = (ms: number) => Math.max(0, Math.round(ms / 60_000));

/** The Desk claimed this wave: the person at this Desk is its coordinator. */
const claimedHere = (w: WaveView | undefined, ctx: AttentionCtx): boolean =>
  !!ctx.identity && w?.state?.owner === ctx.identity;

/**
 * The wave's coordinator: the store's view (owner topics, else the
 * supervisor's), with a `working` coordinator silent for longer than
 * `claim_after_s` counted as `gone`. An `awaiting_input` coordinator stays
 * waiting: it is quiet because it is waiting for the owner; one waiting on
 * the wave's events (a live background wait, or the generic idle prompt with
 * nothing pending for the owner) stays `working` for the same reason.
 */
export function coordinatorFor(w: WaveView, ctx: AttentionCtx): EffectiveCoordinator {
  const s = w.state;
  const id = s?.owner ?? s?.coordinator?.agent_id ?? null;
  if (!id) return { id: null, state: "gone" };
  if (claimedHere(w, ctx)) return { id, state: "working" };
  // The supervisor times the grace and flips it to gone; the Desk never does (SPEC §4.6.1).
  if (s?.coordinator?.state === "reconnecting") {
    const since = parseTime(s.coordinator.last_seen);
    return { id, state: "reconnecting", ...(since !== undefined ? { since } : {}) };
  }
  const view = ctx.coordinators?.[id];
  const sup = s?.coordinator?.agent_id === id ? s.coordinator : undefined;
  const a = ctx.agents?.[id];
  const seen = [a?.lastSeen, a?.heartbeat ?? undefined, Date.parse(sup?.last_seen ?? "")].filter(
    (t): t is number => typeof t === "number" && Number.isFinite(t),
  );
  const lastSeen = seen.length ? Math.max(...seen) : undefined;
  let state: CoordinatorState = view?.state ?? sup?.state ?? "gone";
  const question = view?.question ?? sup?.question;
  // Only the harness's generic idle prompt, and nothing pending for the owner: the turn
  // ended without a question, so the next wave event wakes it (design point ii). This is
  // what a cold load sees, since volleyd's retained `coordinator` drops `background_wait`.
  const idleOnly =
    state === "awaiting_input" &&
    a?.attention?.notificationType !== "permission_prompt" &&
    question !== undefined &&
    GENERIC_IDLE_PROMPT.test(question.trim()) &&
    openDecisions(w).length === 0 &&
    (s?.gates.length ?? 0) === 0;
  if (idleOnly) state = "working";
  const waitingOnEvents = state === "working" && (idleOnly || view?.waitingOnEvents === true);
  // Waiting on events is quiet on purpose too: only a terminal status (the LWT) ends it.
  if (
    state === "working" &&
    !waitingOnEvents &&
    lastSeen !== undefined &&
    connectedSilence(lastSeen, ctx.now, ctx.offline) > tunables(w, ctx).claimMs
  ) {
    state = "gone";
  }
  const sessionUrl = view?.sessionUrl ?? sup?.session_url;
  const workspace = view?.workspace ?? sup?.workspace;
  return {
    id,
    state,
    ...(question && !idleOnly ? { question } : {}),
    ...(view?.text && !idleOnly ? { text: view.text } : {}),
    ...(sessionUrl ? { sessionUrl } : {}),
    ...(workspace ? { workspace } : {}),
    ...(lastSeen !== undefined ? { lastSeen } : {}),
    ...(waitingOnEvents ? { waitingOnEvents: true } : {}),
  };
}

/** `Coordinator reconnecting · 3m` (just the label while the time it went away is unknown). */
export function reconnectingLabel(c: EffectiveCoordinator, now: number): string {
  return `Coordinator reconnecting${c.since === undefined ? "" : ` · ${mins(now - c.since)}m`}`;
}

export function openDecisions(w: WaveView | undefined): DecisionPayload[] {
  return Object.values(w?.decisions ?? {}).filter((d) => !d.resolved);
}

/** A coordinator-tier item, promoted to `you` once it has waited `escalate_after_min`. */
function handled(
  reason: string,
  since: number | undefined,
  w: WaveView | undefined,
  ctx: AttentionCtx,
): Attn {
  const waited = since === undefined ? 0 : ctx.now - since;
  if (since !== undefined && waited >= tunables(w, ctx).escalateMs) {
    return { tier: "you", reason: `${reason} · unresolved for ${mins(waited)} min` };
  }
  return { tier: "coordinator", reason };
}

/** The oldest of several items wins: it is the first to escalate. */
function oldest(items: { reason: string; since: number | undefined }[]) {
  return [...items].sort(
    (x, y) => (x.since ?? Number.POSITIVE_INFINITY) - (y.since ?? Number.POSITIVE_INFINITY),
  )[0];
}

function gateReason(task: string) {
  return `Merge-ready gate: ${task} is waiting on the coordinator`;
}

function infoFor(tasks: readonly WaveTask[], agentIds: readonly string[], ctx: AttentionCtx): Attn {
  for (const pool of Object.values(ctx.leases ?? {})) {
    const q = pool.queue.find((e) => agentIds.includes(e.holder));
    if (q) return { tier: "info", reason: `Waiting for a ${pool.pool} lease` };
  }
  const lease = tasks.find((t) => /lease/i.test(t.why_waiting ?? ""));
  if (lease) return { tier: "info", reason: lease.why_waiting ?? "Waiting for a lease" };
  const pr = tasks.find((t) => t.pr && t.stage !== "done" && t.stage !== "cancelled");
  if (pr?.pr) return { tier: "info", reason: `PR #${pr.pr.number} open` };
  return NONE;
}

export function waveAttention(w: WaveView, ctx: AttentionCtx): Attn {
  const s = w.state;
  if (!s || isEndedWave(w)) return NONE;
  const c = coordinatorFor(w, ctx);
  if (c.state === "awaiting_input") {
    return {
      tier: "you",
      reason: c.question ?? c.text ?? "The coordinator is waiting for your answer",
    };
  }
  if (c.state === "gone") {
    const away = c.lastSeen === undefined ? "" : ` for ${mins(ctx.now - c.lastSeen)} min`;
    return { tier: "you", reason: `No coordinator${away}` };
  }
  const decisions = openDecisions(w);
  const first = decisions[0];
  if (first && ((ctx.me && s.owner === ctx.me) || claimedHere(w, ctx))) {
    return { tier: "you", reason: `Decision: ${first.question}` };
  }
  const gate = s.gates[0];
  if (gate !== undefined && claimedHere(w, ctx)) {
    return { tier: "you", reason: `Merge-ready gate: ${gate} is waiting on you` };
  }
  // Neutral: the session is coming back; nothing to claim, decisions wait or autopilot answers.
  if (c.state === "reconnecting") return { tier: "info", reason: reconnectingLabel(c, ctx.now) };
  const items = [
    ...decisions.map((d) => ({ reason: `Decision: ${d.question}`, since: parseTime(d.opened_at) })),
    ...s.gates.map((t) => ({ reason: gateReason(t), since: ctx.gateSince?.[`${w.id}/${t}`] })),
  ];
  const top = oldest(items);
  if (top) return handled(top.reason, top.since, w, ctx);
  const agentIds = s.tasks.flatMap((t) => Object.values(t.agents)).filter((x): x is string => !!x);
  // Ahead of the coordinator's own idle wait: that is its normal state while agents work.
  for (const id of agentIds) {
    const a = ctx.agents?.[id];
    const stale = a && staleProgressFor(a, w, ctx);
    if (stale) return { tier: "info", reason: `${a.task ?? a.id}: ${stale.label}` };
  }
  if (c.waitingOnEvents) return { tier: "info", reason: IDLE_WAIT_REASON };
  return infoFor(s.tasks, agentIds, ctx);
}

/** volleyd holds the task for CI (S7 sets `why_waiting: "CI pending on <sha> (n/m checks)"`). */
export function ciPending(t: WaveTask): boolean {
  return /^CI pending\b/i.test(t.why_waiting ?? "");
}

/** A `why_waiting` that is a pipeline hold (CI pending, a lease), never a stall. */
function isHoldReason(why: string): boolean {
  return /^CI pending\b/i.test(why) || /lease/i.test(why);
}

function parseTime(t: string | undefined): number | undefined {
  const ms = Date.parse(t ?? "");
  return Number.isNaN(ms) ? undefined : ms;
}

export function agentAttention(a: AgentView, w: WaveView | undefined, ctx: AttentionCtx): Attn {
  if (isEndedWave(w)) return NONE;
  // Nobody but the person here handles a wave the Desk claimed.
  const live =
    w?.state && a.wave !== UNASSIGNED && !claimedHere(w, ctx)
      ? coordinatorFor(w, ctx).state !== "gone"
      : false;
  const mine = !!ctx.me && w?.state?.owner === ctx.me;
  // Stuck: a blocked status, or an outstanding awaiting_input from a still-running agent's hooks.
  const stuck =
    a.status && STUCK_STATUS.has(a.status.type)
      ? { reason: blockReason(a.status.payload), since: a.status.at }
      : a.attention && waitsOnPerson(a.attention) && !ENDED_STATUS.has(a.status?.type ?? "")
        ? {
            reason: `Waiting for input${a.attention.question ? `: ${a.attention.question}` : ""}`,
            since: a.attention.at,
          }
        : undefined;
  if (stuck)
    return live
      ? handled(stuck.reason, stuck.since, w, ctx)
      : { tier: "you", reason: stuck.reason };
  const task = a.task;
  const s = w?.state;
  if (task && s) {
    const d = openDecisions(w).find((x) => x.task === task);
    if (d) {
      const reason = `Decision: ${d.question}`;
      return live && !mine
        ? handled(reason, parseTime(d.opened_at), w, ctx)
        : { tier: "you", reason };
    }
    if (s.gates.includes(task)) {
      const reason = gateReason(task);
      return live
        ? handled(reason, ctx.gateSince?.[`${w.id}/${task}`], w, ctx)
        : { tier: "you", reason };
    }
  }
  const ns = noSignalFor(a, w, ctx);
  // Quiet is neutral: only the supervisor's why_waiting makes it somebody's job, and not
  // a hold (CI, a lease): the agent is quiet because the pipeline waits, not stalled.
  if (ns && (ns.kind === "mcp" || (ns.reason !== ns.label && !isHoldReason(ns.reason)))) {
    const stage = s?.tasks.find((t) => t.id === task)?.stage;
    const theirs = live && a.role === "implementer" && stage === "implement";
    return theirs ? handled(ns.reason, ns.since, w, ctx) : { tier: "info", reason: ns.reason };
  }
  const stale = staleProgressFor(a, w, ctx);
  if (stale) return { tier: "info", reason: stale.label };
  // Whoever launched an ad-hoc agent hears about it going silent (a wave hears through its window).
  for (const child of Object.values(ctx.agents ?? {})) {
    if (child.parentId !== a.id || child.wave !== UNASSIGNED) continue;
    const s2 = staleProgressFor(child, undefined, ctx);
    if (s2) return { tier: "info", reason: `${purposeOf(child, undefined).label}: ${s2.label}` };
  }
  const tasks = s?.tasks.filter((t) => t.id === task) ?? [];
  return infoFor(tasks, [a.id], ctx);
}

/**
 * A dispatched agent `working` for `STALE_PROGRESS_MS` with no `progress` of its own
 * (`reportedAt`; else since it went `working`; never before `observedAt`), over connected
 * time: the badge text. Null for a session, an agent not working, waiting on a person or
 * idle by its hooks, an ended wave, or while the Desk is syncing.
 */
export function staleProgressFor(
  a: AgentView,
  w: WaveView | undefined,
  ctx: AttentionCtx,
): { label: string; since: number } | null {
  if (ctx.syncing || isEndedWave(w) || isSession(a)) return null;
  if (a.status?.type !== "working" || a.attention) return null;
  // Its turn ended (the hooks said so): quiet on purpose, like `noSignalFor`.
  if (a.lastProgress?.type === "idle" || a.work?.state === "idle") return null;
  // Never time before this page could see the agent: a cold load replays only retained
  // timestamps, and progress (not retained) has had no chance to arrive.
  const since = Math.max(a.reportedAt ?? a.status.seenAt ?? a.status.at, a.observedAt ?? 0);
  if (!Number.isFinite(since)) return null;
  const silent = connectedSilence(since, ctx.now, ctx.offline);
  if (silent < STALE_PROGRESS_MS) return null;
  return {
    label: `no progress reported for ${Math.floor(silent / 60_000)} m`,
    since: since + STALE_PROGRESS_MS,
  };
}

/** An agent's no-signal or quiet state: the window's label and tooltip, and its attention reason. */
export interface NoSignal {
  /** `mcp`: no MCP registration on this broker (the hint); `quiet`: registered, silent a while. */
  kind: "mcp" | "quiet";
  label: string;
  /** The wave state's `why_waiting` for the agent's task when the supervisor set one, else the label. */
  reason: string;
  /** Tooltip: what is missing and where the session runs, when its registry says. */
  title: string;
  /** ms the item began: for `quiet`, the last signal plus `quiet_after_s`; for `mcp`, its registration. */
  since: number;
}

/** `2m`, `1.5h`: how long an agent has been quiet. */
function quietFor(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? `${m}m` : `${(ms / 3_600_000).toFixed(1)}h`;
}

/** volleyd found the agent's hooks but not its MCP server: an open `mcp_not_registered` decision for its task. */
function mcpNotRegistered(a: AgentView, w: WaveView | undefined): boolean {
  return openDecisions(w).some(
    (d) =>
      // volleyd's decision id hashes the agent id, so the task is the only key to match on.
      d.kind === "mcp_not_registered" && a.task !== null && d.task === a.task,
  );
}

/**
 * The agent's no-signal (`mcp`) or `quiet` state (see the module comment), or
 * null while it has a signal, has ended, waits on purpose, or the Desk is
 * still syncing.
 */
export function noSignalFor(
  a: AgentView,
  w: WaveView | undefined,
  ctx: AttentionCtx,
): NoSignal | null {
  if (ctx.syncing || isEndedWave(w)) return null;
  const type = a.status?.type;
  if (type !== undefined && (ENDED_STATUS.has(type) || STUCK_STATUS.has(type))) return null;
  // Quiet on purpose: waiting for a human, or its turn ended (the hooks said so, on this broker).
  if (a.attention || a.lastProgress?.type === "idle") return null;
  // Local receipt for live messages: a sender's skewed clock must not read as silence.
  const signals = [a.status?.seenAt ?? a.status?.at, a.heartbeat, a.lastProgress?.at].filter(
    (t): t is number => typeof t === "number" && Number.isFinite(t),
  );
  const reg: Partial<RegistryPayload> = a.registry ?? {};
  const why = a.task ? w?.state?.tasks.find((t) => t.id === a.task)?.why_waiting : undefined;
  const silent = signals.length
    ? connectedSilence(Math.max(...signals), ctx.now, ctx.offline)
    : null;
  if (a.registered && (a.status === null || mcpNotRegistered(a, w))) {
    // Timed from its registration: the hint is about a missing MCP registration, not
    // silence, and the hooks' heartbeats (on this broker) do not make it any less missing.
    const since = parseTime(reg.started_at) ?? a.lastSeen;
    const head =
      a.status === null
        ? `${a.id} registered here but has published no status.`
        : `volleyd found ${a.id}'s hooks but not its Volley MCP server.`;
    const where =
      typeof reg.cwd === "string" && reg.cwd !== "" ? ` (the session runs in ${reg.cwd})` : "";
    const title = `${head} Its Volley MCP server may be connected to another broker${where}.`;
    return { kind: "mcp", label: NO_SIGNAL_LABEL, reason: why || NO_SIGNAL_LABEL, title, since };
  }
  if (silent === null) return null;
  const limit = tunables(w, ctx).quietMs;
  if (silent <= limit) return null;
  const label = `quiet for ${quietFor(silent)}`;
  return {
    kind: "quiet",
    label,
    reason: why || label,
    title: `Nothing from ${a.id} for ${Math.round(silent / 1000)} s: no status, progress or heartbeat.`,
    since: ctx.now - (silent - limit),
  };
}

/** `Blocked: <reason>` from the status payload, without doubling a leading "Blocked". */
function blockReason(payload: unknown): string {
  const p =
    payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const r = [p.reason, p.msg].find((v): v is string => typeof v === "string" && v !== "");
  if (!r) return "Blocked";
  return /^blocked\b/i.test(r) ? r : `Blocked: ${r}`;
}

export function tierFor(wave: WaveView, ctx: AttentionCtx): Tier;
export function tierFor(agent: AgentView, wave: WaveView | undefined, ctx: AttentionCtx): Tier;
export function tierFor(
  x: WaveView | AgentView,
  y: WaveView | AttentionCtx | undefined,
  z?: AttentionCtx,
): Tier {
  if (z) return agentAttention(x as AgentView, y as WaveView | undefined, z).tier;
  return waveAttention(x as WaveView, y as AttentionCtx).tier;
}

export interface CtxOpts {
  now: number;
  me?: string | null;
  identity?: string | null;
  gateSince?: Record<string, number>;
  offline?: readonly OfflineSpan[];
  syncing?: boolean;
}

/** The store's parts of the attention context. */
export function ctxFrom(state: DeskState, opts: CtxOpts): AttentionCtx {
  return {
    ...opts,
    config: state.config,
    coordinators: state.coordinators,
    agents: state.agents,
    leases: state.leases,
  };
}

export interface NeedsYouTarget {
  kind: "wave" | "agent";
  id: string;
  wave: string;
}

/** Tiers already computed by the caller, so `needsYouTargets` need not recompute them. */
export interface ComputedAttention {
  waves: Record<string, Attn>;
  agents: Record<string, Attn>;
}

/**
 * Everything at tier `you`: waves first, then agents whose wave is not already
 * listed. Its length is the top-bar pill and the dock badge count.
 */
export function needsYouTargets(
  state: DeskState,
  opts: CtxOpts,
  computed?: ComputedAttention,
): NeedsYouTarget[] {
  const ctx = ctxFrom(state, opts);
  const waveTier = (w: WaveView) => (computed?.waves[w.id] ?? waveAttention(w, ctx)).tier;
  const agentTier = (a: AgentView) =>
    (computed?.agents[a.id] ?? agentAttention(a, state.waves[a.wave], ctx)).tier;
  const waves = Object.values(state.waves)
    .filter((w) => waveTier(w) === "you")
    .map((w): NeedsYouTarget => ({ kind: "wave", id: w.id, wave: w.id }));
  const listed = new Set(waves.map((t) => t.wave));
  const agents = Object.values(state.agents)
    .filter((a) => !listed.has(a.wave) && !state.coordinators[a.id])
    .filter((a) => agentTier(a) === "you")
    .map((a): NeedsYouTarget => ({ kind: "agent", id: a.id, wave: a.wave }));
  return [...waves, ...agents];
}
