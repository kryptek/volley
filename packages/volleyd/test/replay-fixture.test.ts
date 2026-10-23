import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The replay fixture (scripts/replay-fixture.ts regenerates it): the 26 issues of the dogfood
 * wave with the Files lists their bodies carry, and the repository tree's file sizes. The
 * footprint resolver and the overlap planner replay it.
 */
const read = (f: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/replay/${f}`, import.meta.url), "utf8"));

describe("the replay fixture", () => {
  const issues = read("dogfood-26.json") as {
    id: string;
    issue: number;
    title: string;
    files: string[];
  }[];
  const tree = read("tree.json") as Record<string, number>;

  it("holds the 26 dogfood issues, each with a non-empty Files list", () => {
    expect(issues).toHaveLength(26);
    expect(new Set(issues.map((i) => i.issue)).size).toBe(26);
    for (const i of issues) {
      expect(i.id).toBe(`i${i.issue}`);
      expect(i.title).not.toBe("");
      expect(i.files.length).toBeGreaterThan(0);
    }
  });

  it("names no path outside the repository", () => {
    for (const f of issues.flatMap((i) => i.files)) expect(f).not.toMatch(/^[/~]|\.\./);
  });

  it("maps every tree path under packages/, spec/, scripts/, docs/ and the root to its bytes", () => {
    const paths = Object.keys(tree);
    expect(paths).toContain("spec/SPEC.md");
    expect(paths).toContain("package.json");
    for (const p of paths) {
      expect(p).toMatch(/^((packages|spec|scripts|docs)\/[^/].*|[^/]+)$/);
      expect(Number.isInteger(tree[p]) && (tree[p] as number) >= 0).toBe(true);
    }
  });
});
