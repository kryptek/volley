import { afterEach, describe, expect, it } from "vitest";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import type { PipelineDriver } from "../src/pipeline";
import { TERMINAL_ALARM } from "../src/watchdog";
import { fakeClock } from "./helpers/fake-clock";
import { runCli } from "./helpers/run-cli";
import { AGENT, type SupervisedEnv, makeSupervisedEnv } from "./helpers/supervised-env";

/**
 * An agent's `blocked` status (SPEC §5.1) reaches the pipeline as an `agent_blocked` decision
 * (continue | respawn | cancel); the agent is not retired (SPEC §5.2). The pipeline's side for
 * every role is in pipeline-blocked.test.ts.
 */

let s: SupervisedEnv;
afterEach(async () => {
  await s?.cleanup();
});

const blockedOpened = () =>
  s.journal().filter((e) => e.type === "decision_opened" && e.data.kind === "agent_blocked");
const stage = () => s.daemon.snapshot("w1")?.tasks[0]?.stage;
const resolve = async (id: string, answer: string) => {
  const r = await runCli(["resolve", id, answer, "--by", "tester"], s.env.env);
  expect(r.exitCode).toBe(0);
  await s.event((e) => e.type === "decision_resolved" && e.data.decision_id === id);
  await s.settled();
};

describe("daemon: a blocked status", () => {
  it("opens an agent_blocked decision with the reason and parks the task; nothing is retired", async () => {
    s = await makeSupervisedEnv();
    await s.status("blocked", { reason: "needs the API key" });
    const opened = await s.event((e) => e.type === "decision_opened");
    expect(opened.task).toBe("T1");
    expect(opened.data).toMatchObject({
      kind: "agent_blocked",
      options: ["continue", "respawn", "cancel"],
      agent_id: AGENT,
      reason: "needs the API key",
      pipeline: { on: "agent_blocked", role: "implementer" },
    });
    expect(opened.data.question).toContain(AGENT);
    expect(opened.data.question).toContain("needs the API key");
    await s.settled();
    expect(stage()).toBe("awaiting_decision");
    expect(s.journal().some((e) => e.type === "agent_retired")).toBe(false);
  });

  it("the same status re-delivered after a restart opens no second decision", async () => {
    s = await makeSupervisedEnv();
    await s.status("blocked", { reason: "stuck" });
    await s.event("decision_opened");
    await s.daemon.stop();
    await s.restart();
    // The retained status is re-delivered to the new daemon's watch on re-attach.
    await s.consumed();
    expect(blockedOpened()).toHaveLength(1);
  });

  it("continue: the task returns to implement, the agent stays supervised; a new blocked asks again", async () => {
    s = await makeSupervisedEnv();
    await s.status("blocked", { reason: "stuck" });
    const opened = await s.event("decision_opened");
    await resolve(opened.data.decision_id as string, "continue");
    expect(stage()).toBe("implement");
    expect(s.journal().some((e) => e.type === "agent_retired")).toBe(false);
    await s.status("working");
    await s.status("blocked", { reason: "stuck again" });
    await s.event("decision_opened", 2);
    expect(blockedOpened()[1]?.data.reason).toBe("stuck again");
  });

  it("continue, then done: the claim goes through the pipeline as usual", async () => {
    s = await makeSupervisedEnv();
    await s.status("blocked", { reason: "stuck" });
    const opened = await s.event("decision_opened");
    await resolve(opened.data.decision_id as string, "continue");
    await s.status("done", { summary: "ok" });
    // No artifacts in the fake world: the done is checked and the agent steered to push.
    await s.event((e) => e.type === "steering_sent" && e.data.reason === "artifacts");
  });

  it("respawn: retired as relaunched, the implementer's attempt 2 is launched", async () => {
    s = await makeSupervisedEnv();
    await s.status("blocked", { reason: "stuck" });
    const opened = await s.event("decision_opened");
    await resolve(opened.data.decision_id as string, "respawn");
    expect((await s.event("relaunched")).data).toMatchObject({ from_agent: AGENT });
    expect(
      s.journal().find((e) => e.type === "agent_retired" && e.data.agent_id === AGENT)?.data,
    ).toMatchObject({ status: "relaunched" });
    await s.event("agent_spawned", 2);
    expect(s.host.launches).toHaveLength(2);
  });

  it("cancel: the task is cancelled and the agent retired", async () => {
    s = await makeSupervisedEnv();
    await s.status("blocked", { reason: "stuck" });
    const opened = await s.event("decision_opened");
    await resolve(opened.data.decision_id as string, "cancel");
    await s.event("task_cancelled");
    await s.event((e) => e.type === "agent_retired" && e.data.agent_id === AGENT);
  });
});

describe("daemon: the terminal-status watchdog", () => {
  const alarms = () =>
    s.journal().filter((e) => e.type === "alarm_raised" && e.data.alarm === TERMINAL_ALARM);
  const late = DAEMON_DEFAULTS.terminal_unjournaled_alarm_ms + 1_000;

  it("a handled blocked status raises nothing", async () => {
    const clock = fakeClock(Date.now());
    s = await makeSupervisedEnv({ daemon: { clock } });
    await s.status("blocked", { reason: "stuck" });
    await s.event("decision_opened");
    await clock.advance(late);
    await s.daemon.tick();
    await s.settled();
    expect(alarms()).toHaveLength(0);
  });

  it("a done the pipeline drops: one alarm, cleared once the agent is retired", async () => {
    const clock = fakeClock(Date.now());
    s = await makeSupervisedEnv({ daemon: { clock } });
    // The pipeline loses the claim: nothing about the agent is journaled.
    const d = s.daemon as unknown as {
      pipelineFor(w: string): PipelineDriver;
      retire(id: string, status: string): Promise<void>;
    };
    const real = d.pipelineFor.bind(d);
    d.pipelineFor = (w) =>
      Object.assign(Object.create(real(w)), {
        handle: async () => {
          throw new Error("dropped");
        },
      });
    await s.status("done", { summary: "ok" });
    await s.consumed();
    await clock.advance(late);
    for (let i = 0; i < 3; i++) await s.daemon.tick();
    await s.settled();
    expect(alarms()).toHaveLength(1);
    expect(alarms()[0]?.data).toMatchObject({
      agent_id: AGENT,
      role: "implementer",
      status: "done",
    });
    expect(typeof alarms()[0]?.data.since).toBe("string");

    await d.retire(AGENT, "stopped");
    await s.daemon.tick();
    await s.settled();
    expect(
      s.journal().filter((e) => e.type === "alarm_cleared" && e.data.alarm === TERMINAL_ALARM),
    ).toHaveLength(1);
  });
});
