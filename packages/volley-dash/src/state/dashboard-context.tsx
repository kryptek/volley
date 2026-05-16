/**
 * React context that owns the dashboard's `useReducer`, mounts the mqtt
 * client, and translates incoming MQTT messages into reducer actions.
 *
 * Wiring on mount:
 *   1. `createMqttClient` with the broker URL from `VITE_VOLLEY_BROKER_URL`
 *      (default `ws://localhost:9001` — mosquitto's WebSocket listener).
 *   2. `connect()` → subscribe to all 5 wildcards (handled inside the client).
 *   3. `onMessage` → `actionsFromMessage` → `dispatch` (one event + at most
 *      one agent action per inbound message).
 *   4. A debounced 400ms `EVENT_AGE` clears `fresh` flags so Phase 3's row
 *      flash animation has something to detach from.
 *
 * Cleanup on unmount: `disconnect()` ends the broker session.
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
import { useFlipOnAgentTransition } from "../hooks/useFlipOnAgentTransition";
import { type VolleyMqttClient, createMqttClient } from "../lib/mqtt-client";
import { parseTopic } from "../lib/parse-topic";
import type { DashState } from "../types";
import { actionsFromMessage } from "./envelope-to-actions";
import { type DashAction, initialState, reducer } from "./reducer";

const DEFAULT_BROKER_URL = "ws://localhost:9001";
const FRESH_AGE_MS = 400;

export type BrokerStatus = "connecting" | "connected" | "disconnected";

export interface DashboardContextValue {
  state: DashState;
  dispatch: React.Dispatch<DashAction>;
  brokerStatus: BrokerStatus;
  brokerUrl: string;
}

const DashboardContext = createContext<DashboardContextValue | null>(null);

export interface DashboardProviderProps {
  children: ReactNode;
  /**
   * Optional override for the broker URL. Tests pass a `mqtt://127.0.0.1:port`
   * URL pointing at an in-process Aedes broker; production reads from
   * `VITE_VOLLEY_BROKER_URL` and defaults to mosquitto's WebSocket listener.
   */
  brokerUrl?: string | undefined;
  /**
   * Optional client factory override — lets tests inject a mock without
   * spinning the real mqtt.js client.
   */
  clientFactory?: ((url: string) => VolleyMqttClient) | undefined;
}

function resolveBrokerUrl(override: string | undefined): string {
  if (override !== undefined) return override;
  const envUrl = (import.meta as ImportMeta & { env?: Record<string, string> }).env
    ?.VITE_VOLLEY_BROKER_URL;
  return envUrl ?? DEFAULT_BROKER_URL;
}

export function DashboardProvider({
  children,
  brokerUrl,
  clientFactory,
}: DashboardProviderProps): JSX.Element {
  const [state, rawDispatch] = useReducer(reducer, initialState);
  // Wrap raw dispatch so AGENT_TRANSITION actions trigger a GSAP Flip
  // animation across the grid. Other actions pass through unchanged.
  const dispatch = useFlipOnAgentTransition(rawDispatch);
  const [brokerStatus, setBrokerStatus] = useState<BrokerStatus>("connecting");
  const resolvedUrl = useMemo(() => resolveBrokerUrl(brokerUrl), [brokerUrl]);
  // Keep a ref to the latest state so the onMessage callback (registered once
  // at mount) can compute transitions against the freshest agents Map without
  // forcing a reconnect on every state change.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const factory = clientFactory ?? ((u: string) => createMqttClient({ url: u }));
    const client = factory(resolvedUrl);
    let cancelled = false;
    let ageTimer: ReturnType<typeof setTimeout> | null = null;

    const offMessage = client.onMessage((topic, envelope) => {
      const parsed = parseTopic(topic);
      if (parsed === null) return;
      const { agentAction, feedEvent } = actionsFromMessage(parsed, envelope, stateRef.current);
      dispatch({ type: "EVENT_RECV", event: feedEvent });
      if (agentAction !== null) dispatch(agentAction);

      if (ageTimer !== null) clearTimeout(ageTimer);
      ageTimer = setTimeout(() => {
        dispatch({ type: "EVENT_AGE" });
        ageTimer = null;
      }, FRESH_AGE_MS);
    });

    const offConnect = client.onConnect(() => {
      if (!cancelled) setBrokerStatus("connected");
    });
    const offDisconnect = client.onDisconnect(() => {
      if (!cancelled) setBrokerStatus("disconnected");
    });

    client.connect().catch((err) => {
      if (!cancelled) {
        console.warn("volley-dash: mqtt connect failed", err);
        setBrokerStatus("disconnected");
      }
    });

    return () => {
      cancelled = true;
      offMessage();
      offConnect();
      offDisconnect();
      if (ageTimer !== null) clearTimeout(ageTimer);
      void client.disconnect();
    };
  }, [resolvedUrl, clientFactory, dispatch]);

  const value = useMemo<DashboardContextValue>(
    () => ({ state, dispatch, brokerStatus, brokerUrl: resolvedUrl }),
    [state, dispatch, brokerStatus, resolvedUrl],
  );
  return <DashboardContext.Provider value={value}>{children}</DashboardContext.Provider>;
}

export function useDashboard(): DashboardContextValue {
  const ctx = useContext(DashboardContext);
  if (ctx === null) {
    throw new Error("useDashboard must be used inside <DashboardProvider />");
  }
  return ctx;
}
