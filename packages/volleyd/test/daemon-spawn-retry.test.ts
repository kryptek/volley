import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import { CONFIG_DEFAULTS } from "../src/config-defaults";
import type { Daemon } from "../src/daemon";
import { readJournalFile } from "../src/journal";
import { apply, emptyRecord } from "../src/reducer";
import { SpawnError } from "../src/spawn-error";
import type { JournalEvent, TaskState } from "../src/types";
import { parseWaveFile } from "../src/wave-file";
import { type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { type FakeClock, fakeClock } from "./helpers/fake-clock";
import { fakeExec } from "./helpers/fake-exec";
import { FIXTURES, type FakeHost, fakeHost } from "./helpers/fake-host";
import { type EventMatch, type JournalWait, journalWait } from "./helpers/journal-wait";
import { runCli } from "./helpers/run-cli";

const ID = "w1-t1-implementer-1";
const T0 = Date.parse("2026-10-18T12:00:00.000Z");

describe("visible spawn failures: spawn_failed, backoff, one decision, spawn_recovered", () => {
  let env: DaemonEnv;
  let agent: VolleyBroker;
  let host: FakeHost;
  let daemon: Daemon;
  let startOpts: Parameters<DaemonEnv["start"]>[0];
  /** The git argvs run in the wave's repo so far. */
  let gitCalls: () => string[][] = () => [];
  /** The daemon's clock: every backoff, verification window and reap grace runs on it. */
  let clock: FakeClock;
  let waits: JournalWait;
  /** While true, every worktree add fails as in the owner's smoke. */
  let failing = true;
  /** A launched session comes up (its MCP status, then the hooks) once this resolves. */
  let sessionGate: Promise<void> = Promise.resolve();
  /** While false, the launched session's MCP server never publishes its own status. */
  let mcpStatus = true;
  /** The simulated sessions' in-flight publishes (see teardown). */
  const sessions = new Set<Promise<void>>();
  let sessionErrors: unknown[] = [];
  let closing = false;

  const journal = (): JournalEvent[] =>
    readJournalFile(join(env.home, "waves", "w1", "journal.jsonl"));
  const of = (type: string) => journal().filter((e) => e.type === type);
  /** The n-th journal event matching `match`, awaited as the daemon appends it. */
  const event = (match: EventMatch, n = 1) => waits.event("w1", match, n);
  /** The daemon is idle: whatever a tick or an answer started has run. */
  const settle = () => waits.settled();
  const task = (): TaskState => daemon.snapshot("w1")?.tasks[0] as TaskState;
  const pub = (topic: string, type: string, channel: string, payload: unknown, retain = true) =>
    agent.publish(
      topic,
      JSON.stringify({
        ...buildEnvelope({ agentId: ID, parentId: "volleyd", channel, type, payload }),
        ...(channel === "_system/registry" ? { namespace: NS } : {}),
      }),
      { qos: 1, retain },
    );

  async function setup(
    config: string,
    o: {
      failing?: boolean;
      /** Hold launched sessions until this resolves (default: they come up at once). */
      sessionGate?: Promise<void>;
      mcpStatus?: boolean;
      /** The repo's release branch: local (default), nowhere, or on origin once fetched. */
      release?: "local" | "missing" | "after-fetch";
      /** The task's `host:` (default local). */
      taskHost?: string;
    } = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    clock = fakeClock(T0);
    failing = o.failing ?? true;
    sessionGate = o.sessionGate ?? Promise.resolve();
    mcpStatus = o.mcpStatus ?? true;
    closing = false;
    sessionErrors = [];
    env = await makeDaemonEnv();
    const repo = join(realpathSync(env.home), "repo");
    mkdirSync(repo);
    const claudeJson = join(env.home, "claude.json");
    writeFileSync(
      claudeJson,
      JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }),
    );
    agent = new VolleyBroker();
    await agent.connect({ url: env.broker.url, agentId: "agent-sim" });
    const fake = fakeExec()
      .on(["git", "-C", repo, "rev-parse", "--show-toplevel"], { stdout: `${repo}\n` })
      .on(["git", "-C", repo, "rev-parse", "--verify", "--quiet", "refs/heads/release/w1"], {
        stdout: `${"1".repeat(40)}\n`,
      })
      .on(["gh", "issue", "view"], {
        stdout: readFileSync(join(FIXTURES, "gh-issue-42.json"), "utf-8"),
      })
      .on(["volley", "auth", "add-agent"], (argv) => ({
        stdout: JSON.stringify({ username: argv[3], password: "pw" }),
      }));
    if (o.release === "missing" || o.release === "after-fetch") {
      const fetched = () => fake.argvs(["git", "-C", repo, "fetch"]).length > 0;
      fake
        .on(["git", "-C", repo, "rev-parse", "--verify", "--quiet", "refs/heads/release/w1"], {
          code: 1,
        })
        .on(
          ["git", "-C", repo, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/release/w1"],
          () =>
            o.release === "after-fetch" && fetched()
              ? { stdout: `${"2".repeat(40)}\n` }
              : { code: 1 },
        );
    }
    gitCalls = () => fake.argvs(["git", "-C", repo]);
    host = fakeHost(fake);
    const prepare = host.prepareWorktree.bind(host);
    host.prepareWorktree = async (spec) => {
      if (failing) {
        throw new SpawnError(
          "WORKTREE_FAILED",
          "git worktree add failed: fatal: invalid reference: release/w1",
          { path: spec.path, branch: spec.branch },
        );
      }
      return prepare(spec);
    };
    // The launched session: the MCP server's spawning status, then the SessionStart hook. Its
    // publishes are tracked, so teardown never disconnects the client under them.
    host.onLaunch = () => {
      if (closing) return;
      const s = sessionGate
        .then(() => (closing ? undefined : session()))
        .catch((e: unknown) => {
          sessionErrors.push(e);
        });
      sessions.add(s);
      void s.finally(() => sessions.delete(s));
    };
    const session = async () => {
      if (mcpStatus) await pub(buildTopic(NS, ID, "status"), "spawning", "status", {});
      await pub(registryTopic(ID), "registered", "_system/registry", {
        capabilities: [],
        cwd: "/wt",
        started_at: new Date().toISOString(),
        model: "claude-opus-5-5",
        model_source: "harness-hook",
      });
      await pub(buildTopic(NS, ID, "status"), "working", "status", { source: "harness-hook" });
      await pub(
        buildTopic(NS, ID, "progress"),
        "heartbeat",
        "progress",
        { source: "harness-hook", seq: 1, hook_event: "SessionStart" },
        false,
      );
    };
    startOpts = {
      clock,
      spawner: {
        host,
        claudeJsonPath: claudeJson,
        hooksDir: "/opt/volley-hooks",
        reapGraceMs: 300,
      },
    };
    daemon = await env.start(startOpts);
    waits = journalWait(env.home, () => daemon);
    const wave = join(env.home, "w1.yaml");
    writeFileSync(
      wave,
      `wave: w1\nrepo: ${repo}\nrelease_branch: release/w1\nmodel: claude-opus-5-5\npipeline: [implement]\ntasks:\n  T1: { issue: 42${o.taskHost !== undefined ? `, host: ${o.taskHost}` : ""} }\nconfig: { worktree_root: ${join(env.home, "wt")}, ${config} }\n`,
    );
    const r = await runCli(["run", wave], env.env);
    if (o.release === "missing") return r;
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    return r;
  }

  afterEach(async () => {
    closing = true;
    await Promise.all([...sessions]);
    await agent.disconnect();
    await env.cleanup();
    expect(sessionErrors).toEqual([]);
  });

  it("journals each failure with its retry, keeps one decision open, doubles the wait, recovers visibly", async () => {
    await setup("spawn_retry_max_s: 100, spawn_retry_max: 5");
    await event("spawn_failed");
    expect(of("spawn_failed")[0]).toMatchObject({
      task: "T1",
      data: {
        code: "WORKTREE_FAILED",
        message: "git worktree add failed: fatal: invalid reference: release/w1",
        role: "implementer",
        attempt: 1,
        next_retry_at: new Date(T0 + 30_000).toISOString(),
      },
    });
    const opened = await event("decision_opened");
    expect(opened?.data).toMatchObject({
      kind: "spawn_failed",
      options: ["retry now", "stop task"],
      parks: false,
    });
    expect(opened?.data.question).toContain("WORKTREE_FAILED");
    // The task stays queued (the decision does not park it) and says why it waits.
    expect(task()).toMatchObject({
      stage: "queued",
      why_waiting: "spawn failed: WORKTREE_FAILED — retry in 30s (attempt 1)",
      last_error: {
        code: "WORKTREE_FAILED",
        message: "git worktree add failed: fatal: invalid reference: release/w1",
      },
      attempt: 1,
      next_retry_at: new Date(T0 + 30_000).toISOString(),
    });
    const status = await runCli(["status"], env.env);
    expect(status.stdout).toContain("decisions: 1  alarms: 1");
    expect(status.stdout).toContain("spawn failed: WORKTREE_FAILED — retry in 30s (attempt 1)");
    const json = JSON.parse((await runCli(["status", "w1", "--json"], env.env)).stdout);
    expect(json.tasks[0]).toMatchObject({
      last_error: { code: "WORKTREE_FAILED" },
      attempt: 1,
      next_retry_at: new Date(T0 + 30_000).toISOString(),
    });

    // Not before its time.
    await clock.advanceTo(T0 + 29_000);
    await daemon.tick();
    await settle();
    expect(of("spawn_failed")).toHaveLength(1);
    expect(task().why_waiting).toBe("spawn failed: WORKTREE_FAILED — retry in 1s (attempt 1)");

    // Then 30 s → 60 s → capped at spawn_retry_max_s (100), one decision throughout.
    await clock.advanceTo(T0 + 30_000);
    await daemon.tick();
    expect((await event("spawn_failed", 2)).data).toMatchObject({
      attempt: 2,
      next_retry_at: new Date(clock.now() + 60_000).toISOString(),
    });
    await clock.advance(60_000);
    await daemon.tick();
    expect((await event("spawn_failed", 3)).data).toMatchObject({
      attempt: 3,
      next_retry_at: new Date(clock.now() + 100_000).toISOString(),
    });
    await settle();
    expect(of("decision_opened")).toHaveLength(1);
    expect(task().why_waiting).toBe("spawn failed: WORKTREE_FAILED — retry in 100s (attempt 3)");

    // The cause is fixed (the tracking branch exists): the next retry spawns, visibly.
    failing = false;
    await clock.advance(100_000);
    await daemon.tick();
    expect(await event("spawn_recovered")).toMatchObject({
      task: "T1",
      data: { role: "implementer", after_failures: 3, attempt: 4 },
    });
    expect((await event("decision_resolved")).data).toMatchObject({
      decision_id: opened?.data.decision_id,
      answer: "recovered",
      by: "volleyd",
    });
    await event("agent_registered");
    await settle();
    const t = task();
    expect(t.why_waiting ?? "").not.toContain("spawn failed");
    expect(t.last_error).toBeUndefined();
    expect(t.next_retry_at).toBeUndefined();
    expect((await runCli(["status"], env.env)).stdout).toContain("decisions: 0  alarms: 0");
  });

  it("spawn_retry_max reached: retries stop, the decision says so; 'retry now' tries again", async () => {
    await setup("spawn_retry_max: 2");
    await event("spawn_failed");
    await clock.advance(30_000);
    await daemon.tick();
    expect((await event("spawn_failed", 2)).data).toMatchObject({
      attempt: 2,
      next_retry_at: null,
    });
    const stopped = await event(
      (e) => e.type === "decision_opened" && String(e.data.question).includes("retries stopped"),
    );
    await settle();
    expect(stopped?.data).toMatchObject({
      kind: "spawn_failed",
      options: ["retry now", "stop task"],
    });
    // The first decision was superseded, so exactly one is open.
    expect(daemon.snapshot("w1")?.open_decisions).toEqual([stopped?.data.decision_id]);
    expect(task().why_waiting).toBe(
      "spawn failed: WORKTREE_FAILED — retries stopped after 2 attempts",
    );
    expect(task().next_retry_at).toBeNull();

    // No automatic retry, however long it waits — nor after a restart.
    await clock.advance(24 * 3_600_000);
    await daemon.tick();
    await settle();
    expect(of("spawn_failed")).toHaveLength(2);
    await daemon.stop();
    daemon = await env.start(startOpts);
    await daemon.tick();
    await settle();
    expect(of("spawn_failed")).toHaveLength(2);

    // The owner fixes it and answers "retry now".
    failing = false;
    const r = await runCli(
      ["resolve", stopped?.data.decision_id as string, "retry now", "--by", "tester"],
      env.env,
    );
    expect(r.stderr).toBe("");
    await daemon.tick();
    expect((await event("spawn_recovered")).data).toMatchObject({ after_failures: 2, attempt: 3 });
  });

  it("'stop task' cancels the task", async () => {
    await setup("spawn_retry_max: 5");
    const id = (await event("decision_opened")).data.decision_id as string;
    const r = await runCli(["resolve", id, "stop task", "--by", "tester"], env.env);
    expect(r.stderr).toBe("");
    await event("task_cancelled");
    await settle();
    expect(task().stage).toBe("cancelled");
    expect(task().last_error).toBeUndefined();
    await clock.advance(3_600_000);
    await daemon.tick();
    await settle();
    expect(of("spawn_failed")).toHaveLength(1);
  });

  it("two roles of one step failing: each counts its own attempts, backs off and reaches the stop", async () => {
    await setup("spawn_retry_max: 3");
    await event("spawn_failed");
    await settle();
    // A step that spawns two roles at once ([spec_review, quality_review]), both refused.
    const d = daemon as unknown as {
      spawnFailed(wave: string, task: string, role: string, e: unknown): Promise<void>;
    };
    const err = new SpawnError("WORKTREE_FAILED", "git worktree add failed: boom");
    for (let i = 0; i < 3; i++) {
      await d.spawnFailed("w1", "T1", "spec_reviewer", err);
      await d.spawnFailed("w1", "T1", "quality_reviewer", err);
    }
    const byRole = (role: string) =>
      of("spawn_failed")
        .filter((e) => e.data.role === role)
        .map((e) => [e.data.attempt, e.data.next_retry_at]);
    for (const role of ["spec_reviewer", "quality_reviewer"]) {
      expect(byRole(role)).toEqual([
        [1, new Date(T0 + 30_000).toISOString()],
        [2, new Date(T0 + 60_000).toISOString()],
        [3, null],
      ]);
    }
    expect(byRole("implementer")).toEqual([[1, new Date(T0 + 30_000).toISOString()]]);
    // One decision on the task, superseded once by the one that says the retries stopped.
    await event(
      (e) => e.type === "decision_opened" && String(e.data.question).includes("retries stopped"),
    );
    await settle();
    expect(daemon.snapshot("w1")?.open_decisions).toHaveLength(1);
    expect(of("decision_opened")).toHaveLength(2);

    // The implementer's retry succeeds: its own failure is recovered, but the reviewers' are
    // not, so the decision stays open and the task still shows the latest failure.
    failing = false;
    await clock.advanceTo(T0 + 30_000);
    await daemon.tick();
    expect((await event("spawn_recovered")).data).toMatchObject({
      role: "implementer",
      after_failures: 1,
      attempt: 2,
    });
    await event("agent_registered");
    await settle();
    expect(of("decision_resolved").filter((e) => e.data.answer === "recovered")).toHaveLength(0);
    expect(daemon.snapshot("w1")?.open_decisions).toHaveLength(1);
    expect(task()).toMatchObject({
      last_error: { code: "WORKTREE_FAILED" },
      attempt: 3,
      next_retry_at: null,
    });
  });

  it("a `volleyd spawn` refused SPAWN_LOCKED while the launched agent is verifying records nothing against the task", async () => {
    // The session stays down until the extra spawn was refused: it is refused mid-verification.
    let comeUp: () => void = () => {};
    const sessionGate = new Promise<void>((r) => {
      comeUp = r;
    });
    await setup("spawn_retry_max: 5", { failing: false, sessionGate });
    await event("agent_spawned");
    const r = await runCli(["spawn", "w1", "T1"], env.env);
    expect(r.stderr).toContain("SPAWN_LOCKED");
    expect(of("agent_registered")).toHaveLength(0);
    comeUp();
    await event("agent_registered");
    await settle();
    expect(of("spawn_failed")).toHaveLength(0);
    expect(of("decision_opened")).toHaveLength(0);
    expect(task().last_error).toBeUndefined();
    expect(task().why_waiting ?? "").not.toContain("spawn failed");
  });

  it("an agent whose MCP server never reaches volleyd's broker parks the task on mcp_not_registered", async () => {
    await setup("spawn_retry_max: 5", { failing: false, mcpStatus: false });
    await event("agent_spawned");
    // The session's hook signals are on the broker; a control round-trip through the daemon's
    // connection (behind them on it) proves the daemon has read them. Then the window closes.
    await Promise.all([...sessions]);
    expect((await runCli(["status"], env.env)).exitCode).toBe(0);
    const windowMs = CONFIG_DEFAULTS.spawn_timeout_s * 1000;
    await clock.armed(windowMs);
    await clock.advance(windowMs);
    await event("verify_failed");
    await event((e) => e.type === "decision_opened" && e.data.kind === "mcp_not_registered");
    await settle();
    expect(task().why_waiting).toContain("mcp_not_registered");
  });

  it("run refuses a wave whose repo has the release branch neither locally nor on origin, before admitting anything", async () => {
    const r = await setup("spawn_retry_max: 5", { release: "missing" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain(
      `RELEASE_BRANCH_MISSING: ${join(realpathSync(env.home), "repo")} has neither release/w1 nor origin/release/w1 — push it first`,
    );
    expect(existsSync(join(env.home, "waves", "w1", "journal.jsonl"))).toBe(false);
    expect(daemon.snapshot("w1")).toBeNull();
    // it fetched before it looked
    expect(gitCalls().map((a) => a[3])).toContain("fetch");
  });

  it("run accepts a release branch pushed from another clone but not fetched yet: it fetches first", async () => {
    await setup("spawn_retry_max: 5", { release: "after-fetch", failing: false });
    const calls = gitCalls().map((a) => a.slice(3, 5).join(" "));
    expect(calls.indexOf("fetch --quiet")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("fetch --quiet")).toBeLessThan(calls.indexOf("rev-parse --verify"));
    await event("task_admitted");
  });

  it("run does not check the local repo for a wave whose every task runs on a remote host", async () => {
    const r = await setup("spawn_retry_max: 5", { release: "missing", taskHost: "build-box.lan" });
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(gitCalls().filter((a) => a[3] === "rev-parse" && a[4] === "--verify")).toEqual([]);
    await event("task_admitted");
  });
});

describe("spawn failures in the reducer", () => {
  const at = "2026-10-18T12:00:00.000Z";
  let seq = 0;
  const ev = (type: string, data: Record<string, unknown>, task = "T1"): JournalEvent =>
    ({ v: 1, seq: ++seq, at, wave: "w1", type, task, data }) as unknown as JournalEvent;
  const failed = (role: string, attempt: number) =>
    ev("spawn_failed", {
      code: "WORKTREE_FAILED",
      message: "boom",
      role,
      attempt,
      next_retry_at: at,
    });
  const base = () => {
    seq = 0;
    let rec = emptyRecord();
    const wave = parseWaveFile(
      "wave: w1\nrepo: /r\nrelease_branch: release/w1\nmodel: claude-opus-5-5\npipeline: [implement]\ntasks:\n  T1: { issue: 1 }\n",
    );
    for (const e of [
      ev("wave_submitted", { wave, owner: null }, undefined),
      ev("task_queued", { issue: 1 }),
    ])
      rec = apply(rec, e);
    return rec;
  };

  it("keeps one failure per role; recovering one role leaves the other's", () => {
    let rec = base();
    rec = apply(rec, failed("spec_reviewer", 1));
    rec = apply(rec, failed("quality_reviewer", 1));
    rec = apply(rec, failed("spec_reviewer", 2));
    expect(Object.keys(rec.spawnFailures.T1 ?? {}).sort()).toEqual([
      "quality_reviewer",
      "spec_reviewer",
    ]);
    // the task shows the latest failure
    expect(rec.state?.tasks[0]?.attempt).toBe(2);
    rec = apply(
      rec,
      ev("spawn_recovered", { role: "spec_reviewer", after_failures: 2, attempt: 3 }),
    );
    expect(Object.keys(rec.spawnFailures.T1 ?? {})).toEqual(["quality_reviewer"]);
    expect(rec.state?.tasks[0]?.attempt).toBe(1);
  });

  it("a task that is done carries no spawn failure", () => {
    let rec = base();
    rec = apply(rec, failed("rebase", 1));
    rec = apply(rec, ev("stage_entered", { stage: "done" }));
    expect(rec.spawnFailures.T1).toBeUndefined();
    expect(rec.state?.tasks[0]?.last_error).toBeUndefined();
  });
});
