import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseSimpleYaml,
  splitFrontmatter,
  validateDispatch,
  validateFrontmatter,
  validateSkill,
} from "../scripts/validate-skill";

const GOOD_FRONTMATTER = `---
name: volley-wait
description: Block a Claude Code session event-driven on a Volley topic
user_invocable: true
---
`;

const SKILL_MD_PATH = join(import.meta.dirname, "..", "SKILL.md");

describe("splitFrontmatter", () => {
  it("returns the frontmatter block and the body when both exist", () => {
    const r = splitFrontmatter(`${GOOD_FRONTMATTER}body\nmore\n`);
    expect(r.frontmatter).toContain("name: volley-wait");
    expect(r.body.trim()).toBe("body\nmore");
  });
  it("returns frontmatter:null when the file does not start with ---", () => {
    expect(splitFrontmatter("# heading\nbody\n").frontmatter).toBeNull();
  });
  it("returns frontmatter:null when the second --- is missing", () => {
    expect(splitFrontmatter("---\nname: volley-wait\nno-close").frontmatter).toBeNull();
  });
});

describe("parseSimpleYaml", () => {
  it("parses string and boolean values", () => {
    expect(parseSimpleYaml("name: volley-wait\nuser_invocable: true\n")).toEqual({
      name: "volley-wait",
      user_invocable: true,
    });
  });
  it("ignores blank and comment lines", () => {
    expect(parseSimpleYaml("# comment\nname: volley-wait\n\nuser_invocable: false\n")).toEqual({
      name: "volley-wait",
      user_invocable: false,
    });
  });
  it("strips quotes from quoted values", () => {
    expect(parseSimpleYaml('name: "volley-wait"\n')).toEqual({ name: "volley-wait" });
  });
  it("throws on unparseable lines", () => {
    expect(() => parseSimpleYaml("not a key value\n")).toThrow(/unparseable/);
  });
});

describe("validateFrontmatter", () => {
  it("accepts a valid frontmatter block", () => {
    expect(validateFrontmatter(GOOD_FRONTMATTER).ok).toBe(true);
  });
  it("rejects a file without frontmatter", () => {
    const r = validateFrontmatter("# /wait\nno frontmatter\n");
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("missing YAML frontmatter");
  });
  it("rejects frontmatter with a wrong name field", () => {
    const bad = "---\nname: not-volley-wait\ndescription: x\nuser_invocable: true\n---\n";
    expect(validateFrontmatter(bad).errors.join(" ")).toContain('name must be "volley-wait"');
  });
  it("rejects frontmatter with user_invocable: false", () => {
    const bad = "---\nname: volley-wait\ndescription: x\nuser_invocable: false\n---\n";
    expect(validateFrontmatter(bad).errors.join(" ")).toContain("user_invocable must be true");
  });
});

describe("validateDispatch", () => {
  it("flags a body that lacks the required sections", () => {
    const body = `${GOOD_FRONTMATTER}\n# /wait\n\nNo sections here.\n`;
    const r = validateDispatch(body);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("flags a body that never mentions the volley CLI commands it backgrounds", () => {
    const body = `${GOOD_FRONTMATTER}\n# /wait\n\n## Usage\n\n## Flags\n\n## Prerequisites\n\n## What You Must Do When Invoked\n\n## Exit conditions\n\nNo CLI commands named here.\n`;
    const r = validateDispatch(body);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/volley wait|volley sub/);
  });
});

describe("validateSkill (end-to-end)", () => {
  it("returns ok:true for the real SKILL.md shipped in this package", () => {
    const source = readFileSync(SKILL_MD_PATH, "utf8");
    const r = validateSkill(source);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });
});
