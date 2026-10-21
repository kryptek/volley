import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DEFAULTS, DAEMON_DEFAULTS } from "../src/config-defaults";
import { Daemon } from "../src/daemon";
import type { PipelineDriver, PipelineEvent } from "../src/pipeline";
import { BLOCKED_ALARM, TERMINAL_ALARM } from "../src/watchdog";
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
  vi.restoreAllMocks();
  await s?.cleanup();
});

const blockedOpened = () =>
  s.journal().filter((e) => e.type === "decision_opened" && e.data.kind === "agent_blocked");
const stage = () => s.daemon.snapshot("w1")?.tasks[0]?.stage;
const unhandled = () =>
  s.journal().filter((e) => e.type === "alarm_raised" && e.data.alarm === BLOCKED_ALARM);
const terminalAlarms = () =>
  s.journal().filter((e) => e.type === "alarm_raised" && e.data.alarm === TERMINAL_ALARM);
const late = DAEMON_DEFAULTS.terminal_unjournaled_alarm_ms + 1_000;

/** The daemon's pipeline for w1, with its `handle` replaced for `agent_blocked` events. */
function dropBlocked(daemon: Daemon, handle: (ev: PipelineEvent) => Promise<void>): void {
  const d = daemon as unknown as { pipelineFor(w: string): PipelineDriver };
  const real = d.pipelineFor.bind(d);
  d.pipelineFor = (w) => {
    const p = real(w);
    return Object.assign(Object.create(p), {
      handle: (task: string, ev: PipelineEvent) =>
        ev.kind === "agent_blocked" ? handle(ev) : p.handle(task, ev),
    });
  };
}

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

describe("daemon: a retained blocked always has a decision (the invariant)", () => {
  it("a blocked retained before supervision attaches (a restart) opens exactly one decision", async () => {
    s = await makeSupervisedEnv();
    await s.daemon.stop();
    await s.status("blocked", { reason: "stuck while volleyd was down" });
    await s.restart();
    const opened = await s.event(
      (e) => e.type === "decision_opened" && e.data.kind === "agent_blocked",
    );
    expect(opened.data).toMatchObject({
      agent_id: AGENT,
      reason: "stuck while volleyd was down",
      pipeline: { on: "agent_blocked", role: "implementer" },
    });
    await s.consumed();
    expect(blockedOpened()).toHaveLength(1);
  });

  it("the pipeline opens nothing: after the window the sweep asks, with one blocked_unhandled alarm", async () => {
    const clock = fakeClock(Date.now());
    s = await makeSupervisedEnv({ daemon: { clock } });
    dropBlocked(s.daemon, async () => {});
    await s.status("blocked", { reason: "stuck" });
    await s.consumed();
    expect(blockedOpened()).toHaveLength(0);
    await clock.advance(late);
    for (let i = 0; i < 3; i++) await s.daemon.tick();
    await s.settled();
    expect(blockedOpened()).toHaveLength(1);
    expect(blockedOpened()[0]).toMatchObject({
      task: "T1",
      data: {
        class: "blocked_unhandled",
        agent_id: AGENT,
        role: "implementer",
        reason: "stuck",
        options: ["respawn", "cancel"],
      },
    });
    expect(typeof blockedOpened()[0]?.data.status_at).toBe("string");
    expect(blockedOpened()[0]?.data.pipeline).toBeUndefined();
    expect(unhandled()).toHaveLength(1);
    expect(unhandled()[0]?.data).toMatchObject({ agent_id: AGENT });
    expect(String(unhandled()[0]?.data.why)).toContain("no decision");
    // The decision handles the status: the terminal-status watchdog stays quiet.
    expect(terminalAlarms()).toHaveLength(0);
    expect(stage()).toBe("awaiting_decision");
  });

  it("the pipeline throws: the daemon asks at once, the alarm carries the error", async () => {
    s = await makeSupervisedEnv();
    dropBlocked(s.daemon, async () => {
      throw new Error("view gone");
    });
    await s.status("blocked", { reason: "stuck" });
    const opened = await s.event(
      (e) => e.type === "decision_opened" && e.data.kind === "agent_blocked",
    );
    expect(opened.data).toMatchObject({ class: "blocked_unhandled", agent_id: AGENT });
    expect(String(unhandled()[0]?.data.why)).toContain("view gone");
  });

  it("its respawn: the agent is retired as relaunched and attempt 2 launches", async () => {
    s = await makeSupervisedEnv();
    dropBlocked(s.daemon, async () => {
      throw new Error("dropped");
    });
    await s.status("blocked", { reason: "stuck" });
    const opened = await s.event(
      (e) => e.type === "decision_opened" && e.data.kind === "agent_blocked",
    );
    await resolve(opened.data.decision_id as string, "respawn");
    await s.event((e) => e.type === "agent_retired" && e.data.agent_id === AGENT);
    expect(
      s.journal().find((e) => e.type === "agent_retired" && e.data.agent_id === AGENT)?.data,
    ).toMatchObject({ status: "relaunched" });
    await s.event("agent_spawned", 2);
    expect(s.host.launches).toHaveLength(2);
  });

  it("its cancel: the task is cancelled", async () => {
    s = await makeSupervisedEnv();
    dropBlocked(s.daemon, async () => {
      throw new Error("dropped");
    });
    await s.status("blocked", { reason: "stuck" });
    const opened = await s.event(
      (e) => e.type === "decision_opened" && e.data.kind === "agent_blocked",
    );
    await resolve(opened.data.decision_id as string, "cancel");
    await s.event("task_cancelled");
  });

  it("a blocked on a merge_ready task: a daemon-level manual | cancel decision, no error", async () => {
    const logs: string[] = [];
    s = await makeSupervisedEnv({ daemon: { log: (l) => logs.push(l) } });
    await s.daemon.recordEvent("w1", {
      type: "stage_entered",
      task: "T1",
      data: { stage: "merge_ready" },
    });
    await s.status("blocked", { reason: "stuck after the gate" });
    const opened = await s.event(
      (e) => e.type === "decision_opened" && e.data.kind === "agent_blocked",
    );
    expect(opened).toMatchObject({
      task: "T1",
      data: { class: "blocked_unhandled", agent_id: AGENT, options: ["manual", "cancel"] },
    });
    expect(unhandled()[0]?.data).toMatchObject({
      agent_id: AGENT,
      why: "the task is merge_ready",
    });
    await s.settled();
    expect(stage()).toBe("merge_ready");
    expect(logs.filter((l) => l.startsWith("error:"))).toEqual([]);
    // cancel on a settled task stops the agent; the task stays where it is.
    await resolve(opened.data.decision_id as string, "cancel");
    await s.event((e) => e.type === "agent_retired" && e.data.agent_id === AGENT);
    expect(stage()).toBe("merge_ready");
  });

  it("a blocked agent nobody decided on is stalled after blocked_undecided_stall_ms", async () => {
    const clock = fakeClock(Date.now());
    s = await makeSupervisedEnv({ daemon: { clock } });
    // Every path that would ask is lost: liveness is the last line.
    vi.spyOn(Daemon.prototype as never, "onBlocked").mockResolvedValue(undefined as never);
    vi.spyOn(Daemon.prototype as never, "blockedInvariant").mockResolvedValue(undefined as never);
    await s.hook("idle-stop.json");
    await s.status("blocked", { reason: "stuck" });
    await s.consumed();
    await s.daemon.tick();
    await clock.advance(CONFIG_DEFAULTS.blocked_undecided_stall_ms + 1_000);
    await s.daemon.tick();
    await s.settled();
    const stalled = s
      .journal()
      .filter((e) => e.type === "decision_opened" && e.data.kind === "agent_stalled");
    expect(stalled).toHaveLength(1);
    expect(stalled[0]?.data).toMatchObject({ agent_id: AGENT, options: ["respawn", "stop task"] });
    expect(String(stalled[0]?.data.question)).toContain("blocked");
  });
});

describe("daemon: the terminal-status watchdog", () => {
  const alarms = terminalAlarms;

  it("is armed for a blocked already retained when supervision attaches", async () => {
    const clock = fakeClock(Date.now());
    s = await makeSupervisedEnv({ daemon: { clock } });
    await s.daemon.stop();
    await s.status("blocked", { reason: "stuck" });
    vi.spyOn(Daemon.prototype as never, "onBlocked").mockResolvedValue(undefined as never);
    vi.spyOn(Daemon.prototype as never, "blockedInvariant").mockResolvedValue(undefined as never);
    const d = await s.restart();
    await d.reconciled();
    await s.consumed();
    await clock.advance(late);
    await d.tick();
    await s.settled();
    expect(alarms()).toHaveLength(1);
    expect(alarms()[0]?.data).toMatchObject({ agent_id: AGENT, status: "blocked" });
  });

  it("a blocked decided before a restart is not alarmed after it", async () => {
    const clock = fakeClock(Date.now());
    s = await makeSupervisedEnv({ daemon: { clock } });
    await s.status("blocked", { reason: "stuck" });
    await s.event("decision_opened");
    await s.daemon.stop();
    const d = await s.restart();
    await d.reconciled();
    await s.consumed();
    await clock.advance(late);
    await d.tick();
    await s.settled();
    expect(alarms()).toHaveLength(0);
    expect(blockedOpened()).toHaveLength(1);
  });

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
