import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  sampleOf,
  sleep,
} from "../src/clock";
import { lockPath, readLock } from "../src/locks";
import { spawnAgent } from "../src/spawn";
import { worktreePath } from "../src/worktree";
import { NS } from "./helpers/daemon-env";
import { type FakeClock, fakeClock } from "./helpers/fake-clock";
import { type SpawnEnv, makeSpawnEnv } from "./helpers/fake-host";
import { runCli } from "./helpers/run-cli";
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

describe("fake clock (test/helpers/fake-clock.ts)", () => {
  it("runs due timers in due order, each at its own instant", async () => {
    const c = fakeClock(T0);
    const ran: [string, number][] = [];
    c.setTimeout(() => ran.push(["c", c.now()]), 30);
    c.setTimeout(() => ran.push(["a", c.now()]), 10);
    c.setTimeout(() => ran.push(["b", c.now()]), 20);
    c.setTimeout(() => ran.push(["late", c.now()]), 31);
    await c.advance(30);
    expect(ran).toEqual([
      ["a", T0 + 10],
      ["b", T0 + 20],
      ["c", T0 + 30],
    ]);
    expect(c.now()).toBe(T0 + 30);
    expect(c.pending()).toBe(1);
  });

  it("flushes microtasks between timers: an earlier timer's promise chain lands first", async () => {
    const c = fakeClock(T0);
    const seen: string[] = [];
    c.setTimeout(() => {
      void Promise.resolve()
        .then(() => Promise.resolve())
        .then(() => seen.push("first's continuation"));
    }, 10);
    c.setTimeout(() => seen.push("second"), 10);
    c.setTimeout(() => seen.push("third"), 20);
    await c.advance(20);
    // Same instant: the second timer runs once the first's chain has settled.
    expect(seen).toEqual(["first's continuation", "second", "third"]);
  });

  it("advanceToNext jumps exactly to the next due timer", async () => {
    const c = fakeClock(T0);
    expect(await c.advanceToNext()).toBeNull();
    let fired = 0;
    c.setTimeout(() => fired++, 30_000);
    c.setTimeout(() => fired++, 60_000);
    expect(c.nextDue()).toBe(30_000);
    expect(await c.advanceToNext()).toBe(30_000);
    expect([fired, c.now()]).toEqual([1, T0 + 30_000]);
    expect(await c.advanceToNext()).toBe(30_000);
    expect([fired, c.now()]).toEqual([2, T0 + 60_000]);
  });

  it("intervals repeat until cleared; a cleared timeout never runs", async () => {
    const c = fakeClock(T0);
    let ticks = 0;
    const iv = c.setInterval(() => ticks++, 1000);
    const t = c.setTimeout(() => {
      ticks += 100;
    }, 500);
    c.clearTimeout(t);
    await c.advance(3500);
    expect(ticks).toBe(3);
    c.clearInterval(iv);
    await c.advance(10_000);
    expect(ticks).toBe(3);
    expect(c.pending()).toBe(0);
  });

  it("timers armed by a timer run in the same advance when they fall due within it", async () => {
    const c = fakeClock(T0);
    const at: number[] = [];
    c.setTimeout(() => {
      at.push(c.now());
      c.setTimeout(() => at.push(c.now()), 100);
    }, 100);
    await c.advance(250);
    expect(at).toEqual([T0 + 100, T0 + 200]);
  });

  it("sleep() resolves when the clock reaches it, or at once on abort", async () => {
    const c = fakeClock(T0);
    let done = false;
    void sleep(c, 1000).then(() => {
      done = true;
    });
    await c.advance(999);
    expect(done).toBe(false);
    await c.advance(1);
    expect(done).toBe(true);
    const abort = new AbortController();
    const early = sleep(c, 60_000, abort.signal);
    abort.abort();
    await early;
    expect(c.pending()).toBe(0);
  });

  it("T8's wake detection runs on the same interface: a host sleep moves the wall clock only", async () => {
    const c = fakeClock(T0);
    let st: ClockState = sampleClock({ last: null, wake: null }, sampleOf(c)).state;
    await c.advance(10 * S);
    let r = sampleClock(st, sampleOf(c));
    expect(r.wake).toBeNull();
    st = r.state;
    c.sleepHost(300 * S);
    expect(c.mono()).toBe(10 * S);
    r = sampleClock(st, sampleOf(c));
    expect(r.wake).toEqual({ at: T0 + 310 * S, jump_ms: 300 * S });
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
   * The daemon runs on a fake clock (test/helpers/fake-clock.ts): `advance(ms)` moves both clocks
   * and fires the daemon's due timers (reap graces), `sleepHost(ms)` moves the wall clock only.
   * Nothing in these tests waits on real time for a verdict.
   */
  type Clock = FakeClock;

  /** Wake the daemon from a 300 s sleep (journals wake_detected). */
  async function wake(clock: Clock) {
    await s.daemon.tick();
    await clock.advance(10_000);
    clock.sleepHost(300_000);
    await s.daemon.tick();
  }
  /** One tick at `ms` later, then a second one: anything the first enqueued has run. */
  async function tickAfter(clock: Clock, ms: number) {
    await clock.advance(ms);
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
    const clock = fakeClock(Date.now());
    s = await makeSupervisedEnv({
      config: "wake_grace_s: 2",
      reapGraceMs: 60_000,
      daemon: { clock },
    });
    await wake(clock);
    expect(systemJournal(s.env).find((e) => e.type === "wake_detected")?.data).toMatchObject({
      jump_ms: 300_000,
    });
    // The flood of LWTs after the wake: this agent is fine and heartbeats on its next tool call.
    const lwt = reapedRaw();
    await s.agent.publish(statusTopic, lwt, { qos: 1, retain: true });
    await consumed(1);
    await clock.advance(1000);
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
    expect(s.creds.revoked).toEqual([]);
  });

  it("a new LWT after a suppressed one is held again and accepted once its grace runs out quietly", async () => {
    const clock = fakeClock(Date.now());
    s = await makeSupervisedEnv({
      reapGraceMs: 60_000,
      daemon: { clock },
    });
    await s.status("reaped", { reason: "lwt" });
    await consumed(1);
    await clock.advance(1000);
    await s.hook("heartbeat.json");
    await s.until(() => s.journal().some((e) => e.type === "reap_suppressed"));
    await clock.advance(1000);
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
    const clock = fakeClock(Date.now());
    s = await makeSupervisedEnv({
      config: "wake_grace_s: 1",
      reapGraceMs: 60_000,
      daemon: { clock },
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

describe("one clock per comparison: the daemon stamps with the clock it is given", () => {
  /** Far from real time, so a stamp from the real clock cannot pass for the fake one. */
  const PAST = Date.parse("2020-01-01T00:00:00.000Z");
  let s: SupervisedEnv | undefined;
  let spawn: SpawnEnv | undefined;
  afterEach(async () => {
    await s?.cleanup();
    await spawn?.cleanup();
    s = undefined;
    spawn = undefined;
  });

  it("wave and _system journal events, config changes and the worktree lock carry the fake time", async () => {
    const clock = fakeClock(PAST);
    s = await makeSupervisedEnv({ daemon: { clock } });
    const cli = await runCli(["config", "set", "hard_ceiling", "3", "--by", "tester"], s.env.env);
    expect(cli.exitCode).toBe(0);
    await s.settled();
    const at = new Date(PAST).toISOString();
    const stamps = [...s.journal(), ...systemJournal(s.env)].map((e) => [e.type, e.at]);
    expect(stamps.length).toBeGreaterThan(3);
    expect(stamps.filter(([, a]) => a !== at)).toEqual([]);
    expect(systemJournal(s.env).some((e) => e.type === "config_changed")).toBe(true);
    const lock = readLock(
      lockPath(s.env.home, worktreePath(join(s.env.home, "wt"), "w1", "T1", "implementer")),
    );
    expect(lock?.at).toBe(at);
  });

  it("a spawn judges a held lock stale on its own clock, and stamps the decisions it opens with it", async () => {
    const clock = fakeClock(PAST);
    spawn = await makeSpawnEnv({ trusted: false });
    const deps = { ...spawn.deps, now: clock.now };
    // An untrusted repo: the decision a spawn opens itself is stamped with the injected clock.
    const out = await spawnAgent(spawn.request(), deps);
    expect(out.kind).toBe("decision");
    const opened = spawn.events.find((e) => e.type === "decision_opened");
    expect(opened?.data.opened_at).toBe(new Date(PAST).toISOString());

    // A holder that wrote its lock an hour ago and heartbeat a minute ago (both on the fake
    // clock) is live: a spawn reading "now" off the real clock would call it quiet and take over.
    spawn.deps.claudeJsonPath = spawn.claudeJson;
    writeFileSync(
      spawn.claudeJson,
      JSON.stringify({ projects: { [spawn.repo]: { hasTrustDialogAccepted: true } } }),
    );
    const path = lockPath(spawn.home, spawn.worktree);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({
        wave: "w1",
        task: "T1",
        role: "implementer",
        attempt: 1,
        agent_id: "w1-t1-implementer-1",
        pid: 0,
        at: new Date(PAST - 3_600_000).toISOString(),
      })}\n`,
    );
    const held = {
      ...deps,
      openDecisions: [],
      probe: { ...deps.probe, lastHeartbeat: () => PAST - 60_000 },
    };
    const err = await spawnAgent(spawn.request({ attempt: 2 }), held).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("SPAWN_LOCKED");
  });
});
