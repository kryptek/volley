import { DAEMON_DEFAULTS } from "./config-defaults";

/**
 * Sleep/wake detection and reap re-verification. Pure.
 *
 * The daemon samples a monotonic clock (which stands still while the host sleeps) and the wall
 * clock on every monitor tick. When the wall clock moved more than `wake_jump_ms` further than
 * the monotonic one between two samples, the host slept: `wake_detected`. For `wake_grace_s`
 * after a wake the liveness alarms are held and every `reaped` status (the LWTs a sleep floods
 * the broker with) is held in a pending reap: a heartbeat within the grace keeps the agent
 * (`reap_suppressed` — the daemon never republishes `working` for an agent, SPEC linearity: the
 * agent's own hooks clear it), no heartbeat accepts the reap. Outside a wake the same pending
 * reap applies with the daemon's normal reap grace.
 */

export interface ClockSample {
  /** Monotonic ms (does not advance while the host sleeps). */
  mono: number;
  /** Wall-clock epoch ms. */
  wall: number;
}

export interface ClockState {
  last: ClockSample | null;
  /** The latest wake: when (wall ms) and how far the wall clock jumped. */
  wake: { at: number; jump_ms: number } | null;
}

export const initialClock = (): ClockState => ({ last: null, wake: null });

/** Fold one sample; `wake` is set when this sample detected a wake. */
export function sampleClock(
  state: ClockState,
  sample: ClockSample,
  jumpMs: number = DAEMON_DEFAULTS.wake_jump_ms,
): { state: ClockState; wake: { at: number; jump_ms: number } | null } {
  const last = state.last;
  if (last !== null) {
    const jump = sample.wall - last.wall - (sample.mono - last.mono);
    if (jump > jumpMs) {
      const wake = { at: sample.wall, jump_ms: jump };
      return { state: { last: sample, wake }, wake };
    }
  }
  return { state: { ...state, last: sample }, wake: null };
}

/** Whether `now` (wall ms) is within `graceS` seconds after the latest wake. */
export function inWakeGrace(state: ClockState, now: number, graceS: number): boolean {
  return state.wake !== null && now - state.wake.at < graceS * 1000;
}

/** A `reaped` status held for re-verification. */
export interface PendingReap {
  agent_id: string;
  reaped_at: number;
  /** Accept the reap at this time unless a heartbeat moves it. */
  until: number;
  /** Held because of a wake (journaled on `reap_suppressed`). */
  wake: boolean;
  /** When the first heartbeat after the LWT arrived (null: none yet). */
  suppressed_at: number | null;
}

export function holdReap(
  agentId: string,
  now: number,
  graceMs: number,
  wake: boolean,
): PendingReap {
  return { agent_id: agentId, reaped_at: now, until: now + graceMs, wake, suppressed_at: null };
}

/**
 * A heartbeat from the agent while its reap is pending. One after the LWT suppresses the reap
 * (`suppressed` is true the first time only, so it is journaled once) and restarts the grace.
 */
export function heartbeatDuringReap(
  p: PendingReap,
  at: number,
  graceMs: number,
): { pending: PendingReap; suppressed: boolean } {
  if (at <= p.reaped_at) return { pending: p, suppressed: false };
  return {
    pending: { ...p, until: Math.max(p.until, at + graceMs), suppressed_at: p.suppressed_at ?? at },
    suppressed: p.suppressed_at === null,
  };
}

export function reapVerdict(p: PendingReap, now: number): "accept" | "hold" {
  return now >= p.until ? "accept" : "hold";
}
