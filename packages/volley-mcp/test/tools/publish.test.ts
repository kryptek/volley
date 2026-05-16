import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startLifecycle } from "../../src/lifecycle";
import type { ServerState } from "../../src/state";
import { volPublish } from "../../src/tools/publish";
import { type TestBroker, startTestBroker } from "../helpers/aedes-broker";

describe("vol_publish", () => {
  let tb: TestBroker;
  let state: ServerState;
  beforeEach(async () => {
    tb = await startTestBroker();
    state = await startLifecycle({
      brokerUrl: tb.url,
      namespace: "test",
      agentId: "pub-aaaa",
      parentId: null,
    });
  });
  afterEach(async () => {
    await state.broker.disconnect();
    await tb.close();
  });

  it("rejects with NOT_REGISTERED if state.registered has been cleared", async () => {
    state.registered = false;
    await expect(volPublish(state, { channel: "progress", type: "tick" })).rejects.toMatchObject({
      code: "NOT_REGISTERED",
    });
  });

  it("publishes a retained status message and reports retained: true", async () => {
    state.registered = true;
    const res = await volPublish(state, {
      channel: "status",
      type: "working",
      payload: { issue: 929 },
    });
    expect(res.topic).toBe("volley/test/pub-aaaa/status");
    expect(res.retained).toBe(true);
    expect(typeof res.message_id).toBe("string");

    const got = await state.broker.queryRetained("volley/test/pub-aaaa/status", 1000);
    const env = JSON.parse(got ?? "{}");
    expect(env.type).toBe("working");
    expect(env.payload).toEqual({ issue: 929 });
    expect(env.agent_id).toBe("pub-aaaa");
  });

  it("publishes a fire-and-forget progress message (retained: false)", async () => {
    state.registered = true;
    const res = await volPublish(state, { channel: "progress", type: "tests-green" });
    expect(res.retained).toBe(false);
    expect(await state.broker.queryRetained(res.topic, 500)).toBeNull();
  });

  it("accepts a _user/* channel", async () => {
    state.registered = true;
    const res = await volPublish(state, { channel: "_user/metrics", type: "sample" });
    expect(res.topic).toBe("volley/test/pub-aaaa/_user/metrics");
    expect(res.retained).toBe(false);
  });

  it("rejects an unknown channel with INVALID_TOPIC", async () => {
    state.registered = true;
    await expect(volPublish(state, { channel: "bogus", type: "x" })).rejects.toMatchObject({
      code: "INVALID_TOPIC",
    });
  });
});
