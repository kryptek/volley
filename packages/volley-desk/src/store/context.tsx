/**
 * Desk store provider. Live mode connects to the broker over WebSocket
 * (`VITE_VOLLEY_BROKER_URL`, default `ws://localhost:9001` — mosquitto's
 * WebSocket listener) and folds every delivery through the reducer; demo mode
 * (`?demo=1` / `VITE_VOLLEY_DEMO=1`) starts from the fixtures and runs their
 * simulation instead, with no broker at all.
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
import { initialState, reduceAll } from "./reducer";
import type { DeskMessage, DeskState } from "./types";

export const DEFAULT_BROKER_URL = "ws://localhost:9001";
const TICK_MS = 2600;
const REVIEWER_AFTER_MS = 22_000;
/** Coalesce a retained-message burst into one render. */
const FLUSH_MS = 16;

export type Connection = "demo" | "connecting" | "connected" | "disconnected";

export interface DeskContextValue {
  state: DeskState;
  connection: Connection;
  demo: boolean;
  brokerUrl: string | null;
}

type Action = { type: "apply"; msgs: DeskMessage[] } | { type: "tick"; step: number; now: number };

function storeReducer(state: DeskState, a: Action): DeskState {
  return a.type === "tick" ? tick(state, a.step, a.now) : reduceAll(state, a.msgs);
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
    let buffer: DeskMessage[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      timer = null;
      const msgs = buffer;
      buffer = [];
      dispatch({ type: "apply", msgs });
    };
    const offs = [
      client.onMessage((m) => {
        buffer.push(m);
        timer ??= setTimeout(flush, FLUSH_MS);
      }),
      client.onConnect(() => setConnection("connected")),
      client.onDisconnect(() => setConnection("disconnected")),
    ];
    setConnection("connecting");
    client.connect().catch((err: unknown) => {
      console.warn("volley-desk: broker connect failed", err);
      setConnection("disconnected");
    });
    return () => {
      for (const off of offs) off();
      if (timer) clearTimeout(timer);
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
