import { afterEach, describe, expect, it } from "vitest";
import { ScreenPublisher } from "../src/screen-publisher";
import { NS } from "./helpers/daemon-env";
import { type FakeClock, fakeClock } from "./helpers/fake-clock";
import { fakeHost } from "./helpers/fake-host";
import { runCli } from "./helpers/run-cli";
import { AGENT, type SupervisedEnv, makeSupervisedEnv } from "./helpers/supervised-env";

/**
 * Screen supervision ends with the agent: a retired agent and every agent of a stopped wave
 * leave the capture set at once, and a live agent whose workspace is gone (3 consecutive read
 * timeouts) is read at most hourly, without a `read timed out` line every capture.
 */

describe("ScreenPublisher: a closed workspace", () => {
  it("3 consecutive read timeouts back off to hourly and the log goes quiet", async () => {
    const timers = fakeClock(1_000_000);
    let clock = 1_000_000;
    const logs: string[] = [];
    const host = fakeHost();
    host.readScreen = () => new Promise<string | null>(() => {}); // the workspace is closed
    const p = new ScreenPublisher({
      publish: async () => {},
      clock: timers,
      now: () => clock,
      log: (l) => logs.push(l),
      slowMs: 40,
      readTimeoutMs: 100,
    });
    p.track({ agentId: "a1", namespace: NS, workspace: "workspace:9", host, intervalS: () => 5 });
    const capture = async () => {
      const t = p.tick();
      await timers.advance(100);
      await t;
    };
    for (let i = 0; i < 3; i++) {
      await capture();
      clock += 30_000; // the 30 s stale back-off
    }
    expect(logs.filter((l) => l.includes("read timed out"))).toHaveLength(3);
    expect(logs.some((l) => l.includes("hourly"))).toBe(true);
    const reads = () => host.screenReads.length;
    // Backed off to an hour: nothing for the next 59 min.
    const before = reads();
    for (let m = 0; m < 59; m++) {
      clock += 60_000;
      await p.tick();
    }
    expect(host.screenReads.length).toBe(before);
    clock += 60_000;
    await capture();
    expect(logs.filter((l) => l.includes("read timed out"))).toHaveLength(3);
    expect(p.tracked()).toEqual(["a1"]);
  });
});

describe("daemon: who is captured", () => {
  let s: SupervisedEnv;
  let clock: FakeClock;
  afterEach(async () => s.cleanup());

  it("an agent of a stopped wave leaves the capture set at once", async () => {
    clock = fakeClock(Date.now());
    s = await makeSupervisedEnv({ daemon: { clock } });
    expect(s.daemon.capturing()).toEqual([AGENT]);
    expect((await runCli(["stop", "w1", "--by", "tester"], s.env.env)).exitCode).toBe(0);
    await s.settled();
    expect(s.daemon.capturing()).toEqual([]);
    const reads = s.host.screenReads.length;
    await clock.advance(20_000);
    await s.settled();
    expect(s.host.screenReads.length).toBe(reads);
  });

  it("a retired agent leaves the capture set", async () => {
    clock = fakeClock(Date.now());
    s = await makeSupervisedEnv({ daemon: { clock } });
    await s.status("failed", { reason: "gave up" });
    await s.event((e) => e.type === "agent_retired" && e.data.agent_id === AGENT);
    await s.settled();
    expect(s.daemon.capturing()).toEqual([]);
  });
});
