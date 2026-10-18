import { DAEMON_DEFAULTS } from "./config-defaults";

/**
 * Sleep/wake detection and reap re-verification. Pure.
 *
 * The daemon samples a monotonic clock (which stands still while the host sleeps) and the wall
 * clock on every monitor tick. When the wall clock moved more than `wake_jump_ms` further than
 * the monotonic one between two samples, the host slept: `wake_detected`. For `wake_grace_s`
 * after a wake the liveness alarms are held and every `reaped` status (the LWTs a sleep floods
 * the broker with) is held in a pending reap: a heartbeat after the LWT proves the session alive
 * and suppresses the reap for good (`reap_suppressed` — the daemon never republishes `working`
 * for an agent, SPEC linearity: the agent stays supervised and its next status decides), no
 * heartbeat accepts the reap after the grace. The same pending reap applies outside a wake with
 * the daemon's normal reap grace; a wake never shortens it.
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
  /** Accept the reap at this time unless a heartbeat suppresses it first. */
  until: number;
  /** Held because of a wake (journaled on `reap_suppressed`). */
  wake: boolean;
}

export function holdReap(
  agentId: string,
  now: number,
  graceMs: number,
  wake: boolean,
): PendingReap {
  return { agent_id: agentId, reaped_at: now, until: now + graceMs, wake };
}

/** A heartbeat at `at` suppresses the pending reap when it came after the LWT. */
export const heartbeatSuppresses = (p: PendingReap, at: number): boolean => at > p.reaped_at;

export function reapVerdict(p: PendingReap, now: number): "accept" | "hold" {
  return now >= p.until ? "accept" : "hold";
}
