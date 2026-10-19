import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newId } from "../src/lib/id";
import { createConfigTransport } from "../src/settings/configTransport";
import { createSteerTransport } from "../src/steer/transport";
import { createAuthOps } from "../src/store/control";
import type { DeskMessage, Envelope } from "../src/store/types";

/** RFC 4122 version 4, as the envelope's `correlation_id` (format: uuid) requires. */
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function mockClient() {
  const published: { topic: string; envelope: Envelope }[] = [];
  return {
    published,
    client: {
      publish: vi.fn(async (topic: string, payload: string) => {
        published.push({ topic, envelope: JSON.parse(payload) as Envelope });
      }),
      onMessage: (_h: (m: DeskMessage) => void) => () => {},
    },
  };
}

// A phone at http://<lan address>:5199 is not a secure context: `crypto.randomUUID` is missing there.
describe("on plain http (no crypto.randomUUID)", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", {
      getRandomValues: <T extends ArrayBufferView>(a: T) => webcrypto.getRandomValues(a as never),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("newId makes version 4 UUIDs from getRandomValues", () => {
    const a = newId();
    expect(a).toMatch(UUID4);
    expect(newId()).not.toBe(a);
  });

  it("a steer is sent", () => {
    const { client, published } = mockClient();
    const t = createSteerTransport(client, { identity: "desk-phone", onEvent: () => {} });
    expect(() =>
      t.send({ agentId: "impl-a1", namespace: "default", coordinator: false }, "check the tests"),
    ).not.toThrow();
    expect(published[0]?.envelope.correlation_id).toMatch(UUID4);
  });

  it("a config change is sent", async () => {
    const { client, published } = mockClient();
    const t = createConfigTransport(client, { identity: "desk-phone", timeoutMs: 10 });
    await t.send({ fallback_model: "claude-haiku-5-5" });
    expect(published[0]?.envelope.correlation_id).toMatch(UUID4);
  });

  it("an account op is sent with a uuid correlation id", async () => {
    const { client, published } = mockClient();
    const ops = createAuthOps(client, {
      identity: "admin-0123abcd",
      timeoutMs: 10,
      replyKey: async () => ({ jwk: { kty: "RSA", n: "n", e: "AQAB" }, open: async () => ({}) }),
    });
    await ops.request("account_list");
    expect(published[0]?.envelope.correlation_id).toMatch(UUID4);
  });
});
