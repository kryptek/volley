import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import { cleanupWave } from "../src/commands/cleanup";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import type { Daemon } from "../src/daemon";
import { decisionTopic } from "../src/decisions";
import { makeBufferIO } from "../src/io";
import { readJournalFile } from "../src/journal";
import { trustDecisionId } from "../src/trust";
import type { JournalEvent } from "../src/types";
import { addWorktree } from "../src/worktree";
import { eventually } from "./helpers/broker-wait";
import { type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { type FakeClock, fakeClock } from "./helpers/fake-clock";
import { type MemoryCredentials, memoryCredentials } from "./helpers/fake-dynsec";
import { fakeExec } from "./helpers/fake-exec";
import { FIXTURES, type FakeHost, fakeHost } from "./helpers/fake-host";
import { type EventMatch, type JournalWait, journalWait } from "./helpers/journal-wait";
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
  /** The daemon's clock: reap graces and verification windows move only when the test says. */
  let clock: FakeClock;
  let waits: JournalWait;
  /** The simulated session's publishes (teardown waits for them). */
  const sessions = new Set<Promise<void>>();
  /** With `freshBase`: while true, `git fetch origin release/w1` fails (offline). */
  let fetchFails = false;

  const journal = (): JournalEvent[] =>
    readJournalFile(join(env.home, "waves", "w1", "journal.jsonl"));
  /** The n-th journal event matching `match`, awaited as the daemon appends it. */
  const event = (match: EventMatch, n = 1) => waits.event("w1", match, n);
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
  async function setup(
    o: {
      trusted?: boolean;
      /** Cut worktrees through the real release-base resolution (worktree.ts) on the fake exec. */
      freshBase?: boolean;
      /** Extra per-wave `config:` entries. */
      config?: string;
    } = {},
  ) {
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
    fake.on(["git", "-C", repo, "fetch"], () =>
      fetchFails ? { code: 128, stderr: "fatal: unable to access origin" } : {},
    );
    creds = memoryCredentials();
    host = fakeHost(fake);
    if (o.freshBase === true) {
      const prepare = host.prepareWorktree.bind(host);
      host.prepareWorktree = async (spec) => {
        const r = await addWorktree(fake.exec, spec);
        await prepare(spec);
        return r;
      };
    }
    // The launched session: MCP registers, the SessionStart hook re-publishes + heartbeats.
    host.onLaunch = () => {
      const session = (async () => {
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
      })();
      sessions.add(session);
      void session.finally(() => sessions.delete(session));
    };
    clock = fakeClock(Date.now());
    daemon = await env.start({
      clock,
      spawner: {
        host,
        claudeJsonPath: claudeJson,
        hooksDir: "/opt/volley-hooks",
        reapGraceMs: 300,
        credentials: creds,
      },
    });
    waits = journalWait(env.home, () => daemon);
    const wave = join(env.home, "w1.yaml");
    writeFileSync(
      wave,
      `wave: w1\nrepo: ${repo}\nrelease_branch: release/w1\nmodel: claude-opus-5-5\npipeline: [implement]\ntasks:\n  T1: { issue: 42 }\nconfig: { worktree_root: ${join(env.home, "wt")}${o.config !== undefined ? `, ${o.config}` : ""} }\n`,
    );
    const r = await runCli(["run", wave], env.env);
    expect(r.exitCode).toBe(0);
  }

  afterEach(async () => {
    fetchFails = false;
    await Promise.all([...sessions]);
    await agent.disconnect();
    await env.cleanup();
  });

  it("spawns the admitted implementer, verifies it through the hooks, refuses a second spawn, retires on done", async () => {
    await setup();
    await event("agent_registered");
    await waits.settled();
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
    await event("agent_retired");
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
    await event((e) => e.data.stage === "merge_ready");
    // The state that stage change published is on the broker once the daemon is idle.
    await waits.settled();
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

    // The retire closed its workspace; cleanup: dry run lists the worktree, --yes removes it.
    expect(host.closed).toEqual(["workspace:1"]);
    const io = makeBufferIO();
    const worktree = join(env.home, "wt", "w1", "T1-implementer");
    expect(await cleanupWave(env.home, "w1", { yes: false, force: false }, io)).toBe(0);
    expect(io.readStdout()).toContain(`would remove ${worktree}\n`);
    const fx = fakeExec();
    expect(await cleanupWave(env.home, "w1", { yes: true, force: false, exec: fx.exec }, io)).toBe(
      0,
    );
    expect(fx.argvs()).toEqual([["git", "-C", repo, "worktree", "remove", worktree]]);
  });

  it("a failed release-branch fetch refuses with BASE_STALE, backs off like any spawn failure, and the retry records base_sha", async () => {
    fetchFails = true;
    await setup({ freshBase: true });
    const failed = await event("spawn_failed");
    expect(failed?.data).toMatchObject({ code: "BASE_STALE", role: "implementer", attempt: 1 });
    expect(failed?.data.message).toContain("fatal: unable to access origin");
    expect(typeof failed?.data.next_retry_at).toBe("string");
    await waits.settled();
    expect(host.launches).toHaveLength(0);
    expect(daemon.snapshot("w1")?.tasks[0]).toMatchObject({
      stage: "queued",
      last_error: { code: "BASE_STALE" },
    });

    // The network is back: the backoff's retry fetches, cuts the worktree and records its base.
    fetchFails = false;
    await clock.advance(DAEMON_DEFAULTS.spawn_retry_base_ms);
    await daemon.tick();
    const spawned = await event("agent_spawned");
    expect(spawned?.data.base_sha).toBe("1".repeat(40));
    await event("agent_registered");
    await waits.settled();
    expect(daemon.snapshot("w1")?.tasks[0]?.base_sha).toBe("1".repeat(40));
    const state = (await env.retained("volley/_waves/w1/state")) as {
      payload: { tasks: { base_sha?: string }[] };
    };
    expect(state.payload.tasks[0]?.base_sha).toBe("1".repeat(40));
  });

  it("require_fresh_base off: a failed fetch spawns from the local copy and journals a BASE_STALE warning", async () => {
    fetchFails = true;
    await setup({ freshBase: true, config: "require_fresh_base: false" });
    const spawned = await event("agent_spawned");
    expect(spawned?.data.base_sha).toBe("1".repeat(40));
    await event("agent_registered");
    await waits.settled();
    expect(journal().some((e) => e.type === "spawn_failed")).toBe(false);
    const warning = journal().find(
      (e) => e.type === "alarm_raised" && e.data.code === "BASE_STALE",
    );
    expect(warning?.data).toMatchObject({
      code: "BASE_STALE",
      severity: "warning",
      role: "implementer",
      base_sha: "1".repeat(40),
      fetch_error: "fatal: unable to access origin",
    });
  });

  it("cleanup skips worktrees whose agent is not retired", async () => {
    await setup();
    await event("agent_registered");
    await waits.settled();
    const io = makeBufferIO();
    const fx = fakeExec();
    await cleanupWave(env.home, "w1", { yes: true, force: false, exec: fx.exec }, io);
    expect(fx.calls).toEqual([]);
    expect(io.readStdout()).toContain(`agent(s) not retired: ${ID}`);
  });

  it("reaped is not retired while the session comes back; reaped and quiet past the grace is", async () => {
    await setup();
    await event("agent_registered");
    await waits.settled();
    const lock = journal().find((e) => e.type === "agent_spawned")?.data.lock as string;
    // An LWT from a network blip: the reap is held for its grace (300 ms on the daemon's clock).
    await pub(buildTopic(NS, ID, "status"), "reaped", "status", { reason: "lwt" });
    await clock.armed(300);
    const held = clock.pending();
    // Then the MCP server reconnects with a fresh spawning: the held reap is dropped.
    await pub(buildTopic(NS, ID, "status"), "spawning", "status", {});
    await eventually(() => clock.pending() < held);
    await clock.advance(600); // two graces
    await waits.settled();
    expect(journal().some((e) => e.type === "agent_retired")).toBe(false);
    expect(creds.revoked).toEqual([]);
    expect(existsSync(lock)).toBe(true);
    // Reaped for good: retired after the grace.
    await pub(buildTopic(NS, ID, "status"), "reaped", "status", { reason: "lwt" });
    await clock.armed(300);
    await clock.advance(300);
    await event("agent_retired");
    expect(journal().find((e) => e.type === "agent_retired")?.data).toMatchObject({
      agent_id: ID,
      status: "reaped",
      lock_released: true,
    });
  });

  it("an untrusted repo opens a published repo_untrusted decision; answering trust records it and spawns", async () => {
    await setup({ trusted: false });
    const opened = await event("decision_opened");
    await waits.settled();
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
    await event("agent_registered");
    expect(host.launches).toHaveLength(1);
  });

  it("a repo_untrusted decision raised from a pane resolves on the next tick once the repo is trusted", async () => {
    await setup();
    await event("agent_registered");
    await waits.settled();
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
    await event("agent_registered");
    await waits.settled();
    expect((await runCli(["stop", "w1", "--by", "tester"], env.env)).exitCode).toBe(0);
    expect(host.keys).toContainEqual({ workspace: "workspace:1", key: "Escape" });
    expect((await runCli(["stop", "--all", "--by", "tester"], env.env)).exitCode).toBe(0);
    const r = await runCli(["spawn", "w1", "T1", "--json"], env.env);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).error).toContain("kill switch");
  });
});
