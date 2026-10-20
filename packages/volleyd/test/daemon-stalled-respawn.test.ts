import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DecisionRecord } from "../src/decisions";
import { AUTOPILOT_ON } from "./helpers/daemon-env";
import { type FakeClock, fakeClock } from "./helpers/fake-clock";
import { AGENT, type SupervisedEnv, makeSupervisedEnv } from "./helpers/supervised-env";

/**
 * A stalled agent (idle after a nudge, twice) answered `respawn`: stopped like `stop task` (a
 * mailbox cancel and an interrupt), retired `relaunched`, and its role spawned at the next attempt
 * through the pipeline; an implementer continues the branch (and PR) it pushed.
 */

const MIN = 60_000;
const NEXT = "w1-t1-implementer-2";

let s: SupervisedEnv;
let clock: FakeClock;
afterEach(async () => {
  await s.cleanup();
});

const stalls = () =>
  s.journal().filter((e) => e.type === "decision_opened" && e.data.kind === "agent_stalled");

/** The agent's pushed branch is on origin (what an implementer respawn continues). */
function pushedBranch(): string {
  const spawned = s.journal().find((e) => e.type === "agent_spawned" && e.data.agent_id === AGENT);
  const branch = String(spawned?.data.branch);
  s.host.fake.on(
    ["git", "-C", s.repo, "rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
    { stdout: `${"2".repeat(40)}\n` },
  );
  return branch;
}

/** Idle (Stop without a terminal status), nudged past idle_grace_s, still idle `wait` later. */
async function stallOnce(wait: number, n: number): Promise<DecisionRecord> {
  await clock.advance(wait);
  await s.daemon.tick();
  const opened = await s.event(
    (e) => e.type === "decision_opened" && e.data.kind === "agent_stalled",
    n,
  );
  await s.settled();
  return s.daemon.record("w1")?.decisions[opened.data.decision_id as string] as DecisionRecord;
}

async function idle(): Promise<void> {
  await s.hook("idle-stop.json");
  await s.consumed();
  // The "continue" nudge.
  await clock.advance(4 * MIN);
  await s.daemon.tick();
  await s.event((e) => e.type === "steering_sent" && e.data.reason === "idle");
  await s.settled();
}

describe("agent_stalled: respawn", () => {
  it("offers respawn; the owner's respawn stops the agent and spawns the implementer again on its branch", async () => {
    clock = fakeClock(Date.now() + 10 * MIN);
    s = await makeSupervisedEnv({ daemon: { clock } });
    const branch = pushedBranch();
    await idle();
    const d = await stallOnce(4 * MIN, 1);
    expect(d.options).toEqual(["nudge again", "respawn", "stop task"]);
    expect((d as unknown as { pipeline: unknown }).pipeline).toMatchObject({
      on: "liveness",
      role: "implementer",
      agent_id: AGENT,
      attempt: 1,
    });

    await s.daemon.resolveDecision("w1", d.decision_id, { answer: "respawn", by: "tester" });
    const relaunched = await s.event("relaunched");
    expect(relaunched.data).toMatchObject({
      from_agent: AGENT,
      to_agent: NEXT,
      role: "implementer",
      attempt: 2,
    });
    await s.event((e) => e.type === "agent_spawned" && e.data.agent_id === NEXT);
    await s.settled();
    const ev = s.journal();
    // Stopped first: a mailbox cancel to the old agent, then its retire.
    const cancel = ev.findIndex(
      (e) => e.type === "steering_sent" && e.data.type === "cancel" && e.data.agent_id === AGENT,
    );
    const retired = ev.findIndex((e) => e.type === "agent_retired" && e.data.agent_id === AGENT);
    expect(cancel).toBeGreaterThan(-1);
    expect(retired).toBeGreaterThan(cancel);
    expect(ev[retired]?.data.status).toBe("relaunched");
    // Never typed to the agent as a steer.
    expect(ev.some((e) => e.type === "steering_sent" && e.data.reason === "stalled")).toBe(false);
    expect(ev.some((e) => e.type === "task_cancelled")).toBe(false);

    // The new attempt continues the pushed branch.
    expect(s.host.launches).toHaveLength(2);
    const next = ev.find((e) => e.type === "agent_spawned" && e.data.agent_id === NEXT);
    expect(next?.data.branch).toBe(branch);
    const brief = readFileSync(join(String(next?.data.worktree), ".volley", "brief.md"), "utf-8");
    expect(brief).toContain(`An earlier attempt of this task pushed \`${branch}\``);
    // The stall slot is free: the retired agent is no longer supervised at all.
    expect(s.daemon.snapshot("w1")?.tasks[0]?.agents.implementer).toBe(NEXT);
  });

  it("nudge again is still steered to the agent", async () => {
    clock = fakeClock(Date.now() + 10 * MIN);
    s = await makeSupervisedEnv({ daemon: { clock } });
    await idle();
    const d = await stallOnce(4 * MIN, 1);
    await s.daemon.resolveDecision("w1", d.decision_id, { answer: "nudge again", by: "tester" });
    await s.event((e) => e.type === "steering_sent" && e.data.reason === "stalled");
    await s.settled();
    expect(s.journal().some((e) => e.type === "relaunched")).toBe(false);
  });

  it("autopilot: the first stall is nudged, the second respawned under respawn_max", async () => {
    clock = fakeClock(Date.now() + 10 * MIN);
    s = await makeSupervisedEnv({ daemon: { clock, ...AUTOPILOT_ON } });
    pushedBranch();
    await idle();
    const first = await stallOnce(4 * MIN, 1);
    expect(first.resolved).toMatchObject({ answer: "nudge again", by: "volleyd" });
    // The answer counts as the next nudge; the next stall waits twice the grace.
    const second = await stallOnce(7 * MIN, 2);
    expect(second.resolved).toMatchObject({ answer: "respawn", by: "volleyd" });
    const auto = s
      .journal()
      .filter((e) => e.type === "decision_auto_resolved")
      .map((e) => e.data);
    expect(auto).toEqual([
      expect.objectContaining({ policy: "agent_stalled/nudge", answer: "nudge again" }),
      expect.objectContaining({
        policy: "agent_stalled/respawn",
        answer: "respawn",
        budget: { key: "respawn_max:T1/implementer", used: 1, max: 1 },
      }),
    ]);
    await s.event((e) => e.type === "agent_spawned" && e.data.agent_id === NEXT);
    await s.settled();
    expect(s.journal().find((e) => e.type === "relaunched")?.data).toMatchObject({
      from_agent: AGENT,
      to_agent: NEXT,
    });
    expect(stalls()).toHaveLength(2);
  });
});
