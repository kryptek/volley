import { afterEach, describe, expect, it } from "vitest";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import { reconcileSkip } from "../src/reconcile";
import { emptyRecord } from "../src/reducer";
import { NS } from "./helpers/daemon-env";
import { runCli } from "./helpers/run-cli";
import { AGENT, type SupervisedEnv, makeSupervisedEnv } from "./helpers/supervised-env";

/**
 * On restart, reconcile skips stopped (and complete) waves: listed as `skipped: stopped`, never
 * re_wait'ed or respawned, no decision. A stopped wave's agents that outlived the daemon are
 * force-retired (the stop's grace ran out while it was down).
 */

describe("reconcile skips stopped waves", () => {
  let s: SupervisedEnv;
  afterEach(async () => s.cleanup());

  it("a stopped wave with an agent whose status is missing → skipped: stopped, no re_wait, no decision", async () => {
    s = await makeSupervisedEnv();
    expect((await runCli(["stop", "w1", "--by", "tester"], s.env.env)).exitCode).toBe(0);
    await s.settled();
    await s.daemon.stop();
    // The agent's records vanished while volleyd was down.
    await s.agent.publish(buildTopic(NS, AGENT, "status"), "", { qos: 1, retain: true });
    await s.agent.publish(registryTopic(AGENT), "", { qos: 1, retain: true });
    await s.restart();
    const rec = await s.event("reconciled");
    expect(rec.data).toMatchObject({ agent_id: AGENT, skipped: "stopped" });
    expect(rec.data.action).toBeUndefined();
    await s.event((e) => e.type === "agent_force_retired" && e.data.agent_id === AGENT);
    await s.settled();
    expect(s.journal().some((e) => e.type === "decision_opened")).toBe(false);
    expect(s.journal().some((e) => e.type === "reconciled" && e.data.action === "re_wait")).toBe(
      false,
    );
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
