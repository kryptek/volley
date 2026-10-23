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
 * replay of an envelope already in an agent's feed (same topic, type,
 * `wall_time` and `payload.seq`) is not appended again. Heartbeats update an
 * agent's liveness and count only; they never take a place in its feed.
 * After a reconnect the store calls `resync` first, so topics cleared while
 * the Desk was offline do not linger.
 *
 * A supervisor (`volleyd`: registry capability `supervisor`, or an id matching
 * `^volleyd(-|$)`) is health, not an agent: it goes into `supervisors` and
 * never gets an agent window. volleyd's control channel — a mailbox `query`
 * with `payload.op` and the daemon's `ack` echoing it — is kept out of every
 * agent's feed.
 *
 * Claude accounts (SPEC §4.6.11–12): an agent's retained `usage` sample is
 * kept in `usage` by agent id (never a feed row: it is a meter, not news), the
 * supervisor's per-account records in `claudeAccounts`, and sign-in events in
 * `signins` by account (live-only).
 *
 * Machines (SPEC §4.6.14): each paired machine's retained health record goes
 * into `machines` by name, taken only from the machine itself or volleyd and
 * only when it names its topic's machine. Which of them are machines at all
 * (configured hosts) is the section's call, at render time. volleyd's
 * readiness verdict on each (§4.6.15) goes into `readiness` by name.
 *
 * Autopilot (SPEC §4.6.16): of each wave's live `events` mirror only volleyd's
 * `decision_auto_resolved` / `decision_escalated` and the overlap plan's events (`wave_planned`,
 * `cluster_strategy_changed`, `train_started` / `_merged` / `_failed`) are kept, in `waveFeed` by
 * wave and in the feeds of the event's task's agents. The account events (`account_chosen`,
 * `agent_account_moved`, §4.6.11) are kept in `accountFeed` by wave: the agent window reads its
 * task role's from there (a choice is journaled before the agent it chose for exists).
 */
import { WAVE_FEED_EVENTS } from "./autopilot";
import { ACCOUNT_EVENTS } from "./claude";
import { pushRecord } from "./machineHistory";
import {
  type AgentAttention,
  type AgentView,
  type ArchivePayload,
  type ClaudeAccountPayload,
  type ClaudeSignin,
  type ConfigPayload,
  type CoordinatorView,
  type DecisionPayload,
  type DeskMessage,
  type DeskState,
  type DigestPayload,
  type Envelope,
  type FeedEntry,
  type InboxItem,
  type LeasePoolPayload,
  type MachinePayload,
  ROLES,
  type ReadinessPayload,
  type Receipts,
  type RegistryPayload,
  type Role,
  type ScreenPayload,
  type SteeringReceipts,
  type SupervisorView,
  type UsagePayload,
  type WaveStatePayload,
  type WaveView,
  type WorkLog,
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
  | { kind: "waveEvent"; wave: string }
  | { kind: "decision"; wave: string; decisionId: string }
  | { kind: "digest"; wave: string }
  | { kind: "config" }
  | { kind: "archive" }
  | { kind: "lease"; pool: string }
  | { kind: "admission" }
  | { kind: "claudeAccount"; acct: string }
  | { kind: "signin"; acct: string }
  | { kind: "usage"; agentId: string }
  | { kind: "machine"; name: string }
  | { kind: "readiness"; name: string }
  | { kind: "inbox"; id: string };

/** Map a topic to what it updates, or `null` for anything outside the Desk's subscriptions. */
export function routeTopic(topic: string): Route | null {
  const p = topic.split("/");
  if (p[0] !== "volley" || p.some((s) => s === "")) return null;
  const [, a, b, c, d] = p;
  if (a === "_inbox") return p.length === 3 && b ? { kind: "inbox", id: b } : null;
  if (a === "_system") {
    if (p.length === 4 && b === "registry" && c) return { kind: "registry", agentId: c };
    if (p.length === 4 && b === "leases" && c) return { kind: "lease", pool: c };
    if (p.length === 3 && b === "admission") return { kind: "admission" };
    if (p.length === 4 && b === "claude-accounts" && c) return { kind: "claudeAccount", acct: c };
    if (p.length === 5 && b === "claude" && c && d === "signin") return { kind: "signin", acct: c };
    if (p.length === 4 && b === "machines" && c) return { kind: "machine", name: c };
    if (p.length === 5 && b === "machines" && c && d === "readiness") {
      return { kind: "readiness", name: c };
    }
    return null;
  }
  if (a === "_waves") {
    if (p.length === 3 && b === "_config") return { kind: "config" };
    if (p.length === 3 && b === "_archive") return { kind: "archive" };
    if (p.length === 4 && b && c === "state") return { kind: "wave", wave: b };
    if (p.length === 4 && b && c === "events") return { kind: "waveEvent", wave: b };
    if (p.length === 4 && b && c === "digest") return { kind: "digest", wave: b };
    if (p.length === 5 && b && c === "decisions" && d) {
      return { kind: "decision", wave: b, decisionId: d };
    }
    return null;
  }
  if (p.length === 4 && a && b && !a.startsWith("_")) {
    if (c === "usage") return { kind: "usage", agentId: b };
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
    archive: null,
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
      if (
        route.channel === "mailbox" &&
        m.envelope &&
        isControlTraffic(m.envelope, route.agentId, (id) => isSupervisor(s, id, null))
      ) {
        return s;
      }
      return ownsNoAgent(s, route, m) ? s : withCoordinators(reduceAgent(s, route, m));
    }
    case "wave":
      return withCoordinators(reduceWave(state, route.wave, m));
    case "waveEvent":
      return reduceWaveEvent(state, route.wave, m);
    case "decision":
      return reduceDecision(state, route.wave, route.decisionId, m);
    case "digest":
      return reduceDigest(state, route.wave, m);
    case "config":
      return { ...state, config: (m.envelope?.payload as ConfigPayload | undefined) ?? null };
    case "archive":
      return { ...state, archive: (m.envelope?.payload as ArchivePayload | undefined) ?? null };
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
    case "claudeAccount":
      return {
        ...state,
        claudeAccounts: keyed(
          state.claudeAccounts,
          route.acct,
          m.envelope?.payload as ClaudeAccountPayload | undefined,
        ),
      };
    case "usage":
      return {
        ...state,
        usage: keyed(state.usage, route.agentId, m.envelope?.payload as UsagePayload | undefined),
      };
    case "signin":
      return reduceSignin(state, route.acct, m);
    case "machine":
      return reduceMachine(state, route.name, m);
    case "readiness":
      return reduceReadiness(state, route.name, m);
    case "inbox":
      return reduceInbox(state, route.id, m);
  }
}

/**
 * A wave's morning digest (SPEC §4.6.16): taken only from volleyd and only when it names its
 * topic's wave; a cleared topic (the wave archived) forgets it.
 */
function reduceDigest(state: DeskState, wave: string, m: DeskMessage): DeskState {
  const env = m.envelope;
  if (env === null) return { ...state, digests: keyed(state.digests, wave, undefined) };
  const p = env.payload as Partial<DigestPayload> | undefined;
  if (env.agent_id !== "volleyd" || p?.wave !== wave) return state;
  return { ...state, digests: keyed(state.digests, wave, p as DigestPayload) };
}

/**
 * A needs-you inbox item (SPEC §4.6.18): taken only from volleyd (the broker lets no one else
 * write it; the id is a sanity check) and only when it names its topic's id; a cleared topic
 * forgets it. An answered item stays (with `answered`) until volleyd clears it.
 */
function reduceInbox(state: DeskState, id: string, m: DeskMessage): DeskState {
  const env = m.envelope;
  if (env === null) return { ...state, inbox: keyed(state.inbox, id, undefined) };
  const p = env.payload as Partial<InboxItem> | undefined;
  if (env.agent_id !== "volleyd" || p?.id !== id) return state;
  return { ...state, inbox: keyed(state.inbox, id, p as InboxItem) };
}

/**
 * volleyd's readiness verdict on a machine (SPEC §4.6.15): taken only from
 * volleyd (the broker lets no one else write it; the id is a sanity check)
 * and only when it names its topic's machine; a cleared topic forgets it.
 */
function reduceReadiness(state: DeskState, name: string, m: DeskMessage): DeskState {
  const env = m.envelope;
  if (env === null) return { ...state, readiness: keyed(state.readiness, name, undefined) };
  const p = env.payload as Partial<ReadinessPayload> | undefined;
  if (env.agent_id !== "volleyd" || p?.name !== name) return state;
  return { ...state, readiness: keyed(state.readiness, name, p as ReadinessPayload) };
}

/**
 * A machine record: kept when the machine itself or volleyd (its down record)
 * published it for this topic's machine; a cleared topic (`peer_remove`)
 * forgets the machine (and its sparkline history). Anything else leaves the slice as it was. A down
 * record that replaces an up one keeps the up one's load, agents and the
 * later `last_seen`, as volleyd's `MachineHealth.observe` does: the LWT is
 * built when the machine connects, so its values may be hours old. An up or
 * local record's reading joins the machine's ring (`machineHistory.ts`).
 */
function reduceMachine(state: DeskState, name: string, m: DeskMessage): DeskState {
  const env = m.envelope;
  if (env === null) {
    return {
      ...state,
      machines: keyed(state.machines, name, undefined),
      machineHistory: keyed(state.machineHistory, name, undefined),
    };
  }
  const p = env.payload as Partial<MachinePayload> | undefined;
  if (
    env.type !== "machine" ||
    (env.agent_id !== name && env.agent_id !== "volleyd") ||
    p?.name !== name
  ) {
    return state;
  }
  const next = p as MachinePayload;
  const prior = state.machines?.[name];
  const rec: MachinePayload =
    next.tunnel === "down" && prior
      ? {
          ...prior,
          tunnel: "down",
          ...(next.reason !== undefined ? { reason: next.reason } : {}),
          last_seen:
            Date.parse(next.last_seen) > Date.parse(prior.last_seen)
              ? next.last_seen
              : prior.last_seen,
        }
      : next;
  return {
    ...state,
    machines: keyed(state.machines, name, rec),
    machineHistory: keyed(
      state.machineHistory,
      name,
      pushRecord(state.machineHistory?.[name], next),
    ),
  };
}

/** `map` with `key` set to `value`, or removed when `value` is undefined (a cleared topic). */
function keyed<V>(map: Record<string, V> | undefined, key: string, value: V | undefined) {
  const next = { ...map };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

const SIGNIN_STATE: Record<string, ClaudeSignin["state"]> = {
  claude_signin_url: "waiting",
  claude_signin_done: "done",
  claude_signin_failed: "failed",
};

/** A sign-in event: the URL (waiting), then done or failed. The link is kept until a new URL. */
function reduceSignin(state: DeskState, acct: string, m: DeskMessage): DeskState {
  const env = m.envelope;
  const next = env ? SIGNIN_STATE[env.type] : undefined;
  if (!env || next === undefined) return state;
  const p = record(env.payload);
  const prev = next === "waiting" ? undefined : state.signins?.[acct];
  const signin: ClaudeSignin = {
    acct,
    state: next,
    at: m.receivedAt,
    ...optional("url", str(p.url) ?? prev?.url),
    ...optional("flow", str(p.flow) ?? prev?.flow),
    ...optional("attach", str(p.attach) ?? prev?.attach),
    ...optional("manual_url", str(p.manual_url) ?? prev?.manual_url),
    ...optional("plan", str(p.plan)),
    ...optional("email", str(p.email)),
    ...optional("reason", str(p.reason)),
  };
  return { ...state, signins: { ...state.signins, [acct]: signin } };
}

// ------------------------------------------------------------------ resync

/**
 * Forget everything that retained topics hold, ahead of the replay that
 * follows a reconnect: waves (with their decisions), config, leases,
 * admission, Claude account records and usage samples, machine records, each agent's
 * registry, status and screen, and each supervisor's registry and status.
 * Live-only parts — feed, narration, progress, heartbeat, attention, a
 * supervisor's namespace, the machines' sparkline rings (machineHistory; the
 * replayed record is deduplicated by last_seen) — are kept. Agents and supervisors that were
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
  // volleyd's namespace survives, so a config_set or steer sent during the replay still reaches it.
  const supervisors: Record<string, SupervisorView> = {};
  for (const sv of Object.values(state.supervisors)) {
    if (sv.registry) unconfirmed.add(sv.id);
    supervisors[sv.id] = { ...sv, registry: null, status: null };
  }
  return {
    ...state,
    waves: {},
    agents,
    coordinators: {},
    supervisors,
    config: null,
    archive: null,
    leases: {},
    admission: null,
    claudeAccounts: {},
    usage: {},
    machines: {},
    readiness: {},
    inbox: {},
    digests: {},
    unconfirmed: [...unconfirmed],
  };
}

/**
 * Drop agents and supervisors still `unconfirmed` once the post-reconnect replay has settled, and
 * the sparkline ring of any machine whose record was not replayed (removed while disconnected).
 */
export function pruneUnconfirmed(state: DeskState): DeskState {
  if (state.unconfirmed === undefined) return state;
  const { unconfirmed, ...rest } = state;
  const agents = { ...state.agents };
  const supervisors = { ...state.supervisors };
  for (const id of unconfirmed) {
    if (agents[id] && !agents[id].registered) delete agents[id];
    if (supervisors[id] && !supervisors[id].registry) delete supervisors[id];
  }
  const pruned = { ...rest, agents, supervisors };
  if (state.machineHistory !== undefined) {
    pruned.machineHistory = Object.fromEntries(
      Object.entries(state.machineHistory).filter(([name]) => state.machines?.[name] !== undefined),
    );
  }
  return withCoordinators(pruned);
}

// ------------------------------------------------------------------ agents

function newAgent(
  id: string,
  waves: Record<string, WaveView>,
  at: number,
  observedAt: number,
): AgentView {
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
    observedAt,
  };
}

/**
 * An autopilot or plan event from a wave's live `events` mirror (SPEC §4.6.16), taken only from volleyd:
 * kept in the wave's feed and, when it names a task, in the feeds of that task's agents. Every
 * other journal event is the supervisor's bookkeeping, already folded into the wave state.
 */
function reduceWaveEvent(state: DeskState, wave: string, m: DeskMessage): DeskState {
  const env = m.envelope;
  if (!env || env.agent_id !== "volleyd") return state;
  const entry = { topic: m.topic, envelope: env, receivedAt: m.receivedAt };
  if (ACCOUNT_EVENTS.has(env.type)) {
    const kept = state.accountFeed?.[wave] ?? [];
    if (redelivered(kept, env)) return state;
    const accountFeed = { ...state.accountFeed, [wave]: [...kept, entry].slice(-FEED_LIMIT) };
    return { ...state, accountFeed };
  }
  if (!WAVE_FEED_EVENTS.has(env.type)) return state;
  const prior = state.waveFeed?.[wave] ?? [];
  if (redelivered(prior, env)) return state;
  const feed = [...prior, entry].slice(-FEED_LIMIT);
  const task = str(record(env.payload).task);
  const t = task ? state.waves[wave]?.state?.tasks.find((x) => x.id === task) : undefined;
  let agents = state.agents;
  for (const id of new Set(Object.values(t?.agents ?? {}))) {
    const a = id ? agents[id] : undefined;
    if (!a) continue;
    agents = { ...agents, [a.id]: { ...a, feed: pushFeed(a, m.topic, env, m.receivedAt) } };
  }
  return { ...state, agents, waveFeed: { ...state.waveFeed, [wave]: feed } };
}

/** A QoS-1 redelivery after a reconnect carries a seq already kept. */
function redelivered(kept: readonly FeedEntry[], env: Envelope): boolean {
  const seq = record(env.payload).seq;
  return typeof seq === "number" && kept.some((e) => record(e.envelope.payload).seq === seq);
}

function pushFeed(a: AgentView, topic: string, envelope: Envelope, receivedAt: number) {
  const feed = [...a.feed, { topic, envelope, receivedAt }];
  return feed.length > FEED_LIMIT ? feed.slice(feed.length - FEED_LIMIT) : feed;
}

const seqOf = (env: Envelope): unknown => record(env.payload).seq;

/** A retained replay of an envelope the agent's feed already holds: same topic, type, `wall_time` and `seq`. */
function isReplay(a: AgentView | undefined, m: DeskMessage, env: Envelope): boolean {
  return (
    m.retained === true &&
    a !== undefined &&
    a.feed.some(
      (f) =>
        f.topic === m.topic &&
        f.envelope.type === env.type &&
        f.envelope.wall_time === env.wall_time &&
        seqOf(f.envelope) === seqOf(env),
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
  const prev = existing ?? newAgent(id, state.waves, at, m.receivedAt);
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
  const prev = existing ?? newAgent(id, state.waves, at, m.receivedAt);
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
  // A heartbeat is liveness, not news: it is counted, never a feed row.
  const beat = channel === "progress" && env.type === "heartbeat";
  const next: AgentView = {
    ...base,
    feed: replay || beat ? prev.feed : pushFeed(prev, m.topic, env, m.receivedAt),
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
  const hook = channel === "progress" && payload.source === "harness-hook";
  if (channel === "progress" && !hook && !beat && !replay) next.reportedAt = at;
  if (channel === "progress" && !hook && prev.firstSaid === undefined) {
    const said = str(payload.msg);
    if (said !== undefined) next.firstSaid = said;
  }
  // A hook's work-log line is the session's, not the agent's own narration: kept in `work`.
  const narration = env.type === "activity" && hook ? undefined : str(payload.msg);
  // Live traffic is the newest by definition; only a replay can be older than what is shown
  // (and its `wall_time` is the sender's clock, which may run ahead of ours).
  if (narration !== undefined && (!m.retained || at >= (prev.narrationAt ?? at))) {
    next.narration = narration;
    next.narrationAt = at;
    next.narrationRestored = false;
  }
  if (typeof payload.progress === "number") next.progress = payload.progress;
  if (channel === "status") {
    next.status = {
      type: env.type,
      payload: env.payload,
      at: envTime(env, m.receivedAt),
      seenAt: at,
    };
    return putAgent(state, next);
  }
  // progress: hook activity events (SPEC §4.3)
  // Heartbeats are never retained; local receipt avoids cross-machine clock skew.
  if (beat) {
    next.heartbeat = at;
    next.heartbeats = (prev.heartbeats ?? 0) + 1;
  }
  if (env.type === "awaiting_input") {
    next.attentionObserved = true;
    next.attention = {
      state: "awaiting_input",
      at: envTime(env, m.receivedAt),
      ...optional("text", str(payload.text)),
      ...optional("question", str(payload.question)),
      ...optional("sessionUrl", str(payload.session_url)),
      ...optional("workspace", str(payload.workspace)),
      ...optional("notificationType", str(payload.notification_type)),
      ...(payload.background_wait === true ? { backgroundWait: true } : {}),
    };
  }
  if (env.type === "resumed") {
    next.attentionObserved = true;
    next.attention = null;
  }
  if (hook) {
    const work = workLog(prev.work, env.type, payload, at);
    if (work) next.work = work;
  }
  return putAgent(state, next);
}

/**
 * Fold one hook tick into the work log: `activity` (a tool call or a new prompt) and
 * `resumed` mean working, `idle` / `awaiting_input` mean the turn ended. Anything else
 * (a heartbeat) changes nothing. `tool_calls` only grows.
 */
export function workLog(
  prev: WorkLog | undefined,
  type: string,
  payload: Record<string, unknown>,
  at: number,
): WorkLog | undefined {
  const state =
    type === "activity" || type === "resumed"
      ? "working"
      : type === "idle" || type === "awaiting_input"
        ? "idle"
        : null;
  if (state === null) return prev;
  const reported = typeof payload.tool_calls === "number" ? payload.tool_calls : 0;
  const msg = type === "activity" ? str(payload.msg) : undefined;
  const base: WorkLog = prev ?? { toolCalls: 0, lastToolAt: null, last: null, state, since: at };
  return {
    toolCalls: Math.max(base.toolCalls, reported),
    lastToolAt: msg !== undefined && msg !== PROMPT_RECEIVED ? at : base.lastToolAt,
    last: msg ?? base.last,
    state,
    since: prev && prev.state === state ? prev.since : at,
  };
}

/** The `activity` line the hooks send for a new prompt (never its text). */
export const PROMPT_RECEIVED = "prompt received";

// ------------------------------------------------------------- supervisors

/** Supervisor statuses that mean it is running (volleyd's `LIVE_STATUS`). */
const LIVE_SUPERVISOR = new Set(["spawning", "registered", "working"]);

/** A known supervisor, one by its id, or a registry entry declaring capability `supervisor`. */
function isSupervisor(state: DeskState, id: string, registry: Envelope | null): boolean {
  if (isSupervisorId(id) || state.supervisors[id]) return true;
  const caps = record(registry?.payload).capabilities;
  return Array.isArray(caps) && caps.includes("supervisor");
}

/**
 * volleyd's control channel, on the mailbox of agent `to`: a `query` carrying
 * `payload.op` sent to a supervisor, or a supervisor's `ack` to one (it echoes
 * `acked_type: "query"` and the op). `op` is not reserved (SPEC §4.4), so
 * the same query between two agents is a conversation and stays.
 */
export function isControlTraffic(
  env: Envelope,
  to: string,
  supervisor: (id: string) => boolean = isSupervisorId,
): boolean {
  const p = record(env.payload);
  if (typeof p.op !== "string") return false;
  if (env.type === "query") return supervisor(to);
  return env.type === "ack" && p.acked_type === "query" && supervisor(env.agent_id);
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
  if (channel !== "registry") return { ...state, supervisors, agents };
  const unconfirmed = state.unconfirmed?.filter((u) => u !== id);
  return { ...state, supervisors, agents, ...optional("unconfirmed", unconfirmed) };
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
  return Object.values(state.supervisors).sort(
    (a, b) => Number(b.id === "volleyd") - Number(a.id === "volleyd") || a.id.localeCompare(b.id),
  );
}

/** The namespace volleyd's control mailbox lives in: its registry's, else `default`. */
export function supervisorNamespace(state: DeskState, id = "volleyd"): string {
  return state.supervisors[id]?.namespace ?? "default";
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
    // The wave's agents move to "no wave", except those whose retained records are all gone
    // (retired, then the wave archived): nothing would ever bring them back, so they go.
    const agents: Record<string, AgentView> = {};
    for (const a of Object.values(state.agents)) {
      if (a.wave !== id) agents[a.id] = a;
      else if (a.status !== null || a.registry !== null)
        agents[a.id] = { ...a, wave: UNASSIGNED, task: null, role: null };
    }
    const { [id]: _gone, ...waveFeed } = state.waveFeed ?? {};
    const { [id]: _chosen, ...accountFeed } = state.accountFeed ?? {};
    return {
      ...state,
      waves,
      agents,
      ...(state.waveFeed ? { waveFeed } : {}),
      ...(state.accountFeed ? { accountFeed } : {}),
    };
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
 * An outstanding `awaiting_input` waits on a person unless the hooks flagged
 * a live background wait (`background_wait: true`: the session ended its turn
 * with a background task armed, so the next event wakes it). A
 * `permission_prompt` always waits on a person.
 */
export function waitsOnPerson(att: AgentAttention | null): boolean {
  if (att === null) return false;
  return att.backgroundWait !== true || att.notificationType === "permission_prompt";
}

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
    // volleyd's view of this owner; its agent_id is the bound agent when the owner is a name.
    const sup = s.coordinator;
    const a = (sup !== undefined ? state.agents[sup.agent_id] : undefined) ?? state.agents[id];
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
    } else if (s.coordinator?.state === "reconnecting") {
      // The supervisor's call (its grace, its flip to gone): the bound agent's terminal status is why.
      view = { id, waves: [w.id], state: "reconnecting", ...fallbacks };
    } else if (a?.status && TERMINAL_STATUS.has(a.status.type)) {
      view = { id, waves: [w.id], state: "gone", ...fallbacks };
    } else if (a?.attention && !waitsOnPerson(a.attention)) {
      // Idle with a background wait armed: it wakes on the wave's events, nobody has to answer.
      view = { id, waves: [w.id], state: "working", waitingOnEvents: true, ...fallbacks };
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

const REGISTRY_PREFIX = "volley/_system/registry/";

/**
 * Agents with no status: their registry entry replayed ahead of it, a reconnect's
 * resync cleared it, or a session whose hooks reach this broker but whose MCP server
 * does not (the "no signal" case, which never gets one). `stale` are those whose
 * registry entry started at least `graceMs` ago and from which nothing but that
 * entry has been heard: an old record, which the Desk hides with the finished agents (C11).
 */
export function unclassifiedAgents(
  state: DeskState,
  now: number,
  graceMs: number,
): { all: Set<string>; stale: Set<string> } {
  const all = new Set<string>();
  const stale = new Set<string>();
  for (const a of Object.values(state.agents)) {
    if (a.status) continue;
    all.add(a.id);
    const started = Date.parse(a.registry?.started_at ?? "");
    if (
      !Number.isNaN(started) &&
      now - started >= graceMs &&
      a.feed.every((f) => f.topic.startsWith(REGISTRY_PREFIX))
    ) {
      stale.add(a.id);
    }
  }
  return { all, stale };
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

/** Wave statuses after which nothing runs: the wave window renders dimmed and folds under Show finished. */
const ENDED_WAVE = new Set(["stopped", "complete", "archived"]);

export function isEndedWave(w: WaveView | undefined): boolean {
  return ENDED_WAVE.has(w?.state?.status ?? "");
}

/** Waves that are `stopped` or `complete`. */
export function endedWaves(state: DeskState): Set<string> {
  return new Set(
    Object.values(state.waves)
      .filter(isEndedWave)
      .map((w) => w.id),
  );
}

/** Registry entries the harness hooks wrote: `model_source` is theirs (SPEC §4.3). */
const HOOK_SOURCES = new Set(["harness-hook", "unknown"]);

/**
 * An interactive Claude Code session rather than a dispatched agent: the hooks
 * registered it (`model_source`), nobody launched it (no `parent_id`) and no
 * wave runs it (SPEC §4.3).
 */
export function isSession(a: Pick<AgentView, "registry" | "parentId" | "wave" | "task">): boolean {
  const src = a.registry?.model_source;
  return (
    typeof src === "string" &&
    HOOK_SOURCES.has(src) &&
    a.parentId === null &&
    a.wave === UNASSIGNED &&
    a.task === null
  );
}

/** The top bar's "· N sessions": live interactive sessions (`isSession`), apart from the agents. */
export function sessionCount(state: DeskState): number {
  return Object.values(state.agents).filter(
    (a) => !state.coordinators[a.id] && isSession(a) && LIVE_AGENT.has(a.status?.type ?? ""),
  ).length;
}

const LIVE_AGENT = new Set(["spawning", "registered", "working"]);

/**
 * The top bar's "N agents working": agents (not coordinators, never sessions, never
 * supervisors, none of a stopped / complete wave) whose status is `working`, or still `spawning` / `registered`
 * while they publish progress — an agent the MCP server left at `registered`
 * (it never set `working` itself) that is narrating is at work.
 */
export function workingCount(state: DeskState): number {
  return Object.values(state.agents).filter((a) => {
    // Nothing runs in a stopped / complete wave, whatever an agent's last status said.
    if (state.coordinators[a.id] || isSession(a) || isEndedWave(state.waves[a.wave])) return false;
    const t = a.status?.type;
    if (t === "working") return true;
    return (t === "spawning" || t === "registered") && a.lastProgress !== undefined;
  }).length;
}

/** Whether agent `id` is running: it has a status and it is not terminal. */
export function isLiveAgent(state: DeskState, id: string): boolean {
  const t = state.agents[id]?.status?.type;
  return t !== undefined && !TERMINAL_STATUS.has(t);
}

/**
 * This machine's agents, for Settings › Machines: live agents (not
 * coordinators, never supervisors, none of an ended wave, no terminal status)
 * whose task names no remote `host`.
 */
export function localAgentCount(state: DeskState): number {
  return Object.values(state.agents).filter((a) => {
    if (state.coordinators[a.id] || isSupervisorId(a.id)) return false;
    const w = state.waves[a.wave];
    if (isEndedWave(w)) return false;
    const t = a.status?.type;
    if (t === undefined || TERMINAL_STATUS.has(t)) return false;
    const task = w?.state?.tasks.find((x) => x.id === a.task);
    return typeof task?.host !== "string";
  }).length;
}

const REVIEW_LABEL = { spec_reviewer: "spec review", quality_reviewer: "quality review" } as const;

/**
 * The stage chip of a task in review: `review (spec + quality)` while both
 * reviewers run in parallel, else the one still running; `null` outside
 * review or with no reviewer running.
 */
export function stageChip(state: DeskState, wave: string, task: string): string | null {
  const t = state.waves[wave]?.state?.tasks.find((x) => x.id === task);
  if (!t || (t.stage !== "spec_review" && t.stage !== "quality_review")) return null;
  const running = (["spec_reviewer", "quality_reviewer"] as const).filter((role) => {
    const id = t.agents[role];
    const type = id ? state.agents[id]?.status?.type : undefined;
    return type !== undefined && !TERMINAL_STATUS.has(type) && type !== "blocked";
  });
  if (running.length === 2) return "review (spec + quality)";
  const [one] = running;
  return one ? REVIEW_LABEL[one] : null;
}

/**
 * Put back an agent's last narration from this browser's session (a cold
 * load hears only retained topics); marked `narrationRestored` until a live
 * one replaces it. A newer narration already in the store wins.
 */
export function restoreNarration(
  state: DeskState,
  id: string,
  text: string,
  at: number,
): DeskState {
  const a = state.agents[id];
  if (!a || (a.narration !== null && (a.narrationAt ?? 0) >= at)) return state;
  return putAgent(state, { ...a, narration: text, narrationAt: at, narrationRestored: true });
}
