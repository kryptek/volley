import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BRIEFS_DIR, ROLES, loadTemplate, renderBrief } from "../src/brief";
import {
  HYGIENE_CHECK,
  type ReviewResult,
  disagreementDecision,
  findDisagreements,
  fixupItems,
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
    expect(review("approve-empty")).toEqual({
      findings: [],
      verdict: "approve",
      hygiene: { checked: true, findings: [] },
    });
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

  it("the owner's ruling survives a cloned review (matched by content, not identity)", () => {
    const reviews = {
      spec_reviewer: review("spec-p1"),
      quality_reviewer: review("quality-fine-same-hunk"),
    };
    const ruled = findDisagreements(reviews);
    const items = fixupItems(structuredClone(reviews), { notBlockers: ruled });
    expect(items.find((i) => i.id === "S1")?.finding.severity).toBe("P3");
  });
});

describe("public hygiene (reviewer backstop)", () => {
  const VARS = {
    agent_id: "w1-t1-x-1",
    namespace: "ns",
    wave: "w1",
    task: "T1",
    issue: 42,
    issue_title: "Title",
    issue_url: "https://github.com/example/repo/issues/42",
    model: "claude-opus-5-5",
    repo: "/w/repo",
    release_branch: "release/w1",
    branch: "b",
    worktree: "/wt",
    extra: "",
  };

  it("both reviewer briefs carry the fixed hygiene check line, with no preface and no extras", () => {
    expect(HYGIENE_CHECK).toBe(
      "Public hygiene: flag as P1 any person name, local username, machine path (home directories, temp paths), private hostname or IP in the diff, commit messages or PR text.",
    );
    for (const role of ROLES) {
      const brief = renderBrief(loadTemplate(role, BRIEFS_DIR), { ...VARS, role });
      if (role === "spec_reviewer" || role === "quality_reviewer") {
        expect(brief).toContain(HYGIENE_CHECK);
        expect(brief).toContain('"hygiene": { "checked": true, "findings": [');
      } else expect(brief).not.toContain(HYGIENE_CHECK);
    }
  });

  it("a review without hygiene.checked is unparseable", () => {
    expect(parseReviewResult(fixture("no-hygiene"))).toBeNull();
    expect(
      parseReviewResult({
        findings: [],
        verdict: "approve",
        hygiene: { checked: false, findings: [] },
      }),
    ).toBeNull();
    expect(
      parseReviewResult({ findings: [], verdict: "approve", hygiene: { checked: true } }),
    ).toBeNull();
  });

  it("hygiene findings are review findings: the fixup gets them, numbered with the rest", () => {
    const r = review("hygiene-p1");
    const hits = r.hygiene?.findings ?? [];
    expect(hits).toHaveLength(1);
    expect(r.findings).toEqual(hits);
    // Listed in both places by the reviewer: counted once.
    const both = parseReviewResult({ ...r, findings: [...hits] }) as ReviewResult;
    expect(both.findings).toHaveLength(1);
    const items = fixupItems({ quality_reviewer: r });
    expect(items.map((i) => `${i.id} ${i.finding.severity} ${i.finding.file}`)).toEqual([
      "Q1 P1 docs/setup.md",
    ]);
  });
  it("a hygiene hit listed as P2 in findings and P1 in hygiene stays a P1 (never downgraded)", () => {
    const hit = { severity: "P1" as const, file: "src/a.ts", line: 3, text: "a home path" };
    const r = parseReviewResult({
      findings: [{ ...hit, severity: "P2" }],
      verdict: "changes_requested",
      hygiene: { checked: true, findings: [hit] },
    }) as ReviewResult;
    expect(r.findings).toEqual([hit]);
    // A hygiene hit is a P1 whatever severity the reviewer gave it.
    const low = parseReviewResult({
      findings: [],
      verdict: "changes_requested",
      hygiene: { checked: true, findings: [{ ...hit, severity: "P3" }] },
    }) as ReviewResult;
    expect(low.findings).toEqual([hit]);
    expect(low.hygiene?.findings).toEqual([hit]);
  });

  it("COMMIT / PR hits tell the fixup how to handle them (gh pr edit; the owner edits the squash message)", () => {
    const r = parseReviewResult({
      findings: [],
      verdict: "changes_requested",
      hygiene: {
        checked: true,
        findings: [
          { severity: "P1", file: "COMMIT", text: "a person's name in a commit message" },
          { severity: "P1", file: "PR", text: "a home path in the PR body" },
        ],
      },
    }) as ReviewResult;
    const ctx = {
      pr_branch: "w1/T1-implementer-1",
      pr_url: "https://github.com/example/repo/pull/7",
      head: "abc1234",
      release_branch: "release/w1",
    };
    const md = renderFindingsMd(fixupItems({ spec_reviewer: r }), ctx);
    expect(md).toContain("## Hits outside the diff");
    expect(md).toContain("gh pr edit https://github.com/example/repo/pull/7");
    expect(md).toMatch(/`COMMIT`.*never rewrite.*squash-merg/s);
    // Only when there is such a hit.
    const plain = renderFindingsMd(fixupItems({ spec_reviewer: review("spec-p1") }), ctx);
    expect(plain).not.toContain("Hits outside the diff");
  });
});
