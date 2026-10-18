import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { registryTopic } from "volley-mcp/topics";
import { mintModelSwitchToken } from "../src/fence";
import {
  CREDIT_CLASS,
  LIMITED_CLASS,
  UNVERIFIED_CLASS,
  creditOccurrences,
  modelSwitchInput,
  parseSwitchAnswer,
  recoveryAllowed,
  switchModel,
  switchOptions,
} from "../src/recovery";
import type { JournalEvent } from "../src/types";
import { watchAgent } from "../src/verify";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { FIXTURES, fakeHost } from "./helpers/fake-host";
import { AGENT, type SupervisedEnv, makeSupervisedEnv } from "./helpers/supervised-env";

const NS = "volleyd-test";
const T0 = Date.parse("2026-10-18T12:00:00.000Z");

const creditOpened = (at: number, agent = AGENT, seq = 1): JournalEvent => ({
  seq,
  at: new Date(at).toISOString(),
  type: "decision_opened",
  task: "T1",
  data: { decision_id: `d-${seq}`, kind: "model_switch", class: CREDIT_CLASS, agent_id: agent },
});

describe("model_switch decision (credit_exhausted)", () => {
  it("offers the fallback model, wait and stop; no fallback → wait/stop only", () => {
    expect(switchOptions("claude-sonnet-5-5", true)).toEqual([
      "switch to claude-sonnet-5-5",
      "wait",
      "stop task",
    ]);
    expect(switchOptions(null, true)).toEqual(["wait", "stop task"]);
    expect(switchOptions("claude-sonnet-5-5", false)).toEqual(["wait", "stop task"]);
  });

  it("builds a model_switch decision carrying the class, agent, fallback and evidence", () => {
    const { input, data } = modelSwitchInput({
      task: "T1",
      agent_id: AGENT,
      fallback_model: "claude-sonnet-5-5",
      allowed: true,
      source: "screen",
      text: "Claude usage limit reached.",
      screen: "/volleyd-home/waves/w1/screens/a.txt",
    });
    expect(input).toMatchObject({
      kind: "model_switch",
      task: "T1",
      options: ["switch to claude-sonnet-5-5", "wait", "stop task"],
      pointers: { screen: "/volleyd-home/waves/w1/screens/a.txt" },
    });
    expect(input.question).toContain(AGENT);
    expect(data).toMatchObject({
      class: CREDIT_CLASS,
      agent_id: AGENT,
      fallback_model: "claude-sonnet-5-5",
      recovery_allowed: true,
      source: "screen",
    });
  });

  it("the third occurrence within an hour is decision only", () => {
    const events = [
      creditOpened(T0 - 50 * 60_000, AGENT, 1),
      creditOpened(T0 - 10 * 60_000, AGENT, 2),
    ];
    expect(creditOccurrences(events, AGENT, T0)).toBe(2);
    // Older than an hour, or another agent's, does not count.
    const old = [creditOpened(T0 - 61 * 60_000, AGENT, 1), creditOpened(T0 - 60_000, "other", 2)];
    expect(creditOccurrences(old, AGENT, T0)).toBe(0);
    const third = modelSwitchInput({
      task: "T1",
      agent_id: AGENT,
      fallback_model: "claude-sonnet-5-5",
      allowed: recoveryAllowed(creditOccurrences(events, AGENT, T0)),
      source: "hook",
      text: null,
    });
    expect(recoveryAllowed(creditOccurrences(events.slice(0, 1), AGENT, T0))).toBe(true);
    expect(third.input.options).toEqual(["wait", "stop task"]);
    expect(third.data.recovery_allowed).toBe(false);
    expect(third.input.question).toMatch(/already ran 2 times in the last 60 min/);
  });

  it("a switch refused by the limit says so (nothing was typed), not that it went unverified", () => {
    const limited = modelSwitchInput({
      task: "T1",
      agent_id: AGENT,
      fallback_model: "claude-sonnet-5-5",
      allowed: false,
      source: "screen",
      text: null,
      class: LIMITED_CLASS,
      tried: "claude-sonnet-5-5",
    });
    expect(limited.input.question).toMatch(/was not typed/);
    expect(limited.input.question).not.toMatch(/not confirmed/);
    expect(limited.input.options).toEqual(["wait", "stop task"]);
    expect(limited.data.class).toBe(LIMITED_CLASS);
  });

  it("parses the resolve answer; a switch needs an allowed recovery and a model", () => {
    const d = { fallback_model: "claude-sonnet-5-5", recovery_allowed: true };
    expect(parseSwitchAnswer("switch to claude-sonnet-5-5", d)).toEqual({
      kind: "switch",
      model: "claude-sonnet-5-5",
    });
    expect(parseSwitchAnswer("Switch", d)).toEqual({ kind: "switch", model: "claude-sonnet-5-5" });
    expect(parseSwitchAnswer("switch to claude-haiku-5-5", d)).toEqual({
      kind: "switch",
      model: "claude-haiku-5-5",
    });
    expect(parseSwitchAnswer("wait", d)).toEqual({ kind: "wait" });
    expect(parseSwitchAnswer("stop task", d)).toEqual({ kind: "stop" });
    expect(parseSwitchAnswer("switch", { fallback_model: null, recovery_allowed: true })).toEqual({
      kind: "other",
    });
    expect(
      parseSwitchAnswer("switch to claude-sonnet-5-5", { ...d, recovery_allowed: false }),
    ).toEqual({
      kind: "other",
    });
  });
});

describe("switchModel: /model + Enter, verified by the PostModelSwitch registry re-publish (Aedes)", () => {
  let broker: TestBroker;
  let daemonSide: VolleyBroker;
  let agentSide: VolleyBroker;
  const registry = (model: string) => {
    const e = JSON.parse(
      readFileSync(join(FIXTURES, "hooks", "post-model-switch-registry.json"), "utf-8"),
    );
    e.payload.model = model;
    return JSON.stringify(e);
  };

  beforeEach(async () => {
    broker = await startTestBroker();
    daemonSide = new VolleyBroker();
    await daemonSide.connect({ url: broker.url, agentId: "volleyd" });
    agentSide = new VolleyBroker();
    await agentSide.connect({ url: broker.url, agentId: "agent-sim" });
  });
  afterEach(async () => {
    await agentSide.disconnect();
    await daemonSide.disconnect();
    await broker.close();
  });

  it("types /model <m> and Enter; success once the registry is re-published with model == m", async () => {
    const host = fakeHost();
    const watch = await watchAgent(daemonSide, NS, AGENT);
    expect(host.texts).toEqual([]);
    setTimeout(() => {
      void agentSide.publish(registryTopic(AGENT), registry("claude-sonnet-5-5"), {
        qos: 1,
        retain: true,
      });
    }, 50);
    const r = await switchModel({
      host,
      workspace: "workspace:1",
      watch,
      token: mintModelSwitchToken("claude-sonnet-5-5", "d-1"),
      timeoutMs: 2000,
    });
    expect(r.ok).toBe(true);
    expect(host.texts).toEqual([{ workspace: "workspace:1", text: "/model claude-sonnet-5-5" }]);
    expect(host.keys).toEqual([{ workspace: "workspace:1", key: "Enter" }]);
    await watch.close();
  });

  it("a re-publish with another model, or none, is not a switch", async () => {
    const host = fakeHost();
    const watch = await watchAgent(daemonSide, NS, AGENT);
    setTimeout(() => {
      void agentSide.publish(registryTopic(AGENT), registry("claude-opus-5-5"), {
        qos: 1,
        retain: true,
      });
    }, 30);
    const wrong = await switchModel({
      host,
      workspace: "workspace:1",
      watch,
      token: mintModelSwitchToken("claude-sonnet-5-5", "d-1"),
      timeoutMs: 300,
    });
    expect(wrong.ok).toBe(false);
    await watch.close();
  });

  it("an entry that already named the model before the switch does not count: it must be re-published", async () => {
    await agentSide.publish(registryTopic(AGENT), registry("claude-sonnet-5-5"), {
      qos: 1,
      retain: true,
    });
    const host = fakeHost();
    const watch = await watchAgent(daemonSide, NS, AGENT);
    await watch.waitFor((s) => s.hookRegistry !== null, 1000);
    const r = await switchModel({
      host,
      workspace: "workspace:1",
      watch,
      token: mintModelSwitchToken("claude-sonnet-5-5", "d-1"),
      timeoutMs: 300,
    });
    expect(r.ok).toBe(false);
    await watch.close();
  });

  it("a re-delivery of that same retained entry (e.g. after a reconnect) is not a re-publish", async () => {
    const raw = registry("claude-sonnet-5-5");
    await agentSide.publish(registryTopic(AGENT), raw, { qos: 1, retain: true });
    const host = fakeHost();
    const watch = await watchAgent(daemonSide, NS, AGENT);
    await watch.waitFor((s) => s.hookRegistry !== null, 1000);
    const pending = switchModel({
      host,
      workspace: "workspace:1",
      watch,
      token: mintModelSwitchToken("claude-sonnet-5-5", "d-1"),
      timeoutMs: 1000,
    });
    // The identical envelope again (same wall_time): a new object in the watch, the same entry.
    await agentSide.publish(registryTopic(AGENT), raw, { qos: 1, retain: true });
    expect((await pending).ok).toBe(false);
    await watch.close();
  });
});

describe("daemon: credit exhaustion → approval-gated model switch", () => {
  let s: SupervisedEnv;
  afterEach(async () => {
    await s.cleanup();
  });

  const opened = () =>
    s.journal().filter((e) => e.type === "decision_opened" && e.data.kind === "model_switch");

  it("opens model_switch; nothing is typed before resolve; 'switch to X' types /model X and is verified by the registry", async () => {
    s = await makeSupervisedEnv({ config: "fallback_model: claude-sonnet-5-5" });
    await s.hook("awaiting-credit.json");
    await s.until(() => opened().length === 1);
    const d = opened()[0] as JournalEvent;
    expect(d.data).toMatchObject({
      class: CREDIT_CLASS,
      agent_id: AGENT,
      options: ["switch to claude-sonnet-5-5", "wait", "stop task"],
    });
    expect(s.host.texts).toEqual([]);
    await s.daemon.tick();
    expect(s.host.texts).toEqual([]);

    await s.daemon.resolveDecision("w1", d.data.decision_id as string, {
      answer: "switch to claude-sonnet-5-5",
      by: "tester",
    });
    await s.until(() => s.host.texts.length === 1);
    expect(s.host.texts[0]?.text).toBe("/model claude-sonnet-5-5");
    expect(s.host.keys.at(-1)?.key).toBe("Enter");
    await s.hook("post-model-switch-registry.json");
    await s.until(() =>
      s
        .journal()
        .some((e) => e.type === "alarm_raised" && e.data.alarm === "model_switch_verified"),
    );
    expect(opened()).toHaveLength(1);
  });

  it("no re-publish within the verify window → the decision is re-opened with the screen capture", async () => {
    s = await makeSupervisedEnv({
      config: "fallback_model: claude-sonnet-5-5",
      daemon: { recoveryTimeouts: { modelSwitchVerifyMs: 200 } },
    });
    s.host.screens = ["… still at the usage-limit prompt …"];
    await s.hook("awaiting-credit.json");
    await s.until(() => opened().length === 1);
    await s.daemon.resolveDecision("w1", opened()[0]?.data.decision_id as string, {
      answer: "switch to claude-sonnet-5-5",
      by: "tester",
    });
    await s.until(() => opened().length === 2);
    const again = opened()[1] as JournalEvent;
    expect(again.data).toMatchObject({ class: UNVERIFIED_CLASS, agent_id: AGENT });
    expect((again.data.pointers as { screen?: string }).screen).toMatch(/\.txt$/);
    expect(
      s
        .journal()
        .some((e) => e.type === "alarm_raised" && e.data.alarm === "model_switch_unverified"),
    ).toBe(true);
  });

  it("the third credit exhaustion within the hour is decision only: no switch offered, a switch answer types nothing", async () => {
    s = await makeSupervisedEnv({ config: "fallback_model: claude-sonnet-5-5" });
    for (let n = 1; n <= 3; n++) {
      await s.hook("awaiting-credit.json", { seq: 10 + n });
      await s.until(() => opened().length === n);
      if (n === 3) break;
      await s.daemon.resolveDecision("w1", opened()[n - 1]?.data.decision_id as string, {
        answer: "wait",
        by: "tester",
      });
      await s.hook("resumed.json", { seq: 20 + n });
    }
    expect(opened()[1]?.data).toMatchObject({
      options: ["switch to claude-sonnet-5-5", "wait", "stop task"],
      recovery_allowed: true,
    });
    const third = opened()[2] as JournalEvent;
    expect(third.data).toMatchObject({
      class: CREDIT_CLASS,
      options: ["wait", "stop task"],
      recovery_allowed: false,
    });
    await s.daemon.resolveDecision("w1", third.data.decision_id as string, {
      answer: "switch to claude-sonnet-5-5",
      by: "tester",
    });
    await s.until(() =>
      s
        .journal()
        .some(
          (e) => e.type === "decision_resolved" && e.data.decision_id === third.data.decision_id,
        ),
    );
    // A tick after the resolve: anything it started has run by then.
    await s.daemon.tick();
    await s.daemon.tick();
    expect(s.host.texts).toEqual([]);
    expect(
      s.journal().some((e) => e.type === "alarm_raised" && e.data.alarm === "model_switch_sent"),
    ).toBe(false);
  });

  it("'wait' types nothing; 'stop task' cancels the task's agent", async () => {
    s = await makeSupervisedEnv({ config: "fallback_model: claude-sonnet-5-5" });
    await s.hook("awaiting-credit.json");
    await s.until(() => opened().length === 1);
    await s.daemon.resolveDecision("w1", opened()[0]?.data.decision_id as string, {
      answer: "wait",
      by: "tester",
    });
    // A resumed agent, then a second credit prompt: a fresh decision; this one is stopped.
    await s.hook("resumed.json");
    await s.hook("awaiting-credit.json");
    await s.until(() => opened().length === 2);
    expect(s.host.texts).toEqual([]);
    await s.daemon.resolveDecision("w1", opened()[1]?.data.decision_id as string, {
      answer: "stop task",
      by: "tester",
    });
    await s.until(() => s.journal().some((e) => e.type === "task_cancelled"));
    expect(
      s.journal().find((e) => e.type === "steering_sent" && e.data.type === "cancel")?.data,
    ).toMatchObject({ agent_id: AGENT });
    expect(s.host.texts).toEqual([]);
  });
});
