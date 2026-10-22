import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  citedSections,
  citesDesignDoc,
  fileProblems,
  listProblems,
  numberingProblems,
  parseReserved,
  reservationProblems,
  specListItems,
  specListProblems,
  specSections,
  tunableKeys,
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

describe("specListItems", () => {
  const spec = [
    "intro `not_an_item`",
    "<!-- spec-list: kinds -->",
    "- `alpha` — the first (§1).",
    "- `beta` — the second,",
    "  wrapped onto a continuation line with `gamma` in it.",
    "<!-- /spec-list -->",
    "- `delta` — after the list",
  ].join("\n");

  test("reads the first code span of each top-level item between the markers", () => {
    expect(specListItems(spec, "kinds")).toEqual(["alpha", "beta"]);
  });

  test("a missing list is null", () => {
    expect(specListItems(spec, "events")).toBeNull();
  });
});

describe("listProblems", () => {
  test("names the missing and the extra item", () => {
    expect(listProblems("tunables", ["a", "c"], ["a", "b"], "config.schema.json")).toEqual([
      "the tunables list lacks `b` (in config.schema.json)",
      "the tunables list has `c`, which config.schema.json does not",
    ]);
  });

  test("a duplicate item", () => {
    expect(listProblems("kinds", ["a", "a"], ["a"], "x.json")).toEqual([
      "the kinds list has `a` twice",
    ]);
  });

  test("equal sets pass, in any order", () => {
    expect(listProblems("kinds", ["b", "a"], ["a", "b"], "x.json")).toEqual([]);
  });
});

describe("tunableKeys", () => {
  test("recurses into objects with fixed properties and stops at maps", () => {
    expect(
      tunableKeys({
        hard_ceiling: { type: "integer" },
        lease_pools: { type: "object", additionalProperties: {} },
        autopilot: {
          type: "object",
          properties: { enabled: { type: "boolean" }, weights: { properties: { cpu: {} } } },
        },
      }),
    ).toEqual(["hard_ceiling", "lease_pools", "autopilot.enabled", "autopilot.weights.cpu"]);
  });
});

describe("specListProblems", () => {
  const spec = (tunables: string[]) =>
    [
      "<!-- spec-list: decision-kinds -->",
      "- `agent_blocked` — blocked.",
      "<!-- /spec-list -->",
      "<!-- spec-list: events -->",
      "- `wave_submitted`",
      "<!-- /spec-list -->",
      "<!-- spec-list: tunables -->",
      ...tunables.map((t) => `- \`${t}\` — default 1.`),
      "<!-- /spec-list -->",
    ].join("\n");
  const sources = {
    decisionKinds: ["agent_blocked"],
    events: ["wave_submitted"],
    tunables: ["hard_ceiling", "autopilot.digest_min_interval_s"],
  };

  test("a tunables list that lacks a schema key fails naming it", () => {
    expect(specListProblems(spec(["hard_ceiling"]), sources)).toEqual([
      "the tunables list lacks `autopilot.digest_min_interval_s` (in config.schema.json)",
    ]);
  });

  test("matching lists pass", () => {
    expect(
      specListProblems(spec(["hard_ceiling", "autopilot.digest_min_interval_s"]), sources),
    ).toEqual([]);
  });

  test("a missing list fails", () => {
    expect(specListProblems("no lists here", sources)).toEqual([
      "no `<!-- spec-list: decision-kinds -->` list",
      "no `<!-- spec-list: events -->` list",
      "no `<!-- spec-list: tunables -->` list",
    ]);
  });

  test("a list without its closing marker fails naming the list", () => {
    const open = spec(["hard_ceiling", "autopilot.digest_min_interval_s"]).replace(
      /<!-- \/spec-list -->$/,
      "",
    );
    expect(specListProblems(open, sources)).toEqual([
      "the tunables list has no closing `<!-- /spec-list -->`",
    ]);
  });
});

describe("reservations", () => {
  const reserved = [
    "# Reserved",
    "",
    "| Reserved | Issue | Topic |",
    "|---|---|---|",
    "| §9.9 | #1 | foo |",
    "| `inbox_snoozed` | #2 | an event name |",
  ].join("\n");

  test("parses the section rows and ignores the rest", () => {
    expect(parseReserved(reserved)).toEqual([
      { section: "9.9", issue: "#1", topic: "foo", line: 5 },
    ]);
  });

  test("a heading with the reserved number and another topic fails", () => {
    const spec = "## 9. Nine\n### 9.9 Bar\n";
    expect(reservationProblems(spec, parseReserved(reserved))).toEqual([
      'spec/RESERVED.md:5: §9.9 is reserved for #1 (foo), but SPEC.md\'s §9.9 is "Bar"',
    ]);
  });

  test("a heading that matches the topic passes, as does a number not yet taken", () => {
    expect(
      reservationProblems("## 9. Nine\n### 9.9 Foo things\n", parseReserved(reserved)),
    ).toEqual([]);
    expect(reservationProblems("## 9. Nine\n", parseReserved(reserved))).toEqual([]);
  });

  test("a number reserved twice fails", () => {
    const twice = `${reserved}\n| §9.9 | #3 | bar |`;
    expect(reservationProblems("", parseReserved(twice))).toEqual([
      "spec/RESERVED.md:7: §9.9 is already reserved on line 5",
    ]);
  });

  test("a reservation with no topic fails", () => {
    const blank = "| §9.8 | #4 |  |";
    expect(reservationProblems("## 9. Nine\n### 9.8 Anything\n", parseReserved(blank))).toEqual([
      "spec/RESERVED.md:1: §9.8 is reserved for #4 with no topic",
    ]);
  });
});
