import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  citedSections,
  citesDesignDoc,
  fileProblems,
  numberingProblems,
  specSections,
} from "./check-spec-refs";

/**
 * `head rest`, joined at runtime: the repo scan reads this file too, so a design-doc citation
 * or an unknown SPEC section written out literally would flag this file's own source.
 */
const cite = (head: string, rest: string) => `${head} ${rest}`;

describe("specSections", () => {
  test("reads numbered headings at every level", () => {
    const spec = "# Title\n## 1. Intro\n### 1.1 Scope\n#### 1.1.1 Detail\n## 2. Topics\nno §9\n";
    expect(specSections(spec)).toEqual(["1", "1.1", "1.1.1", "2"]);
  });
});

describe("numberingProblems", () => {
  test("clean numbering has no problems", () => {
    expect(numberingProblems(["1", "1.1", "1.2", "2", "2.1"])).toEqual([]);
  });

  test("a gap", () => {
    expect(numberingProblems(["1", "3"])).toEqual(["§3 follows §1"]);
    expect(numberingProblems(["1", "1.1", "1.2", "1.4"])).toEqual(["§1.4 follows §1.2"]);
    expect(numberingProblems(["1", "1.2"])).toEqual(["§1.2 is the first under §1"]);
  });

  test("a duplicate", () => {
    expect(numberingProblems(["1", "1.1", "1.1"])).toEqual(["§1.1 follows §1.1"]);
  });

  test("a missing parent", () => {
    expect(numberingProblems(["1", "2.1"])).toEqual(["§2.1 has no parent §2"]);
  });
});

describe("citedSections", () => {
  const refs = (text: string, isSpec = false) => citedSections(text, isSpec).map((r) => r.ref);

  test("a single reference, with and without .md", () => {
    expect(refs("see SPEC §4.6 and SPEC.md §2.2.")).toEqual(["4.6", "2.2"]);
  });

  test("a list after one SPEC", () => {
    expect(refs("SPEC §3, §4.3 and §4.6.1")).toEqual(["3", "4.3", "4.6.1"]);
    expect(refs("SPEC §4.4/§4.6")).toEqual(["4.4", "4.6"]);
  });

  test("a §§ range or list", () => {
    expect(refs("SPEC §§4.4–4.6")).toEqual(["4.4"]);
    expect(refs("SPEC §§4.4, §4.6")).toEqual(["4.4", "4.6"]);
  });

  test("a dotted number with no §", () => {
    expect(refs("per SPEC 4.6, the retained state")).toEqual(["4.6"]);
    expect(refs("SPEC 4.6.1")).toEqual(["4.6.1"]);
  });

  test("spec section N.N", () => {
    expect(refs("as spec section 7.2 says")).toEqual(["7.2"]);
  });

  test("a trailing .x keeps the parent", () => {
    expect(refs("SPEC §4.6.x")).toEqual(["4.6"]);
  });

  test("ignores § outside a SPEC reference in other files, but not inside SPEC.md", () => {
    expect(refs(cite("the design", "§5 covers it"))).toEqual([]);
    expect(refs("see §5 above", true)).toEqual(["5"]);
  });

  test("reports the line number", () => {
    expect(citedSections("one\nSPEC §2\n", false)).toEqual([{ ref: "2", line: 2 }]);
  });
});

describe("citesDesignDoc", () => {
  test.each([
    cite("design doc", "§8.5"),
    cite("the design doc's", "§3"),
    cite("design doc", "section 8.5"),
    cite("Design doc's", "section 2"),
    cite("design", "§4"),
  ])("flags %p", (line) => {
    expect(citesDesignDoc(line)).toBe(true);
  });

  test("leaves plain mentions alone", () => {
    expect(citesDesignDoc("the design doc lives under docs/")).toBe(false);
    expect(citesDesignDoc("SPEC §4.6")).toBe(false);
  });
});

describe("fileProblems", () => {
  const known = new Set(
    specSections(readFileSync(join(import.meta.dir, "../spec/SPEC.md"), "utf-8")),
  );

  test("flags a design-doc citation and an unknown SPEC section, with file and line", () => {
    expect(
      fileProblems(
        "docs/x.md",
        `ok\n${cite("see design doc", "§8.5")}\n${cite("SPEC", "§99.1")}\n`,
        known,
      ),
    ).toEqual([
      `docs/x.md:3: ${cite("cites SPEC", "§99.1")}, which does not exist`,
      "docs/x.md:2: cites the local-only design doc by section",
    ]);
  });

  test("this test file's own fixtures do not trip the repo scan", () => {
    expect(
      fileProblems(
        "scripts/check-spec-refs.test.ts",
        readFileSync(import.meta.path, "utf-8"),
        known,
      ),
    ).toEqual([]);
  });
});
