// @vitest-environment node
//
// Uses the Node test environment instead of the file-wide jsdom default so
// mqtt.js loads its Node entry point (TCP transport for `mqtt://` URLs).
// In jsdom mqtt.js detects browser-like globals and switches to its
// WebSocket-only browser build, which hangs against an Aedes TCP listener.
// The dashboard's production path is browser → `ws://` → mosquitto; the
// mqtt-client contract we verify here (subscribe + onMessage) is identical
// across transports.
import mqtt from "mqtt";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthFailedError, type VolleyMqttClient, createMqttClient } from "../src/lib/mqtt-client";
import type { ParsedEnvelope } from "../src/lib/parse-envelope";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";

interface Received {
  topic: string;
  envelope: ParsedEnvelope;
}

function makeEnvelope(overrides: Partial<ParsedEnvelope> = {}): ParsedEnvelope {
  return {
    schema_version: "0.1",
    agent_id: "agent-x",
    channel: "status",
    type: "working",
    wall_time: "2026-05-16T00:00:00.000Z",
    payload: {},
    ...overrides,
  } as ParsedEnvelope;
}

describe("createMqttClient", () => {
  let broker: TestBroker;
  let client: VolleyMqttClient | null = null;

  beforeEach(async () => {
    broker = await startTestBroker();
  });

  afterEach(async () => {
    if (client) {
      await client.disconnect();
      client = null;
    }
    await broker.close();
  });

  it("connects to the broker and emits onConnect", async () => {
    client = createMqttClient({ url: broker.url });
    const connected = new Promise<void>((resolve) => {
      client?.onConnect(() => resolve());
    });
    await client.connect();
    await connected;
  });

  it("subscribes to all 5 Volley wildcards on connect", async () => {
    client = createMqttClient({ url: broker.url });

    // Publish one message on each wildcard's matching topic from a separate
    // client; if the dashboard client subscribed correctly it will receive all 5.
    await client.connect();
    const received: Received[] = [];
    client.onMessage((topic, envelope) => {
      received.push({ topic, envelope });
    });

    const pub = await mqtt.connectAsync(broker.url, { reconnectPeriod: 0 });
    const topics = [
      "volley/_system/registry/agent-a",
      "volley/default/agent-a/status",
      "volley/default/agent-a/progress",
      "volley/default/agent-a/mailbox",
      "volley/default/agent-a/result",
    ];
    for (const topic of topics) {
      await pub.publishAsync(topic, JSON.stringify(makeEnvelope({ agent_id: "agent-a" })));
    }

    // Wait until all 5 arrive (or fail the test with a clear timeout).
    await waitFor(() => received.length === 5, 2000);
    await pub.endAsync();

    expect(received.map((r) => r.topic).sort()).toEqual(topics.slice().sort());
    for (const r of received) {
      expect(r.envelope.agent_id).toBe("agent-a");
    }
  });

  it("ignores topics that don't match the Volley shape (defensive)", async () => {
    client = createMqttClient({ url: broker.url });
    await client.connect();
    const received: string[] = [];
    client.onMessage((topic) => {
      received.push(topic);
    });

    const pub = await mqtt.connectAsync(broker.url, { reconnectPeriod: 0 });
    // The client's subscriptions are scoped to `volley/...` wildcards, so a
    // publish to `foo/bar` won't even arrive. Sanity-check by also publishing
    // a malformed-JSON volley message — the client must drop it without crashing.
    await pub.publishAsync("volley/default/agent-b/status", "{not-json");
    await pub.publishAsync("volley/default/agent-b/status", JSON.stringify(makeEnvelope()));
    await waitFor(() => received.length >= 1, 2000);
    await pub.endAsync();

    expect(received).toEqual(["volley/default/agent-b/status"]);
  });

  it("emits onDisconnect after disconnect()", async () => {
    client = createMqttClient({ url: broker.url });
    const disconnected = new Promise<void>((resolve) => {
      client?.onDisconnect(() => resolve());
    });
    await client.connect();
    await client.disconnect();
    await disconnected;
    client = null;
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("createMqttClient credentials", () => {
  let broker: TestBroker;
  let client: VolleyMqttClient | null = null;

  beforeEach(async () => {
    broker = await startTestBroker({ credentials: { username: "desk", password: "right" } });
  });

  afterEach(async () => {
    if (client) {
      await client.disconnect();
      client = null;
    }
    await broker.close();
  });

  it("connects with the right username/password", async () => {
    client = createMqttClient({ url: broker.url, auth: { username: "desk", password: "right" } });
    await client.connect();
  });

  it("rejects connect() with AuthFailedError on refused credentials", async () => {
    client = createMqttClient({ url: broker.url, auth: { username: "desk", password: "wrong" } });
    await expect(client.connect()).rejects.toBeInstanceOf(AuthFailedError);
  });

  it("rejects an anonymous connect to an auth-only broker with AuthFailedError", async () => {
    client = createMqttClient({ url: broker.url });
    await expect(client.connect()).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });
});
