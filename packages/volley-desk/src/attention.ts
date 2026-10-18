/**
 * The Desk's attention model (pure). Every wave and agent window gets a tier:
 *
 * - **you** — the wave's coordinator is `awaiting_input` or `gone` (reaped,
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
 * **No signal**: a live (not finished, blocked or waiting) agent whose
 * registry entry is here but no status, progress or heartbeat is, or whose
 * last one is older than `no_signal_after_s` (default 120 s, read like
 * `claim_after_s`; not a SPEC §4.6.4 tunable yet). Typically its Volley MCP
 * server is connected to another broker, so it only looks idle.
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
import { UNASSIGNED } from "./store/reducer";
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

export type Tier = "you" | "coordinator" | "info" | "none";

/** volleyd's default `claim_after_s` (30 min). */
export const DEFAULT_CLAIM_AFTER_S = 1800;
/** The prototype's default `escalate_after_min`. */
export const DEFAULT_ESCALATE_AFTER_MIN = 15;
/** Silence after which a live agent has no signal (`no_signal_after_s`). */
export const DEFAULT_NO_SIGNAL_AFTER_S = 120;
export const NO_SIGNAL_LABEL = "no signal — MCP not on this broker?";

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
}

const NONE: Attn = { tier: "none" };
const ENDED = new Set(["complete", "stopped"]);
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
    noSignalMs:
      (num(local.no_signal_after_s, global.no_signal_after_s) ?? DEFAULT_NO_SIGNAL_AFTER_S) * 1000,
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
 * waiting: it is quiet because it is waiting for the owner.
 */
export function coordinatorFor(w: WaveView, ctx: AttentionCtx): EffectiveCoordinator {
  const s = w.state;
  const id = s?.owner ?? s?.coordinator?.agent_id ?? null;
  if (!id) return { id: null, state: "gone" };
  if (claimedHere(w, ctx)) return { id, state: "working" };
  const view = ctx.coordinators?.[id];
  const sup = s?.coordinator?.agent_id === id ? s.coordinator : undefined;
  const a = ctx.agents?.[id];
  const seen = [a?.lastSeen, a?.heartbeat ?? undefined, Date.parse(sup?.last_seen ?? "")].filter(
    (t): t is number => typeof t === "number" && Number.isFinite(t),
  );
  const lastSeen = seen.length ? Math.max(...seen) : undefined;
  let state: CoordinatorState = view?.state ?? sup?.state ?? "gone";
  if (
    state === "working" &&
    lastSeen !== undefined &&
    connectedSilence(lastSeen, ctx.now, ctx.offline) > tunables(w, ctx).claimMs
  ) {
    state = "gone";
  }
  const question = view?.question ?? sup?.question;
  const sessionUrl = view?.sessionUrl ?? sup?.session_url;
  const workspace = view?.workspace ?? sup?.workspace;
  return {
    id,
    state,
    ...(question ? { question } : {}),
    ...(view?.text ? { text: view.text } : {}),
    ...(sessionUrl ? { sessionUrl } : {}),
    ...(workspace ? { workspace } : {}),
    ...(lastSeen !== undefined ? { lastSeen } : {}),
  };
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
  if (!s || ENDED.has(s.status)) return NONE;
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
  const items = [
    ...decisions.map((d) => ({ reason: `Decision: ${d.question}`, since: parseTime(d.opened_at) })),
    ...s.gates.map((t) => ({ reason: gateReason(t), since: ctx.gateSince?.[`${w.id}/${t}`] })),
  ];
  const top = oldest(items);
  if (top) return handled(top.reason, top.since, w, ctx);
  const agentIds = s.tasks.flatMap((t) => Object.values(t.agents)).filter((x): x is string => !!x);
  return infoFor(s.tasks, agentIds, ctx);
}

function parseTime(t: string | undefined): number | undefined {
  const ms = Date.parse(t ?? "");
  return Number.isNaN(ms) ? undefined : ms;
}

export function agentAttention(a: AgentView, w: WaveView | undefined, ctx: AttentionCtx): Attn {
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
      : a.attention && !ENDED_STATUS.has(a.status?.type ?? "")
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
  if (ns) {
    const stage = s?.tasks.find((t) => t.id === task)?.stage;
    const theirs = live && a.role === "implementer" && stage === "implement";
    return { tier: theirs ? "coordinator" : "info", reason: ns.reason };
  }
  const tasks = s?.tasks.filter((t) => t.id === task) ?? [];
  return infoFor(tasks, [a.id], ctx);
}

/** An agent's no-signal state: the window's label and tooltip, and its attention reason. */
export interface NoSignal {
  label: string;
  /** The wave state's `why_waiting` for the agent's task when the supervisor set one, else the label. */
  reason: string;
  /** Tooltip: what is missing and where the session runs, when its registry says. */
  title: string;
}

/** The agent's no-signal state (see the module comment), or null while it has a signal. */
export function noSignalFor(
  a: AgentView,
  w: WaveView | undefined,
  ctx: AttentionCtx,
): NoSignal | null {
  const type = a.status?.type;
  if (type !== undefined && (ENDED_STATUS.has(type) || STUCK_STATUS.has(type))) return null;
  // Quiet on purpose: waiting for a human, or its turn ended (the hooks said so, on this broker).
  if (a.attention || a.lastProgress?.type === "idle") return null;
  const signals = [a.status?.at, a.heartbeat, a.lastProgress?.at].filter(
    (t): t is number => typeof t === "number" && Number.isFinite(t),
  );
  let silent: number | null = null;
  if (signals.length === 0) {
    if (!a.registered) return null;
  } else {
    silent = connectedSilence(Math.max(...signals), ctx.now, ctx.offline);
    if (silent <= tunables(w, ctx).noSignalMs) return null;
  }
  const why = a.task ? w?.state?.tasks.find((t) => t.id === a.task)?.why_waiting : undefined;
  const reg: Partial<RegistryPayload> = a.registry ?? {};
  const broker = [reg.broker_url, reg.broker].find(
    (v): v is string => typeof v === "string" && v !== "",
  );
  const head =
    silent === null
      ? `${a.id} registered here but has published no status, progress or heartbeat.`
      : `Nothing from ${a.id} for ${Math.round(silent / 1000)} s.`;
  const where = [
    broker && `its registry names ${broker}`,
    typeof reg.cwd === "string" && reg.cwd !== "" && `the session runs in ${reg.cwd}`,
  ]
    .filter(Boolean)
    .join("; ");
  const title = `${head} Its Volley MCP server may be connected to another broker${where ? ` (${where})` : ""}.`;
  return { label: NO_SIGNAL_LABEL, reason: why || NO_SIGNAL_LABEL, title };
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
