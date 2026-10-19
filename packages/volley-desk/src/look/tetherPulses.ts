/**
 * The tethers' moving parts (D10), pure so they test without a browser:
 *
 * - `PulsePool`: an energy pulse runs along an agent's tether each time the
 *   agent publishes `progress` (its `progressBeat` changes). At most `max`
 *   run at once (the oldest is dropped) and each is retired after `PULSE_MS`.
 * - The sway: dragging a window kicks a damped spring on the sag of each of
 *   its tethers; `stepSway` runs it a frame at a time until `swaySettled`.
 *   The spring is under-damped, so the cable overshoots and settles well
 *   within `SWAY.settleMs`.
 */
import type { FeedEntry } from "../store/types";
import { feedChannel } from "../windows/agent/Feed";

/** How long a pulse takes from the wave window to the agent window. */
export const PULSE_MS = 1100;
/** The most pulses in flight at once, across every tether. */
export const MAX_PULSES = 24;

export interface Pulse {
  id: number;
  agent: string;
  /** `performance.now()` when it set off. */
  at: number;
}

export class PulsePool {
  private pulses: Pulse[] = [];
  private nextId = 0;

  constructor(
    readonly max: number = MAX_PULSES,
    readonly duration: number = PULSE_MS,
  ) {}

  add(agent: string, now: number): Pulse {
    const pulse = { id: this.nextId++, agent, at: now };
    this.pulses.push(pulse);
    if (this.pulses.length > this.max) this.pulses.splice(0, this.pulses.length - this.max);
    return pulse;
  }

  /** Drops the pulses whose run is over; `true` when any was. */
  retire(now: number): boolean {
    const before = this.pulses.length;
    this.pulses = this.pulses.filter((p) => now - p.at < this.duration);
    return this.pulses.length !== before;
  }

  /** When the oldest pulse in flight ends, or `null` with none. */
  nextEnd(): number | null {
    const first = this.pulses[0];
    return first ? first.at + this.duration : null;
  }

  list(): readonly Pulse[] {
    return this.pulses;
  }
}

/** The sway spring: angular frequency (rad/s), damping ratio, kick per px moved, bound (px). */
export const SWAY = {
  omega: 9,
  zeta: 0.3,
  impulse: 6,
  max: 36,
  settleMs: 2500,
} as const;

/** The sway of one tether: sag offset `x` (px, + is down) and its velocity `v` (px/s). */
export interface Sway {
  x: number;
  v: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const VMAX = SWAY.max * SWAY.omega;

/** A drag moved the tether's ends by (dx, dy): the cable lags behind and swings. */
export function kickSway(s: Sway | undefined, dx: number, dy: number): Sway {
  const cur = s ?? { x: 0, v: 0 };
  return { x: cur.x, v: clamp(cur.v + SWAY.impulse * (Math.abs(dx) + dy), -VMAX, VMAX) };
}

/** Advances the spring by `dtMs` (in ≤ 16 ms sub-steps; a long frame is capped). */
export function stepSway(s: Sway, dtMs: number): Sway {
  let { x, v } = s;
  let left = Math.min(dtMs, 250) / 1000;
  const k = SWAY.omega * SWAY.omega;
  const c = 2 * SWAY.zeta * SWAY.omega;
  while (left > 0) {
    const h = Math.min(left, 0.016);
    v += (-k * x - c * v) * h;
    x += v * h;
    left -= h;
  }
  return { x: clamp(x, -SWAY.max, SWAY.max), v };
}

export const swaySettled = (s: Sway): boolean => Math.abs(s.x) < 0.25 && Math.abs(s.v) < 3;

/** When the agent's latest `progress` envelope arrived: a new value is a new pulse. */
export function progressBeat(feed: readonly FeedEntry[]): number | null {
  for (let i = feed.length - 1; i >= 0; i--) {
    const e = feed[i] as FeedEntry;
    if (feedChannel(e) === "progress") return e.receivedAt;
  }
  return null;
}
