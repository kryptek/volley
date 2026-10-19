import { buildEnvelope } from "volley-mcp/envelope";
import { buildTopic } from "volley-mcp/topics";
import { type Clock, type TimerHandle, systemClock, withNow } from "./clock";
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
 * without reading it again. A read slower than `screen_slow_ms` (marked stale the moment that
 * passes, not when the read returns), or `screen_max_failures` failed reads in a row, backs the
 * agent off to `screen_backoff_s` and marks it stale until a read succeeds in time. Every read is
 * bounded by `screen_read_timeout_ms`: one still pending then counts as failed, so a hung host
 * never holds a capture (or `untrack`, or the daemon's retire) forever.
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
  /** Capture mechanism for `payload.source`; default the host's (`cmux` local, `tmux` remote). */
  source?: string;
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
  /** Timers and wall clock (default: real). */
  clock?: Clock;
  /** Wall clock override on top of `clock`. */
  now?: () => number;
  /** Called when an agent's capture becomes stale or recovers. */
  onStale?: (agentId: string, stale: boolean) => void;
  log?: (line: string) => void;
  /** Overrides of DAEMON_DEFAULTS `screen_slow_ms` / `screen_read_timeout_ms` (tests). */
  slowMs?: number;
  readTimeoutMs?: number;
}

interface Tracked {
  target: ScreenTarget;
  nextAt: number;
  lastHash: string | null;
  failures: number;
  stale: boolean;
  inflight: Promise<void> | null;
  /** The retained publish in flight, if any (never rejects). */
  publishing: Promise<void> | null;
}

export class ScreenPublisher {
  private readonly agents = new Map<string, Tracked>();
  private readonly listeners = new Set<(c: ScreenCapture) => void>();
  private readonly clock: Clock;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly slowMs: number;
  private readonly readTimeoutMs: number;

  constructor(private readonly deps: ScreenPublisherDeps) {
    this.clock = withNow(deps.clock ?? systemClock, deps.now);
    this.now = this.clock.now;
    this.log = deps.log ?? (() => {});
    this.slowMs = deps.slowMs ?? DAEMON_DEFAULTS.screen_slow_ms;
    this.readTimeoutMs = deps.readTimeoutMs ?? DAEMON_DEFAULTS.screen_read_timeout_ms;
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
      publishing: null,
    });
  }

  /**
   * Stop capturing an agent, after any publish already in flight (so a later clear is the last
   * word). A read still in flight is not waited for: once untracked it publishes nothing.
   */
  async untrack(agentId: string): Promise<void> {
    const a = this.agents.get(agentId);
    this.agents.delete(agentId);
    await a?.publishing;
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
    let slowFired = false;
    let timedOut = false;
    let slowTimer: TimerHandle | undefined;
    let hardTimer: TimerHandle | undefined;
    const screen = await new Promise<string | null>((resolve) => {
      slowTimer = this.clock.setTimeout(() => {
        slowFired = true;
        this.setStale(a, true);
      }, this.slowMs);
      hardTimer = this.clock.setTimeout(() => {
        timedOut = true;
        resolve(null);
      }, this.readTimeoutMs);
      target.host
        .readScreen(target.workspace, DAEMON_DEFAULTS.screen_capture_lines)
        .then(resolve, () => resolve(null));
    }).finally(() => {
      this.clock.clearTimeout(slowTimer);
      this.clock.clearTimeout(hardTimer);
    });
    if (timedOut) this.log(`screen ${target.agentId}: read timed out`);
    const finished = this.now();
    const slow = slowFired || finished - started > this.slowMs;
    a.failures = screen === null ? a.failures + 1 : 0;
    // Only a read that succeeds in time clears a stale capture.
    this.setStale(
      a,
      slow || a.failures >= DAEMON_DEFAULTS.screen_max_failures || (a.stale && screen === null),
    );
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
        source: target.source ?? target.host.screenSource ?? "cmux",
      };
      // An agent untracked mid-read (retired) publishes nothing: its topic is being cleared.
      if (tail.hash !== a.lastHash && this.agents.get(target.agentId) === a) {
        changed = true;
        a.lastHash = tail.hash;
        a.publishing = this.deps
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
            changed = false;
            this.log(`screen ${target.agentId}: ${e instanceof Error ? e.message : String(e)}`);
          });
        await a.publishing;
        a.publishing = null;
      }
    }
    // An agent untracked (retired) or cleared (daemon halt) mid-capture is gone: tell no one.
    if (this.agents.get(target.agentId) !== a) return;
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
