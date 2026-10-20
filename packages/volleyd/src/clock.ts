import { DAEMON_DEFAULTS } from "./config-defaults";

/**
 * The daemon's clock and timer scheduler. Every timer in volleyd (spawn backoff, ticks, reap
 * graces, verification windows, tunnel restarts, screen captures, sweeps) and every wall-clock read
 * goes through a `Clock` — the only place real timers live is `systemClock` below (a grep-guard
 * test enforces it). Tests inject a fake one (test/helpers/fake-clock.ts) and move time by hand,
 * so daemon timing never races the machine's load.
 */

declare const timerBrand: unique symbol;
/** An armed timer, as returned by `Clock.setTimeout` / `Clock.setInterval`. */
export type TimerHandle = { readonly [timerBrand]: true };

export interface Clock {
  /** Wall-clock epoch ms. */
  now(): number;
  /** Monotonic ms (does not advance while the host sleeps). */
  mono(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle | undefined): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle | undefined): void;
}

type RealHandle = ReturnType<typeof setTimeout>;

/** Real timers and the machine's clocks. */
export const systemClock: Clock = {
  now: () => Date.now(),
  mono: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as TimerHandle,
  clearTimeout: (h) => clearTimeout(h as unknown as RealHandle | undefined),
  setInterval: (fn, ms) => setInterval(fn, ms) as unknown as TimerHandle,
  clearInterval: (h) => clearInterval(h as unknown as RealHandle | undefined),
};

/** `clock` with its wall clock read from `now` instead (an injected `now` beside a clock). */
export const withNow = (clock: Clock, now: (() => number) | undefined): Clock =>
  now === undefined ? clock : { ...clock, now };

/** Resolves after `ms` on `clock`, or at once when `signal` aborts. */
export function sleep(clock: Clock, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = clock.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clock.clearTimeout(t);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** The wall clock as a Date. */
export const dateOf = (clock: Clock): Date => new Date(clock.now());

/** One sleep/wake sample of `clock` (sampleClock below). */
export const sampleOf = (clock: Clock): ClockSample => ({ mono: clock.mono(), wall: clock.now() });

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
