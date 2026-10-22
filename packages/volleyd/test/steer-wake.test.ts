import { afterEach, describe, expect, it } from "vitest";
import { buildEnvelope } from "volley-mcp/envelope";
import { buildTopic } from "volley-mcp/topics";
import { ControlClient } from "../src/control";
import { WAKE_TEXT } from "../src/liveness";
import { NS } from "./helpers/daemon-env";
import { type FakeClock, fakeClock } from "./helpers/fake-clock";
import { AGENT, type SupervisedEnv, makeSupervisedEnv } from "./helpers/supervised-env";

/**
 * A mailbox steer to an idle agent is read only at its next hook: volleyd waits
 * `mailbox_wake_after_ms` for the hooks' ack, then types the fixed wake line (and Enter) into an
 * idle session, once per message; a working agent, or one at a picker, is never typed into.
 */

const MIN = 60_000;
const WAKE_MS = 20_000;

let s: SupervisedEnv;
let clock: FakeClock;
let client: ControlClient;
afterEach(async () => {
  await client?.close();
  await s?.cleanup();
});

async function setup(): Promise<void> {
  clock = fakeClock(Date.now() + 10 * MIN);
  s = await makeSupervisedEnv({ daemon: { clock } });
  client = await ControlClient.connect(s.env.broker.url, NS);
}

const steer = async (fields: Record<string, unknown> = {}) => {
  const res = await client.request("steer", {
    wave: "w1",
    task: "T1",
    by: "coord-a",
    text: "use the shared table",
    wait_ack_ms: 0,
    ...fields,
  });
  expect(res.error).toBeUndefined();
  return res.result as { message_id: string; delivery: string };
};

const wakes = () => s.host.texts.filter((t) => t.text === WAKE_TEXT);
const woken = () => s.journal().filter((e) => e.type === "agent_woken");

/** The agent's hooks ack `messageId` to volleyd's mailbox (SPEC §4.4). */
const ack = (messageId: string) =>
  s.agent.publish(
    buildTopic(NS, "volleyd", "mailbox"),
    JSON.stringify(
      buildEnvelope({
        agentId: AGENT,
        parentId: "volleyd",
        channel: "mailbox",
        type: "ack",
        payload: { text: "ACKED", acked_type: "steering" },
        correlationId: messageId,
      }),
    ),
    { qos: 1, retain: false },
  );

/** The agent acknowledges `messageId` on its progress channel (SPEC §4.3 `steering_acked`). */
const steeringAcked = (messageId: string) =>
  s.agent.publish(
    buildTopic(NS, AGENT, "progress"),
    JSON.stringify(
      buildEnvelope({
        agentId: AGENT,
        parentId: "volleyd",
        channel: "progress",
        type: "steering_acked",
        payload: { progress: 50, msg: "acknowledged: use the shared table" },
        correlationId: messageId,
      }),
    ),
    { qos: 0, retain: false },
  );

async function idle(): Promise<void> {
  await s.hook("idle-stop.json");
  await s.consumed();
}

describe("steer wakes an idle agent", () => {
  it("an idle agent with no ack in the window gets the wake line and Enter, once; agent_woken is journaled", async () => {
    await setup();
    await idle();
    const sent = await steer();
    expect(sent.delivery).toBe("delivered");
    await clock.advance(WAKE_MS - 1);
    await s.settled();
    expect(wakes()).toEqual([]);

    await clock.advance(1);
    const e = await s.event("agent_woken");
    expect(e.task).toBe("T1");
    expect(e.data).toMatchObject({
      agent_id: AGENT,
      reason: "mailbox",
      message_id: sent.message_id,
    });
    expect(wakes()).toHaveLength(1);
    expect(s.host.keys.at(-1)?.key).toBe("Enter");
    const status = s.daemon.snapshot("w1")?.tasks.find((t) => t.id === "T1");
    expect(status?.steer_unacked).toBe(AGENT);

    // A second miss: no second wake for the same message.
    await clock.advance(5 * WAKE_MS);
    await s.settled();
    expect(wakes()).toHaveLength(1);
    expect(woken()).toHaveLength(1);

    // The ack arrives at last: the unacked mark clears.
    await ack(sent.message_id);
    await s.event("steering_received");
    expect(
      s.daemon.snapshot("w1")?.tasks.find((t) => t.id === "T1")?.steer_unacked,
    ).toBeUndefined();
  });

  it("two steers sent together to an idle agent type one wake line: it drains both", async () => {
    await setup();
    await idle();
    await steer();
    await steer({ text: "and rebase first" });
    await clock.advance(WAKE_MS);
    await s.event("agent_woken");
    await s.settled();
    expect(wakes()).toHaveLength(1);
    expect(woken()).toHaveLength(1);
  });

  it("a wake drains the steers after it: one acked before the next one's window ends types no second line", async () => {
    await setup();
    await idle();
    const a = await steer();
    await clock.advance(WAKE_MS / 2);
    await steer({ text: "and rebase first" });
    await clock.advance(WAKE_MS / 2);
    await s.event("agent_woken");
    // The first ack lands; the second lags past its own window, which ends within the wake's.
    await ack(a.message_id);
    await s.event("steering_received");
    await clock.advance(WAKE_MS / 2);
    await s.settled();
    expect(wakes()).toHaveLength(1);
    expect(woken()).toHaveLength(1);
  });

  it("a woken message's late ack clears the unacked mark although a newer message was sent since", async () => {
    await setup();
    await idle();
    const a = await steer();
    await clock.advance(WAKE_MS);
    await s.event("agent_woken");
    const b = await steer({ text: "and rebase first" });
    await ack(a.message_id);
    await ack(b.message_id);
    await s.event("steering_received");
    await s.consumed();
    expect(
      s.daemon.snapshot("w1")?.tasks.find((t) => t.id === "T1")?.steer_unacked,
    ).toBeUndefined();
  });

  it("a woken message's ack after a daemon restart clears the unacked mark", async () => {
    await setup();
    await idle();
    const sent = await steer();
    await clock.advance(WAKE_MS);
    await s.event("agent_woken");
    await s.daemon.stop();
    const d = await s.restart();
    await s.event("reconciled");
    await s.settled();
    await ack(sent.message_id);
    await s.event("steering_received");
    expect(d.snapshot("w1")?.tasks.find((t) => t.id === "T1")?.steer_unacked).toBeUndefined();
  });

  it("a working agent is never typed into", async () => {
    await setup();
    await steer();
    await clock.advance(2 * WAKE_MS);
    await s.settled();
    expect(wakes()).toEqual([]);
    expect(woken()).toEqual([]);
  });

  it("an agent at a picker (a permission prompt) is never typed into: the Enter would answer it", async () => {
    await setup();
    await s.hook("awaiting-permission-prompt.json");
    await s.consumed();
    await steer();
    await clock.advance(2 * WAKE_MS);
    await s.settled();
    expect(wakes()).toEqual([]);
    expect(woken()).toEqual([]);
  });

  it("the auth_failed pause steers an idle agent but never types the wake line", async () => {
    await setup();
    await idle();
    // The pause the daemon runs when the broker refused the agent's hooks (relaunch.test.ts).
    await (s.daemon as unknown as { pauseAuthFailed(id: string): Promise<void> }).pauseAuthFailed(
      AGENT,
    );
    await s.event((e) => e.type === "steering_sent" && e.data.reason === "auth_failed");
    await clock.advance(2 * WAKE_MS);
    await s.settled();
    expect(wakes()).toEqual([]);
    expect(woken()).toEqual([]);
  });

  it("an ack within the window cancels the wake", async () => {
    await setup();
    await idle();
    const sent = await steer();
    await ack(sent.message_id);
    await s.consumed();
    await clock.advance(2 * WAKE_MS);
    await s.settled();
    expect(wakes()).toEqual([]);
    expect(woken()).toEqual([]);
  });

  it("an ack that arrives before steering_sent is journaled cancels the wake too", async () => {
    await setup();
    await idle();
    // The agent acks while volleyd is still journaling the steer (append fsyncs).
    const d = s.daemon as unknown as {
      append: (
        wave: string,
        ev: { type: string; data: { message_id?: string } },
      ) => Promise<unknown>;
      mailboxHeard: (messageId: string, by: string) => void;
    };
    const append = d.append.bind(d);
    const mailboxHeard = d.mailboxHeard.bind(d);
    let heard: () => void = () => {};
    d.mailboxHeard = (messageId, by) => {
      mailboxHeard(messageId, by);
      heard();
    };
    d.append = async (wave, ev) => {
      if (ev.type === "steering_sent" && ev.data.message_id !== undefined) {
        const acked = new Promise<void>((r) => {
          heard = r;
        });
        await steeringAcked(ev.data.message_id);
        await acked;
      }
      return append(wave, ev);
    };
    await steer();
    await s.settled();
    await clock.advance(2 * WAKE_MS);
    await s.settled();
    expect(wakes()).toEqual([]);
    expect(woken()).toEqual([]);
  });

  it("the liveness nudge wakes the idle agent it steers", async () => {
    await setup();
    await idle();
    await clock.advance(4 * MIN);
    await s.daemon.tick();
    const nudge = await s.event((e) => e.type === "steering_sent" && e.data.reason === "idle");
    await s.settled();
    await clock.advance(WAKE_MS);
    const e = await s.event("agent_woken");
    expect(e.data.message_id).toBe(nudge.data.message_id);
    expect(wakes()).toHaveLength(1);
  });

  it("a steer that waits for its ack answers that it woke the agent", async () => {
    await setup();
    await idle();
    const answer = client.request("steer", {
      wave: "w1",
      task: "T1",
      by: "coord-a",
      text: "use the shared table",
      wait_ack_ms: 30_000,
    });
    // The wake timer is armed as the steer is sent.
    const armed = clock.armed(WAKE_MS);
    await s.event("steering_sent");
    await armed;
    await clock.advance(WAKE_MS);
    await s.event("agent_woken");
    await clock.advance(10_000);
    const res = await answer;
    expect(res.error).toBeUndefined();
    expect(res.result).toMatchObject({ delivery: "delivered", woke: true, acked: false });
  });
});
