import { describe, expect, it } from "vitest";
import {
  buildTopic,
  isReservedTopic,
  isValidAgentId,
  isValidNamespace,
  isValidTopicFilter,
  registryTopic,
} from "../src/topics";

describe("topics", () => {
  it("accepts conforming agent ids and namespaces", () => {
    expect(isValidAgentId("issue-42-fix-7a3f")).toBe(true);
    expect(isValidAgentId("a")).toBe(true);
    expect(isValidAgentId("a".repeat(63))).toBe(true);
    expect(isValidNamespace("example-dispatch")).toBe(true);
  });
  it("rejects ids with uppercase, spaces, leading punctuation, or over 63 chars", () => {
    expect(isValidAgentId("Issue 929")).toBe(false);
    expect(isValidAgentId("_system")).toBe(false);
    expect(isValidAgentId("-leading")).toBe(false);
    expect(isValidAgentId("a".repeat(64))).toBe(false);
    expect(isValidAgentId("")).toBe(false);
  });
  it("builds the canonical topic shape", () => {
    expect(buildTopic("example-dispatch", "issue-42-fix-7a3f", "status")).toBe(
      "volley/example-dispatch/issue-42-fix-7a3f/status",
    );
  });
  it("builds the registry topic", () => {
    expect(registryTopic("issue-42-fix-7a3f")).toBe("volley/_system/registry/issue-42-fix-7a3f");
  });
  it("flags reserved-namespace topics", () => {
    expect(isReservedTopic("volley/_system/registry/x")).toBe(true);
    expect(isReservedTopic("volley/_meta/tap/x")).toBe(true);
    expect(isReservedTopic("volley/default/agent/status")).toBe(false);
  });
  it("validates MQTT topic filters", () => {
    expect(isValidTopicFilter("volley/_system/registry/+")).toBe(true);
    expect(isValidTopicFilter("volley/+/+/status")).toBe(true);
    expect(isValidTopicFilter("volley/default/agent/#")).toBe(true);
    expect(isValidTopicFilter("")).toBe(false);
    expect(isValidTopicFilter("volley/#/status")).toBe(false);
    expect(isValidTopicFilter("volley/ab+/status")).toBe(false);
    // bare wildcards on their own are valid filters
    expect(isValidTopicFilter("#")).toBe(true);
    expect(isValidTopicFilter("+")).toBe(true);
    // # must be the final level
    expect(isValidTopicFilter("#/status")).toBe(false);
    expect(isValidTopicFilter("volley/#")).toBe(true);
    // a wildcard char mixed into a level (not occupying the whole level) is invalid
    expect(isValidTopicFilter("volley/+x/status")).toBe(false);
    expect(isValidTopicFilter("volley/x#/status")).toBe(false);
    // a space anywhere makes it invalid
    expect(isValidTopicFilter("volley/ab /status")).toBe(false);
  });
});
