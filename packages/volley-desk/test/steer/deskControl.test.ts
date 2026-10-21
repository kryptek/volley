import { describe, expect, it, vi } from "vitest";
import { DESK_LOGIN_OPS, routeDeskControl } from "../../src/steer/deskControl";
import type { SteerTransport } from "../../src/steer/transport";
import { type ReplyKey, createAuthOps } from "../../src/store/control";
import type { DeskMessage, Envelope } from "../../src/store/types";

const plainKey = async (): Promise<ReplyKey> => ({
  jwk: { kty: "RSA", n: "n", e: "AQAB" },
  open: async (sealed) => JSON.parse(sealed) as Record<string, unknown>,
});

/** A fake SteerClient: what was published, and volleyd's answers on the reply topic. */
function mockClient() {
  const published: { topic: string; envelope: Envelope }[] = [];
  const handlers = new Set<(m: DeskMessage) => void>();
  return {
    published,
    client: {
      publish: vi.fn(async (topic: string, payload: string) => {
        published.push({ topic, envelope: JSON.parse(payload) as Envelope });
      }),
      onMessage: (h: (m: DeskMessage) => void) => {
        handlers.add(h);
        return () => handlers.delete(h);
      },
    },
    answer(correlationId: string, payload: Record<string, unknown>) {
      const topic = `volley/_system/auth/replies/${correlationId}`;
      const envelope = {
        schema_version: "0.1",
        agent_id: "volleyd",
        parent_id: null,
        channel: "_system/auth",
        type: "ack",
        wall_time: "2026-10-21T12:00:00.000Z",
        correlation_id: correlationId,
        payload,
      } as Envelope;
      for (const h of [...handlers]) h({ topic, envelope } as DeskMessage);
    },
  };
}

const answer = { id: "d-w1-d-abc", version: 1, answer: "fine", where: { kind: "desk" } };

function setup(role: string | null = null) {
  const m = mockClient();
  const authOps = createAuthOps(m.client, { identity: "steer-1", replyKey: plainKey });
  const mailbox = vi.fn<SteerTransport["control"]>(async () => ({ ok: true, result: "mailbox" }));
  return { m, mailbox, control: routeDeskControl(mailbox, authOps, role) };
}

/** The first published request, once it is out. */
async function sent(m: ReturnType<typeof mockClient>) {
  for (let i = 0; i < 50 && m.published.length === 0; i++)
    await new Promise((r) => setTimeout(r, 0));
  return m.published[0] as { topic: string; envelope: Envelope };
}

describe("routeDeskControl: Needs-you answers travel the Desk's own account-op topic", () => {
  it("names inbox_answer and resolve", () => {
    expect([...DESK_LOGIN_OPS]).toEqual(["inbox_answer", "resolve"]);
  });

  it("inbox_answer is published on volley/_system/auth/ops/<identity>, answered by volleyd's ack", async () => {
    const { m, mailbox, control } = setup();
    const pending = control?.("inbox_answer", answer);
    const req = await sent(m);
    expect(req.topic).toBe("volley/_system/auth/ops/steer-1");
    expect(req.envelope.payload).toMatchObject({ op: "inbox_answer", ...answer });
    expect((req.envelope.payload as Record<string, unknown>).reply_key).toBeDefined();
    m.answer(req.envelope.correlation_id as string, {
      ok: false,
      op: "inbox_answer",
      error: "already answered on desk·phone",
    });
    expect(await pending).toEqual({ ok: false, error: "already answered on desk·phone" });
    expect(mailbox).not.toHaveBeenCalled();
  });

  it("resolve goes the same way; its result comes back", async () => {
    const { m, mailbox, control } = setup();
    const pending = control?.(
      "resolve",
      { decision_id: "d-abc", answer: "fine" },
      "volleyd resolve",
    );
    const req = await sent(m);
    expect(req.topic).toBe("volley/_system/auth/ops/steer-1");
    expect(req.envelope.payload).toMatchObject({ op: "resolve", decision_id: "d-abc" });
    m.answer(req.envelope.correlation_id as string, { ok: true, result: { wave: "w1" } });
    expect(await pending).toEqual({ ok: true, result: { wave: "w1" } });
    expect(mailbox).not.toHaveBeenCalled();
  });

  it("an unanswered Needs-you answer names the role migration a broker may still need", async () => {
    const { mailbox, control } = setup();
    const r = await control?.("inbox_answer", answer, undefined, 20);
    expect(r?.ok).toBe(false);
    expect(r?.error).toMatch(/^volleyd did not answer within 0\.02s/);
    expect(r?.error).toContain("volley auth migrate --roles --yes");
    expect(mailbox).not.toHaveBeenCalled();
  });

  it("a login whose role grants no Desk answers (watch) gets no migration hint", async () => {
    const { control } = setup("watch");
    const r = await control?.("inbox_answer", answer, undefined, 20);
    expect(r?.ok).toBe(false);
    expect(r?.error).toMatch(/^volleyd did not answer within 0\.02s/);
    expect(r?.error).not.toContain("volley auth migrate");
  });

  it("a steer or admin login keeps the migration hint", async () => {
    for (const role of ["steer", "admin"]) {
      const { control } = setup(role);
      const r = await control?.("inbox_answer", answer, undefined, 20);
      expect(r?.error).toContain("volley auth migrate --roles --yes");
    }
  });

  it("every other op still goes to volleyd's mailbox", async () => {
    const { m, mailbox, control } = setup();
    expect(await control?.("claim", { wave: "w1" }, "volleyd claim w1")).toEqual({
      ok: true,
      result: "mailbox",
    });
    expect(mailbox).toHaveBeenCalledWith("claim", { wave: "w1" }, "volleyd claim w1", undefined);
    expect(m.published).toEqual([]);
  });

  it("without the admin channel (read-only, demo) every op goes to the mailbox", async () => {
    const mailbox = vi.fn<SteerTransport["control"]>(async () => ({ ok: true }));
    const control = routeDeskControl(mailbox, null);
    await control?.("inbox_answer", answer);
    expect(mailbox).toHaveBeenCalledWith("inbox_answer", answer);
    expect(routeDeskControl(null, null)).toBeNull();
  });
});
