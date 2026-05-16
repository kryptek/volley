import mqtt from "mqtt";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VolleyConfig } from "../src/config";
import { shutdownLifecycle, startLifecycle } from "../src/lifecycle";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";

function cfg(tb: TestBroker, agentId: string): VolleyConfig {
  return { brokerUrl: tb.url, namespace: "test", agentId, parentId: null };
}

describe("startLifecycle", () => {
  let tb: TestBroker;
  beforeEach(async () => {
    tb = await startTestBroker();
  });
  afterEach(async () => {
    await tb.close();
  });

  it("connects, publishes spawning, then auto-registers (final retained status: registered)", async () => {
    const state = await startLifecycle(cfg(tb, "life-aaaa"));
    expect(state.broker.connected).toBe(true);
    expect(state.registered).toBe(true);

    const observer = await mqtt.connectAsync(tb.url, { reconnectPeriod: 0 });
    const got = new Promise<string>((resolve) => {
      observer.on("message", (t, p) => {
        if (t === "volley/test/life-aaaa/status") resolve(p.toString());
      });
    });
    await observer.subscribeAsync("volley/test/life-aaaa/status", { qos: 1 });
    const env = JSON.parse(await got);
    expect(env.type).toBe("registered");
    expect(env.channel).toBe("status");
    expect(env.agent_id).toBe("life-aaaa");
    expect(env.schema_version).toBe("0.1");

    const registry = await state.broker.queryRetained("volley/_system/registry/life-aaaa", 1000);
    const reg = JSON.parse(registry ?? "{}");
    expect(reg.channel).toBe("_system/registry");
    expect(reg.namespace).toBe("test");
    expect(reg.payload.capabilities).toEqual([]);
    expect(typeof reg.payload.cwd).toBe("string");

    await observer.endAsync();
    await state.broker.disconnect();
  });

  it("publishes spawning before auto-register (sequence is observable to a subscriber attached pre-startLifecycle)", async () => {
    const observer = await mqtt.connectAsync(tb.url, { reconnectPeriod: 0 });
    const seen: string[] = [];
    observer.on("message", (t, p) => {
      if (t === "volley/test/life-seq/status") seen.push(JSON.parse(p.toString()).type);
    });
    await observer.subscribeAsync("volley/test/life-seq/status", { qos: 1 });

    const state = await startLifecycle(cfg(tb, "life-seq"));
    await new Promise((r) => setTimeout(r, 200));
    expect(seen[0]).toBe("spawning");
    expect(seen[1]).toBe("registered");

    await observer.endAsync();
    await state.broker.disconnect();
  });

  it("arms the LWT so an ungraceful exit yields a retained status: reaped", async () => {
    const state = await startLifecycle(cfg(tb, "life-bbbb"));
    const observer = await mqtt.connectAsync(tb.url, { reconnectPeriod: 0 });
    const reaped = new Promise<string>((resolve) => {
      observer.on("message", (t, p) => {
        const env = JSON.parse(p.toString());
        if (t === "volley/test/life-bbbb/status" && env.type === "reaped") resolve(p.toString());
      });
    });
    await observer.subscribeAsync("volley/test/life-bbbb/status", { qos: 1 });
    state.broker.simulateCrash();
    const env = JSON.parse(await reaped);
    expect(env.type).toBe("reaped");
    expect(env.payload).toMatchObject({ reason: "disconnect" });
    await observer.endAsync();
  });

  it("throws BROKER_DOWN when the broker is unreachable", async () => {
    await expect(
      startLifecycle({
        brokerUrl: "mqtt://127.0.0.1:1",
        namespace: "test",
        agentId: "life-cccc",
        parentId: null,
      }),
    ).rejects.toMatchObject({ code: "BROKER_DOWN" });
  });
});

describe("shutdownLifecycle", () => {
  let tb: TestBroker;
  beforeEach(async () => {
    tb = await startTestBroker();
  });
  afterEach(async () => {
    await tb.close();
  });

  it("publishes a retained terminal status and disconnects cleanly (no LWT)", async () => {
    const state = await startLifecycle(cfg(tb, "down-aaaa"));

    const observer = await mqtt.connectAsync(tb.url, { reconnectPeriod: 0 });
    const seen: string[] = [];
    observer.on("message", (t, p) => {
      if (t === "volley/test/down-aaaa/status") seen.push(JSON.parse(p.toString()).type);
    });
    await observer.subscribeAsync("volley/test/down-aaaa/status", { qos: 1 });

    await shutdownLifecycle(state, "done");
    expect(state.broker.connected).toBe(false);

    await new Promise((r) => setTimeout(r, 400));
    expect(seen).toContain("done");
    expect(seen).not.toContain("reaped");
    await observer.endAsync();
  });

  it("defaults the terminal type to done and is a no-op when already disconnected", async () => {
    const state = await startLifecycle(cfg(tb, "down-bbbb"));
    await shutdownLifecycle(state);
    await shutdownLifecycle(state);
    expect(state.broker.connected).toBe(false);
  });
});
