import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import { cleanupWave } from "../src/commands/cleanup";
import { makeBufferIO } from "../src/io";
import { readJournalFile } from "../src/journal";
import type { JournalEvent } from "../src/types";
import { type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { fakeExec } from "./helpers/fake-exec";
import { FIXTURES, type FakeHost, fakeHost } from "./helpers/fake-host";
import { runCli } from "./helpers/run-cli";

const ID = "w1-t1-implementer-1";

describe("daemon spawn loop", () => {
  let env: DaemonEnv;
  let agent: VolleyBroker;
  let host: FakeHost;
  let repo: string;

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

  beforeEach(async () => {
    env = await makeDaemonEnv();
    repo = realpathSync(env.home);
    repo = join(repo, "repo");
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
    // The launched session: MCP registers, the SessionStart hook re-publishes + heartbeats.
    host.onLaunch = () => {
      setTimeout(async () => {
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
    await env.start({
      spawner: { host, claudeJsonPath: claudeJson, hooksDir: "/opt/volley-hooks" },
    });
    const wave = join(env.home, "w1.yaml");
    writeFileSync(
      wave,
      `wave: w1\nrepo: ${repo}\nrelease_branch: release/w1\nmodel: claude-opus-5-5\npipeline: [implement]\ntasks:\n  T1: { issue: 42 }\nconfig: { worktree_root: ${join(env.home, "wt")} }\n`,
    );
    const r = await runCli(["run", wave], env.env);
    expect(r.exitCode).toBe(0);
  });

  afterEach(async () => {
    await agent.disconnect();
    await env.cleanup();
  });

  it("spawns the admitted implementer, verifies it through the hooks, refuses a second spawn, retires on done", async () => {
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

    // done → retire: credentials revoked, retained records cleared, lock released.
    await pub(buildTopic(NS, ID, "result"), "result", "result", { summary: "ok" });
    await pub(buildTopic(NS, ID, "status"), "done", "status", { summary: "ok" });
    await until(() => journal().some((e) => e.type === "agent_retired"));
    expect(host.fake.argvs(["volley", "auth", "rm-agent"])).toEqual([
      ["volley", "auth", "rm-agent", ID],
    ]);
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
    await until(() => journal().some((e) => e.type === "agent_registered"));
    const io = makeBufferIO();
    const fx = fakeExec();
    await cleanupWave(env.home, "w1", { yes: true, force: false, exec: fx.exec }, io);
    expect(fx.calls).toEqual([]);
    expect(io.readStdout()).toContain(`agent(s) not retired: ${ID}`);
  });
});
