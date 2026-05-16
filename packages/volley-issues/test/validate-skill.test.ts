import { describe, expect, it } from "vitest";
import {
  REQUIRED_SECTIONS,
  parseSimpleYaml,
  splitFrontmatter,
  validateFrontmatter,
  validateSections,
  validateSkill,
} from "../scripts/validate-skill";

const GOOD_FRONTMATTER = `---
name: volley-issues
description: Dispatch GitHub issues to autonomous Claude agents coordinated via Volley
user_invocable: true
---
`;

const ALL_SECTIONS = REQUIRED_SECTIONS.map((h) => `${h}\n\nbody\n`).join("\n");
const FULL_OK = `${GOOD_FRONTMATTER}\n# /volley-issues\n\n${ALL_SECTIONS}`;

describe("splitFrontmatter", () => {
  it("returns the frontmatter and body when both present", () => {
    const r = splitFrontmatter(`${GOOD_FRONTMATTER}body\n`);
    expect(r.frontmatter).toContain("name: volley-issues");
    expect(r.body.trim()).toBe("body");
  });
  it("returns frontmatter:null when missing leading ---", () => {
    expect(splitFrontmatter("# hi\n").frontmatter).toBeNull();
  });
});

describe("parseSimpleYaml", () => {
  it("parses strings and booleans, ignores blanks + comments", () => {
    expect(parseSimpleYaml("# comment\nname: volley-issues\nuser_invocable: true\n\n")).toEqual({
      name: "volley-issues",
      user_invocable: true,
    });
  });
  it("throws on unparseable lines", () => {
    expect(() => parseSimpleYaml("not a kv line\n")).toThrow(/unparseable/);
  });
});

describe("validateFrontmatter", () => {
  it("accepts a valid frontmatter", () => {
    expect(validateFrontmatter(GOOD_FRONTMATTER).ok).toBe(true);
  });
  it("rejects wrong name", () => {
    const bad = "---\nname: not-volley-issues\ndescription: x\nuser_invocable: true\n---\n";
    expect(validateFrontmatter(bad).errors.join(" ")).toContain('name must be "volley-issues"');
  });
  it("rejects user_invocable: false", () => {
    const bad = "---\nname: volley-issues\ndescription: x\nuser_invocable: false\n---\n";
    expect(validateFrontmatter(bad).errors.join(" ")).toContain("user_invocable must be true");
  });
  it("rejects empty description", () => {
    const bad = "---\nname: volley-issues\ndescription: \nuser_invocable: true\n---\n";
    expect(validateFrontmatter(bad).errors.join(" ")).toContain("description must be a non-empty");
  });
});

describe("validateSections", () => {
  it("accepts a body with all required sections", () => {
    expect(validateSections(FULL_OK).ok).toBe(true);
  });
  it("flags a missing section", () => {
    const without = ALL_SECTIONS.replace("## Coordinator loop\n\nbody\n", "");
    expect(validateSections(`${GOOD_FRONTMATTER}\n${without}`).errors.join(" ")).toContain(
      "## Coordinator loop",
    );
  });
});

describe("validateSkill (end-to-end)", () => {
  it("returns ok:true on a fully valid SKILL.md", () => {
    expect(validateSkill(FULL_OK).ok).toBe(true);
  });
});
