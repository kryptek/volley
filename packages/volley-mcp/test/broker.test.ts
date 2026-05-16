import mqtt from "mqtt";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "../src/broker";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";

describe("VolleyBroker connect / disconnect / LWT", () => {
  let tb: TestBroker;
  beforeEach(async () => {
    tb = await startTestBroker();
  });
  afterEach(async () => {
    await tb.close();
  });

  it("connects to a reachable broker", async () => {
    const b = new VolleyBroker();
    await b.connect({
      url: tb.url,
      agentId: "agent-aaaa",
      willTopic: "volley/test/agent-aaaa/status",
      willPayload: '{"type":"reaped"}',
    });
    expect(b.connected).toBe(true);
    await b.disconnect();
    expect(b.connected).toBe(false);
  });

  it("throws BROKER_DOWN when the broker is unreachable", async () => {
    const b = new VolleyBroker();
    await expect(
      b.connect({
        url: "mqtt://127.0.0.1:1",
        agentId: "agent-aaaa",
        willTopic: "volley/test/agent-aaaa/status",
        willPayload: '{"type":"reaped"}',
        connectTimeoutMs: 1500,
      }),
    ).rejects.toMatchObject({ code: "BROKER_DOWN" });
  });

  it("fires the LWT on an ungraceful disconnect (simulateCrash)", async () => {
    const willTopic = "volley/test/agent-bbbb/status";
    const willPayload = JSON.stringify({ schema_version: "0.1", type: "reaped" });

    const observer = await mqtt.connectAsync(tb.url, { reconnectPeriod: 0 });
    const received = new Promise<string>((resolve) => {
      observer.on("message", (t, p) => {
        if (t === willTopic) resolve(p.toString());
      });
    });
    await observer.subscribeAsync(willTopic, { qos: 1 });

    const b = new VolleyBroker();
    await b.connect({ url: tb.url, agentId: "agent-bbbb", willTopic, willPayload });
    b.simulateCrash();

    expect(await received).toBe(willPayload);
    await observer.endAsync();
  });

  it("uses a random clientId suffix so two same-agent_id connects coexist without kicking each other", async () => {
    // Two MCP processes can share one VOLLEY_AGENT_ID (user-scope MCP config
    // inherited by every Claude Code session on the same machine). Without a
    // per-connection suffix, both produce clientId "volley-<agentId>" and the
    // broker is required by the MQTT spec to disconnect the older client.
    const a = new VolleyBroker();
    const b = new VolleyBroker();
    await a.connect({
      url: tb.url,
      agentId: "concurrent-aaaa",
      willTopic: "volley/test/concurrent-aaaa/status",
      willPayload: '{"type":"reaped"}',
    });
    await b.connect({
      url: tb.url,
      agentId: "concurrent-aaaa",
      willTopic: "volley/test/concurrent-aaaa/status",
      willPayload: '{"type":"reaped"}',
    });

    expect(a.clientId).toMatch(/^volley-concurrent-aaaa-[0-9a-f]{8}$/);
    expect(b.clientId).toMatch(/^volley-concurrent-aaaa-[0-9a-f]{8}$/);
    expect(a.clientId).not.toBe(b.clientId);

    // Give the broker a beat to surface any spec-mandated same-clientId kick.
    await new Promise((r) => setTimeout(r, 200));
    expect(a.connected).toBe(true);
    expect(b.connected).toBe(true);

    await a.disconnect();
    await b.disconnect();
  });

  it("surfaces BROKER_DOWN on stale connection (post-disconnect operations)", async () => {
    const b = new VolleyBroker();
    await b.connect({
      url: tb.url,
      agentId: "stale-aaaa",
      willTopic: "volley/test/stale-aaaa/status",
      willPayload: '{"type":"reaped"}',
    });
    expect(b.connected).toBe(true);

    // Forcibly destroy the underlying socket without nulling `this.client`,
    // so requireClient() sees `client !== null` but `client.connected === false`.
    // simulateCrash() nulls the client; _destroyForTest() leaves it set.
    b._destroyForTest();

    await expect(b.queryRetained("volley/test/stale-aaaa/status", 500)).rejects.toMatchObject({
      code: "BROKER_DOWN",
    });
    await expect(b.publish("volley/test/x", "{}", { qos: 1, retain: false })).rejects.toMatchObject(
      {
        code: "BROKER_DOWN",
      },
    );
    await expect(b.subscribeCollect("volley/test/+/status", 1, 500)).rejects.toMatchObject({
      code: "BROKER_DOWN",
    });
    await expect(b.subscribeUntil("volley/test/+/status", () => true, 500)).rejects.toMatchObject({
      code: "BROKER_DOWN",
    });
  });

  it("does NOT fire the LWT on a clean disconnect", async () => {
    const willTopic = "volley/test/agent-cccc/status";
    const observer = await mqtt.connectAsync(tb.url, { reconnectPeriod: 0 });
    let gotWill = false;
    observer.on("message", (t) => {
      if (t === willTopic) gotWill = true;
    });
    await observer.subscribeAsync(willTopic, { qos: 1 });

    const b = new VolleyBroker();
    await b.connect({
      url: tb.url,
      agentId: "agent-cccc",
      willTopic,
      willPayload: '{"type":"reaped"}',
    });
    await b.disconnect();

    await new Promise((r) => setTimeout(r, 500));
    expect(gotWill).toBe(false);
    await observer.endAsync();
  });
});

describe("VolleyBroker publish / queryRetained", () => {
  let tb: TestBroker;
  let b: VolleyBroker;
  beforeEach(async () => {
    tb = await startTestBroker();
    b = new VolleyBroker();
    await b.connect({
      url: tb.url,
      agentId: "pub-aaaa",
      willTopic: "volley/test/pub-aaaa/status",
      willPayload: "{}",
    });
  });
  afterEach(async () => {
    await b.disconnect();
    await tb.close();
  });

  it("publishes a retained message that queryRetained reads back", async () => {
    await b.publish("volley/test/pub-aaaa/status", '{"type":"working"}', { qos: 1, retain: true });
    const got = await b.queryRetained("volley/test/pub-aaaa/status", 1000);
    expect(got).toBe('{"type":"working"}');
  });

  it("queryRetained returns null when no retained message exists", async () => {
    const got = await b.queryRetained("volley/test/pub-aaaa/nothing", 600);
    expect(got).toBeNull();
  });

  it("queryRetained reflects the latest retained value", async () => {
    await b.publish("volley/test/pub-aaaa/result", '{"v":1}', { qos: 1, retain: true });
    await b.publish("volley/test/pub-aaaa/result", '{"v":2}', { qos: 1, retain: true });
    expect(await b.queryRetained("volley/test/pub-aaaa/result", 1000)).toBe('{"v":2}');
  });

  it("a non-retained publish is NOT returned by a later queryRetained", async () => {
    await b.publish("volley/test/pub-aaaa/progress", '{"type":"tick"}', { qos: 0, retain: false });
    expect(await b.queryRetained("volley/test/pub-aaaa/progress", 600)).toBeNull();
  });
});

describe("VolleyBroker subscribeCollect", () => {
  let tb: TestBroker;
  let b: VolleyBroker;
  beforeEach(async () => {
    tb = await startTestBroker();
    b = new VolleyBroker();
    await b.connect({
      url: tb.url,
      agentId: "sub-aaaa",
      willTopic: "volley/test/sub-aaaa/status",
      willPayload: "{}",
    });
  });
  afterEach(async () => {
    await b.disconnect();
    await tb.close();
  });

  it("collects retained messages that arrive on subscribe", async () => {
    await b.publish("volley/test/a/status", '{"id":"a"}', { qos: 1, retain: true });
    await b.publish("volley/test/b/status", '{"id":"b"}', { qos: 1, retain: true });
    const msgs = await b.subscribeCollect("volley/test/+/status", 10, 600);
    expect(msgs.map((m) => m.payload).sort()).toEqual(['{"id":"a"}', '{"id":"b"}']);
  });

  it("collects live messages published after the subscribe and stops at maxMessages", async () => {
    const collecting = b.subscribeCollect("volley/test/live/+", 2, 3000);
    await new Promise((r) => setTimeout(r, 100));
    const pub = new VolleyBroker();
    await pub.connect({
      url: tb.url,
      agentId: "pub-live",
      willTopic: "volley/test/pub-live/status",
      willPayload: "{}",
    });
    await pub.publish("volley/test/live/1", "one", { qos: 0, retain: false });
    await pub.publish("volley/test/live/2", "two", { qos: 0, retain: false });
    await pub.publish("volley/test/live/3", "three", { qos: 0, retain: false });
    const msgs = await collecting;
    expect(msgs).toHaveLength(2);
    await pub.disconnect();
  });

  it("resolves with a partial collection when the timeout elapses first", async () => {
    const msgs = await b.subscribeCollect("volley/test/empty/+", 5, 400);
    expect(msgs).toEqual([]);
  });
});

describe("VolleyBroker subscribeUntil", () => {
  let tb: TestBroker;
  let b: VolleyBroker;
  beforeEach(async () => {
    tb = await startTestBroker();
    b = new VolleyBroker();
    await b.connect({
      url: tb.url,
      agentId: "until-aaaa",
      willTopic: "volley/test/until-aaaa/status",
      willPayload: "{}",
    });
  });
  afterEach(async () => {
    await b.disconnect();
    await tb.close();
  });

  it("resolves with the first retained message that matches the predicate", async () => {
    await b.publish("volley/test/u-1/status", '{"type":"done"}', { qos: 1, retain: true });
    const got = await b.subscribeUntil("volley/test/u-1/status", (p) => p.includes('"done"'), 1000);
    expect(got).not.toBeNull();
    expect(got?.payload).toBe('{"type":"done"}');
  });

  it("skips non-matching retained messages and waits for a live publish that matches", async () => {
    // Pre-publish a non-matching retained value.
    await b.publish("volley/test/u-2/status", '{"type":"working"}', { qos: 1, retain: true });

    // Kick off subscribeUntil; it sees "working" (no match) and keeps waiting.
    const waiting = b.subscribeUntil("volley/test/u-2/status", (p) => p.includes('"done"'), 3000);

    // After a tick, publish the matching live message via a second client.
    setTimeout(() => {
      void (async () => {
        const pub = new VolleyBroker();
        await pub.connect({
          url: tb.url,
          agentId: "until-pub",
          willTopic: "volley/test/until-pub/status",
          willPayload: "{}",
        });
        await pub.publish("volley/test/u-2/status", '{"type":"done"}', { qos: 1, retain: true });
        await pub.disconnect();
      })();
    }, 200);

    const got = await waiting;
    expect(got).not.toBeNull();
    expect(got?.payload).toBe('{"type":"done"}');
  });

  it("does NOT busy-loop on a non-matching retained message — count predicate invocations", async () => {
    // The retained value never matches; subscribeUntil must subscribe once + wait.
    await b.publish("volley/test/u-3/status", '{"type":"working"}', { qos: 1, retain: true });
    let invocations = 0;
    const got = await b.subscribeUntil(
      "volley/test/u-3/status",
      (p) => {
        invocations++;
        return p.includes('"done"');
      },
      500,
    );
    expect(got).toBeNull();
    // The broker delivers the retained payload exactly once on subscribe. If
    // subscribeUntil were re-subscribing internally, invocations would be in the
    // hundreds. With a single subscribe we expect exactly 1.
    expect(invocations).toBe(1);
  });

  it("returns null when the predicate never matches within the timeout", async () => {
    const got = await b.subscribeUntil("volley/test/u-4/status", () => false, 300);
    expect(got).toBeNull();
  });
});

describe("VolleyBroker subscribeStream", () => {
  let tb: TestBroker;
  let b: VolleyBroker;
  beforeEach(async () => {
    tb = await startTestBroker();
    b = new VolleyBroker();
    await b.connect({
      url: tb.url,
      agentId: "stream-aaaa",
      willTopic: "volley/test/stream-aaaa/status",
      willPayload: "{}",
    });
  });
  afterEach(async () => {
    await b.disconnect();
    await tb.close();
  });

  it("invokes the listener for each published message in publish order", async () => {
    const received: { topic: string; payload: string }[] = [];
    const unsubscribe = await b.subscribeStream("volley/test/stream/+", (msg) => {
      received.push(msg);
    });

    const pub = new VolleyBroker();
    await pub.connect({
      url: tb.url,
      agentId: "stream-pub",
      willTopic: "volley/test/stream-pub/status",
      willPayload: "{}",
    });
    try {
      // QoS 1 is the only way to guarantee publish-order delivery to a single
      // subscriber against a single broker.
      await pub.publish("volley/test/stream/1", "one", { qos: 1, retain: false });
      await pub.publish("volley/test/stream/2", "two", { qos: 1, retain: false });
      await pub.publish("volley/test/stream/3", "three", { qos: 1, retain: false });
    } finally {
      await pub.disconnect();
    }

    // Give the broker a beat to deliver all three.
    for (let i = 0; i < 50 && received.length < 3; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(received.map((m) => m.payload)).toEqual(["one", "two", "three"]);
    expect(received.map((m) => m.topic)).toEqual([
      "volley/test/stream/1",
      "volley/test/stream/2",
      "volley/test/stream/3",
    ]);

    await unsubscribe();
  });

  it("stops invoking the listener after unsubscribe() resolves", async () => {
    const received: { topic: string; payload: string }[] = [];
    const unsubscribe = await b.subscribeStream("volley/test/stop/+", (msg) => {
      received.push(msg);
    });

    const pub = new VolleyBroker();
    await pub.connect({
      url: tb.url,
      agentId: "stop-pub",
      willTopic: "volley/test/stop-pub/status",
      willPayload: "{}",
    });
    try {
      await pub.publish("volley/test/stop/1", "before", { qos: 1, retain: false });
      // Wait for the pre-unsubscribe delivery.
      for (let i = 0; i < 50 && received.length < 1; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(received).toHaveLength(1);

      await unsubscribe();

      await pub.publish("volley/test/stop/2", "after", { qos: 1, retain: false });
      // Give the broker time to (not) deliver.
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      await pub.disconnect();
    }

    // Still only the pre-unsubscribe message.
    expect(received.map((m) => m.payload)).toEqual(["before"]);
  });

  it("rejects with BROKER_DOWN when invoked against a disconnected client", async () => {
    b._destroyForTest();
    await expect(b.subscribeStream("volley/test/dead/+", () => {})).rejects.toMatchObject({
      code: "BROKER_DOWN",
    });
  });
});
