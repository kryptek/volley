import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { fixture, makeWorkdir, runHook } from "./helpers/hooks";

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
});
