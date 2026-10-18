import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateAgentId, loadConfig, resolveBrokerAuth } from "../src/config";

describe("generateAgentId", () => {
  it("derives a conforming id from the cwd basename plus a 4-char suffix", () => {
    expect(generateAgentId("/private/tmp/example-issue-929")).toMatch(
      /^example-issue-929-[a-z0-9]{4}$/,
    );
  });
  it("sanitizes non-conforming characters", () => {
    expect(generateAgentId("/Users/Someone/My Project!")).toMatch(/^my-project-[a-z0-9]{4}$/);
  });
  it("falls back to 'agent' when the basename sanitizes to empty", () => {
    expect(generateAgentId("/!!!")).toMatch(/^agent-[a-z0-9]{4}$/);
  });
  it("produces a fresh suffix each call", () => {
    expect(generateAgentId("/x/proj")).not.toBe(generateAgentId("/x/proj"));
  });
});

describe("loadConfig", () => {
  it("uses defaults when env is empty", () => {
    const c = loadConfig({}, "/private/tmp/demo");
    expect(c.brokerUrl).toBe("mqtt://localhost:1883");
    expect(c.namespace).toBe("default");
    expect(c.agentId).toMatch(/^demo-[a-z0-9]{4}$/);
    expect(c.parentId).toBeNull();
  });
  it("honors VOLLEY_* overrides", () => {
    const c = loadConfig(
      {
        VOLLEY_BROKER_URL: "mqtt://broker.local:1883",
        VOLLEY_NAMESPACE: "example-dispatch",
        VOLLEY_AGENT_ID: "issue-42-fix-7a3f",
        VOLLEY_PARENT_ID: "coordinator-abcd",
      },
      "/ignored",
    );
    expect(c.brokerUrl).toBe("mqtt://broker.local:1883");
    expect(c.namespace).toBe("example-dispatch");
    expect(c.agentId).toMatch(/^issue-42-fix-7a3f-[a-z0-9]{4}$/);
    expect(c.parentId).toBe("coordinator-abcd");
  });
  it("rejects a malformed VOLLEY_AGENT_ID", () => {
    expect(() => loadConfig({ VOLLEY_AGENT_ID: "Bad ID" }, "/x")).toThrow(/VOLLEY_AGENT_ID/);
  });
  it("rejects a malformed VOLLEY_NAMESPACE", () => {
    expect(() => loadConfig({ VOLLEY_NAMESPACE: "_system" }, "/x")).toThrow(/VOLLEY_NAMESPACE/);
  });
});

describe("VOLLEY_AGENT_ID is a prefix; agent_id auto-suffixes", () => {
  // For each case: pass env explicitly to loadConfig(), assert the agent_id shape.
  // Suffix alphabet is the existing util.randomSuffix shape: [a-z0-9]{4}.

  it("bare role becomes role + suffix", () => {
    const c = loadConfig({ VOLLEY_AGENT_ID: "coordinator" }, "/x");
    expect(c.agentId).toMatch(/^coordinator-[a-z0-9]{4}$/);
  });

  it("pre-suffixed prefix gets ANOTHER suffix appended (no special-casing)", () => {
    const c = loadConfig({ VOLLEY_AGENT_ID: "coordinator-base" }, "/x");
    expect(c.agentId).toMatch(/^coordinator-base-[a-z0-9]{4}$/);
  });

  it("two successive loadConfig() calls produce distinct agent_ids", () => {
    const a = loadConfig({ VOLLEY_AGENT_ID: "coordinator" }, "/x").agentId;
    const b = loadConfig({ VOLLEY_AGENT_ID: "coordinator" }, "/x").agentId;
    expect(a).not.toBe(b);
    expect(a).toMatch(/^coordinator-[a-z0-9]{4}$/);
    expect(b).toMatch(/^coordinator-[a-z0-9]{4}$/);
  });

  it("rejects a prefix that would produce an out-of-grammar agent_id (too long)", () => {
    // 59-char prefix + "-" + 4 = 64 chars total > 63 grammar max
    expect(() => loadConfig({ VOLLEY_AGENT_ID: "a".repeat(59) }, "/x")).toThrow(/VOLLEY_AGENT_ID/);
  });

  it("rejects a prefix with invalid characters (uppercase, space, !)", () => {
    expect(() => loadConfig({ VOLLEY_AGENT_ID: "Coord!nator" }, "/x")).toThrow(/VOLLEY_AGENT_ID/);
    expect(() => loadConfig({ VOLLEY_AGENT_ID: "Coordinator" }, "/x")).toThrow(/VOLLEY_AGENT_ID/);
    expect(() => loadConfig({ VOLLEY_AGENT_ID: "has space" }, "/x")).toThrow(/VOLLEY_AGENT_ID/);
  });

  it("accepts a single-character prefix and produces a 6-char agent_id", () => {
    const c = loadConfig({ VOLLEY_AGENT_ID: "x" }, "/x");
    expect(c.agentId).toMatch(/^x-[a-z0-9]{4}$/);
    expect(c.agentId.length).toBe(6);
  });

  it("accepts the maximum 58-char prefix and produces a 63-char agent_id", () => {
    const prefix58 = "a".repeat(58);
    const c = loadConfig({ VOLLEY_AGENT_ID: prefix58 }, "/x");
    expect(c.agentId).toMatch(new RegExp(`^${prefix58}-[a-z0-9]{4}$`));
    expect(c.agentId.length).toBe(63);
  });
});

describe(".volley/agent.json assigned identity (SPEC §6.5)", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "volley-identity-"));
    mkdirSync(join(cwd, ".volley"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });
  const writeIdentity = (body: string) => writeFileSync(join(cwd, ".volley", "agent.json"), body);

  it("uses the literal agent_id, namespace and parent_id from the file (no suffix)", () => {
    writeIdentity(
      JSON.stringify({
        agent_id: "w1-t1-implementer-1",
        namespace: "dispatch",
        parent_id: "coordinator-ab12",
      }),
    );
    const c = loadConfig({}, cwd);
    expect(c.agentId).toBe("w1-t1-implementer-1");
    expect(c.namespace).toBe("dispatch");
    expect(c.parentId).toBe("coordinator-ab12");
    expect(c.brokerUrl).toBe("mqtt://localhost:1883");
  });

  it("file wins over VOLLEY_AGENT_ID / VOLLEY_NAMESPACE / VOLLEY_PARENT_ID / VOLLEY_BROKER_URL", () => {
    writeIdentity(
      JSON.stringify({
        agent_id: "w1-t1-implementer-1",
        namespace: "dispatch",
        parent_id: "coordinator-ab12",
        broker_url: "mqtt://127.0.0.1:2883",
      }),
    );
    const c = loadConfig(
      {
        VOLLEY_AGENT_ID: "coordinator",
        VOLLEY_NAMESPACE: "default",
        VOLLEY_PARENT_ID: "someone-else",
        VOLLEY_BROKER_URL: "mqtt://localhost:1883",
      },
      cwd,
    );
    expect(c.agentId).toBe("w1-t1-implementer-1");
    expect(c.namespace).toBe("dispatch");
    expect(c.parentId).toBe("coordinator-ab12");
    expect(c.brokerUrl).toBe("mqtt://127.0.0.1:2883");
  });

  it("keys absent from the file fall back to env, then defaults", () => {
    writeIdentity(JSON.stringify({ agent_id: "w1-t1-implementer-1" }));
    const c = loadConfig({ VOLLEY_NAMESPACE: "example-dispatch" }, cwd);
    expect(c.agentId).toBe("w1-t1-implementer-1");
    expect(c.namespace).toBe("example-dispatch");
    expect(c.parentId).toBeNull();
  });

  it("an explicit null parent_id in the file wins over VOLLEY_PARENT_ID", () => {
    writeIdentity(JSON.stringify({ agent_id: "w1-t1-implementer-1", parent_id: null }));
    expect(loadConfig({ VOLLEY_PARENT_ID: "coordinator-ab12" }, cwd).parentId).toBeNull();
  });

  it("throws a clear error naming the path when the file is malformed JSON", () => {
    writeIdentity("{ not json");
    expect(() => loadConfig({}, cwd)).toThrow(join(cwd, ".volley", "agent.json"));
  });

  it("throws when the file is not an object or lacks agent_id", () => {
    writeIdentity("[]");
    expect(() => loadConfig({}, cwd)).toThrow(/must be a JSON object/);
    writeIdentity(JSON.stringify({ namespace: "dispatch" }));
    expect(() => loadConfig({}, cwd)).toThrow(/must set agent_id to a string/);
    writeIdentity(JSON.stringify({ agent_id: 42 }));
    expect(() => loadConfig({}, cwd)).toThrow(/must set agent_id to a string/);
  });

  it("throws an INVALID_AGENT_ID error when agent_id violates the §2.2 grammar", () => {
    for (const agent_id of ["W1-T1-Implementer", "a".repeat(64)]) {
      writeIdentity(JSON.stringify({ agent_id }));
      expect(() => loadConfig({}, cwd)).toThrow(
        expect.objectContaining({
          code: "INVALID_AGENT_ID",
          message: expect.stringContaining(join(cwd, ".volley", "agent.json")),
        }),
      );
    }
  });

  it("rejects a non-string or empty broker_url in the file", () => {
    for (const broker_url of ["", 1883]) {
      writeIdentity(JSON.stringify({ agent_id: "w1-t1-implementer-1", broker_url }));
      expect(() => loadConfig({}, cwd)).toThrow(/broker_url must be a non-empty string/);
    }
  });

  it("rejects an out-of-grammar namespace or parent_id in the file", () => {
    writeIdentity(JSON.stringify({ agent_id: "w1-t1-implementer-1", namespace: "_system" }));
    expect(() => loadConfig({}, cwd)).toThrow(/namespace/);
    writeIdentity(JSON.stringify({ agent_id: "w1-t1-implementer-1", parent_id: "Bad Parent" }));
    expect(() => loadConfig({}, cwd)).toThrow(/parent_id/);
  });

  it("a cwd without .volley/agent.json keeps the env-prefix behavior", () => {
    rmSync(join(cwd, ".volley"), { recursive: true });
    expect(loadConfig({ VOLLEY_AGENT_ID: "coordinator" }, cwd).agentId).toMatch(
      /^coordinator-[a-z0-9]{4}$/,
    );
  });
});

describe("broker credentials (VOLLEY_AUTH_* and the identity file broker block)", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "volley-auth-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });
  const writeIdentity = (body: unknown) => {
    mkdirSync(join(cwd, ".volley"), { recursive: true });
    writeFileSync(join(cwd, ".volley", "agent.json"), JSON.stringify(body));
  };

  it("carries no credentials when neither env nor identity file sets them", () => {
    expect(loadConfig({}, cwd).auth).toBeUndefined();
    expect(resolveBrokerAuth({}, cwd)).toBeNull();
  });

  it("VOLLEY_AUTH_USERNAME / VOLLEY_AUTH_PASSWORD land on the config", () => {
    const env = { VOLLEY_AUTH_USERNAME: "coordinator", VOLLEY_AUTH_PASSWORD: "s3cret" };
    expect(loadConfig(env, cwd).auth).toEqual({ username: "coordinator", password: "s3cret" });
    expect(resolveBrokerAuth(env, cwd)).toEqual({ username: "coordinator", password: "s3cret" });
  });

  it("a username without a password is passed through (brokers may not require one)", () => {
    expect(loadConfig({ VOLLEY_AUTH_USERNAME: "desk" }, cwd).auth).toEqual({ username: "desk" });
  });

  it("refuses a password without a username", () => {
    expect(() => loadConfig({ VOLLEY_AUTH_PASSWORD: "s3cret" }, cwd)).toThrow(
      /VOLLEY_AUTH_PASSWORD is set but VOLLEY_AUTH_USERNAME is not/,
    );
  });

  it("the identity file broker block wins over VOLLEY_AUTH_*", () => {
    writeIdentity({
      agent_id: "w1-t1-implementer-1",
      broker: { username: "w1-t1-implementer-1", password: "minted" },
    });
    const env = { VOLLEY_AUTH_USERNAME: "coordinator", VOLLEY_AUTH_PASSWORD: "s3cret" };
    const want = { username: "w1-t1-implementer-1", password: "minted" };
    expect(loadConfig(env, cwd).auth).toEqual(want);
    expect(resolveBrokerAuth(env, cwd)).toEqual(want);
  });

  it("an identity file without a broker block falls back to VOLLEY_AUTH_*", () => {
    writeIdentity({ agent_id: "w1-t1-implementer-1" });
    expect(loadConfig({ VOLLEY_AUTH_USERNAME: "coordinator" }, cwd).auth).toEqual({
      username: "coordinator",
    });
  });

  it("rejects a malformed broker block, naming the file", () => {
    for (const broker of [
      "user:pass",
      { username: "", password: "x" },
      { username: "a" },
      { username: "a", password: 1 },
    ]) {
      writeIdentity({ agent_id: "w1-t1-implementer-1", broker });
      expect(() => loadConfig({}, cwd)).toThrow(
        new RegExp(`${join(cwd, ".volley", "agent.json")}: broker`),
      );
    }
  });
});
