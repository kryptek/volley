import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BRIEFS_DIR, ROLES, loadTemplate, renderBrief } from "../src/brief";
import {
  HYGIENE_CHECK,
  type HygieneLevel,
  type ReviewResult,
  disagreementDecision,
  findDisagreements,
  fixupItems,
  hygieneLevel,
  hygieneText,
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

  const P3_RULE =
    "Hygiene (private repository): note as P3 any person name, local username, machine path, private hostname or IP in the diff, commit messages or PR text; it will not block the merge.";
  const render = (role: (typeof ROLES)[number], level: HygieneLevel) => {
    const t = hygieneText(level);
    return renderBrief(loadTemplate(role, BRIEFS_DIR), {
      ...VARS,
      role,
      hygiene_rule: t.rule,
      hygiene_contract: t.contract,
    });
  };

  it("hygieneText: p1 is the 0.3.1 line, p3 a non-blocking note, off nothing", () => {
    expect(HYGIENE_CHECK).toBe(
      "Public hygiene: flag as P1 any person name, local username, machine path (home directories, temp paths), private hostname or IP in the diff, commit messages or PR text.",
    );
    expect(hygieneText("p1").rule).toBe(HYGIENE_CHECK);
    expect(hygieneText("p3").rule).toBe(P3_RULE);
    expect(hygieneText("p3").rule).toContain("P3");
    expect(hygieneText("p3").rule).not.toContain("P1");
    expect(hygieneText("off")).toEqual({ rule: "", contract: "" });
  });

  it("hygieneLevel: on → p1, off → off, auto by visibility (unknown is public)", () => {
    expect(hygieneLevel("on", "private")).toBe("p1");
    expect(hygieneLevel("off", "public")).toBe("off");
    expect(hygieneLevel("auto", "public")).toBe("p1");
    expect(hygieneLevel("auto", "unknown")).toBe("p1");
    expect(hygieneLevel("auto", null)).toBe("p1");
    expect(hygieneLevel("auto", "private")).toBe("p3");
    expect(hygieneLevel("auto", "internal")).toBe("p3");
  });

  it("the reviewer briefs carry the level's rule and contract; other roles never do", () => {
    for (const role of ROLES) {
      const reviewer = role === "spec_reviewer" || role === "quality_reviewer";
      const p1 = render(role, "p1");
      const p3 = render(role, "p3");
      const off = render(role, "off");
      if (reviewer) {
        expect(p1).toContain(HYGIENE_CHECK);
        expect(p1).toContain('"hygiene": { "checked": true, "findings": [');
        expect(p1).toContain("A result without it is not accepted");
        expect(p3).toContain(P3_RULE);
        expect(p3).not.toContain(HYGIENE_CHECK);
        expect(p3).toMatch(/`hygiene` is optional/);
        expect(p3).not.toContain("A result without it is not accepted");
        expect(off).not.toContain("hygiene");
        expect(off).not.toContain("Public hygiene");
        expect(off).not.toContain('"hygiene":');
        // An empty placeholder on its own line leaves no blank paragraph or list gap.
        expect(off).not.toMatch(/\n\n\n/);
        expect(off).toMatch(/`"verdict": "approve"`\.\n\n## Rules/);
      }
      for (const brief of reviewer ? [] : [p1, p3, off]) {
        expect(brief).not.toContain(HYGIENE_CHECK);
        expect(brief).not.toContain(P3_RULE);
        expect(brief).not.toContain('"hygiene":');
      }
    }
  });

  it("parsing by level: p1 needs the block and promotes hits; p3 keeps them P3; off ignores it", () => {
    expect(parseReviewResult(fixture("no-hygiene"), "p1")).toBeNull();
    expect(parseReviewResult(fixture("no-hygiene"), "p3")).toEqual({
      findings: [],
      verdict: "approve",
    });
    expect(parseReviewResult(fixture("no-hygiene"), "off")).toEqual({
      findings: [],
      verdict: "approve",
    });
    const hit = { severity: "P3" as const, file: "docs/ops.md", line: 4, text: "a hostname" };
    const payload = {
      findings: [],
      verdict: "approve",
      hygiene: { checked: true, findings: [hit] },
    };
    const p3 = parseReviewResult(payload, "p3") as ReviewResult;
    expect(p3.findings).toEqual([hit]);
    expect(p3.hygiene?.findings).toEqual([hit]);
    // A P1 a reviewer gave anyway is still folded in as the P3 the level allows.
    const high = parseReviewResult(
      { ...payload, hygiene: { checked: true, findings: [{ ...hit, severity: "P1" }] } },
      "p3",
    ) as ReviewResult;
    expect(high.findings).toEqual([hit]);
    const p1 = parseReviewResult(payload, "p1") as ReviewResult;
    expect(p1.findings).toEqual([{ ...hit, severity: "P1" }]);
    const off = parseReviewResult(payload, "off") as ReviewResult;
    expect(off.findings).toEqual([]);
    expect(off.hygiene).toBeUndefined();
    // The default is p1 (0.3.1 behaviour).
    expect(parseReviewResult(fixture("no-hygiene"))).toBeNull();
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
