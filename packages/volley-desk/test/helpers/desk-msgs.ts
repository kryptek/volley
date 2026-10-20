/**
 * Message builders and a scriptable fake broker client for the Desk's store
 * and App tests: envelopes on an agent's channels, the registry, a wave
 * state, and a `DeskMqttClient` whose deliveries, connects, disconnects and
 * reconnect probes the test drives by hand.
 */
import type { DeskMqttClient } from "../../src/store/mqtt-client";
import type {
  DeskMessage,
  Envelope,
  MachinePayload,
  ReadinessPayload,
  TaskPlacement,
  WaveStatePayload,
  WaveView,
} from "../../src/store/types";

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

// ------------------------------------------------------------------ Fleet

/** A paired machine's record with a doctor report (SPEC §4.6.15), every check passing. */
export function machineRecord(over: Partial<MachinePayload> = {}): MachinePayload {
  return {
    name: "box-a",
    kind: "peer",
    os: "linux",
    arch: "x64",
    cores: 16,
    tunnel: "up",
    load: [1.25, 0.9, 0.7],
    agents: 2,
    last_seen: new Date(NOW - 20 * S).toISOString(),
    memory: { total_mb: 65_536, available_pct: 71 },
    disk: { path: "/srv/work", free_gb: 312, free_pct: 64 },
    versions: { peer: "0.3.1", volley: "0.3.1", bun: "1.3.2", git: "2.47.0", claude: "2.1.0" },
    auth: { gh: "ok", claude: "signed_in", trust: "ok" },
    repo: { path: "/srv/work/repo", exists: true, origin: "github.com/example-org/example-repo" },
    checks: [
      { id: "tool.git", ok: true, severity: "block", detail: "git 2.47.0" },
      { id: "claude_on_path", ok: true, severity: "warn", detail: "claude resolves" },
      { id: "volley.version", ok: true, severity: "block", detail: "volley 0.3.1" },
      { id: "repo.clone", ok: true, severity: "block", detail: "clone at /srv/work/repo" },
      { id: "gh.auth", ok: true, severity: "block", detail: "gh can push" },
      { id: "claude.signin", ok: true, severity: "block", detail: "signed in" },
      { id: "claude.trust", ok: true, severity: "warn", detail: "Claude Code trusts the repo" },
      { id: "machine.disk", ok: true, severity: "warn", detail: "312 GB free" },
    ],
    doctor_at: new Date(NOW - 60 * S).toISOString(),
    ...over,
  };
}

export const machineMsg = (
  p: MachinePayload | null,
  name = p?.name ?? "",
  agentId = name,
): DeskMessage => ({
  topic: `volley/_system/machines/${name}`,
  envelope: p === null ? null : env(agentId, "_system/machines", "machine", p, NOW),
  receivedAt: NOW,
  retained: true,
});

/** volleyd's verdict on a machine (SPEC §4.6.15), ready and eligible. */
export function readiness(over: Partial<ReadinessPayload> = {}): ReadinessPayload {
  return {
    name: "box-a",
    ready: true,
    reasons: [],
    drain: false,
    max_agents: 4,
    placed: 2,
    path_ok: { claude: true, bun: true },
    requirements: { volley: "0.3.1" },
    heavy: {},
    usage: { account: "primary@box-a", five_hour_pct: 42 },
    eligible: true,
    checked_at: new Date(NOW - 5 * S).toISOString(),
    ...over,
  };
}

export const readinessMsg = (
  p: ReadinessPayload | null,
  name = p?.name ?? "",
  agentId = "volleyd",
): DeskMessage => ({
  topic: `volley/_system/machines/${name}/readiness`,
  envelope: p === null ? null : env(agentId, "_system/machines/readiness", "readiness", p, NOW),
  receivedAt: NOW,
  retained: true,
});

/** A placement volleyd made at admission: box-a best of three. */
export function placement(over: Partial<TaskPlacement> = {}): TaskPlacement {
  return {
    host: "box-a",
    by: "auto",
    score: 0.82,
    decided_at: new Date(NOW - 10 * 60 * S).toISOString(),
    candidates: [
      {
        host: "box-a",
        score: 0.82,
        line: "box-a: 0.82 (cpu 0.9, slots 0.5, mem 0.71, usage 0.58)",
      },
      { host: "hub", score: 0.61, line: "hub: 0.61 (cpu 0.4, slots 0.75, mem 0.6, usage 0.58)" },
      { host: "box-b", score: null, line: "ineligible: box-b is down (no heartbeat for 90 s)" },
    ],
    ...over,
  };
}

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
