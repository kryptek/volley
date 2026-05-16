import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { type TestBroker, startTestBroker } from "../helpers/aedes-broker";
import { runCli } from "../helpers/run-cli";

async function publisherFor(tb: TestBroker, agentId: string): Promise<VolleyBroker> {
  const b = new VolleyBroker();
  await b.connect({
    url: tb.url,
    agentId,
    willTopic: `volley/_meta/cli/${agentId}/will`,
    willPayload: "",
  });
  return b;
}

function envelope(agentId: string, channel: string, type: string): string {
  return JSON.stringify(buildEnvelope({ agentId, parentId: null, channel, type, payload: {} }));
}

describe("volley sub", () => {
  let tb: TestBroker;
  let pubA: VolleyBroker;
  beforeEach(async () => {
    tb = await startTestBroker();
    pubA = await publisherFor(tb, "pub-a");
  });
  afterEach(async () => {
    await pubA.disconnect();
    await tb.close();
  });

  it("collects max-messages then exits 0 with one JSONL line per message", async () => {
    // Pre-publish two retained status envelopes so they arrive immediately on subscribe.
    await pubA.publish("volley/test/a-1/status", envelope("a-1", "status", "working"), {
      qos: 1,
      retain: true,
    });
    await pubA.publish("volley/test/a-2/status", envelope("a-2", "status", "done"), {
      qos: 1,
      retain: true,
    });

    const r = await runCli({
      argv: [
        "sub",
        "--broker-url",
        tb.url,
        "--pattern",
        "volley/test/+/status",
        "--max-messages",
        "2",
        "--timeout",
        "5",
      ],
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");

    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l));
    const topics = parsed.map((p: { topic: string }) => p.topic).sort();
    expect(topics).toEqual(["volley/test/a-1/status", "volley/test/a-2/status"]);
    expect(parsed[0]).toHaveProperty("envelope");
  });

  it("on timeout with no messages, exits 124 and emits no stdout", async () => {
    const r = await runCli({
      argv: [
        "sub",
        "--broker-url",
        tb.url,
        "--pattern",
        "volley/empty/+/status",
        "--max-messages",
        "1",
        "--timeout",
        "1",
      ],
    });
    expect(r.exitCode).toBe(124);
    expect(r.stdout).toBe("");
  });

  it("rejects an invalid topic filter with exit 2", async () => {
    const r = await runCli({
      argv: [
        "sub",
        "--broker-url",
        tb.url,
        "--pattern",
        "volley/test/#/status",
        "--max-messages",
        "1",
        "--timeout",
        "1",
      ],
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("invalid topic filter");
  });
});
