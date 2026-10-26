import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { connectOpts, resolveHooksAuth } from "../src/lib/auth";
import { makeWorkdir } from "./helpers/hooks";
import { tempDir } from "./helpers/tmp";

const AGENT = "w1-t1-implementer-1";
const ENV_AUTH = { VOLLEY_AUTH_USERNAME: "from-env", VOLLEY_AUTH_PASSWORD: "env-pw" };

function authDir(creds?: unknown): string {
  const dir = tempDir("volley-hooks-authdir-");
  if (creds !== undefined) {
    const path = join(dir, "coordinator.json");
    writeFileSync(path, typeof creds === "string" ? creds : JSON.stringify(creds));
    chmodSync(path, 0o600);
  }
  return dir;
}

describe("resolveHooksAuth — agent mode", () => {
  it("the identity file's broker block wins; env is ignored", () => {
    const dir = makeWorkdir({ agent_id: AGENT, broker: { username: AGENT, password: "minted" } });
    expect(resolveHooksAuth({ mode: "agent", projectDir: dir }, ENV_AUTH)).toEqual({
      username: AGENT,
      password: "minted",
    });
  });

  it("an identity file without a broker block falls back to VOLLEY_AUTH_*", () => {
    const dir = makeWorkdir({ agent_id: AGENT });
    expect(resolveHooksAuth({ mode: "agent", projectDir: dir }, ENV_AUTH)).toEqual({
      username: "from-env",
      password: "env-pw",
    });
  });

  it("no broker block and no env: anonymous (null)", () => {
    const dir = makeWorkdir({ agent_id: AGENT });
    expect(resolveHooksAuth({ mode: "agent", projectDir: dir }, {})).toBeNull();
  });

  it("never reads the coordinator file", () => {
    const dir = makeWorkdir({ agent_id: AGENT });
    const env = { VOLLEY_AUTH_DIR: authDir({ username: "coordinator", password: "c" }) };
    expect(resolveHooksAuth({ mode: "agent", projectDir: dir }, env)).toBeNull();
  });
});

describe("resolveHooksAuth — coordinator mode", () => {
  let projectDir = "";
  beforeEach(() => {
    projectDir = makeWorkdir();
  });

  it("VOLLEY_AUTH_* wins over the coordinator file", () => {
    const env = {
      ...ENV_AUTH,
      VOLLEY_AUTH_DIR: authDir({ username: "coordinator", password: "file-pw" }),
    };
    expect(resolveHooksAuth({ mode: "coordinator", projectDir }, env)).toEqual({
      username: "from-env",
      password: "env-pw",
    });
  });

  it("else $VOLLEY_AUTH_DIR/coordinator.json", () => {
    const env = { VOLLEY_AUTH_DIR: authDir({ username: "coordinator", password: "file-pw" }) };
    expect(resolveHooksAuth({ mode: "coordinator", projectDir }, env)).toEqual({
      username: "coordinator",
      password: "file-pw",
    });
  });

  it("else null (anonymous)", () => {
    expect(
      resolveHooksAuth({ mode: "coordinator", projectDir }, { VOLLEY_AUTH_DIR: authDir() }),
    ).toBeNull();
  });

  const resolveIn = (env: Record<string, string>) => () =>
    resolveHooksAuth({ mode: "coordinator", projectDir }, env);

  it("a malformed coordinator file throws AUTH_FAILED (loud, never a cached miss), naming the path", () => {
    const dir = authDir("{not json");
    expect(resolveIn({ VOLLEY_AUTH_DIR: dir })).toThrow(join(dir, "coordinator.json"));
    expect(resolveIn({ VOLLEY_AUTH_DIR: dir })).toThrow(/not a JSON object/);
    expect(captured(resolveIn({ VOLLEY_AUTH_DIR: dir }))).toMatchObject({ code: "AUTH_FAILED" });
    const noUser = authDir({ password: "x" });
    expect(resolveIn({ VOLLEY_AUTH_DIR: noUser })).toThrow(/username/);
    // The four damaged forms: the path, never a byte of the file (#613).
    const marker = "hunter2-marker-aa11";
    for (const text of [
      marker,
      `{"username":"coordinator","password":${marker}}`,
      `{"username":"coordinator","password":"${marker}`,
    ]) {
      const d = authDir(text);
      const e = captured(resolveIn({ VOLLEY_AUTH_DIR: d })) as Error;
      expect(e.message).toContain(join(d, "coordinator.json"));
      expect(e.message).not.toContain(marker);
    }
    expect(captured(resolveIn({ VOLLEY_AUTH_DIR: noUser }))).toMatchObject({
      code: "AUTH_FAILED",
    });
  });

  it.skipIf(process.getuid?.() === 0)(
    "an unreadable coordinator file throws AUTH_FAILED, reported as unreadable (not malformed)",
    () => {
      const dir = authDir({ username: "coordinator", password: "c" });
      chmodSync(join(dir, "coordinator.json"), 0o000);
      const e = captured(resolveIn({ VOLLEY_AUTH_DIR: dir }));
      expect(e).toMatchObject({ code: "AUTH_FAILED" });
      expect((e as Error).message).toContain(join(dir, "coordinator.json"));
      expect((e as Error).message).toMatch(/cannot read/);
      expect((e as Error).message).not.toMatch(/malformed/);
    },
  );

  it("VOLLEY_AUTH_PASSWORD without VOLLEY_AUTH_USERNAME throws AUTH_FAILED", () => {
    expect(captured(resolveIn({ VOLLEY_AUTH_PASSWORD: "x" }))).toMatchObject({
      code: "AUTH_FAILED",
    });
  });

  it("never reads the directory's agent.json (a malformed one cannot break coordinator auth)", () => {
    const dir = makeWorkdir();
    mkdirSync(join(dir, ".volley"), { recursive: true });
    writeFileSync(join(dir, ".volley", "agent.json"), "{bad");
    const target = { mode: "coordinator" as const, projectDir: dir };
    expect(resolveHooksAuth(target, ENV_AUTH)).toEqual({
      username: "from-env",
      password: "env-pw",
    });
    const env = { VOLLEY_AUTH_DIR: authDir({ username: "coordinator", password: "file-pw" }) };
    expect(resolveHooksAuth(target, env)).toEqual({ username: "coordinator", password: "file-pw" });
  });
});

describe("resolveHooksAuth — agent mode credential errors are loud", () => {
  it("an invalid broker block throws AUTH_FAILED", () => {
    const dir = makeWorkdir({ agent_id: AGENT, broker: { password: "no-user" } });
    expect(captured(() => resolveHooksAuth({ mode: "agent", projectDir: dir }, {}))).toMatchObject({
      code: "AUTH_FAILED",
    });
  });
});

function captured(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
}

describe("connectOpts", () => {
  it("adds the resolved credentials to every connect", () => {
    const dir = makeWorkdir({ agent_id: AGENT, broker: { username: AGENT, password: "minted" } });
    const target = {
      mode: "agent" as const,
      projectDir: dir,
      brokerUrl: "mqtt://x",
      agentId: AGENT,
      stateDir: join(dir, ".volley"),
    };
    expect(connectOpts(target, {}, { cleanSession: false })).toEqual({
      url: "mqtt://x",
      agentId: AGENT,
      connectTimeoutMs: 3000,
      cleanSession: false,
      username: AGENT,
      password: "minted",
    });
  });

  it("anonymous: no username/password keys at all", () => {
    const dir = makeWorkdir({ agent_id: AGENT });
    const opts = connectOpts(
      {
        mode: "agent",
        projectDir: dir,
        brokerUrl: "mqtt://x",
        agentId: AGENT,
        stateDir: join(dir, ".volley"),
      },
      {},
    );
    expect(opts).not.toHaveProperty("username");
    expect(opts).not.toHaveProperty("password");
  });
});
