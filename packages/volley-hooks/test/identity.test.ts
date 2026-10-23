import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
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
  coordinatorStateDir,
  projectDirOf,
  readAgentIdentity,
  resolveCoordinatorIdentity,
  sessionKey,
} from "../src/lib/identity";
import { startTestBroker } from "./helpers/aedes-broker";
import { HOOK_NAMES, fixture, hookEnv, makeWorkdir, runHook } from "./helpers/hooks";
import { tempDir } from "./helpers/tmp";

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
  "picker-pre": "pre-tool-use-ask.json",
  "picker-post": "post-tool-use-ask.json",
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
    const env = { VOLLEY_HOOKS_STATE_DIR: tempDir("volley-hooks-state-") };
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

  describe("sessions sharing a cwd (#392)", () => {
    const at = (
      agentId: string,
      startedAt: string,
      surface?: string,
    ): ReturnType<typeof live> & { surface?: string } => ({
      ...live(agentId, startedAt),
      ...(surface !== undefined ? { surface } : {}),
    });
    const A = at("coordinator-aaaa", "2026-10-22T10:00:00.000Z", "surface-a");
    const B = at("coordinator-bbbb", "2026-10-22T10:05:00.000Z", "surface-b");

    it("the session key is the hook input's session_id, else the cmux surface, else none", () => {
      expect(sessionKey({ session_id: "s1" }, { CMUX_SURFACE_ID: "x" })).toBe("session:s1");
      expect(sessionKey({}, { CMUX_SURFACE_ID: "x" })).toBe("surface:x");
      expect(sessionKey({ session_id: "" }, {})).toBeNull();
    });

    it("each session resolves its own entry by surface and keeps its own state dir", async () => {
      const { dir, env } = setup();
      const lookup = async () => [B, A];
      const a = await resolveCoordinatorIdentity(
        dir,
        { ...env, CMUX_SURFACE_ID: "surface-a" },
        lookup,
        {
          refresh: true,
          sessionKey: "session:a",
        },
      );
      const b = await resolveCoordinatorIdentity(
        dir,
        { ...env, CMUX_SURFACE_ID: "surface-b" },
        lookup,
        {
          refresh: true,
          sessionKey: "session:b",
        },
      );
      expect(a?.agentId).toBe("coordinator-aaaa");
      expect(b?.agentId).toBe("coordinator-bbbb");
      expect(a?.stateDir).not.toBe(b?.stateDir);
      expect(a?.stateDir).toBe(coordinatorStateDir(dir, env, "session:a"));
    });

    it("never adopts an entry recorded from another surface", async () => {
      const { dir, env } = setup();
      const id = await resolveCoordinatorIdentity(
        dir,
        { ...env, CMUX_SURFACE_ID: "surface-a" },
        async () => [B],
        { refresh: true, sessionKey: "session:a" },
      );
      expect(id).toBeNull();
    });

    it("at startup, another surface's entry alone does not cache a miss: it waits for its own", async () => {
      const { dir, env } = setup();
      const b = at("coordinator-bbbb", "2026-10-22T10:05:01.000Z", "surface-b");
      let lookups = 0;
      const lookup = async () => {
        lookups++;
        return lookups < 2 ? [A] : [b, A];
      };
      const benv = { ...env, CMUX_SURFACE_ID: "surface-b" };
      const id = await resolveCoordinatorIdentity(dir, benv, lookup, {
        refresh: true,
        notBefore: Date.parse("2026-10-22T09:59:00.000Z"),
        retryDelayMs: 0,
        sessionKey: "session:b",
      });
      expect(id?.agentId).toBe("coordinator-bbbb");
      expect(lookups).toBe(2);
    });

    it("without cmux, a session keeps the entry it resolved first after a newer one appears", async () => {
      const { dir, env } = setup();
      const a0 = at("coordinator-aaaa", "2026-10-22T10:00:00.000Z");
      const b0 = at("coordinator-bbbb", "2026-10-22T10:05:00.000Z");
      let entries = [a0];
      const lookup = async () => entries;
      const first = await resolveCoordinatorIdentity(dir, env, lookup, { sessionKey: "session:a" });
      expect(first?.agentId).toBe("coordinator-aaaa");
      entries = [b0, a0];
      const again = await resolveCoordinatorIdentity(dir, env, lookup, {
        refresh: true,
        sessionKey: "session:a",
      });
      expect(again?.agentId).toBe("coordinator-aaaa");
      // A new session in the same cwd takes the newest.
      const other = await resolveCoordinatorIdentity(dir, env, lookup, {
        refresh: true,
        sessionKey: "session:b",
      });
      expect(other?.agentId).toBe("coordinator-bbbb");
    });

    it("the pin survives a cached miss (a broker that was briefly unreachable)", async () => {
      const { dir, env } = setup();
      const a0 = at("coordinator-aaaa", "2026-10-22T10:00:00.000Z");
      const b0 = at("coordinator-bbbb", "2026-10-22T10:05:00.000Z");
      let entries: (typeof a0)[] = [a0];
      const lookup = async () => entries;
      const opts = { refresh: true, sessionKey: "session:a" };
      await resolveCoordinatorIdentity(dir, env, lookup, opts);
      entries = [];
      expect(await resolveCoordinatorIdentity(dir, env, lookup, opts)).toBeNull();
      entries = [b0, a0];
      expect((await resolveCoordinatorIdentity(dir, env, lookup, opts))?.agentId).toBe(
        "coordinator-aaaa",
      );
    });

    it("without a session key the directory key still applies", async () => {
      const { dir, env } = setup();
      const id = await resolveCoordinatorIdentity(dir, env, async () => [A]);
      expect(id?.stateDir).toBe(coordinatorStateDir(dir, env));
    });
  });

  it("two hook runs in a non-matching cwd open one broker connection, not two", async () => {
    const broker = await startTestBroker();
    try {
      const dir = makeWorkdir();
      const env = {
        VOLLEY_HOOKS_COORDINATOR: "1",
        VOLLEY_BROKER_URL: broker.url,
        VOLLEY_HOOKS_STATE_DIR: tempDir("volley-hooks-state-"),
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
