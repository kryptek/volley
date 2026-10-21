import { describe, expect, it } from "vitest";
import { autoCompactWindowTokens, contextWindowTokens } from "../../src/claude/context-window";

describe("contextWindowTokens", () => {
  it.each([
    "claude-opus-5-5",
    "claude-sonnet-5",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
    "claude-fable-5-1",
    "opus",
    "sonnet",
    "haiku",
    "fable",
    "claude-opus-4-7",
    "claude-opus-4-6[1m]",
    "us.anthropic.claude-sonnet-4-6-v1:0[1m]",
  ])("%s runs with a 1M window", (model) => {
    expect(contextWindowTokens(model)).toBe(1_000_000);
  });

  it.each([
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5",
    "claude-haiku-4-5",
    "claude-haiku-5",
    "claude-sonnet-4-5@20250929",
    "us.anthropic.claude-opus-4-1-20250805-v1:0",
    "arn:aws:bedrock:us-east-1:123456789012:inference-profile/x",
    "my-gateway-opus",
  ])("%s runs with a 200K window", (model) => {
    expect(contextWindowTokens(model)).toBe(200_000);
  });
});

describe("autoCompactWindowTokens", () => {
  it("is that share of the model's window, in tokens", () => {
    expect(autoCompactWindowTokens("claude-opus-5-5", 85)).toBe(850_000);
    expect(autoCompactWindowTokens("claude-opus-4-6[1m]", 85)).toBe(850_000);
    expect(autoCompactWindowTokens("claude-opus-4-6", 85)).toBe(170_000);
    expect(autoCompactWindowTokens("claude-opus-5-5", 100)).toBe(1_000_000);
  });

  it("is clamped to Claude Code's accepted 100000..1000000", () => {
    expect(autoCompactWindowTokens("claude-sonnet-4-5", 40)).toBe(100_000);
    expect(autoCompactWindowTokens("claude-sonnet-4-5", 1)).toBe(100_000);
  });

  it("is undefined at 0: Claude Code's own default applies", () => {
    expect(autoCompactWindowTokens("claude-opus-5-5", 0)).toBeUndefined();
    expect(autoCompactWindowTokens("claude-sonnet-4-5", 0)).toBeUndefined();
  });

  it("is always an integer", () => {
    for (let pct = 1; pct <= 100; pct++) {
      for (const model of ["claude-opus-5-5", "claude-opus-4-6"]) {
        expect(Number.isInteger(autoCompactWindowTokens(model, pct))).toBe(true);
      }
    }
    expect(Number.isInteger(autoCompactWindowTokens("claude-opus-4-6", 77.7))).toBe(true);
  });
});
