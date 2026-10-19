import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import type { Daemon } from "../src/daemon";
import { type DecisionRecord, openEvent, resolveEvent } from "../src/decisions";
import { agentIdFor } from "../src/identity";
import { readJournalFile } from "../src/journal";
import { retainedTopics } from "../src/retire";
import type { JournalEvent } from "../src/types";
import { type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { type FakeClock, fakeClock } from "./helpers/fake-clock";
import { fakeExec } from "./helpers/fake-exec";
import { FIXTURES, type FakeHost, fakeHost } from "./helpers/fake-host";
import { type EventMatch, type JournalWait, journalWait } from "./helpers/journal-wait";
import { type Harness, pipelineHarness, sha } from "./helpers/pipeline-harness";
import { runCli } from "./helpers/run-cli";

/**
 * Relaunch is real: a spawn-type decision (hooks_auth_failed, mcp_not_registered) carries the
 * pipeline marker of the run it is about, and `relaunch` retires that agent through the delete
 * path (retained records cleared, login deleted, lock released), mints a new login and spawns
 * the same role at attempt + 1; `cancel` retires it and blocks the task with the decision text.
 */

const A1 = "w1-t1-implementer-1";
const A2 = "w1-t1-implementer-2";

describe("relaunch of a spawn-type decision", () => {
  let env: DaemonEnv;
  let agent: VolleyBroker;
  let host: FakeHost;
  let daemon: Daemon;
  let clock: FakeClock;
  let waits: JournalWait;
  const sessions = new Set<Promise<void>>();

  const journal = (): JournalEvent[] =>
    readJournalFile(join(env.home, "waves", "w1", "journal.jsonl"));
  const event = (match: EventMatch, n = 1) => waits.event("w1", match, n);
  const pub = (
    id: string,
    topic: string,
    type: string,
    channel: string,
    payload: unknown,
    retain = true,
  ) =>
    agent.publish(
      topic,
      JSON.stringify({
        ...buildEnvelope({ agentId: id, parentId: "volleyd", channel, type, payload }),
        ...(channel === "_system/registry" ? { namespace: NS } : {}),
      }),
      { qos: 1, retain },
    );
  const registry = (id: string) =>
    pub(id, registryTopic(id), "registered", "_system/registry", {
      capabilities: [],
      cwd: "/wt",
      started_at: new Date().toISOString(),
      model: "claude-opus-5-5",
      model_source: "harness-hook",
    });
  const heartbeat = (id: string) =>
    pub(
      id,
      buildTopic(NS, id, "progress"),
      "heartbeat",
      "progress",
      { source: "harness-hook", seq: 1, hook_event: "SessionStart" },
      false,
    );

  /**
   * w1 (one task, [implement]) on a fake host and a fake clock. The first launch fails as
   * `first` says; every later launch registers normally.
   */
  async function setup(first: "auth" | "mcp") {
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
    host = fakeHost(fake);
    let launches = 0;
    host.onLaunch = (spec) => {
      const n = ++launches;
      const id = `w1-t1-implementer-${n}`;
      const session = (async () => {
        if (n === 1 && first === "auth") {
          // The MCP server got in (its retained status), the hooks were refused.
          await pub(id, buildTopic(NS, id, "capability"), "capability", "capability", {
            tools: [],
          });
          mkdirSync(join(spec.cwd, ".volley"), { recursive: true });
          writeFileSync(
            join(spec.cwd, ".volley", "hooks-error.json"),
            `${JSON.stringify({ code: "AUTH_FAILED", at: new Date().toISOString(), hook_event: "SessionStart", username: id })}\n`,
          );
          return;
        }
        if (n === 1 && first === "mcp") {
          // The hooks registered; the agent's MCP server never published a status.
          await registry(id);
          await heartbeat(id);
          return;
        }
        await pub(id, buildTopic(NS, id, "status"), "spawning", "status", {});
        await registry(id);
        await pub(id, buildTopic(NS, id, "status"), "working", "status", {
          source: "harness-hook",
        });
        await heartbeat(id);
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
      },
    });
    waits = journalWait(env.home, () => daemon);
    const wave = join(env.home, "w1.yaml");
    writeFileSync(
      wave,
      `wave: w1\nrepo: ${repo}\nrelease_branch: release/w1\nmodel: claude-opus-5-5\npipeline: [implement]\ntasks:\n  T1: { issue: 42 }\nconfig: { worktree_root: ${join(env.home, "wt")}, spawn_timeout_s: 10 }\n`,
    );
    expect((await runCli(["run", wave], env.env)).exitCode).toBe(0);
    await event((e) => e.type === "agent_spawned" && e.data.agent_id === A1);
    // The spawn's verification window (spawn_timeout_s) runs on the daemon's clock.
    await clock.armed(10_000);
    await clock.advance(10_000);
    const opened = await event("decision_opened");
    await waits.settled();
    return opened;
  }

  afterEach(async () => {
    await Promise.all([...sessions]);
    await agent.disconnect();
    await env.cleanup();
  });

  const resolve = async (id: string, answer: string) => {
    const r = await runCli(["resolve", id, answer, "--wave", "w1", "--by", "tester"], env.env);
    expect(r.exitCode, r.stderr).toBe(0);
  };

  it("hooks_auth_failed: marked decision, the agent paused; relaunch retires it and spawns attempt 2", async () => {
    const opened = await setup("auth");
    expect(opened.data).toMatchObject({
      kind: "hooks_auth_failed",
      agent_id: A1,
      pipeline: {
        on: "relaunch",
        wave: "w1",
        task: "T1",
        role: "implementer",
        attempt: 1,
        agent_id: A1,
      },
      options: ["relaunch", "cancel"],
    });
    // No by-hand credential edits are asked of anyone.
    expect(String(opened.data.question)).not.toMatch(/volley auth add-agent|agent\.json/);
    // Paused at once: Escape in its workspace and a steering that says why.
    expect(host.keys).toContainEqual({ workspace: "workspace:1", key: "Escape" });
    const steer = journal().find(
      (e) =>
        e.type === "steering_sent" && e.data.agent_id === A1 && e.data.reason === "auth_failed",
    );
    expect(steer?.data.text).toMatch(/stop: your broker login is being repaired/);

    await resolve(opened.data.decision_id as string, "relaunch");
    const relaunched = await event("relaunched");
    expect(relaunched.data).toEqual({
      from_agent: A1,
      to_agent: A2,
      role: "implementer",
      attempt: 2,
    });
    // The failed agent went through the delete path: login deleted, records cleared, retired.
    const retired = await event((e) => e.type === "agent_retired" && e.data.agent_id === A1);
    expect(retired.data).toMatchObject({
      status: "relaunched",
      credentials_revoked: true,
      lock_released: true,
    });
    expect(host.fake.argvs(["volley", "auth", "rm-agent", A1])).toHaveLength(1);
    for (const topic of retainedTopics(NS, A1)) expect(await env.retained(topic)).toBeNull();
    // A new login for attempt 2, the same role spawned again, and it registers.
    await event((e) => e.type === "agent_registered" && e.data.agent_id === A2);
    expect(host.fake.argvs(["volley", "auth", "add-agent", A2])).toHaveLength(1);
    const spawned = journal().find((e) => e.type === "agent_spawned" && e.data.agent_id === A2);
    expect(spawned?.data).toMatchObject({ role: "implementer", attempt: 2 });
    const types = journal().map((e) => e.type);
    expect(types.indexOf("agent_retired")).toBeLessThan(
      types.findIndex((t, i) => t === "agent_spawned" && journal()[i]?.data.agent_id === A2),
    );
    await waits.settled();
    const state = daemon.snapshot("w1");
    expect(state?.tasks[0]).toMatchObject({ stage: "implement", agents: { implementer: A2 } });
  });

  it("hooks_auth_failed: cancel retires the agent and blocks the task with the decision text", async () => {
    const opened = await setup("auth");
    await resolve(opened.data.decision_id as string, "cancel");
    await event((e) => e.type === "agent_retired" && e.data.agent_id === A1);
    const blocked = await event((e) => e.type === "stage_entered" && e.data.stage === "blocked");
    expect(blocked.data.why).toContain(String(opened.data.question));
    await waits.settled();
    const t = daemon.snapshot("w1")?.tasks[0];
    expect(t?.stage).toBe("blocked");
    expect(t?.why_waiting).toContain("AUTH_FAILED");
    expect(journal().some((e) => e.type === "relaunched")).toBe(false);
    expect(host.launches).toHaveLength(1);
  });

  it("mcp_not_registered: the same marker, and relaunch spawns attempt 2", async () => {
    const opened = await setup("mcp");
    expect(opened.data).toMatchObject({
      kind: "mcp_not_registered",
      pipeline: { on: "relaunch", role: "implementer", attempt: 1, agent_id: A1 },
    });
    // Only an auth failure pauses the agent: this one's hooks reach the broker.
    expect(host.keys).not.toContainEqual({ workspace: "workspace:1", key: "Escape" });
    await resolve(opened.data.decision_id as string, "relaunch");
    expect((await event("relaunched")).data).toMatchObject({ from_agent: A1, to_agent: A2 });
    await event((e) => e.type === "agent_registered" && e.data.agent_id === A2);
    for (const topic of retainedTopics(NS, A1)) expect(await env.retained(topic)).toBeNull();
    await waits.settled();
    expect(daemon.snapshot("w1")?.open_decisions).toEqual([]);
  });

  // S5 (#95) owns `reaped`-on-delete; this base has no S5 yet. Its integration fills this in.
  it.todo("publishes reaped for <role>-1 through the S5 delete path once S5 lands");
});

describe("relaunch of a pipeline role (the review stage continues)", () => {
  let h: Harness;
  afterEach(() => h?.cleanup());
  const review = (name: string): unknown =>
    JSON.parse(readFileSync(join(FIXTURES, "review-results", `${name}.json`), "utf-8"));

  it("a spec reviewer refused by the broker is replaced by attempt 2 at the same head", async () => {
    const H1 = sha(0x1001);
    h = pipelineHarness();
    await h.start();
    h.openPr(H1);
    await h.finish("implementer", { head: H1, ci: "green" });
    const spec1 = h.run("spec_reviewer")?.agent_id as string;
    // What spawn.ts opens when the reviewer's hooks are refused.
    const r = openEvent(
      h.record(),
      {
        kind: "hooks_auth_failed",
        task: "T1",
        question: "the broker refused its hooks",
        options: ["relaunch", "cancel"],
      },
      new Date(),
    );
    if ("error" in r) throw new Error(r.error);
    await h.journal({
      ...r.event,
      data: {
        ...r.event.data,
        agent_id: spec1,
        pipeline: {
          on: "relaunch",
          wave: "w1",
          task: "T1",
          role: "spec_reviewer",
          attempt: 1,
          agent_id: spec1,
        },
      },
    });
    // The answer is journaled, and a tick runs before the pipeline handles it: the old run is
    // kept until it is retired, so nothing spawns beside it.
    const ans = resolveEvent(h.record(), r.id, { answer: "relaunch", by: "coord-1" }, new Date());
    if (!("event" in ans)) throw new Error("cannot resolve");
    await h.journal(ans.event);
    await h.tick();
    expect(h.spawns.filter((s) => s.role === "spec_reviewer")).toHaveLength(1);
    await h.driver.handle("T1", {
      kind: "decision_resolved",
      decision: h.record().decisions[r.id] as DecisionRecord,
    });
    await h.driver.settled();
    expect(h.retired).toContainEqual({ agent_id: spec1, status: "relaunched" });
    const spec2 = agentIdFor("w1", "T1", "spec_reviewer", 2);
    expect(h.events.find((e) => e.type === "relaunched")?.data).toEqual({
      from_agent: spec1,
      to_agent: spec2,
      role: "spec_reviewer",
      attempt: 2,
    });
    const specs = h.spawns.filter((s) => s.role === "spec_reviewer");
    expect(specs.map((s) => s.agent_id)).toEqual([spec1, spec2]);
    expect(specs[1]?.start).toEqual({ ref: H1, detach: true });
    // The new reviewer's result counts; with both reviews in, the fixup runs.
    await h.finish("spec_reviewer", { result: review("spec-p1") });
    await h.finish("quality_reviewer", { result: review("quality-p1-elsewhere") });
    expect(h.spawns.some((s) => s.role === "fixup")).toBe(true);
  });
});
