/**
 * Message builders and a scriptable fake broker client for the Desk's store
 * and App tests: envelopes on an agent's channels, the registry, a wave
 * state, and a `DeskMqttClient` whose deliveries, connects, disconnects and
 * reconnect probes the test drives by hand.
 */
import type { DeskMqttClient } from "../../src/store/mqtt-client";
import type { DeskMessage, Envelope, WaveStatePayload, WaveView } from "../../src/store/types";

export const NOW = Date.parse("2026-10-18T12:00:00.000Z");
export const S = 1000;

export function env(
  agent: string,
  channel: string,
  type: string,
  payload: unknown,
  at: number,
): Envelope {
  return {
    schema_version: "0.1",
    agent_id: agent,
    channel,
    type,
    wall_time: new Date(at).toISOString(),
    namespace: "default",
    payload,
  };
}

export const registry = (id: string, at: number, retained = false): DeskMessage => ({
  topic: `volley/_system/registry/${id}`,
  envelope: env(
    id,
    "_system/registry",
    "registered",
    {
      capabilities: ["implements-issue"],
      cwd: "/work/repo",
      started_at: new Date(at).toISOString(),
    },
    at,
  ),
  receivedAt: at,
  ...(retained ? { retained } : {}),
});

export const status = (
  id: string,
  type: string,
  at: number,
  payload: Record<string, unknown> = {},
  retained = false,
): DeskMessage => ({
  topic: `volley/default/${id}/status`,
  envelope: env(id, "status", type, payload, at),
  receivedAt: at,
  ...(retained ? { retained } : {}),
});

export const progress = (
  id: string,
  type: string,
  at: number,
  payload: unknown = {},
): DeskMessage => ({
  topic: `volley/default/${id}/progress`,
  envelope: env(id, "progress", type, payload, at),
  receivedAt: at,
});

export function waveState(over: Partial<WaveStatePayload> = {}): WaveStatePayload {
  return {
    wave: "w1",
    version: 1,
    owner: "coord-1",
    repo: "example-org/example-repo",
    release_branch: "release/w1",
    status: "running",
    tasks: [{ id: "T1", issue: 1, stage: "implement", agents: { implementer: "impl-1" } }],
    open_decisions: [],
    gates: [],
    updated_at: new Date(NOW).toISOString(),
    ...over,
  };
}

export const waveMsg = (state: WaveStatePayload, at = NOW): DeskMessage => ({
  topic: `volley/_waves/${state.wave}/state`,
  envelope: env("volleyd", "_waves/state", "wave_state", state, at),
  receivedAt: at,
});

export const waveView = (state: WaveStatePayload): WaveView => ({
  id: state.wave,
  state,
  decisions: {},
  receivedAt: NOW,
});

/** A fake broker client: `emit` delivers, `connect`/`drop` fire the handlers, `probes` counts reconnects. */
export function fakeClient() {
  const message = new Set<(m: DeskMessage) => void>();
  const connect = new Set<() => void>();
  const disconnect = new Set<() => void>();
  const on =
    <H>(set: Set<H>) =>
    (h: H) => {
      set.add(h);
      return () => {
        set.delete(h);
      };
    };
  const ctl = {
    probes: 0,
    emit: (m: DeskMessage) => {
      for (const h of message) h(m);
    },
    up: () => {
      for (const h of connect) h();
    },
    drop: () => {
      for (const h of disconnect) h();
    },
    client: {
      connect: async () => {},
      disconnect: async () => {},
      publish: async () => {},
      reconnect: () => {
        ctl.probes += 1;
      },
      onMessage: on(message),
      onConnect: on(connect),
      onDisconnect: on(disconnect),
      onError: () => () => {},
    } as DeskMqttClient,
  };
  return ctl;
}
