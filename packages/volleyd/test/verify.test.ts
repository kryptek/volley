import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import { type SpawnOutcome, spawnAgent } from "../src/spawn";
import { trustDecisionId } from "../src/trust";
import { sameModel, watchAgent } from "../src/verify";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { FIXTURES, type SpawnEnv, makeSpawnEnv } from "./helpers/fake-host";

const NS = "volleyd-test";

/** A PR #30 hook-shape fixture, re-addressed to `agentId`, with payload overrides. */
function hookFixture(name: string, agentId: string, payload: Record<string, unknown> = {}) {
  const env = JSON.parse(readFileSync(join(FIXTURES, "hooks", name), "utf-8"));
  env.agent_id = agentId;
  env.payload = { ...env.payload, ...payload };
  return JSON.stringify(env);
}

describe("verify through hook signals (Aedes)", () => {
  let broker: TestBroker;
  let daemonSide: VolleyBroker;
  let agentSide: VolleyBroker;
  let env: SpawnEnv;

  beforeEach(async () => {
    broker = await startTestBroker();
    daemonSide = new VolleyBroker();
    await daemonSide.connect({ url: broker.url, agentId: "volleyd" });
    agentSide = new VolleyBroker();
    await agentSide.connect({ url: broker.url, agentId: "agent-sim" });
  });

  afterEach(async () => {
    await env?.cleanup();
    await agentSide.disconnect();
    await daemonSide.disconnect();
    await broker.close();
  });

  /** What a real session does after launch: MCP auto-register, then the SessionStart hook. */
  async function sessionStart(
    agentId: string,
    opts: { registry?: string; model?: string; heartbeat?: boolean; hooks?: boolean } = {},
  ) {
    await agentSide.publish(registryTopic(agentId), hookFixture("registry-mcp.json", agentId), {
      qos: 1,
      retain: true,
    });
    if (opts.hooks === false) return;
    const reg = opts.registry ?? "registry-harness-hook.json";
    await agentSide.publish(
      registryTopic(agentId),
      hookFixture(reg, agentId, opts.model !== undefined ? { model: opts.model } : {}),
      { qos: 1, retain: true },
    );
    if (opts.heartbeat !== false) {
      await agentSide.publish(
        buildTopic(NS, agentId, "progress"),
        hookFixture("heartbeat-session-start.json", agentId),
        { qos: 0, retain: false },
      );
    }
  }

  async function spawnWith(
    onLaunch: (attempt: number) => Promise<void>,
    screens: (string | null)[] = [],
  ): Promise<SpawnOutcome> {
    env = await makeSpawnEnv({
      spawnTimeoutS: 0.5,
      watch: (ns, id) => watchAgent(daemonSide, ns, id),
    });
    env.host.screens = screens;
    let n = 0;
    env.host.onLaunch = () => {
      const attempt = ++n;
      // Like a real pane: the session starts a moment after the workspace opens.
      setTimeout(() => void onLaunch(attempt), 20);
    };
    const out = await spawnAgent(env.request(), env.deps);
    if (out.kind !== "launched") throw new Error(`expected a launch, got ${out.kind}`);
    const verified = await out.verified;
    await verified.watch.close();
    return verified;
  }

  const screen = (name: string) => readFileSync(join(FIXTURES, "screens", name), "utf-8");
  const types = () => env.events.map((e) => e.type);

  it("MCP registry → hooks registry (harness-hook) → SessionStart heartbeat: agent_registered, no screen read", async () => {
    const out = await spawnWith(() => sessionStart("w1-t1-implementer-1"));
    expect(out).toMatchObject({ kind: "registered", agentId: "w1-t1-implementer-1" });
    const reg = env.events.find((e) => e.type === "agent_registered");
    expect(reg?.data).toMatchObject({
      agent_id: "w1-t1-implementer-1",
      model: "claude-opus-5-5",
      model_source: "harness-hook",
      model_verified: true,
      screen_read: false,
    });
    expect(env.host.screenReads).toEqual([]);
    expect(types()).not.toContain("decision_opened");
  });

  it("the MCP server's own registration alone is not a verified spawn", async () => {
    const out = await spawnWith(
      () => sessionStart("w1-t1-implementer-1", { hooks: false }),
      [screen("shell-prompt.txt")],
    );
    expect(out).toMatchObject({ kind: "decision", decision: "unknown_screen" });
    expect(types()).not.toContain("agent_registered");
  });

  it("model ≠ wave model → model_switch decision (agent left running)", async () => {
    const out = await spawnWith(() =>
      sessionStart("w1-t1-implementer-1", { model: "claude-sonnet-5-5" }),
    );
    expect(out).toMatchObject({ kind: "decision", decision: "model_switch" });
    expect(env.events.find((e) => e.type === "agent_registered")?.data).toMatchObject({
      model: "claude-sonnet-5-5",
      expected_model: "claude-opus-5-5",
    });
    expect(env.events.find((e) => e.type === "decision_opened")?.data).toMatchObject({
      kind: "model_switch",
      model: "claude-sonnet-5-5",
    });
    expect(env.host.fake.argvs(["cmux", "close-workspace"])).toEqual([]);
  });

  it("an older version of the same family is a mismatch (claude-opus-5 ≠ claude-opus-5-5)", async () => {
    const out = await spawnWith(() =>
      sessionStart("w1-t1-implementer-1", { model: "claude-opus-5" }),
    );
    expect(out).toMatchObject({ kind: "decision", decision: "model_switch" });
    expect(env.events.find((e) => e.type === "decision_opened")?.data).toMatchObject({
      kind: "model_switch",
      model: "claude-opus-5",
      expected_model: "claude-opus-5-5",
    });
  });

  it("model_source unknown → a status line showing an older version is a mismatch", async () => {
    const out = await spawnWith(
      () => sessionStart("w1-t1-implementer-1", { registry: "registry-unknown.json" }),
      [screen("working.txt").replace(/Opus 5\.5/g, "Opus 5")],
    );
    expect(out).toMatchObject({ kind: "decision", decision: "model_switch" });
    expect(env.events.find((e) => e.type === "agent_registered")?.data).toMatchObject({
      model: "claude-opus-5",
      model_source: "unknown",
    });
  });

  it("model_source unknown → one readScreen; model_verified:false when unreadable", async () => {
    const out = await spawnWith(
      () => sessionStart("w1-t1-implementer-1", { registry: "registry-unknown.json" }),
      [null],
    );
    expect(out).toMatchObject({ kind: "registered", model: null, modelVerified: false });
    expect(env.host.screenReads).toHaveLength(1);
    expect(env.events.find((e) => e.type === "agent_registered")?.data).toMatchObject({
      model_source: "unknown",
      model_verified: false,
      screen_read: true,
    });
  });

  it("model_source unknown → the status line's model is used when readable", async () => {
    const out = await spawnWith(
      () => sessionStart("w1-t1-implementer-1", { registry: "registry-unknown.json" }),
      [screen("working.txt")],
    );
    expect(out).toMatchObject({
      kind: "registered",
      model: "claude-opus-5-5",
      modelVerified: true,
    });
    expect(env.host.screenReads).toHaveLength(1);
  });

  it("no SessionStart heartbeat + trust dialog on screen → repo_untrusted decision", async () => {
    const out = await spawnWith(async () => {}, [screen("trust-dialog.txt")]);
    expect(out).toMatchObject({ kind: "decision", decision: "repo_untrusted" });
    const d = env.events.find((e) => e.type === "decision_opened");
    expect(d?.data).toMatchObject({
      kind: "repo_untrusted",
      decision_id: trustDecisionId(env.repo),
    });
    const pointer = (d?.data.pointers as { screen?: string }).screen as string;
    expect(existsSync(pointer)).toBe(true);
    expect(env.host.keys).toEqual([]); // never auto-accepted
  });

  it("no SessionStart heartbeat + update prompt → Enter, then one relaunch (attempt+1, same lock)", async () => {
    const out = await spawnWith(
      async (attempt) => {
        if (attempt === 2) await sessionStart("w1-t1-implementer-2");
      },
      [screen("update-prompt.txt")],
    );
    expect(out).toMatchObject({ kind: "registered", agentId: "w1-t1-implementer-2" });
    expect(env.host.keys).toEqual([{ workspace: "workspace:1", key: "Enter" }]);
    expect(env.host.launches).toHaveLength(2);
    const spawned = env.events.filter((e) => e.type === "agent_spawned");
    expect(spawned.map((e) => e.data.agent_id)).toEqual([
      "w1-t1-implementer-1",
      "w1-t1-implementer-2",
    ]);
    expect(spawned[1]?.data).toMatchObject({
      attempt: 2,
      recovered_from: "w1-t1-implementer-1",
      recovery: "update_prompt",
      lock: spawned[0]?.data.lock,
    });
    // the first identity is revoked before the second is minted
    expect(env.host.fake.argvs(["volley", "auth"]).map((a) => `${a[2]} ${a[3]}`)).toEqual([
      "add-agent w1-t1-implementer-1",
      "rm-agent w1-t1-implementer-1",
      "add-agent w1-t1-implementer-2",
    ]);
    const agentJson = JSON.parse(
      readFileSync(join(env.worktree, ".volley", "agent.json"), "utf-8"),
    );
    expect(agentJson.agent_id).toBe("w1-t1-implementer-2");
  });

  it("relaunches only once: a second update prompt opens unknown_screen", async () => {
    const out = await spawnWith(async () => {}, [screen("update-prompt.txt")]);
    expect(out).toMatchObject({ kind: "decision", decision: "unknown_screen" });
    expect(env.host.launches).toHaveLength(2);
    expect(env.host.keys).toHaveLength(1);
  });

  it("an unknown screen → unknown_screen decision with the capture path", async () => {
    const out = await spawnWith(async () => {}, [screen("login.txt")]);
    expect(out).toMatchObject({ kind: "decision", decision: "unknown_screen" });
    const d = env.events.find((e) => e.type === "decision_opened");
    expect(d?.data).toMatchObject({ kind: "unknown_screen", screen_class: "login" });
    const pointer = (d?.data.pointers as { screen?: string }).screen as string;
    expect(readFileSync(pointer, "utf-8")).toBe(screen("login.txt"));
  });
});

describe("sameModel", () => {
  it("accepts dated ids and context suffixes", () => {
    expect(sameModel("claude-opus-5-5", "claude-opus-5-5")).toBe(true);
    expect(sameModel("claude-opus-5-5[1m]", "claude-opus-5-5")).toBe(true);
    expect(sameModel("claude-opus-5-5-20261001", "claude-opus-5-5")).toBe(true);
    expect(sameModel("claude-sonnet-5-5", "claude-opus-5-5")).toBe(false);
  });

  it("compares exact versions: a shorter or longer version is a different model", () => {
    expect(sameModel("claude-opus-5", "claude-opus-5-5")).toBe(false);
    expect(sameModel("claude-opus-5-5", "claude-opus-5")).toBe(false);
    expect(sameModel("claude-opus-5-5-1", "claude-opus-5-5")).toBe(false);
    expect(sameModel("claude-opus-5[1m]", "claude-opus-5-5")).toBe(false);
    expect(sameModel("claude-opus-5-20261001", "claude-opus-5-5")).toBe(false);
    expect(sameModel("claude-opus-5-5-20261001", "claude-opus-5-5-20260901")).toBe(true);
  });
});
