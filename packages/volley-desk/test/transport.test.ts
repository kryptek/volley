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

  it("/stop publishes a cancel plus the urgent control request to the daemon", async () => {
    const { transport, published } = setup();
    const sent = transport.send(AGENT, "/stop");
    await flush();
    expect(published).toHaveLength(2);
    const [cancel, control] = published;
    expect(cancel?.topic).toBe("volley/default/impl-a1/mailbox");
    expect(cancel?.envelope).toMatchObject({ type: "cancel", correlation_id: sent.id });
    expect(control?.topic).toBe(`volley/default/${DAEMON_AGENT_ID}/mailbox`);
    expect(control?.envelope).toMatchObject({
      agent_id: "desk",
      channel: "mailbox",
      type: "query",
      payload: {
        op: "steer",
        urgent: true,
        escape_only: true,
        message_id: sent.id,
        agent_id: "impl-a1",
        wave: "status-chip",
        task: "T2",
        by: "desk",
      },
    });
    expect(typeof (control?.envelope.payload as { text?: unknown }).text).toBe("string");
    expect(control?.envelope.correlation_id).not.toBe(sent.id);
  });

  it("Urgent mode sends steering plus the urgent control request", async () => {
    const { transport, published } = setup();
    transport.send(AGENT, "rebase first", { urgent: true });
    await flush();
    expect(published.map((p) => p.envelope.type)).toEqual(["steering", "query"]);
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
});

describe("copySteerCommand", () => {
  it("yields the exact volleyd steer line, shell-quoted", () => {
    expect(copySteerCommand("status-chip", "T2", "keep the rename out")).toBe(
      'volleyd steer status-chip T2 "keep the rename out"',
    );
    expect(copySteerCommand("w", "T1", 'say "hi" for $5 `now`\\')).toBe(
      'volleyd steer w T1 "say \\"hi\\" for \\$5 \\`now\\`\\\\"',
    );
  });
});
