import { buildEnvelope } from "volley-mcp/envelope";
import { buildTopic } from "volley-mcp/topics";
import { DAEMON_DEFAULTS } from "./config-defaults";
import { DAEMON_AGENT_ID } from "./control";
import type { Host } from "./hosts/host";
import { screenHash, screenTail } from "./screen-tail";

/**
 * Per-agent screen tails (SPEC §4.6.6). The daemon is the only process that reads agents'
 * terminals: every `screen_tail_interval_s` it reads each live agent's workspace through its
 * host, cuts the tail (`screenTail`), and publishes it retained on `volley/<ns>/<agent>/screen`
 * (QoS 0) only when the hash changed, so a late-attaching Desk sees the current screen at once.
 * Every capture is also emitted in-process (`onCapture`) for consumers that need the screen
 * without reading it again. A read slower than `screen_slow_ms`, or `screen_max_failures` failed
 * reads in a row, backs the agent off to `screen_backoff_s` and marks it stale until a good read.
 */

/** The `screen` channel payload (screen.schema.json). */
export interface ScreenPayload {
  lines: string[];
  captured_at: string;
  workspace: string;
  hash: string;
  source: string;
}

/** One live agent whose terminal is captured. */
export interface ScreenTarget {
  agentId: string;
  namespace: string;
  workspace: string;
  host: Host;
  /** Capture mechanism for `payload.source`: `cmux` locally, `tmux` on remote hosts. */
  source: string;
  /** Seconds between captures; read on every capture, so a config change applies at once. */
  intervalS: () => number;
}

/** One capture, as emitted to `onCapture` listeners. */
export interface ScreenCapture {
  agentId: string;
  workspace: string;
  /** The raw screen as read, or null when the read failed. */
  screen: string | null;
  /** The published payload's content (null when the read failed). */
  tail: ScreenPayload | null;
  /** True when the tail differed from the last one and was published. */
  changed: boolean;
  stale: boolean;
}

export interface ScreenPublisherDeps {
  /** Publish a retained QoS 0 message. */
  publish: (topic: string, payload: string) => Promise<void>;
  now?: () => number;
  /** Called when an agent's capture becomes stale or recovers. */
  onStale?: (agentId: string, stale: boolean) => void;
  log?: (line: string) => void;
}

interface Tracked {
  target: ScreenTarget;
  nextAt: number;
  lastHash: string | null;
  failures: number;
  stale: boolean;
  inflight: Promise<void> | null;
}

export class ScreenPublisher {
  private readonly agents = new Map<string, Tracked>();
  private readonly listeners = new Set<(c: ScreenCapture) => void>();
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: ScreenPublisherDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
  }

  /** Start capturing an agent; its first capture is due at the next tick. */
  track(target: ScreenTarget): void {
    this.agents.set(target.agentId, {
      target,
      nextAt: this.now(),
      lastHash: null,
      failures: 0,
      stale: false,
      inflight: null,
    });
  }

  /** Stop capturing an agent, after any in-flight capture (so a later clear is the last word). */
  async untrack(agentId: string): Promise<void> {
    const a = this.agents.get(agentId);
    this.agents.delete(agentId);
    await a?.inflight;
  }

  /** Stop capturing every agent (daemon halt); in-flight captures finish but publish nothing new. */
  clear(): void {
    this.agents.clear();
  }

  isStale(agentId: string): boolean {
    return this.agents.get(agentId)?.stale === true;
  }

  /** Listen to every capture. Returns the unsubscribe function. */
  onCapture(cb: (c: ScreenCapture) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Capture every agent that is due and not already being captured, concurrently. */
  async tick(): Promise<void> {
    const now = this.now();
    const due = [...this.agents.values()].filter((a) => a.inflight === null && a.nextAt <= now);
    await Promise.all(
      due.map((a) => {
        a.inflight = this.capture(a).finally(() => {
          a.inflight = null;
        });
        return a.inflight;
      }),
    );
  }

  private async capture(a: Tracked): Promise<void> {
    const { target } = a;
    const started = this.now();
    const screen = await target.host
      .readScreen(target.workspace, DAEMON_DEFAULTS.screen_capture_lines)
      .catch(() => null);
    const finished = this.now();
    const slow = finished - started > DAEMON_DEFAULTS.screen_slow_ms;
    a.failures = screen === null ? a.failures + 1 : 0;
    this.setStale(a, slow || a.failures >= DAEMON_DEFAULTS.screen_max_failures);
    const delayS = a.stale ? DAEMON_DEFAULTS.screen_backoff_s : target.intervalS();
    a.nextAt = finished + delayS * 1000;

    let tail: ScreenPayload | null = null;
    let changed = false;
    if (screen !== null) {
      const lines = screenTail(screen, DAEMON_DEFAULTS.screen_tail_lines);
      tail = {
        lines,
        captured_at: new Date(finished).toISOString(),
        workspace: target.workspace,
        hash: screenHash(lines),
        source: target.source,
      };
      // An agent untracked mid-read (retired) publishes nothing: its topic is being cleared.
      if (tail.hash !== a.lastHash && this.agents.get(target.agentId) === a) {
        changed = true;
        a.lastHash = tail.hash;
        await this.deps
          .publish(
            buildTopic(target.namespace, target.agentId, "screen"),
            JSON.stringify(
              buildEnvelope({
                agentId: DAEMON_AGENT_ID,
                parentId: null,
                channel: "screen",
                type: "screen_tail",
                payload: tail,
              }),
            ),
          )
          .catch((e: unknown) => {
            a.lastHash = null; // retry on the next capture
            this.log(`screen ${target.agentId}: ${e instanceof Error ? e.message : String(e)}`);
          });
      }
    }
    const c: ScreenCapture = {
      agentId: target.agentId,
      workspace: target.workspace,
      screen,
      tail,
      changed,
      stale: a.stale,
    };
    for (const cb of this.listeners) {
      try {
        cb(c);
      } catch (e) {
        this.log(`screen listener: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private setStale(a: Tracked, stale: boolean): void {
    if (a.stale === stale) return;
    a.stale = stale;
    if (this.agents.get(a.target.agentId) === a) this.deps.onStale?.(a.target.agentId, stale);
  }
}
