import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectOpts, resolveHooksAuth } from "../src/lib/auth";
import { makeWorkdir } from "./helpers/hooks";

const AGENT = "w1-t1-implementer-1";
const ENV_AUTH = { VOLLEY_AUTH_USERNAME: "from-env", VOLLEY_AUTH_PASSWORD: "env-pw" };

function authDir(creds?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "volley-hooks-authdir-"));
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
  const projectDir = makeWorkdir();

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

  it("a malformed coordinator file throws, naming the path", () => {
    const dir = authDir("{not json");
    expect(() =>
      resolveHooksAuth({ mode: "coordinator", projectDir }, { VOLLEY_AUTH_DIR: dir }),
    ).toThrow(join(dir, "coordinator.json"));
    const noUser = authDir({ password: "x" });
    expect(() =>
      resolveHooksAuth({ mode: "coordinator", projectDir }, { VOLLEY_AUTH_DIR: noUser }),
    ).toThrow(/username/);
  });
});

describe("connectOpts", () => {
  it("adds the resolved credentials to every connect", () => {
    const dir = makeWorkdir({ agent_id: AGENT, broker: { username: AGENT, password: "minted" } });
    const target = {
      mode: "agent" as const,
      projectDir: dir,
      brokerUrl: "mqtt://x",
      agentId: AGENT,
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
      { mode: "agent", projectDir: dir, brokerUrl: "mqtt://x", agentId: AGENT },
      {},
    );
    expect(opts).not.toHaveProperty("username");
    expect(opts).not.toHaveProperty("password");
  });
});
