import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Role } from "../src/brief";
import { blockedReason } from "../src/pipeline";
import type { BranchUpdate } from "../src/types";
import { FIXTURES } from "./helpers/fake-host";
import { type Harness, pipelineHarness, sha } from "./helpers/pipeline-harness";

/**
 * Every role's `blocked` status becomes an `agent_blocked` decision (continue | respawn | cancel)
 * that parks the task and retires nothing: SPEC §5.2 lets a blocked agent stay alive, waiting for
 * mailbox guidance.
 */

const result = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, "review-results", `${name}.json`), "utf-8"));

const H1 = sha(0x1001);
const H2 = sha(0x1002);

let h: Harness;
afterEach(() => h?.cleanup());

const stage = () => h.task()?.stage;
const blockedDecisions = () =>
  h.events.filter((e) => e.type === "decision_opened" && e.data.kind === "agent_blocked");

/** Drive the default pipeline (with `update` as the branch_update tunable) to where `role` runs. */
async function runningRole(role: Role, update?: BranchUpdate): Promise<string> {
  h = pipelineHarness(update !== undefined ? { branchUpdate: update } : {});
  await h.start();
  if (role === "implementer") return "implement";
  h.openPr(H1);
  await h.finish("implementer", { head: H1, ci: "green" });
  if (role === "spec_reviewer" || role === "quality_reviewer") return "spec_review";
  await h.finish("spec_reviewer", { result: result("spec-p1") });
  await h.finish("quality_reviewer", { result: result("quality-p1-elsewhere") });
  if (role === "fixup") return "fixup";
  // The release branch moved: the update step runs after the fixup.
  h.world.mergeBase[H2] = sha(0xdead);
  await h.finish("fixup", { head: H2, ci: "green", result: result("fixup-resolved") });
  return "fixup";
}

const ROLES: [Role, BranchUpdate | undefined][] = [
  ["implementer", undefined],
  ["spec_reviewer", undefined],
  ["quality_reviewer", undefined],
  ["fixup", undefined],
  ["rebase", undefined],
  ["rebase", "merge"],
];

describe.each(ROLES)("pipeline: a blocked %s (branch_update %s)", (role, update) => {
  it("opens one agent_blocked decision with the reason, parks the task, retires nothing", async () => {
    const at = await runningRole(role, update);
    expect(stage()).toBe(at);
    const agent = h.run(role)?.agent_id as string;
    const retiredBefore = h.retired.length;
    await h.block(role, "stuck on the API key");
    const opened = blockedDecisions();
    expect(opened).toHaveLength(1);
    expect(opened[0]?.task).toBe("T1");
    expect(opened[0]?.data).toMatchObject({
      kind: "agent_blocked",
      options: ["continue", "respawn", "cancel"],
      pipeline: { on: "agent_blocked", role },
      agent_id: agent,
      reason: "stuck on the API key",
    });
    const q = opened[0]?.data.question as string;
    expect(q).toContain(agent);
    expect(q).toContain(update === "merge" ? "merge (branch update)" : role);
    expect(q).toContain("stuck on the API key");
    expect(h.retired.length).toBe(retiredBefore);
    expect(stage()).toBe("awaiting_decision");
  });

  it("continue: the task returns to its stage, the agent keeps its run, nothing is spawned", async () => {
    const at = await runningRole(role, update);
    const agent = h.run(role)?.agent_id;
    const spawns = h.spawns.length;
    await h.block(role, "stuck");
    const id = h.openDecisions()[0]?.decision_id as string;
    await h.resolve(id, "continue");
    expect(stage()).toBe(at);
    expect(h.run(role)?.agent_id).toBe(agent);
    expect(h.run(role)?.retired).toBeUndefined();
    expect(h.spawns.length).toBe(spawns);
    // A new blocked (a new status) after continue is a new question.
    await h.block(role, "stuck again");
    expect(blockedDecisions()).toHaveLength(2);
  });

  it("respawn: the agent is retired as relaunched and the role's next attempt spawns", async () => {
    await runningRole(role, update);
    const agent = h.run(role)?.agent_id as string;
    const spawns = h.spawns.filter((s) => s.role === role).length;
    await h.block(role, "stuck");
    await h.resolve(h.openDecisions()[0]?.decision_id as string, "respawn");
    expect(h.retired).toContainEqual({ agent_id: agent, status: "relaunched" });
    expect(h.events.find((e) => e.type === "relaunched")?.data).toMatchObject({
      from_agent: agent,
      role,
    });
    expect(h.spawns.filter((s) => s.role === role)).toHaveLength(spawns + 1);
    expect(h.run(role)?.agent_id).not.toBe(agent);
  });

  it("cancel: the agent is stopped and the task cancelled", async () => {
    await runningRole(role, update);
    const agent = h.run(role)?.agent_id as string;
    await h.block(role, "stuck");
    await h.resolve(h.openDecisions()[0]?.decision_id as string, "cancel");
    expect(h.events.some((e) => e.type === "task_cancelled")).toBe(true);
    expect(stage()).toBe("cancelled");
    expect(h.retired).toContainEqual({ agent_id: agent, status: "stopped" });
  });
});

describe("pipeline: blocked edge cases", () => {
  it("a stale agent (not the role's run) opens nothing", async () => {
    await runningRole("implementer");
    await h.driver.handle("T1", {
      kind: "agent_blocked",
      role: "implementer",
      agent_id: "someone-else",
      reason: "stuck",
      payload: {},
    });
    expect(blockedDecisions()).toHaveLength(0);
  });

  it("respawn after the agent finished by hand and was accepted relaunches nothing", async () => {
    await runningRole("implementer");
    const agent = h.run("implementer")?.agent_id as string;
    await h.block("implementer", "stuck");
    const id = h.openDecisions()[0]?.decision_id as string;
    // The owner steered it by hand; it pushed and reported done before anyone answered.
    h.openPr(H1);
    await h.finish("implementer", { head: H1, ci: "green" });
    expect(h.run("implementer")?.accepted).toBe(true);
    const spawns = h.spawns.filter((s) => s.role === "implementer").length;
    await h.resolve(id, "respawn");
    expect(h.events.some((e) => e.type === "relaunched")).toBe(false);
    expect(h.retired).not.toContainEqual({ agent_id: agent, status: "relaunched" });
    expect(h.spawns.filter((s) => s.role === "implementer")).toHaveLength(spawns);
    expect(h.run("implementer")?.agent_id).toBe(agent);
    expect(h.run("implementer")?.accepted).toBe(true);
  });

  it("any other answer is asked again", async () => {
    await runningRole("implementer");
    await h.block("implementer", "stuck");
    await h.resolve(h.openDecisions()[0]?.decision_id as string, "maybe");
    const asks = blockedDecisions();
    expect(asks).toHaveLength(2);
    expect(asks[1]?.data.question).toMatch(/^"maybe" is not one of continue \/ respawn \/ cancel/);
    expect(asks[1]?.data.agent_id).toBe(h.run("implementer")?.agent_id);
    expect(stage()).toBe("awaiting_decision");
  });

  it("the reason: reason, else summary, else text, else a placeholder; clipped in the question", async () => {
    expect(blockedReason({ reason: "r", summary: "s" })).toBe("r");
    expect(blockedReason({ summary: "s", text: "t" })).toBe("s");
    expect(blockedReason({ text: "t" })).toBe("t");
    expect(blockedReason({})).toBe("(no reason given)");
    expect(blockedReason(null)).toBe("(no reason given)");
    await runningRole("implementer");
    await h.block("implementer", "x".repeat(2000));
    const d = blockedDecisions()[0]?.data;
    expect((d?.question as string).length).toBeLessThan(800);
    expect(d?.reason).toHaveLength(2000);
  });
});
