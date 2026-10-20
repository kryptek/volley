/**
 * The tether model's pure parts (D10): the pulse pool (one pulse per
 * `progress`, capped, oldest dropped, retired after its run), the damped sway
 * a drag starts, and the progress beat a pulse is keyed on.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_PULSES,
  PULSE_MS,
  PulsePool,
  SWAY,
  type Sway,
  kickSway,
  progressBeat,
  stepSway,
  swaySettled,
} from "../src/look/tetherPulses";
import type { Envelope, FeedEntry } from "../src/store/types";

const T0 = 1_000_000;

function entry(channel: string, at: number, type = "narration"): FeedEntry {
  const envelope: Envelope = {
    schema_version: "0.1",
    agent_id: "x",
    wall_time: new Date(at).toISOString(),
    channel,
    type,
    payload: {},
  };
  return { topic: `volley/demo/x/${channel}`, envelope, receivedAt: at };
}

describe("PulsePool", () => {
  it("a progress beat enqueues one pulse on that agent's tether", () => {
    const pool = new PulsePool();
    pool.add("x", T0);
    expect(pool.list()).toHaveLength(1);
    expect(pool.list()[0]).toMatchObject({ agent: "x", at: T0 });
    pool.add("y", T0 + 5);
    expect(pool.list().map((p) => p.agent)).toEqual(["x", "y"]);
    // Every pulse has its own id, so React keys stay stable.
    expect(new Set(pool.list().map((p) => p.id)).size).toBe(2);
  });

  it("caps the concurrent pulses and drops the oldest", () => {
    const pool = new PulsePool(3);
    for (let i = 0; i < 5; i++) pool.add(`a${i}`, T0 + i);
    expect(pool.list().map((p) => p.agent)).toEqual(["a2", "a3", "a4"]);
    expect(new PulsePool().max).toBe(MAX_PULSES);
    expect(MAX_PULSES).toBeGreaterThanOrEqual(8);
  });

  it("retires pulses after their duration and says when the next one ends", () => {
    const pool = new PulsePool();
    pool.add("x", T0);
    pool.add("y", T0 + 300);
    expect(pool.nextEnd()).toBe(T0 + PULSE_MS);
    expect(pool.retire(T0 + PULSE_MS - 1)).toBe(false);
    expect(pool.list()).toHaveLength(2);
    expect(pool.retire(T0 + PULSE_MS)).toBe(true);
    expect(pool.list().map((p) => p.agent)).toEqual(["y"]);
    expect(pool.retire(T0 + 300 + PULSE_MS)).toBe(true);
    expect(pool.list()).toHaveLength(0);
    expect(pool.nextEnd()).toBeNull();
  });
});

describe("sway", () => {
  /** Runs the spring in 16 ms frames until it settles; returns the time and the peaks. */
  function settle(s: Sway): { ms: number; peaks: number[] } {
    let t = 0;
    let cur = s;
    const peaks: number[] = [];
    let prev = cur.x;
    let rising = true;
    while (!swaySettled(cur) && t < 10_000) {
      cur = stepSway(cur, 16);
      t += 16;
      const up = Math.abs(cur.x) > Math.abs(prev);
      if (rising && !up) peaks.push(Math.abs(prev));
      rising = up;
      prev = cur.x;
    }
    return { ms: t, peaks };
  }

  it("a drag kicks the cable, which swings and settles (damped) within the configured time", () => {
    const s = kickSway(undefined, 40, 25);
    expect(s.v).not.toBe(0);
    const { ms, peaks } = settle(s);
    expect(ms).toBeLessThanOrEqual(SWAY.settleMs);
    // It overshoots at least once and every swing is smaller than the last.
    expect(peaks.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < peaks.length; i++) expect(peaks[i]).toBeLessThan(peaks[i - 1] as number);
  });

  it("the swing is bounded however hard the window is flung", () => {
    let s: Sway | undefined;
    for (let i = 0; i < 50; i++) s = kickSway(s, 400, 400);
    let max = 0;
    let cur = s as Sway;
    for (let i = 0; i < 200; i++) {
      cur = stepSway(cur, 16);
      max = Math.max(max, Math.abs(cur.x));
    }
    expect(max).toBeLessThanOrEqual(SWAY.max);
    expect(settle(s as Sway).ms).toBeLessThanOrEqual(SWAY.settleMs);
  });

  it("a long frame (a background tab) does not blow the spring up", () => {
    const s = stepSway(kickSway(undefined, 30, 0), 5_000);
    expect(Number.isFinite(s.x)).toBe(true);
    expect(Math.abs(s.x)).toBeLessThanOrEqual(SWAY.max);
  });
});

describe("progressBeat", () => {
  it("is the receipt time of the agent's latest progress envelope", () => {
    expect(progressBeat([])).toBeNull();
    expect(progressBeat([entry("status", T0, "working")])).toBeNull();
    expect(
      progressBeat([entry("progress", T0), entry("progress", T0 + 9), entry("status", T0 + 20)]),
    ).toBe(T0 + 9);
  });
});
