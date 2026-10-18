import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VolleyBroker } from "../../src/broker";
import { shutdownLifecycle, startLifecycle } from "../../src/lifecycle";
import type { ServerState } from "../../src/state";
import { volListAgents } from "../../src/tools/list-agents";
import { volPublish } from "../../src/tools/publish";
import { volQuery } from "../../src/tools/query";
import { volRegister } from "../../src/tools/register";

const RUN = process.env.VOLLEY_INTEGRATION === "1";
const BROKER_URL = process.env.VOLLEY_BROKER_URL ?? "mqtt://localhost:1883";

describe.skipIf(!RUN)("volley-mcp against real mosquitto", () => {
  let state: ServerState | undefined;

  beforeAll(async () => {
    state = await startLifecycle({
      brokerUrl: BROKER_URL,
      namespace: "integration",
      agentId: "mosq-aaaa",
      parentId: null,
    });
  });
  afterAll(async () => {
    if (state) await shutdownLifecycle(state, "done");
  });

  it("registers, publishes, queries, and lists end-to-end against mosquitto", async () => {
    if (!state) throw new Error("beforeAll did not initialise state");

    const reg = await volRegister(state, { capabilities: ["integration"], model: "test" });
    expect(reg).toEqual({ agent_id: "mosq-aaaa", namespace: "integration" });

    const pub = await volPublish(state, {
      channel: "result",
      type: "build-artifact",
      payload: { url: "https://volley.systems/ci/1" },
    });
    expect(pub.retained).toBe(true);

    const q = await volQuery(state, { topic: pub.topic });
    expect((q.payload as { type: string }).type).toBe("build-artifact");

    const list = await volListAgents(state, { namespace: "integration" });
    expect(list.agents.map((a) => a.agent_id)).toContain("mosq-aaaa");
  });
});

describe.skipIf(!RUN)("persistent mailbox sessions against real mosquitto (MQTT v5)", () => {
  it.each([
    ["an explicit sessionExpirySeconds", { sessionExpirySeconds: 60 }],
    ["the default session expiry", {}],
  ])(
    "queues an offline QoS 1 message for a v5 session with %s and drains it on reconnect",
    async (_label, expiry) => {
      // Unique per run so a session left behind by an earlier run cannot interfere.
      const suffix = randomBytes(4).toString("hex");
      const topic = `volley/integration/mosq-${suffix}/mailbox`;
      const opts = {
        url: BROKER_URL,
        agentId: `mosq-${suffix}`,
        clientId: `volley-mosq-${suffix}-hooks`,
        cleanSession: false,
        protocolVersion: 5 as const,
        ...expiry,
      };

      const consumer = new VolleyBroker();
      await consumer.connect(opts);
      expect(await consumer.drainQueued(topic, { idleMs: 200 })).toEqual([]);
      await consumer.disconnect();

      const pub = new VolleyBroker();
      await pub.connect({ url: BROKER_URL, agentId: `mosq-pub-${suffix}` });
      await pub.publish(topic, "queued-while-offline", { qos: 1, retain: false });
      await pub.disconnect();

      await consumer.connect(opts);
      const got = await consumer.drainQueued(topic, { idleMs: 300 });
      expect(got).toEqual([{ topic, payload: "queued-while-offline" }]);
      await consumer.disconnect();

      // Discard the session now instead of leaving it on the broker until it expires.
      await consumer.connect({ ...opts, cleanSession: true });
      await consumer.disconnect();
    },
  );
});
