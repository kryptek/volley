import { describe, expect, it } from "vitest";
import { assignTaskIds, parseDependsOn, parseIssueArg, taskIdFor } from "../src/issue-task";

describe("taskIdFor", () => {
  it("is the title's task tag", () => {
    expect(taskIdFor(68, "O0: onboarding groundwork")).toBe("O0");
    expect(taskIdFor(70, "T3b — fence follow-up")).toBe("T3b");
    expect(taskIdFor(71, "D10 - desk polish")).toBe("D10");
  });

  it("falls back to i<N> without a tag, or for a product name", () => {
    expect(taskIdFor(85, "S3: upload fails")).toBe("i85");
    expect(taskIdFor(72, "Untagged chore")).toBe("i72");
    expect(taskIdFor(74, "T4 without a separator")).toBe("i74");
    expect(taskIdFor(78)).toBe("i78");
  });
});

describe("parseDependsOn", () => {
  it("reads references, none, and list items under an empty label", () => {
    expect(parseDependsOn("Depends on: #5, #6")).toEqual({ declared: true, refs: [5, 6] });
    expect(parseDependsOn("Depends on: none")).toEqual({ declared: true, refs: [] });
    expect(parseDependsOn("No dependency line, but #12 is mentioned.")).toEqual({
      declared: false,
      refs: [],
    });
    expect(parseDependsOn("Depends on:\n- #5\n- #6 (T4)\n\nMore text #9")).toEqual({
      declared: true,
      refs: [5, 6],
    });
  });

  describe("a clause in the opening paragraph, with or without its colon (#648)", () => {
    const PRE = "Part of #100 (the epic). **T1 — title.** ";

    it("reads references from the label up to the sentence break or Blocks:", () => {
      expect(parseDependsOn(`${PRE}Depends on #101 (the wire field). Blocks: T6, T7.`)).toEqual({
        declared: true,
        refs: [101],
      });
      expect(
        parseDependsOn(
          `${PRE}Depends on #102 (renderer + parser), #103 (search endpoints), #104 (uploads). Blocks: T9.`,
        ),
      ).toEqual({ declared: true, refs: [102, 103, 104] });
      expect(
        parseDependsOn(
          `${PRE}Depends on #107 (portal composer) and #108 (admin composer). Blocks: nothing (Phase N).`,
        ),
      ).toEqual({ declared: true, refs: [107, 108] });
      expect(parseDependsOn("Depends on #5 Blocks: #9")).toEqual({ declared: true, refs: [5] });
      expect(parseDependsOn("Depends on #5, #6")).toEqual({ declared: true, refs: [5, 6] });
      // A `;` before a reference separates; before prose it ends the clause.
      expect(parseDependsOn("Depends on: #5; #6")).toEqual({ declared: true, refs: [5, 6] });
      expect(parseDependsOn("Depends on #5; see #9 for context")).toEqual({
        declared: true,
        refs: [5],
      });
    });

    it("'nothing' declares none, and prose after the clause is ignored", () => {
      expect(
        parseDependsOn(
          `${PRE}Depends on: nothing. Blocks: T1, T2, T8 (and through them every composer task).`,
        ),
      ).toEqual({ declared: true, refs: [] });
      expect(
        parseDependsOn(
          `${PRE}Depends on: nothing (pure frontend restructuring). Blocks: T7. Lands **before** T1 touches \`X.vue\` (see merge order in #100).`,
        ),
      ).toEqual({ declared: true, refs: [] });
    });

    it("prose that says 'depends on' without a reference is not a clause", () => {
      expect(parseDependsOn("Whether this ships depends on load testing.")).toEqual({
        declared: false,
        refs: [],
      });
      // A label quoted in a code span is an example, not a clause; a span holding only the
      // label is emphasis.
      for (const body of [
        "Write `Depends on: #N, #M` in the body.",
        "The note says `no Depends on:/deps: line in #…; confirm` today.",
        "The helper reads `Depends on #5` here.",
        "A pin, e.g. `` `Depends on #N` `` as is.",
      ]) {
        expect(parseDependsOn(body)).toEqual({ declared: false, refs: [] });
      }
      expect(parseDependsOn("`Depends on`: #5")).toEqual({ declared: true, refs: [5] });
      expect(parseDependsOn("Quoted `Depends on: #N`, then Depends on #7.")).toEqual({
        declared: true,
        refs: [7],
      });
    });

    it("fails closed, naming the line, its number and the leftover", () => {
      const cases: [string, RegExp][] = [
        ["Depends on #5 then #6", /'then'/],
        ["Depends on: nothing, #5", /'nothing'/],
        ["Depends on: T3, T4", /'T3, T4'/],
        ["Depends on: #5, T3", /'T3'/],
        ["The retry depends on #5 landing first.", /'landing first'/],
      ];
      for (const [line, leftover] of cases) {
        let message = "";
        try {
          parseDependsOn(line);
        } catch (e) {
          message = (e as Error).message;
        }
        expect(message).toContain(`'${line}'`);
        expect(message).toMatch(/line 1\b/);
        expect(message).toMatch(leftover);
      }
      expect(() => parseDependsOn("Intro.\n\nDepends on #5 or #6")).toThrow(/line 3\b/);
    });

    it("a Depends on clause after a deps: clause on the same line is read too", () => {
      expect(parseDependsOn("deps: #3. Also depends on #4.")).toEqual({
        declared: true,
        refs: [3, 4],
      });
      expect(() => parseDependsOn("deps: #3. Depends on #4 then #5")).toThrow(/'then'/);
    });

    it("an error in a later clause on the line names that line, not the list item's", () => {
      expect(() => parseDependsOn("Depends on:. Depends on #5 then #6\n- #7")).toThrow(
        /'Depends on:\. Depends on #5 then #6' on line 1\b/,
      );
    });
  });

  it("refuses a cross-repository reference", () => {
    expect(() => parseDependsOn("Depends on: other/repo#5", "owner/repo")).toThrow(
      /cross-repository dependency other\/repo#5/,
    );
    expect(parseDependsOn("Depends on: owner/repo#5", "owner/repo").refs).toEqual([5]);
  });
});

describe("assignTaskIds", () => {
  const issue = (number: number, title: string) => ({ number, title, body: "" });

  it("keeps tags that collide with nothing", () => {
    const r = assignTaskIds([issue(602, "B13: fix"), issue(603, "untagged")], ["B12"]);
    expect([...r.ids]).toEqual([
      [602, "B13"],
      [603, "i603"],
    ]);
    expect(r.warnings).toEqual([]);
  });

  it("a tag already taken by the wave falls back to i<N> with the collision warning", () => {
    const r = assignTaskIds([issue(602, "B12: fix")], ["B12"]);
    expect(r.ids.get(602)).toBe("i602");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/title tag 'B12' would name more than one task/);
    expect(r.warnings[0]).toMatch(/using i602 instead/);
  });

  it("so does a tag that differs from a taken id only in case", () => {
    const r = assignTaskIds([issue(602, "b12: fix")], ["B12"]);
    // `b12` is not a tag (upper-case letters only): the fallback either way.
    expect(r.ids.get(602)).toBe("i602");
    const s = assignTaskIds([issue(602, "B12a: fix")], ["b12A"]);
    expect(s.ids.get(602)).toBe("i602");
    expect(s.warnings[0]).toMatch(/title tag 'B12a'/);
  });

  it("two issues sharing a tag both fall back, as on day one", () => {
    const r = assignTaskIds([issue(1, "T1: a"), issue(2, "T1: b")]);
    expect([...r.ids.values()]).toEqual(["i1", "i2"]);
    expect(r.warnings[0]).toMatch(/\(#1, #2\)/);
  });

  it("a fallback id already taken is an error, never a silent rename", () => {
    expect(() => assignTaskIds([issue(602, "fix")], ["i602"])).toThrow(/i602/);
  });
});

describe("parseIssueArg", () => {
  it("reads N, #N and an issue URL of the wave's repository", () => {
    expect(parseIssueArg("602")).toBe(602);
    expect(parseIssueArg("#602")).toBe(602);
    expect(parseIssueArg("https://github.com/o/r/issues/602", "o/r")).toBe(602);
    expect(parseIssueArg("https://github.com/O/R/issues/602", "o/r")).toBe(602);
  });

  it("refuses another repository's URL, a pull request and anything else", () => {
    expect(() => parseIssueArg("https://github.com/x/y/issues/602", "o/r")).toThrow(/x\/y/);
    expect(() => parseIssueArg("https://github.com/o/r/issues/602")).toThrow(/issue number/);
    expect(() => parseIssueArg("https://github.com/o/r/pull/602", "o/r")).toThrow();
    expect(() => parseIssueArg("abc")).toThrow(/abc/);
    expect(() => parseIssueArg("0")).toThrow();
  });
});
