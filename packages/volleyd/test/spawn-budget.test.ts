import { afterEach, describe, expect, it } from "vitest";
import { waveDecisionId } from "../src/decisions";
import { AUTOPILOT_ON } from "./helpers/daemon-env";
import { runCli } from "./helpers/run-cli";
import { ARTIFACTS_OK, type SupervisedEnv, makeSupervisedEnv } from "./helpers/supervised-env";

/**
 * Spawn budget exhaustion is never silent: a role spawn the budget holds opens a
 * `spawn_budget_exhausted` decision (raise by N | cancel) that parks the task (its why_waiting
 * names it). `raise by N` raises the wave's budget and the held spawn goes through.
 */

describe("spawn budget exhausted", () => {
  let s: SupervisedEnv;
  afterEach(async () => s.cleanup());

  /** Budget 1: the implementer spends it; its verified done needs a reviewer. */
  async function held() {
    s = await makeSupervisedEnv({
      exec: ARTIFACTS_OK,
      pipeline: "[implement, spec_review, merge_ready]",
      waveExtra: "spawn_budget: 1",
    });
    await s.status("done");
    return s.event((e) => e.type === "decision_opened" && e.data.kind === "spawn_budget_exhausted");
  }

  it("opens one decision with the budget in it, and the task says so", async () => {
    const d = await held();
    expect(d.task).toBe("T1");
    expect(d.data.options).toEqual(["raise by 1", "cancel"]);
    expect(d.data.decision_id).toBe(waveDecisionId("spawn_budget_exhausted", "w1"));
    expect(String(d.data.question)).toContain("1/1");
    await s.settled();
    const t = s.daemon.snapshot("w1")?.tasks[0];
    expect(t?.stage).toBe("awaiting_decision");
    expect(t?.why_waiting).toContain(String(d.data.decision_id));
    // Ticks while it is open do not open another.
    await s.daemon.tick();
    await s.settled();
    expect(
      s
        .journal()
        .filter((e) => e.type === "decision_opened" && e.data.kind === "spawn_budget_exhausted"),
    ).toHaveLength(1);
  });

  it("raise by N lets the held spawn through", async () => {
    const d = await held();
    const r = await runCli(
      ["resolve", String(d.data.decision_id), "raise by 2", "--wave", "w1", "--by", "t"],
      s.env.env,
    );
    expect(r.exitCode, r.stderr).toBe(0);
    await s.daemon.tick();
    const spawned = await s.event(
      (e) => e.type === "agent_spawned" && e.data.role === "spec_reviewer",
    );
    expect(spawned.task).toBe("T1");
  });

  /**
   * Three tasks, budget 3: every implementer spawned; T1's verified done needs a reviewer. Each
   * task still needs its reviewer and a fixup allowance: 6 (the old offer was 1). The 5-task
   * sizing is scheduler.test.ts's.
   */
  async function heldWide(o: { autopilot?: boolean } = {}) {
    s = await makeSupervisedEnv({
      exec: ARTIFACTS_OK,
      pipeline: "[implement, spec_review, merge_ready]",
      waveExtra: "spawn_budget: 3",
      tasks: ["T2: { issue: 42 }", "T3: { issue: 42 }"],
      config: `autopilot: { enabled: ${o.autopilot === true}, budget_raise_max: 3 }`,
      ...(o.autopilot === true ? { daemon: AUTOPILOT_ON } : {}),
    });
    await s.status("done");
    return s.event((e) => e.type === "decision_opened" && e.data.kind === "spawn_budget_exhausted");
  }
  const budgetDecisions = () =>
    s
      .journal()
      .filter((e) => e.type === "decision_opened" && e.data.kind === "spawn_budget_exhausted");

  it("raise by <n> is sized for what the wave still needs, not one spawn (#315)", async () => {
    const d = await heldWide();
    expect(d.data.options).toEqual(["raise by 6", "cancel"]);
  });

  it("one autopilot raise lets the held spawn through with no second decision (#315)", async () => {
    await heldWide({ autopilot: true });
    const spawned = await s.event(
      (e) => e.type === "agent_spawned" && e.data.role === "spec_reviewer",
    );
    expect(spawned.task).toBe("T1");
    const resolved = s.journal().filter((e) => e.type === "decision_resolved");
    expect(resolved.map((e) => e.data.answer)).toEqual(["raise by 6"]);
    expect(s.daemon.record("w1")?.budget_raised).toBe(6);
    await s.daemon.tick();
    await s.settled();
    expect(budgetDecisions()).toHaveLength(1);
  });

  it("an answer it cannot apply is refused and the decision stays open (#315)", async () => {
    const d = await held();
    const r = await runCli(
      ["resolve", String(d.data.decision_id), "raise", "--wave", "w1", "--by", "t"],
      s.env.env,
    );
    expect(r.exitCode).toBe(3);
    expect(s.journal().filter((e) => e.type === "decision_resolved")).toHaveLength(0);
    const ok = await runCli(
      ["resolve", String(d.data.decision_id), "raise 2", "--wave", "w1", "--by", "t"],
      s.env.env,
    );
    expect(ok.exitCode, ok.stderr).toBe(0);
    await s.daemon.tick();
    await s.event((e) => e.type === "agent_spawned" && e.data.role === "spec_reviewer");
  });

  it("cancel cancels the task", async () => {
    const d = await held();
    await runCli(
      ["resolve", String(d.data.decision_id), "cancel", "--wave", "w1", "--by", "t"],
      s.env.env,
    );
    await s.event("task_cancelled");
  });
});
