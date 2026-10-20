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
});
