import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coordinatorStateDir } from "../src/lib/identity";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { fixture, hookEnv, makeWorkdir, runHook } from "./helpers/hooks";

const AGENT = "w1-t1-implementer-1";
const PASSWORD = "minted-pw";

let broker: TestBroker;

beforeEach(async () => {
  broker = await startTestBroker({ credentials: { username: AGENT, password: PASSWORD } });
});

afterEach(async () => {
  await broker.close();
});

const agentJson = (password: string, brokerUrl = broker.url) => ({
  agent_id: AGENT,
  namespace: "ns",
  broker_url: brokerUrl,
  broker: { username: AGENT, password },
});

const sessionStart = (dir: string) =>
  runHook("session-start", fixture("session-start-startup.json", dir), { cwd: dir });

describe("runHook: AUTH_FAILED is loud", () => {
  it("wrong credentials → exit 1, one stderr line naming AUTH_FAILED and the user, hooks-error.json; a later good run clears it", async () => {
    const dir = makeWorkdir(agentJson("wrong"));
    const run = await sessionStart(dir);
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe("");
    const lines = run.stderr.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("AUTH_FAILED");
    expect(lines[0]).toContain(AGENT);
    expect(lines[0]).toContain(broker.url);
    expect(lines[0]).toMatch(/^volley-hooks SessionStart: /);

    const errorFile = join(dir, ".volley", "hooks-error.json");
    const err = JSON.parse(readFileSync(errorFile, "utf-8"));
    expect(err).toMatchObject({ code: "AUTH_FAILED", hook_event: "SessionStart", username: AGENT });
    expect(Number.isNaN(Date.parse(err.at))).toBe(false);

    writeFileSync(join(dir, ".volley", "agent.json"), JSON.stringify(agentJson(PASSWORD)));
    const ok = await sessionStart(dir);
    expect(ok.exitCode).toBe(0);
    expect(ok.stderr).toBe("");
    expect(existsSync(errorFile)).toBe(false);
  });

  it("anonymous against the authenticating broker → exit 1, reported as anonymous", async () => {
    const dir = makeWorkdir({ agent_id: AGENT, namespace: "ns", broker_url: broker.url });
    const run = await sessionStart(dir);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("AUTH_FAILED for anonymous");
    const err = JSON.parse(readFileSync(join(dir, ".volley", "hooks-error.json"), "utf-8"));
    expect(err.username).toBeNull();
  });

  it("an unrelated error (broker down) still exits 0 silently, no error file", async () => {
    const down = await startTestBroker();
    const url = down.url;
    await down.close();
    const dir = makeWorkdir(agentJson(PASSWORD, url));
    const run = await sessionStart(dir);
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe("");
    expect(existsSync(join(dir, ".volley", "hooks-error.json"))).toBe(false);
  });

  it("coordinator mode: a refused registry lookup is loud too (and not cached as a miss)", async () => {
    const dir = makeWorkdir();
    const stateRoot = makeWorkdir();
    const env = {
      VOLLEY_HOOKS_COORDINATOR: "1",
      VOLLEY_BROKER_URL: broker.url,
      VOLLEY_HOOKS_STATE_DIR: stateRoot,
      VOLLEY_AUTH_USERNAME: "coordinator",
      VOLLEY_AUTH_PASSWORD: "nope",
    };
    const stop = () => runHook("stop", fixture("stop.json", dir), { cwd: dir, env });
    const run = await stop();
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("AUTH_FAILED for coordinator");
    // Still refused on the next run (a cached miss would have made it silent).
    expect((await stop()).exitCode).toBe(1);
  });

  it("coordinator mode with no credentials at all is not set up: every hook is silent (#407)", async () => {
    const dir = makeWorkdir();
    const stateRoot = makeWorkdir();
    // No VOLLEY_AUTH_*, and VOLLEY_AUTH_DIR (hookEnv's empty temp dir) has no coordinator.json.
    const env = {
      VOLLEY_HOOKS_COORDINATOR: "1",
      VOLLEY_BROKER_URL: broker.url,
      VOLLEY_HOOKS_STATE_DIR: stateRoot,
    };
    for (const [name, fx] of [
      ["session-start", "session-start-startup.json"],
      ["user-prompt-submit", "user-prompt-submit.json"],
      ["post-tool-use", "post-tool-use.json"],
      ["stop", "stop.json"],
    ] as const) {
      const run = await runHook(name, fixture(fx, dir), { cwd: dir, env });
      expect(run.exitCode, name).toBe(0);
      expect(run.stdout, name).toBe("");
      expect(run.stderr, name).toBe("");
    }
    const stateDir = coordinatorStateDir(
      dir,
      hookEnv(env),
      "session:7c984d76-0e0e-40d5-b9f1-777e9c0e6caa",
    );
    expect(existsSync(join(stateDir, "hooks-error.json"))).toBe(false);
  });

  it("pre-tool-use-lease: a refused lease-pool read is loud (exit 1, never 2), the tool call is not blocked", async () => {
    const dir = makeWorkdir(agentJson("wrong"));
    const run = await runHook("pre-tool-use-lease", fixture("pre-tool-use-bash.json", dir), {
      cwd: dir,
    });
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(`AUTH_FAILED for ${AGENT}`);
    expect(existsSync(join(dir, ".volley", "hooks-error.json"))).toBe(true);
  });
});

describe("runHook: unusable credential files are loud too", () => {
  const ERROR_LINE = /^volley-hooks Stop: AUTH_FAILED — /;

  function coordinatorEnv(authDir: string, stateRoot = makeWorkdir()) {
    return {
      VOLLEY_HOOKS_COORDINATOR: "1",
      VOLLEY_BROKER_URL: broker.url,
      VOLLEY_HOOKS_STATE_DIR: stateRoot,
      VOLLEY_AUTH_DIR: authDir,
    };
  }

  async function expectLoudCoordinator(authDir: string, pathPattern: RegExp) {
    const dir = makeWorkdir();
    const env = coordinatorEnv(authDir);
    const stop = () => runHook("stop", fixture("stop.json", dir), { cwd: dir, env });
    const run = await stop();
    expect(run.exitCode).toBe(1);
    const lines = run.stderr.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(ERROR_LINE);
    expect(lines[0]).toContain(join(authDir, "coordinator.json"));
    expect(lines[0]).toMatch(pathPattern);
    const stateDir = coordinatorStateDir(
      dir,
      hookEnv(env),
      "session:7c984d76-0e0e-40d5-b9f1-777e9c0e6caa",
    );
    const err = JSON.parse(readFileSync(join(stateDir, "hooks-error.json"), "utf-8"));
    expect(err).toMatchObject({ code: "AUTH_FAILED", hook_event: "Stop", username: null });
    // Not cached as "no coordinator here": the next run is just as loud.
    expect(existsSync(join(stateDir, "identity.json"))).toBe(false);
    expect((await stop()).exitCode).toBe(1);
  }

  it("a malformed coordinator.json → exit 1, one stderr line naming the file, hooks-error.json, no cached miss", async () => {
    const authDir = makeWorkdir();
    writeFileSync(join(authDir, "coordinator.json"), "{oops");
    await expectLoudCoordinator(authDir, /malformed/);
  });

  it.skipIf(process.getuid?.() === 0)(
    "an unreadable (mode 000) coordinator.json → exit 1, reported as unreadable",
    async () => {
      const authDir = makeWorkdir();
      const path = join(authDir, "coordinator.json");
      writeFileSync(path, JSON.stringify({ username: AGENT, password: PASSWORD }));
      chmodSync(path, 0o000);
      await expectLoudCoordinator(authDir, /cannot read/);
    },
  );

  it("a malformed agent.json → exit 1, one stderr line naming it, .volley/hooks-error.json", async () => {
    const dir = makeWorkdir();
    mkdirSync(join(dir, ".volley"));
    writeFileSync(join(dir, ".volley", "agent.json"), "{bad");
    // Even with coordinator mode on (and usable coordinator credentials) it is not a fallback.
    const env = {
      ...coordinatorEnv(makeWorkdir()),
      VOLLEY_AUTH_USERNAME: AGENT,
      VOLLEY_AUTH_PASSWORD: PASSWORD,
    };
    const run = await runHook("stop", fixture("stop.json", dir), { cwd: dir, env });
    expect(run.exitCode).toBe(1);
    const lines = run.stderr.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(ERROR_LINE);
    expect(lines[0]).toContain(join(dir, ".volley", "agent.json"));
    const err = JSON.parse(readFileSync(join(dir, ".volley", "hooks-error.json"), "utf-8"));
    expect(err).toMatchObject({ code: "AUTH_FAILED", hook_event: "Stop", username: null });
    expect(broker.connections()).toBe(0);
  });

  it.skipIf(process.getuid?.() === 0)(
    "an unreadable (mode 000) agent.json → exit 1, hooks-error.json",
    async () => {
      const dir = makeWorkdir(agentJson(PASSWORD));
      chmodSync(join(dir, ".volley", "agent.json"), 0o000);
      const run = await runHook("stop", fixture("stop.json", dir), { cwd: dir });
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toMatch(ERROR_LINE);
      expect(existsSync(join(dir, ".volley", "hooks-error.json"))).toBe(true);
    },
  );
});
