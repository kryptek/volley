/**
 * Desk store provider. Live mode connects to the broker over WebSocket
 * (`VITE_VOLLEY_BROKER_URL`, default port 9001 on the host that served the
 * page — mosquitto's WebSocket listener, so a phone on the LAN reaches the
 * same broker as the laptop) and folds every delivery through the reducer; demo mode
 * (`?demo=1` / `VITE_VOLLEY_DEMO=1`) starts from the fixtures and runs their
 * simulation instead, with no broker at all.
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
import { demoAgentCount, demoReviewer, demoState, isDemoMode, tick } from "./fixtures";
import {
  AuthFailedError,
  type BrokerCredentials,
  type DeskMqttClient,
  createMqttClient,
} from "./mqtt-client";
import { initialState, pruneUnconfirmed, reduceAll, resync } from "./reducer";
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

/** The broker URL the live Desk connects to: the prop, else `VITE_VOLLEY_BROKER_URL`, else the page host's. */
export function resolveBrokerUrl(
  urlProp?: string,
  env: Record<string, unknown> = viteEnv(),
  page: Parameters<typeof defaultBrokerUrl>[0] = typeof window === "undefined"
    ? undefined
    : window.location,
): string {
  const fromEnv = env.VITE_VOLLEY_BROKER_URL;
  if (urlProp !== undefined) return urlProp;
  if (typeof fromEnv === "string" && fromEnv !== "") return fromEnv;
  return defaultBrokerUrl(page);
}
const TICK_MS = 2600;
const REVIEWER_AFTER_MS = 22_000;
/** Coalesce a retained-message burst into one render. */
const FLUSH_MS = 16;
/** How long after a reconnect the retained replay is given to arrive. */
const SETTLE_MS = 3000;
/** Offline spans kept (older ones are long past any `claim_after_s`). */
const OFFLINE_KEEP = 50;

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

export type Action =
  | { type: "apply"; msgs: DeskMessage[] }
  | { type: "tick"; step: number; now: number }
  | { type: "resync" }
  | { type: "prune" };

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
  }
}

/**
 * Feed a client's deliveries into `dispatch`, coalesced every `flushMs`. A
 * reconnect (every connect after the first) dispatches `resync` in order with
 * the buffered messages, then `prune` once `settleMs` has passed. `onSettling`
 * hears `false` once a connect's replay has settled (`settleMs` after it) and
 * `true` on a disconnect after the first connect. Returns a cleanup that
 * detaches and cancels pending work; it does not disconnect.
 */
export function attachClient(
  client: DeskMqttClient,
  dispatch: (a: Action) => void,
  { flushMs = FLUSH_MS, settleMs = SETTLE_MS }: { flushMs?: number; settleMs?: number } = {},
  onConnection?: (c: Connection) => void,
  onSettling?: (settling: boolean, at: number) => void,
): () => void {
  let buffer: DeskMessage[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settle: ReturnType<typeof setTimeout> | null = null;
  let connected = false;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const msgs = buffer;
    buffer = [];
    if (msgs.length > 0) dispatch({ type: "apply", msgs });
  };
  const offs = [
    client.onMessage((m) => {
      buffer.push(m);
      timer ??= setTimeout(flush, flushMs);
    }),
    client.onConnect(() => {
      onConnection?.("connected");
      const reconnect = connected;
      connected = true;
      if (reconnect) {
        flush();
        dispatch({ type: "resync" });
      }
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => {
        settle = null;
        flush();
        if (reconnect) dispatch({ type: "prune" });
        onSettling?.(false, Date.now());
      }, settleMs);
    }),
    client.onDisconnect(() => {
      onConnection?.("disconnected");
      // The next connect resyncs and settles again; until then nothing is settled.
      if (settle) clearTimeout(settle);
      settle = null;
      if (connected) onSettling?.(true, Date.now());
    }),
  ];
  return () => {
    for (const off of offs) off();
    if (timer) clearTimeout(timer);
    if (settle) clearTimeout(settle);
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
  const [offline, setOffline] = useState<readonly OfflineSpan[]>([]);
  const [liveWriter, setLiveWriter] = useState<SteerClient | null>(null);
  const [liveConnected, setLiveConnected] = useState(false);
  useEffect(() => {
    if (connection === "connected") setLiveConnected(true);
  }, [connection]);
  // The demo writer answers a coordinator with `resumed` instead of `steering_acked`.
  const coordinatorIds = useRef<ReadonlySet<string>>(new Set());
  coordinatorIds.current = new Set(Object.keys(state.coordinators));
  const [demoWriter] = useState<SteerClient | null>(() =>
    demo
      ? createDemoSteerClient(
          (msgs) => dispatch({ type: "apply", msgs }),
          (id) => coordinatorIds.current.has(id),
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
    return () => {
      clearTimeout(settled);
      clearInterval(t);
      clearTimeout(r);
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
    const detach = attachClient(client, dispatch, { settleMs }, setConnection, onSettling);
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
      setLiveWriter(null);
      void client.disconnect();
    };
  }, [brokerUrl, clientFactory, settleMs, auth]);

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
      identity: writer ? identity : null,
      writer,
    }),
    [state, connection, demo, brokerUrl, settling, offline, identity, writer],
  );
  return <DeskContext.Provider value={value}>{children}</DeskContext.Provider>;
}

export function useDesk(): DeskContextValue {
  const ctx = useContext(DeskContext);
  if (!ctx) throw new Error("useDesk must be used inside <DeskStoreProvider>");
  return ctx;
}
