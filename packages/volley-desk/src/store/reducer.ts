/**
 * Pure Desk reducer: folds Volley MQTT deliveries into
 * `{ waves, agents, coordinators, supervisors, config, leases, admission }`.
 *
 * Agents are keyed by the topic's `<agent_id>` segment, not the envelope's
 * `agent_id`: a mailbox envelope names its sender and a screen envelope names
 * the supervisor that captured it (SPEC §4.6.6). A cleared retained topic
 * (`envelope: null`) removes what that topic held.
 *
 * Retained replays (`retained: true`, on page load and after every reconnect)
 * are not news: their times come from the envelope, not local receipt, and a
 * replay of an envelope already in an agent's feed is not appended again.
 * After a reconnect the store calls `resync` first, so topics cleared while
 * the Desk was offline do not linger.
 *
 * A supervisor (`volleyd`: registry capability `supervisor`, or an id matching
 * `^volleyd(-|$)`) is health, not an agent: it goes into `supervisors` and
 * never gets an agent window. volleyd's control channel — a mailbox `query`
 * with `payload.op` and the daemon's `ack` echoing it — is kept out of every
 * agent's feed.
 */
import {
  type AgentView,
  type ConfigPayload,
  type CoordinatorView,
  type DecisionPayload,
  type DeskMessage,
  type DeskState,
  type Envelope,
  type LeasePoolPayload,
  ROLES,
  type Receipts,
  type RegistryPayload,
  type Role,
  type ScreenPayload,
  type SteeringReceipts,
  type SupervisorView,
  type WaveStatePayload,
  type WaveView,
} from "./types";

/** Pseudo-wave for agents no wave state references (legacy dispatches, ad-hoc agents). */
export const UNASSIGNED = "unassigned";

/** Per-agent feed ring size. */
export const FEED_LIMIT = 200;

const AGENT_CHANNELS = ["status", "progress", "result", "mailbox", "screen"] as const;
type AgentChannel = (typeof AGENT_CHANNELS)[number];

const TERMINAL_STATUS = new Set(["done", "failed", "reaped"]);

/** volleyd's agent id, and the ids of its control clients (`volleyd-cli-<suffix>`). */
const SUPERVISOR_ID = /^volleyd(-|$)/;

/** A supervisor by its id alone (`volleyd`, `volleyd-<suffix>`). */
export function isSupervisorId(id: string): boolean {
  return SUPERVISOR_ID.test(id);
}

/** Order agents within a wave the way the prototype stacks them. */
const ROLE_ORDER: readonly Role[] = [
  "implementer",
  "fixup",
  "rebase",
  "spec_reviewer",
  "quality_reviewer",
];

export type Route =
  | { kind: "registry"; agentId: string }
  | { kind: "agent"; namespace: string; agentId: string; channel: AgentChannel }
  | { kind: "wave"; wave: string }
  | { kind: "decision"; wave: string; decisionId: string }
  | { kind: "config" }
  | { kind: "lease"; pool: string }
  | { kind: "admission" };

/** Map a topic to what it updates, or `null` for anything outside the Desk's subscriptions. */
export function routeTopic(topic: string): Route | null {
  const p = topic.split("/");
  if (p[0] !== "volley" || p.some((s) => s === "")) return null;
  const [, a, b, c, d] = p;
  if (a === "_system") {
    if (p.length === 4 && b === "registry" && c) return { kind: "registry", agentId: c };
    if (p.length === 4 && b === "leases" && c) return { kind: "lease", pool: c };
    if (p.length === 3 && b === "admission") return { kind: "admission" };
    return null;
  }
  if (a === "_waves") {
    if (p.length === 3 && b === "_config") return { kind: "config" };
    if (p.length === 4 && b && c === "state") return { kind: "wave", wave: b };
    if (p.length === 5 && b && c === "decisions" && d) {
      return { kind: "decision", wave: b, decisionId: d };
    }
    return null;
  }
  if (p.length === 4 && a && b && !a.startsWith("_")) {
    const channel = AGENT_CHANNELS.find((ch) => ch === c);
    if (channel) return { kind: "agent", namespace: a, agentId: b, channel };
  }
  return null;
}

export function initialState(): DeskState {
  return {
    waves: {},
    agents: {},
    coordinators: {},
    supervisors: {},
    config: null,
    leases: {},
    admission: null,
  };
}

export function reduceAll(state: DeskState, msgs: readonly DeskMessage[]): DeskState {
  return msgs.reduce(reduce, state);
}

export function reduce(state: DeskState, m: DeskMessage): DeskState {
  const route = routeTopic(m.topic);
  if (route === null) return state;
  switch (route.kind) {
    case "registry":
      if (isSupervisor(state, route.agentId, m.envelope)) {
        return withCoordinators(reduceSupervisor(state, route.agentId, "registry", null, m));
      }
      return withCoordinators(reduceRegistry(state, route.agentId, m));
    case "agent": {
      const s = withReceipts(state, route, m);
      if (isSupervisor(s, route.agentId, null)) {
        return reduceSupervisor(s, route.agentId, route.channel, route.namespace, m);
      }
      if (route.channel === "mailbox" && m.envelope && isControlTraffic(m.envelope)) return s;
      return ownsNoAgent(s, route, m) ? s : withCoordinators(reduceAgent(s, route, m));
    }
    case "wave":
      return withCoordinators(reduceWave(state, route.wave, m));
    case "decision":
      return reduceDecision(state, route.wave, route.decisionId, m);
    case "config":
      return { ...state, config: (m.envelope?.payload as ConfigPayload | undefined) ?? null };
    case "lease": {
      const leases = { ...state.leases };
      if (m.envelope) leases[route.pool] = m.envelope.payload as LeasePoolPayload;
      else delete leases[route.pool];
      return { ...state, leases };
    }
    case "admission":
      return {
        ...state,
        admission: (m.envelope?.payload as Record<string, unknown> | undefined) ?? null,
      };
  }
}

// ------------------------------------------------------------------ resync

/**
 * Forget everything that retained topics hold, ahead of the replay that
 * follows a reconnect: waves (with their decisions), supervisors, config,
 * leases, admission, and each agent's registry, status and screen. Live-only parts —
 * feed, narration, progress, heartbeat, attention — are kept. Agents that were
 * registered become `unconfirmed` until their registry entry is replayed.
 */
export function resync(state: DeskState): DeskState {
  const agents: Record<string, AgentView> = {};
  const unconfirmed = new Set(state.unconfirmed ?? []);
  for (const a of Object.values(state.agents)) {
    if (a.registered) unconfirmed.add(a.id);
    agents[a.id] = {
      ...a,
      wave: UNASSIGNED,
      task: null,
      role: null,
      registered: false,
      registry: null,
      status: null,
      screen: null,
    };
  }
  return {
    ...state,
    waves: {},
    agents,
    coordinators: {},
    supervisors: {},
    config: null,
    leases: {},
    admission: null,
    unconfirmed: [...unconfirmed],
  };
}

/** Drop agents still `unconfirmed` once the post-reconnect replay has settled. */
export function pruneUnconfirmed(state: DeskState): DeskState {
  if (state.unconfirmed === undefined) return state;
  const { unconfirmed, ...rest } = state;
  const agents = { ...state.agents };
  for (const id of unconfirmed) {
    if (agents[id] && !agents[id].registered) delete agents[id];
  }
  return withCoordinators({ ...rest, agents });
}

// ------------------------------------------------------------------ agents

function newAgent(id: string, waves: Record<string, WaveView>, at: number): AgentView {
  const where = findAssignment(waves, id);
  return {
    id,
    namespace: null,
    parentId: null,
    wave: where?.wave ?? UNASSIGNED,
    task: where?.task ?? null,
    role: where?.role ?? null,
    registered: false,
    registry: null,
    model: null,
    status: null,
    progress: null,
    narration: null,
    heartbeat: null,
    lastSeen: at,
    attention: null,
    attentionObserved: false,
    feed: [],
    screen: null,
    bornAt: null,
  };
}

function pushFeed(a: AgentView, topic: string, envelope: Envelope, receivedAt: number) {
  const feed = [...a.feed, { topic, envelope, receivedAt }];
  return feed.length > FEED_LIMIT ? feed.slice(feed.length - FEED_LIMIT) : feed;
}

/** A retained replay of an envelope the agent's feed already holds. */
function isReplay(a: AgentView | undefined, m: DeskMessage, env: Envelope): boolean {
  return (
    m.retained === true &&
    a !== undefined &&
    a.feed.some(
      (f) =>
        f.topic === m.topic &&
        f.envelope.type === env.type &&
        f.envelope.wall_time === env.wall_time,
    )
  );
}

function envTime(env: Envelope, fallback: number): number {
  const t = Date.parse(env.wall_time ?? "");
  return Number.isNaN(t) ? fallback : t;
}

/** When a delivery was current: receipt for a live publish, `wall_time` for a retained replay. */
function seenAt(m: DeskMessage, env: Envelope): number {
  return m.retained ? envTime(env, m.receivedAt) : m.receivedAt;
}

/** `lastSeen` never moves backwards (a replay can be older than live traffic). */
function touch(prev: AgentView, at: number): number {
  return Math.max(prev.lastSeen, at);
}

function record(payload: unknown): Record<string, unknown> {
  return payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : {};
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function reduceRegistry(state: DeskState, id: string, m: DeskMessage): DeskState {
  const agents = { ...state.agents };
  const env = m.envelope;
  if (env === null) {
    if (!agents[id]) return state;
    delete agents[id];
    return { ...state, agents };
  }
  const at = seenAt(m, env);
  const existing = agents[id];
  const replay = isReplay(existing, m, env);
  const prev = existing ?? newAgent(id, state.waves, at);
  const registry = record(env.payload) as RegistryPayload;
  const started = Date.parse(registry.started_at ?? "");
  agents[id] = {
    ...prev,
    namespace: str(env.namespace) ?? prev.namespace,
    parentId: env.parent_id ?? prev.parentId,
    registered: true,
    registry,
    model: str(registry.model) ?? prev.model,
    lastSeen: replay ? prev.lastSeen : touch(prev, at),
    bornAt: prev.bornAt ?? (m.retained && !Number.isNaN(started) ? started : at),
    feed: replay ? prev.feed : pushFeed(prev, m.topic, env, m.receivedAt),
  };
  const unconfirmed = state.unconfirmed?.filter((u) => u !== id);
  return { ...state, agents, ...optional("unconfirmed", unconfirmed) };
}

function reduceAgent(
  state: DeskState,
  route: Extract<ReturnType<typeof routeTopic>, { kind: "agent" }>,
  m: DeskMessage,
): DeskState {
  const { agentId: id, channel } = route;
  const env = m.envelope;
  const existing = state.agents[id];
  if (env === null) {
    if (!existing) return state;
    if (channel === "screen") return putAgent(state, { ...existing, screen: null });
    if (channel === "status") return putAgent(state, { ...existing, status: null });
    return state;
  }
  const at = seenAt(m, env);
  const replay = isReplay(existing, m, env);
  const prev = existing ?? newAgent(id, state.waves, at);
  // mailbox and screen envelopes name another agent (sender / supervisor), not this one's parent.
  const foreign = channel === "mailbox" || channel === "screen";
  const base: AgentView = {
    ...prev,
    namespace: prev.namespace ?? route.namespace,
    parentId: prev.parentId ?? (foreign ? null : (env.parent_id ?? null)),
  };
  if (channel === "screen") {
    return putAgent(state, {
      ...base,
      screen: env.payload as ScreenPayload,
      lastSeen: touch(prev, at),
    });
  }
  const next: AgentView = {
    ...base,
    feed: replay ? prev.feed : pushFeed(prev, m.topic, env, m.receivedAt),
  };
  if (channel === "mailbox" || channel === "result") {
    if (channel === "result" && !replay) next.lastSeen = touch(prev, at);
    return putAgent(state, next);
  }
  const payload = record(env.payload);
  if (!replay) next.lastSeen = touch(prev, at);
  if (channel === "progress" && !replay && at >= (prev.lastProgress?.at ?? at)) {
    next.lastProgress = { type: env.type, at };
  }
  const narration = str(payload.msg);
  if (narration !== undefined) next.narration = narration;
  if (typeof payload.progress === "number") next.progress = payload.progress;
  if (channel === "status") {
    next.status = { type: env.type, payload: env.payload, at: envTime(env, m.receivedAt) };
    return putAgent(state, next);
  }
  // progress: hook activity events (SPEC §4.3)
  // Heartbeats are never retained; local receipt avoids cross-machine clock skew.
  if (env.type === "heartbeat") next.heartbeat = at;
  if (env.type === "awaiting_input") {
    next.attentionObserved = true;
    next.attention = {
      state: "awaiting_input",
      at: envTime(env, m.receivedAt),
      ...optional("text", str(payload.text)),
      ...optional("question", str(payload.question)),
      ...optional("sessionUrl", str(payload.session_url)),
      ...optional("workspace", str(payload.workspace)),
    };
  }
  if (env.type === "resumed") {
    next.attentionObserved = true;
    next.attention = null;
  }
  return putAgent(state, next);
}

// ------------------------------------------------------------- supervisors

/** Supervisor statuses that mean it is running (volleyd's `LIVE_STATUS`). */
const LIVE_SUPERVISOR = new Set(["spawning", "registered", "working"]);

/** A known supervisor, one by its id, or a registry entry declaring capability `supervisor`. */
function isSupervisor(state: DeskState, id: string, registry: Envelope | null): boolean {
  if (isSupervisorId(id) || state.supervisors?.[id]) return true;
  const caps = record(registry?.payload).capabilities;
  return Array.isArray(caps) && caps.includes("supervisor");
}

/**
 * volleyd's control channel: a mailbox `query` carrying `payload.op`, or the
 * daemon's `ack` to one (it echoes `acked_type: "query"` and the op).
 */
export function isControlTraffic(env: Envelope): boolean {
  const p = record(env.payload);
  if (typeof p.op !== "string") return false;
  return env.type === "query" || (env.type === "ack" && p.acked_type === "query");
}

/**
 * A supervisor's registry, status and progress update its health; its
 * mailbox, results and screens are not news about it. An agent window made
 * before its registry entry said it was a supervisor is folded in and dropped.
 */
function reduceSupervisor(
  state: DeskState,
  id: string,
  channel: AgentChannel | "registry",
  namespace: string | null,
  m: DeskMessage,
): DeskState {
  const env = m.envelope;
  const supervisors = { ...state.supervisors };
  const prev = supervisors[id];
  const stray = state.agents[id];
  const agents = { ...state.agents };
  delete agents[id];
  if (channel === "registry" && env === null) {
    if (!prev && !stray) return state;
    delete supervisors[id];
    return { ...state, supervisors, agents };
  }
  if (channel !== "registry" && channel !== "status" && channel !== "progress") return state;
  if (env === null) {
    if (!prev || channel !== "status") return state;
    supervisors[id] = { ...prev, status: null };
    return { ...state, supervisors };
  }
  const at = seenAt(m, env);
  const base: SupervisorView = prev ?? {
    id,
    namespace: stray?.namespace ?? null,
    registry: null,
    status: stray?.status?.type ?? null,
    lastHeartbeat: stray?.lastSeen ?? null,
    wavesOwned: null,
  };
  const payload = record(env.payload);
  const next: SupervisorView = {
    ...base,
    namespace: str(env.namespace) ?? base.namespace ?? namespace,
    lastHeartbeat: Math.max(base.lastHeartbeat ?? at, at),
  };
  const version = str(payload.version);
  if (version !== undefined) next.version = version;
  if (channel === "registry") next.registry = payload as RegistryPayload;
  if (channel === "status") {
    next.status = env.type;
    if (typeof payload.waves === "number") next.wavesOwned = payload.waves;
  }
  supervisors[id] = next;
  return { ...state, supervisors, agents };
}

/** A supervisor's health for the top-bar pill and the coordinators row. */
export interface SupervisorHealth {
  /** Not running: reaped, stopped, failed, no status, or no supervisor at all. */
  down: boolean;
  /** Its status type, `no status`, or `absent`. */
  label: string;
  /** ms of its last sign of life, when known. */
  since: number | null;
}

export function supervisorHealth(s: SupervisorView | undefined): SupervisorHealth {
  if (!s) return { down: true, label: "absent", since: null };
  return {
    down: s.status === null || !LIVE_SUPERVISOR.has(s.status),
    label: s.status ?? "no status",
    since: s.lastHeartbeat,
  };
}

/** The supervisors, volleyd first. */
export function supervisorList(state: DeskState): SupervisorView[] {
  return Object.values(state.supervisors ?? {}).sort(
    (a, b) => Number(b.id === "volleyd") - Number(a.id === "volleyd") || a.id.localeCompare(b.id),
  );
}

/** The namespace volleyd's control mailbox lives in: its registry's, else `default`. */
export function supervisorNamespace(state: DeskState, id = "volleyd"): string {
  return state.supervisors?.[id]?.namespace ?? "default";
}

// ---------------------------------------------------------------- receipts

/** Message ids kept per receipt kind; the oldest are dropped first. */
export const RECEIPT_LIMIT = 500;

type AgentRoute = Extract<Route, { kind: "agent" }>;

/**
 * Delivery receipts (D4): a mailbox `ack` (SPEC §4.4) or any other mailbox
 * message correlated to an earlier one (a reply), both only on the Desk's own
 * mailbox (answers go to the sender's mailbox) and never the Desk's own echo;
 * and a `progress` `steering_acked` (§4.3) on the recipient's own topic. Each
 * is keyed by the message id and the answering agent. Neither channel is
 * retained, so local receipt time is the time. Live `resumed` / `working`
 * signals (a coordinator working again) are kept per agent; a retained replay
 * after a reconnect is not a signal.
 */
function withReceipts(state: DeskState, route: AgentRoute, m: DeskMessage): DeskState {
  const env = m.envelope;
  if (!env) return state;
  if (
    m.retained !== true &&
    ((route.channel === "progress" && env.type === "resumed") ||
      (route.channel === "status" && env.type === "working"))
  ) {
    const prev = state.steering ?? emptyReceipts();
    return {
      ...state,
      steering: { ...prev, signals: { ...prev.signals, [route.agentId]: m.receivedAt } },
    };
  }
  const id = str(env.correlation_id);
  if (id === undefined) return state;
  if (route.channel === "mailbox") {
    if (state.self === undefined || route.agentId !== state.self || env.agent_id === state.self)
      return state;
    const kind = env.type === "ack" ? "acks" : "replies";
    return addReceipt(state, kind, id, env.agent_id, m.receivedAt);
  }
  if (route.channel === "progress" && env.type === "steering_acked") {
    return addReceipt(state, "applied", id, route.agentId, m.receivedAt);
  }
  return state;
}

const emptyReceipts = (): SteeringReceipts => ({ acks: {}, applied: {}, replies: {}, signals: {} });

function addReceipt(
  state: DeskState,
  kind: "acks" | "applied" | "replies",
  id: string,
  by: string,
  at: number,
): DeskState {
  const prev = state.steering ?? emptyReceipts();
  const map: Receipts = { ...prev[kind], [id]: { ...prev[kind][id], [by]: at } };
  const ids = Object.keys(map);
  if (ids.length > RECEIPT_LIMIT) delete map[ids[0] as string];
  return { ...state, steering: { ...prev, [kind]: map } };
}

/**
 * Mailbox traffic that is not an agent: the Desk's own mailbox (answers to
 * what it sent), and an ack to an unknown recipient — an ack goes to a
 * message's sender, which is often a CLI, the daemon or the Desk.
 */
function ownsNoAgent(state: DeskState, route: AgentRoute, m: DeskMessage): boolean {
  if (route.channel !== "mailbox" || !m.envelope) return false;
  if (route.agentId === state.self) return true;
  return m.envelope.type === "ack" && !state.agents[route.agentId];
}

function putAgent(state: DeskState, a: AgentView): DeskState {
  return { ...state, agents: { ...state.agents, [a.id]: a } };
}

/** `{ key: value }` when value is defined, `{}` otherwise (exactOptionalPropertyTypes). */
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}

// ------------------------------------------------------------------- waves

function findAssignment(
  waves: Record<string, WaveView>,
  agentId: string,
): { wave: string; task: string; role: Role } | null {
  for (const w of Object.values(waves)) {
    for (const t of w.state?.tasks ?? []) {
      for (const role of ROLES) {
        if (t.agents[role] === agentId) return { wave: w.id, task: t.id, role };
      }
    }
  }
  return null;
}

function reduceWave(state: DeskState, id: string, m: DeskMessage): DeskState {
  const waves = { ...state.waves };
  if (m.envelope === null) {
    if (!waves[id]) return state;
    delete waves[id];
    const agents: Record<string, AgentView> = {};
    for (const a of Object.values(state.agents)) {
      agents[a.id] = a.wave === id ? { ...a, wave: UNASSIGNED, task: null, role: null } : a;
    }
    return { ...state, waves, agents };
  }
  const payload = m.envelope.payload as WaveStatePayload;
  waves[id] = { id, decisions: {}, ...waves[id], state: payload, receivedAt: m.receivedAt };
  // Sticky: an agent keeps its wave after the task's role slot moves on to a new agent.
  const agents: Record<string, AgentView> = {};
  for (const a of Object.values(state.agents)) {
    const where = findAssignment({ [id]: waves[id] }, a.id);
    agents[a.id] = where ? { ...a, ...where } : a;
  }
  return { ...state, waves, agents };
}

function reduceDecision(state: DeskState, wave: string, id: string, m: DeskMessage): DeskState {
  const prev = state.waves[wave];
  if (m.envelope === null && !prev?.decisions[id]) return state;
  const w: WaveView = prev ?? { id: wave, state: null, decisions: {}, receivedAt: m.receivedAt };
  const decisions = { ...w.decisions };
  if (m.envelope) decisions[id] = m.envelope.payload as DecisionPayload;
  else delete decisions[id];
  return { ...state, waves: { ...state.waves, [wave]: { ...w, decisions } } };
}

// ------------------------------------------------------------- coordinators

/**
 * Coordinator state per wave owner. A wave the Desk itself owns (it claimed
 * it, so the owner is `state.self`) is coordinated by the person at this Desk:
 * `working`. Otherwise the owner's own topics win when they say
 * something (a terminal status → `gone`, an outstanding `awaiting_input`, or
 * a `resumed`); otherwise the supervisor's `coordinator` view from the wave
 * state is used; otherwise a known agent is `working` and an unseen one `gone`.
 */
function withCoordinators(state: DeskState): DeskState {
  const coordinators: Record<string, CoordinatorView> = {};
  for (const w of Object.values(state.waves)) {
    const s = w.state;
    const id = s?.owner ?? s?.coordinator?.agent_id;
    if (!s || !id) continue;
    const seen = coordinators[id];
    if (seen) {
      seen.waves.push(w.id);
      continue;
    }
    const sup = s.coordinator?.agent_id === id ? s.coordinator : undefined;
    const a = state.agents[id];
    const sessionUrl = str(a?.registry?.session_url) ?? sup?.session_url;
    const workspace = str(a?.registry?.workspace) ?? sup?.workspace;
    const fallbacks = {
      ...optional("sessionUrl", sessionUrl),
      ...optional("workspace", workspace),
    };
    let view: CoordinatorView;
    if (id === state.self) {
      // The Desk claimed the wave: the person at this Desk coordinates it (it has no agent).
      view = { id, waves: [w.id], state: "working" };
    } else if (a?.status && TERMINAL_STATUS.has(a.status.type)) {
      view = { id, waves: [w.id], state: "gone", ...fallbacks };
    } else if (a?.attention) {
      view = {
        id,
        waves: [w.id],
        state: "awaiting_input",
        ...fallbacks,
        ...optional("question", a.attention.question),
        ...optional("text", a.attention.text),
        ...optional("sessionUrl", a.attention.sessionUrl),
        ...optional("workspace", a.attention.workspace),
      };
    } else if (a?.attentionObserved || (a && !sup)) {
      view = { id, waves: [w.id], state: "working", ...fallbacks };
    } else if (sup) {
      view = {
        id,
        waves: [w.id],
        state: sup.state,
        ...fallbacks,
        ...optional("question", sup.question),
      };
    } else {
      view = { id, waves: [w.id], state: "gone", ...fallbacks };
    }
    coordinators[id] = view;
  }
  return { ...state, coordinators };
}

// --------------------------------------------------------------- selectors

/**
 * Agents that finished (`done`, `failed` or `reaped`) at least `graceMs` ago,
 * by the status's time (`wall_time` for a retained replay): the Desk hides
 * them unless the user asks to see finished agents.
 */
export function finishedAgents(state: DeskState, now: number, graceMs: number): Set<string> {
  const out = new Set<string>();
  for (const a of Object.values(state.agents)) {
    if (a.status && TERMINAL_STATUS.has(a.status.type) && now - a.status.at >= graceMs) {
      out.add(a.id);
    }
  }
  return out;
}

/**
 * Agents grouped by wave id (every known wave, plus `UNASSIGNED`), ordered by
 * task then role. Wave coordinators are not listed: they have their own window.
 */
export function agentsByWave(state: DeskState): Record<string, AgentView[]> {
  const groups: Record<string, AgentView[]> = { [UNASSIGNED]: [] };
  for (const id of Object.keys(state.waves)) groups[id] = [];
  for (const a of Object.values(state.agents)) {
    if (a.wave === UNASSIGNED && state.coordinators[a.id]) continue;
    const list = groups[a.wave] ?? [];
    list.push(a);
    groups[a.wave] = list;
  }
  for (const [id, list] of Object.entries(groups)) {
    const tasks = state.waves[id]?.state?.tasks.map((t) => t.id) ?? [];
    const order = (a: AgentView) =>
      (a.task && tasks.includes(a.task) ? tasks.indexOf(a.task) : tasks.length) * 10 +
      (a.role ? ROLE_ORDER.indexOf(a.role) : ROLE_ORDER.length);
    list.sort((x, y) => order(x) - order(y) || x.id.localeCompare(y.id));
  }
  return groups;
}
