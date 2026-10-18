import { describe, expect, it } from "vitest";
import { type SentSteer, ackStateOf, steerLog } from "../src/steer/ackState";
import { initialState, reduceAll, resync } from "../src/store/reducer";
import type { DeskMessage, DeskState, Envelope } from "../src/store/types";

const DESK = "desk";
const AGENT = "impl-a1";
const COORD = "coordinator-k2pq";
const ID1 = "0f6c4a52-6f43-4d7e-9a49-2c0c3b7c1a01";
const ID2 = "0f6c4a52-6f43-4d7e-9a49-2c0c3b7c1a02";
const T0 = 1_000_000;

const env = (agent_id: string, channel: string, type: string, extra: Partial<Envelope> = {}) =>
  ({
    schema_version: "0.1",
    agent_id,
    namespace: "default",
    channel,
    type,
    wall_time: new Date(T0).toISOString(),
    payload: {},
    ...extra,
  }) as Envelope;

const msg = (topic: string, envelope: Envelope, receivedAt = T0 + 10): DeskMessage => ({
  topic,
  envelope,
  receivedAt,
});

/** The hook's SPEC §4.4 ack, published to the Desk's mailbox by the recipient. */
const ack = (from: string, id: string, at = T0 + 10) =>
  msg(
    `volley/default/${DESK}/mailbox`,
    env(from, "mailbox", "ack", {
      correlation_id: id,
      payload: { text: "ACKED", acked_type: "steering", seq: 1 },
    }),
    at,
  );

/** The model's own compliance ack (SPEC §4.3). */
const steeringAcked = (from: string, id: string, at = T0 + 20) =>
  msg(
    `volley/default/${from}/progress`,
    env(from, "progress", "steering_acked", {
      correlation_id: id,
      payload: { msg: "acknowledged" },
    }),
    at,
  );

/** The store as the signed-in Desk sees it: its own mailbox is `self`. */
const base = (): DeskState => ({ ...initialState(), self: DESK });

const sent = (over: Partial<SentSteer> = {}): SentSteer => ({
  id: ID1,
  target: AGENT,
  namespace: "default",
  coordinator: false,
  type: "steering",
  text: "Keep the rename out of this PR",
  seq: 1,
  sentAt: T0,
  puback: false,
  ...over,
});

describe("steerLog (local publish lifecycle)", () => {
  it("records a send, its PUBACK and a refused publish", () => {
    let log = steerLog([], { type: "sending", msg: sent() });
    expect(log).toHaveLength(1);
    expect(log[0]?.puback).toBe(false);
    log = steerLog(log, { type: "puback", id: ID1 });
    expect(log[0]?.puback).toBe(true);
    log = steerLog(log, { type: "sending", msg: sent({ id: ID2, seq: 2 }) });
    log = steerLog(log, { type: "failed", id: ID2, error: "not authorised" });
    expect(log[1]?.error).toBe("not authorised");
  });
});

describe("ackStateOf", () => {
  it("moves sending → sent (PUBACK) → delivered (hook ack) → acked (steering_acked)", () => {
    let log = steerLog([], { type: "sending", msg: sent() });
    let desk: DeskState = base();
    expect(ackStateOf(log[0] as SentSteer, log, desk)).toBe("sending");

    log = steerLog(log, { type: "puback", id: ID1 });
    expect(ackStateOf(log[0] as SentSteer, log, desk)).toBe("sent");

    desk = reduceAll(desk, [ack(AGENT, ID1)]);
    expect(ackStateOf(log[0] as SentSteer, log, desk)).toBe("delivered");

    desk = reduceAll(desk, [steeringAcked(AGENT, ID1)]);
    expect(ackStateOf(log[0] as SentSteer, log, desk)).toBe("acked");
  });

  it("only accepts an ack from the recipient it addressed (SPEC §4.4)", () => {
    const log = steerLog(steerLog([], { type: "sending", msg: sent() }), {
      type: "puback",
      id: ID1,
    });
    const desk = reduceAll(base(), [ack("someone-else", ID1)]);
    expect(ackStateOf(log[0] as SentSteer, log, desk)).toBe("sent");
  });

  it("an agent acknowledgement implies delivery even when the hook ack is missing", () => {
    const log = steerLog(steerLog([], { type: "sending", msg: sent() }), {
      type: "puback",
      id: ID1,
    });
    const desk = reduceAll(base(), [steeringAcked(AGENT, ID1)]);
    expect(ackStateOf(log[0] as SentSteer, log, desk)).toBe("acked");
  });

  it("a refused publish is failed", () => {
    const log = steerLog(steerLog([], { type: "sending", msg: sent() }), {
      type: "failed",
      id: ID1,
      error: "boom",
    });
    expect(ackStateOf(log[0] as SentSteer, log, base())).toBe("failed");
  });

  it("a newer message that supersedes an older one marks the older one superseded", () => {
    let log = steerLog([], { type: "sending", msg: sent() });
    log = steerLog(log, { type: "puback", id: ID1 });
    log = steerLog(log, {
      type: "sending",
      msg: sent({ id: ID2, seq: 2, supersedes: ID1, text: "Actually, include it" }),
    });
    const desk = reduceAll(base(), [ack(AGENT, ID1)]);
    expect(ackStateOf(log[0] as SentSteer, log, desk)).toBe("superseded");
    expect(ackStateOf(log[1] as SentSteer, log, desk)).toBe("sending");
  });

  it("an older message the agent already acted on stays acked", () => {
    let log = steerLog([], { type: "sending", msg: sent({ puback: true }) });
    log = steerLog(log, { type: "sending", msg: sent({ id: ID2, seq: 2, supersedes: ID1 }) });
    const desk = reduceAll(base(), [steeringAcked(AGENT, ID1)]);
    expect(ackStateOf(log[0] as SentSteer, log, desk)).toBe("acked");
  });

  describe("coordinator target", () => {
    const toCoord = sent({ target: COORD, coordinator: true, puback: true });
    const log = [toCoord];

    it("delivered = the coordinator's hooks acked it (shown in the Claude session)", () => {
      const desk = reduceAll(base(), [ack(COORD, ID1)]);
      expect(ackStateOf(toCoord, log, desk)).toBe("delivered");
    });

    it("replied = the coordinator's next resumed signal after the send", () => {
      const resumed = (at: number) =>
        msg(
          `volley/default/${COORD}/progress`,
          env(COORD, "progress", "resumed", { payload: { source: "harness-hook", seq: 4 } }),
          at,
        );
      // A resumed from before the send is not a reply.
      let desk = reduceAll(base(), [resumed(T0 - 5), ack(COORD, ID1)]);
      expect(ackStateOf(toCoord, log, desk)).toBe("delivered");
      desk = reduceAll(desk, [resumed(T0 + 30)]);
      expect(ackStateOf(toCoord, log, desk)).toBe("acked");
    });

    it("replied = a working status after the send", () => {
      const desk = reduceAll(base(), [
        ack(COORD, ID1),
        msg(`volley/default/${COORD}/status`, env(COORD, "status", "working"), T0 + 40),
      ]);
      expect(ackStateOf(toCoord, log, desk)).toBe("acked");
    });

    it("a retained working replayed after a reconnect is not a reply", () => {
      const replay: DeskMessage = {
        ...msg(`volley/default/${COORD}/status`, env(COORD, "status", "working"), T0 + 40),
        retained: true,
      };
      const desk = reduceAll(base(), [ack(COORD, ID1), replay]);
      expect(ackStateOf(toCoord, log, desk)).toBe("delivered");
    });

    it("replied = a mailbox reply correlated to the message", () => {
      const desk = reduceAll(base(), [
        msg(
          `volley/default/${DESK}/mailbox`,
          env(COORD, "mailbox", "steering", {
            correlation_id: ID1,
            payload: { text: "Merging T2 now" },
          }),
        ),
      ]);
      expect(ackStateOf(toCoord, log, desk)).toBe("acked");
    });
  });
});

describe("reducer: own-mailbox acks and steering_acked", () => {
  it("records receipts by message id and sender", () => {
    const desk = reduceAll(base(), [ack(AGENT, ID1, 5), steeringAcked(AGENT, ID1, 7)]);
    expect(desk.steering?.acks[ID1]).toEqual({ [AGENT]: 5 });
    expect(desk.steering?.applied[ID1]).toEqual({ [AGENT]: 7 });
  });

  it("nothing on the Desk's own mailbox conjures a 'desk' agent window", () => {
    const reply = msg(
      `volley/default/${DESK}/mailbox`,
      env(COORD, "mailbox", "steering", { correlation_id: ID1, payload: { text: "ok" } }),
    );
    const desk = reduceAll(base(), [ack(AGENT, ID1), reply]);
    expect(desk.agents[DESK]).toBeUndefined();
    expect(desk.steering?.replies[ID1]).toEqual({ [COORD]: T0 + 10 });
  });

  it("an ack never creates its recipient as an agent (it is a sender: a CLI, the daemon)", () => {
    const desk = reduceAll(initialState(), [ack(AGENT, ID1)]);
    expect(desk.agents[DESK]).toBeUndefined();
  });

  it("the Desk's own outgoing message is not mistaken for a reply", () => {
    const desk = reduceAll(base(), [
      msg(
        `volley/default/${AGENT}/mailbox`,
        env(DESK, "mailbox", "steering", { correlation_id: ID1, payload: { text: "hi", seq: 1 } }),
      ),
    ]);
    expect(desk.steering?.replies[ID1]).toBeUndefined();
    const log = [sent({ puback: true })];
    expect(ackStateOf(log[0] as SentSteer, log, desk)).toBe("sent");
  });

  it("records acks and replies only from the Desk's own mailbox (SPEC §4.4)", () => {
    const elsewhere = "volley/default/cli-x9/mailbox";
    const desk = reduceAll(base(), [
      msg(
        elsewhere,
        env(AGENT, "mailbox", "ack", { correlation_id: ID1, payload: { text: "ACKED" } }),
      ),
      msg(
        `volley/default/${AGENT}/mailbox`,
        env(COORD, "mailbox", "steering", { correlation_id: ID2, payload: { text: "relay" } }),
      ),
    ]);
    expect(desk.steering?.acks[ID1]).toBeUndefined();
    expect(desk.steering?.replies[ID2]).toBeUndefined();
    // Without a signed-in identity there is no own mailbox: nothing is recorded.
    expect(reduceAll(initialState(), [ack(AGENT, ID1)]).steering?.acks[ID1]).toBeUndefined();
  });

  it("the Desk's echo of its own message on its own mailbox is never a reply", () => {
    const desk = reduceAll(base(), [
      msg(
        `volley/default/${DESK}/mailbox`,
        env(DESK, "mailbox", "steering", { correlation_id: ID1, payload: { text: "hi" } }),
      ),
    ]);
    expect(desk.steering?.replies[ID1]).toBeUndefined();
    const toSelf = sent({ target: DESK, coordinator: true, puback: true });
    expect(ackStateOf(toSelf, [toSelf], desk)).toBe("sent");
  });

  it("keeps receipts and self across a reconnect resync", () => {
    const desk = resync(reduceAll(base(), [ack(AGENT, ID1, 5)]));
    expect(desk.steering?.acks[ID1]).toEqual({ [AGENT]: 5 });
    expect(desk.self).toBe(DESK);
  });
});
