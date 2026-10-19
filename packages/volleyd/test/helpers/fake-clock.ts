import type { Clock, TimerHandle } from "../../src/clock";

/**
 * A virtual `Clock` for the daemon (DaemonOptions.clock): its timers fire only when the test
 * moves time, in due order, with pending microtasks (promise continuations) flushed after each one.
 * Nothing global is faked, so the MQTT client and the in-process Aedes broker keep running on real
 * I/O while every daemon timer — ticks, backoffs, reap graces, verification windows — is virtual.
 */
export interface FakeClock extends Clock {
  /** Move both clocks `ms` on, running every timer that falls due on the way, in order. */
  advance(ms: number): Promise<void>;
  /** Move to `wall` (epoch ms, not before now), running the timers due on the way. */
  advanceTo(wall: number): Promise<void>;
  /** Jump exactly to the next due timer and run it (and any due at that same instant). */
  advanceToNext(): Promise<number | null>;
  /** The host sleeps `ms`: the wall clock jumps, the monotonic clock stands still, no timer runs. */
  sleepHost(ms: number): void;
  /** Armed timers (intervals count once). */
  pending(): number;
  /** The delay of the next due timer from now, or null when none is armed. */
  nextDue(): number | null;
  /**
   * Resolves once a timer of exactly `ms` (any timer, without `ms`) is armed — at once if one
   * already is: the sync point between "the daemon consumed a message" and "move time past what
   * it scheduled".
   */
  armed(ms?: number): Promise<void>;
}

interface Timer {
  id: number;
  ms: number;
  due: number;
  fn: () => void;
  every: number | null;
}

/** Let every pending promise continuation run (several macrotask turns: chains settle). */
export async function flushMicrotasks(turns = 3): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setImmediate(r));
}

export function fakeClock(startWall = Date.parse("2026-10-18T12:00:00.000Z")): FakeClock {
  let wall = startWall;
  let mono = 0;
  let nextId = 1;
  const timers = new Map<number, Timer>();
  const armWaiters = new Set<{ ms: number | undefined; resolve: () => void }>();
  const handle = (id: number) => ({ id }) as unknown as TimerHandle;
  const idOf = (h: TimerHandle | undefined) => (h as unknown as { id: number } | undefined)?.id;
  const arm = (fn: () => void, ms: number, every: number | null): TimerHandle => {
    const id = nextId++;
    timers.set(id, { id, ms, due: mono + Math.max(0, ms), fn, every });
    for (const w of armWaiters) {
      if (w.ms !== undefined && w.ms !== ms) continue;
      armWaiters.delete(w);
      w.resolve();
    }
    return handle(id);
  };
  const clear = (h: TimerHandle | undefined) => {
    const id = idOf(h);
    if (id !== undefined) timers.delete(id);
  };
  /** The earliest timer due at or before `limit` (mono ms), oldest first on a tie. */
  const next = (limit: number): Timer | undefined => {
    let best: Timer | undefined;
    for (const t of timers.values()) {
      if (t.due > limit) continue;
      if (best === undefined || t.due < best.due || (t.due === best.due && t.id < best.id)) {
        best = t;
      }
    }
    return best;
  };
  const fire = async (t: Timer) => {
    if (t.every === null) timers.delete(t.id);
    else t.due += Math.max(1, t.every);
    t.fn();
    await flushMicrotasks();
  };
  const run = async (ms: number) => {
    const target = mono + Math.max(0, ms);
    for (let t = next(target); t !== undefined; t = next(target)) {
      wall += t.due - mono;
      mono = t.due;
      await fire(t);
    }
    wall += target - mono;
    mono = target;
    await flushMicrotasks();
  };

  return {
    now: () => wall,
    mono: () => mono,
    setTimeout: (fn, ms) => arm(fn, ms, null),
    clearTimeout: clear,
    setInterval: (fn, ms) => arm(fn, ms, ms),
    clearInterval: clear,
    advance: run,
    advanceTo: (to) => run(to - wall),
    async advanceToNext() {
      const t = next(Number.POSITIVE_INFINITY);
      if (t === undefined) return null;
      const by = t.due - mono;
      await run(by);
      return by;
    },
    sleepHost(ms) {
      wall += ms;
    },
    pending: () => timers.size,
    nextDue() {
      const t = next(Number.POSITIVE_INFINITY);
      return t === undefined ? null : t.due - mono;
    },
    armed(ms) {
      if ([...timers.values()].some((t) => ms === undefined || t.ms === ms)) {
        return Promise.resolve();
      }
      return new Promise((resolve) => armWaiters.add({ ms, resolve }));
    },
  };
}
