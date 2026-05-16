import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startLifecycle } from "../../src/lifecycle";
import type { ServerState } from "../../src/state";
import { volSubscribe } from "../../src/tools/subscribe";
import { type TestBroker, startTestBroker } from "../helpers/aedes-broker";

describe("vol_subscribe", () => {
  let tb: TestBroker;
  let state: ServerState;
  beforeEach(async () => {
    tb = await startTestBroker();
    state = await startLifecycle({
      brokerUrl: tb.url,
      namespace: "test",
      agentId: "sub-aaaa",
      parentId: null,
    });
  });
  afterEach(async () => {
    await state.broker.disconnect();
    await tb.close();
  });

  it("collects retained messages and parses them into envelopes", async () => {
    const res = await volSubscribe(state, {
      topic_pattern: "volley/test/sub-aaaa/status",
      max_messages: 1,
      timeout_ms: 1000,
    });
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0]?.topic).toBe("volley/test/sub-aaaa/status");
    expect(res.messages[0]?.envelope?.type).toBe("registered");
    expect(typeof res.messages[0]?.raw).toBe("string");
  });

  it("returns a partial collection when the timeout elapses", async () => {
    const res = await volSubscribe(state, {
      topic_pattern: "volley/test/sub-aaaa/_user/never",
      max_messages: 5,
      timeout_ms: 400,
    });
    expect(res.messages).toEqual([]);
  });

  it("rejects an invalid topic pattern with INVALID_TOPIC", async () => {
    await expect(volSubscribe(state, { topic_pattern: "volley/#/status" })).rejects.toMatchObject({
      code: "INVALID_TOPIC",
    });
  });

  it("surfaces a non-envelope message with envelope: null but raw preserved", async () => {
    const collecting = volSubscribe(state, {
      topic_pattern: "volley/test/sub-aaaa/_user/raw",
      max_messages: 1,
      timeout_ms: 2000,
    });
    await new Promise((r) => setTimeout(r, 100));
    await state.broker.publish("volley/test/sub-aaaa/_user/raw", "plain text", {
      qos: 0,
      retain: false,
    });
    const res = await collecting;
    expect(res.messages[0]?.envelope).toBeNull();
    expect(res.messages[0]?.raw).toBe("plain text");
  });
});
