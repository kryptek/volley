import { describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  buildEnvelope,
  isSupportedSchemaVersion,
  parseEnvelope,
} from "../src/envelope";

describe("buildEnvelope", () => {
  it("produces a complete v0.1 envelope with an injected clock", () => {
    const env = buildEnvelope({
      agentId: "issue-42-fix-7a3f",
      parentId: "coordinator-abcd",
      channel: "status",
      type: "working",
      payload: { issue: 929 },
      correlationId: null,
      now: () => new Date("2026-05-14T02:08:55.000Z"),
    });
    expect(env).toEqual({
      schema_version: "0.1",
      agent_id: "issue-42-fix-7a3f",
      parent_id: "coordinator-abcd",
      wall_time: "2026-05-14T02:08:55.000Z",
      channel: "status",
      type: "working",
      payload: { issue: 929 },
      correlation_id: null,
    });
  });
  it("defaults payload to {} and correlation_id to null", () => {
    const env = buildEnvelope({
      agentId: "a",
      parentId: null,
      channel: "progress",
      type: "tick",
      now: () => new Date("2026-05-14T00:00:00.000Z"),
    });
    expect(env.payload).toEqual({});
    expect(env.correlation_id).toBeNull();
    expect(env.schema_version).toBe(SCHEMA_VERSION);
  });
});

describe("isSupportedSchemaVersion", () => {
  it("accepts 0.x versions and rejects everything else", () => {
    expect(isSupportedSchemaVersion("0.1")).toBe(true);
    expect(isSupportedSchemaVersion("0.9")).toBe(true);
    expect(isSupportedSchemaVersion("1.0")).toBe(false);
    expect(isSupportedSchemaVersion("99.0")).toBe(false);
    expect(isSupportedSchemaVersion(undefined)).toBe(false);
    expect(isSupportedSchemaVersion(0.1)).toBe(false);
  });
});

describe("parseEnvelope", () => {
  const valid = JSON.stringify({
    schema_version: "0.1",
    agent_id: "a",
    parent_id: null,
    wall_time: "2026-05-14T00:00:00.000Z",
    channel: "status",
    type: "done",
    payload: { ok: true },
    correlation_id: null,
  });
  it("parses a well-formed envelope", () => {
    const env = parseEnvelope(valid);
    expect(env?.agent_id).toBe("a");
    expect(env?.type).toBe("done");
    expect(env?.payload).toEqual({ ok: true });
  });
  it("returns null for malformed JSON", () => {
    expect(parseEnvelope("{not json")).toBeNull();
  });
  it("returns null when required envelope fields are missing", () => {
    expect(parseEnvelope(JSON.stringify({ agent_id: "a" }))).toBeNull();
  });
  it("still parses an envelope whose schema_version is unsupported", () => {
    const future = JSON.stringify({
      schema_version: "9.9",
      agent_id: "a",
      wall_time: "2026-05-14T00:00:00.000Z",
      channel: "status",
      type: "done",
    });
    expect(parseEnvelope(future)?.schema_version).toBe("9.9");
  });
  it("passes through a registry envelope's top-level namespace field", () => {
    const registry = JSON.stringify({
      schema_version: "0.1",
      agent_id: "a",
      wall_time: "2026-05-14T00:00:00.000Z",
      channel: "_system/registry",
      type: "registered",
      namespace: "example-dispatch",
    });
    expect(parseEnvelope(registry)?.namespace).toBe("example-dispatch");
  });
  it("leaves namespace undefined on a non-registry envelope", () => {
    const status = JSON.stringify({
      schema_version: "0.1",
      agent_id: "a",
      wall_time: "2026-05-14T00:00:00.000Z",
      channel: "status",
      type: "done",
    });
    expect(parseEnvelope(status)?.namespace).toBeUndefined();
  });
});
