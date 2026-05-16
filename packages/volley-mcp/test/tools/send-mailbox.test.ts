import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startLifecycle } from "../../src/lifecycle";
import type { ServerState } from "../../src/state";
import { volSendMailbox } from "../../src/tools/send-mailbox";
import { type TestBroker, startTestBroker } from "../helpers/aedes-broker";

describe("vol_send_mailbox", () => {
  let tb: TestBroker;
  let sender: ServerState;
  beforeEach(async () => {
    tb = await startTestBroker();
    sender = await startLifecycle({
      brokerUrl: tb.url,
      namespace: "test",
      agentId: "coordinator-aaaa",
      parentId: null,
    });
  });
  afterEach(async () => {
    await sender.broker.disconnect();
    await tb.close();
  });

  it("rejects with NOT_REGISTERED if sender.registered has been cleared", async () => {
    sender.registered = false;
    await expect(
      volSendMailbox(sender, {
        to_agent_id: "worker-bbbb",
        type: "steering",
        payload: { text: "hi" },
      }),
    ).rejects.toMatchObject({ code: "NOT_REGISTERED" });
  });

  it("publishes a non-retained mailbox message to the recipient's topic", async () => {
    sender.registered = true;
    const recipient = await startLifecycle({
      brokerUrl: tb.url,
      namespace: "test",
      agentId: "worker-bbbb",
      parentId: null,
    });
    const collecting = recipient.broker.subscribeCollect(
      "volley/test/worker-bbbb/mailbox",
      1,
      3000,
    );
    await new Promise((r) => setTimeout(r, 100));

    const res = await volSendMailbox(sender, {
      to_agent_id: "worker-bbbb",
      type: "steering",
      payload: { text: "skip the integration sweep" },
      correlation_id: "11111111-1111-4111-8111-111111111111",
    });
    expect(res.delivered).toBe(true);
    expect(typeof res.message_id).toBe("string");

    const [msg] = await collecting;
    const env = JSON.parse(msg?.payload ?? "{}");
    expect(env.channel).toBe("mailbox");
    expect(env.type).toBe("steering");
    expect(env.agent_id).toBe("coordinator-aaaa");
    expect(env.payload.text).toBe("skip the integration sweep");
    expect(env.correlation_id).toBe("11111111-1111-4111-8111-111111111111");

    await recipient.broker.disconnect();
  });

  it("rejects a malformed to_agent_id with INVALID_AGENT_ID", async () => {
    sender.registered = true;
    await expect(
      volSendMailbox(sender, {
        to_agent_id: "Bad ID",
        type: "nudge",
        payload: { text: "x" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_AGENT_ID" });
  });
});
