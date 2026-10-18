import { existsSync, unlinkSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { buildEnvelope } from "volley-mcp/envelope";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import type { Daemon } from "../src/daemon";
import {
  type ReconcileProbes,
  type TaskFacts,
  ciOf,
  execProbes,
  reconcileTargets,
  reconcileTask,
} from "../src/reconcile";
import type { WaveRecord } from "../src/reducer";
import type { JournalEvent } from "../src/types";
import { NS } from "./helpers/daemon-env";
import { fakeExec } from "./helpers/fake-exec";
import {
  AGENT,
  ARTIFACTS_OK,
  type SupervisedEnv,
  makeSupervisedEnv,
} from "./helpers/supervised-env";

const NOW = Date.parse("2026-10-18T12:00:00.000Z");
const STALE_MS = 600_000;

const facts = (over: Partial<TaskFacts> = {}): TaskFacts => ({
  task: "T1",
  stage: "implement",
  agent_id: AGENT,
  role: "implementer",
  registered: true,
  status: "working",
  heartbeat_at: NOW - 60_000,
  lock: true,
  branch: { name: "w1/T1-implementer-1", exists: true, head: "abc123" },
  pr: null,
  ...over,
});

describe("reconcileTask (pure)", () => {
  it("consistent → drift: [] and no action", () => {
    expect(reconcileTask(facts(), NOW, STALE_MS)).toEqual({
      task: "T1",
      agent_id: AGENT,
      drift: [],
    });
  });

  it("journal implement/working but the agent reported done + PR + CI green → mark_done_verified", () => {
    const pr = {
      number: 7,
      url: "https://example.test/pr/7",
      head_sha: "abc123",
      ci: "green" as const,
    };
    const r = reconcileTask(facts({ status: "done", pr }), NOW, STALE_MS);
    expect(r.action).toBe("mark_done_verified");
    expect(r.drift).toEqual([expect.stringContaining("done")]);
    expect(r.pr).toEqual(pr);
  });

  it("done but the PR is missing or CI is not green → re_wait (the normal done path checks artifacts)", () => {
    expect(reconcileTask(facts({ status: "done" }), NOW, STALE_MS).action).toBe("re_wait");
    const red = { number: 7, url: "u", ci: "red" as const };
    expect(reconcileTask(facts({ status: "done", pr: red }), NOW, STALE_MS).action).toBe("re_wait");
  });

  it("journal working, no registry entry, no heartbeat, no lock → respawn_needed", () => {
    const r = reconcileTask(
      facts({ registered: false, status: null, heartbeat_at: null, lock: false }),
      NOW,
      STALE_MS,
    );
    expect(r.action).toBe("respawn_needed");
    expect(r.drift).toEqual(
      expect.arrayContaining([
        expect.stringContaining("no registry entry"),
        expect.stringContaining("no lock"),
      ]),
    );
  });

  it("any sign the agent may still be alive → re_wait, never a respawn", () => {
    for (const over of [
      { registered: false },
      { status: "reaped", lock: false, registered: false },
      { status: null, registered: false, lock: false, heartbeat_at: NOW - 1000 },
      { status: null, registered: false, heartbeat_at: null },
    ] satisfies Partial<TaskFacts>[]) {
      const r = reconcileTask(facts(over), NOW, STALE_MS);
      expect(r.action, JSON.stringify(over)).toBe("re_wait");
      expect(r.drift.length).toBeGreaterThan(0);
    }
  });

  it("a missing branch is drift", () => {
    const r = reconcileTask(
      facts({ branch: { name: "b", exists: false, head: null } }),
      NOW,
      STALE_MS,
    );
    expect(r.drift).toEqual([expect.stringContaining("branch b")]);
  });
});

describe("reconcileTargets (pure)", () => {
  const ev = (seq: number, type: string, task: string, data: Record<string, unknown>) =>
    ({ seq, at: "2026-10-18T12:00:00.000Z", type, task, data }) as JournalEvent;
  const rec = (stage = "implement") =>
    ({ state: { tasks: [{ id: "T1", stage }] } }) as unknown as WaveRecord;

  it("only the latest spawn per (task, role), and none retired", () => {
    const events = [
      ev(1, "agent_spawned", "T1", { agent_id: "w1-t1-implementer-1", role: "implementer" }),
      ev(2, "agent_spawned", "T1", { agent_id: "w1-t1-implementer-2", role: "implementer" }),
      ev(3, "agent_spawned", "T1", { agent_id: "w1-t1-reviewer-1", role: "reviewer" }),
      ev(4, "agent_spawned", "T1", { agent_id: "w1-t1-fixer-1", role: "fixer" }),
      ev(5, "agent_retired", "T1", { agent_id: "w1-t1-fixer-1", role: "fixer" }),
    ];
    expect(reconcileTargets(rec(), events).map((t) => t.agent_id)).toEqual([
      "w1-t1-implementer-2",
      "w1-t1-reviewer-1",
    ]);
    expect(reconcileTargets(rec("done"), events)).toEqual([]);
  });
});

describe("execProbes (git / gh through the fence)", () => {
  it("asks git for the branch and gh for its PR (exact head match) and checks", async () => {
    const fake = fakeExec()
      .on(["git", "-C", "/repo", "rev-parse"], { stdout: "abc123\n" })
      .on(["gh", "pr", "list"], {
        stdout: JSON.stringify([
          { number: 3, url: "u3", headRefName: "other", headRefOid: "x" },
          { number: 7, url: "u7", headRefName: "w1/T1-implementer-1", headRefOid: "abc123" },
        ]),
      })
      .on(["gh", "pr", "checks"], {
        stdout: JSON.stringify([{ bucket: "pass" }, { bucket: "skipping" }]),
      });
    const p = execProbes(fake.exec);
    expect(await p.branch("/repo", "w1/T1-implementer-1")).toEqual({
      name: "w1/T1-implementer-1",
      exists: true,
      head: "abc123",
    });
    expect(await p.pr("/repo", "w1/T1-implementer-1")).toEqual({
      number: 7,
      url: "u7",
      head_sha: "abc123",
      ci: "green",
    });
    expect(fake.argvs(["gh", "pr", "checks"])).toEqual([
      ["gh", "pr", "checks", "7", "--json", "bucket"],
    ]);
  });

  it("a missing branch, no PR, and unknown output", async () => {
    const fake = fakeExec().on(["git"], { code: 1 }).on(["gh", "pr", "list"], { stdout: "[]" });
    const p = execProbes(fake.exec);
    expect((await p.branch("/repo", "b")).exists).toBe(false);
    expect(await p.pr("/repo", "b")).toBeNull();
    expect(ciOf("")).toBe("none");
    expect(ciOf(JSON.stringify([{ bucket: "pass" }, { bucket: "fail" }]))).toBe("red");
    expect(ciOf(JSON.stringify([{ bucket: "pending" }]))).toBe("running");
  });
});

describe("daemon: restart reconciliation", () => {
  let s: SupervisedEnv;
  let second: Daemon;
  afterEach(async () => {
    await s.cleanup();
  });

  const probes = (pr: Awaited<ReturnType<ReconcileProbes["pr"]>> = null): ReconcileProbes => ({
    branch: async (_repo, branch) => ({ name: branch, exists: true, head: "abc123" }),
    pr: async () => pr,
  });
  const reconciled = (): JournalEvent[] => s.journal().filter((e) => e.type === "reconciled");

  it("a consistent task journals drift: [] and its agent is supervised again", async () => {
    s = await makeSupervisedEnv({ exec: ARTIFACTS_OK });
    await s.daemon.stop();
    second = await s.restart({ reconcile: probes() });
    await second.reconciled();
    expect(reconciled()).toHaveLength(1);
    expect(reconciled()[0]).toMatchObject({ task: "T1", data: { agent_id: AGENT, drift: [] } });
    expect(reconciled()[0]?.data.action).toBeUndefined();
    // Re-supervised: its done status is consumed (verified by the pipeline) and it is retired.
    await s.status("done", { summary: "ok" });
    await s.until(() => s.journal().some((e) => e.type === "agent_retired"));
    expect(second).toBeDefined();
  });

  it("an agent that finished while the daemon was down, with a green PR → mark_done_verified", async () => {
    s = await makeSupervisedEnv({ exec: ARTIFACTS_OK });
    await s.daemon.stop();
    await s.status("done", { summary: "ok" });
    const pr = {
      number: 7,
      url: "https://example.test/pr/7",
      head_sha: "abc123",
      ci: "green" as const,
    };
    second = await s.restart({ reconcile: probes(pr) });
    await second.reconciled();
    expect(reconciled()[0]?.data).toMatchObject({ action: "mark_done_verified", pr });
    expect(second.record("w1")?.state?.tasks[0]?.pr).toEqual(pr);
    await s.until(() => s.journal().some((e) => e.type === "agent_retired"));
  });

  it("an agent with no registry, no status, no heartbeat and no lock → respawn_needed decision, nothing launched", async () => {
    s = await makeSupervisedEnv();
    const lock = s.journal().find((e) => e.type === "agent_spawned")?.data.lock as string;
    await s.daemon.stop();
    await s.agent.publish(registryTopic(AGENT), "", { qos: 1, retain: true });
    await s.agent.publish(buildTopic(NS, AGENT, "status"), "", { qos: 1, retain: true });
    unlinkSync(lock);
    expect(existsSync(lock)).toBe(false);
    second = await s.restart({ reconcile: probes() });
    await second.reconciled();
    expect(reconciled()[0]?.data).toMatchObject({ action: "respawn_needed" });
    const d = s.journal().find((e) => e.type === "decision_opened");
    expect(d?.data).toMatchObject({
      kind: "agent_blocked",
      class: "respawn_needed",
      agent_id: AGENT,
    });
    expect(s.host.launches).toHaveLength(1);
    expect(second.record("w1")?.state?.open_decisions).toEqual([d?.data.decision_id]);
  });

  /** Stop the daemon and wipe every trace of the agent: registry, status, lock. */
  async function vanish() {
    const lock = s.journal().find((e) => e.type === "agent_spawned")?.data.lock as string;
    await s.daemon.stop();
    await s.agent.publish(registryTopic(AGENT), "", { qos: 1, retain: true });
    await s.agent.publish(buildTopic(NS, AGENT, "status"), "", { qos: 1, retain: true });
    unlinkSync(lock);
  }
  const respawnDecisions = () =>
    s.journal().filter((e) => e.type === "decision_opened" && e.data.class === "respawn_needed");

  it("restarting twice while respawn_needed is open opens no second decision; stop task retires the dead agent for good", async () => {
    s = await makeSupervisedEnv();
    await vanish();
    second = await s.restart({ reconcile: probes() });
    await second.reconciled();
    expect(respawnDecisions()).toHaveLength(1);
    await second.stop();
    const third = await s.restart({ reconcile: probes() });
    await third.reconciled();
    expect(reconciled()).toHaveLength(2);
    expect(respawnDecisions()).toHaveLength(1);

    const id = respawnDecisions()[0]?.data.decision_id as string;
    await third.resolveDecision("w1", id, { answer: "stop task", by: "tester" });
    await s.until(() => s.journal().some((e) => e.type === "agent_retired"));
    expect(s.journal().find((e) => e.type === "agent_retired")?.data).toMatchObject({
      agent_id: AGENT,
      role: "implementer",
      status: "gone",
    });
    await third.stop();
    const fourth = await s.restart({ reconcile: probes() });
    await fourth.reconciled();
    expect(reconciled()).toHaveLength(2);
    expect(respawnDecisions()).toHaveLength(1);
  });

  it("a heartbeat seen while reconciling counts: no registry, status or lock, but alive → re_wait", async () => {
    s = await makeSupervisedEnv();
    await vanish();
    // Retained so it reaches the reconcile watch as soon as it subscribes (before the probes end).
    await s.agent.publish(
      buildTopic(NS, AGENT, "progress"),
      JSON.stringify({
        ...buildEnvelope({
          agentId: AGENT,
          parentId: "volleyd",
          channel: "progress",
          type: "heartbeat",
          payload: { source: "harness-hook", seq: 9, hook_event: "PostToolUse" },
        }),
      }),
      { qos: 1, retain: true },
    );
    second = await s.restart({ reconcile: probes() });
    await second.reconciled();
    expect(reconciled()[0]?.data).toMatchObject({ action: "re_wait" });
    expect(respawnDecisions()).toEqual([]);
  });

  it("reconciles with spawning off too, but offers no respawn", async () => {
    s = await makeSupervisedEnv();
    await vanish();
    second = await s.env.start({ reconcile: probes() }); // no spawner
    await second.reconciled();
    expect(reconciled()[0]?.data).toMatchObject({ action: "respawn_needed" });
    expect(respawnDecisions()[0]?.data.options).toEqual(["stop task"]);
  });
});
