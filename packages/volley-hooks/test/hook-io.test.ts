import { describe, expect, it } from "vitest";
import { QUESTION_MAX, boundQuestion, clip, questionOf } from "../src/lib/hook-io";

describe("questionOf", () => {
  it("is the whole last paragraph when the text ends in a question", () => {
    expect(questionOf("Done.\n\nShould I merge?\nIt has approvals.\nOr wait for CI?")).toBe(
      "Should I merge?\nIt has approvals.\nOr wait for CI?",
    );
    expect(questionOf("All green.")).toBeNull();
    expect(questionOf(undefined)).toBeNull();
  });

  it("reads the unclipped text: a long turn's trailing question survives", () => {
    const raw = `${"status line\n".repeat(60)}\nShould I merge PR 12 now?`;
    expect(questionOf(clip(raw, 500))).toBeNull();
    expect(questionOf(raw)).toBe("Should I merge PR 12 now?");
  });

  it("bounds a huge question to its end, behind a marker", () => {
    const q = `${"x".repeat(QUESTION_MAX + 100)} ok?`;
    const bounded = boundQuestion(q);
    expect(bounded.startsWith(`[… ${q.length - QUESTION_MAX} earlier characters omitted`)).toBe(
      true,
    );
    expect(bounded.endsWith(" ok?")).toBe(true);
    expect(bounded.length).toBeLessThan(QUESTION_MAX + 100);
    expect(boundQuestion("short?")).toBe("short?");
  });
});
