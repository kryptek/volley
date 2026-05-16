import { describe, expect, it } from "vitest";
import { parseTopic } from "../src/lib/parse-topic";

describe("parseTopic", () => {
  it("parses status topics into namespace/agentId/channel", () => {
    expect(parseTopic("volley/default/coordinator-clu1/status")).toEqual({
      namespace: "default",
      agentId: "coordinator-clu1",
      channel: "status",
    });
  });

  it("parses progress topics", () => {
    expect(parseTopic("volley/ci/typecheck-rt7m/progress")).toEqual({
      namespace: "ci",
      agentId: "typecheck-rt7m",
      channel: "progress",
    });
  });

  it("parses mailbox topics", () => {
    expect(parseTopic("volley/prod/security-scan-w7e1/mailbox")).toEqual({
      namespace: "prod",
      agentId: "security-scan-w7e1",
      channel: "mailbox",
    });
  });

  it("parses result topics", () => {
    expect(parseTopic("volley/default/issue-43-fix-2b9e/result")).toEqual({
      namespace: "default",
      agentId: "issue-43-fix-2b9e",
      channel: "result",
    });
  });

  it("special-cases the _system/registry topic as channel=system", () => {
    expect(parseTopic("volley/_system/registry/coordinator-clu1")).toEqual({
      namespace: "_system",
      agentId: "coordinator-clu1",
      channel: "system",
    });
  });

  it("returns null for unknown channels", () => {
    expect(parseTopic("volley/default/agent-1/unknown")).toBeNull();
  });

  it("returns null for topics missing the volley prefix", () => {
    expect(parseTopic("foo/default/agent-1/status")).toBeNull();
  });

  it("returns null for topics with wrong segment count", () => {
    expect(parseTopic("volley/default/status")).toBeNull();
    expect(parseTopic("volley/default/agent-1/status/extra")).toBeNull();
    expect(parseTopic("")).toBeNull();
  });

  it("returns null for non-registry topics inside the _system namespace", () => {
    expect(parseTopic("volley/_system/foo/status")).toBeNull();
  });
});
