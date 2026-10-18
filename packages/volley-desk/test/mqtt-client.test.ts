// @vitest-environment node
//
// Node environment so mqtt.js loads its TCP entry point against the Aedes
// listener (see volley-dash/test/mqtt-client.test.ts); the browser build uses
// WebSocket with the same subscribe/onMessage contract.
import mqtt from "mqtt";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DESK_SUBSCRIPTIONS,
  type DeskMqttClient,
  createMqttClient,
} from "../src/store/mqtt-client";
import type { DeskMessage } from "../src/store/types";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";

const envelope = (agent_id: string) =>
  JSON.stringify({
    schema_version: "0.1",
    agent_id,
    channel: "status",
    type: "working",
    payload: {},
  });

describe("createMqttClient (desk)", () => {
  let broker: TestBroker;
  let client: DeskMqttClient | null = null;

  beforeEach(async () => {
    broker = await startTestBroker();
  });

  afterEach(async () => {
    await client?.disconnect();
    client = null;
    await broker.close();
  });

  it("subscribes to every Desk topic filter", async () => {
    expect(DESK_SUBSCRIPTIONS).toEqual([
      "volley/_system/registry/+",
      "volley/+/+/status",
      "volley/+/+/progress",
      "volley/+/+/result",
      "volley/+/+/mailbox",
      "volley/+/+/screen",
      "volley/_waves/+/state",
      "volley/_waves/+/decisions/+",
      "volley/_waves/_config",
      "volley/_system/leases/+",
      "volley/_system/admission",
    ]);
    client = createMqttClient({ url: broker.url, reconnectPeriod: 0 });
    const received: DeskMessage[] = [];
    client.onMessage((m) => received.push(m));
    await client.connect();

    const topics = [
      "volley/_system/registry/a",
      "volley/demo/a/status",
      "volley/demo/a/progress",
      "volley/demo/a/result",
      "volley/demo/a/mailbox",
      "volley/demo/a/screen",
      "volley/_waves/w1/state",
      "volley/_waves/w1/decisions/d1",
      "volley/_waves/_config",
      "volley/_system/leases/build",
      "volley/_system/admission",
    ];
    const pub = await mqtt.connectAsync(broker.url, { reconnectPeriod: 0 });
    for (const t of topics) await pub.publishAsync(t, envelope("a"));
    await waitFor(() => received.length >= topics.length, 2000);
    await pub.endAsync();

    expect(received.map((r) => r.topic).sort()).toEqual([...topics].sort());
    expect(received.every((r) => r.envelope?.agent_id === "a")).toBe(true);
    expect(received.every((r) => typeof r.receivedAt === "number")).toBe(true);
  });

  it("passes a cleared retained topic through as envelope null and drops malformed JSON", async () => {
    client = createMqttClient({ url: broker.url, reconnectPeriod: 0 });
    const received: DeskMessage[] = [];
    client.onMessage((m) => received.push(m));
    await client.connect();

    const pub = await mqtt.connectAsync(broker.url, { reconnectPeriod: 0 });
    await pub.publishAsync("volley/demo/b/status", "{not-json");
    await pub.publishAsync("volley/demo/b/screen", "");
    await pub.publishAsync("volley/demo/b/status", envelope("b"));
    await waitFor(() => received.length >= 2, 2000);
    await pub.endAsync();

    expect(received.map((r) => [r.topic, r.envelope?.agent_id ?? null])).toEqual([
      ["volley/demo/b/screen", null],
      ["volley/demo/b/status", "b"],
    ]);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
