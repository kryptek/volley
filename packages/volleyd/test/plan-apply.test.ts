import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatWave } from "../src/commands/status";
import { resolveEvent } from "../src/decisions";
import { readJournalFile } from "../src/journal";
import { launchScriptPath } from "../src/launch";
import {
  PlanChangeError,
  applyPlan,
  planAnswer,
  planDecisionId,
  taskActivity,
} from "../src/plan-apply";
import { formatDiff } from "../src/plan-diff";
import { type WaveRecord, replay } from "../src/reducer";
import { spawnAgent } from "../src/spawn";
import type { JournalEvent, NewEvent, TaskState, Wave } from "../src/types";
import { parseWaveFile } from "../src/wave-file";
import { type DaemonEnv, makeDaemonEnv } from "./helpers/daemon-env";
import { type SpawnEnv, makeSpawnEnv } from "./helpers/fake-host";
import { runCli } from "./helpers/run-cli";
import { envelope, schemaErrors } from "./helpers/schema";

const text = (name: string) =>
  readFileSync(new URL(`./fixtures/waves/${name}`, import.meta.url), "utf-8");
const V1 = parseWaveFile(text("v1.yaml"));
const V2 = parseWaveFile(text("v2.yaml"));

/** A tiny journal: assigns seq and a minute-spaced `at` (from 10:00Z) to each event. */
function journal() {
  const events: JournalEvent[] = [];
  const push = (ev: NewEvent): JournalEvent => {
    const seq = events.length + 1;
    const at = ev.at ?? new Date(Date.UTC(2026, 9, 18, 10, seq - 1)).toISOString();
    const e: JournalEvent = { ...ev, seq, at };
    events.push(e);
    return e;
  };
  const start = (task: string, issue: number) => {
    push({ type: "task_admitted", task, data: {} });
    push({
      type: "agent_spawned",
      task,
      data: { role: "implementer", agent_id: `w-plan-${task.toLowerCase()}-implementer-1`, issue },
    });
    push({ type: "stage_entered", task, data: { stage: "implement" } });
  };
  return { events, push, start };
}

/**
 * v1 mid-flight: T1 done, T3 and T4 implementing (spawned at 10:11 and 10:14), T2 and T5 queued.
 */
function midFlight(wave: Wave = V1) {
  const j = journal();
  j.push({ type: "wave_submitted", data: { wave, owner: null } });
  for (const id of wave.task_order) {
    j.push({ type: "task_queued", task: id, data: { issue: wave.tasks[id]?.issue } });
  }
  j.start("T1", 101);
  j.push({ type: "stage_entered", task: "T1", data: { stage: "done" } });
  j.start("T3", 103);
  j.start("T4", 104);
  return j;
}

const NOW = "2026-10-18T10:25:00.000Z";

function applyTo(j: ReturnType<typeof journal>, next: Wave) {
  const rec = replay(j.events);
  const res = applyPlan(rec, next, { now: NOW, activity: taskActivity(j.events) });
  for (const ev of res.events) j.push(ev);
  return { before: rec, res, after: replay(j.events) };
}

const taskOf = (rec: WaveRecord, id: string): TaskState | undefined =>
  rec.state?.tasks.find((t) => t.id === id);

/** Tasks with an open plan_change decision. */
const pendingTasks = (rec: WaveRecord) =>
  (rec.state?.open_decisions ?? [])
    .map((id) => rec.decisions[id])
    .filter((d) => d?.kind === "plan_change")
    .map((d) => d?.task);

/** Journal the owner's answer to a decision (T7's resolve event). */
function answer(j: ReturnType<typeof journal>, id: string, a: string) {
  const r = resolveEvent(replay(j.events), id, { answer: a, by: "owner-1" }, new Date(NOW));
  if (!("event" in r)) throw new Error(`cannot resolve ${id}`);
  j.push(r.event);
}

describe("applyPlan", () => {
  it("journals the new version with its structural diff, first", () => {
    const { res, after } = applyTo(midFlight(), V2);
    expect(res.version).toBe(2);
    expect(res.events[0]).toMatchObject({
      type: "wave_versioned",
      data: { version: 2, previous_version: 1, diff: res.diff },
    });
    expect(res.diff.removed).toEqual(["T3", "T5"]);
    expect(after.state?.version).toBe(2);
    expect(after.state?.spec?.version).toBe(2);
    expect(Object.keys(after.state?.spec?.tasks ?? {})).toEqual(["T1", "T2", "T4", "T6"]);
    expect(after.plan?.version).toBe(2);
    expect(
      schemaErrors("wave-state.schema.json", envelope("_waves/state", "wave_state", after.state)),
    ).toEqual([]);
  });

  it("switching to placement: auto keeps a started task's host and says so (#323)", () => {
    const auto = parseWaveFile(`${text("v1.yaml")}placement: auto\n`);
    const { res, after } = applyTo(midFlight(), auto);
    // T3 and T4 implement on the supervisor's machine, T1 is done there: their host stays.
    expect(res.diff.hosts_kept).toEqual([
      { task: "T1", kept: "local", planned: "auto", running: false },
      { task: "T3", kept: "local", planned: "auto", running: true },
      { task: "T4", kept: "local", planned: "auto", running: true },
    ]);
    expect(formatDiff(res.diff)).toContain(
      "T3: host kept local (already running; new plan says auto)",
    );
    expect(after.wave?.tasks.T3?.host).toBe("local");
    expect(taskOf(after, "T3")?.host_planned).toBe("auto");
    // T2 and T5 never started: placement places them.
    expect(after.wave?.tasks.T2?.host).toBe("auto");
    expect(after.wave?.tasks.T5?.host).toBe("auto");
    expect(after.plan?.tasks.T3?.host).toBe("auto"); // the file as submitted
  });

  it("a placed, spawned task under an unchanged placement: auto is not reported as kept (#323)", () => {
    const auto = parseWaveFile(`${text("v1.yaml")}placement: auto\n`);
    const j = journal();
    j.push({ type: "wave_submitted", data: { wave: auto, owner: null } });
    for (const id of auto.task_order) {
      j.push({ type: "task_queued", task: id, data: { issue: auto.tasks[id]?.issue } });
    }
    j.push({
      type: "task_placed",
      task: "T2",
      data: { task: "T2", host: "box", score: 0.8, candidates: [], by: "auto" },
    });
    j.push({ type: "task_admitted", task: "T2", data: {} });
    j.push({
      type: "agent_spawned",
      task: "T2",
      data: { role: "implementer", agent_id: "w-plan-t2-implementer-1", issue: 2, host: "box" },
    });
    j.push({ type: "stage_entered", task: "T2", data: { stage: "implement" } });
    const { res, after } = applyTo(j, parseWaveFile(`${text("v2.yaml")}placement: auto\n`));
    expect(res.events[0]?.type).toBe("wave_versioned");
    expect(res.diff.hosts_kept).toBeUndefined();
    expect(after.wave?.tasks.T2?.host).toBe("box");
    expect(taskOf(after, "T2")?.host_planned).toBeUndefined();
  });

  it("an admitted, unspawned task whose host changes gives its admission back (#434)", () => {
    const j = midFlight();
    j.push({ type: "task_admitted", task: "T2", data: {} });
    const { res, after } = applyTo(j, parseWaveFile(`${text("v1.yaml")}placement: auto\n`));
    expect(res.events).toContainEqual({
      type: "task_admission_returned",
      task: "T2",
      data: { task: "T2", from_host: "local", to_host: "auto", plan_version: 2 },
    });
    // The event follows wave_versioned; a queued task never admitted has nothing to give back.
    const types = res.events.map((e) => `${e.type}:${e.task ?? ""}`);
    expect(types.indexOf("task_admission_returned:T2")).toBeGreaterThan(0);
    expect(types).not.toContain("task_admission_returned:T5");
    expect(after.admitted).not.toContain("T2");
    expect(taskOf(after, "T2")?.placement).toBeUndefined();
    expect(after.wave?.tasks.T2?.host).toBe("auto");
    // Started tasks keep their host, as before.
    expect(res.diff.hosts_kept?.map((k) => k.task)).toEqual(["T1", "T3", "T4"]);
    expect(types.filter((t) => t.startsWith("task_admission_returned"))).toEqual([
      "task_admission_returned:T2",
    ]);
  });

  it("a placed, admitted task whose host changes loses its placement too (#434)", () => {
    const auto = parseWaveFile(`${text("v1.yaml")}placement: auto\n`);
    const j = journal();
    j.push({ type: "wave_submitted", data: { wave: auto, owner: null } });
    for (const id of auto.task_order) {
      j.push({ type: "task_queued", task: id, data: { issue: auto.tasks[id]?.issue } });
    }
    j.push({
      type: "task_placed",
      task: "T2",
      data: { task: "T2", host: "box", score: 0.8, candidates: [], by: "auto" },
    });
    j.push({ type: "task_admitted", task: "T2", data: {} });
    // Still left to placement: it stays where it was placed, admitted.
    const reissued = text("v1.yaml").replace("T5: { issue: 105 }", "T5: { issue: 106 }");
    const same = applyTo(j, parseWaveFile(`${reissued}placement: auto\n`));
    expect(same.res.events.map((e) => e.type)).not.toContain("task_admission_returned");
    expect(same.after.admitted).toContain("T2");
    expect(same.after.wave?.tasks.T2?.host).toBe("box");
    // Back on the supervisor's machine: the placement goes, and so does the admission.
    const { res, after } = applyTo(j, V1);
    expect(res.events).toContainEqual({
      type: "task_admission_returned",
      task: "T2",
      data: { task: "T2", from_host: "box", to_host: "local", plan_version: 3 },
    });
    expect(after.admitted).not.toContain("T2");
    expect(taskOf(after, "T2")?.placement).toBeUndefined();
    expect(after.wave?.tasks.T2?.host).toBe("local");
  });

  it("an admitted task named onto a host and then left to placement is placed afresh (#434)", () => {
    const named = parseWaveFile(
      `${text("v1.yaml").replace("T2: { issue: 102, after: [T1] }", "T2: { issue: 102, after: [T1], host: box }")}placement: auto\n`,
    );
    const j = journal();
    j.push({ type: "wave_submitted", data: { wave: named, owner: null } });
    for (const id of named.task_order) {
      j.push({ type: "task_queued", task: id, data: { issue: named.tasks[id]?.issue } });
    }
    j.push({
      type: "task_placed",
      task: "T2",
      data: { task: "T2", host: "box", score: 1, candidates: [], by: "wave_file" },
    });
    j.push({ type: "task_admitted", task: "T2", data: {} });
    const { res, after } = applyTo(j, parseWaveFile(`${text("v1.yaml")}placement: auto\n`));
    expect(res.events).toContainEqual({
      type: "task_admission_returned",
      task: "T2",
      data: { task: "T2", from_host: "box", to_host: "auto", plan_version: 2 },
    });
    expect(after.admitted).not.toContain("T2");
    expect(taskOf(after, "T2")?.placement).toBeUndefined();
    expect(after.wave?.tasks.T2?.host).toBe("auto");
  });

  it("a task with an agent, or one being spawned, keeps its admission (#434)", () => {
    const j = midFlight();
    j.push({ type: "task_admitted", task: "T2", data: {} });
    const rec = replay(j.events);
    const auto = parseWaveFile(`${text("v1.yaml")}placement: auto\n`);
    const spawning = applyPlan(rec, auto, {
      now: NOW,
      activity: taskActivity(j.events),
      spawning: ["T2"],
    });
    expect(spawning.events.map((e) => e.type)).not.toContain("task_admission_returned");
    // T3 runs (an agent): its host is kept, its admission stays.
    const running = applyPlan(rec, auto, { now: NOW, activity: taskActivity(j.events) });
    expect(running.events.map((e) => e.task)).not.toContain("T3");
    expect(running.diff.hosts_kept?.map((k) => k.task)).toContain("T3");
  });

  it("removed queued task → cancelled", () => {
    const { res, after } = applyTo(midFlight(), V2);
    expect(res.events).toContainEqual(
      expect.objectContaining({ type: "task_cancelled", task: "T5" }),
    );
    expect(taskOf(after, "T5")?.stage).toBe("cancelled");
    expect(after.wave?.tasks.T5).toBeUndefined();
  });

  it("a synthetic task (a flake's fixer) is in no file: a new version keeps it, unasked", () => {
    for (const started of [false, true]) {
      const j = midFlight();
      j.push({
        type: "task_queued",
        task: "fix-a",
        data: {
          issue: 0,
          synthetic: true,
          title: "Fix flaky test a",
          remediation: { kind: "fix_flake", test: "a", test_file: null, run_urls: [], for: ["T3"] },
        },
      });
      if (started) j.start("fix-a", 0);
      const { res, after } = applyTo(j, V2);
      expect(res.events.filter((e) => e.task === "fix-a")).toEqual([]);
      expect(after.wave?.tasks["fix-a"]?.synthetic).toBe(true);
      expect(after.wave?.task_order.at(-1)).toBe("fix-a");
      expect(taskOf(after, "fix-a")?.stage).toBe(started ? "implement" : "queued");
      expect(res.diff.removed).not.toContain("fix-a");
    }
  });

  it("removed in-flight task → plan_change decision, task untouched", () => {
    const { before, res, after } = applyTo(midFlight(), V2);
    expect(res.events.filter((e) => e.task === "T3").map((e) => e.type)).toEqual([
      "decision_opened",
    ]);
    const d = res.events.find((e) => e.type === "decision_opened" && e.task === "T3");
    const id = planDecisionId("w-plan", "T3", "removed", 2);
    expect(d?.data).toMatchObject({
      decision_id: id,
      kind: "plan_change",
      change: "removed",
      options: ["stop", "let finish"],
      plan_version: 2,
      pointers: {},
      opened_at: NOW,
    });
    // spawned at 10:11, now 10:25
    expect(d?.data.question).toContain("stop T3 (implementer working 14 min)?");
    expect(taskOf(after, "T3")).toEqual(taskOf(before, "T3"));
    expect(after.wave?.tasks.T3).toEqual(V1.tasks.T3); // its agents still need its definition
    expect(after.state?.open_decisions).toContain(id);
    // A T7 decision record (what the daemon publishes on volley/_waves/<wave>/decisions/<id>).
    expect(after.decisions[id]).toMatchObject({ wave: "w-plan", task: "T3", change: "removed" });
    expect(res.decisions).toContainEqual(
      expect.objectContaining({ op: "open", input: expect.objectContaining({ id, task: "T3" }) }),
    );
    expect(pendingTasks(after)).toEqual(["T4", "T3"]);
  });

  it("dependency added to a queued task → waiting_on updated; added task queued", () => {
    const { before, res, after } = applyTo(midFlight(), V2);
    expect(taskOf(before, "T2")?.waiting_on).toBeUndefined(); // T1 is done
    expect(res.events).toContainEqual(
      expect.objectContaining({
        type: "task_queued",
        task: "T6",
        data: { issue: 106, plan_version: 2 },
      }),
    );
    expect(taskOf(after, "T6")?.stage).toBe("queued");
    expect(taskOf(after, "T2")).toMatchObject({ waiting_on: ["T6"], why_waiting: "after: T6" });
  });

  it("issue changed on an in-flight task → decision; the agent keeps the old issue", () => {
    const { res, after } = applyTo(midFlight(), V2);
    const d = res.events.find((e) => e.type === "decision_opened" && e.task === "T4");
    expect(d?.data).toMatchObject({
      decision_id: planDecisionId("w-plan", "T4", "issue", 2),
      kind: "plan_change",
      change: "issue",
      from_issue: 104,
      to_issue: 114,
      options: ["restart", "let finish"],
    });
    expect(d?.data.question).toContain("#104");
    expect(d?.data.question).toContain("#114");
    expect(taskOf(after, "T4")?.issue).toBe(104);
    // Everything else about T4's new definition applies.
    expect(after.wave?.tasks.T4).toMatchObject({
      issue: 104,
      pipeline: ["implement", "merge_ready"],
    });
    expect(after.state?.spec?.tasks.T4?.issue).toBe(114); // the submitted plan, as written
  });

  it("issue changed on a queued task applies directly", () => {
    const v2 = parseWaveFile(text("v1.yaml").replace("T5: { issue: 105 }", "T5: { issue: 155 }"));
    const { res, after } = applyTo(midFlight(), v2);
    expect(res.events.map((e) => e.type)).toEqual(["wave_versioned"]);
    expect(taskOf(after, "T5")?.issue).toBe(155);
    expect(after.wave?.tasks.T5?.issue).toBe(155);
  });

  it("status shows the version and the tasks pending decision", () => {
    const { after } = applyTo(midFlight(), V2);
    const header = formatWave(after.state as NonNullable<WaveRecord["state"]>, {
      decisions: Object.values(after.decisions),
    }).split("\n")[0];
    expect(header).toContain("plan v2 (2 tasks pending decision)");
  });

  it("re-submitting the same plan changes nothing", () => {
    const j = midFlight();
    applyTo(j, V2);
    const rec = replay(j.events);
    const again = applyPlan(rec, V2, { now: NOW, activity: taskActivity(j.events) });
    expect(again.unchanged).toBe(true);
    expect(again.events).toEqual([]);
  });

  it("a later version that restores the plan withdraws its open decisions and re-queues", () => {
    const j = midFlight();
    applyTo(j, V2);
    const { res, after } = applyTo(j, V1);
    expect(res.version).toBe(3);
    const resolved = res.events.filter((e) => e.type === "decision_resolved");
    expect(resolved.map((e) => [e.task, e.data.answer, e.data.by])).toEqual([
      ["T3", "withdrawn", "plan v3"],
      ["T4", "withdrawn", "plan v3"],
    ]);
    expect(after.state?.open_decisions).toEqual([]);
    expect(pendingTasks(after)).toEqual([]);
    expect(taskOf(after, "T5")?.stage).toBe("queued"); // re-added after its cancellation
    expect(taskOf(after, "T6")?.stage).toBe("cancelled"); // removed while still queued
    expect(taskOf(after, "T3")?.stage).toBe("implement");
    expect(after.wave?.tasks.T4?.issue).toBe(104);
  });

  it("re-pointing an in-flight task again supersedes the open issue decision", () => {
    const j = midFlight();
    applyTo(j, V2);
    const v3 = parseWaveFile(text("v2.yaml").replace("issue: 114", "issue: 124"));
    const { res, after } = applyTo(j, v3);
    const old = planDecisionId("w-plan", "T4", "issue", 2);
    const id = planDecisionId("w-plan", "T4", "issue", 3);
    expect(
      res.events
        .filter((e) => e.task === "T4")
        .map((e) => [e.type, e.data.decision_id, e.data.answer]),
    ).toEqual([
      ["decision_resolved", old, "superseded"],
      ["decision_opened", id, undefined],
    ]);
    expect(after.state?.open_decisions.filter((d) => d === id)).toHaveLength(1);
    expect(after.state?.open_decisions).not.toContain(old);
    // the still-open removal decision for T3 is not re-asked
    expect(res.events.some((e) => e.task === "T3")).toBe(false);
  });

  it("refuses a version for another repo or before submission", () => {
    const other = parseWaveFile(text("v2.yaml").replace("~/repos/example", "~/repos/other"));
    const rec = replay(midFlight().events);
    expect(() => applyPlan(rec, other, { now: NOW, activity: {} })).toThrow(PlanChangeError);
    expect(() => applyPlan(replay([]), V2, { now: NOW, activity: {} })).toThrow(/not submitted/);
  });
});

describe("applyPlan: answered, withdrawn and parked plan_change decisions", () => {
  const v3T6 = () =>
    parseWaveFile(text("v2.yaml").replace("T6: { issue: 106 }", "T6: { issue: 107 }"));

  it("an answered decision is not asked again by a later version", () => {
    const j = midFlight();
    applyTo(j, V2);
    answer(j, planDecisionId("w-plan", "T3", "removed", 2), "let finish");
    answer(j, planDecisionId("w-plan", "T4", "issue", 2), "let finish");
    expect(replay(j.events).state?.open_decisions).toEqual([]);
    const { res, after } = applyTo(j, v3T6()); // changes only T6's issue
    expect(res.version).toBe(3);
    expect(res.events.filter((e) => e.type.startsWith("decision_"))).toEqual([]);
    expect(after.state?.open_decisions).toEqual([]);
    expect(after.wave?.tasks.T3).toEqual(V1.tasks.T3); // still running, still defined
    expect(after.wave?.tasks.T4?.issue).toBe(104); // "let finish": keeps the old issue
  });

  it("a new issue target after `let finish` is a new question, with a new id", () => {
    const j = midFlight();
    applyTo(j, V2);
    answer(j, planDecisionId("w-plan", "T4", "issue", 2), "let finish");
    const v3 = parseWaveFile(text("v2.yaml").replace("issue: 114", "issue: 124"));
    const { res } = applyTo(j, v3);
    const opened = res.events.filter((e) => e.type === "decision_opened");
    expect(opened.map((e) => [e.task, e.data.decision_id, e.data.to_issue])).toEqual([
      ["T4", planDecisionId("w-plan", "T4", "issue", 3), 124],
    ]);
  });

  it("removing a task withdraws its open issue decision before asking to stop it", () => {
    const j = midFlight();
    applyTo(j, V2); // re-points in-flight T4 (104 -> 114)
    const v3 = parseWaveFile(
      text("v2.yaml").replace(
        "  T4: { issue: 114, after: [T1], pipeline: [implement, merge_ready] }\n",
        "",
      ),
    );
    const { res, after } = applyTo(j, v3);
    expect(
      res.events
        .filter((e) => e.task === "T4")
        .map((e) => [e.type, e.data.change ?? e.data.answer]),
    ).toEqual([
      ["decision_resolved", "withdrawn"],
      ["decision_opened", "removed"],
    ]);
    const onT4 = (after.state?.open_decisions ?? []).filter(
      (id) => after.decisions[id]?.task === "T4",
    );
    expect(onT4).toEqual([planDecisionId("w-plan", "T4", "removed", 3)]);
  });

  it("a plan_change decision does not park its task; another decision still parks and resumes it", () => {
    const j = midFlight();
    const { after } = applyTo(j, V2);
    expect(taskOf(after, "T3")?.stage).toBe("implement");
    expect(taskOf(after, "T3")?.why_waiting).toBeUndefined();
    j.push({
      type: "decision_opened",
      task: "T3",
      data: { decision_id: "d-blocked", kind: "agent_blocked", question: "?", pointers: {} },
    });
    expect(taskOf(replay(j.events), "T3")?.stage).toBe("awaiting_decision");
    answer(j, "d-blocked", "go on"); // the plan_change one stays open: the task resumes anyway
    const rec = replay(j.events);
    expect(taskOf(rec, "T3")?.stage).toBe("implement");
    expect(pendingTasks(rec)).toContain("T3");
  });

  it("an admitted task that never spawned counts as queued: removed → cancelled, un-admitted", () => {
    const j = midFlight();
    j.push({ type: "task_admitted", task: "T5", data: {} });
    const { res, after } = applyTo(j, V2);
    expect(res.events.filter((e) => e.task === "T5").map((e) => e.type)).toEqual([
      "task_cancelled",
    ]);
    expect(after.admitted).not.toContain("T5");
  });

  it("a task whose spawn is under way is in flight", () => {
    const j = midFlight();
    j.push({ type: "task_admitted", task: "T5", data: {} });
    const rec = replay(j.events);
    const res = applyPlan(rec, V2, {
      now: NOW,
      activity: taskActivity(j.events),
      spawning: ["T5"],
    });
    expect(res.events.filter((e) => e.task === "T5").map((e) => [e.type, e.data.change])).toEqual([
      ["decision_opened", "removed"],
    ]);
    expect(res.events.find((e) => e.task === "T5")?.data.question).toContain("stop T5 (spawning)?");
  });

  it("refuses a release_branch or namespace change", () => {
    const rec = replay(midFlight().events);
    const branch = parseWaveFile(text("v2.yaml").replace("release/w-plan", "release/other"));
    expect(() => applyPlan(rec, branch, { now: NOW, activity: {} })).toThrow(
      /release_branch cannot change/,
    );
    const ns = parseWaveFile(`${text("v2.yaml")}namespace: other\n`);
    expect(() => applyPlan(rec, ns, { now: NOW, activity: {} })).toThrow(/namespace cannot change/);
  });

  it("re-ordering the tasks alone is no change", () => {
    const rec = replay(midFlight().events);
    const lines = text("v1.yaml").split("\n");
    const i = lines.indexOf("  T1: { issue: 101 }");
    [lines[i], lines[i + 2]] = [lines[i + 2] as string, lines[i] as string];
    const reordered = parseWaveFile(lines.join("\n"));
    expect(reordered.task_order).not.toEqual(V1.task_order);
    expect(applyPlan(rec, reordered, { now: NOW, activity: {} }).unchanged).toBe(true);
  });
});

describe("planAnswer", () => {
  it("stop on a removed task cancels it", () => {
    const j = midFlight();
    applyTo(j, V2);
    answer(j, planDecisionId("w-plan", "T3", "removed", 2), "stop");
    const rec = replay(j.events);
    const d = rec.decisions[planDecisionId("w-plan", "T3", "removed", 2)];
    const effect = planAnswer(rec, d as NonNullable<typeof d>);
    expect(effect.cancel).toContain("Stop work on T3");
    expect(effect.events.map((e) => [e.type, e.task])).toEqual([["task_cancelled", "T3"]]);
    for (const ev of effect.events) j.push(ev);
    expect(taskOf(replay(j.events), "T3")?.stage).toBe("cancelled");
  });

  it("restart on a re-pointed task queues it again on the new issue", () => {
    const j = midFlight();
    applyTo(j, V2);
    const id = planDecisionId("w-plan", "T4", "issue", 2);
    answer(j, id, "restart");
    const rec = replay(j.events);
    const effect = planAnswer(
      rec,
      rec.decisions[id] as NonNullable<(typeof rec.decisions)[string]>,
    );
    expect(effect.events.map((e) => e.type)).toEqual(["task_cancelled", "task_queued"]);
    for (const ev of effect.events) j.push(ev);
    const after = replay(j.events);
    expect(taskOf(after, "T4")).toMatchObject({ stage: "queued", issue: 114, agents: {} });
    expect(after.wave?.tasks.T4?.issue).toBe(114); // what the next spawn uses
  });

  it("let finish does nothing", () => {
    const j = midFlight();
    applyTo(j, V2);
    const id = planDecisionId("w-plan", "T3", "removed", 2);
    answer(j, id, "let finish");
    const rec = replay(j.events);
    expect(
      planAnswer(rec, rec.decisions[id] as NonNullable<(typeof rec.decisions)[string]>),
    ).toEqual({
      events: [],
    });
  });
});

describe("model change mid-wave", () => {
  let env: SpawnEnv;
  afterEach(async () => env.cleanup());

  it("the running stage keeps its model; the next stage spawns with the new one", async () => {
    env = await makeSpawnEnv();
    const v1 = parseWaveFile(
      [
        "wave: w1",
        `repo: ${env.repo}`,
        "release_branch: release/w1",
        "model: claude-opus-5-5",
        "pipeline: [implement, spec_review]",
        "tasks:",
        "  T1: { issue: 42 }",
        "",
      ].join("\n"),
    );
    const v2 = parseWaveFile(
      [
        "wave: w1",
        `repo: ${env.repo}`,
        "release_branch: release/w1",
        "model: claude-opus-5-5",
        "pipeline: [implement, spec_review]",
        "tasks:",
        "  T1: { issue: 42, model: claude-sonnet-5-5 }",
        "",
      ].join("\n"),
    );
    const j = journal();
    j.push({ type: "wave_submitted", data: { wave: v1, owner: null } });
    j.push({ type: "task_queued", task: "T1", data: { issue: 42 } });
    j.push({ type: "task_admitted", task: "T1", data: {} });

    const wave = () => replay(j.events).wave as Wave;
    const impl = await spawnAgent(
      { wave: wave(), task: "T1", role: "implementer", attempt: 1 },
      env.deps,
    );
    if (impl.kind !== "launched") throw new Error("implementer not launched");
    await impl.verified;
    for (const ev of env.events) j.push(ev);
    const implScript = readFileSync(launchScriptPath(impl.worktree), "utf-8");
    expect(implScript).toContain("--model 'claude-opus-5-5'");

    const res = applyPlan(replay(j.events), v2, { now: NOW, activity: taskActivity(j.events) });
    expect(res.diff.changed).toEqual([
      { task: "T1", model: { from: "claude-opus-5-5", to: "claude-sonnet-5-5" } },
    ]);
    expect(res.events.map((e) => e.type)).toEqual(["wave_versioned"]); // no decision for a model change
    for (const ev of res.events) j.push(ev);

    const review = await spawnAgent(
      { wave: wave(), task: "T1", role: "spec_reviewer", attempt: 1 },
      env.deps,
    );
    if (review.kind !== "launched") throw new Error("reviewer not launched");
    await review.verified;
    expect(readFileSync(launchScriptPath(review.worktree), "utf-8")).toContain(
      "--model 'claude-sonnet-5-5'",
    );
    // The implementer's launch (its argv) is not rewritten.
    expect(readFileSync(launchScriptPath(impl.worktree), "utf-8")).toBe(implScript);
    const spawned = env.events.filter((e) => e.type === "agent_spawned").map((e) => e.data.role);
    expect(spawned).toEqual(["implementer", "spec_reviewer"]);
  });
});

describe("daemon: volleyd run on a running wave, volleyd diff", () => {
  let t: DaemonEnv;
  afterEach(async () => t.cleanup());
  const V1_FILE = new URL("./fixtures/waves/v1.yaml", import.meta.url).pathname;
  const V2_FILE = new URL("./fixtures/waves/v2.yaml", import.meta.url).pathname;

  it("stores and journals the new version, applies it, and refuses an unchanged re-run", async () => {
    t = await makeDaemonEnv();
    await t.start();
    expect((await runCli(["run", V1_FILE], t.env)).exitCode).toBe(0);
    const dir = join(t.home, "waves", "w-plan");
    expect(readFileSync(join(dir, "v1.yaml"), "utf-8")).toBe(text("v1.yaml"));

    const preview = await runCli(["diff", "w-plan", V2_FILE], t.env);
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toContain("w-plan plan v1 -> ");
    expect(preview.stdout).toContain("+ T6\n- T3\n- T5\n");
    expect(existsSync(join(dir, "v2.yaml"))).toBe(false); // diff submits nothing
    const json = JSON.parse((await runCli(["diff", "w-plan", V2_FILE, "--json"], t.env)).stdout);
    expect(json).toMatchObject({ added: ["T6"], removed: ["T3", "T5"] });

    const r = await runCli(["run", V2_FILE], t.env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("submitted wave w-plan plan v2\n+ T6\n");
    // T1, T3 and T5 were admitted on submission, but nothing spawned them (no spawner): T3 and
    // T5 never started, so removing them cancels them and gives their admission back.
    expect(r.stdout).toContain("plan v2  owner");
    expect(readFileSync(join(dir, "v2.yaml"), "utf-8")).toBe(text("v2.yaml"));
    const events = readJournalFile(join(dir, "journal.jsonl"));
    expect(events.find((e) => e.type === "wave_versioned")?.data).toMatchObject({
      version: 2,
      file: join(dir, "v2.yaml"),
    });
    expect(events.filter((e) => e.type === "decision_opened")).toEqual([]);
    expect(events.filter((e) => e.type === "task_cancelled").map((e) => e.task)).toEqual([
      "T3",
      "T5",
    ]);

    const state = (await t.retained("volley/_waves/w-plan/state")) as {
      payload: { version: number; tasks: TaskState[] };
    };
    expect(state.payload.version).toBe(2);
    const byId = Object.fromEntries(state.payload.tasks.map((x) => [x.id, x]));
    expect(byId.T3?.stage).toBe("cancelled");
    expect(byId.T4?.issue).toBe(114); // still queued (waits on T1): the re-point applies
    expect(byId.T6?.stage).toBe("queued");

    const again = await runCli(["run", V2_FILE], t.env);
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain("already submitted as v2; the file has no changes");
    expect(existsSync(join(dir, "v3.yaml"))).toBe(false);

    const unknown = await runCli(["diff", "nope", V2_FILE], t.env);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("unknown wave 'nope'");
  });

  it("numbers the first submission v1 whatever its file says", async () => {
    t = await makeDaemonEnv();
    await t.start();
    const file = join(t.home, "first.yaml");
    writeFileSync(file, `${text("v1.yaml")}version: 3\n`);
    expect((await runCli(["run", file], t.env)).exitCode).toBe(0);
    const dir = join(t.home, "waves", "w-plan");
    expect(existsSync(join(dir, "v1.yaml"))).toBe(true);
    expect(existsSync(join(dir, "v3.yaml"))).toBe(false);
    const state = (await t.retained("volley/_waves/w-plan/state")) as {
      payload: { version: number };
    };
    expect(state.payload.version).toBe(1);
    expect((await runCli(["run", V2_FILE], t.env)).exitCode).toBe(0);
    expect(existsSync(join(dir, "v2.yaml"))).toBe(true);
  });

  it("publishes plan_change decisions on the decisions topic; `resolve … stop` cancels the task", async () => {
    t = await makeDaemonEnv();
    const daemon = await t.start();
    expect((await runCli(["run", V1_FILE], t.env)).exitCode).toBe(0);
    // T3 is running (an implementer was spawned and is implementing).
    await daemon.recordEvent("w-plan", {
      type: "agent_spawned",
      task: "T3",
      data: { role: "implementer", agent_id: "w-plan-t3-implementer-1", issue: 103 },
    });
    await daemon.recordEvent("w-plan", {
      type: "stage_entered",
      task: "T3",
      data: { stage: "implement" },
    });

    const r = await runCli(["run", V2_FILE], t.env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("plan v2 (1 task pending decision)");
    const id = planDecisionId("w-plan", "T3", "removed", 2);
    const topic = `volley/_waves/w-plan/decisions/${id}`;
    const retained = (await t.retained(topic)) as {
      type: string;
      payload: Record<string, unknown>;
    };
    expect(retained.type).toBe("decision_opened");
    expect(retained.payload).toMatchObject({
      decision_id: id,
      wave: "w-plan",
      task: "T3",
      kind: "plan_change",
      change: "removed",
      options: ["stop", "let finish"],
    });
    expect(schemaErrors("decision.schema.json", retained)).toEqual([]);
    const listed = await runCli(["decisions", "w-plan"], t.env);
    expect(listed.stdout).toContain(id);

    const res = await runCli(["resolve", id, "stop"], t.env);
    expect(res.exitCode).toBe(0);
    expect(await t.retained(topic)).toBeNull();
    const events = daemon.journalEvents("w-plan");
    expect(
      events
        .filter((e) => e.task === "T3")
        .map((e) => e.type)
        .slice(-3),
    ).toEqual(["decision_resolved", "steering_sent", "task_cancelled"]);
    const state = (await t.retained("volley/_waves/w-plan/state")) as {
      payload: { tasks: TaskState[] };
    };
    expect(state.payload.tasks.find((x) => x.id === "T3")?.stage).toBe("cancelled");

    // A later version does not ask about T3 again.
    const v3 = join(t.home, "v3.yaml");
    writeFileSync(v3, text("v2.yaml").replace("T6: { issue: 106 }", "T6: { issue: 107 }"));
    expect((await runCli(["run", v3], t.env)).exitCode).toBe(0);
    expect(daemon.journalEvents("w-plan").filter((e) => e.type === "decision_opened")).toHaveLength(
      1,
    );
  });

  it("a plan_change `stop` never cancels an agent already retired", async () => {
    t = await makeDaemonEnv();
    const daemon = await t.start();
    expect((await runCli(["run", V1_FILE], t.env)).exitCode).toBe(0);
    const ev = (type: string, data: Record<string, unknown>) =>
      daemon.recordEvent("w-plan", { type, task: "T3", data } as never);
    await ev("agent_spawned", { role: "implementer", agent_id: "w-plan-t3-implementer-1" });
    await ev("agent_spawned", { role: "spec_reviewer", agent_id: "w-plan-t3-spec-1" });
    // The reviewer finished; task.agents still names it.
    await ev("agent_retired", { agent_id: "w-plan-t3-spec-1", status: "done" });
    await ev("stage_entered", { stage: "implement" });
    expect((await runCli(["run", V2_FILE], t.env)).exitCode).toBe(0);
    const id = planDecisionId("w-plan", "T3", "removed", 2);
    expect((await runCli(["resolve", id, "stop"], t.env)).exitCode).toBe(0);
    const steered = daemon
      .journalEvents("w-plan")
      .filter((e) => e.type === "steering_sent")
      .map((e) => e.data.agent_id);
    expect(steered).toEqual(["w-plan-t3-implementer-1"]);
  });
});
