import mqtt from "mqtt";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startLifecycle } from "../../src/lifecycle";
import type { ServerState } from "../../src/state";
import { volRegister } from "../../src/tools/register";
import { type TestBroker, startTestBroker } from "../helpers/aedes-broker";

describe("vol_register", () => {
  let tb: TestBroker;
  let state: ServerState;
  beforeEach(async () => {
    tb = await startTestBroker();
    state = await startLifecycle({
      brokerUrl: tb.url,
      namespace: "test",
      agentId: "reg-aaaa",
      parentId: "coordinator-zzzz",
    });
  });
  afterEach(async () => {
    await state.broker.disconnect();
    await tb.close();
  });

  it("publishes a retained registry entry and flips status + state.registered", async () => {
    const result = await volRegister(state, {
      capabilities: ["implements-issue", "writes-tests"],
      model: "claude-opus-4-7",
      cwd: "/private/tmp/example-issue-42",
    });
    expect(result).toEqual({ agent_id: "reg-aaaa", namespace: "test" });
    expect(state.registered).toBe(true);

    const observer = await mqtt.connectAsync(tb.url, { reconnectPeriod: 0 });
    const registry = await new Promise<string>((resolve) => {
      observer.on("message", (t, p) => {
        if (t === "volley/_system/registry/reg-aaaa") resolve(p.toString());
      });
      observer.subscribe("volley/_system/registry/reg-aaaa", { qos: 1 });
    });
    const env = JSON.parse(registry);
    expect(env.channel).toBe("_system/registry");
    expect(env.type).toBe("registered");
    expect(env.namespace).toBe("test");
    expect(env.parent_id).toBe("coordinator-zzzz");
    expect(env.payload.capabilities).toEqual(["implements-issue", "writes-tests"]);
    expect(env.payload.model).toBe("claude-opus-4-7");
    expect(typeof env.payload.started_at).toBe("string");
    await observer.endAsync();
  });

  it("the registry entry records the Claude account the supervisor launched it under", async () => {
    state.config.claudeAccount = "work";
    await volRegister(state, { capabilities: [] });
    const got = await state.broker.queryRetained("volley/_system/registry/reg-aaaa", 1000);
    expect(JSON.parse(got ?? "{}").payload.claude_account).toBe("work");
  });

  it("carries the coordinator name from VOLLEY_COORDINATOR and returns it", async () => {
    state.config.coordinator = "coord-main";
    const result = await volRegister(state, { capabilities: [] });
    expect(result).toEqual({ agent_id: "reg-aaaa", namespace: "test", coordinator: "coord-main" });
    const got = await state.broker.queryRetained("volley/_system/registry/reg-aaaa", 1000);
    const env = JSON.parse(got ?? "{}");
    expect(env.payload.coordinator).toBe("coord-main");
  });

  it("without VOLLEY_COORDINATOR the entry has no coordinator field", async () => {
    const result = await volRegister(state, { capabilities: [] });
    expect(result).not.toHaveProperty("coordinator");
    const got = await state.broker.queryRetained("volley/_system/registry/reg-aaaa", 1000);
    const env = JSON.parse(got ?? "{}");
    expect(env.payload).not.toHaveProperty("coordinator");
  });

  it("an invalid VOLLEY_COORDINATOR fails vol_register naming the variable", async () => {
    state.config.coordinator = "Coord Main";
    await expect(volRegister(state, { capabilities: [] })).rejects.toMatchObject({
      code: "INVALID_AGENT_ID",
      message: expect.stringMatching(/VOLLEY_COORDINATOR "Coord Main"/),
    });
  });

  it("title and links round-trip into the retained registry payload", async () => {
    const links = {
      repo: "example-org/example-repo",
      issue: 42,
      pr: "https://github.com/example-org/example-repo/pull/57",
    };
    await volRegister(state, {
      capabilities: [],
      title: "#42 T3 fix the login redirect — spec review",
      links,
    });
    const got = await state.broker.queryRetained("volley/_system/registry/reg-aaaa", 1000);
    const payload = JSON.parse(got ?? "{}").payload;
    expect(payload.title).toBe("#42 T3 fix the login redirect — spec review");
    expect(payload.links).toEqual(links);
  });

  it("trims the title; a blank title is none", async () => {
    await volRegister(state, { capabilities: [], title: "  Desk agent purpose line  " });
    const got = await state.broker.queryRetained("volley/_system/registry/reg-aaaa", 1000);
    expect(JSON.parse(got ?? "{}").payload.title).toBe("Desk agent purpose line");
    await volRegister(state, { capabilities: [], title: "   " });
    const blank = await state.broker.queryRetained("volley/_system/registry/reg-aaaa", 1000);
    expect(JSON.parse(blank ?? "{}").payload).not.toHaveProperty("title");
  });

  it("a direct caller's over-long title is cut to SPEC's 120 characters", async () => {
    await volRegister(state, { capabilities: [], title: "y".repeat(300) });
    const got = await state.broker.queryRetained("volley/_system/registry/reg-aaaa", 1000);
    expect(JSON.parse(got ?? "{}").payload.title).toBe("y".repeat(120));
  });

  it("without title or links the payload has neither key (byte-identical to before)", async () => {
    await volRegister(state, { capabilities: ["a"], cwd: "/tmp/x", model: "m" });
    const raw = await state.broker.queryRetained("volley/_system/registry/reg-aaaa", 1000);
    const payload = JSON.parse(raw ?? "{}").payload;
    expect(Object.keys(payload).sort()).toEqual(["capabilities", "cwd", "model", "started_at"]);
  });

  it("publishes a retained status: registered", async () => {
    await volRegister(state, { capabilities: [] });
    const got = await state.broker.queryRetained("volley/test/reg-aaaa/status", 1000);
    expect(JSON.parse(got ?? "{}").type).toBe("registered");
  });

  it("is idempotent — a second call republishes without error", async () => {
    await volRegister(state, { capabilities: ["a"] });
    const result = await volRegister(state, { capabilities: ["a", "b"] });
    expect(result).toEqual({ agent_id: "reg-aaaa", namespace: "test" });
    expect(state.registered).toBe(true);
  });

  it("rejects a malformed parent_id override", async () => {
    await expect(
      volRegister(state, { capabilities: [], parent_id: "Bad ID" }),
    ).rejects.toMatchObject({
      code: "INVALID_AGENT_ID",
    });
  });

  it("explicit parent_id: null overrides a non-null config.parentId", async () => {
    await volRegister(state, { capabilities: [], parent_id: null });

    const observer = await mqtt.connectAsync(tb.url, { reconnectPeriod: 0 });
    const registry = await new Promise<string>((resolve) => {
      observer.on("message", (t, p) => {
        if (t === "volley/_system/registry/reg-aaaa") resolve(p.toString());
      });
      observer.subscribe("volley/_system/registry/reg-aaaa", { qos: 1 });
    });
    await observer.endAsync();

    const env = JSON.parse(registry);
    expect(env.parent_id).toBeNull();

    const status = await state.broker.queryRetained("volley/test/reg-aaaa/status", 1000);
    expect(JSON.parse(status ?? "{}").parent_id).toBeNull();
  });
});
