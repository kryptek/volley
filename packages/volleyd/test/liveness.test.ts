import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AgentLiveness,
  type HookSignal,
  type LivenessAction,
  checkLiveness,
  noteCapture,
  noteDecision,
  observeScreen,
  observeSignal,
  parseHookSignal,
  rebase,
  trackAgent,
  whyWaiting,
} from "../src/liveness";
import { FIXTURES } from "./helpers/fake-host";
import { AGENT, type SupervisedEnv, makeSupervisedEnv } from "./helpers/supervised-env";

const MIN = 60_000;
const T0 = Date.parse("2026-10-18T12:00:00.000Z");
const TUNABLES = { idle_grace_s: 180, heartbeat_alarm_s: 600 };

const hook = (name: string, at: number): HookSignal => {
  const sig = parseHookSignal(readFileSync(join(FIXTURES, "hooks", name), "utf-8"), at);
  if (sig === null) throw new Error(`${name} is not a hook signal`);
  return sig;
};
const screen = (name: string) => readFileSync(join(FIXTURES, "screens", name), "utf-8");

/** Fold steps, collecting every action. */
function run(
  start: AgentLiveness,
  steps: ((s: AgentLiveness) => { state: AgentLiveness; actions: LivenessAction[] })[],
) {
  let s = start;
  const actions: LivenessAction[] = [];
  for (const step of steps) {
    const r = step(s);
    s = r.state;
    actions.push(...r.actions);
  }
  return { state: s, actions };
}

const signal = (name: string, at: number) => (s: AgentLiveness) => observeSignal(s, hook(name, at));
const check =
  (at: number, status: string | null = "working") =>
  (s: AgentLiveness) =>
    checkLiveness(s, { now: at, status, tunables: TUNABLES });
const read = (text: string | null, at: number) => (s: AgentLiveness) =>
  observeScreen(s, { now: at, screen: text });

const fresh = () => trackAgent({ agent_id: "w1-t1-implementer-1", task: "T1", now: T0 });
const kinds = (a: LivenessAction[]) => a.map((x) => x.kind);

describe("parseHookSignal", () => {
  it("parses a harness-hook progress envelope; anything else is not a hook signal", () => {
    expect(hook("heartbeat.json", T0)).toMatchObject({
      type: "heartbeat",
      at: T0,
      seq: 5,
      hook_event: "PostToolUse",
    });
    const narration = JSON.stringify({
      schema_version: "0.1",
      agent_id: "a",
      parent_id: null,
      wall_time: "2026-10-18T12:00:00.000Z",
      channel: "progress",
      type: "narration",
      payload: { progress: 40, msg: "working" },
      correlation_id: null,
    });
    expect(parseHookSignal(narration, T0)).toBeNull();
    expect(parseHookSignal("not json", T0)).toBeNull();
    expect(parseHookSignal("", T0)).toBeNull();
  });
});

describe("liveness: questions (awaiting_input permission_prompt / agent_needs_input)", () => {
  it("opens agent_question with the last Stop text and never reads the screen", () => {
    const r = run(fresh(), [
      signal("idle-stop.json", T0 + MIN),
      signal("awaiting-permission-prompt.json", T0 + 1.1 * MIN),
    ]);
    expect(kinds(r.actions)).toEqual(["agent_question"]);
    const q = r.actions[0] as Extract<LivenessAction, { kind: "agent_question" }>;
    expect(q.last_text).toContain("Should I add the column");
    expect(q.notification_type).toBe("permission_prompt");
    expect(r.state.activity).toBe("awaiting_input");
    // Waiting on a question is neither silence nor a stall: no screen read, no steer, ever.
    const later = run(r.state, [check(T0 + 30 * MIN), check(T0 + 60 * MIN)]);
    expect(later.actions).toEqual([]);
  });

  it("agent_needs_input opens it too; a second prompt for the same question opens nothing new", () => {
    const needs = hook("awaiting-permission-prompt.json", T0 + MIN);
    needs.payload.notification_type = "agent_needs_input";
    const first = observeSignal(fresh(), needs);
    expect(kinds(first.actions)).toEqual(["agent_question"]);
    const again = observeSignal(first.state, hook("awaiting-permission-prompt.json", T0 + 2 * MIN));
    expect(again.actions).toEqual([]);
  });

  it("resumed closes the open question", () => {
    const r = run(fresh(), [signal("awaiting-permission-prompt.json", T0 + MIN)]);
    const opened = noteDecision(r.state, "question", "d-q1");
    const after = observeSignal(opened, hook("resumed.json", T0 + 3 * MIN));
    expect(after.actions).toEqual([
      { kind: "close", decision_id: "d-q1", answer: expect.stringContaining("resumed") },
    ]);
    expect(after.state.activity).toBe("working");
    expect(after.state.decisions.question).toBeUndefined();
  });
});

describe("liveness: idle stalls (Stop without a terminal status)", () => {
  it("idle past idle_grace_s → one steer; still idle another grace later → agent_stalled, once", () => {
    const idle = run(fresh(), [signal("idle-stop.json", T0)]);
    expect(idle.actions).toEqual([]);
    expect(run(idle.state, [check(T0 + 2 * MIN)]).actions).toEqual([]);
    const steered = run(idle.state, [check(T0 + 3 * MIN)]);
    expect(kinds(steered.actions)).toEqual(["steer"]);
    const steer = steered.actions[0] as Extract<LivenessAction, { kind: "steer" }>;
    expect(steer.text).toMatch(/continue/i);
    expect(steer.text).toMatch(/done\/blocked\/failed/);
    const rest = run(steered.state, [
      check(T0 + 4 * MIN),
      check(T0 + 6 * MIN),
      check(T0 + 9 * MIN),
    ]);
    expect(kinds(rest.actions)).toEqual(["agent_stalled"]);
    expect(rest.actions[0]).toMatchObject({ last_text: expect.stringContaining("schema change") });
  });

  it("idle_prompt confirms the idle before the grace is up", () => {
    const r = run(fresh(), [
      signal("idle-stop.json", T0),
      signal("idle-prompt.json", T0 + MIN),
      check(T0 + MIN + 1000),
    ]);
    expect(kinds(r.actions)).toEqual(["steer"]);
  });

  it("resumed clears the stall; a terminal or blocked status is never steered", () => {
    const resumed = run(fresh(), [
      signal("idle-stop.json", T0),
      signal("resumed.json", T0 + MIN),
      check(T0 + 10 * MIN),
    ]);
    expect(resumed.actions).toEqual([]);
    for (const status of ["done", "failed", "blocked", "reaped"]) {
      const r = run(fresh(), [signal("idle-stop.json", T0), check(T0 + 10 * MIN, status)]);
      expect(r.actions).toEqual([]);
    }
  });
});

describe("liveness: credit exhaustion", () => {
  it("awaiting_input with class credit → credit_exhausted at once (not a question)", () => {
    const r = run(fresh(), [signal("awaiting-credit.json", T0 + MIN)]);
    expect(r.actions).toEqual([
      expect.objectContaining({ kind: "credit_exhausted", source: "hook" }),
    ]);
    const again = run(r.state, [signal("awaiting-credit.json", T0 + 2 * MIN)]);
    expect(again.actions).toEqual([]);
  });
});

describe("liveness: silence → screen fallback", () => {
  const silent = () => run(fresh(), [signal("heartbeat.json", T0)]).state;

  it("no read before heartbeat_alarm_s; then one read_screen", () => {
    expect(run(silent(), [check(T0 + 9 * MIN)]).actions).toEqual([]);
    const r = run(silent(), [check(T0 + 11 * MIN), check(T0 + 11 * MIN + 5000)]);
    expect(kinds(r.actions)).toEqual(["read_screen"]);
  });

  it("heartbeats stop for 11 min with the screen readable and changing → hooks_silent", () => {
    const r = run(silent(), [
      check(T0 + 11 * MIN),
      read(screen("working.txt"), T0 + 11 * MIN),
      check(T0 + 11 * MIN + 10_000),
      read(screen("claude-session.txt"), T0 + 11 * MIN + 10_000),
    ]);
    expect(kinds(r.actions)).toEqual(["read_screen", "read_screen", "hooks_silent"]);
    const alarm = r.actions.at(-1) as Extract<LivenessAction, { kind: "hooks_silent" }>;
    expect(alarm.silent_s).toBeGreaterThanOrEqual(600);
    expect(alarm.screen).toBe(screen("claude-session.txt"));
    // Decided: no more reads, no second alarm.
    expect(run(r.state, [check(T0 + 20 * MIN)]).actions).toEqual([]);
  });

  it("a screen the capture saw changing since the last hook signal decides on the first read", () => {
    let s = silent();
    s = noteCapture(s, { hash: "aaa", at: T0 + 2 * MIN });
    s = noteCapture(s, { hash: "bbb", at: T0 + 8 * MIN });
    const r = run(s, [check(T0 + 11 * MIN), read(screen("working.txt"), T0 + 11 * MIN)]);
    expect(kinds(r.actions)).toEqual(["read_screen", "hooks_silent"]);
  });

  it("a screen showing the credit prompt → credit_exhausted with the screen", () => {
    const r = run(silent(), [
      check(T0 + 11 * MIN),
      read(screen("credit-exhausted.txt"), T0 + 11 * MIN),
    ]);
    expect(kinds(r.actions)).toEqual(["read_screen", "credit_exhausted"]);
    expect(r.actions[1]).toMatchObject({
      source: "screen",
      screen: expect.stringContaining("usage limit"),
    });
  });

  it("an unreadable screen is a crash candidate: alarm once, then wait for the LWT (no kill, no re-read)", () => {
    const r = run(silent(), [
      check(T0 + 11 * MIN),
      read(null, T0 + 11 * MIN),
      check(T0 + 12 * MIN),
      check(T0 + 30 * MIN),
    ]);
    expect(kinds(r.actions)).toEqual(["read_screen", "crash_candidate"]);
  });

  it("an unchanged screen on the second read → screen_static", () => {
    const r = run(silent(), [
      check(T0 + 11 * MIN),
      read(screen("working.txt"), T0 + 11 * MIN),
      check(T0 + 11 * MIN + 10_000),
      read(screen("working.txt"), T0 + 11 * MIN + 10_000),
    ]);
    expect(kinds(r.actions)).toEqual(["read_screen", "read_screen", "screen_static"]);
  });

  it("silence only counts while the retained status is working, and a hook signal ends it", () => {
    expect(run(silent(), [check(T0 + 11 * MIN, "registered")]).actions).toEqual([]);
    expect(run(silent(), [check(T0 + 11 * MIN, null)]).actions).toEqual([]);
    const back = run(silent(), [
      check(T0 + 11 * MIN),
      signal("heartbeat.json", T0 + 11 * MIN + 1000),
      check(T0 + 12 * MIN),
    ]);
    expect(kinds(back.actions)).toEqual(["read_screen"]);
  });

  it("a hook signal closes an open hooks_silent decision", () => {
    let s = run(silent(), [
      check(T0 + 11 * MIN),
      read(screen("working.txt"), T0 + 11 * MIN),
      check(T0 + 11 * MIN + 10_000),
      read(screen("claude-session.txt"), T0 + 11 * MIN + 10_000),
    ]).state;
    s = noteDecision(s, "silent", "d-s1");
    const r = observeSignal(s, hook("heartbeat.json", T0 + 13 * MIN));
    expect(r.actions).toEqual([
      { kind: "close", decision_id: "d-s1", answer: expect.stringContaining("hook") },
    ]);
  });

  it("rebase after a wake restarts the clocks: the sleep is not silence", () => {
    const s = rebase(silent(), T0 + 60 * MIN);
    expect(run(s, [check(T0 + 61 * MIN)]).actions).toEqual([]);
    expect(kinds(run(s, [check(T0 + 71 * MIN)]).actions)).toEqual(["read_screen"]);
  });
});

describe("whyWaiting", () => {
  it("names the question, the credit prompt, the stall and the silence", () => {
    const q = noteDecision(
      run(fresh(), [signal("awaiting-permission-prompt.json", T0)]).state,
      "question",
      "d-q1",
    );
    expect(whyWaiting(q, T0 + MIN)).toBe("question pending (decision d-q1)");

    const c = noteDecision(
      run(fresh(), [signal("awaiting-credit.json", T0)]).state,
      "credit",
      "d-c1",
    );
    expect(whyWaiting(c, T0 + MIN)).toBe("stalled: credit prompt (decision d-c1)");

    const silent = run(fresh(), [
      signal("heartbeat.json", T0),
      check(T0 + 11 * MIN),
      read(screen("working.txt"), T0 + 11 * MIN),
      check(T0 + 11 * MIN + 10_000),
      read(screen("claude-session.txt"), T0 + 11 * MIN + 10_000),
    ]).state;
    expect(whyWaiting(silent, T0 + 12 * MIN)).toBe("hooks silent 12 min");

    const idle = run(fresh(), [signal("idle-stop.json", T0), check(T0 + 3 * MIN)]).state;
    expect(whyWaiting(idle, T0 + 4 * MIN)).toBe("idle 4 min: nudged to continue");

    expect(
      whyWaiting(run(fresh(), [signal("heartbeat.json", T0)]).state, T0 + MIN),
    ).toBeUndefined();
  });
});

describe("daemon: hook-signal liveness", () => {
  let s: SupervisedEnv;
  afterEach(async () => {
    await s.cleanup();
  });
  const decisions = (kind: string) =>
    s.journal().filter((e) => e.type === "decision_opened" && e.data.kind === kind);

  it("a permission_prompt opens agent_question (no screen read); resolving steers the answer; resumed is then a no-op", async () => {
    s = await makeSupervisedEnv();
    await s.hook("idle-stop.json");
    await s.hook("awaiting-permission-prompt.json");
    await s.until(() => decisions("agent_question").length === 1);
    const d = decisions("agent_question")[0];
    expect(d?.data).toMatchObject({ class: "agent_question", agent_id: AGENT });
    expect(d?.data.question).toContain("Should I add the column");
    expect(s.host.screenReads).toEqual([]);
    const why = `question pending (decision ${d?.data.decision_id})`;
    await s.until(() => s.daemon.snapshot("w1")?.tasks[0]?.why_waiting === why);
    const retained = (await s.env.retained("volley/_waves/w1/state")) as {
      payload: { tasks: { why_waiting?: string }[] };
    };
    expect(retained.payload.tasks[0]?.why_waiting).toBe(why);

    await s.daemon.resolveDecision("w1", d?.data.decision_id as string, {
      answer: "Create a new table.",
      by: "tester",
    });
    await s.until(() => s.journal().some((e) => e.type === "steering_sent"));
    expect(s.journal().find((e) => e.type === "steering_sent")?.data).toMatchObject({
      agent_id: AGENT,
      type: "steering",
      text: "Create a new table.",
    });
    await s.hook("resumed.json");
    await new Promise((r) => setTimeout(r, 100));
    expect(s.journal().filter((e) => e.type === "decision_resolved")).toHaveLength(1);
    expect(s.daemon.snapshot("w1")?.tasks[0]?.why_waiting).toBeUndefined();
  });

  it("resumed before anyone answers closes the question itself", async () => {
    s = await makeSupervisedEnv();
    await s.hook("awaiting-permission-prompt.json");
    await s.until(() => decisions("agent_question").length === 1);
    await s.hook("resumed.json");
    await s.until(() => s.journal().some((e) => e.type === "decision_resolved"));
    expect(s.journal().find((e) => e.type === "decision_resolved")?.data).toMatchObject({
      by: AGENT,
    });
    expect(s.journal().some((e) => e.type === "steering_sent")).toBe(false);
    expect(s.daemon.record("w1")?.state?.tasks[0]?.stage).toBe("implement");
  });

  it("an idle agent is nudged once past idle_grace_s, but never in a stopped wave", async () => {
    let now = Date.now();
    s = await makeSupervisedEnv({ daemon: { now: () => now } });
    await s.hook("idle-stop.json");
    await new Promise((r) => setTimeout(r, 100));
    now += 4 * MIN;
    await s.daemon.tick();
    const steers = () =>
      s.journal().filter((e) => e.type === "steering_sent" && e.data.type === "steering");
    await s.until(() => steers().length === 1);
    expect(steers()[0]?.data).toMatchObject({ agent_id: AGENT, by: "volleyd", reason: "idle" });
    expect(s.daemon.snapshot("w1")?.tasks[0]?.why_waiting).toBe("idle 4 min: nudged to continue");

    await s.hook("resumed.json");
    await s.hook("idle-stop.json");
    await new Promise((r) => setTimeout(r, 100));
    await s.daemon.recordEvent("w1", { type: "wave_stopped", data: { by: "tester" } });
    now += 30 * MIN;
    await s.daemon.tick();
    expect(steers()).toHaveLength(1);
    expect(decisions("agent_stalled")).toEqual([]);
  });

  it("silence past heartbeat_alarm_s reads the screen once per tick and opens hooks_silent", async () => {
    let now = Date.now();
    s = await makeSupervisedEnv({ daemon: { now: () => now } });
    s.host.screens = ["● step one\n✶ Working… (3s)", "● step two\n✶ Working… (9s)"];
    now += 11 * MIN;
    await s.daemon.tick();
    await s.until(() => s.host.screenReads.length === 1);
    now += 10_000;
    await s.daemon.tick();
    await s.until(() => decisions("unknown_screen").length === 1);
    expect(decisions("unknown_screen")[0]?.data).toMatchObject({
      class: "hooks_silent",
      agent_id: AGENT,
    });
    expect(decisions("unknown_screen")[0]?.data.question).toMatch(/hooks may be broken/);
    expect(s.daemon.snapshot("w1")?.tasks[0]?.why_waiting).toBe("hooks silent 11 min");
  });
});
