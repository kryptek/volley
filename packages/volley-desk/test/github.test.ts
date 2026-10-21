import { describe, expect, it } from "vitest";
import { isIssueNumber } from "../src/lib/github";

describe("isIssueNumber", () => {
  it("accepts only a positive safe integer", () => {
    for (const n of [1, 42, Number.MAX_SAFE_INTEGER]) expect(isIssueNumber(n)).toBe(true);
    for (const n of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "7", null, undefined])
      expect(isIssueNumber(n)).toBe(false);
  });
});
