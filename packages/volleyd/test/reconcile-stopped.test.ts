import { afterEach, describe, expect, it } from "vitest";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import { reconcileSkip } from "../src/reconcile";
import { emptyRecord } from "../src/reducer";
import { NS } from "./helpers/daemon-env";
import { type FakeClock, fakeClock } from "./helpers/fake-clock";
import { runCli } from "./helpers/run-cli";
import { AGENT, type SupervisedEnv, makeSupervisedEnv } from "./helpers/supervised-env";

/**
 * On restart, reconcile skips stopped (and complete) waves: listed as `skipped: stopped`, never
 * re_wait'ed or respawned, no decision. A stopped wave's agents that outlived the daemon are
 * force-retired once what is left of the stop's grace (none, if it ran out while it was down)
 * has passed.
 */

describe("reconcile skips stopped waves", () => {
  let s: SupervisedEnv;
  let clock: FakeClock;
  afterEach(async () => s.cleanup());

  /** Stop w1, halt the daemon, and let `downMs` pass on the daemon clock while it is down. */
  async function stoppedThenDown(downMs: number) {
    clock = fakeClock(Date.now());
    s = await makeSupervisedEnv({ daemon: { clock } });
    expect((await runCli(["stop", "w1", "--by", "tester"], s.env.env)).exitCode).toBe(0);
    await s.settled();
    await s.daemon.stop();
    await clock.advance(downMs);
  }

  it("a stopped wave with an agent whose status is missing → skipped: stopped, no re_wait, no decision", async () => {
    await stoppedThenDown(31_000);
    // The agent's records vanished while volleyd was down.
    await s.agent.publish(buildTopic(NS, AGENT, "status"), "", { qos: 1, retain: true });
    await s.agent.publish(registryTopic(AGENT), "", { qos: 1, retain: true });
    await s.restart();
    const rec = await s.event("reconciled");
    expect(rec.data).toMatchObject({ agent_id: AGENT, skipped: "stopped" });
    expect(rec.data.action).toBeUndefined();
    await s.event((e) => e.type === "agent_force_retired" && e.data.agent_id === AGENT);
    // Its workspace ref came back from the journal as a short cmux ref, which may name another
    // workspace by now: left for `cleanup --yes`, never closed blind.
    const retired = await s.event((e) => e.type === "agent_retired" && e.data.agent_id === AGENT);
    expect(retired.data).toMatchObject({ workspace: "workspace:1", workspace_closed: false });
    expect(s.host.closed).toEqual([]);
    await s.settled();
    expect(s.journal().some((e) => e.type === "decision_opened")).toBe(false);
    expect(s.journal().some((e) => e.type === "reconciled" && e.data.action === "re_wait")).toBe(
      false,
    );
  });

  it("a restart within the stop's grace waits out what is left of it before force-retiring", async () => {
    await stoppedThenDown(10_000);
    await s.restart();
    await s.event("reconciled");
    await s.settled();
    expect(s.journal().some((e) => e.type === "agent_force_retired")).toBe(false);
    await clock.armed(20_000);
    await clock.advance(20_000);
    await s.event((e) => e.type === "agent_force_retired" && e.data.agent_id === AGENT);
  });
});

describe("reconcileSkip", () => {
  it("reconcileSkip: stopped and complete waves are skipped, running ones are not", () => {
    const rec = emptyRecord();
    expect(reconcileSkip(rec)).toBeNull();
    for (const status of ["stopped", "complete"] as const) {
      const r = { ...rec, state: { status } as never };
      expect(reconcileSkip(r)).toBe("stopped");
    }
    expect(reconcileSkip({ ...rec, state: { status: "running" } as never })).toBeNull();
  });
});
