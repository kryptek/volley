import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import { addAccount, profileDir } from "../src/claude/profiles";
import { cleanupPlan, readWave } from "../src/commands/cleanup";
import { Journal } from "../src/journal";
import { LAUNCH_COMMAND } from "../src/launch";
import { retainedTopics } from "../src/retire";
import { lastOutputNote } from "../src/screens";
import { type SpawnOutcome, spawnAgent } from "../src/spawn";
import { trustDecisionId } from "../src/trust";
import { sameModel, watchAgent } from "../src/verify";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { type FakeClock, fakeClock } from "./helpers/fake-clock";
import { FIXTURES, type SpawnEnv, makeSpawnEnv } from "./helpers/fake-host";
import { stubEnv } from "./helpers/with-env";

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
  /** The verification window and the relaunch settle time run on it. */
  let clock: FakeClock;
  /** The simulated sessions' publishes, in flight or done. */
  let sessions: Promise<void>[];
  const run = (session: Promise<void>) => {
    sessions.push(session);
  };
  const watch = (ns: string, id: string) => watchAgent(daemonSide, ns, id, clock);

  /**
   * Every agent-side publish so far has reached the daemon side: a sentinel the agent side sends
   * now arrives behind them on the daemon side's connection.
   */
  async function delivered(): Promise<void> {
    const topic = `volley/${NS}/test-barrier/progress`;
    const token = randomUUID();
    let back!: () => void;
    const got = new Promise<void>((r) => {
      back = r;
    });
    const unsub = await daemonSide.subscribeStream(topic, ({ payload }) => {
      if (payload === token) back();
    });
    await agentSide.publish(topic, token, { qos: 1, retain: false });
    await got;
    await unsub();
  }

  /**
   * Settle a spawn's verification on the fake clock: whatever the simulated session publishes is
   * read first, and only then does the window (or the next timer: the relaunch settle) run out.
   */
  async function drive<T>(verified: Promise<T>): Promise<T> {
    let done = false;
    const out = verified.finally(() => {
      done = true;
    });
    const quiet = out.then(
      () => {},
      () => {},
    );
    while (!done) {
      const started = sessions.length;
      await Promise.all(sessions);
      await delivered();
      await Promise.race([quiet, clock.armed()]);
      if (done) break;
      // A session started meanwhile (a relaunch) publishes before any window runs out.
      if (sessions.length !== started) continue;
      await clock.advanceToNext();
    }
    return out;
  }

  beforeEach(async () => {
    clock = fakeClock();
    sessions = [];
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
    env = await makeSpawnEnv({ spawnTimeoutS: 0.5, watch });
    env.host.screens = screens;
    let n = 0;
    // Like a real pane: the session starts once the workspace is open.
    env.host.onLaunch = () => run(onLaunch(++n));
    const out = await spawnAgent(env.request(), env.deps);
    if (out.kind !== "launched") throw new Error(`expected a launch, got ${out.kind}`);
    const verified = await drive(out.verified);
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
      decision_id: trustDecisionId("w1", env.repo),
    });
    const pointer = (d?.data.pointers as { screen?: string }).screen as string;
    expect(existsSync(pointer)).toBe(true);
    expect(env.host.keys).toEqual([]); // never auto-accepted
  });

  it("no SessionStart heartbeat + update prompt → Enter, then one relaunch typed into the same workspace (attempt+1, same lock)", async () => {
    env = await makeSpawnEnv({ spawnTimeoutS: 0.5, watch });
    env.host.screens = [screen("update-prompt.txt"), screen("shell-prompt.txt")];
    // The retyped launch command starts the second attempt's session in the same pane.
    const typeText = env.host.sendText;
    env.host.sendText = async (ws, text) => {
      await typeText(ws, text);
      run(sessionStart("w1-t1-implementer-2"));
    };
    const launched = await spawnAgent(env.request(), env.deps);
    if (launched.kind !== "launched") throw new Error("expected a launch");
    const out = await drive(launched.verified);
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
    // Through the delete path: `reaped { credentials_deleted }` first, the records cleared
    // before the delete and again after it.
    expect(env.published.map((p) => [p.topic, JSON.parse(p.payload).type])).toEqual([
      [buildTopic(NS, "w1-t1-implementer-1", "status"), "reaped"],
    ]);
    expect(env.cleared).toEqual([
      ...retainedTopics(NS, "w1-t1-implementer-1"),
      ...retainedTopics(NS, "w1-t1-implementer-1"),
    ]);
    expect(env.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["agent_reaped_by_supervisor", "credentials_revoked"]),
    );
    // cleanup sees only the second attempt as live, and nothing once it is retired too.
    // --all: T1 is unfinished, which alone would hold its worktree back.
    const planAll = (home: string) => {
      const { state, events } = readWave(home, "w1");
      return cleanupPlan(state, events, { all: true });
    };
    const j = Journal.open(join(env.home, "waves", "w1"));
    j.append({ type: "wave_submitted", data: { wave: env.wave } });
    for (const e of env.events) j.append(e);
    expect(planAll(env.home).targets[0]?.live).toEqual(["w1-t1-implementer-2"]);
    j.append({
      type: "agent_retired",
      task: "T1",
      data: { agent_id: "w1-t1-implementer-2", role: "implementer", status: "done" },
    });
    expect(planAll(env.home).targets[0]?.live).toEqual([]);
    const agentJson = JSON.parse(
      readFileSync(join(env.worktree, ".volley", "agent.json"), "utf-8"),
    );
    expect(agentJson.agent_id).toBe("w1-t1-implementer-2");
  });

  it("after Enter the original launch may continue: its hook signals verify it, no relaunch", async () => {
    env = await makeSpawnEnv({ spawnTimeoutS: 0.3, watch });
    env.host.screens = [screen("update-prompt.txt")];
    const orig = env.host.sendKeys;
    env.host.sendKeys = async (ws, key) => {
      await orig(ws, key);
      run(sessionStart("w1-t1-implementer-1"));
    };
    const out = await spawnAgent(env.request(), env.deps);
    if (out.kind !== "launched") throw new Error("expected a launch");
    const verified = await drive(out.verified);
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
        const w = await watch(ns, id);
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
    await expect(drive(out.verified)).rejects.toThrow("socket timeout");
    expect(existsSync(out.lock.path)).toBe(false);
    expect(closed).toBeGreaterThan(0);
    expect(env.events.at(-1)).toMatchObject({ type: "alarm_raised" });
  });

  describe("Claude Code's first-run screens (#400)", () => {
    let restore: (() => void) | undefined;
    afterEach(() => {
      restore?.();
      restore = undefined;
    });

    /**
     * A spawn under profile `work` (registered where the launch fence reads it) whose sessions
     * show `screens`; the n-th launch's session registers when `registers(n)`.
     */
    async function firstRun(screens: string[], registers: (n: number) => boolean) {
      env = await makeSpawnEnv({ spawnTimeoutS: 0.5, watch });
      const root = join(env.dir, "claude");
      restore = stubEnv({ VOLLEY_CLAUDE_DIR: root, VOLLEYD_HOME: join(env.dir, "volleyd") });
      const dir = profileDir(
        root,
        addAccount(root, { label: "work" }, "2026-10-19T00:00:00.000Z").id,
      );
      writeFileSync(
        join(dir, ".claude.json"),
        JSON.stringify({ projects: { [env.repo]: { hasTrustDialogAccepted: true } } }),
      );
      env.host.screens = screens;
      const seeded: { id: string; dir: string; machine: string }[] = [];
      env.deps.seedProfile = async (a) => {
        seeded.push(a);
        return { ".claude.json": ["hasCompletedOnboarding", "theme"], "settings.json": [] };
      };
      let n = 0;
      env.host.onLaunch = () => {
        const i = ++n;
        if (registers(i)) run(sessionStart(`w1-t1-implementer-${i}`));
      };
      const out = await spawnAgent(
        env.request({ account: { id: "work", dir, machine: "local" } }),
        env.deps,
      );
      if (out.kind !== "launched") throw new Error(`expected a launch, got ${out.kind}`);
      const verified = await drive(out.verified);
      await verified.watch.close();
      return { verified, seeded, dir };
    }

    it("the theme picker: the profile is prepared, profile_repaired journaled, one relaunch in a new workspace", async () => {
      const { verified, seeded, dir } = await firstRun(
        [screen("first-run-theme.txt")],
        (n) => n === 2,
      );
      expect(verified).toMatchObject({ kind: "registered", agentId: "w1-t1-implementer-2" });
      expect(seeded).toEqual([{ id: "work", dir, machine: "local" }]);
      // The stuck session is closed (never typed into); the relaunch opens a workspace of its own.
      expect(env.host.closed).toEqual(["workspace:1"]);
      expect(env.host.texts).toEqual([]);
      expect(env.host.launches).toHaveLength(2);
      const repaired = env.events.find((e) => e.type === "profile_repaired");
      expect(repaired?.data).toEqual({
        account: "work",
        machine: "local",
        keys: { ".claude.json": ["hasCompletedOnboarding", "theme"], "settings.json": [] },
        agent_id: "w1-t1-implementer-1",
        screen_class: "first_run_theme",
      });
      expect(env.events.find((e) => e.type === "agent_retired")?.data).toMatchObject({
        agent_id: "w1-t1-implementer-1",
        status: "superseded",
      });
      const spawned = env.events.filter((e) => e.type === "agent_spawned");
      expect(spawned[1]?.data).toMatchObject({
        attempt: 2,
        workspace: "workspace:2",
        recovered_from: "w1-t1-implementer-1",
        recovery: "first_run",
      });
      expect(env.events.some((e) => e.type === "decision_opened")).toBe(false);
    });

    it("stuck there again: unknown_screen, in plain words, the terminal's last line never the headline", async () => {
      const { verified, seeded } = await firstRun([screen("first-run-theme.txt")], () => false);
      expect(verified).toMatchObject({ kind: "decision", decision: "unknown_screen" });
      expect(seeded).toHaveLength(1);
      expect(env.host.launches).toHaveLength(2);
      const d = env.events.find((e) => e.type === "decision_opened");
      const question = d?.data.question as string;
      expect(question).toContain(
        "w1-t1-implementer-2 is stuck on Claude Code's first-run setup (theme picker) for account work on local.",
      );
      expect(question).not.toContain("Syntax theme");
      expect(question).not.toContain("Last output");
      expect(d?.data).toMatchObject({ screen_class: "first_run_theme" });
    });

    it("an update prompt, then a first-run screen: no second relaunch, unknown_screen", async () => {
      const { verified, seeded } = await firstRun(
        [screen("update-prompt.txt"), screen("first-run-theme.txt")],
        () => false,
      );
      expect(verified).toMatchObject({ kind: "decision", decision: "unknown_screen" });
      expect(seeded).toEqual([]);
      expect(env.events.some((e) => e.type === "profile_repaired")).toBe(false);
      const d = env.events.find((e) => e.type === "decision_opened");
      expect(d?.data.question).toContain("already relaunched it once");
    });

    it("the bypass-permissions confirmation is named as such", async () => {
      await firstRun([screen("bypass-consent.txt")], () => false);
      const d = env.events.find((e) => e.type === "decision_opened");
      expect(d?.data.question).toContain(
        "is stuck on Claude Code's first-run setup (bypass-permissions confirmation)",
      );
    });
  });

  it("an unknown screen → unknown_screen decision with the capture path", async () => {
    const out = await spawnWith(async () => {}, [screen("login.txt")]);
    expect(out).toMatchObject({ kind: "decision", decision: "unknown_screen" });
    const d = env.events.find((e) => e.type === "decision_opened");
    expect(d?.data).toMatchObject({ kind: "unknown_screen", screen_class: "login" });
    const pointer = (d?.data.pointers as { screen?: string }).screen as string;
    expect(readFileSync(pointer, "utf-8")).toBe(screen("login.txt"));
  });

  it("an unknown_screen decision quotes the session's last output (why it did not start)", async () => {
    const said =
      "volleyd: cannot start the agent: claude is not on this session's PATH (/usr/bin:/bin). Put its directory on the PATH a non-interactive shell gets (zsh: ~/.zshenv; bash: the top of ~/.bashrc), then relaunch.";
    const out = await spawnWith(async () => {}, [`$ bash .volley/launch.sh\n${said}\n\n`]);
    expect(out).toMatchObject({ kind: "decision", decision: "unknown_screen" });
    const d = env.events.find((e) => e.type === "decision_opened");
    expect(d?.data.question).toContain("did not start");
    expect(d?.data.question).toContain("Last output: “");
    expect(d?.data.question).toContain("claude is not on this session's PATH");
    expect(d?.data.last_output).toContain("claude is not on this session's PATH");
  });

  it("an empty screen says the session showed nothing (it may have exited at once)", async () => {
    await spawnWith(async () => {}, [screen("blank.txt")]);
    const d = env.events.find((e) => e.type === "decision_opened");
    expect(d?.data.question).toContain("screen: empty");
    expect(d?.data.question).toContain("nothing on screen: its session may have ended at once");
    // A local agent: no remote ssh PATH hint.
    expect(d?.data.question).not.toContain("ssh PATH");
    expect(lastOutputNote(null, true)).toContain("non-interactive ssh PATH");
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
