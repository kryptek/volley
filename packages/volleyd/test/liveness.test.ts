import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildEnvelope } from "volley-mcp/envelope";
import { buildTopic } from "volley-mcp/topics";
import { type ActivityEvidence, NO_EVIDENCE } from "../src/activity-evidence";
import { ControlClient, leasePoolTopic } from "../src/control";
import {
  type AgentLiveness,
  CONTINUE_TEXT,
  type HookSignal,
  type LivenessAction,
  checkLiveness,
  noteCapture,
  noteDecision,
  noteResolved,
  observeScreen,
  observeSignal,
  parseHookSignal,
  rebase,
  trackAgent,
  whyWaiting,
} from "../src/liveness";
import { NS } from "./helpers/daemon-env";
import { fakeClock } from "./helpers/fake-clock";
import { FIXTURES } from "./helpers/fake-host";
import { AGENT, type SupervisedEnv, makeSupervisedEnv } from "./helpers/supervised-env";

const MIN = 60_000;
const T0 = Date.parse("2026-10-18T12:00:00.000Z");
const TUNABLES = {
  idle_grace_s: 180,
  heartbeat_alarm_s: 600,
  background_wait_max_s: 7200,
  stall_backoff_max_s: 1800,
  tool_in_flight_max_s: 7200,
};

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
  (at: number, status: string | null = "working", evidence?: Partial<ActivityEvidence>) =>
  (s: AgentLiveness) =>
    checkLiveness(s, {
      now: at,
      status,
      tunables: TUNABLES,
      ...(evidence !== undefined ? { evidence: { ...NO_EVIDENCE, ...evidence } } : {}),
    });
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
  it("a question after the turn resumed quotes the prompt, not the previous turn's Stop text", () => {
    const r = run(fresh(), [
      signal("idle-stop.json", T0),
      signal("resumed.json", T0 + MIN),
      signal("awaiting-permission-prompt.json", T0 + 2 * MIN),
    ]);
    expect(kinds(r.actions)).toEqual(["agent_question"]);
    expect(r.actions[0]).toMatchObject({
      question: "Claude needs your permission",
      last_text: null,
    });
  });

  it("idle_prompt while a question (or credit prompt) is open keeps the wait: no steer, no stall", () => {
    for (const [fixture, slot] of [
      ["awaiting-permission-prompt.json", "question"],
      ["awaiting-credit.json", "credit"],
    ] as const) {
      const asked = run(fresh(), [signal(fixture, T0)]);
      const opened = noteDecision(asked.state, slot, "d-1");
      const r = run(opened, [
        signal("idle-prompt.json", T0 + MIN),
        check(T0 + MIN + 1000),
        check(T0 + 10 * MIN),
        check(T0 + 60 * MIN),
      ]);
      expect(r.actions).toEqual([]);
      expect(r.state.activity).toBe("awaiting_input");
      expect(r.state.decisions[slot]).toBe("d-1");
    }
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

  it("an answered agent_stalled backs off: each re-open waits twice as long, capped at stall_backoff_max_s", () => {
    const stalled = run(fresh(), [
      signal("idle-stop.json", T0),
      check(T0 + 3 * MIN),
      check(T0 + 6 * MIN),
    ]);
    expect(kinds(stalled.actions)).toEqual(["steer", "agent_stalled"]);
    expect(stalled.actions[1]).toMatchObject({ asked: 1, next_s: 360 });
    let s = stalled.state;
    let answered = T0 + 7 * MIN;
    const answer = (at: number) => {
      s = noteResolved(noteDecision(s, "stalled", `d-${at}`), `d-${at}`, at);
    };
    answer(answered);
    expect(s.decisions.stalled).toBeUndefined();
    // Not one grace after the answer (10 min): twice the grace (13 min).
    expect(
      run(s, [check(answered + 10_000), check(T0 + 10 * MIN), check(T0 + 12 * MIN)]).actions,
    ).toEqual([]);
    let r = run(s, [check(T0 + 13 * MIN), check(T0 + 13 * MIN + 10_000)]);
    expect(kinds(r.actions)).toEqual(["agent_stalled"]);
    expect(r.actions[0]).toMatchObject({ asked: 2, next_s: 720 });
    s = r.state;
    answered = T0 + 13 * MIN;
    answer(answered);
    expect(run(s, [check(answered + 11 * MIN)]).actions).toEqual([]);
    r = run(s, [check(answered + 12 * MIN)]);
    expect(kinds(r.actions)).toEqual(["agent_stalled"]);
    s = r.state;
    // Gaps 24 min, then 30 min (the cap), then 30 min again.
    for (const gap of [24, 30, 30]) {
      answered += 60 * MIN;
      answer(answered);
      expect(run(s, [check(answered + (gap - 1) * MIN)]).actions).toEqual([]);
      r = run(s, [check(answered + gap * MIN)]);
      expect(kinds(r.actions)).toEqual(["agent_stalled"]);
      s = r.state;
    }
    // resumed resets the count: a later idle starts from one grace again.
    const later = answered + 60 * MIN;
    const again = run(s, [
      signal("resumed.json", later),
      signal("idle-stop.json", later + MIN),
      check(later + 4 * MIN),
      check(later + 7 * MIN),
    ]);
    expect(kinds(again.actions)).toEqual(["steer", "agent_stalled"]);
    expect(again.actions.at(-1)).toMatchObject({ asked: 1 });
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

  /** Silent and changing for one window: the change is held, not yet a decision. */
  const changingOneWindow = () =>
    run(silent(), [
      check(T0 + 11 * MIN),
      read(screen("working.txt"), T0 + 11 * MIN),
      check(T0 + 11 * MIN + 10_000),
      read(screen("claude-session.txt"), T0 + 11 * MIN + 10_000),
    ]);

  it("heartbeats stop and the screen changes for one window → held, no decision", () => {
    const r = changingOneWindow();
    expect(kinds(r.actions)).toEqual(["read_screen", "read_screen"]);
    // Held one more window: no re-read until it has passed.
    expect(run(r.state, [check(T0 + 15 * MIN), check(T0 + 20 * MIN)]).actions).toEqual([]);
  });

  it("the screen keeps changing with no hook signal for a second window → hooks_silent", () => {
    const r = run(changingOneWindow().state, [
      check(T0 + 21 * MIN + 10_000),
      read(screen("working.txt"), T0 + 21 * MIN + 10_000),
    ]);
    expect(kinds(r.actions)).toEqual(["read_screen", "hooks_silent"]);
    const alarm = r.actions.at(-1) as Extract<LivenessAction, { kind: "hooks_silent" }>;
    expect(alarm.silent_s).toBeGreaterThanOrEqual(1200);
    expect(alarm.screen).toBe(screen("working.txt"));
    // Decided: no more reads, no second alarm.
    expect(run(r.state, [check(T0 + 30 * MIN)]).actions).toEqual([]);
  });

  it("a hook signal inside the held window clears it: a silence that ends is no decision", () => {
    const r = run(changingOneWindow().state, [
      signal("heartbeat.json", T0 + 15 * MIN),
      check(T0 + 22 * MIN),
    ]);
    expect(r.actions).toEqual([]);
    expect(r.state.silence).toBeNull();
  });

  it("the screen stops changing during the held window → screen_static", () => {
    const r = run(changingOneWindow().state, [
      check(T0 + 21 * MIN + 10_000),
      read(screen("claude-session.txt"), T0 + 21 * MIN + 10_000),
    ]);
    expect(kinds(r.actions)).toEqual(["read_screen", "screen_static"]);
  });

  it("a screen the capture saw changing since the last hook signal is held on the first read", () => {
    let s = silent();
    s = noteCapture(s, { hash: "aaa", at: T0 + 2 * MIN });
    s = noteCapture(s, { hash: "bbb", at: T0 + 8 * MIN });
    const first = run(s, [check(T0 + 11 * MIN), read(screen("working.txt"), T0 + 11 * MIN)]);
    expect(kinds(first.actions)).toEqual(["read_screen"]);
    const changed = noteCapture(first.state, { hash: "ccc", at: T0 + 15 * MIN });
    const second = run(changed, [check(T0 + 21 * MIN), read(screen("working.txt"), T0 + 21 * MIN)]);
    expect(kinds(second.actions)).toEqual(["read_screen", "hooks_silent"]);
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
    let s = run(changingOneWindow().state, [
      check(T0 + 21 * MIN + 10_000),
      read(screen("working.txt"), T0 + 21 * MIN + 10_000),
    ]).state;
    s = noteDecision(s, "silent", "d-s1");
    const r = observeSignal(s, hook("heartbeat.json", T0 + 23 * MIN));
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

describe("liveness: a tool in flight is not silence", () => {
  /** The hooks' tool boundary: PreToolUse's `activity`, PostToolUse's `heartbeat` (SPEC §4.3). */
  const tool =
    (type: string, hook_event: string, at: number, tool_use_id: string) => (s: AgentLiveness) =>
      observeSignal(s, {
        type,
        at,
        seq: null,
        hook_event,
        payload: { source: "harness-hook", hook_event, tool_use_id, tool: "Bash" },
      });
  const pre = (at: number, id = "toolu_1") => tool("activity", "PreToolUse", at, id);
  const post = (at: number, id = "toolu_1") => tool("heartbeat", "PostToolUse", at, id);
  /** The screen publisher saw the screen change at `at`. */
  const capture = (at: number) => (s: AgentLiveness) => ({
    state: noteCapture(s, { hash: `h${at}`, at }),
    actions: [],
  });
  const started = () => run(fresh(), [capture(T0 - MIN), pre(T0)]).state;

  it("PreToolUse records the tool in flight; the matching PostToolUse ends it", () => {
    const s = started();
    expect(s.tool_in_flight).toEqual([{ tool_use_id: "toolu_1", tool: "Bash", since: T0 }]);
    expect(run(s, [post(T0 + MIN, "toolu_other")]).state.tool_in_flight).toHaveLength(1);
    expect(run(s, [post(T0 + MIN)]).state.tool_in_flight).toEqual([]);
    expect(run(s, [signal("idle-stop.json", T0 + MIN)]).state.tool_in_flight).toEqual([]);
  });

  it("a PreToolUse with no PostToolUse and a changing screen for 3 windows → no read, no decision", () => {
    const steps = [];
    for (let m = 1; m <= 31; m++) steps.push(capture(T0 + m * MIN), check(T0 + m * MIN + 1000));
    const r = run(started(), steps);
    expect(r.actions).toEqual([]);
    expect(r.state.silence).toBeNull();
  });

  it("the matching PostToolUse restarts the silence clock", () => {
    const r = run(started(), [capture(T0 + 20 * MIN), post(T0 + 30 * MIN), check(T0 + 39 * MIN)]);
    expect(r.actions).toEqual([]);
    expect(kinds(run(r.state, [check(T0 + 41 * MIN)]).actions)).toEqual(["read_screen"]);
  });

  it("past tool_in_flight_max_s with a static screen → today's path: screen_static", () => {
    const at = T0 + 121 * MIN;
    const r = run(started(), [
      capture(T0 + 5 * MIN),
      check(T0 + 119 * MIN),
      check(at),
      read(screen("working.txt"), at),
      check(at + 10_000),
      read(screen("working.txt"), at + 10_000),
    ]);
    expect(kinds(r.actions)).toEqual(["read_screen", "read_screen", "screen_static"]);
  });

  it("past tool_in_flight_max_s a screen still changing is no decision either", () => {
    const steps = [];
    for (let m = 115; m <= 150; m++) steps.push(capture(T0 + m * MIN), check(T0 + m * MIN + 1000));
    expect(run(started(), steps).actions).toEqual([]);
  });

  it("past tool_in_flight_max_s, reads that keep differing on a static capture → never hooks_silent", () => {
    const at = T0 + 121 * MIN;
    const r = run(started(), [
      capture(T0 + 5 * MIN),
      check(at),
      read(screen("working.txt"), at),
      check(at + 10_000),
      read(screen("claude-session.txt"), at + 10_000),
      check(at + 11 * MIN),
      read(screen("working.txt"), at + 11 * MIN),
      check(at + 22 * MIN),
      read(screen("claude-session.txt"), at + 22 * MIN),
    ]);
    expect(kinds(r.actions)).toEqual(["read_screen", "read_screen", "read_screen", "read_screen"]);
    expect(r.state.silence?.phase).toBe("holding");
  });

  it("parallel calls: the one that ends first leaves the other in flight", () => {
    const steps = [pre(T0 + 1000, "toolu_2"), post(T0 + 2000, "toolu_2")];
    for (let m = 1; m <= 31; m++) steps.push(capture(T0 + m * MIN), check(T0 + m * MIN + 1000));
    const r = run(started(), steps);
    expect(r.actions).toEqual([]);
    expect(r.state.tool_in_flight).toEqual([{ tool_use_id: "toolu_1", tool: "Bash", since: T0 }]);
    expect(run(r.state, [post(T0 + 32 * MIN)]).state.tool_in_flight).toEqual([]);
  });

  it("rebase after a wake moves the tool's start forward", () => {
    expect(rebase(started(), T0 + 60 * MIN).tool_in_flight[0]?.since).toBe(T0 + 60 * MIN);
  });
});

describe("liveness: an idle agent waiting on its own work", () => {
  it("rebase after a wake moves the background wait forward with the other clocks", () => {
    const waiting = run(fresh(), [signal("idle-background-wait.json", T0)]).state;
    expect(rebase(waiting, T0 + 60 * MIN).background_wait).toEqual({ since: T0 + 60 * MIN });
  });

  it("idle with background_wait is never steered or called a stall; resumed ends the wait", () => {
    const r = run(fresh(), [
      signal("idle-background-wait.json", T0),
      check(T0 + 3 * MIN),
      check(T0 + 6 * MIN),
      check(T0 + 10 * MIN),
    ]);
    expect(r.actions).toEqual([]);
    expect(whyWaiting(r.state, T0 + 6 * MIN)).toBe(
      "idle 6 min: waiting on its own background task",
    );
    const back = run(r.state, [signal("resumed.json", T0 + 11 * MIN)]);
    expect(whyWaiting(back.state, T0 + 11 * MIN)).toBeUndefined();
    // The next plain idle is a plain idle again.
    const idle = run(back.state, [signal("idle-stop.json", T0 + 12 * MIN), check(T0 + 15 * MIN)]);
    expect(kinds(idle.actions)).toEqual(["steer"]);
  });

  it("an idle_prompt carrying background_wait after a plain idle (older Stop hook) also holds the nudge", () => {
    const r = run(fresh(), [
      signal("idle-stop.json", T0),
      signal("idle-prompt-background-wait.json", T0 + MIN),
      check(T0 + MIN + 1000),
      check(T0 + 3 * MIN),
      check(T0 + 6 * MIN),
    ]);
    expect(r.actions).toEqual([]);
  });

  it("a lease, a running shell or a fresh worktree write holds the nudge; a stale write does not", () => {
    const idle = run(fresh(), [signal("idle-stop.json", T0)]).state;
    const at = (n: number) => T0 + n * MIN;
    for (const [evidence, reason] of [
      [{ lease_held: true, lease_pool: "it" }, "holds lease it"],
      [{ shells_running: 2 }, "2 shells still running"],
      [{ worktree_write_at: at(6) - 40_000 }, "worktree written in the last 3 min"],
    ] as const) {
      const r = run(idle, [check(at(3), "working", evidence), check(at(6), "working", evidence)]);
      expect(r.actions).toEqual([]);
      expect(whyWaiting(r.state, at(6))).toBe(`idle 6 min: ${reason}`);
    }
    const stale = run(idle, [check(at(3), "working", { worktree_write_at: at(3) - 10 * MIN })]);
    expect(kinds(stale.actions)).toEqual(["steer"]);
  });

  it("a background_wait older than background_wait_max_s with no other evidence is nudged again", () => {
    const start = run(fresh(), [signal("idle-background-wait.json", T0), check(T0 + 60 * MIN)]);
    expect(start.actions).toEqual([]);
    const r = run(start.state, [check(T0 + 121 * MIN), check(T0 + 124 * MIN)]);
    expect(kinds(r.actions)).toEqual(["steer", "agent_stalled"]);
  });

  it("a running shell or a held lease holds the nudge for at most background_wait_max_s of idle", () => {
    const idle = run(fresh(), [signal("idle-stop.json", T0)]).state;
    for (const evidence of [{ shells_running: 1 }, { lease_held: true, lease_pool: "it" }]) {
      const held = run(idle, [check(T0 + 60 * MIN, "working", evidence)]);
      expect(held.actions).toEqual([]);
      const r = run(held.state, [
        check(T0 + 121 * MIN, "working", evidence),
        check(T0 + 124 * MIN, "working", evidence),
      ]);
      expect(kinds(r.actions)).toEqual(["steer", "agent_stalled"]);
    }
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
      check(T0 + 21 * MIN + 10_000),
      read(screen("working.txt"), T0 + 21 * MIN + 10_000),
    ]).state;
    expect(whyWaiting(silent, T0 + 22 * MIN)).toBe("hooks silent 22 min");

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
  const opened = (kind: string, n = 1) =>
    s.event((e) => e.type === "decision_opened" && e.data.kind === kind, n);

  it("a permission_prompt opens agent_question (no screen read); resolving steers the answer; resumed is then a no-op", async () => {
    s = await makeSupervisedEnv();
    await s.hook("idle-stop.json");
    await s.hook("awaiting-permission-prompt.json");
    const d = await opened("agent_question");
    await s.settled();
    expect(d?.data).toMatchObject({ class: "agent_question", agent_id: AGENT });
    expect(d?.data.question).toContain("Should I add the column");
    expect(s.host.screenReads).toEqual([]);
    const why = `question pending (decision ${d?.data.decision_id})`;
    expect(s.daemon.snapshot("w1")?.tasks[0]?.why_waiting).toBe(why);
    const retained = (await s.env.retained("volley/_waves/w1/state")) as {
      payload: { tasks: { why_waiting?: string }[] };
    };
    expect(retained.payload.tasks[0]?.why_waiting).toBe(why);

    await s.daemon.resolveDecision("w1", d?.data.decision_id as string, {
      answer: "Create a new table.",
      by: "tester",
    });
    expect((await s.event("steering_sent")).data).toMatchObject({
      agent_id: AGENT,
      type: "steering",
      text: "Create a new table.",
    });
    await s.hook("resumed.json");
    await s.consumed();
    expect(s.journal().filter((e) => e.type === "decision_resolved")).toHaveLength(1);
    expect(s.daemon.snapshot("w1")?.tasks[0]?.why_waiting).toBeUndefined();
  });

  it("a question superseded by its PR's merge is closed, never sent to the agent as an answer", async () => {
    s = await makeSupervisedEnv();
    await s.hook("awaiting-permission-prompt.json");
    const d = await opened("agent_question");
    await s.settled();
    await s.daemon.resolveDecision("w1", d?.data.decision_id as string, {
      answer: "superseded_by_merge",
      by: "volleyd",
      rationale: "PR #7 merged into release/w1 at 5a5a5a5",
    });
    await s.settled();
    expect(s.journal().filter((e) => e.type === "decision_resolved")).toHaveLength(1);
    expect(s.journal().some((e) => e.type === "steering_sent")).toBe(false);
  });

  it("resumed before anyone answers closes the question itself", async () => {
    s = await makeSupervisedEnv();
    await s.hook("awaiting-permission-prompt.json");
    await opened("agent_question");
    await s.hook("resumed.json");
    expect((await s.event("decision_resolved")).data).toMatchObject({
      by: AGENT,
    });
    expect(s.journal().some((e) => e.type === "steering_sent")).toBe(false);
    expect(s.daemon.record("w1")?.state?.tasks[0]?.stage).toBe("implement");
  });

  it("an idle agent is nudged once past idle_grace_s, but never in a stopped wave", async () => {
    const clock = fakeClock(Date.now());
    s = await makeSupervisedEnv({ daemon: { clock } });
    await s.hook("idle-stop.json");
    await s.consumed();
    await clock.advance(4 * MIN);
    await s.daemon.tick();
    const steers = () =>
      s.journal().filter((e) => e.type === "steering_sent" && e.data.type === "steering");
    await s.event((e) => e.type === "steering_sent" && e.data.type === "steering");
    await s.settled();
    expect(steers()[0]?.data).toMatchObject({ agent_id: AGENT, by: "volleyd", reason: "idle" });
    expect(s.daemon.snapshot("w1")?.tasks[0]?.why_waiting).toBe("idle 4 min: nudged to continue");

    await s.hook("resumed.json");
    await s.hook("idle-stop.json");
    await s.consumed();
    await s.daemon.recordEvent("w1", { type: "wave_stopped", data: { by: "tester" } });
    await clock.advance(30 * MIN);
    await s.daemon.tick();
    await s.settled();
    expect(steers()).toHaveLength(1);
    expect(decisions("agent_stalled")).toEqual([]);
  });

  it("in a wave with its own namespace, the nudge and an answer reach the agent's mailbox there", async () => {
    // Ahead of the wall clock: the files the spawn just wrote are no fresh worktree write.
    s = await makeSupervisedEnv({
      namespace: "w1-ns",
      daemon: { clock: fakeClock(Date.now() + 10 * MIN) },
    });
    const got: { type: string; text: string }[] = [];
    await s.agent.subscribeStream(buildTopic("w1-ns", AGENT, "mailbox"), ({ payload }) => {
      const e = JSON.parse(payload) as { type: string; payload: { text: string } };
      got.push({ type: e.type, text: e.payload.text });
    });
    await s.hook("awaiting-permission-prompt.json");
    await opened("agent_question");
    await s.daemon.resolveDecision(
      "w1",
      decisions("agent_question")[0]?.data.decision_id as string,
      {
        answer: "Create a new table.",
        by: "tester",
      },
    );
    // The steer's mailbox delivery reaches this subscriber over the broker.
    await s.until(() => got.length === 1);
    expect(got[0]).toEqual({ type: "steering", text: "Create a new table." });

    await s.hook("resumed.json");
    await s.hook("idle-stop.json");
    await s.hook("idle-prompt.json"); // confirms the idle: the next tick nudges
    await s.consumed();
    // The clock stands still: one nudge, ever, however many ticks.
    for (let i = 0; i < 3; i++) await s.daemon.tick();
    await s.event((e) => e.type === "steering_sent" && e.data.reason === "idle");
    await s.until(() => got.length === 2);
    await s.daemon.tick();
    await s.consumed();
    expect(got.map((m) => m.text)).toEqual(["Create a new table.", CONTINUE_TEXT]);
  });

  it("an idle agent holding a lease is never nudged; once it releases the lease it is, once", async () => {
    const clock = fakeClock(Date.now() + 10 * MIN);
    s = await makeSupervisedEnv({ daemon: { clock } });
    const client = await ControlClient.connect(s.env.broker.url, NS);
    try {
      const ack = await client.request(
        "config_set",
        { patch: { lease_pools: { it: { capacity: 1 } } }, by: "tester" },
        { text: "add the it pool" },
      );
      expect(ack.applied).toBe(true);
    } finally {
      await client.close();
    }
    const lease = async (op: "acquire" | "release") => {
      const env = buildEnvelope({
        agentId: AGENT,
        parentId: null,
        channel: "_system/leases/requests",
        type: "lease_request",
        payload: { op, lease_id: "l-it", holder: AGENT },
      });
      await s.agent.publish(`${leasePoolTopic("it")}/requests`, JSON.stringify(env), {
        qos: 1,
        retain: false,
      });
    };
    await lease("acquire");
    await s.event((e) => e.type === "lease_granted", 1, "_system");
    await s.hook("idle-stop.json");
    await s.consumed();
    const steers = () =>
      s.journal().filter((e) => e.type === "steering_sent" && e.data.reason === "idle");
    for (let i = 0; i < 3; i++) {
      await clock.advance(4 * MIN);
      await s.daemon.tick();
      await s.settled();
    }
    expect(steers()).toEqual([]);
    expect(decisions("agent_stalled")).toEqual([]);
    expect(s.daemon.snapshot("w1")?.tasks[0]?.why_waiting).toBe("idle 12 min: holds lease it");

    await lease("release");
    await s.event((e) => e.type === "lease_released", 1, "_system");
    await s.daemon.tick();
    await s.event((e) => e.type === "steering_sent" && e.data.reason === "idle");
    await s.daemon.tick();
    await s.settled();
    expect(steers()).toHaveLength(1);
  });

  it("an idle agent whose terminal footer counts running shells is not nudged; once they end it is", async () => {
    const clock = fakeClock(Date.now() + 10 * MIN);
    s = await makeSupervisedEnv({ daemon: { clock } });
    const screen = (name: string) => readFileSync(join(FIXTURES, "screens", name), "utf-8");
    s.host.screens = [screen("working-shells.txt")];
    await s.daemon.tickScreens();
    await s.hook("idle-stop.json");
    await s.consumed();
    const steers = () =>
      s.journal().filter((e) => e.type === "steering_sent" && e.data.reason === "idle");
    await clock.advance(4 * MIN);
    await s.daemon.tick();
    await s.settled();
    expect(steers()).toEqual([]);
    expect(s.daemon.snapshot("w1")?.tasks[0]?.why_waiting).toBe(
      "idle 4 min: 2 shells still running",
    );

    s.host.screens = [screen("working.txt")];
    await s.daemon.tickScreens();
    await s.daemon.tick();
    await s.event((e) => e.type === "steering_sent" && e.data.reason === "idle");
    await s.settled();
    expect(steers()).toHaveLength(1);
  });

  it("an idle local agent whose worktree was written within idle_grace_s is not nudged", async () => {
    const clock = fakeClock(Date.now() + 10 * MIN);
    s = await makeSupervisedEnv({ daemon: { clock } });
    const worktree = s.journal().find((e) => e.type === "agent_spawned")?.data.worktree;
    expect(typeof worktree).toBe("string");
    await s.hook("idle-stop.json");
    await s.consumed();
    await clock.advance(4 * MIN);
    const log = join(worktree as string, "it.log");
    writeFileSync(log, "x");
    utimesSync(log, clock.now() / 1000, clock.now() / 1000);
    const steers = () =>
      s.journal().filter((e) => e.type === "steering_sent" && e.data.reason === "idle");
    await s.daemon.tick();
    await s.settled();
    expect(steers()).toEqual([]);
    expect(s.daemon.snapshot("w1")?.tasks[0]?.why_waiting).toBe(
      "idle 4 min: worktree written in the last 3 min",
    );

    await clock.advance(4 * MIN); // the write is now older than idle_grace_s
    await s.daemon.tick();
    await s.event((e) => e.type === "steering_sent" && e.data.reason === "idle");
    await s.settled();
    expect(steers()).toHaveLength(1);
  });

  it("silence past two heartbeat_alarm_s windows reads the screen once per tick and opens hooks_silent", async () => {
    const clock = fakeClock(Date.now());
    s = await makeSupervisedEnv({ daemon: { clock } });
    s.host.screens = [
      "● step one\n✶ Working… (3s)",
      "● step two\n✶ Working… (9s)",
      "● step three\n✶ Working… (15s)",
    ];
    await clock.advance(11 * MIN);
    await s.daemon.tick();
    await s.settled();
    expect(s.host.screenReads).toHaveLength(1);
    await clock.advance(10_000);
    await s.daemon.tick();
    await s.settled();
    // Changing for one window: held, no decision yet.
    expect(s.host.screenReads).toHaveLength(2);
    expect(decisions("unknown_screen")).toEqual([]);
    await clock.advance(10 * MIN);
    await s.daemon.tick();
    await opened("unknown_screen");
    await s.settled();
    expect(decisions("unknown_screen")[0]?.data).toMatchObject({
      class: "hooks_silent",
      agent_id: AGENT,
    });
    expect(decisions("unknown_screen")[0]?.data.question).toMatch(/hooks may be broken/);
    expect(s.daemon.snapshot("w1")?.tasks[0]?.why_waiting).toBe("hooks silent 21 min");
  });
});
