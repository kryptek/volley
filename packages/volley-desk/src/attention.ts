/**
 * The Desk's attention model (pure). Every wave and agent window gets a tier:
 *
 * - **you** — the wave's coordinator is `awaiting_input` or `gone` (reaped,
 *   or silent for longer than `claim_after_s`, the same rule `volleyd claim`
 *   uses); an open decision on a wave this browser owns; a stuck agent
 *   (`blocked`, or awaiting input) with no live coordinator.
 * - **coordinator** — an open decision or a merge-ready gate on a wave with a
 *   live coordinator, or a stuck agent with one. Items left unresolved for
 *   `escalate_after_min` are promoted to **you**.
 * - **info** — notable but nobody's job yet: an open PR, a lease wait.
 * - **none** — nothing to see.
 *
 * Tunables come from the wave's `effective_config`, else the retained global
 * config, else the defaults below.
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
  Tunables,
  WaveTask,
  WaveView,
} from "./store/types";

export type Tier = "you" | "coordinator" | "info" | "none";

/** volleyd's default `claim_after_s` (30 min). */
export const DEFAULT_CLAIM_AFTER_S = 1800;
/** The prototype's default `escalate_after_min`. */
export const DEFAULT_ESCALATE_AFTER_MIN = 15;

export interface AttentionCtx {
  now: number;
  /** This browser's coordinator agent id (`?me=`). */
  me?: string | null;
  config?: ConfigPayload | null;
  coordinators?: Record<string, CoordinatorView>;
  agents?: Record<string, AgentView>;
  leases?: Record<string, LeasePoolPayload>;
  /** When this browser first saw each merge-ready gate (`<wave>/<task>` → ms); gates carry no time. */
  gateSince?: Record<string, number>;
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
  };
}

const mins = (ms: number) => Math.max(0, Math.round(ms / 60_000));

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
    ctx.now - lastSeen > tunables(w, ctx).claimMs
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
  if (first && ctx.me && s.owner === ctx.me) {
    return { tier: "you", reason: `Decision: ${first.question}` };
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
  const live = w?.state && a.wave !== UNASSIGNED ? coordinatorFor(w, ctx).state !== "gone" : false;
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
  const tasks = s?.tasks.filter((t) => t.id === task) ?? [];
  return infoFor(tasks, [a.id], ctx);
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

/** The store's parts of the attention context. */
export function ctxFrom(
  state: DeskState,
  opts: { now: number; me?: string | null; gateSince?: Record<string, number> },
): AttentionCtx {
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

/**
 * Everything at tier `you`: waves first, then agents whose wave is not already
 * listed. Its length is the top-bar pill and the dock badge count.
 */
export function needsYouTargets(
  state: DeskState,
  opts: { now: number; me?: string | null; gateSince?: Record<string, number> },
): NeedsYouTarget[] {
  const ctx = ctxFrom(state, opts);
  const waves = Object.values(state.waves)
    .filter((w) => waveAttention(w, ctx).tier === "you")
    .map((w): NeedsYouTarget => ({ kind: "wave", id: w.id, wave: w.id }));
  const listed = new Set(waves.map((t) => t.wave));
  const agents = Object.values(state.agents)
    .filter((a) => !listed.has(a.wave) && !state.coordinators[a.id])
    .filter((a) => agentAttention(a, state.waves[a.wave], ctx).tier === "you")
    .map((a): NeedsYouTarget => ({ kind: "agent", id: a.id, wave: a.wave }));
  return [...waves, ...agents];
}
