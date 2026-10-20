import { describe, expect, it, vi } from "vitest";
import type { SteerLogEvent } from "../src/steer/ackState";
import {
  DAEMON_AGENT_ID,
  type SteerClient,
  type SteerTarget,
  compose,
  copySteerCommand,
  createSteerTransport,
} from "../src/steer/transport";
import type { DeskMessage, Envelope } from "../src/store/types";

const AGENT: SteerTarget = {
  agentId: "impl-a1",
  namespace: "default",
  coordinator: false,
  wave: "status-chip",
  task: "T2",
};

/** A mock broker client: records publishes, PUBACKs them, lets a test deliver messages. */
function mockClient({ refuse = false }: { refuse?: boolean } = {}) {
  const published: { topic: string; envelope: Envelope }[] = [];
  const handlers = new Set<(m: DeskMessage) => void>();
  const client: SteerClient = {
    publish: vi.fn(async (topic: string, payload: string) => {
      published.push({ topic, envelope: JSON.parse(payload) as Envelope });
      if (refuse) throw new Error("not authorised");
    }),
    onMessage: (h) => {
      handlers.add(h);
      return () => handlers.delete(h);
    },
  };
  const deliver = (m: DeskMessage) => {
    for (const h of handlers) h(m);
  };
  return { client, published, deliver, handlers };
}

function setup(opts: { refuse?: boolean } = {}) {
  const mock = mockClient(opts);
  const events: SteerLogEvent[] = [];
  let n = 0;
  const transport = createSteerTransport(mock.client, {
    identity: "desk",
    onEvent: (e) => events.push(e),
    newId: () => `00000000-0000-4000-8000-00000000000${++n}`,
    now: () => new Date("2026-10-18T15:00:00.000Z"),
    timeoutMs: 50,
  });
  return { ...mock, events, transport };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("compose", () => {
  it("maps the four commands and keeps plain text as steering", () => {
    expect(compose("/stop", false)).toMatchObject({ type: "cancel", urgent: true });
    expect(compose("/stop the rename is wrong", false).text).toContain("the rename is wrong");
    expect(compose("/wrap-up", false)).toMatchObject({ type: "steering", urgent: false });
    expect(compose("/wrap-up", false).text).toMatch(/publish done/);
    expect(compose("/pause", false).text).toMatch(/next tool-call boundary/);
    expect(compose("/status", false)).toMatchObject({ type: "nudge", urgent: false });
    expect(compose("keep the rename out", false)).toEqual({
      type: "steering",
      text: "keep the rename out",
      urgent: false,
    });
    expect(compose("keep the rename out", true)).toMatchObject({ type: "steering", urgent: true });
    expect(compose("/unknown thing", false)).toMatchObject({
      type: "steering",
      text: "/unknown thing",
    });
  });
});

describe("createSteerTransport", () => {
  it("publishes plain text as a T0 steering envelope with seq increments and supersedes", async () => {
    const { transport, published, events } = setup();
    const first = transport.send(AGENT, "keep the rename out of this PR");
    const second = transport.send(AGENT, "actually, include it");
    await flush();

    expect(published.map((p) => p.topic)).toEqual([
      "volley/default/impl-a1/mailbox",
      "volley/default/impl-a1/mailbox",
    ]);
    const [a, b] = published.map((p) => p.envelope);
    expect(a).toMatchObject({
      schema_version: "0.1",
      agent_id: "desk",
      namespace: "default",
      channel: "mailbox",
      type: "steering",
      wall_time: "2026-10-18T15:00:00.000Z",
      correlation_id: first.id,
      payload: { text: "keep the rename out of this PR", seq: 1 },
    });
    expect((a?.payload as Record<string, unknown>).supersedes).toBeUndefined();
    expect(b).toMatchObject({
      type: "steering",
      correlation_id: second.id,
      payload: { text: "actually, include it", seq: 2, supersedes: first.id },
    });
    expect(second).toMatchObject({ seq: 2, supersedes: first.id, target: "impl-a1" });
    expect(events.map((e) => e.type)).toEqual(["sending", "sending", "puback", "puback"]);
  });

  it("keeps seq and supersedes per target", async () => {
    const { transport, published } = setup();
    transport.send(AGENT, "one");
    transport.send({ ...AGENT, agentId: "spec-b2" }, "two");
    await flush();
    expect(published.map((p) => (p.envelope.payload as { seq: number }).seq)).toEqual([1, 1]);
    expect(
      published.map((p) => (p.envelope.payload as { supersedes?: string }).supersedes),
    ).toEqual([undefined, undefined]);
  });

  /** Answer the daemon's pending control request (the last `query` published). */
  const answer = (
    m: ReturnType<typeof setup>,
    payload: Record<string, unknown>,
    agent = DAEMON_AGENT_ID,
  ) => {
    const req = m.published.filter((p) => p.envelope.type === "query").at(-1);
    m.deliver({
      topic: "volley/default/desk/mailbox",
      receivedAt: 1,
      envelope: {
        schema_version: "0.1",
        agent_id: agent,
        channel: "mailbox",
        type: "ack",
        correlation_id: req?.envelope.correlation_id ?? null,
        payload: { text: "ACKED", acked_type: "query", op: "steer", ...payload },
      },
    });
  };

  it("/stop asks the daemon to interrupt (escape_only) first, then publishes the one cancel", async () => {
    const m = setup();
    const sent = m.transport.send(AGENT, "/stop");
    await flush();
    // Only the interrupt request so far: the cancel waits for the daemon's answer.
    expect(m.published).toHaveLength(1);
    const control = m.published[0];
    expect(control?.topic).toBe(`volley/default/${DAEMON_AGENT_ID}/mailbox`);
    expect(control?.envelope).toMatchObject({
      agent_id: "desk",
      channel: "mailbox",
      type: "query",
      payload: {
        op: "steer",
        urgent: true,
        escape_only: true,
        wait_ack_ms: 0,
        wave: "status-chip",
        task: "T2",
        by: "desk",
      },
    });
    expect(control?.envelope.correlation_id).not.toBe(sent.id);
    expect(m.events.map((e) => e.type)).toEqual(["sending"]);

    answer(m, { ok: true, result: { agent_id: "impl-a1", escape_only: true, interrupted: true } });
    await flush();
    expect(m.published).toHaveLength(2);
    const cancel = m.published[1];
    expect(cancel?.topic).toBe("volley/default/impl-a1/mailbox");
    expect(cancel?.envelope).toMatchObject({ type: "cancel", correlation_id: sent.id });
    // Exactly one message reaches the agent.
    expect(m.published.filter((p) => p.topic.endsWith("/impl-a1/mailbox"))).toHaveLength(1);
    expect(m.events).toEqual([
      expect.objectContaining({ type: "sending" }),
      { type: "interrupt", id: sent.id, interrupted: true },
      { type: "puback", id: sent.id },
    ]);
  });

  it("/stop names the target's role, so volleyd interrupts that agent, not the stage's (P2-7)", async () => {
    const m = setup();
    const reviewer: SteerTarget = { ...AGENT, agentId: "spec-a1", role: "spec_reviewer" };
    const sent = m.transport.send(reviewer, "/stop");
    await flush();
    expect(m.published[0]?.envelope.payload).toMatchObject({
      op: "steer",
      escape_only: true,
      task: "T2",
      role: "spec_reviewer",
    });
    answer(m, { ok: true, result: { agent_id: "spec-a1", interrupted: true } });
    await flush();
    expect(m.events).toContainEqual({ type: "interrupt", id: sent.id, interrupted: true });
  });

  it("an interrupt that reached another agent is not reported as interrupting the target", async () => {
    const m = setup();
    const sent = m.transport.send(AGENT, "/stop");
    await flush();
    answer(m, { ok: true, result: { agent_id: "spec-a1", interrupted: true } });
    await flush();
    expect(m.events).toContainEqual({
      type: "interrupt",
      id: sent.id,
      interrupted: false,
      reason: "volleyd interrupted spec-a1, not impl-a1",
    });
  });

  it("Urgent mode: interrupt request, then the steering message", async () => {
    const m = setup();
    m.transport.send(AGENT, "rebase first", { urgent: true });
    await flush();
    answer(m, { ok: true, result: { interrupted: true } });
    await flush();
    expect(m.published.map((p) => p.envelope.type)).toEqual(["query", "steering"]);
  });

  it("no interrupt wired: delivered anyway, recorded as not interrupted", async () => {
    const m = setup();
    const sent = m.transport.send(AGENT, "/stop");
    await flush();
    answer(m, { ok: true, result: { interrupted: false } });
    await flush();
    expect(m.published.map((p) => p.envelope.type)).toEqual(["query", "cancel"]);
    expect(m.events).toContainEqual({
      type: "interrupt",
      id: sent.id,
      interrupted: false,
      reason: "volleyd has no interrupt for this agent",
    });
  });

  it("a refused or unanswered interrupt still delivers the message, with the reason", async () => {
    const m = setup();
    const refused = m.transport.send(AGENT, "/stop");
    await flush();
    answer(m, { ok: false, error: "wave status-chip is owned by coordinator-x" });
    await flush();
    expect(m.events).toContainEqual({
      type: "interrupt",
      id: refused.id,
      interrupted: false,
      reason: "wave status-chip is owned by coordinator-x",
    });
    const silent = m.transport.send(AGENT, "/stop");
    await new Promise((r) => setTimeout(r, 80));
    expect(m.events).toContainEqual(
      expect.objectContaining({ type: "interrupt", id: silent.id, interrupted: false }),
    );
    expect(m.published.map((p) => p.envelope.type)).toEqual(["query", "cancel", "query", "cancel"]);
  });

  it("a target with no wave task (a coordinator) is not interrupted and gets no daemon request", async () => {
    const m = setup();
    const sent = m.transport.send(
      { agentId: "coordinator-k2", namespace: "default", coordinator: true, wave: "w" },
      "/stop",
    );
    await flush();
    expect(m.published.map((p) => p.envelope.type)).toEqual(["cancel"]);
    expect(m.events).toContainEqual({
      type: "interrupt",
      id: sent.id,
      interrupted: false,
      reason: "no wave task to interrupt",
    });
  });

  it("supersedes chains only steering: a nudge or cancel supersedes nothing and is never superseded", async () => {
    const m = setup();
    const a = m.transport.send(AGENT, "keep the rename out of this PR");
    const nudge = m.transport.send(AGENT, "/status");
    const b = m.transport.send(AGENT, "include the docs");
    await flush();
    expect(nudge).toMatchObject({ type: "nudge", seq: 2 });
    expect(nudge.supersedes).toBeUndefined();
    expect(b).toMatchObject({ type: "steering", seq: 3, supersedes: a.id });
    expect(
      (m.published[1]?.envelope.payload as { supersedes?: string }).supersedes,
    ).toBeUndefined();
  });

  it("a refused publish is reported as failed", async () => {
    const { transport, events } = setup({ refuse: true });
    const sent = transport.send(AGENT, "hello");
    await flush();
    expect(events.at(-1)).toEqual({ type: "failed", id: sent.id, error: "not authorised" });
  });

  it("control() resolves with the daemon's ack on the Desk's own mailbox", async () => {
    const { transport, published, deliver, handlers } = setup();
    const reply = transport.control("claim", { wave: "leaderboard" });
    await flush();
    const req = published[0];
    expect(req?.topic).toBe("volley/default/volleyd/mailbox");
    expect(req?.envelope).toMatchObject({
      type: "query",
      payload: { op: "claim", wave: "leaderboard", by: "desk" },
    });
    // An ack from anyone but the daemon, or for another id, is ignored.
    const ack = (agent_id: string, correlation_id: unknown) => ({
      topic: "volley/default/desk/mailbox",
      receivedAt: 1,
      envelope: {
        schema_version: "0.1",
        agent_id,
        channel: "mailbox",
        type: "ack",
        correlation_id,
        payload: {
          text: "ACKED",
          acked_type: "query",
          op: "claim",
          ok: true,
          result: { owner: "desk" },
        },
      } as Envelope,
    });
    deliver(ack("impostor", req?.envelope.correlation_id));
    deliver(ack(DAEMON_AGENT_ID, "other-id"));
    deliver(ack(DAEMON_AGENT_ID, req?.envelope.correlation_id));
    await expect(reply).resolves.toEqual({ ok: true, result: { owner: "desk" } });
    expect(handlers.size).toBe(0);
  });

  it("control() reports a daemon refusal and a timeout", async () => {
    const { transport, published, deliver } = setup();
    const refused = transport.control("claim", { wave: "w" });
    await flush();
    deliver({
      topic: "volley/default/desk/mailbox",
      receivedAt: 1,
      envelope: {
        schema_version: "0.1",
        agent_id: DAEMON_AGENT_ID,
        channel: "mailbox",
        type: "ack",
        correlation_id: published[0]?.envelope.correlation_id ?? null,
        payload: { text: "ACKED", ok: false, error: "wave w is owned by coordinator-x" },
      },
    });
    await expect(refused).resolves.toEqual({
      ok: false,
      error: "wave w is owned by coordinator-x",
    });
    await expect(transport.control("claim", { wave: "w" })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/did not answer/),
    });
  });
  it("control() takes a per-request timeout in place of the default", async () => {
    const { transport } = setup();
    await expect(transport.control("claim", { wave: "w" }, undefined, 5)).resolves.toEqual({
      ok: false,
      error: "volleyd did not answer within 0.005s",
    });
    await expect(transport.control("claim", { wave: "w" })).resolves.toEqual({
      ok: false,
      error: "volleyd did not answer within 0.05s",
    });
  });
});

describe("copySteerCommand", () => {
  it("yields the exact volleyd steer line, shell-quoted", () => {
    expect(copySteerCommand("status-chip", "T2", "keep the rename out")).toBe(
      "volleyd steer status-chip T2 'keep the rename out'",
    );
    expect(copySteerCommand("w", "T1", 'say "hi" for $5 `now`\\')).toBe(
      `volleyd steer w T1 'say "hi" for $5 \`now\`\\'`,
    );
    // `!` (history expansion) and `'` survive an interactive bash/zsh paste.
    expect(copySteerCommand("w", "T1", "Stop now! it's $HOME")).toBe(
      `volleyd steer w T1 'Stop now! it'\\''s $HOME'`,
    );
  });

  it("names the agent's role, so the command reaches that agent (P2-7)", () => {
    expect(copySteerCommand("w", "T1", "hold on", "quality_reviewer")).toBe(
      "volleyd steer w T1 'hold on' --role quality_reviewer",
    );
  });
});
