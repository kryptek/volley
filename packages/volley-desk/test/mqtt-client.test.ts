// @vitest-environment node
//
// Node environment so mqtt.js loads its TCP entry point against the Aedes
// listener (see volley-dash/test/mqtt-client.test.ts); the browser build uses
// WebSocket with the same subscribe/onMessage contract.
import mqtt from "mqtt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
      "volley/+/+/usage",
      "volley/_system/claude-accounts/+",
      "volley/_system/claude/+/signin",
      "volley/_system/machines/#",
      "volley/_inbox/+",
      "volley/_system/auth/replies/+",
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
      "volley/demo/a/usage",
      "volley/_system/claude-accounts/work",
      "volley/_system/claude/work/signin",
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

  it("runs the connect handlers before the retained replay's first message (C11)", async () => {
    const pub = await mqtt.connectAsync(broker.url, { reconnectPeriod: 0 });
    for (const id of ["r1", "r2", "r3"]) {
      await pub.publishAsync(`volley/demo/${id}/status`, envelope(id), { retain: true, qos: 1 });
    }
    await pub.endAsync();

    client = createMqttClient({ url: broker.url, reconnectPeriod: 0 });
    const events: string[] = [];
    client.onConnect(() => events.push("connect"));
    client.onMessage((m) => events.push(m.topic));
    await client.connect();
    await waitFor(() => events.length >= 4, 2000);

    expect(events[0]).toBe("connect");
  });

  it("on a reconnect, runs the connect handlers once the resubscribe is granted, before its replay (C11)", async () => {
    const pub = await mqtt.connectAsync(broker.url, { reconnectPeriod: 0 });
    await pub.publishAsync("volley/demo/r1/status", envelope("r1"), { retain: true, qos: 1 });
    await pub.endAsync();

    client = createMqttClient({ url: broker.url, clientId: "desk-resub", reconnectPeriod: 50 });
    const events: string[] = [];
    const granted: number[] = [];
    client.onConnect(() => {
      events.push("connect");
      granted.push(broker.subscriptions("desk-resub").length);
    });
    client.onMessage((m) => events.push(m.topic));
    await client.connect();
    await waitFor(() => events.length >= 2, 2000);

    broker.dropClient("desk-resub");
    await waitFor(() => events.length >= 4, 3000);

    // At the CONNACK the resubscribe is still a round trip away: the handlers wait for its SUBACK.
    expect(granted).toEqual([DESK_SUBSCRIPTIONS.length, 2 * DESK_SUBSCRIPTIONS.length]);
    expect(events).toEqual([
      "connect",
      "volley/demo/r1/status",
      "connect",
      "volley/demo/r1/status",
    ]);
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

describe("createMqttClient reconnect() — the resume probe", () => {
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

  // reconnectPeriod > 0 as in production: mqtt.js then tracks every granted filter for
  // resubscription and silently skips a SUBSCRIBE to one it already holds.
  it("puts a SUBSCRIBE on the wire while connected and keeps a live socket", async () => {
    client = createMqttClient({ url: broker.url, clientId: "desk-probe", reconnectPeriod: 2000 });
    let disconnects = 0;
    client.onDisconnect(() => {
      disconnects += 1;
    });
    await client.connect();
    const before = broker.subscriptions("desk-probe").length;

    client.reconnect?.();
    await waitFor(() => broker.subscriptions("desk-probe").length > before, 2000);
    await new Promise((r) => setTimeout(r, 400));

    expect(broker.subscriptions("desk-probe").slice(before)).toEqual([
      "volley/_system/desk-probe/desk-probe",
    ]);
    expect(disconnects).toBe(0);
  });

  it("drops a socket the broker no longer answers on, then connects again", async () => {
    client = createMqttClient({
      url: broker.url,
      clientId: "desk-dead",
      reconnectPeriod: 50,
      probeTimeoutMs: 300,
    });
    let connects = 0;
    let disconnects = 0;
    client.onConnect(() => {
      connects += 1;
    });
    client.onDisconnect(() => {
      disconnects += 1;
    });
    await client.connect();
    broker.silenceClient("desk-dead");

    client.reconnect?.();
    await waitFor(() => disconnects >= 1 && connects >= 2, 3000);
  });

  it("connects again at once when already disconnected", async () => {
    client = createMqttClient({ url: broker.url, clientId: "desk-down", reconnectPeriod: 60_000 });
    let connects = 0;
    let disconnects = 0;
    client.onConnect(() => {
      connects += 1;
    });
    client.onDisconnect(() => {
      disconnects += 1;
    });
    await client.connect();
    broker.dropClient("desk-down");
    await waitFor(() => disconnects >= 1, 2000);

    client.reconnect?.();
    await waitFor(() => connects >= 2, 2000);
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

// Fake timers: each step below is a deterministic advance, never a race with the runner.
describe("attachClient", () => {
  const msg = (topic: string, retained: boolean): DeskMessage => ({
    topic,
    envelope: {
      schema_version: "0.1",
      agent_id: "a",
      channel: "status",
      type: "working",
      payload: {},
    },
    receivedAt: Date.now(),
    retained,
  });
  function fake() {
    const message = new Set<(m: DeskMessage) => void>();
    const connect = new Set<() => void>();
    const disconnect = new Set<() => void>();
    const on =
      <H>(set: Set<H>) =>
      (h: H) => {
        set.add(h);
        return () => {
          set.delete(h);
        };
      };
    const client: DeskMqttClient = {
      connect: async () => {},
      disconnect: async () => {},
      publish: async () => {},
      onMessage: on(message),
      onConnect: on(connect),
      onDisconnect: on(disconnect),
      onError: () => () => {},
    };
    return {
      client,
      emit: (m: DeskMessage) => {
        for (const h of message) h(m);
      },
      up: () => {
        for (const h of connect) h();
      },
      down: () => {
        for (const h of disconnect) h();
      },
    };
  }
  type Logged = { type: string; topics?: string[] };
  function attach(
    f: ReturnType<typeof fake>,
    opts: Parameters<typeof attachClient>[2],
    onSettling?: (s: boolean) => void,
  ) {
    const log: Logged[] = [];
    const detach = attachClient(
      f.client,
      (a) =>
        log.push(a.type === "apply" ? { type: a.type, topics: a.msgs.map((m) => m.topic) } : a),
      opts,
      undefined,
      onSettling,
    );
    return { log, detach };
  }
  const types = (log: Logged[]) => log.map((l) => l.type);
  const advance = (ms: number) => vi.advanceTimersByTime(ms);

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("settling", () => {
    it("settles after each connect's replay and unsettles on a disconnect", () => {
      const f = fake();
      const settling: boolean[] = [];
      const { log, detach } = attach(
        f,
        { flushMs: 0, settleMs: 30, quietMs: 2, holdMaxMs: 10 },
        (s) => settling.push(s),
      );
      f.up();
      expect(settling).toEqual([]);
      advance(30);
      expect(settling).toEqual([false]);
      expect(log).toEqual([]); // the first connect neither resyncs nor prunes

      f.down();
      expect(settling).toEqual([false, true]);
      f.up();
      expect(log).toEqual([]); // the resync waits for the replay (C11)
      advance(2);
      expect(types(log)).toEqual(["resync"]); // nothing retained: released after the quiet window
      f.down(); // dropped again before settling: no settle while offline
      advance(60);
      expect(settling).toEqual([false, true, true]);
      f.up();
      advance(30);
      expect(settling).toEqual([false, true, true, false]);
      expect(types(log)).toEqual(["resync", "resync", "prune"]);
      detach();
    });
  });

  describe("replay hold (C11: the first load must not flash every retained agent)", () => {
    it("holds the first connect's retained replay until it goes quiet, then applies it in one batch", () => {
      const f = fake();
      const { log, detach } = attach(f, { flushMs: 0, settleMs: 1000, quietMs: 40 });
      f.up();
      f.emit(msg("volley/_system/registry/a", true)); // registry entries replay first…
      advance(20); // …longer than a flush, shorter than the quiet window
      f.emit(msg("volley/default/a/status", true)); // …then the statuses
      advance(39);
      expect(log).toEqual([]);
      advance(1);
      expect(log).toEqual([
        { type: "apply", topics: ["volley/_system/registry/a", "volley/default/a/status"] },
      ]);
      // Once released, deliveries flow as before.
      f.emit(msg("volley/default/a/progress", false));
      advance(0);
      expect(log.at(-1)).toEqual({ type: "apply", topics: ["volley/default/a/progress"] });
      detach();
    });

    it("live (non-retained) deliveries during the hold do not keep it open", () => {
      const f = fake();
      const { log, detach } = attach(f, { flushMs: 0, settleMs: 1000, quietMs: 40 });
      f.up();
      f.emit(msg("volley/default/a/status", true));
      for (let i = 0; i < 6; i++) {
        advance(15);
        f.emit(msg("volley/default/b/progress", false));
      }
      // 90 ms of live traffic, but the replay went quiet after its one retained message.
      expect(log[0]).toEqual({
        type: "apply",
        topics: [
          "volley/default/a/status",
          "volley/default/b/progress",
          "volley/default/b/progress",
        ],
      });
      detach();
    });

    it("releases a replay that never goes quiet once the hold's bound passes", () => {
      const f = fake();
      const { log, detach } = attach(f, { flushMs: 0, settleMs: 1000, quietMs: 40, holdMaxMs: 80 });
      f.up();
      for (let t = 0; t < 70; t += 10) {
        f.emit(msg("volley/default/a/status", true));
        advance(10);
      }
      f.emit(msg("volley/default/a/status", true));
      advance(9);
      expect(log).toEqual([]); // still replaying 79 ms in
      advance(1);
      expect(types(log)).toEqual(["apply"]);
      detach();
    });

    it("on a reconnect, dispatches the resync together with the replay, never before it", () => {
      const f = fake();
      const { log, detach } = attach(f, { flushMs: 0, settleMs: 3000, quietMs: 40 });
      f.up();
      advance(3000);
      f.down();
      f.up(); // at the resubscribe's SUBACK, however slow the link (see the Aedes test above)
      f.emit(msg("volley/_system/registry/a", true));
      advance(39);
      expect(log).toEqual([]); // the store still shows the pre-reconnect state
      f.emit(msg("volley/_system/registry/b", true));
      advance(20);
      expect(log).toEqual([]);
      f.emit(msg("volley/default/a/status", true));
      advance(40);
      expect(log).toEqual([
        { type: "resync" },
        {
          type: "apply",
          topics: [
            "volley/_system/registry/a",
            "volley/_system/registry/b",
            "volley/default/a/status",
          ],
        },
      ]);
      detach();
    });

    it("applies nothing while offline when the link drops during a hold", () => {
      const f = fake();
      const { log, detach } = attach(f, { flushMs: 0, settleMs: 3000, quietMs: 40 });
      f.up();
      advance(3000);
      f.down();
      f.up();
      f.emit(msg("volley/_system/registry/a", true)); // part of the replay…
      advance(20);
      f.down(); // …and the link drops again before the hold ends
      advance(10_000);
      expect(log).toEqual([]);
      // The next connect's replay replaces the partial one, and the owed resync comes with it.
      f.up();
      f.emit(msg("volley/_system/registry/b", true));
      advance(40);
      expect(log).toEqual([
        { type: "resync" },
        { type: "apply", topics: ["volley/_system/registry/b"] },
      ]);
      detach();
    });
  });
});
