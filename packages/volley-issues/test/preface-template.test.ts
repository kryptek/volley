import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TEMPLATE = join(
  fileURLToPath(new URL("..", import.meta.url)),
  "templates",
  "brief-preface.md",
);

describe("templates/brief-preface.md", () => {
  it("gives the changelog-fragment rule as the first example under Repository rules", () => {
    const rules = readFileSync(TEMPLATE, "utf8").split("## Repository rules")[1] ?? "";
    expect(rules).toContain("changes/<issue>.<type>.md");
    expect(rules).toContain("never edit `CHANGELOG.md`");
  });

  it("carries the go/no-go AskUserQuestion convention, before the repository's own rules", () => {
    const text = readFileSync(TEMPLATE, "utf8");
    const [before = "", rules = ""] = text.split("## Repository rules");
    expect(before).toContain("## Asking for a go-ahead");
    for (const part of [
      "`AskUserQuestion`",
      "`go`",
      "`hold`",
      "`cancel`",
      "`multiSelect: false`",
    ]) {
      expect(before).toContain(part);
    }
    expect(before).toContain("never as a question at the end of your turn");
    // The hygiene rules are unchanged by it.
    expect(before).toContain("## Public-repo hygiene");
    expect(rules).not.toContain("AskUserQuestion");
  });
});
