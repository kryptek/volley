import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { type Server, type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handle as notification } from "../src/hooks/notification";
import { handle as postModelSwitch } from "../src/hooks/post-model-switch";
import { handle as postToolUse } from "../src/hooks/post-tool-use";
import { handle as preCompact } from "../src/hooks/pre-compact";
import { handle as preToolUse } from "../src/hooks/pre-tool-use";
import { handle as preToolUseLease } from "../src/hooks/pre-tool-use-lease";
import { handle as sessionStart } from "../src/hooks/session-start";
import { handle as stop } from "../src/hooks/stop";
import { handle as userPromptSubmit } from "../src/hooks/user-prompt-submit";
import { invokeHook } from "../src/lib/hook-io";
import {
  coordinatorEnabled,
  projectDirOf,
  readAgentIdentity,
  resolveCoordinatorIdentity,
} from "../src/lib/identity";
import { startTestBroker } from "./helpers/aedes-broker";
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
  "pre-tool-use-lease": "pre-tool-use-bash.json",
  "pre-tool-use": "pre-tool-use-bash.json",
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

  const handlers: [string, string, Parameters<typeof invokeHook>[1]][] = [
    ["SessionStart", "SessionStart", sessionStart],
    ["PostModelSwitch", "PostModelSwitch", postModelSwitch],
    ["UserPromptSubmit", "UserPromptSubmit", userPromptSubmit],
    ["PostToolUse", "PostToolUse", postToolUse],
    ["Stop", "Stop", stop],
    ["Notification", "Notification", notification],
    ["PreCompact", "PreCompact", preCompact],
    ["PreToolUse (lease)", "PreToolUse", preToolUseLease],
    ["PreToolUse (activity)", "PreToolUse", preToolUse],
  ];

  it.each(handlers)("%s handler returns within 50 ms", async (_label, event, handler) => {
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

  it("a malformed agent.json is not a no-op: it is loud (exit 1) and opens no socket", async () => {
    const dir = makeWorkdir();
    mkdirSync(join(dir, ".volley"));
    writeFileSync(join(dir, ".volley", "agent.json"), "{not json");
    const before = connections;
    const run = await runHook("stop", fixture("stop.json", dir), {
      cwd: dir,
      env: { VOLLEY_BROKER_URL: url },
    });
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("agent.json");
    expect(connections).toBe(before);
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

  it("throws AUTH_FAILED when the file exists but is unusable (never treated as absent)", () => {
    const dir = makeWorkdir();
    mkdirSync(join(dir, ".volley"));
    writeFileSync(join(dir, ".volley", "agent.json"), "{not json");
    expect(() => readAgentIdentity(dir, {})).toThrow(join(dir, ".volley", "agent.json"));
    try {
      readAgentIdentity(dir, {});
    } catch (e) {
      expect(e).toMatchObject({ code: "AUTH_FAILED", stateDir: join(dir, ".volley") });
    }
  });

  it("hookEnv pins VOLLEY_AUTH_DIR to an empty temp dir (never the host's coordinator.json)", () => {
    const dir = hookEnv().VOLLEY_AUTH_DIR as string;
    expect(dir.startsWith(tmpdir())).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
    expect(hookEnv({ VOLLEY_AUTH_DIR: "/x" }).VOLLEY_AUTH_DIR).toBe("/x");
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

describe("coordinator identity", () => {
  const live = (agentId: string, startedAt: string, status: string | null = "working") => ({
    agentId,
    namespace: "default",
    parentId: null,
    startedAt,
    status,
  });
  const setup = () => {
    const dir = makeWorkdir();
    const env = { VOLLEY_HOOKS_STATE_DIR: mkdtempSync(join(tmpdir(), "volley-hooks-state-")) };
    return { dir, env };
  };

  it("caches a miss, so an unrelated project costs one lookup per TTL", async () => {
    const { dir, env } = setup();
    let lookups = 0;
    const lookup = async () => {
      lookups++;
      return [];
    };
    let t = 1_000_000;
    const now = () => t;
    expect(await resolveCoordinatorIdentity(dir, env, lookup, { now })).toBeNull();
    t += 30_000;
    expect(await resolveCoordinatorIdentity(dir, env, lookup, { now })).toBeNull();
    expect(lookups).toBe(1);
    t += 31_000;
    expect(await resolveCoordinatorIdentity(dir, env, lookup, { now })).toBeNull();
    expect(lookups).toBe(2);
    // SessionStart always looks again.
    await resolveCoordinatorIdentity(dir, env, lookup, { now, refresh: true });
    expect(lookups).toBe(3);
  });

  it("caches an unreachable broker as a miss too", async () => {
    const { dir, env } = setup();
    let lookups = 0;
    const lookup = async () => {
      lookups++;
      throw new Error("connect timeout");
    };
    expect(await resolveCoordinatorIdentity(dir, env, lookup)).toBeNull();
    expect(await resolveCoordinatorIdentity(dir, env, lookup)).toBeNull();
    expect(lookups).toBe(1);
  });

  it("skips agents whose status is terminal", async () => {
    const { dir, env } = setup();
    const lookup = async () => [
      live("coordinator-dead", "2026-10-18T12:00:00.000Z", "reaped"),
      live("coordinator-done", "2026-10-18T11:00:00.000Z", "done"),
      live("coordinator-live", "2026-10-18T10:00:00.000Z"),
    ];
    const id = await resolveCoordinatorIdentity(dir, env, lookup);
    expect(id?.agentId).toBe("coordinator-live");
  });

  it("at startup, waits for this session's entry rather than adopting an older session's", async () => {
    const { dir, env } = setup();
    const started = Date.parse("2026-10-18T12:00:00.000Z");
    let calls = 0;
    const lookup = async () => {
      calls++;
      return calls < 3
        ? [live("coordinator-old1", "2026-10-17T10:00:00.000Z")]
        : [
            live("coordinator-new1", "2026-10-18T12:00:01.000Z"),
            live("coordinator-old1", "2026-10-17T10:00:00.000Z"),
          ];
    };
    const id = await resolveCoordinatorIdentity(dir, env, lookup, {
      refresh: true,
      notBefore: started - 60_000,
      retryDelayMs: 0,
    });
    expect(id?.agentId).toBe("coordinator-new1");
  });

  it("at startup, an older session's entry alone is neither adopted nor cached", async () => {
    const { dir, env } = setup();
    let lookups = 0;
    const lookup = async () => {
      lookups++;
      return [live("coordinator-old1", "2026-10-17T10:00:00.000Z")];
    };
    const notBefore = Date.parse("2026-10-18T11:59:00.000Z");
    const opts = { refresh: true, notBefore, retryDelayMs: 0 };
    expect(await resolveCoordinatorIdentity(dir, env, lookup, opts)).toBeNull();
    const after = lookups;
    // Not cached: the next hook looks again (and, outside startup, takes the live entry).
    expect((await resolveCoordinatorIdentity(dir, env, lookup))?.agentId).toBe("coordinator-old1");
    expect(lookups).toBe(after + 1);
  });

  it("two hook runs in a non-matching cwd open one broker connection, not two", async () => {
    const broker = await startTestBroker();
    try {
      const dir = makeWorkdir();
      const env = {
        VOLLEY_HOOKS_COORDINATOR: "1",
        VOLLEY_BROKER_URL: broker.url,
        VOLLEY_HOOKS_STATE_DIR: mkdtempSync(join(tmpdir(), "volley-hooks-state-")),
      };
      for (let i = 0; i < 2; i++) {
        const run = await runHook("post-tool-use", fixture("post-tool-use.json", dir), {
          cwd: dir,
          env,
        });
        expect(run.exitCode).toBe(0);
        expect(run.stdout).toBe("");
      }
      expect(broker.connections()).toBe(1);
    } finally {
      await broker.close();
    }
  });
});
