import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { registryTopic } from "volley-mcp/topics";
import type { DecisionPayload } from "../src/decisions";
import { mintModelSwitchToken } from "../src/fence";
import {
  CREDIT_CLASS,
  LIMITED_CLASS,
  UNVERIFIED_CLASS,
  creditOccurrences,
  isRespawnAnswer,
  modelSwitchInput,
  parseSwitchAnswer,
  recoveryAllowed,
  respawnTarget,
  switchModel,
  switchOptions,
  withRespawnOn,
} from "../src/recovery";
import type { JournalEvent } from "../src/types";
import { watchAgent } from "../src/verify";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { eventually } from "./helpers/broker-wait";
import { type FakeClock, fakeClock } from "./helpers/fake-clock";
import { FIXTURES, fakeHost } from "./helpers/fake-host";
import { type Fleet, makeFleet } from "./helpers/fleet-env";
import { type Harness, pipelineHarness, sha } from "./helpers/pipeline-harness";
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

describe("respawn on <best> (SPEC §4.6.15: an agent whose host is down or not eligible)", () => {
  const failed = {
    kind: "agent_blocked" as const,
    task: "T1",
    question:
      "w1-t1-implementer-1 (implementer) failed. Respawn the implementer, or cancel the task?",
    options: ["respawn", "cancel"],
  };

  it("adds the third option right after respawn, saying where, why and what no answer does", () => {
    const d = withRespawnOn(failed, {
      host: "box-a",
      why: "down (no heartbeat for 90 s)",
      best: "studio",
      role: "implementer",
    });
    expect(d.options).toEqual(["respawn", "respawn on studio", "cancel"]);
    expect(d.question).toBe(
      `${failed.question} Where: box-a is down (no heartbeat for 90 s): respawn on studio starts the implementer on studio instead (the best eligible machine now), in a fresh worktree there (an implementer continues the branch and PR it pushed); respawn starts it on box-a again (it waits there until box-a takes new agents). If nobody answers, nothing is respawned.`,
    );
    // Asked again: the offer is made afresh, never twice.
    const again = withRespawnOn(
      { ...d, question: `"x" is not one of respawn / cancel. ${d.question}` },
      { host: "box-a", why: "down", best: "box-b" },
    );
    expect(again.options).toEqual(["respawn", "respawn on box-b", "cancel"]);
    expect(again.question.match(/Where: /g)).toHaveLength(1);
    expect(again.question).toContain("respawn on box-b starts the agent on box-b");
    // The machine is fine again: plain respawn alone, the note gone.
    expect(withRespawnOn(d, null)).toEqual(failed);
  });

  it("a machine closed to new agents offers only respawn on <best>, and plain respawn is no answer", () => {
    const d = withRespawnOn(failed, {
      host: "box-a",
      why: "being removed",
      best: "studio",
      role: "implementer",
      closed: true,
    });
    expect(d.options).toEqual(["respawn on studio", "cancel"]);
    expect(d.question).toContain(
      "Where: box-a is being removed, so nothing new starts there: respawn on studio starts the implementer on studio instead",
    );
    expect(d.question).not.toContain("respawn starts it on box-a");
    expect(isRespawnAnswer("respawn", d.options)).toBe(false);
    expect(isRespawnAnswer("respawn on studio", d.options)).toBe(true);
    // Asked again once the machine is fine: plain respawn comes back.
    expect(withRespawnOn(d, null).options).toEqual(["respawn", "cancel"]);
  });

  it("only decisions that offer respawn get it", () => {
    const other = { ...failed, options: ["skip", "cancel"] };
    expect(withRespawnOn(other, { host: "box-a", why: "down", best: "studio" })).toEqual(other);
  });

  it("an answer counts only when it is the offered option (case and space aside)", () => {
    const offered = ["respawn", "respawn on studio", "cancel"];
    expect(respawnTarget(" Respawn on studio ", offered)).toBe("studio");
    expect(respawnTarget("respawn on box-b", offered)).toBeNull();
    expect(respawnTarget("respawn", offered)).toBeNull();
    expect(isRespawnAnswer("respawn", offered)).toBe(true);
    expect(isRespawnAnswer("respawn on studio", offered)).toBe(true);
    expect(isRespawnAnswer("respawn on box-b", offered)).toBe(false);
    expect(isRespawnAnswer("cancel", offered)).toBe(false);
  });
});

describe("respawn on <best>: the role starts elsewhere with the task's branch and PR", () => {
  let h: Harness;
  afterEach(() => h?.cleanup());

  it("a reviewer that failed on a down machine is respawned with the same PR branch and URL", async () => {
    const H1 = sha(0x1001);
    h = pipelineHarness({
      // What the daemon adds when the task's machine (box) is down and studio is the best one.
      decideWith: (input, extra) =>
        withRespawnOn(input, {
          host: "box",
          why: "down (disconnected)",
          best: "studio",
          role: (extra.pipeline as { role: string }).role,
        }),
    });
    await h.start();
    h.openPr(H1);
    await h.finish("implementer", { head: H1, ci: "green" });
    await h.finish("spec_reviewer", { status: "failed" });
    const [d] = h.openDecisions();
    expect(d?.options).toEqual(["respawn", "respawn on studio", "cancel"]);
    await h.resolve(d?.decision_id as string, "respawn on studio");
    const specs = h.spawns.filter((s) => s.role === "spec_reviewer");
    expect(specs).toHaveLength(2);
    expect(specs[1]?.agent_id).not.toBe(specs[0]?.agent_id);
    expect(specs[1]?.start).toEqual({ ref: H1, detach: true });
    // The same branch and PR, by name: the review brief is the one the first reviewer had.
    expect(specs[1]?.files["review.md"]).toBe(specs[0]?.files["review.md"]);
    expect(specs[1]?.files["review.md"]).toContain("https://github.com/example/repo/pull/7");
  });

  it("an answer that is not the offered machine is asked again, nothing respawns", async () => {
    h = pipelineHarness({
      decideWith: (input) => withRespawnOn(input, { host: "box", why: "down", best: "studio" }),
    });
    await h.start();
    h.openPr(sha(0x1001));
    await h.finish("implementer", { status: "failed" });
    const [d] = h.openDecisions();
    await h.resolve(d?.decision_id as string, "respawn on elsewhere");
    expect(h.spawns.filter((s) => s.role === "implementer")).toHaveLength(1);
    expect(h.openDecisions()[0]?.question).toMatch(/^"respawn on elsewhere" is not one of/);
  });
});

describe("daemon: a reaped agent on a down machine offers respawn on <best>", () => {
  let f: Fleet;
  beforeEach(async () => {
    f = await makeFleet();
  });
  afterEach(async () => {
    await f.close();
  });

  it("offers the live best machine; choosing it re-places the task and respawns the role there", async () => {
    await f.submit("w1", "", "  T1: { issue: 42, host: box }\n");
    await f.tick();
    const first = f.agentOf("w1", "T1");
    await f.supervised(first);
    await f.lwt();
    await f.finish(first, "reaped");
    // Past the reap grace: retired, and the pipeline asks.
    let d: DecisionPayload | null = null;
    for (let i = 0; i < 20 && d === null; i++) {
      await f.tick(60_000);
      const opened = f
        .journal("w1")
        .find((e) => e.type === "decision_opened" && e.data.kind === "agent_blocked");
      if (opened !== undefined) d = await f.decision("w1", opened.data.decision_id as string);
    }
    expect(d?.options).toEqual(["respawn", "respawn on control", "cancel"]);
    expect(d?.question).toContain(
      "box is down (disconnected): respawn on control starts the implementer on control instead",
    );
    expect(f.local.launches).toHaveLength(0);

    // The first attempt pushed its branch and opened PR #7 from it.
    f.exec.on(["gh", "pr", "list", "--head", "w1/T1-implementer-1"], {
      stdout: JSON.stringify([
        {
          number: 7,
          url: "https://github.com/example/repo/pull/7",
          headRefName: "w1/T1-implementer-1",
        },
      ]),
    });
    await f.resolve("w1", d?.decision_id as string, "respawn on control");
    const placed = f.journal("w1").filter((e) => e.type === "task_placed");
    expect(placed.at(-1)?.data).toMatchObject({
      task: "T1",
      host: "control",
      by: "decision",
      from: "box",
      local: true,
    });
    await f.tick();
    expect(f.local.launches.map((l) => l.name)).toEqual(["w1 T1 implementer 2"]);
    // A fresh worktree there, on the branch the first attempt pushed (origin's copy), and the
    // brief names it and its open PR: no second branch, no second PR.
    const wt = f.local.worktrees.at(-1);
    expect(wt).toMatchObject({
      branch: "w1/T1-implementer-1",
      base: "w1/T1-implementer-1",
      releaseBase: true,
    });
    const spawned = f.journal("w1").filter((e) => e.type === "agent_spawned");
    expect(spawned.at(-1)?.data).toMatchObject({
      agent_id: "w1-t1-implementer-2",
      branch: "w1/T1-implementer-1",
    });
    expect(spawned.at(-1)?.data.base_sha).toBeUndefined();
    const brief = readFileSync(join(wt?.path as string, ".volley", "brief.md"), "utf-8");
    expect(brief).toContain(
      "An earlier attempt of this task pushed `w1/T1-implementer-1`, and this worktree continues it",
    );
    expect(brief).toContain(
      "PR #7 (https://github.com/example/repo/pull/7) is open from it: push your commits to `w1/T1-implementer-1` and that PR picks them up. Do not open another PR.",
    );
    expect((await f.task("w1", "T1"))?.placement).toMatchObject({
      host: "control",
      by: "decision",
    });
  });
});

describe("daemon: respawn on <machine> is checked again when it is answered", () => {
  let f: Fleet;
  beforeEach(async () => {
    f = await makeFleet();
  });
  afterEach(async () => {
    await f.close();
  });

  it("a machine no longer eligible refuses the answer, re-places nothing and asks again afresh", async () => {
    await f.submit("w1", "", "  T1: { issue: 42, host: box }\n");
    await f.tick();
    const first = f.agentOf("w1", "T1");
    await f.supervised(first);
    await f.lwt();
    await f.finish(first, "reaped");
    let d: DecisionPayload | null = null;
    for (let i = 0; i < 20 && d === null; i++) {
      await f.tick(60_000);
      const opened = f
        .journal("w1")
        .find((e) => e.type === "decision_opened" && e.data.kind === "agent_blocked");
      if (opened !== undefined) d = await f.decision("w1", opened.data.decision_id as string);
    }
    expect(d?.options).toEqual(["respawn", "respawn on control", "cancel"]);
    // Hours later control is overloaded: its next record says so.
    f.setLocalLoad([9999, 9999, 9999]);
    await eventually(async () => {
      await f.tick(30_000);
      return (await f.verdict("control"))?.eligible === false;
    });
    await f.resolve("w1", d?.decision_id as string, "respawn on control");
    const resolved = f
      .journal("w1")
      .find((e) => e.type === "decision_resolved" && e.data.decision_id === d?.decision_id);
    expect(resolved?.data.answer).toMatch(
      /^respawn on control \(refused: control cannot take it now: it is not eligible \(overloaded: load 9999\.0 on \d+ cores · no new agents\)\)$/,
    );
    expect(f.journal("w1").some((e) => e.type === "task_placed" && e.data.by === "decision")).toBe(
      false,
    );
    await f.tick();
    expect(f.local.launches).toHaveLength(0);
    // Asked again: nothing else is eligible now, so plain respawn and cancel.
    const again = f
      .journal("w1")
      .filter((e) => e.type === "decision_opened" && e.data.kind === "agent_blocked")
      .at(-1);
    expect(again?.data.decision_id).not.toBe(d?.decision_id);
    expect(again?.data.options).toEqual(["respawn", "cancel"]);
    expect(again?.data.question).toMatch(
      /^"respawn on control \(refused: control cannot take it now/,
    );
    expect(String(again?.data.question)).not.toContain("Where: ");
  });
});

describe("daemon: an implementer respawn whose earlier branch was never pushed", () => {
  let f: Fleet;
  beforeEach(async () => {
    f = await makeFleet();
  });
  afterEach(async () => {
    await f.close();
  });

  it("starts a fresh branch from the release branch", async () => {
    await f.submit("w1", "", "  T1: { issue: 42 }\n");
    await f.tick();
    const first = f.agentOf("w1", "T1");
    await f.supervised(first);
    const repo = f.local.worktrees[0]?.repo as string;
    f.exec.on(["git", "-C", repo, "fetch", "--quiet", "origin", "w1/T1-implementer-1"], {
      code: 1,
      stderr: "fatal: couldn't find remote ref w1/T1-implementer-1",
    });
    await f.finish(first, "failed");
    let id: string | undefined;
    for (let i = 0; i < 20 && id === undefined; i++) {
      await f.tick();
      id = f
        .journal("w1")
        .find((e) => e.type === "decision_opened" && e.data.kind === "agent_blocked")?.data
        .decision_id as string | undefined;
    }
    await f.resolve("w1", id as string, "respawn");
    await eventually(async () => {
      await f.tick();
      return f.local.worktrees.length === 2;
    });
    expect(f.local.worktrees.at(-1)).toMatchObject({
      branch: "w1/T1-implementer-2",
      base: "release/w1",
    });
  });
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
  /** The watch's verification window runs on it: it closes only when the test says. */
  let clock: FakeClock;
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
    clock = fakeClock();
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
    const watch = await watchAgent(daemonSide, NS, AGENT, clock);
    expect(host.texts).toEqual([]);
    const pending = switchModel({
      host,
      workspace: "workspace:1",
      watch,
      token: mintModelSwitchToken("claude-sonnet-5-5", "d-1"),
      timeoutMs: 2000,
    });
    await agentSide.publish(registryTopic(AGENT), registry("claude-sonnet-5-5"), {
      qos: 1,
      retain: true,
    });
    // The window never closes on its own (the clock stands still): only the re-publish settles it.
    const r = await pending;
    expect(r.ok).toBe(true);
    expect(host.texts).toEqual([{ workspace: "workspace:1", text: "/model claude-sonnet-5-5" }]);
    expect(host.keys).toEqual([{ workspace: "workspace:1", key: "Enter" }]);
    await watch.close();
  });

  it("a re-publish with another model, or none, is not a switch", async () => {
    const host = fakeHost();
    const watch = await watchAgent(daemonSide, NS, AGENT, clock);
    const pending = switchModel({
      host,
      workspace: "workspace:1",
      watch,
      token: mintModelSwitchToken("claude-sonnet-5-5", "d-1"),
      timeoutMs: 300,
    });
    await agentSide.publish(registryTopic(AGENT), registry("claude-opus-5-5"), {
      qos: 1,
      retain: true,
    });
    await eventually(() => watch.state.hookRegistry?.model === "claude-opus-5-5");
    await clock.armed(300); // the window opened once `/model` was typed
    await clock.advance(300);
    expect((await pending).ok).toBe(false);
    await watch.close();
  });

  it("an entry that already named the model before the switch does not count: it must be re-published", async () => {
    await agentSide.publish(registryTopic(AGENT), registry("claude-sonnet-5-5"), {
      qos: 1,
      retain: true,
    });
    const host = fakeHost();
    const watch = await watchAgent(daemonSide, NS, AGENT, clock);
    expect(await watch.waitFor((s) => s.hookRegistry !== null, 1000)).toBe(true);
    const pending = switchModel({
      host,
      workspace: "workspace:1",
      watch,
      token: mintModelSwitchToken("claude-sonnet-5-5", "d-1"),
      timeoutMs: 300,
    });
    await clock.armed(300); // the window opened once `/model` was typed
    await clock.advance(300);
    expect((await pending).ok).toBe(false);
    await watch.close();
  });

  it("a re-delivery of that same retained entry (e.g. after a reconnect) is not a re-publish", async () => {
    const raw = registry("claude-sonnet-5-5");
    await agentSide.publish(registryTopic(AGENT), raw, { qos: 1, retain: true });
    const host = fakeHost();
    const watch = await watchAgent(daemonSide, NS, AGENT, clock);
    expect(await watch.waitFor((s) => s.hookRegistry !== null, 1000)).toBe(true);
    const first = watch.state.hookRegistry;
    const pending = switchModel({
      host,
      workspace: "workspace:1",
      watch,
      token: mintModelSwitchToken("claude-sonnet-5-5", "d-1"),
      timeoutMs: 1000,
    });
    // The identical envelope again (same wall_time): a new object in the watch, the same entry.
    await agentSide.publish(registryTopic(AGENT), raw, { qos: 1, retain: true });
    await eventually(() => watch.state.hookRegistry !== first);
    await clock.armed(1000);
    await clock.advance(1000);
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
  const nth = (n: number) =>
    s.event((e) => e.type === "decision_opened" && e.data.kind === "model_switch", n);
  const alarm = (name: string) =>
    s.event((e) => e.type === "alarm_raised" && e.data.alarm === name);

  it("opens model_switch; nothing is typed before resolve; 'switch to X' types /model X and is verified by the registry", async () => {
    s = await makeSupervisedEnv({ config: "fallback_model: claude-sonnet-5-5" });
    await s.hook("awaiting-credit.json");
    const d = await nth(1);
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
    await alarm("model_switch_sent");
    await s.settled(); // the fake host has the keys typed right after
    expect(s.host.texts).toHaveLength(1);
    expect(s.host.texts[0]?.text).toBe("/model claude-sonnet-5-5");
    expect(s.host.keys.at(-1)?.key).toBe("Enter");
    await s.hook("post-model-switch-registry.json");
    await alarm("model_switch_verified");
    expect(opened()).toHaveLength(1);
  });

  it("no re-publish within the verify window → the decision is re-opened with the screen capture", async () => {
    const clock = fakeClock(Date.now());
    s = await makeSupervisedEnv({
      config: "fallback_model: claude-sonnet-5-5",
      daemon: { clock, recoveryTimeouts: { modelSwitchVerifyMs: 200 } },
    });
    s.host.screens = ["… still at the usage-limit prompt …"];
    await s.hook("awaiting-credit.json");
    await s.daemon.resolveDecision("w1", (await nth(1)).data.decision_id as string, {
      answer: "switch to claude-sonnet-5-5",
      by: "tester",
    });
    await alarm("model_switch_sent");
    // No re-publish: the verify window closes.
    await clock.armed(200);
    await clock.advance(200);
    const again = await nth(2);
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
      await nth(n);
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
    await s.event(
      (e) => e.type === "decision_resolved" && e.data.decision_id === third.data.decision_id,
    );
    // A tick after the resolve: anything it started has run by then.
    await s.daemon.tick();
    await s.settled();
    expect(s.host.texts).toEqual([]);
    expect(
      s.journal().some((e) => e.type === "alarm_raised" && e.data.alarm === "model_switch_sent"),
    ).toBe(false);
  });

  it("'wait' types nothing; 'stop task' cancels the task's agent", async () => {
    s = await makeSupervisedEnv({ config: "fallback_model: claude-sonnet-5-5" });
    await s.hook("awaiting-credit.json");
    await s.daemon.resolveDecision("w1", (await nth(1)).data.decision_id as string, {
      answer: "wait",
      by: "tester",
    });
    // A resumed agent, then a second credit prompt: a fresh decision; this one is stopped.
    await s.hook("resumed.json");
    await s.hook("awaiting-credit.json");
    await nth(2);
    expect(s.host.texts).toEqual([]);
    await s.daemon.resolveDecision("w1", opened()[1]?.data.decision_id as string, {
      answer: "stop task",
      by: "tester",
    });
    await s.event("task_cancelled");
    await s.settled();
    expect(
      s.journal().find((e) => e.type === "steering_sent" && e.data.type === "cancel")?.data,
    ).toMatchObject({ agent_id: AGENT });
    expect(s.host.texts).toEqual([]);
  });
});

describe("daemon: a task on the own machine under fallback, while a peer is eligible", () => {
  let f: Fleet;
  beforeEach(async () => {
    f = await makeFleet({ localAgents: "fallback" });
  });
  afterEach(async () => {
    await f.close();
  });

  it("offers plain respawn only: the fallback is a placement preference, not trouble on the machine", async () => {
    await f.submit("w1", "", "  T1: { issue: 42, host: local }\n");
    await f.tick();
    const first = f.agentOf("w1", "T1");
    await f.supervised(first);
    expect((await f.verdict("control"))?.eligible).toBe(false);
    await f.finish(first, "failed");
    const opened = () =>
      f.journal("w1").find((e) => e.type === "decision_opened" && e.data.kind === "agent_blocked");
    await eventually(async () => {
      await f.tick(0);
      return opened() !== undefined;
    });
    const d = await f.decision("w1", opened()?.data.decision_id as string);
    expect((await f.verdict("box"))?.eligible).toBe(true);
    expect((await f.verdict("control"))?.eligible).toBe(false);
    expect(d?.options).toEqual(["respawn", "cancel"]);
    expect(d?.question).not.toContain("Where: ");
  });
});
