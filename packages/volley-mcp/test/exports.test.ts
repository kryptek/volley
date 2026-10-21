import { describe, expect, it } from "vitest";

describe("volley-mcp package exports", () => {
  it("exposes the wire-protocol modules as subpath imports", async () => {
    const broker = await import("volley-mcp/broker");
    const topics = await import("volley-mcp/topics");
    const envelope = await import("volley-mcp/envelope");
    const channels = await import("volley-mcp/channels");
    const errors = await import("volley-mcp/errors");
    const config = await import("volley-mcp/config");
    const util = await import("volley-mcp/util");
    const mask = await import("volley-mcp/mask");

    expect(typeof broker.VolleyBroker).toBe("function");
    expect(typeof topics.buildTopic).toBe("function");
    expect(typeof envelope.buildEnvelope).toBe("function");
    expect(typeof channels.channelConfigFor).toBe("function");
    expect(typeof errors.VolleyError).toBe("function");
    expect(typeof config.loadConfig).toBe("function");
    expect(typeof util.randomSuffix).toBe("function");
    expect(typeof mask.maskEmail).toBe("function");
  });
});
