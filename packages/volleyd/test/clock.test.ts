import { afterEach, describe, expect, it } from "vitest";
import { buildEnvelope } from "volley-mcp/envelope";
import { buildTopic } from "volley-mcp/topics";
import {
  type ClockState,
  heartbeatSuppresses,
  holdReap,
  inWakeGrace,
  reapVerdict,
  sampleClock,
} from "../src/clock";
import { NS } from "./helpers/daemon-env";
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
    expect(heartbeatSuppresses(p, T0 + 20 * S)).toBe(true);
  });

  it("no heartbeat → the reap is accepted after the grace", () => {
    const p = holdReap(AGENT, T0, 120 * S, true);
    expect(reapVerdict(p, T0 + 119 * S)).toBe("hold");
    expect(reapVerdict(p, T0 + 120 * S)).toBe("accept");
  });

  it("a heartbeat from before the LWT does not suppress it", () => {
    const p = holdReap(AGENT, T0, 120 * S, true);
    expect(heartbeatSuppresses(p, T0 - S)).toBe(false);
    expect(heartbeatSuppresses(p, T0)).toBe(false);
  });
});

describe("daemon: sleep/wake and reap suppression", () => {
  let s: SupervisedEnv;
  afterEach(async () => {
    await s.cleanup();
  });

  /**
   * A controllable clock shared by the daemon's `now` and its clock sampler: `advance(ms)` moves
   * both clocks, `sleep(ms)` the wall clock only. Nothing in these tests waits on real time for
   * a verdict: reaps are accepted (or not) on explicit ticks.
   */
  function fakeClock() {
    let mono = 0;
    let wall = Date.now();
    return {
      read: () => ({ mono, wall }),
      now: () => wall,
      advance: (ms: number) => {
        mono += ms;
        wall += ms;
      },
      sleep: (ms: number) => {
        wall += ms;
      },
    };
  }
  type Clock = ReturnType<typeof fakeClock>;

  /** Wake the daemon from a 300 s sleep (journals wake_detected). */
  async function wake(clock: Clock) {
    await s.daemon.tick();
    clock.advance(10_000);
    clock.sleep(300_000);
    await s.daemon.tick();
  }
  /** One tick at `ms` later, then a second one: anything the first enqueued has run. */
  async function tickAfter(clock: Clock, ms: number) {
    clock.advance(ms);
    await s.daemon.tick();
    await s.daemon.tick();
  }
  const retired = () => s.journal().some((e) => e.type === "agent_retired");
  /**
   * A sync point: the agent asks its n-th question (after a `resumed` closing the previous one);
   * once that is journaled, everything it published before was consumed. The clock is not moved,
   * so these hook signals carry the LWT's own instant: not after it, so they suppress nothing.
   */
  async function consumed(n: number) {
    await s.hook("resumed.json", { seq: 200 + n });
    await s.hook("awaiting-permission-prompt.json", { seq: 100 + n });
    await s.until(
      () =>
        s.journal().filter((e) => e.type === "decision_opened" && e.data.kind === "agent_question")
          .length >= n,
    );
  }
  const statusTopic = buildTopic(NS, AGENT, "status");
  const reapedRaw = () =>
    JSON.stringify(
      buildEnvelope({
        agentId: AGENT,
        parentId: "volleyd",
        channel: "status",
        type: "reaped",
        payload: { reason: "lwt" },
      }),
    );

  it("journals wake_detected; a reaped agent that heartbeats is kept for good, even past many graces and a re-delivered LWT", async () => {
    const clock = fakeClock();
    s = await makeSupervisedEnv({
      config: "wake_grace_s: 2",
      reapGraceMs: 60_000,
      daemon: { clock: clock.read, now: clock.now },
    });
    await wake(clock);
    expect(systemJournal(s.env).find((e) => e.type === "wake_detected")?.data).toMatchObject({
      jump_ms: 300_000,
    });
    // The flood of LWTs after the wake: this agent is fine and heartbeats on its next tool call.
    const lwt = reapedRaw();
    await s.agent.publish(statusTopic, lwt, { qos: 1, retain: true });
    await consumed(1);
    clock.advance(1000);
    await s.hook("heartbeat.json");
    await s.until(() => s.journal().some((e) => e.type === "reap_suppressed"));
    expect(s.journal().find((e) => e.type === "reap_suppressed")?.data).toMatchObject({
      agent_id: AGENT,
      wake: true,
    });
    // The retained LWT re-delivered (e.g. a re-subscribe after a reconnect) is the same reap.
    await s.agent.publish(statusTopic, lwt, { qos: 1, retain: true });
    await consumed(2);
    // Ten minutes is ten reap graces: the agent was never retired.
    for (let i = 0; i < 10; i++) await tickAfter(clock, 60_000);
    expect(retired()).toBe(false);
    expect(s.host.fake.argvs(["volley", "auth", "rm-agent"])).toEqual([]);
  });

  it("a new LWT after a suppressed one is held again and accepted once its grace runs out quietly", async () => {
    const clock = fakeClock();
    s = await makeSupervisedEnv({
      reapGraceMs: 60_000,
      daemon: { clock: clock.read, now: clock.now },
    });
    await s.status("reaped", { reason: "lwt" });
    await consumed(1);
    clock.advance(1000);
    await s.hook("heartbeat.json");
    await s.until(() => s.journal().some((e) => e.type === "reap_suppressed"));
    clock.advance(1000);
    await s.status("reaped", { reason: "lwt" });
    await consumed(2);
    await tickAfter(clock, 59_000);
    expect(retired()).toBe(false);
    await tickAfter(clock, 1000);
    expect(s.journal().find((e) => e.type === "agent_retired")?.data).toMatchObject({
      agent_id: AGENT,
      status: "reaped",
    });
  });

  it("a wake never shortens the reap grace: a quiet reaped agent is retired after the normal grace", async () => {
    const clock = fakeClock();
    s = await makeSupervisedEnv({
      config: "wake_grace_s: 1",
      reapGraceMs: 60_000,
      daemon: { clock: clock.read, now: clock.now },
    });
    await wake(clock);
    await s.status("reaped", { reason: "lwt" });
    await consumed(1);
    // Well past the 1 s wake grace, still inside the normal 60 s reap grace: kept.
    await tickAfter(clock, 30_000);
    expect(retired()).toBe(false);
    await tickAfter(clock, 30_000);
    expect(s.journal().find((e) => e.type === "agent_retired")?.data).toMatchObject({
      agent_id: AGENT,
      status: "reaped",
    });
    expect(s.journal().some((e) => e.type === "reap_suppressed")).toBe(false);
  });
});
