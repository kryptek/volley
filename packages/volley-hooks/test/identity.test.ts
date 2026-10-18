import { mkdirSync, writeFileSync } from "node:fs";
import { type Server, type Socket, createServer } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handle as notification } from "../src/hooks/notification";
import { handle as postModelSwitch } from "../src/hooks/post-model-switch";
import { handle as postToolUse } from "../src/hooks/post-tool-use";
import { handle as preCompact } from "../src/hooks/pre-compact";
import { handle as sessionStart } from "../src/hooks/session-start";
import { handle as stop } from "../src/hooks/stop";
import { handle as userPromptSubmit } from "../src/hooks/user-prompt-submit";
import { invokeHook } from "../src/lib/hook-io";
import { coordinatorEnabled, projectDirOf, readAgentIdentity } from "../src/lib/identity";
import { HOOK_NAMES, fixture, hookEnv, makeWorkdir, runHook } from "./helpers/hooks";

/** A TCP listener standing in for the broker: it only counts connection attempts. */
let server: Server;
let connections = 0;
const sockets: Socket[] = [];
let url: string;

beforeAll(async () => {
  server = createServer((s) => {
    connections++;
    sockets.push(s);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  url = `mqtt://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

const FIXTURE_FOR: Record<string, string> = {
  "session-start": "session-start-startup.json",
  "post-model-switch": "post-model-switch.json",
  "user-prompt-submit": "user-prompt-submit.json",
  "post-tool-use": "post-tool-use.json",
  stop: "stop.json",
  notification: "notification-agent-needs-input.json",
  "pre-compact": "pre-compact.json",
};

describe("no .volley/agent.json → silent no-op", () => {
  it.each(HOOK_NAMES)("%s exits 0 with empty stdout and opens no socket", async (name) => {
    const dir = makeWorkdir();
    const before = connections;
    const run = await runHook(name, fixture(FIXTURE_FOR[name] as string, dir), {
      cwd: dir,
      env: { VOLLEY_BROKER_URL: url },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
    expect(connections).toBe(before);
  });

  const handlers = {
    SessionStart: sessionStart,
    PostModelSwitch: postModelSwitch,
    UserPromptSubmit: userPromptSubmit,
    PostToolUse: postToolUse,
    Stop: stop,
    Notification: notification,
    PreCompact: preCompact,
  };

  it.each(Object.entries(handlers))("%s handler returns within 50 ms", async (event, handler) => {
    const dir = makeWorkdir();
    const before = connections;
    const started = performance.now();
    const out = await invokeHook(
      event,
      handler,
      JSON.stringify({ cwd: dir, hook_event_name: event }),
      hookEnv({ VOLLEY_BROKER_URL: url }),
    );
    expect(performance.now() - started).toBeLessThan(50);
    expect(out).toBe("");
    expect(connections).toBe(before);
  });

  it("a malformed agent.json is a no-op too", async () => {
    const dir = makeWorkdir();
    mkdirSync(join(dir, ".volley"));
    writeFileSync(join(dir, ".volley", "agent.json"), "{not json");
    const run = await runHook("stop", fixture("stop.json", dir), {
      cwd: dir,
      env: { VOLLEY_BROKER_URL: url },
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
  });

  it("garbage on stdin is a no-op", async () => {
    const dir = makeWorkdir({ agent_id: "w1-t1-implementer-1", broker_url: url });
    const run = await runHook("stop", "not json at all", { cwd: dir });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
  });
});

describe("identity resolution", () => {
  it("reads agent_id, namespace, parent_id and broker_url from .volley/agent.json", () => {
    const dir = makeWorkdir({
      agent_id: "w1-t1-implementer-1",
      namespace: "dispatch",
      parent_id: "coordinator-ab12",
      broker_url: "mqtt://127.0.0.1:1",
    });
    expect(readAgentIdentity(dir, {})).toEqual({
      mode: "agent",
      agentId: "w1-t1-implementer-1",
      namespace: "dispatch",
      parentId: "coordinator-ab12",
      brokerUrl: "mqtt://127.0.0.1:1",
      projectDir: dir,
      stateDir: join(dir, ".volley"),
    });
  });

  it("falls back to env for keys the file omits", () => {
    const dir = makeWorkdir({ agent_id: "w1-t1-implementer-1" });
    const id = readAgentIdentity(dir, { VOLLEY_BROKER_URL: "mqtt://b:1", VOLLEY_NAMESPACE: "n" });
    expect(id?.brokerUrl).toBe("mqtt://b:1");
    expect(id?.namespace).toBe("n");
  });

  it("returns null without the file", () => {
    expect(readAgentIdentity(makeWorkdir(), {})).toBeNull();
  });

  it("prefers CLAUDE_PROJECT_DIR over the input cwd", () => {
    expect(projectDirOf({ cwd: "/a/sub" }, { CLAUDE_PROJECT_DIR: "/a" })).toBe("/a");
    expect(projectDirOf({ cwd: "/a/sub" }, {})).toBe("/a/sub");
  });

  it("coordinator mode is opt-in", () => {
    expect(coordinatorEnabled({})).toBe(false);
    expect(coordinatorEnabled({ VOLLEY_HOOKS_COORDINATOR: "1" })).toBe(true);
  });
});
