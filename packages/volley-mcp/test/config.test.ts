import { describe, expect, it } from "vitest";
import { generateAgentId, loadConfig } from "../src/config";

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
