import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import { cleanupPlan } from "../src/commands/cleanup";
import { Journal } from "../src/journal";
import { LAUNCH_COMMAND } from "../src/launch";
import { retainedTopics } from "../src/retire";
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
    opts: {
      registry?: string;
      model?: string;
      heartbeat?: boolean;
      hooks?: boolean;
      /** false: the agent's MCP server is not on this broker (version skew, wrong broker). */
      mcp?: boolean;
    } = {},
  ) {
    if (opts.mcp !== false) {
      // volley-mcp's lifecycle: the retained `spawning` status, before its own registration.
      await agentSide.publish(
        buildTopic(NS, agentId, "status"),
        hookFixture("status-spawning.json", agentId),
        { qos: 1, retain: true },
      );
    }
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

  it("hooks register + heartbeat but no MCP status on this broker → mcp_not_registered, verify_failed", async () => {
    const out = await spawnWith(() => sessionStart("w1-t1-implementer-1", { mcp: false }));
    expect(out).toMatchObject({ kind: "decision", decision: "mcp_not_registered" });
    expect(types()).not.toContain("agent_registered");
    const failed = env.events.find((e) => e.type === "verify_failed");
    expect(failed?.data).toMatchObject({
      agent_id: "w1-t1-implementer-1",
      reason: "mcp_not_registered",
    });
    const d = env.events.find((e) => e.type === "decision_opened");
    expect(d?.task).toBe("T1");
    expect(d?.data).toMatchObject({ kind: "mcp_not_registered", agent_id: "w1-t1-implementer-1" });
    expect(d?.data.question).toContain("MCP server is not on this broker");
    expect(d?.data.question).toContain(".volley/mcp.json");
    // the agent itself is running (its hooks verified): no screen read, nothing typed
    expect(env.host.screenReads).toEqual([]);
    expect(env.host.texts).toEqual([]);
  });

  it("the MCP status arriving after the hooks (same window) still verifies", async () => {
    const out = await spawnWith(async () => {
      await sessionStart("w1-t1-implementer-1", { mcp: false });
      await new Promise((r) => setTimeout(r, 100));
      await agentSide.publish(
        buildTopic(NS, "w1-t1-implementer-1", "status"),
        hookFixture("status-spawning.json", "w1-t1-implementer-1", {}),
        { qos: 1, retain: true },
      );
    });
    expect(out).toMatchObject({ kind: "registered" });
    expect(types()).not.toContain("verify_failed");
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

  it("no SessionStart heartbeat + update prompt → Enter, then one relaunch typed into the same workspace (attempt+1, same lock)", async () => {
    env = await makeSpawnEnv({
      spawnTimeoutS: 0.5,
      watch: (ns, id) => watchAgent(daemonSide, ns, id),
    });
    env.host.screens = [screen("update-prompt.txt"), screen("shell-prompt.txt")];
    // The retyped launch command starts the second attempt's session in the same pane.
    const typeText = env.host.sendText;
    env.host.sendText = async (ws, text) => {
      await typeText(ws, text);
      setTimeout(() => void sessionStart("w1-t1-implementer-2"), 20);
    };
    const launched = await spawnAgent(env.request(), env.deps);
    if (launched.kind !== "launched") throw new Error("expected a launch");
    const out = await launched.verified;
    await out.watch.close();
    expect(out).toMatchObject({ kind: "registered", agentId: "w1-t1-implementer-2" });
    // Never a second workspace in the same worktree: the launch command is typed into it.
    expect(env.host.launches).toHaveLength(1);
    expect(env.host.keys).toEqual([
      { workspace: "workspace:1", key: "Enter" },
      { workspace: "workspace:1", key: "Enter" },
    ]);
    expect(env.host.texts).toEqual([{ workspace: "workspace:1", text: LAUNCH_COMMAND }]);
    const spawned = env.events.filter((e) => e.type === "agent_spawned");
    expect(spawned.map((e) => e.data.agent_id)).toEqual([
      "w1-t1-implementer-1",
      "w1-t1-implementer-2",
    ]);
    expect(spawned[1]?.data).toMatchObject({
      attempt: 2,
      workspace: "workspace:1",
      recovered_from: "w1-t1-implementer-1",
      recovery: "update_prompt",
      lock: spawned[0]?.data.lock,
    });
    // the first identity is revoked before the second is minted, and journaled as retired
    expect(env.creds.minted).toEqual(["w1-t1-implementer-1", "w1-t1-implementer-2"]);
    expect(env.creds.revoked).toEqual(["w1-t1-implementer-1"]);
    expect(env.events.find((e) => e.type === "agent_retired")?.data).toMatchObject({
      agent_id: "w1-t1-implementer-1",
      status: "superseded",
      credentials_revoked: true,
      lock_released: false,
    });
    expect(env.cleared).toEqual(retainedTopics(NS, "w1-t1-implementer-1"));
    // cleanup sees only the second attempt as live, and nothing once it is retired too.
    const j = Journal.open(join(env.home, "waves", "w1"));
    j.append({ type: "wave_submitted", data: { wave: env.wave } });
    for (const e of env.events) j.append(e);
    expect(cleanupPlan(env.home, "w1").targets[0]?.live).toEqual(["w1-t1-implementer-2"]);
    j.append({
      type: "agent_retired",
      task: "T1",
      data: { agent_id: "w1-t1-implementer-2", role: "implementer", status: "done" },
    });
    expect(cleanupPlan(env.home, "w1").targets[0]?.live).toEqual([]);
    const agentJson = JSON.parse(
      readFileSync(join(env.worktree, ".volley", "agent.json"), "utf-8"),
    );
    expect(agentJson.agent_id).toBe("w1-t1-implementer-2");
  });

  it("after Enter the original launch may continue: its hook signals verify it, no relaunch", async () => {
    env = await makeSpawnEnv({
      spawnTimeoutS: 0.3,
      watch: (ns, id) => watchAgent(daemonSide, ns, id),
    });
    env.host.screens = [screen("update-prompt.txt")];
    const orig = env.host.sendKeys;
    env.host.sendKeys = async (ws, key) => {
      await orig(ws, key);
      setTimeout(() => void sessionStart("w1-t1-implementer-1"), 10);
    };
    const out = await spawnAgent(env.request(), env.deps);
    if (out.kind !== "launched") throw new Error("expected a launch");
    const verified = await out.verified;
    await verified.watch.close();
    expect(verified).toMatchObject({ kind: "registered", agentId: "w1-t1-implementer-1" });
    expect(env.host.launches).toHaveLength(1);
    expect(env.host.texts).toEqual([]);
    expect(env.events.filter((e) => e.type === "agent_spawned")).toHaveLength(1);
  });

  it("after Enter a screen that is not a bare shell is never typed into; a second timeout opens unknown_screen", async () => {
    const out = await spawnWith(async () => {}, [screen("update-prompt.txt")]);
    expect(out).toMatchObject({ kind: "decision", decision: "unknown_screen" });
    expect(env.host.launches).toHaveLength(1);
    expect(env.host.texts).toEqual([]);
    expect(env.host.keys).toHaveLength(1);
  });

  it("a failing Enter releases the lock, closes the watch and journals the refusal", async () => {
    let closed = 0;
    env = await makeSpawnEnv({
      spawnTimeoutS: 0.2,
      watch: async (ns, id) => {
        const w = await watchAgent(daemonSide, ns, id);
        const close = w.close;
        return {
          ...w,
          state: w.state,
          close: async () => {
            closed++;
            await close();
          },
        };
      },
    });
    env.host.screens = [screen("update-prompt.txt")];
    env.host.sendKeys = async () => {
      throw new Error("cmux: socket timeout");
    };
    const out = await spawnAgent(env.request(), env.deps);
    if (out.kind !== "launched") throw new Error("expected a launch");
    await expect(out.verified).rejects.toThrow("socket timeout");
    expect(existsSync(out.lock.path)).toBe(false);
    expect(closed).toBeGreaterThan(0);
    expect(env.events.at(-1)).toMatchObject({ type: "alarm_raised" });
  });

  it("an unknown screen → unknown_screen decision with the capture path", async () => {
    const out = await spawnWith(async () => {}, [screen("login.txt")]);
    expect(out).toMatchObject({ kind: "decision", decision: "unknown_screen" });
    const d = env.events.find((e) => e.type === "decision_opened");
    expect(d?.data).toMatchObject({ kind: "unknown_screen", screen_class: "login" });
    const pointer = (d?.data.pointers as { screen?: string }).screen as string;
    expect(readFileSync(pointer, "utf-8")).toBe(screen("login.txt"));
  });

  /** What volley-hooks writes when the broker refuses its CONNECT (runHook's AUTH_FAILED path). */
  const writeHooksError = (at: string, username: string | null) =>
    writeFileSync(
      join(env.worktree, ".volley", "hooks-error.json"),
      `${JSON.stringify({ code: "AUTH_FAILED", at, hook_event: "SessionStart", username })}\n`,
    );

  it("hooks-error.json at the timeout → hooks_auth_failed decision with the username, no screen read", async () => {
    const out = await spawnWith(
      async () => writeHooksError(new Date().toISOString(), "w1-t1-implementer-1"),
      [screen("working.txt")],
    );
    expect(out).toMatchObject({ kind: "decision", decision: "hooks_auth_failed" });
    expect(env.host.screenReads).toEqual([]);
    const d = env.events.find((e) => e.type === "decision_opened");
    expect(d?.data).toMatchObject({
      kind: "hooks_auth_failed",
      agent_id: "w1-t1-implementer-1",
      username: "w1-t1-implementer-1",
    });
    expect(d?.data.question).toContain("AUTH_FAILED");
    expect(types()).not.toContain("agent_registered");
  });

  it("a hooks-error.json older than the launch is stale: the screen is classified as before", async () => {
    const out = await spawnWith(
      async () => writeHooksError(new Date(Date.now() - 3_600_000).toISOString(), "old-user"),
      [screen("login.txt")],
    );
    expect(out).toMatchObject({ kind: "decision", decision: "unknown_screen" });
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
