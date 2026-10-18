// @vitest-environment node
//
// Node environment so mqtt.js loads its TCP entry point against the Aedes
// listener (see volley-dash/test/mqtt-client.test.ts); the browser build uses
// WebSocket with the same subscribe/onMessage contract.
import mqtt from "mqtt";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachClient, storeReducer } from "../src/store/context";
import {
  AuthFailedError,
  DESK_SUBSCRIPTIONS,
  type DeskMqttClient,
  createMqttClient,
} from "../src/store/mqtt-client";
import { initialState } from "../src/store/reducer";
import type { DeskMessage, DeskState } from "../src/store/types";
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

  it("passes a zero-length payload through as envelope null and drops malformed JSON", async () => {
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

  it("drops an envelope whose schema major version does not match (SPEC §3.1)", async () => {
    client = createMqttClient({ url: broker.url, reconnectPeriod: 0 });
    const received: DeskMessage[] = [];
    client.onMessage((m) => received.push(m));
    await client.connect();

    const pub = await mqtt.connectAsync(broker.url, { reconnectPeriod: 0 });
    const v1 = { ...JSON.parse(envelope("c")), schema_version: "1.0" };
    await pub.publishAsync("volley/demo/c/status", JSON.stringify(v1));
    await pub.publishAsync("volley/demo/d/status", envelope("d"));
    await waitFor(() => received.length >= 1, 2000);
    await pub.endAsync();

    expect(received.map((r) => r.topic)).toEqual(["volley/demo/d/status"]);
  });

  it("marks retained replays as retained and live deliveries as not", async () => {
    const pub = await mqtt.connectAsync(broker.url, { reconnectPeriod: 0 });
    await pub.publishAsync("volley/demo/e/status", envelope("e"), { retain: true, qos: 1 });

    client = createMqttClient({ url: broker.url, reconnectPeriod: 0 });
    const received: DeskMessage[] = [];
    client.onMessage((m) => received.push(m));
    await client.connect();
    await waitFor(() => received.length >= 1, 2000);
    await pub.publishAsync("volley/demo/e/status", envelope("e"), { retain: true, qos: 1 });
    await waitFor(() => received.length >= 2, 2000);
    await pub.endAsync();

    expect(received.map((r) => r.retained)).toEqual([true, false]);
  });

  it("after a reconnect, drops state cleared during the outage and does not duplicate the feed", async () => {
    const decision = "volley/_waves/w1/decisions/d1";
    const pub = await mqtt.connectAsync(broker.url, { reconnectPeriod: 0 });
    const retain = { retain: true, qos: 1 } as const;
    await pub.publishAsync(
      "volley/_system/registry/a1",
      JSON.stringify({
        schema_version: "0.1",
        agent_id: "a1",
        wall_time: "2026-10-18T12:00:00.000Z",
        channel: "_system/registry",
        type: "registered",
        payload: { capabilities: [], started_at: "2026-10-18T12:00:00.000Z" },
      }),
      retain,
    );
    await pub.publishAsync(
      "volley/demo/a1/status",
      JSON.stringify({ ...JSON.parse(envelope("a1")), wall_time: "2026-10-18T12:00:01.000Z" }),
      retain,
    );
    await pub.publishAsync(
      decision,
      JSON.stringify({
        schema_version: "0.1",
        agent_id: "volleyd",
        wall_time: "2026-10-18T12:00:02.000Z",
        channel: "_waves/decisions",
        type: "decision_opened",
        payload: { decision_id: "d1", wave: "w1", task: null, kind: "plan_change" },
      }),
      retain,
    );

    let state: DeskState = initialState();
    let connects = 0;
    client = createMqttClient({ url: broker.url, clientId: "desk-reconnect", reconnectPeriod: 50 });
    client.onConnect(() => {
      connects += 1;
    });
    const detach = attachClient(
      client,
      (a) => {
        state = storeReducer(state, a);
      },
      { flushMs: 0, settleMs: 200 },
    );
    await client.connect();
    await waitFor(
      () => state.waves.w1?.decisions.d1 !== undefined && !!state.agents.a1?.status,
      2000,
    );

    broker.dropClient("desk-reconnect");
    await pub.publishAsync(decision, "", retain);
    await waitFor(() => connects >= 2, 3000);
    // resync, then the replay, then the settle-time prune
    await new Promise((r) => setTimeout(r, 500));
    await pub.endAsync();
    detach();

    expect(state.waves.w1?.decisions.d1).toBeUndefined();
    expect(state.agents.a1?.feed.map((f) => f.envelope.type)).toEqual(["registered", "working"]);
    expect(state.agents.a1?.registered).toBe(true);
  });
});

describe("createMqttClient publish (D4 steering)", () => {
  const creds = { username: "desk", password: "s3cret" };
  let broker: TestBroker;
  let client: DeskMqttClient | null = null;

  beforeEach(async () => {
    broker = await startTestBroker({ credentials: creds });
  });

  afterEach(async () => {
    await client?.disconnect();
    client = null;
    await broker.close();
  });

  it("signs in with broker credentials and publishes at QoS 1, resolving on PUBACK", async () => {
    const sub = await mqtt.connectAsync(broker.url, { reconnectPeriod: 0, ...creds });
    const got: { topic: string; qos: number; retain: boolean }[] = [];
    sub.on("message", (topic, _payload, packet) =>
      got.push({ topic, qos: packet.qos, retain: packet.retain }),
    );
    await sub.subscribeAsync("volley/default/impl-a1/mailbox", { qos: 1 });

    client = createMqttClient({ url: broker.url, reconnectPeriod: 0, auth: creds });
    await client.connect();
    await client.publish("volley/default/impl-a1/mailbox", envelope("desk"));
    await waitFor(() => got.length >= 1, 2000);
    await sub.endAsync();

    expect(got).toEqual([{ topic: "volley/default/impl-a1/mailbox", qos: 1, retain: false }]);
  });

  it("rejects connect() with AuthFailedError when the broker refuses the credentials", async () => {
    client = createMqttClient({
      url: broker.url,
      reconnectPeriod: 0,
      auth: { username: "desk", password: "wrong" },
    });
    const err = await client.connect().catch((e: Error) => e);
    expect(err).toBeInstanceOf(AuthFailedError);
    expect((err as AuthFailedError).code).toBe("AUTH_FAILED");
  });

  it("an anonymous connect to a broker that requires credentials is an auth failure too", async () => {
    client = createMqttClient({ url: broker.url, reconnectPeriod: 0 });
    expect(await client.connect().catch((e: Error) => e)).toBeInstanceOf(AuthFailedError);
  });

  it("rejects a publish when not connected", async () => {
    client = createMqttClient({ url: broker.url, reconnectPeriod: 0, auth: creds });
    const err = await client.publish("volley/default/x/mailbox", "{}").catch((e: Error) => e);
    expect((err as Error).message).toMatch(/not connected/);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("attachClient settling", () => {
  function fake() {
    const connect = new Set<() => void>();
    const disconnect = new Set<() => void>();
    const on = (set: Set<() => void>) => (h: () => void) => {
      set.add(h);
      return () => {
        set.delete(h);
      };
    };
    const client: DeskMqttClient = {
      connect: async () => {},
      disconnect: async () => {},
      publish: async () => {},
      onMessage: () => () => {},
      onConnect: on(connect),
      onDisconnect: on(disconnect),
      onError: () => () => {},
    };
    const fire = (set: Set<() => void>) => {
      for (const h of set) h();
    };
    return { client, up: () => fire(connect), down: () => fire(disconnect) };
  }
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("settles after each connect's replay and unsettles on a disconnect", async () => {
    const f = fake();
    const settling: boolean[] = [];
    const actions: string[] = [];
    const detach = attachClient(
      f.client,
      (a) => actions.push(a.type),
      { flushMs: 0, settleMs: 30 },
      undefined,
      (s) => settling.push(s),
    );
    f.up();
    expect(settling).toEqual([]);
    await wait(60);
    expect(settling).toEqual([false]);
    expect(actions).toEqual([]); // the first connect neither resyncs nor prunes

    f.down();
    expect(settling).toEqual([false, true]);
    f.up();
    expect(actions).toEqual(["resync"]);
    f.down(); // dropped again before settling: no settle while offline
    await wait(60);
    expect(settling).toEqual([false, true, true]);
    f.up();
    await wait(60);
    expect(settling).toEqual([false, true, true, false]);
    expect(actions).toEqual(["resync", "resync", "prune"]);
    detach();
  });
});
