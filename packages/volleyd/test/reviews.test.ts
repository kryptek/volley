import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ReviewResult,
  disagreementDecision,
  findDisagreements,
  fixupItems,
  flaggedFiles,
  parseFixupResult,
  parseReviewResult,
  renderFindingsMd,
} from "../src/reviews";
import { FIXTURES } from "./helpers/fake-host";
import { schemaErrors } from "./helpers/schema";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, "review-results", `${name}.json`), "utf-8"));
const review = (name: string) => parseReviewResult(fixture(name)) as ReviewResult;

describe("review results", () => {
  it("parses a result payload that matches review-result.schema.json", () => {
    expect(review("spec-p1").findings).toHaveLength(2);
    expect(review("approve-empty")).toEqual({ findings: [], verdict: "approve" });
    expect(parseFixupResult(fixture("fixup-resolved"))?.resolved).toHaveLength(2);
  });

  it("rejects a payload without findings + verdict (or with a bad severity)", () => {
    expect(parseReviewResult(fixture("unparseable"))).toBeNull();
    expect(parseReviewResult(undefined)).toBeNull();
    expect(parseReviewResult("approve")).toBeNull();
    expect(
      parseReviewResult({
        findings: [{ severity: "P0", file: "a.ts", text: "x" }],
        verdict: "approve",
      }),
    ).toBeNull();
    expect(parseFixupResult({ resolved: [{ finding: "S1" }] })).toBeNull();
  });

  it("the spec example validates against the schema as a whole envelope", () => {
    const example = JSON.parse(
      readFileSync(
        new URL("../../../spec/examples/valid/result-review-findings.json", import.meta.url),
        "utf-8",
      ),
    );
    expect(schemaErrors("review-result.schema.json", example)).toEqual([]);
    expect(
      schemaErrors("review-result.schema.json", { ...example, type: "pr-opened" }),
    ).not.toEqual([]);
  });
});

describe("reviewer disagreement", () => {
  it("a P1 from one reviewer and a P3 'fine' from the other on the same hunk is a disagreement", () => {
    const ds = findDisagreements({
      spec_reviewer: review("spec-p1"),
      quality_reviewer: review("quality-fine-same-hunk"),
    });
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({
      file: "src/batch.ts",
      blocker: { role: "spec_reviewer", finding: { line: 42 } },
      fine: { role: "quality_reviewer", finding: { line: 45 } },
    });
    const d = disagreementDecision("T1", ds);
    expect(d.kind).toBe("reviewers_disagree");
    expect(d.task).toBe("T1");
    expect(d.question).toContain("src/batch.ts:42");
    expect(d.options).toEqual(["blocker", "fine"]);
  });

  it("P1s on different hunks, or the same hunk flagged by only one reviewer, are not", () => {
    expect(
      findDisagreements({
        spec_reviewer: review("spec-p1"),
        quality_reviewer: review("quality-p1-elsewhere"),
      }),
    ).toEqual([]);
    expect(findDisagreements({ spec_reviewer: review("spec-p1") })).toEqual([]);
    // Both say blocker: they agree.
    expect(
      findDisagreements({ spec_reviewer: review("spec-p1"), quality_reviewer: review("spec-p1") }),
    ).toEqual([]);
  });
});

describe("fixup brief", () => {
  it("carries every finding of both reviewers, every P1, and the trivial-only rule", () => {
    const items = fixupItems({
      spec_reviewer: review("spec-p1"),
      quality_reviewer: review("quality-p1-elsewhere"),
    });
    expect(items.map((i) => i.id)).toEqual(["S1", "S2", "Q1", "Q2"]);
    const md = renderFindingsMd(items, {
      pr_branch: "w1/T1-implementer-1",
      pr_url: "https://github.com/example/repo/pull/7",
      head: "abc1234",
      release_branch: "release/w1",
    });
    for (const p1 of items.filter((i) => i.finding.severity === "P1")) {
      expect(md).toContain(p1.finding.text);
      expect(md).toContain(`${p1.id} · P1`);
    }
    expect(md).toContain("src/batch.ts:42");
    expect(md).toMatch(/P2 or P3 only if the change is trivial/);
    expect(md).toContain("git push origin HEAD:w1/T1-implementer-1");
  });

  it("an owner's 'fine' on a disagreement downgrades that P1 to P3 for the fixup", () => {
    const reviews = {
      spec_reviewer: review("spec-p1"),
      quality_reviewer: review("quality-fine-same-hunk"),
    };
    const items = fixupItems(reviews, { notBlockers: findDisagreements(reviews) });
    expect(items.find((i) => i.id === "S1")?.finding.severity).toBe("P3");
    expect(items.find((i) => i.id === "S1")?.note).toMatch(/not a blocker/);
    expect(fixupItems(reviews).find((i) => i.id === "S1")?.finding.severity).toBe("P1");
  });

  it("flagged files are every file a reviewer named", () => {
    expect([...flaggedFiles(review("quality-p1-elsewhere"))].sort()).toEqual([
      "src/batch.ts",
      "src/retry.ts",
    ]);
  });
});
