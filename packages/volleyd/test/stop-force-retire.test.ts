import { afterEach, describe, expect, it } from "vitest";
import { retainedTopics } from "../src/retire";
import { NS } from "./helpers/daemon-env";
import { type FakeClock, fakeClock } from "./helpers/fake-clock";
import { runCli } from "./helpers/run-cli";
import { AGENT, type SupervisedEnv, makeSupervisedEnv } from "./helpers/supervised-env";

/**
 * `volleyd stop <wave>` sends cancel, then waits `stop_grace_s` (default 30 s, on the daemon's
 * clock) for terminal statuses; an agent still running then is force-retired through the delete
 * path: its retained records cleared, its login deleted, `agent_force_retired { reason: stop }`.
 */

describe("stop force-retires agents that never ack", () => {
  let s: SupervisedEnv;
  let clock: FakeClock;
  afterEach(async () => s.cleanup());

  async function stopped() {
    clock = fakeClock(Date.now());
    s = await makeSupervisedEnv({ daemon: { clock } });
    // Records the Desk would keep drawing.
    await s.pub(`volley/${NS}/${AGENT}/result`, "result", "result", { summary: "half done" });
    await s.pub(`volley/${NS}/${AGENT}/capability`, "capability", "capability", { tools: [] });
    const r = await runCli(["stop", "w1", "--by", "tester"], s.env.env);
    expect(r.exitCode, r.stderr).toBe(0);
    await s.settled();
  }

  it("a silent agent: after stop_grace_s its records are cleared, its login deleted, journaled", async () => {
    await stopped();
    expect(s.journal().some((e) => e.type === "agent_force_retired")).toBe(false);
    await clock.armed(30_000);
    await clock.advance(30_000);
    const forced = await s.event("agent_force_retired");
    expect(forced.data).toMatchObject({ agent_id: AGENT, role: "implementer", reason: "stop" });
    const retired = await s.event((e) => e.type === "agent_retired" && e.data.agent_id === AGENT);
    expect(retired.data).toMatchObject({ status: "stopped", credentials_revoked: true });
    expect(s.creds.revoked).toEqual([AGENT]);
    for (const topic of retainedTopics(NS, AGENT)) expect(await s.env.retained(topic)).toBeNull();
  });

  it("an agent that acks within the grace is retired normally, never forced", async () => {
    await stopped();
    await s.status("failed", { reason: "cancelled by volleyd stop" });
    const retired = await s.event((e) => e.type === "agent_retired" && e.data.agent_id === AGENT);
    expect(retired.data.status).toBe("failed");
    await s.settled();
    await clock.advance(30_000);
    await s.settled();
    expect(s.journal().some((e) => e.type === "agent_force_retired")).toBe(false);
    expect(s.journal().filter((e) => e.type === "agent_retired")).toHaveLength(1);
  });

  it("a wave resumed within the grace keeps its agents", async () => {
    await stopped();
    expect(s.daemon.capturing()).toEqual([]);
    expect((await runCli(["resume", "w1", "--by", "tester"], s.env.env)).exitCode).toBe(0);
    // Its terminal is captured again: a live agent never shows a frozen screen.
    expect(s.daemon.capturing()).toEqual([AGENT]);
    await clock.advance(30_000);
    await s.settled();
    expect(s.journal().some((e) => e.type === "agent_force_retired")).toBe(false);
  });

  it("stop_grace_s is a tunable (per-wave config)", async () => {
    clock = fakeClock(Date.now());
    s = await makeSupervisedEnv({ daemon: { clock }, config: "stop_grace_s: 5" });
    expect((await runCli(["stop", "w1", "--by", "tester"], s.env.env)).exitCode).toBe(0);
    await clock.armed(5_000);
    await clock.advance(5_000);
    expect((await s.event("agent_force_retired")).data.agent_id).toBe(AGENT);
  });

  it("a force-retired agent's deleted login is reported: reaped { credentials_deleted } journaled", async () => {
    await stopped();
    await clock.armed(30_000);
    await clock.advance(30_000);
    const reaped = await s.event("agent_reaped_by_supervisor");
    expect(reaped.data).toEqual({ agent_id: AGENT, reason: "credentials_deleted" });
    expect((await s.event("credentials_revoked")).data).toEqual({ agent_id: AGENT, ok: true });
  });
  // The orphan sweep (stop-sweep.test.ts) deletes through the same delete path.
});
