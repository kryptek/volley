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
 */
import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
} from "react";
import { demoReviewer, demoState, isDemoMode, tick } from "./fixtures";
import { type DeskMqttClient, createMqttClient } from "./mqtt-client";
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
  clientFactory,
}: {
  children: ReactNode;
  demo?: boolean;
  brokerUrl?: string;
  clientFactory?: (url: string) => DeskMqttClient;
}) {
  const demo = demoProp ?? isDemoMode(window.location.search, viteEnv());
  const brokerUrl = demo
    ? null
    : (urlProp ?? (viteEnv().VITE_VOLLEY_BROKER_URL as string | undefined) ?? DEFAULT_BROKER_URL);
  const [state, dispatch] = useReducer(storeReducer, undefined, () =>
    demo ? demoState() : initialState(),
  );
  const [connection, setConnection] = useState<Connection>(demo ? "demo" : "connecting");

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
    const client = (clientFactory ?? ((url: string) => createMqttClient({ url })))(brokerUrl);
    const detach = attachClient(client, dispatch, {}, setConnection);
    setConnection("connecting");
    client.connect().catch((err: unknown) => {
      console.warn("volley-desk: broker connect failed", err);
      setConnection("disconnected");
    });
    return () => {
      detach();
      void client.disconnect();
    };
  }, [brokerUrl, clientFactory]);

  const value = useMemo(
    () => ({ state, connection, demo, brokerUrl }),
    [state, connection, demo, brokerUrl],
  );
  return <DeskContext.Provider value={value}>{children}</DeskContext.Provider>;
}

export function useDesk(): DeskContextValue {
  const ctx = useContext(DeskContext);
  if (!ctx) throw new Error("useDesk must be used inside <DeskStoreProvider>");
  return ctx;
}
