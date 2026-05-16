import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseEnvelope } from "../src/lib/parse-envelope";

describe("parseEnvelope", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts a valid SPEC §3 envelope", () => {
    const payload = JSON.stringify({
      schema_version: "0.1",
      agent_id: "issue-42-fix-7a3f",
      wall_time: "2026-05-14T02:11:23.000Z",
      channel: "status",
      type: "working",
      payload: { msg: "running" },
    });
    const parsed = parseEnvelope(payload);
    expect(parsed).not.toBeNull();
    expect(parsed?.agent_id).toBe("issue-42-fix-7a3f");
    expect(parsed?.channel).toBe("status");
    expect(parsed?.type).toBe("working");
  });

  it("tolerates unknown extra fields per SPEC §3.3", () => {
    const payload = JSON.stringify({
      schema_version: "0.1",
      agent_id: "agent-1",
      channel: "progress",
      type: "tick",
      future_field: { whatever: 42 },
      another_one: "hi",
    });
    const parsed = parseEnvelope(payload);
    expect(parsed).not.toBeNull();
    expect((parsed as Record<string, unknown>).future_field).toEqual({ whatever: 42 });
  });

  it("returns null for envelopes missing schema_version", () => {
    const payload = JSON.stringify({
      agent_id: "agent-1",
      channel: "status",
      type: "working",
    });
    expect(parseEnvelope(payload)).toBeNull();
  });

  it("returns null for envelopes missing agent_id", () => {
    const payload = JSON.stringify({
      schema_version: "0.1",
      channel: "status",
      type: "working",
    });
    expect(parseEnvelope(payload)).toBeNull();
  });

  it("returns null for envelopes missing channel", () => {
    const payload = JSON.stringify({
      schema_version: "0.1",
      agent_id: "agent-1",
      type: "working",
    });
    expect(parseEnvelope(payload)).toBeNull();
  });

  it("returns null for envelopes missing type", () => {
    const payload = JSON.stringify({
      schema_version: "0.1",
      agent_id: "agent-1",
      channel: "status",
    });
    expect(parseEnvelope(payload)).toBeNull();
  });

  it("returns null and console.warns on malformed JSON", () => {
    const warn = vi.spyOn(console, "warn");
    expect(parseEnvelope("{not-json")).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it("accepts Buffer/Uint8Array payloads (mqtt.js delivers bytes by default)", () => {
    const payload = Buffer.from(
      JSON.stringify({
        schema_version: "0.1",
        agent_id: "agent-1",
        channel: "status",
        type: "done",
      }),
    );
    const parsed = parseEnvelope(payload);
    expect(parsed?.type).toBe("done");
  });

  it("returns null for non-object root values", () => {
    expect(parseEnvelope("42")).toBeNull();
    expect(parseEnvelope('"hi"')).toBeNull();
    expect(parseEnvelope("null")).toBeNull();
    expect(parseEnvelope("[]")).toBeNull();
  });
});
