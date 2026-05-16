import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startLifecycle } from "../../src/lifecycle";
import type { ServerState } from "../../src/state";
import { volTap } from "../../src/tools/tap";
import { type TestBroker, startTestBroker } from "../helpers/aedes-broker";

describe("vol_tap", () => {
  let tb: TestBroker;
  let state: ServerState;
  beforeEach(async () => {
    tb = await startTestBroker();
    state = await startLifecycle({
      brokerUrl: tb.url,
      namespace: "test",
      agentId: "tap-aaaa",
      parentId: null,
    });
  });
  afterEach(async () => {
    await state.broker.disconnect();
    await tb.close();
  });

  it("collects everything matching a wildcard with debug-tuned defaults", async () => {
    const res = await volTap(state, { topic_pattern: "volley/test/+/status", timeout_ms: 500 });
    expect(res.messages.length).toBeGreaterThanOrEqual(1);
    expect(res.messages[0]?.topic).toBe("volley/test/tap-aaaa/status");
    expect(res.messages[0]?.envelope?.type).toBe("registered");
  });

  it("defaults max_messages to 100 and timeout to 5000 (collects then times out)", async () => {
    const start = Date.now();
    const res = await volTap(state, { topic_pattern: "volley/test/+/_user/none" });
    expect(res.messages).toEqual([]);
    expect(Date.now() - start).toBeGreaterThanOrEqual(4500);
    expect(Date.now() - start).toBeLessThan(8000);
  });

  it("rejects an invalid topic pattern with INVALID_TOPIC", async () => {
    await expect(volTap(state, { topic_pattern: "" })).rejects.toMatchObject({
      code: "INVALID_TOPIC",
    });
  });
});
