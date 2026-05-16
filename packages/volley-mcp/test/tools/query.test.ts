import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startLifecycle } from "../../src/lifecycle";
import type { ServerState } from "../../src/state";
import { volQuery } from "../../src/tools/query";
import { type TestBroker, startTestBroker } from "../helpers/aedes-broker";

describe("vol_query", () => {
  let tb: TestBroker;
  let state: ServerState;
  beforeEach(async () => {
    tb = await startTestBroker();
    state = await startLifecycle({
      brokerUrl: tb.url,
      namespace: "test",
      agentId: "qry-aaaa",
      parentId: null,
    });
  });
  afterEach(async () => {
    await state.broker.disconnect();
    await tb.close();
  });

  it("returns the retained envelope and its wall_time as last_seen", async () => {
    const res = await volQuery(state, { topic: "volley/test/qry-aaaa/status" });
    expect(res.topic).toBe("volley/test/qry-aaaa/status");
    expect((res.payload as { type: string }).type).toBe("registered");
    expect(typeof res.last_seen).toBe("string");
  });

  it("returns null payload + null last_seen when no retained value exists", async () => {
    const res = await volQuery(state, { topic: "volley/test/qry-aaaa/result" });
    expect(res).toEqual({ topic: "volley/test/qry-aaaa/result", payload: null, last_seen: null });
  });

  it("surfaces a non-envelope retained value as a raw string", async () => {
    await state.broker.publish("volley/test/qry-aaaa/_user/raw", "not-json", {
      qos: 1,
      retain: true,
    });
    const res = await volQuery(state, { topic: "volley/test/qry-aaaa/_user/raw" });
    expect(res.payload).toBe("not-json");
    expect(res.last_seen).toBeNull();
  });
});
