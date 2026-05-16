import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { parseEnvelope } from "volley-mcp/envelope";
import { type TestBroker, startTestBroker } from "../helpers/aedes-broker";
import { runCli } from "../helpers/run-cli";

describe("volley pub", () => {
  let tb: TestBroker;
  let inspector: VolleyBroker;
  beforeEach(async () => {
    tb = await startTestBroker();
    inspector = new VolleyBroker();
    await inspector.connect({
      url: tb.url,
      agentId: "inspector",
      willTopic: "volley/_meta/inspector/will",
      willPayload: "",
    });
  });
  afterEach(async () => {
    await inspector.disconnect();
    await tb.close();
  });

  it("publishes a retained status envelope to volley/<ns>/<id>/status", async () => {
    const r = await runCli({
      argv: [
        "pub",
        "--broker-url",
        tb.url,
        "--namespace",
        "test",
        "--agent-id",
        "issue-42-fix-7a3f",
        "--channel",
        "status",
        "--type",
        "working",
        "--payload",
        '{"started_at":"2026-05-14T02:11:23.000Z"}',
      ],
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");

    const raw = await inspector.queryRetained("volley/test/issue-42-fix-7a3f/status");
    expect(raw).not.toBeNull();
    const env = parseEnvelope(raw as string);
    expect(env).not.toBeNull();
    expect(env?.agent_id).toBe("issue-42-fix-7a3f");
    expect(env?.channel).toBe("status");
    expect(env?.type).toBe("working");
    expect(env?.payload).toEqual({ started_at: "2026-05-14T02:11:23.000Z" });
  });

  it("publishes a non-retained progress envelope", async () => {
    // Subscribe FIRST — progress is not retained, so a queryRetained after the fact returns null.
    const sub = inspector.subscribeCollect("volley/test/+/progress", 1, 2000);

    const r = await runCli({
      argv: [
        "pub",
        "--broker-url",
        tb.url,
        "--namespace",
        "test",
        "--agent-id",
        "a-aaaa",
        "--channel",
        "progress",
        "--type",
        "tests-green",
      ],
    });
    expect(r.exitCode).toBe(0);

    const collected = await sub;
    expect(collected).toHaveLength(1);
    expect(parseEnvelope(collected[0]?.payload ?? "")?.type).toBe("tests-green");
  });

  it("publishes to a _user/* channel as fire-and-forget", async () => {
    const sub = inspector.subscribeCollect("volley/test/+/_user/metrics", 1, 2000);
    const r = await runCli({
      argv: [
        "pub",
        "--broker-url",
        tb.url,
        "--namespace",
        "test",
        "--agent-id",
        "a-aaaa",
        "--channel",
        "_user/metrics",
        "--type",
        "heap",
        "--payload",
        '{"mb":42}',
      ],
    });
    expect(r.exitCode).toBe(0);
    expect(await sub).toHaveLength(1);
  });

  it("refuses to publish to a reserved namespace and exits 1", async () => {
    const r = await runCli({
      argv: [
        "pub",
        "--broker-url",
        tb.url,
        "--agent-id",
        "a-aaaa",
        "--channel",
        "_system/registry",
        "--type",
        "registered",
      ],
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("RESERVED_TOPIC_WRITE");
  });

  it("rejects an unknown channel and exits 1", async () => {
    const r = await runCli({
      argv: [
        "pub",
        "--broker-url",
        tb.url,
        "--agent-id",
        "a-aaaa",
        "--channel",
        "bogus",
        "--type",
        "x",
      ],
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("unknown channel");
  });

  it("rejects an invalid agent_id and exits 2 (USAGE)", async () => {
    const r = await runCli({
      argv: [
        "pub",
        "--broker-url",
        tb.url,
        "--agent-id",
        "Bad Id",
        "--channel",
        "status",
        "--type",
        "done",
      ],
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("agent_id");
  });
});
