import { readFileSync } from "node:fs";
import type { VolleyBroker } from "volley-mcp/broker";
import { parseEnvelope } from "volley-mcp/envelope";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import type { Host } from "./hosts/host";
import { type ScreenClass, classifyScreen, modelFromScreen } from "./screens";

/**
 * Registration verification through the hooks' own signals (volley-hooks). The daemon subscribes
 * to the agent's registry entry, status and progress BEFORE launching it, then waits for both:
 *
 *   - a `progress` `heartbeat` with `hook_event: "SessionStart"` (the hooks run), and
 *   - a registry entry with `model_source` `harness-hook` or `unknown` (the SessionStart hook's
 *     re-publish; the MCP server's own auto-registration carries no model_source).
 *
 * Expected sequence: MCP auto-registration (no model) → hooks registry re-publish (+ model) →
 * status flipped to `working` → SessionStart heartbeat. If that does not arrive in time, the hooks'
 * own error file is consulted first (a broker that refused their credentials is not a screen
 * problem); only then is the terminal's screen read and classified (screens.ts).
 */

/** Model sources that prove the SessionStart hook ran. */
const HOOK_MODEL_SOURCES = new Set(["harness-hook", "unknown"]);

export interface SignalState {
  /** The latest registry entry the hooks published (has `model_source`), or null. */
  hookRegistry: Record<string, unknown> | null;
  /** `wall_time` of that entry's envelope: a fresh re-publish has a new one, a re-delivery not. */
  hookRegistryAt: string | null;
  /** True once a SessionStart heartbeat arrived. */
  sessionStart: boolean;
  /** The agent's latest retained status (`wall_time` tells a re-delivery from a new one). */
  status: { type: string; payload: unknown; wall_time: string } | null;
  /** Epoch ms of the latest heartbeat. */
  lastHeartbeatAt: number | null;
}

export interface AgentWatch {
  readonly agentId: string;
  readonly namespace: string;
  readonly state: SignalState;
  /** Resolves true as soon as `pred(state)` holds (checked now and on every message), false at timeout. */
  waitFor(pred: (s: SignalState) => boolean, timeoutMs: number): Promise<boolean>;
  /** Called on every status message (after `state` is updated). */
  onStatus(cb: (type: string, payload: unknown) => void): void;
  /** Called with every raw progress message of the agent (after `state` is updated). */
  onProgress(cb: (raw: string) => void): void;
  close(): Promise<void>;
}

export const hookSignalsArrived = (s: SignalState) => s.sessionStart && s.hookRegistry !== null;

/**
 * Subscribes `deliver` to one topic and returns its unsubscribe (`VolleyBroker.subscribeStream`'s
 * shape). The daemon passes a feed off its single `volley/+/+/progress` subscription, so a
 * watch adds no overlapping filter (mosquitto delivers one copy per matching subscription).
 */
export type ProgressFeed = (
  topic: string,
  deliver: (m: { topic: string; payload: string }) => void,
) => Promise<() => Promise<void>>;

/**
 * Subscribe to one agent's registry entry, status and progress (through `progressFeed`, default a
 * subscription of its own). Call before launching it, so no signal can be missed. Messages from
 * any other agent id are ignored.
 */
export async function watchAgent(
  broker: VolleyBroker,
  namespace: string,
  agentId: string,
  now: () => number = Date.now,
  progressFeed: ProgressFeed = (topic, deliver) => broker.subscribeStream(topic, deliver),
): Promise<AgentWatch> {
  const state: SignalState = {
    hookRegistry: null,
    hookRegistryAt: null,
    sessionStart: false,
    status: null,
    lastHeartbeatAt: null,
  };
  const waiters = new Set<() => void>();
  const statusCbs: ((type: string, payload: unknown) => void)[] = [];
  const progressCbs: ((raw: string) => void)[] = [];
  const statusTopic = buildTopic(namespace, agentId, "status");
  const progressTopic = buildTopic(namespace, agentId, "progress");
  const regTopic = registryTopic(agentId);

  const onMessage = ({ topic, payload }: { topic: string; payload: string }) => {
    if (payload === "") return; // a cleared retained record
    const env = parseEnvelope(payload);
    if (env === null || env.agent_id !== agentId) return;
    const p = (env.payload ?? {}) as Record<string, unknown>;
    if (topic === regTopic) {
      if (env.type === "registered" && HOOK_MODEL_SOURCES.has(String(p.model_source))) {
        state.hookRegistry = p;
        state.hookRegistryAt = env.wall_time;
      }
    } else if (topic === statusTopic) {
      state.status = { type: env.type, payload: env.payload, wall_time: env.wall_time };
      for (const cb of statusCbs) cb(env.type, env.payload);
    } else if (topic === progressTopic) {
      if (env.type === "heartbeat") {
        state.lastHeartbeatAt = now();
        if (p.hook_event === "SessionStart") state.sessionStart = true;
      }
      for (const cb of progressCbs) cb(payload);
    }
    for (const w of [...waiters]) w();
  };

  const unsubs = [
    await broker.subscribeStream(regTopic, onMessage),
    await broker.subscribeStream(statusTopic, onMessage),
    await progressFeed(progressTopic, onMessage),
  ];
  let closed = false;
  return {
    agentId,
    namespace,
    state,
    waitFor(pred, timeoutMs) {
      if (pred(state)) return Promise.resolve(true);
      return new Promise((resolve) => {
        const check = () => {
          if (!pred(state)) return;
          done(true);
        };
        const done = (v: boolean) => {
          clearTimeout(timer);
          waiters.delete(check);
          resolve(v);
        };
        const timer = setTimeout(() => done(false), timeoutMs);
        waiters.add(check);
      });
    },
    onStatus(cb) {
      statusCbs.push(cb);
    },
    onProgress(cb) {
      progressCbs.push(cb);
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const u of unsubs) await u().catch(() => {});
    },
  };
}

/**
 * Same model id, ignoring only a context suffix (`claude-x[1m]`) and an 8-digit date suffix
 * (`claude-x-1-2-20261001`). Versions are compared exactly: model ids are dash-separated
 * version numbers, so `claude-opus-5` is NOT `claude-opus-5-5` (no prefix matching).
 */
export function sameModel(actual: string, expected: string): boolean {
  const norm = (m: string) =>
    m
      .trim()
      .toLowerCase()
      .replace(/\[[^\]]*\]$/, "")
      .replace(/-\d{8}$/, "");
  return norm(actual) === norm(expected);
}

export type VerifyResult =
  | {
      kind: "registered";
      model: string | null;
      model_source: "harness-hook" | "unknown";
      /** False when the model could not be established (unknown source, unreadable screen). */
      model_verified: boolean;
      /** True when the established model differs from the expected one. */
      model_mismatch: boolean;
      /** Whether the screen was read (only for the `unknown` model fallback). */
      screen_read: boolean;
    }
  | { kind: "timeout"; screen: string | null; screen_class: ScreenClass }
  /** The broker refused the hooks' CONNECT (`<worktree>/.volley/hooks-error.json`). */
  | { kind: "hooks_auth_failed"; username: string | null; hook_event: string; at: string };

export interface VerifyInput {
  watch: AgentWatch;
  host: Host;
  workspace: string;
  expectedModel: string;
  timeoutMs: number;
  screenLines: number;
  /**
   * `<worktree>/.volley/hooks-error.json`, when the worktree is on this host (volley-hooks writes
   * it on AUTH_FAILED and clears it on the next successful connect).
   */
  hooksErrorPath?: string;
  /** Epoch ms of the launch: an older error file is left over from an earlier session. */
  launchedAt?: number;
}

/** The hooks' AUTH_FAILED record at `path`, if it is there and from this launch. */
export function readHooksError(
  path: string,
  since = 0,
): { username: string | null; hook_event: string; at: string } | null {
  let e: { code?: unknown; at?: unknown; hook_event?: unknown; username?: unknown };
  try {
    e = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
  if (e?.code !== "AUTH_FAILED" || typeof e.at !== "string") return null;
  const at = Date.parse(e.at);
  if (Number.isNaN(at) || at < since) return null;
  return {
    username: typeof e.username === "string" ? e.username : null,
    hook_event: typeof e.hook_event === "string" ? e.hook_event : "",
    at: e.at,
  };
}

/**
 * Wait for the hook signals. Registered → check the model (the registry's, or for
 * `model_source: "unknown"` the status line on screen). Timeout → read and classify the screen.
 */
export async function verifyRegistration(v: VerifyInput): Promise<VerifyResult> {
  const ok = await v.watch.waitFor(hookSignalsArrived, v.timeoutMs);
  if (!ok) {
    const refused =
      v.hooksErrorPath !== undefined ? readHooksError(v.hooksErrorPath, v.launchedAt) : null;
    if (refused !== null) return { kind: "hooks_auth_failed", ...refused };
    const screen = await v.host.readScreen(v.workspace, v.screenLines);
    return { kind: "timeout", screen, screen_class: classifyScreen(screen) };
  }
  const reg = v.watch.state.hookRegistry as Record<string, unknown>;
  if (reg.model_source === "harness-hook" && typeof reg.model === "string") {
    return {
      kind: "registered",
      model: reg.model,
      model_source: "harness-hook",
      model_verified: true,
      model_mismatch: !sameModel(reg.model, v.expectedModel),
      screen_read: false,
    };
  }
  const model = modelFromScreen(await v.host.readScreen(v.workspace, v.screenLines));
  return {
    kind: "registered",
    model,
    model_source: "unknown",
    model_verified: model !== null,
    model_mismatch: model !== null && !sameModel(model, v.expectedModel),
    screen_read: true,
  };
}
