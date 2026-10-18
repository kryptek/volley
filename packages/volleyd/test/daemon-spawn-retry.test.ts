import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import type { Daemon } from "../src/daemon";
import { readJournalFile } from "../src/journal";
import { SpawnError } from "../src/spawn-error";
import type { JournalEvent, TaskState } from "../src/types";
import { type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { fakeExec } from "./helpers/fake-exec";
import { FIXTURES, type FakeHost, fakeHost } from "./helpers/fake-host";
import { runCli } from "./helpers/run-cli";

const ID = "w1-t1-implementer-1";
const T0 = Date.parse("2026-10-18T12:00:00.000Z");

describe("visible spawn failures: spawn_failed, backoff, one decision, spawn_recovered", () => {
  let env: DaemonEnv;
  let agent: VolleyBroker;
  let host: FakeHost;
  let daemon: Daemon;
  let clock = T0;
  /** While true, every worktree add fails as in the owner's smoke. */
  let failing = true;

  const journal = (): JournalEvent[] =>
    readJournalFile(join(env.home, "waves", "w1", "journal.jsonl"));
  const of = (type: string) => journal().filter((e) => e.type === type);
  const until = async (pred: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error("timed out waiting");
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const settle = () => new Promise((r) => setTimeout(r, 100));
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

  async function setup(config: string) {
    clock = T0;
    failing = true;
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
      .on(["gh", "issue", "view"], {
        stdout: readFileSync(join(FIXTURES, "gh-issue-42.json"), "utf-8"),
      })
      .on(["volley", "auth", "add-agent"], (argv) => ({
        stdout: JSON.stringify({ username: argv[3], password: "pw" }),
      }));
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
    // The launched session: the MCP server's spawning status, then the SessionStart hook.
    host.onLaunch = () => {
      setTimeout(async () => {
        await pub(buildTopic(NS, ID, "status"), "spawning", "status", {});
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
      }, 20);
    };
    daemon = await env.start({
      now: () => clock,
      spawner: {
        host,
        claudeJsonPath: claudeJson,
        hooksDir: "/opt/volley-hooks",
        reapGraceMs: 300,
      },
    });
    const wave = join(env.home, "w1.yaml");
    writeFileSync(
      wave,
      `wave: w1\nrepo: ${repo}\nrelease_branch: release/w1\nmodel: claude-opus-5-5\npipeline: [implement]\ntasks:\n  T1: { issue: 42 }\nconfig: { worktree_root: ${join(env.home, "wt")}, ${config} }\n`,
    );
    const r = await runCli(["run", wave], env.env);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
  }

  afterEach(async () => {
    await agent.disconnect();
    await env.cleanup();
  });

  it("journals each failure with its retry, keeps one decision open, doubles the wait, recovers visibly", async () => {
    await setup("spawn_retry_max_s: 100, spawn_retry_max: 5");
    await until(() => of("spawn_failed").length === 1);
    expect(of("spawn_failed")[0]).toMatchObject({
      task: "T1",
      data: {
        code: "WORKTREE_FAILED",
        message: "WORKTREE_FAILED: git worktree add failed: fatal: invalid reference: release/w1",
        role: "implementer",
        attempt: 1,
        next_retry_at: new Date(T0 + 30_000).toISOString(),
      },
    });
    await until(() => of("decision_opened").length === 1);
    const opened = of("decision_opened")[0];
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
        message: "WORKTREE_FAILED: git worktree add failed: fatal: invalid reference: release/w1",
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
    clock = T0 + 29_000;
    await daemon.tick();
    await settle();
    expect(of("spawn_failed")).toHaveLength(1);
    expect(task().why_waiting).toBe("spawn failed: WORKTREE_FAILED — retry in 1s (attempt 1)");

    // Then 30 s → 60 s → capped at spawn_retry_max_s (100), one decision throughout.
    clock = T0 + 30_000;
    await daemon.tick();
    await until(() => of("spawn_failed").length === 2);
    expect(of("spawn_failed")[1]?.data).toMatchObject({
      attempt: 2,
      next_retry_at: new Date(clock + 60_000).toISOString(),
    });
    clock += 60_000;
    await daemon.tick();
    await until(() => of("spawn_failed").length === 3);
    expect(of("spawn_failed")[2]?.data).toMatchObject({
      attempt: 3,
      next_retry_at: new Date(clock + 100_000).toISOString(),
    });
    expect(of("decision_opened")).toHaveLength(1);
    expect(task().why_waiting).toBe("spawn failed: WORKTREE_FAILED — retry in 100s (attempt 3)");

    // The cause is fixed (the tracking branch exists): the next retry spawns, visibly.
    failing = false;
    clock += 100_000;
    await daemon.tick();
    await until(() => of("spawn_recovered").length === 1);
    expect(of("spawn_recovered")[0]).toMatchObject({
      task: "T1",
      data: { role: "implementer", after_failures: 3, attempt: 4 },
    });
    await until(() => of("decision_resolved").length === 1);
    expect(of("decision_resolved")[0]?.data).toMatchObject({
      decision_id: opened?.data.decision_id,
      answer: "recovered",
      by: "volleyd",
    });
    await until(() => of("agent_registered").length === 1);
    const t = task();
    expect(t.why_waiting ?? "").not.toContain("spawn failed");
    expect(t.last_error).toBeUndefined();
    expect(t.next_retry_at).toBeUndefined();
    expect((await runCli(["status"], env.env)).stdout).toContain("decisions: 0  alarms: 0");
  });

  it("spawn_retry_max reached: retries stop, the decision says so; 'retry now' tries again", async () => {
    await setup("spawn_retry_max: 2");
    await until(() => of("spawn_failed").length === 1);
    clock += 30_000;
    await daemon.tick();
    await until(() => of("spawn_failed").length === 2);
    expect(of("spawn_failed")[1]?.data).toMatchObject({ attempt: 2, next_retry_at: null });
    await until(() =>
      of("decision_opened").some((e) => String(e.data.question).includes("retries stopped")),
    );
    const stopped = of("decision_opened").at(-1);
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

    // No automatic retry, however long it waits.
    clock += 24 * 3_600_000;
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
    await until(() => of("spawn_recovered").length === 1);
    expect(of("spawn_recovered")[0]?.data).toMatchObject({ after_failures: 2, attempt: 3 });
  });

  it("'stop task' cancels the task", async () => {
    await setup("spawn_retry_max: 5");
    await until(() => of("decision_opened").length === 1);
    const id = of("decision_opened")[0]?.data.decision_id as string;
    const r = await runCli(["resolve", id, "stop task", "--by", "tester"], env.env);
    expect(r.stderr).toBe("");
    await until(() => of("task_cancelled").length === 1);
    expect(task().stage).toBe("cancelled");
    expect(task().last_error).toBeUndefined();
    clock += 3_600_000;
    await daemon.tick();
    await settle();
    expect(of("spawn_failed")).toHaveLength(1);
  });
});
