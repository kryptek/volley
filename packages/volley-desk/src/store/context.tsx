/**
 * Desk store provider. Live mode connects to the broker over WebSocket
 * (`VITE_VOLLEY_BROKER_URL`, default `ws://localhost:9001` — mosquitto's
 * WebSocket listener) and folds every delivery through the reducer; demo mode
 * (`?demo=1` / `VITE_VOLLEY_DEMO=1`) starts from the fixtures and runs their
 * simulation instead, with no broker at all.
 *
 * On every reconnect the broker replays each retained topic, so the store
 * `resync`s first (dropping retained-derived state) and lets the replay
 * rebuild it; agents whose registry entry does not come back within
 * `SETTLE_MS` are pruned.
 *
 * Broker credentials (T14) make the Desk a writer (D4 steering): it signs in
 * as that identity, which becomes its `identity` (the sender of everything it
 * publishes, whose mailbox carries the answers) and `writer` is the client.
 * Without credentials the connection is anonymous and read-only. Demo mode
 * writes to a simulated client instead.
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
import { DEMO_IDENTITY, createDemoSteerClient } from "../steer/demoClient";
import type { SteerClient } from "../steer/transport";
import { demoReviewer, demoState, isDemoMode, tick } from "./fixtures";
import { type BrokerCredentials, type DeskMqttClient, createMqttClient } from "./mqtt-client";
import { initialState, pruneUnconfirmed, reduceAll, resync } from "./reducer";
import type { DeskMessage, DeskState } from "./types";

export const DEFAULT_BROKER_URL = "ws://localhost:9001";
const TICK_MS = 2600;
const REVIEWER_AFTER_MS = 22_000;
/** Coalesce a retained-message burst into one render. */
const FLUSH_MS = 16;
/** How long after a reconnect the retained replay is given to arrive. */
const SETTLE_MS = 3000;

export type Connection = "demo" | "connecting" | "connected" | "disconnected";

export interface DeskContextValue {
  state: DeskState;
  connection: Connection;
  demo: boolean;
  brokerUrl: string | null;
  /** The Desk's broker identity when it can write; `null` when anonymous. */
  identity: string | null;
  /** Publishes as `identity` (steering, control requests); `null` when read-only. */
  writer: SteerClient | null;
}

/** localStorage key for the Desk's broker credentials (`{ username, password }`). */
export const CREDENTIALS_STORAGE_KEY = "volley-desk:broker-auth";

/**
 * Broker credentials: `VITE_VOLLEY_BROKER_USERNAME` / `VITE_VOLLEY_BROKER_PASSWORD`,
 * else the JSON stored under `CREDENTIALS_STORAGE_KEY`; `null` (anonymous) otherwise.
 */
export function readCredentials(
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
 * the buffered messages, then `prune` once `settleMs` has passed. Returns a
 * cleanup that detaches and cancels pending work; it does not disconnect.
 */
export function attachClient(
  client: DeskMqttClient,
  dispatch: (a: Action) => void,
  { flushMs = FLUSH_MS, settleMs = SETTLE_MS }: { flushMs?: number; settleMs?: number } = {},
  onConnection?: (c: Connection) => void,
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
      if (!connected) {
        connected = true;
        return;
      }
      flush();
      dispatch({ type: "resync" });
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => {
        settle = null;
        flush();
        dispatch({ type: "prune" });
      }, settleMs);
    }),
    client.onDisconnect(() => onConnection?.("disconnected")),
  ];
  return () => {
    for (const off of offs) off();
    if (timer) clearTimeout(timer);
    if (settle) clearTimeout(settle);
  };
}

const DeskContext = createContext<DeskContextValue | null>(null);

function viteEnv(): Record<string, unknown> {
  return (import.meta as { env?: Record<string, unknown> }).env ?? {};
}

export function DeskStoreProvider({
  children,
  demo: demoProp,
  brokerUrl: urlProp,
  auth: authProp,
  clientFactory,
}: {
  children: ReactNode;
  demo?: boolean;
  brokerUrl?: string;
  /** Broker credentials; `null` forces anonymous; default `readCredentials`. */
  auth?: BrokerCredentials | null;
  clientFactory?: (url: string, auth?: BrokerCredentials) => DeskMqttClient;
}) {
  const demo = demoProp ?? isDemoMode(window.location.search, viteEnv());
  const brokerUrl = demo
    ? null
    : (urlProp ?? (viteEnv().VITE_VOLLEY_BROKER_URL as string | undefined) ?? DEFAULT_BROKER_URL);
  const [auth] = useState(() =>
    demo
      ? null
      : authProp !== undefined
        ? authProp
        : readCredentials(viteEnv(), localStorageOrNull()),
  );
  const identity = demo ? DEMO_IDENTITY : (auth?.username ?? null);
  const [state, dispatch] = useReducer(storeReducer, undefined, () => ({
    ...(demo ? demoState() : initialState()),
    ...(identity !== null ? { self: identity } : {}),
  }));
  const [connection, setConnection] = useState<Connection>(demo ? "demo" : "connecting");
  const [liveWriter, setLiveWriter] = useState<SteerClient | null>(null);
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
      clearInterval(t);
      clearTimeout(r);
    };
  }, [demo]);

  useEffect(() => {
    if (brokerUrl === null) return;
    const client = (
      clientFactory ?? ((url: string, a?: BrokerCredentials) => createMqttClient({ url, auth: a }))
    )(brokerUrl, auth ?? undefined);
    const detach = attachClient(client, dispatch, {}, setConnection);
    setLiveWriter(auth ? client : null);
    setConnection("connecting");
    client.connect().catch((err: unknown) => {
      console.warn("volley-desk: broker connect failed", err);
      setConnection("disconnected");
    });
    return () => {
      detach();
      setLiveWriter(null);
      void client.disconnect();
    };
  }, [brokerUrl, clientFactory, auth]);

  const writer = demo ? demoWriter : liveWriter;
  const value = useMemo(
    () => ({ state, connection, demo, brokerUrl, identity: writer ? identity : null, writer }),
    [state, connection, demo, brokerUrl, identity, writer],
  );
  return <DeskContext.Provider value={value}>{children}</DeskContext.Provider>;
}

export function useDesk(): DeskContextValue {
  const ctx = useContext(DeskContext);
  if (!ctx) throw new Error("useDesk must be used inside <DeskStoreProvider>");
  return ctx;
}
