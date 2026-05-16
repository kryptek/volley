import { describe, expect, it, vi } from "vitest";
import { type Envelope, buildEnvelope } from "volley-mcp/envelope";
import {
  type WebhookFetchFn,
  createWebhookSurface,
} from "../../../../src/commands/notify/surfaces/webhook";
import { makeBufferIO } from "../../../../src/io";

function envelopeFor(agentId: string, type: string): Envelope {
  return buildEnvelope({
    agentId,
    parentId: null,
    channel: "status",
    type,
    now: () => new Date("2026-05-16T00:00:00Z"),
  });
}

function jsonResponse(status: number, body = ""): Response {
  return new Response(body, { status });
}

describe("webhook surface", () => {
  it("POSTs JSON body with topic+envelope and an AbortSignal", async () => {
    const io = makeBufferIO();
    const fetchFn = vi.fn<WebhookFetchFn>().mockResolvedValue(jsonResponse(200));
    const s = createWebhookSurface({ io, url: "https://example.test/hook", fetch: fetchFn });
    const envelope = envelopeFor("alpha", "blocked");
    await s.fire({ topic: "volley/default/alpha/status", envelope });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe("https://example.test/hook");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.["content-type"]).toBe("application/json");
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ topic: "volley/default/alpha/status", envelope });
    expect(init?.signal).toBeDefined();
  });

  it("on 200 response, no stderr written", async () => {
    const io = makeBufferIO();
    const fetchFn = vi.fn<WebhookFetchFn>().mockResolvedValue(jsonResponse(200, "ok"));
    const s = createWebhookSurface({ io, url: "https://example.test/hook", fetch: fetchFn });
    await s.fire({ topic: "volley/default/alpha/status", envelope: envelopeFor("alpha", "done") });
    expect(io.readStderr()).toBe("");
  });

  it("on 500 response, stderr contains 'webhook returned 500' and the first 200 chars of body", async () => {
    const io = makeBufferIO();
    const longBody = "x".repeat(500);
    const fetchFn = vi.fn<WebhookFetchFn>().mockResolvedValue(jsonResponse(500, longBody));
    const s = createWebhookSurface({ io, url: "https://example.test/hook", fetch: fetchFn });
    await s.fire({
      topic: "volley/default/alpha/status",
      envelope: envelopeFor("alpha", "failed"),
    });
    const stderr = io.readStderr();
    expect(stderr).toContain("webhook returned 500");
    expect(stderr).toContain("x".repeat(200));
    expect(stderr).not.toContain("x".repeat(201));
  });

  it("on fetch rejection, stderr contains 'webhook failed:' and the Promise resolves", async () => {
    const io = makeBufferIO();
    const fetchFn = vi
      .fn<WebhookFetchFn>()
      .mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:9999"));
    const s = createWebhookSurface({ io, url: "https://example.test/hook", fetch: fetchFn });
    await expect(
      s.fire({
        topic: "volley/default/alpha/status",
        envelope: envelopeFor("alpha", "blocked"),
      }),
    ).resolves.toBeUndefined();
    expect(io.readStderr()).toContain("webhook failed:");
    expect(io.readStderr()).toContain("ECONNREFUSED");
  });

  it("surface name is 'webhook'", () => {
    const s = createWebhookSurface({
      io: makeBufferIO(),
      url: "https://example.test/hook",
      fetch: vi.fn<WebhookFetchFn>(),
    });
    expect(s.name).toBe("webhook");
  });
});
