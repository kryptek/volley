import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startLifecycle } from "../../src/lifecycle";
import type { ServerState } from "../../src/state";
import { volSendMailbox } from "../../src/tools/send-mailbox";
import { type TestBroker, startTestBroker } from "../helpers/aedes-broker";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
  it("embeds a fresh correlation_id in the envelope and returns it as message_id", async () => {
    sender.registered = true;
    const collecting = sender.broker.subscribeCollect("volley/test/worker-cccc/mailbox", 1, 3000);
    await new Promise((r) => setTimeout(r, 100));
    const res = await volSendMailbox(sender, {
      to_agent_id: "worker-cccc",
      type: "steering",
      payload: { text: "rebase first", seq: 7, supersedes: "22222222-2222-4222-8222-222222222222" },
    });
    const [msg] = await collecting;
    const env = JSON.parse(msg?.payload ?? "{}");
    expect(res.message_id).toMatch(UUID);
    expect(env.correlation_id).toBe(res.message_id);
    expect(env.payload.seq).toBe(7);
    expect(env.payload.supersedes).toBe("22222222-2222-4222-8222-222222222222");
    expect(res).not.toHaveProperty("acked");
  });

  it("preserves a caller-supplied correlation_id and returns it as message_id", async () => {
    sender.registered = true;
    const collecting = sender.broker.subscribeCollect("volley/test/worker-cccc/mailbox", 1, 3000);
    await new Promise((r) => setTimeout(r, 100));
    const res = await volSendMailbox(sender, {
      to_agent_id: "worker-cccc",
      type: "query",
      payload: { text: "status?" },
      correlation_id: "33333333-3333-4333-8333-333333333333",
    });
    const [msg] = await collecting;
    expect(JSON.parse(msg?.payload ?? "{}").correlation_id).toBe(
      "33333333-3333-4333-8333-333333333333",
    );
    expect(res.message_id).toBe("33333333-3333-4333-8333-333333333333");
  });

  it("with wait_ack_ms, resolves acked:true + acked_by when the recipient acks the message id", async () => {
    sender.registered = true;
    const recipient = await startLifecycle({
      brokerUrl: tb.url,
      namespace: "test",
      agentId: "worker-dddd",
      parentId: null,
    });
    recipient.registered = true;
    // Simulated recipient: ack whatever steering message lands in its mailbox.
    const acking = recipient.broker
      .subscribeUntil("volley/test/worker-dddd/mailbox", () => true, 3000)
      .then(async (msg) => {
        const env = JSON.parse(msg?.payload ?? "{}");
        await volSendMailbox(recipient, {
          to_agent_id: env.agent_id,
          type: "ack",
          payload: { text: "ACKED", acked_type: env.type },
          correlation_id: env.correlation_id,
        });
      });
    await new Promise((r) => setTimeout(r, 100));

    const res = await volSendMailbox(sender, {
      to_agent_id: "worker-dddd",
      type: "steering",
      payload: { text: "stop after the current test" },
      wait_ack_ms: 500,
    });
    await acking;
    expect(res).toMatchObject({ delivered: true, acked: true, acked_by: "worker-dddd" });

    await recipient.broker.disconnect();
  });

  it("with wait_ack_ms and no ack, resolves acked:false after the wait", async () => {
    sender.registered = true;
    const t0 = Date.now();
    const res = await volSendMailbox(sender, {
      to_agent_id: "worker-eeee",
      type: "steering",
      payload: { text: "anyone home?" },
      wait_ack_ms: 500,
    });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(450);
    expect(res.acked).toBe(false);
    expect(res).not.toHaveProperty("acked_by");
  });

  async function startAgent(agentId: string): Promise<ServerState> {
    const s = await startLifecycle({
      brokerUrl: tb.url,
      namespace: "test",
      agentId,
      parentId: null,
    });
    s.registered = true;
    return s;
  }

  /** Resolve with the correlation_id of the next envelope that lands in `agentId`'s mailbox. */
  function nextMailboxId(s: ServerState, agentId: string): Promise<string> {
    return s.broker
      .subscribeUntil(`volley/test/${agentId}/mailbox`, () => true, 3000)
      .then((m) => JSON.parse(m?.payload ?? "{}").correlation_id);
  }

  const ackFrom = (s: ServerState, id: string) =>
    volSendMailbox(s, {
      to_agent_id: "coordinator-aaaa",
      type: "ack",
      payload: { text: "ACKED", acked_type: "steering" },
      correlation_id: id,
    });

  it("ignores an ack for a different message id, and still accepts the matching one after it", async () => {
    sender.registered = true;
    const other = await startAgent("worker-ffff");
    const landed = nextMailboxId(other, "worker-ffff");
    await new Promise((r) => setTimeout(r, 100));
    const waiting = volSendMailbox(sender, {
      to_agent_id: "worker-ffff",
      type: "steering",
      payload: { text: "x" },
      wait_ack_ms: 1500,
    });
    const id = await landed;
    let done = false;
    void waiting.then(() => {
      done = true;
    });
    await ackFrom(other, "44444444-4444-4444-8444-444444444444");
    await new Promise((r) => setTimeout(r, 200));
    expect(done).toBe(false); // the stray ack reached the sender and was ignored
    await ackFrom(other, id);
    expect(await waiting).toMatchObject({ acked: true, acked_by: "worker-ffff" });
    await other.broker.disconnect();
  });

  it("ignores an ack for the right id from an agent other than the recipient", async () => {
    sender.registered = true;
    const worker = await startAgent("worker-bbbb");
    const mallory = await startAgent("mallory-cccc");
    const landed = nextMailboxId(worker, "worker-bbbb");
    await new Promise((r) => setTimeout(r, 100));
    const waiting = volSendMailbox(sender, {
      to_agent_id: "worker-bbbb",
      type: "steering",
      payload: { text: "x" },
      wait_ack_ms: 1500,
    });
    const id = await landed;
    await ackFrom(mallory, id);
    await new Promise((r) => setTimeout(r, 200));
    await ackFrom(worker, id);
    expect(await waiting).toMatchObject({ acked: true, acked_by: "worker-bbbb" });
    await worker.broker.disconnect();
    await mallory.broker.disconnect();
  });

  it("concurrent wait_ack_ms sends each see their own ack, even when one resolves first", async () => {
    sender.registered = true;
    const w1 = await startAgent("worker-1111");
    const w2 = await startAgent("worker-2222");
    const landed1 = nextMailboxId(w1, "worker-1111");
    const landed2 = nextMailboxId(w2, "worker-2222");
    await new Promise((r) => setTimeout(r, 100));
    const send = (to: string) =>
      volSendMailbox(sender, {
        to_agent_id: to,
        type: "steering",
        payload: { text: `to ${to}` },
        wait_ack_ms: 2000,
      });
    const first = send("worker-1111");
    const second = send("worker-2222");
    await ackFrom(w1, await landed1);
    expect(await first).toMatchObject({ acked: true, acked_by: "worker-1111" });
    // The first wait has finished (and released its subscription) before this ack.
    await new Promise((r) => setTimeout(r, 200));
    await ackFrom(w2, await landed2);
    expect(await second).toMatchObject({ acked: true, acked_by: "worker-2222" });
    await w1.broker.disconnect();
    await w2.broker.disconnect();
  });

  it("treats an empty correlation_id as missing", async () => {
    sender.registered = true;
    await expect(
      volSendMailbox(sender, {
        to_agent_id: "worker-bbbb",
        type: "ack",
        payload: { text: "ACKED", acked_type: "steering" },
        correlation_id: "",
      }),
    ).rejects.toMatchObject({ code: "IMPL_CORRELATION_ID_REQUIRED" });
    const res = await volSendMailbox(sender, {
      to_agent_id: "worker-bbbb",
      type: "steering",
      payload: { text: "x" },
      correlation_id: "",
    });
    expect(res.message_id).toMatch(UUID);
  });

  it("rejects wait_ack_ms on an ack (recipients never ack an ack)", async () => {
    sender.registered = true;
    await expect(
      volSendMailbox(sender, {
        to_agent_id: "worker-bbbb",
        type: "ack",
        payload: { text: "ACKED", acked_type: "steering" },
        correlation_id: "55555555-5555-4555-8555-555555555555",
        wait_ack_ms: 500,
      }),
    ).rejects.toMatchObject({ code: "IMPL_INVALID_INPUT" });
  });

  it("rejects an ack without a correlation_id (it has nothing to acknowledge)", async () => {
    sender.registered = true;
    await expect(
      volSendMailbox(sender, {
        to_agent_id: "worker-bbbb",
        type: "ack",
        payload: { text: "ACKED", acked_type: "steering" },
      }),
    ).rejects.toMatchObject({ code: "IMPL_CORRELATION_ID_REQUIRED" });
  });
});
