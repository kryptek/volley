import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTopic } from "volley-mcp/topics";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import type { PipelineDriver, PipelineEvent } from "../src/pipeline";
import { TERMINAL_ALARM } from "../src/watchdog";
import { NS } from "./helpers/daemon-env";
import { type FakeClock, fakeClock } from "./helpers/fake-clock";
import { runCli } from "./helpers/run-cli";
import {
  AGENT,
  ARTIFACTS_OK,
  type SupervisedEnv,
  makeSupervisedEnv,
} from "./helpers/supervised-env";

/**
 * A terminal status the daemon dropped is recovered, not just alarmed (#414): the handoff's throw
 * is journaled as `pipeline_error { check: "status" }`, the watchdog alarms, and a
 * `terminal_recover_ms` after the alarm re-reads the retained status and hands it over again
 * (`terminal_status_recovered`). When that fails too, `terminal_status_lost` asks the owner.
 */

let s: SupervisedEnv;
afterEach(async () => {
  vi.restoreAllMocks();
  await s?.cleanup();
});

const late = DAEMON_DEFAULTS.terminal_unjournaled_alarm_ms + 1_000;
const recover = DAEMON_DEFAULTS.terminal_recover_ms + 1_000;

/**
 * The daemon's pipelines throw on an `agent_done` for the first `fails` handoffs (every one, for
 * Infinity); returns the handoffs seen so far.
 */
function failDone(fails: number): { calls: PipelineEvent[]; fails: number } {
  const seen = { calls: [] as PipelineEvent[], fails };
  const d = s.daemon as unknown as { pipelineFor(w: string): PipelineDriver };
  const real = d.pipelineFor.bind(d);
  d.pipelineFor = (w) => {
    const p = real(w);
    return Object.assign(Object.create(p), {
      handle: async (task: string, ev: PipelineEvent) => {
        if (ev.kind !== "agent_done") return p.handle(task, ev);
        seen.calls.push(ev);
        if (seen.calls.length <= seen.fails) throw new Error("verify denied by the fence");
        return p.handle(task, ev);
      },
    });
  };
  return seen;
}

const pass = async (clock: FakeClock, ms: number) => {
  await clock.advance(ms);
  await s.daemon.tick();
  await s.settled();
};

const of = (type: string) => s.journal().filter((e) => e.type === type);
const lostOpened = () =>
  s.journal().filter((e) => e.type === "decision_opened" && e.data.kind === "terminal_status_lost");

const resolve = async (id: string, answer: string) => {
  const r = await runCli(["resolve", id, answer, "--by", "tester"], s.env.env);
  expect(r.exitCode).toBe(0);
  await s.event((e) => e.type === "decision_resolved" && e.data.decision_id === id);
  await s.settled();
};

/** A done whose handoff kept failing: alarmed, recovery failed, terminal_status_lost open. */
async function lost(clock: FakeClock) {
  const seen = failDone(2);
  await s.status("done", { summary: "ok" });
  await s.consumed();
  await pass(clock, late);
  await pass(clock, recover);
  const [opened] = lostOpened();
  expect(opened).toBeDefined();
  return { seen, id: opened?.data.decision_id as string };
}

describe("daemon: a dropped terminal status (#414)", () => {
  it("a done whose handoff throws once is journaled as pipeline_error and recovered by the watchdog's next pass", async () => {
    const clock = fakeClock(Date.now());
    s = await makeSupervisedEnv({ daemon: { clock } });
    const seen = failDone(1);
    await s.status("done", { summary: "ok" });
    await s.consumed();
    const err = s
      .journal()
      .find((e) => e.type === "alarm_raised" && e.data.alarm === "pipeline_error");
    expect(err?.data).toMatchObject({ check: "status", agent_id: AGENT });
    expect(String(err?.data.message)).toContain("verify denied by the fence");

    await pass(clock, late);
    expect(
      s.journal().filter((e) => e.type === "alarm_raised" && e.data.alarm === TERMINAL_ALARM),
    ).toHaveLength(1);
    expect(of("terminal_status_recovered")).toHaveLength(0);

    await pass(clock, recover);
    const rec = of("terminal_status_recovered");
    expect(rec).toHaveLength(1);
    expect(rec[0]?.task).toBe("T1");
    expect(rec[0]?.data).toMatchObject({ agent_id: AGENT, status: "done" });
    expect(rec[0]?.data.after_ms).toBeGreaterThanOrEqual(late + recover);
    expect(seen.calls).toHaveLength(2);
    // The pipeline has the claim now: in the fake world (no PR) it steers the agent to push.
    expect(
      s.journal().some((e) => e.type === "steering_sent" && e.data.reason === "artifacts"),
    ).toBe(true);
    await pass(clock, 1_000);
    expect(
      s.journal().filter((e) => e.type === "alarm_cleared" && e.data.alarm === TERMINAL_ALARM),
    ).toHaveLength(1);
    expect(lostOpened()).toHaveLength(0);
  });

  it("a status re-delivered during recovery is handled once", async () => {
    const clock = fakeClock(Date.now());
    s = await makeSupervisedEnv({ daemon: { clock } });
    const seen = failDone(1);
    await s.status("done", { summary: "ok" });
    await s.consumed();
    await pass(clock, late);
    // The same retained status again (same wall_time): a broker re-delivery.
    const topic = buildTopic(NS, AGENT, "status");
    const raw = await s.agent.queryRetained(topic);
    expect(raw).not.toBeNull();
    await s.agent.publish(topic, raw as string, { qos: 1, retain: true });
    await s.consumed();
    expect(seen.calls).toHaveLength(1);
    await pass(clock, recover);
    await pass(clock, recover);
    expect(seen.calls).toHaveLength(2);
    expect(of("terminal_status_recovered")).toHaveLength(1);
  });

  it("a handoff that keeps throwing opens terminal_status_lost naming the agent", async () => {
    const clock = fakeClock(Date.now());
    s = await makeSupervisedEnv({ daemon: { clock } });
    await lost(clock);
    const [opened] = lostOpened();
    expect(opened?.task).toBe("T1");
    expect(opened?.data).toMatchObject({
      options: ["accept done", "relaunch"],
      agent_id: AGENT,
      role: "implementer",
      status: "done",
    });
    expect(opened?.data.question).toContain(AGENT);
    expect(opened?.data.question).toContain("done");
    expect(of("terminal_status_recovered")).toHaveLength(0);
    // Asked once: later passes ask nothing more.
    await pass(clock, recover);
    expect(lostOpened()).toHaveLength(1);
    // The task is not parked: it stays where it was.
    expect(s.daemon.snapshot("w1")?.tasks[0]?.stage).toBe("implement");
  });

  it("accept done: the status is applied as if it had just arrived", async () => {
    const clock = fakeClock(Date.now());
    s = await makeSupervisedEnv({ daemon: { clock } });
    const { seen, id } = await lost(clock);
    await resolve(id, "accept done");
    expect(seen.calls).toHaveLength(3);
    expect(
      s.journal().some((e) => e.type === "steering_sent" && e.data.reason === "artifacts"),
    ).toBe(true);
  });

  it("a recovered done advances the task: its next stage's agent is launched", async () => {
    const clock = fakeClock(Date.now());
    s = await makeSupervisedEnv({
      daemon: { clock },
      exec: ARTIFACTS_OK,
      pipeline: "[implement, spec_review]",
    });
    failDone(1);
    await s.status("done", { summary: "ok" });
    await s.consumed();
    expect(
      s.journal().some((e) => e.type === "stage_entered" && e.data.stage === "spec_review"),
    ).toBe(false);
    await pass(clock, late);
    await pass(clock, recover);
    expect(of("terminal_status_recovered")).toHaveLength(1);
    await s.event((e) => e.type === "stage_entered" && e.data.stage === "spec_review");
    await s.event("agent_spawned", 2);
  });

  it("a status is not recovered while its agent is moving, and is once the move ends", async () => {
    const clock = fakeClock(Date.now());
    s = await makeSupervisedEnv({ daemon: { clock } });
    const seen = failDone(1);
    await s.status("done", { summary: "ok" });
    await s.consumed();
    await pass(clock, late);
    const moving = (s.daemon as unknown as { moving: Set<string> }).moving;
    moving.add(AGENT);
    await pass(clock, recover);
    expect(of("terminal_status_recovered")).toHaveLength(0);
    expect(lostOpened()).toHaveLength(0);
    expect(seen.calls).toHaveLength(1);
    moving.delete(AGENT);
    await pass(clock, 1_000);
    expect(seen.calls).toHaveLength(2);
    expect(of("terminal_status_recovered")).toHaveLength(1);
  });

  it("a status whose retained copy is gone opens terminal_status_lost", async () => {
    const clock = fakeClock(Date.now());
    s = await makeSupervisedEnv({ daemon: { clock } });
    const seen = failDone(1);
    await s.status("done", { summary: "ok" });
    await s.consumed();
    await pass(clock, late);
    const real = s.daemon as unknown as {
      broker: { queryRetained(t: string, ms: number): Promise<string | null> };
    };
    const q = real.broker.queryRetained.bind(real.broker);
    vi.spyOn(real.broker, "queryRetained").mockImplementation(async (t, ms) =>
      t === buildTopic(NS, AGENT, "status") ? null : q(t, ms),
    );
    await pass(clock, recover);
    expect(seen.calls).toHaveLength(1);
    expect(of("terminal_status_recovered")).toHaveLength(0);
    const [opened] = lostOpened();
    expect(opened?.data).toMatchObject({ agent_id: AGENT, status: "done" });
    expect(String(opened?.data.why)).toContain("retained status is gone");
  });

  it("a failed whose handoff throws after retire asks the owner, and accept done hands it over", async () => {
    const clock = fakeClock(Date.now());
    s = await makeSupervisedEnv({ daemon: { clock } });
    const seen = failDone(1);
    await s.status("failed", { reason: "broke" });
    await s.consumed();
    await s.event((e) => e.type === "agent_retired" && e.data.agent_id === AGENT);
    const err = s
      .journal()
      .find((e) => e.type === "alarm_raised" && e.data.alarm === "pipeline_error");
    expect(err?.task).toBe("T1");
    expect(err?.data).toMatchObject({ check: "status", agent_id: AGENT, status: "failed" });
    const [opened] = lostOpened();
    expect(opened?.task).toBe("T1");
    expect(opened?.data).toMatchObject({ agent_id: AGENT, role: "implementer", status: "failed" });
    await resolve(opened?.data.decision_id as string, "accept done");
    expect(seen.calls).toHaveLength(2);
    expect(seen.calls[1]).toMatchObject({ kind: "agent_done", agent_id: AGENT, status: "failed" });
    expect(lostOpened()).toHaveLength(1);
  });

  it("a done the pipeline retired before it threw is not asked about", async () => {
    const clock = fakeClock(Date.now());
    s = await makeSupervisedEnv({
      daemon: { clock },
      exec: ARTIFACTS_OK,
      pipeline: "[implement, spec_review]",
    });
    // The pipeline accepts and retires the done; its next action (the next stage) throws.
    const d = s.daemon as unknown as {
      pipelineFor(w: string): PipelineDriver;
      retireRole(w: string, agentId: string, status: string): Promise<void>;
    };
    const real = d.pipelineFor.bind(d);
    d.pipelineFor = (w) => {
      const p = real(w);
      return Object.assign(Object.create(p), {
        handle: async (task: string, ev: PipelineEvent) => {
          if (ev.kind !== "agent_done") return p.handle(task, ev);
          await d.retireRole(w, AGENT, "done");
          throw new Error("spawn failed");
        },
      });
    };
    await s.status("done", { summary: "ok" });
    await s.consumed();
    await s.event((e) => e.type === "agent_retired" && e.data.agent_id === AGENT);
    expect(
      s.journal().some((e) => e.type === "alarm_raised" && e.data.alarm === "pipeline_error"),
    ).toBe(true);
    await pass(clock, late);
    await pass(clock, recover);
    expect(lostOpened()).toHaveLength(0);
  });

  it("accept done whose handoff throws again asks again", async () => {
    const clock = fakeClock(Date.now());
    s = await makeSupervisedEnv({ daemon: { clock } });
    const { seen, id } = await lost(clock);
    seen.fails = Number.POSITIVE_INFINITY;
    await resolve(id, "accept done");
    expect(seen.calls).toHaveLength(3);
    const all = lostOpened();
    expect(all).toHaveLength(2);
    expect(all[1]?.data.decision_id).not.toBe(id);
    expect(all[1]?.data).toMatchObject({ agent_id: AGENT, status: "done" });
    expect(String(all[1]?.data.why)).toContain("verify denied by the fence");
  });

  it("relaunch: the agent is retired as relaunched and its role launched again", async () => {
    const clock = fakeClock(Date.now());
    s = await makeSupervisedEnv({ daemon: { clock } });
    const { id } = await lost(clock);
    await resolve(id, "relaunch");
    await s.event((e) => e.type === "agent_retired" && e.data.agent_id === AGENT);
    expect(
      s.journal().find((e) => e.type === "agent_retired" && e.data.agent_id === AGENT)?.data,
    ).toMatchObject({ status: "relaunched" });
    await s.event("agent_spawned", 2);
    expect(s.host.launches).toHaveLength(2);
  });
});
