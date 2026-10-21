import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { slugOf } from "../src/autopilot/remediation";
import type { JournalEvent, NewEvent } from "../src/types";
import { envelope, schemaErrors } from "./helpers/schema";
import { type SupervisedEnv, makeSupervisedEnv } from "./helpers/supervised-env";

/**
 * Self-healing CI (2), SPEC §4.6.16: a flake's fixer is a synthetic task volleyd adds to the
 * wave itself — one per distinct test, bounded per wave — and its merge releases every task it
 * blocked (they update from the release branch and are verified again).
 */

const FLAKE = "test/clock.test.ts > sleep > resolves on abort";
const FIXER = slugOf(FLAKE);
const RED = `c1a55${"0".repeat(35)}`;
const RUN = "https://example.test/runs/9";

let s: SupervisedEnv | undefined;
afterEach(async () => {
  await s?.cleanup();
  s = undefined;
});

const env = (o: { config?: string } = {}) =>
  makeSupervisedEnv({
    tasks: ["T3: { issue: 42 }", "T7: { issue: 42 }"],
    ...(o.config !== undefined ? { config: o.config } : {}),
  });

/** The pipeline's flake classification of `task`'s implementer head, as A3 journals it. */
async function flaky(env: SupervisedEnv, task: string, test = FLAKE): Promise<void> {
  await env.daemon.recordEvent("w1", {
    type: "remediation_requested",
    task,
    data: {
      kind: "fix_flake",
      test,
      test_file: "test/clock.test.ts",
      tests: [test],
      head: RED,
      run_urls: [RUN],
      for: task,
      role: "implementer",
    },
  });
}

/** Its ci_failed decision (offering `fix flake`), as the pipeline opens it. */
async function ciFailed(env: SupervisedEnv, task: string): Promise<string> {
  const id = `ci-${task.toLowerCase()}`;
  await env.daemon.recordEvent("w1", {
    type: "decision_opened",
    task,
    data: {
      decision_id: id,
      kind: "ci_failed",
      question: `CI failed on ${RED.slice(0, 12)}: a flake.`,
      options: ["fix flake", "fixup", "re-verify", "cancel"],
      pointers: {},
      classification: "flake",
      run_urls: [RUN],
      pipeline: { on: "ci_failed", role: "implementer", head: RED },
    },
  } satisfies NewEvent);
  return id;
}

const of = (events: JournalEvent[], type: string, task?: string) =>
  events.filter((e) => e.type === type && (task === undefined || e.task === task));

describe("the flake fixer task (SPEC §4.6.16)", () => {
  it("two requests for one test: one synthetic fixer for both, launched with the flake brief (no gh issue view)", async () => {
    s = await env();
    const issueViews = s.host.fake.argvs(["gh", "issue", "view"]).length;
    await flaky(s, "T3");
    await ciFailed(s, "T3");
    await flaky(s, "T7");
    await ciFailed(s, "T7");
    const spawned = await s.event((e) => e.type === "agent_spawned" && e.task === FIXER);
    await s.settled();
    const queued = of(s.journal(), "task_queued", FIXER);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.data).toMatchObject({
      issue: 0,
      synthetic: true,
      title: `Fix flaky test ${FLAKE}`,
      remediation: {
        kind: "fix_flake",
        test: FLAKE,
        test_file: "test/clock.test.ts",
        run_urls: [RUN],
        for: ["T3"],
      },
    });
    const t = s.daemon.snapshot("w1")?.tasks.find((x) => x.id === FIXER);
    expect(t).toMatchObject({
      synthetic: true,
      issue: 0,
      remediation: { kind: "fix_flake", test: FLAKE, for: ["T3", "T7"] },
    });
    expect(spawned.data.agent_id).toBe(`w1-${FIXER}-implementer-1`);
    const wt = spawned.data.worktree as string;
    const brief = readFileSync(join(wt, ".volley", "brief.md"), "utf-8");
    expect(brief).toContain(`Fix flaky test ${FLAKE}`);
    expect(brief).toMatch(/Never re-run CI as a fix/);
    expect(brief).toContain("open a pull request against `release/w1`");
    const issue = readFileSync(join(wt, "ISSUE.md"), "utf-8");
    expect(issue).toContain(`# Fix flaky test ${FLAKE}`);
    // Blocked when it was spawned (T7 joined it after).
    expect(issue).toContain(
      "Blocked tasks (their PRs wait for this fix, then update from the release branch): T3",
    );
    expect(issue).toContain(RUN);
    expect(s.host.fake.argvs(["gh", "issue", "view"])).toHaveLength(issueViews);
    // The state and the fixer's task_queued are what the schemas say.
    const state = s.daemon.snapshot("w1");
    expect(
      schemaErrors("wave-state.schema.json", envelope("_waves/state", "wave_state", state)),
    ).toEqual([]);
    const q = queued[0] as JournalEvent;
    expect(
      schemaErrors(
        "wave-event.schema.json",
        envelope("_waves/events", "task_queued", {
          wave: "w1",
          seq: q.seq,
          at: q.at,
          task: q.task,
          data: q.data,
        }),
      ),
    ).toEqual([]);
  });

  it("the fixer done: remediation_closed releases both, their decisions resolved `fix landed`, each updates its branch", async () => {
    s = await env();
    await flaky(s, "T3");
    const d3 = await ciFailed(s, "T3");
    await flaky(s, "T7");
    const d7 = await ciFailed(s, "T7");
    await s.event((e) => e.type === "agent_spawned" && e.task === FIXER);
    await s.settled();
    await s.daemon.recordEvent("w1", {
      type: "stage_entered",
      task: FIXER,
      data: { stage: "done" },
    });
    const closed = await s.event("remediation_closed");
    await s.event((e) => e.type === "stage_entered" && e.task === "T7" && e.data.rebase === true);
    await s.settled();
    expect(closed.task).toBe(FIXER);
    expect(closed.data).toMatchObject({
      kind: "fix_flake",
      test: FLAKE,
      task: FIXER,
      outcome: "landed",
      released: ["T3", "T7"],
    });
    const j = s.journal();
    for (const id of [d3, d7]) {
      const r = j.find((e) => e.type === "decision_resolved" && e.data.decision_id === id);
      expect(r?.data).toMatchObject({ answer: "fix landed", by: "volleyd" });
    }
    for (const task of ["T3", "T7"]) {
      expect(of(j, "stage_entered", task).find((e) => e.data.rebase === true)?.data).toMatchObject({
        stage: "fixup",
        roles: ["rebase"],
        rebase: true,
        fix_landed: FLAKE,
      });
      const t = s.daemon.snapshot("w1")?.tasks.find((x) => x.id === task);
      expect(t?.remediation).toBeUndefined();
    }
    // Once only.
    expect(of(j, "remediation_closed")).toHaveLength(1);
    expect(
      schemaErrors(
        "wave-event.schema.json",
        envelope("_waves/events", "remediation_closed", {
          wave: "w1",
          seq: closed.seq,
          at: closed.at,
          task: closed.task,
          data: closed.data,
        }),
      ),
    ).toEqual([]);
  });

  it("the fixer cancelled: remediation_closed failed, the blocked tasks' decisions re-opened escalated", async () => {
    s = await env();
    await flaky(s, "T3");
    const d3 = await ciFailed(s, "T3");
    await flaky(s, "T7");
    const d7 = await ciFailed(s, "T7");
    await s.event((e) => e.type === "agent_spawned" && e.task === FIXER);
    await s.settled();
    // T3's was answered `fix flake` (it waits for the fixer); T7's is still open.
    await s.daemon.resolveDecision("w1", d3, { answer: "fix flake", by: "coord" });
    await s.settled();
    await s.daemon.recordEvent("w1", {
      type: "task_cancelled",
      task: FIXER,
      data: { by: "owner" },
    });
    const closed = await s.event("remediation_closed");
    await s.settled();
    await s.event("decision_escalated", 2);
    await s.settled();
    expect(closed.data).toMatchObject({
      kind: "fix_flake",
      test: FLAKE,
      task: FIXER,
      outcome: "failed",
      why: expect.stringContaining("cancelled"),
      released: [],
    });
    const j = s.journal();
    // T3: a new ci_failed, escalated unattended_safety, without `fix flake`.
    const again = of(j, "decision_opened", "T3").at(-1);
    expect(again?.data.decision_id).not.toBe(d3);
    expect(again?.data).toMatchObject({
      kind: "ci_failed",
      pipeline: { on: "ci_failed", role: "implementer", head: RED },
    });
    expect(again?.data.options).not.toContain("fix flake");
    expect(again?.data.question).toContain(FIXER);
    const esc = of(j, "decision_escalated");
    expect(esc.map((e) => [e.data.decision_id, e.data.why])).toEqual([
      [again?.data.decision_id, "unattended_safety"],
      [d7, "unattended_safety"],
    ]);
    expect(of(j, "remediation_closed")).toHaveLength(1);
  });

  it("a restart closes a fixer that ended just before a crash (no remediation_closed journaled)", async () => {
    s = await env();
    await flaky(s, "T3");
    await ciFailed(s, "T3");
    await s.event((e) => e.type === "agent_spawned" && e.task === FIXER);
    await s.settled();
    await s.daemon.recordEvent("w1", {
      type: "stage_entered",
      task: FIXER,
      data: { stage: "done" },
    });
    await s.event("remediation_closed");
    await s.settled();
    await s.daemon.stop();
    // The crash came between the fixer's done and its close.
    const file = join(s.env.home, "waves", "w1", "journal.jsonl");
    const lines = readFileSync(file, "utf8").split("\n");
    const at = lines.findIndex((l) => l.includes('"remediation_closed"'));
    writeFileSync(file, `${lines.slice(0, at).join("\n")}\n`);
    expect(of(s.journal(), "remediation_closed")).toHaveLength(0);
    await s.restart();
    const closed = await s.event("remediation_closed");
    await s.settled();
    expect(closed.data).toMatchObject({ outcome: "landed", released: ["T3"] });
  });

  it("past autopilot.fix_flake_max: no fixer, the blocked task's ci_failed escalated budget_exhausted", async () => {
    s = await env({ config: "autopilot: { fix_flake_max: 0 }" });
    const d3 = await ciFailed(s, "T3");
    await flaky(s, "T3");
    const esc = await s.event("decision_escalated");
    await s.settled();
    expect(esc.data).toMatchObject({
      decision_id: d3,
      why: "budget_exhausted",
      budget: { key: "fix_flake_max", used: 0, max: 0 },
    });
    expect(of(s.journal(), "task_queued", FIXER)).toEqual([]);
  });
});
