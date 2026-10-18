import { afterEach, describe, expect, it } from "vitest";
import {
  type ClockState,
  heartbeatDuringReap,
  holdReap,
  inWakeGrace,
  reapVerdict,
  sampleClock,
} from "../src/clock";
import {
  AGENT,
  type SupervisedEnv,
  makeSupervisedEnv,
  systemJournal,
} from "./helpers/supervised-env";

const T0 = Date.parse("2026-10-18T12:00:00.000Z");
const S = 1000;

describe("sampleClock: monotonic vs wall clock", () => {
  it("a steady 10 s cadence is no wake; an injected 300 s jump is", () => {
    let st: ClockState = { last: null, wake: null };
    let r = sampleClock(st, { mono: 0, wall: T0 });
    expect(r.wake).toBeNull();
    st = r.state;
    r = sampleClock(st, { mono: 10 * S, wall: T0 + 10 * S });
    expect(r.wake).toBeNull();
    st = r.state;
    // The host slept: the monotonic clock stood still while the wall clock moved 300 s.
    r = sampleClock(st, { mono: 20 * S, wall: T0 + 320 * S });
    expect(r.wake).toEqual({ at: T0 + 320 * S, jump_ms: 300 * S });
    expect(r.state.wake).toEqual({ at: T0 + 320 * S, jump_ms: 300 * S });
  });

  it("a jump of 60 s or less is clock jitter, not a wake", () => {
    const st = sampleClock({ last: null, wake: null }, { mono: 0, wall: T0 }).state;
    expect(sampleClock(st, { mono: 10 * S, wall: T0 + 70 * S }).wake).toBeNull();
    expect(sampleClock(st, { mono: 10 * S, wall: T0 + 71 * S }).wake).not.toBeNull();
  });

  it("the wake grace lasts wake_grace_s after the wake", () => {
    const st: ClockState = { last: null, wake: { at: T0, jump_ms: 300 * S } };
    expect(inWakeGrace(st, T0 + 119 * S, 120)).toBe(true);
    expect(inWakeGrace(st, T0 + 121 * S, 120)).toBe(false);
    expect(inWakeGrace({ last: null, wake: null }, T0, 120)).toBe(false);
  });
});

describe("pending reaps", () => {
  it("a reaped within grace for an agent whose heartbeat arrives 20 s later → reap_suppressed", () => {
    const p = holdReap(AGENT, T0, 120 * S, true);
    expect(reapVerdict(p, T0 + 60 * S)).toBe("hold");
    const r = heartbeatDuringReap(p, T0 + 20 * S, 120 * S);
    expect(r.suppressed).toBe(true);
    // Suppressed once: a later heartbeat keeps it suppressed without a second record.
    expect(heartbeatDuringReap(r.pending, T0 + 30 * S, 120 * S).suppressed).toBe(false);
    expect(reapVerdict(r.pending, T0 + 125 * S)).toBe("hold");
  });

  it("no heartbeat → the reap is accepted after the grace", () => {
    const p = holdReap(AGENT, T0, 120 * S, true);
    expect(reapVerdict(p, T0 + 119 * S)).toBe("hold");
    expect(reapVerdict(p, T0 + 120 * S)).toBe("accept");
  });

  it("a heartbeat from before the LWT does not suppress it", () => {
    const p = holdReap(AGENT, T0, 120 * S, true);
    expect(heartbeatDuringReap(p, T0 - S, 120 * S).suppressed).toBe(false);
    expect(reapVerdict(p, T0 + 120 * S)).toBe("accept");
  });
});

describe("daemon: sleep/wake and reap suppression", () => {
  let s: SupervisedEnv;
  afterEach(async () => {
    await s.cleanup();
  });

  /** A controllable clock: `sleep(ms)` moves the wall clock only. */
  function fakeClock() {
    let mono = 0;
    let wall = Date.now();
    return {
      read: () => ({ mono, wall }),
      advance: (ms: number) => {
        mono += ms;
        wall += ms;
      },
      sleep: (ms: number) => {
        wall += ms;
      },
    };
  }

  it("journals wake_detected; a reaped agent that heartbeats within the grace is kept (reap_suppressed)", async () => {
    const clock = fakeClock();
    s = await makeSupervisedEnv({
      config: "wake_grace_s: 2",
      reapGraceMs: 60_000,
      daemon: { clock: clock.read },
    });
    await s.daemon.tick();
    clock.advance(10_000);
    clock.sleep(300_000);
    await s.daemon.tick();
    expect(systemJournal(s.env).find((e) => e.type === "wake_detected")?.data).toMatchObject({
      jump_ms: 300_000,
    });
    // The flood of LWTs after the wake: this agent is fine and heartbeats on its next tool call.
    await s.status("reaped", { reason: "lwt" });
    await new Promise((r) => setTimeout(r, 100));
    await s.hook("heartbeat.json");
    await s.until(() => s.journal().some((e) => e.type === "reap_suppressed"));
    expect(s.journal().find((e) => e.type === "reap_suppressed")?.data).toMatchObject({
      agent_id: AGENT,
      wake: true,
    });
    await new Promise((r) => setTimeout(r, 2500));
    expect(s.journal().some((e) => e.type === "agent_retired")).toBe(false);
  });

  it("a reaped agent that stays quiet through the wake grace is retired after it", async () => {
    const clock = fakeClock();
    s = await makeSupervisedEnv({
      config: "wake_grace_s: 1",
      reapGraceMs: 60_000,
      daemon: { clock: clock.read },
    });
    await s.daemon.tick();
    clock.advance(10_000);
    clock.sleep(300_000);
    await s.daemon.tick();
    await s.status("reaped", { reason: "lwt" });
    // The wake grace (1 s), not the normal 60 s reap grace, applies.
    await s.until(() => s.journal().some((e) => e.type === "agent_retired"), 4000);
    expect(s.journal().find((e) => e.type === "agent_retired")?.data).toMatchObject({
      agent_id: AGENT,
      status: "reaped",
    });
    expect(s.journal().some((e) => e.type === "reap_suppressed")).toBe(false);
  });
});
