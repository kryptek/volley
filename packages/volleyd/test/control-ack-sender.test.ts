import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { ControlClient, ControlTimeoutError } from "../src/control";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";

const NS = "ack-sender";

/**
 * SPEC §4.4: a sender accepts an ack only from the recipient. A control client's recipient is
 * `volleyd`, so an `ack` with the right correlation_id from any other agent id is ignored.
 */
describe("ControlClient accepts acks only from volleyd", () => {
  let broker: TestBroker;
  let fake: VolleyBroker;
  let client: ControlClient | undefined;
  beforeEach(async () => {
    broker = await startTestBroker();
    fake = new VolleyBroker();
    await fake.connect({ url: broker.url, agentId: "fake-daemon" });
    // A live retained status, so request() sends instead of failing fast with NotRunningError.
    await fake.publish(
      `volley/${NS}/volleyd/status`,
      JSON.stringify(
        buildEnvelope({
          agentId: "volleyd",
          parentId: null,
          channel: "status",
          type: "working",
          payload: {},
        }),
      ),
      { qos: 1, retain: true },
    );
  });
  afterEach(async () => {
    await client?.close();
    client = undefined;
    await fake.disconnect();
    await broker.close();
  });

  /** Answer every control request with an ack signed as `as`. */
  const answerAs = (as: string) =>
    fake.subscribeStream(`volley/${NS}/volleyd/mailbox`, ({ payload }) => {
      const req = parseEnvelope(payload);
      if (req?.type !== "query") return;
      const ack = buildEnvelope({
        agentId: as,
        parentId: null,
        channel: "mailbox",
        type: "ack",
        correlationId: req.correlation_id as string,
        payload: { text: "ACKED", acked_type: "query", op: "status", ok: true, result: as },
      });
      void fake.publish(`volley/${NS}/${req.agent_id}/mailbox`, JSON.stringify(ack), {
        qos: 1,
        retain: false,
      });
    });

  it("ignores a correlated ack from another agent id", async () => {
    await answerAs("rogue-agent");
    client = await ControlClient.connect(broker.url, NS);
    await expect(client.request("status", {}, { timeoutMs: 400 })).rejects.toBeInstanceOf(
      ControlTimeoutError,
    );
  });

  it("accepts the same ack from volleyd", async () => {
    await answerAs("volleyd");
    client = await ControlClient.connect(broker.url, NS);
    const res = await client.request("status", {}, { timeoutMs: 2000 });
    expect(res.result).toBe("volleyd");
  });
});
