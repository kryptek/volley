import { existsSync, unlinkSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import type { Daemon } from "../src/daemon";
import {
  type ReconcileProbes,
  type TaskFacts,
  ciOf,
  execProbes,
  reconcileTask,
} from "../src/reconcile";
import type { JournalEvent } from "../src/types";
import { NS } from "./helpers/daemon-env";
import { fakeExec } from "./helpers/fake-exec";
import { AGENT, type SupervisedEnv, makeSupervisedEnv } from "./helpers/supervised-env";

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
    s = await makeSupervisedEnv();
    await s.daemon.stop();
    second = await s.restart({ reconcile: probes() });
    expect(reconciled()).toHaveLength(1);
    expect(reconciled()[0]).toMatchObject({ task: "T1", data: { agent_id: AGENT, drift: [] } });
    expect(reconciled()[0]?.data.action).toBeUndefined();
    // Re-supervised: its done status is consumed and it is retired.
    await s.status("done", { summary: "ok" });
    await s.until(() => s.journal().some((e) => e.type === "agent_retired"));
    expect(second).toBeDefined();
  });

  it("an agent that finished while the daemon was down, with a green PR → mark_done_verified", async () => {
    s = await makeSupervisedEnv();
    await s.daemon.stop();
    await s.status("done", { summary: "ok" });
    const pr = {
      number: 7,
      url: "https://example.test/pr/7",
      head_sha: "abc123",
      ci: "green" as const,
    };
    second = await s.restart({ reconcile: probes(pr) });
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
});
