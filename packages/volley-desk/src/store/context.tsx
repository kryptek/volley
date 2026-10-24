/**
 * Desk store provider. Live mode connects to the broker over WebSocket
 * (`VITE_VOLLEY_BROKER_URL`, default port 9001 on the host that served the
 * page — mosquitto's WebSocket listener, so a phone on the LAN reaches the
 * same broker as the laptop) and folds every delivery through the reducer; demo mode
 * (`?demo=1` / `VITE_VOLLEY_DEMO=1`) starts from the fixtures and runs their
 * simulation instead, with no broker at all: agent ticks every `TICK_MS`, a reviewer at
 * `REVIEWER_AFTER_MS`, the running wave's morning digest at `DIGEST_AFTER_MS` and a machine
 * beat every `MACHINES_TICK_MS`.
 *
 * On every reconnect the broker replays each retained topic, so the store
 * `resync`s first (dropping retained-derived state) and lets the replay
 * rebuild it; agents whose registry entry does not come back within
 * `SETTLE_MS` are pruned.
 *
 * `settling` is true until the first connect's replay has settled, from every
 * disconnect until the next reconnect's replay has settled, and (in demo mode)
 * for `SETTLE_MS` after load: state seen then is not news, so notifications
 * stay quiet. `offline` lists the spans after the first connect during which
 * the Desk was disconnected or settling, so coordinator silence is measured
 * only over time it could actually hear the broker.
 *
 * `syncing` is the reconnect / resume grace window: from every connect, and
 * from the page coming back to the foreground (`visibilitychange → visible`,
 * when the Desk also probes the broker with `client.reconnect()` instead of
 * waiting for the keepalive to notice a dead socket), for `SYNC_GRACE_MS`
 * (30 s). Retained state alone says
 * nothing about liveness, so nobody is judged quiet or without signal then.
 * A reconnect never clears feed rows or narration (see `resync`). Each agent's
 * last narration is kept in `sessionStorage` (`NARRATION_STORAGE_PREFIX` +
 * agent id), so a cold load (a phone that discarded the tab) shows it again,
 * marked as restored, until a live one arrives.
 * Broker credentials (T14) make the Desk a writer (D4 steering): it signs in
 * as that identity, which becomes its `identity` (the sender of everything it
 * publishes, whose mailbox carries the answers) and `writer` is the client.
 * Without credentials the connection is anonymous and read-only. Demo mode
 * writes to a simulated client instead. A broker that refuses the credentials
 * calls `onAuthFailed` (the sign-in gate, `auth/SignInGate.tsx`, asks again).
 */
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type { OfflineSpan } from "../attention";
import { DEMO_IDENTITY, createDemoSteerClient } from "../steer/demoClient";
import type { SteerClient } from "../steer/transport";
import {
  DIGEST_WAVE,
  MACHINES_TICK_MS,
  demoAgentCount,
  demoDigest,
  demoReviewer,
  demoState,
  isDemoMode,
  machinesTick,
  tick,
} from "./fixtures";
import {
  AuthFailedError,
  type BrokerCredentials,
  type DeskMqttClient,
  createMqttClient,
} from "./mqtt-client";
import { initialState, pruneUnconfirmed, reduceAll, restoreNarration, resync } from "./reducer";
import type { DeskMessage, DeskState } from "./types";

export const DEFAULT_BROKER_URL = "ws://localhost:9001";

/**
 * mosquitto's WebSocket listener on the host that served the page
 * (`localhost` outside a browser). `location.hostname` already brackets an
 * IPv6 literal (`[::1]`); a bare one is bracketed here. A page served over
 * https gets `wss:`, since browsers block a `ws:` socket from it.
 */
export function defaultBrokerUrl(
  page: { hostname: string; protocol?: string | undefined } | undefined,
): string {
  if (!page?.hostname) return DEFAULT_BROKER_URL;
  const { hostname, protocol } = page;
  const host = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  return `${protocol === "https:" ? "wss" : "ws"}://${host}:9001`;
}

/** What `volley desk serve --broker-host` serves at `/desk-config.json`. */
export interface ServedDeskConfig {
  broker: { host: string; ws_port: number };
}

/** Where the live Desk's broker URL came from (Settings › About shows it). */
export type BrokerSource = "prop" | "env" | "served" | "page host";

/** The broker URL and where it came from, for Settings › About (null: demo, tests, previews). */
export const BrokerOriginContext = createContext<{ url: string; source: BrokerSource } | null>(
  null,
);

/**
 * The broker URL the live Desk connects to: the prop, else `VITE_VOLLEY_BROKER_URL`, else the
 * broker the server named (`served`: `/desk-config.json`), else the page host's. A served host
 * is bracketed when it is a bare IPv6 address; `wss` on an https page, as for the page host.
 */
export function resolveBrokerUrl(
  urlProp?: string,
  env: Record<string, unknown> = viteEnv(),
  page: Parameters<typeof defaultBrokerUrl>[0] = typeof window === "undefined"
    ? undefined
    : window.location,
  served?: ServedDeskConfig | null,
): string {
  const fromEnv = env.VITE_VOLLEY_BROKER_URL;
  if (urlProp !== undefined) return urlProp;
  if (typeof fromEnv === "string" && fromEnv !== "") return fromEnv;
  if (served != null) {
    const { host, ws_port } = served.broker;
    const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    return `${page?.protocol === "https:" ? "wss" : "ws"}://${h}:${ws_port}`;
  }
  return defaultBrokerUrl(page);
}

/** Which of `resolveBrokerUrl`'s sources gave the URL. */
export function brokerSource(
  urlProp: string | undefined,
  env: Record<string, unknown>,
  served: ServedDeskConfig | null | undefined,
): BrokerSource {
  if (urlProp !== undefined) return "prop";
  if (typeof env.VITE_VOLLEY_BROKER_URL === "string" && env.VITE_VOLLEY_BROKER_URL !== "")
    return "env";
  return served != null ? "served" : "page host";
}

/** Whether the URL is settled without the server's config (the prop or the env names it). */
export const needsServedConfig = (urlProp: string | undefined, env: Record<string, unknown>) =>
  brokerSource(urlProp, env, null) === "page host";

/**
 * `GET /desk-config.json` (never from the HTTP cache), or null: a 404 (the server names no
 * broker), a network error, or a body that is not `{ broker: { host, ws_port } }` with a bare
 * host and a port.
 */
export async function fetchDeskConfig(
  fetchFn: typeof fetch = fetch,
): Promise<ServedDeskConfig | null> {
  try {
    const r = await fetchFn("/desk-config.json", { cache: "no-store" });
    if (!r.ok) return null;
    const broker = ((await r.json()) as { broker?: { host?: unknown; ws_port?: unknown } })?.broker;
    const host = broker?.host;
    const port = broker?.ws_port;
    if (typeof host !== "string" || !/^[A-Za-z0-9.:-]+$/.test(host)) return null;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535)
      return null;
    return { broker: { host, ws_port: port } };
  } catch {
    return null;
  }
}

let servedConfig: Promise<ServedDeskConfig | null> | null = null;

/** `fetchDeskConfig`, once per page load: kept in memory, never in localStorage. */
export function loadDeskConfig(): Promise<ServedDeskConfig | null> {
  servedConfig ??= fetchDeskConfig();
  return servedConfig;
}

const TICK_MS = 2600;
const REVIEWER_AFTER_MS = 22_000;
/** When the demo's running wave gets its morning digest. */
export const DIGEST_AFTER_MS = 40_000;
/** Coalesce a retained-message burst into one render. */
const FLUSH_MS = 16;
/** How long after a reconnect the retained replay is given to arrive. */
const SETTLE_MS = 3000;
/** A connect's retained replay is over once no retained message has arrived for this long. */
const REPLAY_QUIET_MS = 80;
/** The longest a connect's replay is held back from the store (a broker that never goes quiet). */
const REPLAY_HOLD_MAX_MS = 1500;
/** Offline spans kept: they exclude the agents' quiet windows from silence, so only recent ones matter. */
const OFFLINE_KEEP = 50;
/**
 * The reconnect / resume grace window. A fixed span, not a tunable: the hooks
 * heartbeat on each hook event (SPEC §4.3), not on an interval, so there is no
 * heartbeat interval to derive it from. Long enough for a working session's
 * next hook event or narration to arrive.
 */
export const SYNC_GRACE_MS = 30_000;

/** sessionStorage key prefix for an agent's last narration (`{ text, at }`). */
export const NARRATION_STORAGE_PREFIX = "volley-desk:narration:";

export type Connection = "demo" | "connecting" | "connected" | "disconnected";

export interface DeskContextValue {
  state: DeskState;
  connection: Connection;
  demo: boolean;
  brokerUrl: string | null;
  /** The retained replay has not settled yet (first connect, or a reconnect); see the header. */
  settling: boolean;
  /** Spans the Desk was disconnected or settling after its first connect. */
  offline: readonly OfflineSpan[];
  /** The reconnect / resume grace window is open; see the header. */
  syncing: boolean;
  /** The Desk's broker identity when it can write; `null` when anonymous. */
  identity: string | null;
  /** Publishes as `identity` (steering, control requests); `null` when read-only. */
  writer: SteerClient | null;
}

/** localStorage key for the Desk's broker credentials (`{ username, password }`). */
export const CREDENTIALS_STORAGE_KEY = "volley-desk:broker-auth";

/** The agent-id grammar (SPEC §2.2, `volley-mcp/topics` `ID_PATTERN`): the username is the sender id. */
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/**
 * Broker credentials: `VITE_VOLLEY_BROKER_USERNAME` / `VITE_VOLLEY_BROKER_PASSWORD`
 * (dev only: Vite inlines them into a built bundle), else the JSON stored under
 * `CREDENTIALS_STORAGE_KEY`; `null` (anonymous) otherwise. A username outside the
 * agent-id grammar cannot sign envelopes or name a mailbox, so it stays anonymous.
 */
export function readCredentials(
  env: Record<string, unknown>,
  storage: Pick<Storage, "getItem"> | null,
): BrokerCredentials | null {
  return validIdentity(fromEnvOrStorage(env, storage));
}

function fromEnvOrStorage(
  env: Record<string, unknown>,
  storage: Pick<Storage, "getItem"> | null,
): BrokerCredentials | null {
  const u = env.VITE_VOLLEY_BROKER_USERNAME;
  const p = env.VITE_VOLLEY_BROKER_PASSWORD;
  if (typeof u === "string" && u !== "")
    return { username: u, password: typeof p === "string" ? p : "" };
  try {
    const raw = storage?.getItem(CREDENTIALS_STORAGE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Partial<BrokerCredentials>;
    return typeof c.username === "string" && c.username !== "" && typeof c.password === "string"
      ? { username: c.username, password: c.password }
      : null;
  } catch {
    return null;
  }
}

function validIdentity(c: BrokerCredentials | null): BrokerCredentials | null {
  if (c === null || AGENT_ID.test(c.username)) return c;
  console.warn(
    `volley-desk: broker username '${c.username}' is not a valid agent id; staying read-only`,
  );
  return null;
}

function localStorageOrNull(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function sessionStorageOrNull(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** The narration saved for `id` this session, if any. */
function savedNarration(storage: Storage, id: string): { text: string; at: number } | null {
  try {
    const v = JSON.parse(storage.getItem(NARRATION_STORAGE_PREFIX + id) ?? "null") as {
      text?: unknown;
      at?: unknown;
    } | null;
    return typeof v?.text === "string" && v.text !== "" && typeof v.at === "number"
      ? { text: v.text, at: v.at }
      : null;
  } catch {
    return null;
  }
}

export type Action =
  | { type: "apply"; msgs: DeskMessage[] }
  | { type: "tick"; step: number; now: number }
  | { type: "resync" }
  | { type: "prune" }
  | { type: "restore"; id: string; text: string; at: number };

export function storeReducer(state: DeskState, a: Action): DeskState {
  switch (a.type) {
    case "tick":
      return tick(state, a.step, a.now);
    case "apply":
      return reduceAll(state, a.msgs);
    case "resync":
      return resync(state);
    case "prune":
      return pruneUnconfirmed(state);
    case "restore":
      return restoreNarration(state, a.id, a.text, a.at);
  }
}

/**
 * Feed a client's deliveries into `dispatch`, coalesced every `flushMs`. Each
 * connect holds its retained replay (C11): nothing is dispatched until no
 * retained message has arrived for `quietMs` (live ones do not keep the hold
 * open), or `holdMaxMs` (at most `settleMs`) has passed. The client runs its
 * connect handlers when the subscriptions are granted, and the broker sends the
 * replay straight after that SUBACK, so the quiet window opens with the replay
 * (never a round trip early at the CONNACK). The replay then lands in one `apply`. So the first frame sees every
 * registry entry with its status (a broker with hundreds of finished agents
 * never flashes them onto the canvas), and a reconnect's `resync` is dispatched
 * together with its replay, however long the link takes to deliver it. A hold a
 * disconnect interrupts stays open, its timers stopped, so nothing is applied
 * while offline; the next connect drops its partial replay (the new one resends
 * every retained topic) and holds again. A reconnect (every connect after the
 * first) then dispatches `prune` once `settleMs` has passed. `onSettling` hears
 * `false` once a connect's replay has settled (`settleMs` after it) and `true`
 * on a disconnect after the first connect. Returns a cleanup that detaches and
 * cancels pending work; it does not disconnect.
 */
export function attachClient(
  client: DeskMqttClient,
  dispatch: (a: Action) => void,
  {
    flushMs = FLUSH_MS,
    settleMs = SETTLE_MS,
    quietMs = REPLAY_QUIET_MS,
    holdMaxMs = REPLAY_HOLD_MAX_MS,
  }: { flushMs?: number; settleMs?: number; quietMs?: number; holdMaxMs?: number } = {},
  onConnection?: (c: Connection) => void,
  onSettling?: (settling: boolean, at: number) => void,
): () => void {
  let buffer: DeskMessage[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settle: ReturnType<typeof setTimeout> | null = null;
  let connected = false;
  /** A connect's replay is being held; `resyncDue` when that connect was a reconnect. */
  let holding = false;
  let resyncDue = false;
  let quiet: ReturnType<typeof setTimeout> | null = null;
  let bound: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const msgs = buffer;
    buffer = [];
    if (msgs.length > 0) dispatch({ type: "apply", msgs });
  };
  const stopHold = () => {
    if (quiet) clearTimeout(quiet);
    if (bound) clearTimeout(bound);
    quiet = bound = null;
  };
  const release = () => {
    stopHold();
    holding = false;
    if (resyncDue) dispatch({ type: "resync" });
    resyncDue = false;
    flush();
  };
  const offs = [
    client.onMessage((m) => {
      buffer.push(m);
      if (!holding) timer ??= setTimeout(flush, flushMs);
      else if (m.retained) {
        if (quiet) clearTimeout(quiet);
        quiet = setTimeout(release, quietMs);
      }
    }),
    client.onConnect(() => {
      onConnection?.("connected");
      const reconnect = connected;
      connected = true;
      if (holding) {
        // A hold a disconnect interrupted carries on: this connect's replay resends
        // every retained topic, so drop the partial one (a topic cleared meanwhile
        // must not come back from it). A resync it owed is still owed.
        stopHold();
        buffer = buffer.filter((m) => !m.retained);
      } else if (reconnect) flush();
      if (timer) clearTimeout(timer);
      timer = null;
      resyncDue = (holding && resyncDue) || reconnect;
      holding = true;
      quiet = setTimeout(release, quietMs);
      bound = setTimeout(release, Math.min(holdMaxMs, settleMs));
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => {
        settle = null;
        if (holding) release();
        flush();
        if (reconnect) dispatch({ type: "prune" });
        onSettling?.(false, Date.now());
      }, settleMs);
    }),
    client.onDisconnect(() => {
      onConnection?.("disconnected");
      // The next connect resyncs and settles again; until then nothing is settled,
      // and an open hold applies nothing while offline.
      if (settle) clearTimeout(settle);
      settle = null;
      stopHold();
      if (connected) onSettling?.(true, Date.now());
    }),
  ];
  return () => {
    for (const off of offs) off();
    if (timer) clearTimeout(timer);
    if (settle) clearTimeout(settle);
    if (quiet) clearTimeout(quiet);
    if (bound) clearTimeout(bound);
  };
}

const DeskContext = createContext<DeskContextValue | null>(null);

export function viteEnv(): Record<string, unknown> {
  return (import.meta as { env?: Record<string, unknown> }).env ?? {};
}

export function DeskStoreProvider({
  children,
  demo: demoProp,
  brokerUrl: urlProp,
  auth: authProp,
  clientFactory,
  settleMs = SETTLE_MS,
  onAuthFailed,
}: {
  children: ReactNode;
  demo?: boolean;
  brokerUrl?: string;
  /** Broker credentials; `null` forces anonymous; default `readCredentials`. */
  auth?: BrokerCredentials | null;
  clientFactory?: (url: string, auth?: BrokerCredentials) => DeskMqttClient;
  /** How long a (re)connect's retained replay is given to arrive (tests shorten it). */
  settleMs?: number;
  /** The broker refused the credentials (connect or a later reconnect); the reason. */
  onAuthFailed?: (message: string) => void;
}) {
  const demo = demoProp ?? isDemoMode(window.location.search, viteEnv());
  const brokerUrl = demo ? null : resolveBrokerUrl(urlProp);
  // A ref, not an effect dependency: a new callback must not reconnect.
  const onAuthFailedRef = useRef(onAuthFailed);
  onAuthFailedRef.current = onAuthFailed;
  const [auth] = useState(() =>
    demo
      ? null
      : authProp !== undefined
        ? authProp
        : readCredentials(viteEnv(), localStorageOrNull()),
  );
  const identity = demo ? DEMO_IDENTITY : (auth?.username ?? null);
  const [state, dispatch] = useReducer(storeReducer, undefined, () => ({
    ...(demo ? demoState(Date.now(), demoAgentCount(window.location.search)) : initialState()),
    ...(identity !== null ? { self: identity } : {}),
  }));
  const [connection, setConnection] = useState<Connection>(demo ? "demo" : "connecting");
  const [settling, setSettling] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const graceTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const startGrace = useCallback(() => {
    setSyncing(true);
    clearTimeout(graceTimer.current);
    graceTimer.current = setTimeout(() => setSyncing(false), SYNC_GRACE_MS);
  }, []);
  useEffect(() => () => clearTimeout(graceTimer.current), []);
  const clientRef = useRef<DeskMqttClient | null>(null);
  const [offline, setOffline] = useState<readonly OfflineSpan[]>([]);
  const [liveWriter, setLiveWriter] = useState<SteerClient | null>(null);
  const [liveConnected, setLiveConnected] = useState(false);
  useEffect(() => {
    if (connection === "connected") setLiveConnected(true);
  }, [connection]);
  // The demo writer answers a coordinator with `resumed` instead of `steering_acked`.
  const coordinatorIds = useRef<ReadonlySet<string>>(new Set());
  coordinatorIds.current = new Set(Object.keys(state.coordinators));
  // The demo writer re-publishes a wave's state when its account is set.
  const waveStates = useRef<DeskState["waves"]>({});
  waveStates.current = state.waves;
  const [demoWriter] = useState<SteerClient | null>(() =>
    demo
      ? createDemoSteerClient(
          (msgs) => dispatch({ type: "apply", msgs }),
          (id) => coordinatorIds.current.has(id),
          Date.now,
          (wave) => waveStates.current[wave]?.state ?? null,
        )
      : null,
  );

  useEffect(() => {
    if (!demo) return;
    const settled = setTimeout(() => setSettling(false), settleMs);
    let step = 0;
    const t = setInterval(() => {
      step += 1;
      dispatch({ type: "tick", step, now: Date.now() });
    }, TICK_MS);
    const r = setTimeout(
      () => dispatch({ type: "apply", msgs: demoReviewer(Date.now()) }),
      REVIEWER_AFTER_MS,
    );
    const d = setTimeout(
      () => dispatch({ type: "apply", msgs: demoDigest(Date.now(), DIGEST_WAVE) }),
      DIGEST_AFTER_MS,
    );
    let beat = 0;
    const m = setInterval(() => {
      beat += 1;
      dispatch({ type: "apply", msgs: machinesTick(Date.now(), beat) });
    }, MACHINES_TICK_MS);
    return () => {
      clearTimeout(settled);
      clearInterval(t);
      clearTimeout(r);
      clearTimeout(d);
      clearInterval(m);
    };
  }, [demo, settleMs]);

  useEffect(() => {
    if (brokerUrl === null) return;
    const client = (
      clientFactory ?? ((url: string, a?: BrokerCredentials) => createMqttClient({ url, auth: a }))
    )(brokerUrl, auth ?? undefined);
    const onSettling = (now: boolean, at: number) => {
      setSettling(now);
      setOffline((spans) => {
        const last = spans[spans.length - 1];
        const open = last !== undefined && last.to === null;
        if (now) return open ? spans : [...spans, { from: at, to: null }].slice(-OFFLINE_KEEP);
        return open ? [...spans.slice(0, -1), { from: last.from, to: at }] : spans;
      });
    };
    clientRef.current = client;
    const onConnection = (c: Connection) => {
      setConnection(c);
      if (c === "connected") startGrace();
    };
    const detach = attachClient(client, dispatch, { settleMs }, onConnection, onSettling);
    let refused = false;
    const refuse = (err: AuthFailedError) => {
      if (refused) return;
      refused = true;
      // Stop mqtt.js retrying the refused credentials every reconnectPeriod.
      void client.disconnect();
      setConnection("disconnected");
      if (onAuthFailedRef.current) onAuthFailedRef.current(err.message);
      else console.warn("volley-desk: the broker refused the credentials", err);
    };
    const offError = client.onError((err) => {
      if (err instanceof AuthFailedError) refuse(err);
    });
    setLiveWriter(auth ? client : null);
    setLiveConnected(false);
    setConnection("connecting");
    client.connect().catch((err: unknown) => {
      if (err instanceof AuthFailedError) return refuse(err);
      console.warn("volley-desk: broker connect failed", err);
      setConnection("disconnected");
    });
    return () => {
      offError();
      detach();
      clientRef.current = null;
      setLiveWriter(null);
      void client.disconnect();
    };
  }, [brokerUrl, clientFactory, settleMs, auth, startGrace]);

  // Back in the foreground (a phone resumed the tab): probe the broker now and sync again.
  useEffect(() => {
    if (brokerUrl === null || typeof document === "undefined") return;
    let away = document.visibilityState === "hidden";
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        away = true;
        return;
      }
      if (!away) return;
      away = false;
      clientRef.current?.reconnect?.();
      startGrace();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [brokerUrl, startGrace]);

  // Keep each agent's last narration for this session; restore it once for an agent that has none.
  const savedAt = useRef<Record<string, number>>({});
  const restoreTried = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (demo) return;
    const storage = sessionStorageOrNull();
    if (!storage) return;
    for (const a of Object.values(state.agents)) {
      if (a.narration !== null && a.narrationAt !== undefined) {
        if (a.narrationRestored || savedAt.current[a.id] === a.narrationAt) continue;
        savedAt.current[a.id] = a.narrationAt;
        try {
          storage.setItem(
            NARRATION_STORAGE_PREFIX + a.id,
            JSON.stringify({ text: a.narration, at: a.narrationAt }),
          );
        } catch {
          // A full or blocked sessionStorage only loses the restore.
        }
      } else if (a.narration === null && !restoreTried.current.has(a.id)) {
        restoreTried.current.add(a.id);
        const saved = savedNarration(storage, a.id);
        if (saved) dispatch({ type: "restore", id: a.id, ...saved });
      }
    }
  }, [state.agents, demo]);

  // Writes only once the credentialed connection has actually come up (bad credentials never do).
  const writer = demo ? demoWriter : liveConnected ? liveWriter : null;
  const value = useMemo(
    () => ({
      state,
      connection,
      demo,
      brokerUrl,
      settling,
      offline,
      syncing: demo ? false : syncing,
      identity: writer ? identity : null,
      writer,
    }),
    [state, connection, demo, brokerUrl, settling, offline, syncing, identity, writer],
  );
  return <DeskContext.Provider value={value}>{children}</DeskContext.Provider>;
}

export function useDesk(): DeskContextValue {
  const ctx = useContext(DeskContext);
  if (!ctx) throw new Error("useDesk must be used inside <DeskStoreProvider>");
  return ctx;
}
