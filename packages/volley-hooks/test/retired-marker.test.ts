import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRetiredMarker } from "../src/lib/identity";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { HOOK_NAMES, type HookName, fixture, makeWorkdir, runHook } from "./helpers/hooks";

/**
 * A retired agent (volleyd wrote `.volley/retired.json` naming it, then deleted its login): its
 * hooks end quietly before any connect, and never print the AUTH_FAILED advice.
 */

const AGENT = "w1-t1-implementer-1";
const PASSWORD = "minted-pw";

let broker: TestBroker;

beforeEach(async () => {
  broker = await startTestBroker({ credentials: { username: AGENT, password: PASSWORD } });
});

afterEach(async () => {
  await broker.close();
});

const agentJson = (password: string) => ({
  agent_id: AGENT,
  namespace: "ns",
  broker_url: broker.url,
  broker: { username: AGENT, password },
});

const retire = (dir: string, agentId = AGENT) =>
  writeFileSync(
    join(dir, ".volley", "retired.json"),
    JSON.stringify({ agent_id: agentId, status: "done", at: "2026-10-20T12:00:00.000Z" }),
  );

const FIXTURE_FOR: Record<HookName, string> = {
  "session-start": "session-start-startup.json",
  "post-model-switch": "post-model-switch.json",
  "user-prompt-submit": "user-prompt-submit.json",
  "post-tool-use": "post-tool-use.json",
  stop: "stop.json",
  notification: "notification-agent-needs-input.json",
  "pre-compact": "pre-compact.json",
  "pre-tool-use-lease": "pre-tool-use-bash.json",
  "pre-tool-use": "pre-tool-use-bash.json",
};

const errorFile = (dir: string) =>
  JSON.parse(readFileSync(join(dir, ".volley", "hooks-error.json"), "utf-8"));

describe("a retired agent's hooks are quiet", () => {
  it("wrong credentials + its own marker → exit 0, nothing printed, a RETIRED note, no connect", async () => {
    const dir = makeWorkdir(agentJson("wrong"));
    retire(dir);
    const run = await runHook("stop", fixture("stop.json", dir), { cwd: dir });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
    expect(errorFile(dir)).toMatchObject({ code: "RETIRED", hook_event: "Stop", agent_id: AGENT });
    expect(broker.connections()).toBe(0);
  });

  it("the note is written once: a later hook leaves it as it is", async () => {
    const dir = makeWorkdir(agentJson("wrong"));
    retire(dir);
    await runHook("stop", fixture("stop.json", dir), { cwd: dir });
    const first = readFileSync(join(dir, ".volley", "hooks-error.json"), "utf-8");
    await runHook("post-tool-use", fixture("post-tool-use.json", dir), { cwd: dir });
    expect(readFileSync(join(dir, ".volley", "hooks-error.json"), "utf-8")).toBe(first);
  });

  it("a marker for another agent (a reused worktree) is ignored: AUTH_FAILED stays loud", async () => {
    const dir = makeWorkdir(agentJson("wrong"));
    retire(dir, "w1-t1-implementer-0");
    const run = await runHook("stop", fixture("stop.json", dir), { cwd: dir });
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("AUTH_FAILED");
    expect(errorFile(dir).code).toBe("AUTH_FAILED");
  });

  it("right credentials + its own marker → still quiet, nothing published", async () => {
    const dir = makeWorkdir(agentJson(PASSWORD));
    retire(dir);
    const run = await runHook("stop", fixture("stop.json", dir), { cwd: dir });
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe("");
    expect(broker.connections()).toBe(0);
  });

  it.each(HOOK_NAMES)("%s honours the marker", async (name) => {
    const dir = makeWorkdir(agentJson("wrong"));
    retire(dir);
    const run = await runHook(name, fixture(FIXTURE_FOR[name], dir), { cwd: dir });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
    expect(errorFile(dir).code).toBe("RETIRED");
    expect(broker.connections()).toBe(0);
  });
});

describe("readRetiredMarker", () => {
  it("null for none or a malformed one; never throws", () => {
    const dir = makeWorkdir(agentJson(PASSWORD));
    const state = join(dir, ".volley");
    expect(readRetiredMarker(state)).toBeNull();
    writeFileSync(join(state, "retired.json"), "{not json");
    expect(readRetiredMarker(state)).toBeNull();
    writeFileSync(join(state, "retired.json"), JSON.stringify({ status: "done" }));
    expect(readRetiredMarker(state)).toBeNull();
    retire(dir);
    expect(readRetiredMarker(state)).toEqual({
      agent_id: AGENT,
      status: "done",
      at: "2026-10-20T12:00:00.000Z",
    });
  });
});
