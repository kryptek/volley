import mqtt from "mqtt";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "../src/broker";
import { VolleyError } from "../src/errors";
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

describe("VolleyBroker persistent sessions + drainQueued", () => {
  let tb: TestBroker;
  beforeEach(async () => {
    tb = await startTestBroker();
  });
  afterEach(async () => {
    await tb.close();
  });

  const MAILBOX = "volley/t/a/mailbox";
  const persistentOpts = () => ({
    url: tb.url,
    agentId: "a",
    clientId: "volley-a-hooks",
    cleanSession: false,
  });

  async function publishOnce(topic: string, payload: string): Promise<void> {
    const pub = new VolleyBroker();
    await pub.connect({ url: tb.url, agentId: "pub-only" });
    await pub.publish(topic, payload, { qos: 1, retain: false });
    await pub.disconnect();
  }

  it("uses the caller's clientId verbatim (no random suffix) for a persistent session", async () => {
    const a = new VolleyBroker();
    await a.connect(persistentOpts());
    expect(a.clientId).toBe("volley-a-hooks");
    await a.disconnect();
  });

  it("a clean connect with the same clientId discards the persistent session", async () => {
    const a = new VolleyBroker();
    await a.connect(persistentOpts());
    await a.drainQueued(MAILBOX, { idleMs: 100 });
    await a.disconnect();
    await a.connect({ ...persistentOpts(), cleanSession: true });
    expect(a.clientId).toBe("volley-a-hooks");
    await a.disconnect();

    await publishOnce(MAILBOX, "nobody-subscribed");

    await a.connect(persistentOpts());
    expect(await a.drainQueued(MAILBOX, { idleMs: 200 })).toEqual([]);
    await a.disconnect();
  });

  it("queues a QoS 1 message published while the consumer is offline; drainQueued returns it on reconnect", async () => {
    const a = new VolleyBroker();
    await a.connect(persistentOpts());
    expect(await a.drainQueued(MAILBOX, { idleMs: 150 })).toEqual([]);
    await a.disconnect();

    await publishOnce(MAILBOX, "while-you-were-out");

    await a.connect(persistentOpts());
    const got = await a.drainQueued(MAILBOX, { idleMs: 200 });
    expect(got).toEqual([{ topic: MAILBOX, payload: "while-you-were-out" }]);
    await a.disconnect();
  });

  it("drainQueued returns after idleMs with 0 messages, and the subscription survives a disconnect/reconnect cycle", async () => {
    const a = new VolleyBroker();
    await a.connect(persistentOpts());
    const t0 = Date.now();
    expect(await a.drainQueued(MAILBOX, { idleMs: 200 })).toEqual([]);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(1500);
    await a.disconnect();

    // Reconnect WITHOUT re-subscribing, then publish live: only the session's
    // restored subscription can route this message to us.
    await a.connect(persistentOpts());
    await publishOnce(MAILBOX, "live-after-reconnect");
    const got = await a.drainQueued(MAILBOX, { idleMs: 200 });
    expect(got.map((m) => m.payload)).toEqual(["live-after-reconnect"]);
    await a.disconnect();
  });

  it("drainQueued stops at maxMessages and leaves the rest for the next drain", async () => {
    const a = new VolleyBroker();
    await a.connect(persistentOpts());
    await a.drainQueued(MAILBOX, { idleMs: 100 });
    await a.disconnect();

    await publishOnce(MAILBOX, "one");
    await publishOnce(MAILBOX, "two");
    await publishOnce(MAILBOX, "three");

    await a.connect(persistentOpts());
    const first = await a.drainQueued(MAILBOX, { idleMs: 200, maxMessages: 2 });
    expect(first.map((m) => m.payload)).toEqual(["one", "two"]);
    const rest = await a.drainQueued(MAILBOX, { idleMs: 200 });
    expect(rest.map((m) => m.payload)).toEqual(["three"]);
    await a.disconnect();
  });

  it("buffers mailbox messages that arrive between drains on a live connection", async () => {
    const a = new VolleyBroker();
    await a.connect(persistentOpts());
    await a.drainQueued(MAILBOX, { idleMs: 100 });
    await publishOnce(MAILBOX, "between-drains");
    await new Promise((r) => setTimeout(r, 100));
    const got = await a.drainQueued(MAILBOX, { idleMs: 100 });
    expect(got.map((m) => m.payload)).toEqual(["between-drains"]);
    await a.disconnect();
  });

  it("keeps buffering a restored subscription's messages after another topic is drained", async () => {
    const INBOX = "volley/t/a/_user/inbox";
    const a = new VolleyBroker();
    await a.connect(persistentOpts());
    await a.drainQueued(MAILBOX, { idleMs: 100 });
    await a.drainQueued(INBOX, { idleMs: 100 });
    await a.disconnect();

    for (const i of [0, 1, 2]) await publishOnce(MAILBOX, `a${i}`);
    for (const i of [0, 1, 2]) await publishOnce(INBOX, `b${i}`);

    await a.connect(persistentOpts());
    const gotA = await a.drainQueued(MAILBOX, { idleMs: 200 });
    await publishOnce(INBOX, "b-live");
    await new Promise((r) => setTimeout(r, 100));
    const gotB = await a.drainQueued(INBOX, { idleMs: 200 });
    expect(gotA.map((m) => m.payload)).toEqual(["a0", "a1", "a2"]);
    expect(gotB.map((m) => m.payload)).toEqual(["b0", "b1", "b2", "b-live"]);
    await a.disconnect();
  });

  it("a helper subscription on a drained filter does not remove the persistent subscription", async () => {
    const a = new VolleyBroker();
    await a.connect(persistentOpts());
    await a.drainQueued(MAILBOX, { idleMs: 100 });
    // subscribeUntil on the same filter finishes (and releases) first.
    expect(await a.subscribeUntil(MAILBOX, () => true, 100)).toBeNull();
    await a.disconnect();

    await publishOnce(MAILBOX, "still-queued");

    await a.connect(persistentOpts());
    const got = await a.drainQueued(MAILBOX, { idleMs: 200 });
    expect(got.map((m) => m.payload)).toEqual(["still-queued"]);
    await a.disconnect();
  });

  it("a drain still pending at disconnect resolves with what it had, and never takes from the next connection", async () => {
    const a = new VolleyBroker();
    await a.connect(persistentOpts());
    await a.drainQueued(MAILBOX, { idleMs: 100 });
    const pending = a.drainQueued(MAILBOX, { idleMs: 5000 });
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    await a.disconnect();
    expect(await pending).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(1000);

    await publishOnce(MAILBOX, "for-the-new-connection");
    await a.connect(persistentOpts());
    const got = await a.drainQueued(MAILBOX, { idleMs: 200 });
    expect(got.map((m) => m.payload)).toEqual(["for-the-new-connection"]);
    await a.disconnect();
  });

  it("drainQueued honours maxWaitMs while messages keep arriving faster than idleMs", async () => {
    const a = new VolleyBroker();
    await a.connect(persistentOpts());
    const pub = new VolleyBroker();
    await pub.connect({ url: tb.url, agentId: "pub-only" });
    let i = 0;
    const flood = setInterval(() => {
      pub.publish(MAILBOX, `m${i++}`, { qos: 1, retain: false }).catch(() => {});
    }, 20);
    const t0 = Date.now();
    const got = await a.drainQueued(MAILBOX, { idleMs: 200, maxWaitMs: 400 });
    const elapsed = Date.now() - t0;
    clearInterval(flood);
    expect(elapsed).toBeLessThan(1000);
    expect(got.length).toBeGreaterThan(0);
    await pub.disconnect();
    await a.disconnect();
  });

  it("throws IMPL_CLIENT_ID_REQUIRED when cleanSession:false is requested without a clientId", async () => {
    const a = new VolleyBroker();
    const err = await a
      .connect({ url: tb.url, agentId: "a", cleanSession: false })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VolleyError);
    expect(err).toMatchObject({ code: "IMPL_CLIENT_ID_REQUIRED" });
    expect(a.connected).toBe(false);
  });
});

describe("VolleyBroker shared filters (one connection, many local subscribers)", () => {
  let tb: TestBroker;
  let b: VolleyBroker;
  let pub: VolleyBroker;
  const TOPIC = "volley/t/self/mailbox";
  beforeEach(async () => {
    tb = await startTestBroker();
    b = new VolleyBroker();
    await b.connect({ url: tb.url, agentId: "self" });
    pub = new VolleyBroker();
    await pub.connect({ url: tb.url, agentId: "pub-only" });
  });
  afterEach(async () => {
    await b.disconnect();
    await pub.disconnect();
    await tb.close();
  });

  const send = (payload: string, topic = TOPIC) =>
    pub.publish(topic, payload, { qos: 1, retain: false });

  it("a finished subscribeUntil does not tear down a concurrent subscribeUntil on the same filter", async () => {
    const first = b.subscribeUntil(TOPIC, (p) => p === "one", 2000);
    const second = b.subscribeUntil(TOPIC, (p) => p === "two", 2000);
    await new Promise((r) => setTimeout(r, 100));
    await send("one");
    expect(await first).toMatchObject({ payload: "one" });
    await new Promise((r) => setTimeout(r, 100));
    await send("two");
    expect(await second).toMatchObject({ payload: "two" });
  });

  it("a finished subscribeUntil does not tear down a concurrent subscribeCollect on the same filter", async () => {
    const collecting = b.subscribeCollect(TOPIC, 2, 1500);
    const until = b.subscribeUntil(TOPIC, () => true, 1500);
    await new Promise((r) => setTimeout(r, 100));
    await send("x");
    await until;
    await new Promise((r) => setTimeout(r, 100));
    await send("y");
    expect((await collecting).map((m) => m.payload)).toEqual(["x", "y"]);
  });

  it("a released subscribeStream keeps the filter alive for the other holders", async () => {
    const seen: string[] = [];
    const unsubscribe = await b.subscribeStream(TOPIC, (m) => seen.push(m.payload));
    const collecting = b.subscribeCollect(TOPIC, 1, 1500);
    await new Promise((r) => setTimeout(r, 50));
    await unsubscribe();
    await send("after-stream-release");
    expect((await collecting).map((m) => m.payload)).toEqual(["after-stream-release"]);
    expect(seen).toEqual([]);
  });

  it("routes each message only to subscribers whose filter matches its topic", async () => {
    const other = "volley/t/other/mailbox";
    const mine = b.subscribeCollect(TOPIC, 5, 400);
    const theirs = b.subscribeCollect("volley/t/+/status", 5, 400);
    await new Promise((r) => setTimeout(r, 100));
    await send("for-me");
    await send("not-for-anyone", other);
    expect((await mine).map((m) => m.payload)).toEqual(["for-me"]);
    expect(await theirs).toEqual([]);
  });

  it("subscribeUntil resolves null as soon as its signal aborts", async () => {
    const ac = new AbortController();
    const t0 = Date.now();
    const waiting = b.subscribeUntil(TOPIC, () => true, 5000, ac.signal);
    setTimeout(() => ac.abort(), 50);
    expect(await waiting).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
