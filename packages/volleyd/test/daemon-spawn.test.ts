import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import { cleanupWave } from "../src/commands/cleanup";
import type { Daemon } from "../src/daemon";
import { decisionTopic } from "../src/decisions";
import { makeBufferIO } from "../src/io";
import { readJournalFile } from "../src/journal";
import { trustDecisionId } from "../src/trust";
import type { JournalEvent } from "../src/types";
import { type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { type MemoryCredentials, memoryCredentials } from "./helpers/fake-dynsec";
import { fakeExec } from "./helpers/fake-exec";
import { FIXTURES, type FakeHost, fakeHost } from "./helpers/fake-host";
import { runCli } from "./helpers/run-cli";

const ID = "w1-t1-implementer-1";

describe("daemon spawn loop", () => {
  let env: DaemonEnv;
  let agent: VolleyBroker;
  let host: FakeHost;
  let creds: MemoryCredentials;
  let repo: string;
  let claudeJson: string;
  let daemon: Daemon;

  const journal = (): JournalEvent[] =>
    readJournalFile(join(env.home, "waves", "w1", "journal.jsonl"));
  const until = async (pred: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error("timed out waiting");
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const pub = (topic: string, type: string, channel: string, payload: unknown, retain = true) =>
    agent.publish(
      topic,
      JSON.stringify({
        ...buildEnvelope({ agentId: ID, parentId: "volleyd", channel, type, payload }),
        ...(channel === "_system/registry" ? { namespace: NS } : {}),
      }),
      { qos: 1, retain },
    );

  /** A daemon with the spawner on fakes, and wave w1 (one task, T1) submitted to it. */
  async function setup(o: { trusted?: boolean } = {}) {
    env = await makeDaemonEnv();
    repo = realpathSync(env.home);
    repo = join(repo, "repo");
    mkdirSync(repo);
    claudeJson = join(env.home, "claude.json");
    writeFileSync(
      claudeJson,
      JSON.stringify({
        projects: o.trusted === false ? {} : { [repo]: { hasTrustDialogAccepted: true } },
      }),
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
      });
    // The implementer's claimed artifacts (T6 verifies them before retiring it): pushed, one PR
    // for its branch against the release branch, CI green on the head, release branch current.
    const wt = join(env.home, "wt", "w1", "T1-implementer");
    const head = "1111111111111111111111111111111111111111";
    fake
      .on(["git", "-C", wt, "rev-parse"], { stdout: `${head}\n` })
      .on(["git", "-C", wt, "merge-base"], { stdout: `${head}\n` })
      .on(["gh", "pr", "list"], {
        stdout: JSON.stringify([
          {
            number: 7,
            url: "https://github.com/example/repo/pull/7",
            headRefName: "w1/T1-implementer-1",
            baseRefName: "release/w1",
            headRefOid: head,
          },
        ]),
      })
      .on(["gh", "run", "list"], {
        stdout: JSON.stringify([
          {
            databaseId: 1,
            name: "CI",
            status: "completed",
            conclusion: "success",
            headSha: head,
            url: "https://github.com/example/repo/actions/runs/1",
          },
        ]),
      })
      .on(["gh", "pr", "view"], { stdout: JSON.stringify({ state: "OPEN" }) });
    creds = memoryCredentials();
    host = fakeHost(fake);
    // The launched session: MCP registers, the SessionStart hook re-publishes + heartbeats.
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
      spawner: {
        host,
        claudeJsonPath: claudeJson,
        hooksDir: "/opt/volley-hooks",
        reapGraceMs: 300,
        credentials: creds,
      },
    });
    const wave = join(env.home, "w1.yaml");
    writeFileSync(
      wave,
      `wave: w1\nrepo: ${repo}\nrelease_branch: release/w1\nmodel: claude-opus-5-5\npipeline: [implement]\ntasks:\n  T1: { issue: 42 }\nconfig: { worktree_root: ${join(env.home, "wt")} }\n`,
    );
    const r = await runCli(["run", wave], env.env);
    expect(r.exitCode).toBe(0);
  }

  afterEach(async () => {
    await agent.disconnect();
    await env.cleanup();
  });

  it("spawns the admitted implementer, verifies it through the hooks, refuses a second spawn, retires on done", async () => {
    await setup();
    await until(() => journal().some((e) => e.type === "agent_registered"));
    const types = journal().map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "task_admitted",
        "agent_spawned",
        "stage_entered",
        "agent_registered",
      ]),
    );
    expect(host.launches).toHaveLength(1);
    const state = (await env.retained("volley/_waves/w1/state")) as {
      payload: { tasks: { id: string; stage: string; agents: Record<string, string> }[] };
    };
    expect(state.payload.tasks[0]).toMatchObject({
      stage: "implement",
      agents: { implementer: ID },
    });

    // A second `volleyd spawn` for the same worktree while the agent is working is refused.
    const second = await runCli(["spawn", "w1", "T1", "--json"], env.env);
    expect(second.exitCode).toBe(1);
    expect(JSON.parse(second.stdout).result.code).toBe("SPAWN_LOCKED");
    expect(host.launches).toHaveLength(1);
    expect(
      journal()
        .filter((e) => e.type === "alarm_raised")
        .at(-1)?.data,
    ).toMatchObject({
      code: "SPAWN_LOCKED",
    });
    // A refused extra spawn says nothing about the running task: no spawn failure, no alarm.
    expect(journal().some((e) => e.type === "spawn_failed")).toBe(false);
    expect(daemon.snapshot("w1")?.tasks[0]?.last_error).toBeUndefined();
    expect(daemon.snapshot("w1")?.open_decisions).toEqual([]);

    // done → retire: credentials revoked, retained records cleared, lock released.
    await pub(buildTopic(NS, ID, "result"), "result", "result", { summary: "ok" });
    await pub(buildTopic(NS, ID, "status"), "done", "status", { summary: "ok" });
    await until(() => journal().some((e) => e.type === "agent_retired"));
    // The cleared status/result payloads are kept in the journal.
    expect(journal().find((e) => e.type === "agent_retired")?.data).toMatchObject({
      agent_id: ID,
      status: "done",
      terminal: { summary: "ok" },
      result: { summary: "ok" },
    });
    // Retired only after its artifacts were verified; `[implement]` then ends at the gate.
    const order = journal().map((e) => e.type);
    expect(order.indexOf("artifact_verified")).toBeLessThan(order.indexOf("agent_retired"));
    await until(() => journal().some((e) => e.data.stage === "merge_ready"));
    const gated = (await env.retained("volley/_waves/w1/state")) as {
      payload: { gates: string[]; tasks: { evidence_path?: string }[] };
    };
    expect(gated.payload.gates).toEqual(["T1"]);
    expect(existsSync(gated.payload.tasks[0]?.evidence_path as string)).toBe(true);
    expect(creds.revoked).toEqual([ID]);
    expect(await env.retained(registryTopic(ID))).toBeNull();
    expect(await env.retained(buildTopic(NS, ID, "status"))).toBeNull();
    expect(await env.retained(buildTopic(NS, ID, "result"))).toBeNull();
    const lock = journal().find((e) => e.type === "agent_spawned")?.data.lock as string;
    expect(existsSync(lock)).toBe(false);

    // cleanup: dry run lists the worktree; --yes removes it with consent.
    const io = makeBufferIO();
    const worktree = join(env.home, "wt", "w1", "T1-implementer");
    expect(await cleanupWave(env.home, "w1", { yes: false, force: false }, io)).toBe(0);
    expect(io.readStdout()).toContain(`would remove ${worktree} and workspace(s) workspace:1`);
    const fx = fakeExec();
    expect(await cleanupWave(env.home, "w1", { yes: true, force: false, exec: fx.exec }, io)).toBe(
      0,
    );
    expect(fx.argvs()).toEqual([
      ["cmux", "close-workspace", "--workspace", "workspace:1"],
      ["git", "-C", repo, "worktree", "remove", worktree],
    ]);
  });

  it("cleanup skips worktrees whose agent is not retired", async () => {
    await setup();
    await until(() => journal().some((e) => e.type === "agent_registered"));
    const io = makeBufferIO();
    const fx = fakeExec();
    await cleanupWave(env.home, "w1", { yes: true, force: false, exec: fx.exec }, io);
    expect(fx.calls).toEqual([]);
    expect(io.readStdout()).toContain(`agent(s) not retired: ${ID}`);
  });

  it("reaped is not retired while the session comes back; reaped and quiet past the grace is", async () => {
    await setup();
    await until(() => journal().some((e) => e.type === "agent_registered"));
    const lock = journal().find((e) => e.type === "agent_spawned")?.data.lock as string;
    // An LWT from a network blip, then the MCP server reconnects with a fresh spawning.
    await pub(buildTopic(NS, ID, "status"), "reaped", "status", { reason: "lwt" });
    await new Promise((r) => setTimeout(r, 50));
    await pub(buildTopic(NS, ID, "status"), "spawning", "status", {});
    await new Promise((r) => setTimeout(r, 600));
    expect(journal().some((e) => e.type === "agent_retired")).toBe(false);
    expect(creds.revoked).toEqual([]);
    expect(existsSync(lock)).toBe(true);
    // Reaped for good: retired after the grace.
    await pub(buildTopic(NS, ID, "status"), "reaped", "status", { reason: "lwt" });
    await until(() => journal().some((e) => e.type === "agent_retired"));
    expect(journal().find((e) => e.type === "agent_retired")?.data).toMatchObject({
      agent_id: ID,
      status: "reaped",
      lock_released: true,
    });
  });

  it("an untrusted repo opens a published repo_untrusted decision; answering trust records it and spawns", async () => {
    await setup({ trusted: false });
    await until(() => journal().some((e) => e.type === "decision_opened"));
    const opened = journal().find((e) => e.type === "decision_opened");
    const id = opened?.data.decision_id as string;
    expect(opened?.data).toMatchObject({ kind: "repo_untrusted", repo });
    expect(host.launches).toHaveLength(0);
    const retained = (await env.retained(decisionTopic("w1", id))) as { payload: unknown };
    expect(retained.payload).toMatchObject({ kind: "repo_untrusted", task: "T1" });

    const r = await runCli(["resolve", id, "trust", "--by", "tester"], env.env);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(claudeJson, "utf-8")).projects[repo]).toEqual({
      hasTrustDialogAccepted: true,
    });
    await daemon.tick();
    await until(() => journal().some((e) => e.type === "agent_registered"));
    expect(host.launches).toHaveLength(1);
  });

  it("a repo_untrusted decision raised from a pane resolves on the next tick once the repo is trusted", async () => {
    await setup();
    await until(() => journal().some((e) => e.type === "agent_registered"));
    // As verify does on a trust-dialog screen: the task is past `queued`, so no spawn re-checks.
    const d = await daemon.openDecision("w1", {
      kind: "repo_untrusted",
      task: "T1",
      question: `Needs you: trust ${repo} for dispatch?`,
      id: trustDecisionId(repo),
    });
    expect(daemon.record("w1")?.state?.open_decisions).toEqual([d.decision_id]);
    await daemon.tick();
    const resolved = journal().find((e) => e.type === "decision_resolved");
    expect(resolved?.data).toMatchObject({
      decision_id: d.decision_id,
      answer: "trusted",
      by: "claude-trust-dialog",
    });
    expect(daemon.record("w1")?.state?.tasks[0]?.stage).toBe("implement");
  });

  it("stop interrupts the agent in its workspace; the kill switch refuses spawns", async () => {
    await setup();
    await until(() => journal().some((e) => e.type === "agent_registered"));
    expect((await runCli(["stop", "w1", "--by", "tester"], env.env)).exitCode).toBe(0);
    expect(host.keys).toContainEqual({ workspace: "workspace:1", key: "Escape" });
    expect((await runCli(["stop", "--all", "--by", "tester"], env.env)).exitCode).toBe(0);
    const r = await runCli(["spawn", "w1", "T1", "--json"], env.env);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).error).toContain("kill switch");
  });
});
