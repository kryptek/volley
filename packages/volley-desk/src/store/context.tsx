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
 * `settling` is true until the first connect's replay has settled, from every
 * disconnect until the next reconnect's replay has settled, and (in demo mode)
 * for `SETTLE_MS` after load: state seen then is not news, so notifications
 * stay quiet. `offline` lists the spans after the first connect during which
 * the Desk was disconnected or settling, so coordinator silence is measured
 * only over time it could actually hear the broker.
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
import type { OfflineSpan } from "../attention";
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

function viteEnv(): Record<string, unknown> {
  return (import.meta as { env?: Record<string, unknown> }).env ?? {};
}

export function DeskStoreProvider({
  children,
  demo: demoProp,
  brokerUrl: urlProp,
  clientFactory,
  settleMs = SETTLE_MS,
}: {
  children: ReactNode;
  demo?: boolean;
  brokerUrl?: string;
  clientFactory?: (url: string) => DeskMqttClient;
  /** How long a (re)connect's retained replay is given to arrive (tests shorten it). */
  settleMs?: number;
}) {
  const demo = demoProp ?? isDemoMode(window.location.search, viteEnv());
  const brokerUrl = demo
    ? null
    : (urlProp ?? (viteEnv().VITE_VOLLEY_BROKER_URL as string | undefined) ?? DEFAULT_BROKER_URL);
  const [state, dispatch] = useReducer(storeReducer, undefined, () =>
    demo ? demoState() : initialState(),
  );
  const [connection, setConnection] = useState<Connection>(demo ? "demo" : "connecting");
  const [settling, setSettling] = useState(true);
  const [offline, setOffline] = useState<readonly OfflineSpan[]>([]);

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
    const client = (clientFactory ?? ((url: string) => createMqttClient({ url })))(brokerUrl);
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
    setConnection("connecting");
    client.connect().catch((err: unknown) => {
      console.warn("volley-desk: broker connect failed", err);
      setConnection("disconnected");
    });
    return () => {
      detach();
      void client.disconnect();
    };
  }, [brokerUrl, clientFactory, settleMs]);

  const value = useMemo(
    () => ({ state, connection, demo, brokerUrl, settling, offline }),
    [state, connection, demo, brokerUrl, settling, offline],
  );
  return <DeskContext.Provider value={value}>{children}</DeskContext.Provider>;
}

export function useDesk(): DeskContextValue {
  const ctx = useContext(DeskContext);
  if (!ctx) throw new Error("useDesk must be used inside <DeskStoreProvider>");
  return ctx;
}
