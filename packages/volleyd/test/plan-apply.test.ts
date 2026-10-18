import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatWave } from "../src/commands/status";
import { readJournalFile } from "../src/journal";
import { launchScriptPath } from "../src/launch";
import { PlanChangeError, applyPlan, planDecisionId, taskActivity } from "../src/plan-apply";
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

  it("removed queued task → cancelled", () => {
    const { res, after } = applyTo(midFlight(), V2);
    expect(res.events).toContainEqual(
      expect.objectContaining({ type: "task_cancelled", task: "T5" }),
    );
    expect(taskOf(after, "T5")?.stage).toBe("cancelled");
    expect(after.wave?.tasks.T5).toBeUndefined();
  });

  it("removed in-flight task → plan_change decision, task untouched", () => {
    const { before, res, after } = applyTo(midFlight(), V2);
    expect(res.events.filter((e) => e.task === "T3").map((e) => e.type)).toEqual([
      "decision_opened",
    ]);
    const d = res.events.find((e) => e.type === "decision_opened" && e.task === "T3");
    expect(d?.data).toMatchObject({
      decision_id: planDecisionId("w-plan", "T3", "removed"),
      kind: "plan_change",
      change: "removed",
      wave: "w-plan",
      task: "T3",
      options: ["stop", "let finish"],
      plan_version: 2,
      pointers: {},
      opened_at: NOW,
    });
    // spawned at 10:11, now 10:25
    expect(d?.data.question).toContain("stop T3 (implementer working 14 min)?");
    expect(taskOf(after, "T3")).toEqual(taskOf(before, "T3"));
    expect(after.wave?.tasks.T3).toEqual(V1.tasks.T3); // its agents still need its definition
    expect(after.state?.open_decisions).toContain(planDecisionId("w-plan", "T3", "removed"));
    expect(after.state?.plan_pending).toEqual(["T3", "T4"]);
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
      decision_id: planDecisionId("w-plan", "T4", "issue"),
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
    const header = formatWave(after.state as NonNullable<WaveRecord["state"]>).split("\n")[0];
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
    expect(after.state?.plan_pending).toBeUndefined();
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
    const id = planDecisionId("w-plan", "T4", "issue");
    expect(res.events.filter((e) => e.task === "T4").map((e) => [e.type, e.data.answer])).toEqual([
      ["decision_resolved", "superseded"],
      ["decision_opened", undefined],
    ]);
    expect(after.state?.open_decisions.filter((d) => d === id)).toHaveLength(1);
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
    // T1, T3 and T5 were admitted on submission (no spawner): T3 and T5 are in flight.
    expect(r.stdout).toContain("plan v2 (2 tasks pending decision)");
    expect(readFileSync(join(dir, "v2.yaml"), "utf-8")).toBe(text("v2.yaml"));
    const events = readJournalFile(join(dir, "journal.jsonl"));
    expect(events.find((e) => e.type === "wave_versioned")?.data).toMatchObject({
      version: 2,
      file: join(dir, "v2.yaml"),
    });
    const decisions = events.filter((e) => e.type === "decision_opened");
    expect(decisions.map((e) => [e.task, e.data.change])).toEqual([
      ["T3", "removed"],
      ["T5", "removed"],
    ]);
    expect(decisions[0]?.data.question).toContain("stop T3 (admitted, not yet spawned)?");

    const state = (await t.retained("volley/_waves/w-plan/state")) as {
      payload: { version: number; tasks: TaskState[]; plan_pending: string[] };
    };
    expect(state.payload.version).toBe(2);
    expect(state.payload.plan_pending).toEqual(["T3", "T5"]);
    const byId = Object.fromEntries(state.payload.tasks.map((x) => [x.id, x]));
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
});
