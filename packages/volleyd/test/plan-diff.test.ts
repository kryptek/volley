import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { diffPlans, formatDiff, isEmptyDiff } from "../src/plan-diff";
import { parseWaveFile } from "../src/wave-file";

const fixture = (name: string) =>
  parseWaveFile(readFileSync(new URL(`./fixtures/waves/${name}`, import.meta.url), "utf-8"), name);

describe("diffPlans", () => {
  it("v1 → v2: added, removed and per-task changes", () => {
    const d = diffPlans(fixture("v1.yaml"), fixture("v2.yaml"));
    expect(d.added).toEqual(["T6"]);
    expect(d.removed).toEqual(["T3", "T5"]);
    expect(d.changed).toEqual([
      {
        task: "T2",
        after: { added: ["T6"], removed: [] },
        model: { from: "claude-opus-5-5", to: "claude-sonnet-5-5" },
      },
      {
        task: "T4",
        issue: { from: 104, to: 114 },
        pipeline: {
          from: ["implement", ["spec_review", "quality_review"], "merge_ready"],
          to: ["implement", "merge_ready"],
        },
      },
    ]);
    expect(isEmptyDiff(d)).toBe(false);
  });

  it("v2 → v1 is the inverse", () => {
    const d = diffPlans(fixture("v2.yaml"), fixture("v1.yaml"));
    expect(d.added).toEqual(["T3", "T5"]);
    expect(d.removed).toEqual(["T6"]);
    expect(d.changed.map((c) => c.task)).toEqual(["T2", "T4"]);
    expect(d.changed[0]?.after).toEqual({ added: [], removed: ["T6"] });
  });

  it("identical files → empty diff", () => {
    const d = diffPlans(fixture("v1.yaml"), fixture("v1.yaml"));
    expect(d).toEqual({ added: [], removed: [], changed: [] });
    expect(isEmptyDiff(d)).toBe(true);
    expect(formatDiff(d)).toBe("no structural changes\n");
  });

  it("a wave-level model or pipeline change shows on every task that inherits it", () => {
    const v1 = fixture("v1.yaml");
    const v1text = readFileSync(new URL("./fixtures/waves/v1.yaml", import.meta.url), "utf-8");
    const bumped = parseWaveFile(v1text.replace("model: claude-opus-5-5", "model: m2"));
    const d = diffPlans(v1, bumped);
    expect(d.changed.map((c) => c.task)).toEqual(["T1", "T2", "T3", "T4", "T5"]);
    expect(d.changed[0]).toEqual({ task: "T1", model: { from: "claude-opus-5-5", to: "m2" } });
  });

  it("formats a human-readable diff", () => {
    expect(formatDiff(diffPlans(fixture("v1.yaml"), fixture("v2.yaml")))).toBe(
      [
        "+ T6",
        "- T3",
        "- T5",
        "~ T2  after +T6; model claude-opus-5-5 -> claude-sonnet-5-5",
        "~ T4  issue #104 -> #114; pipeline [implement, [spec_review, quality_review], merge_ready] -> [implement, merge_ready]",
        "",
      ].join("\n"),
    );
  });
});
