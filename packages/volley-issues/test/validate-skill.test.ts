import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_SECTIONS,
  REQUIRED_VOLLEYD_PATH,
  parseSimpleYaml,
  splitFrontmatter,
  validateFrontmatter,
  validateSections,
  validateSkill,
  validateVolleydPath,
  volleydPathSection,
} from "../scripts/validate-skill";

const GOOD_FRONTMATTER = `---
name: volley-issues
description: Dispatch GitHub issues to autonomous Claude agents coordinated via Volley
user_invocable: true
---
`;

const VOLLEYD_NEEDLES = REQUIRED_VOLLEYD_PATH.map((needle) => `- ${needle}\n`).join("");
const ALL_SECTIONS = REQUIRED_SECTIONS.map((h) =>
  h === "## Volleyd path" ? `${h}\n\n${VOLLEYD_NEEDLES}` : `${h}\n\nbody\n`,
).join("\n");
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

const SHIPPED = readFileSync(new URL("../SKILL.md", import.meta.url), "utf8");

describe("validateVolleydPath", () => {
  it("accepts a body that names every command inside the volleyd path", () => {
    expect(validateVolleydPath(FULL_OK).ok).toBe(true);
  });
  it("flags a missing command", () => {
    const without = FULL_OK.replace("- volleyd resolve\n", "");
    expect(validateVolleydPath(without).errors.join(" ")).toContain("volleyd resolve");
  });
  it("does not count a command that only appears outside the volleyd path", () => {
    const moved = `${FULL_OK.replace("- volleyd resolve\n", "")}\n- volleyd resolve\n`;
    expect(validateVolleydPath(moved).errors.join(" ")).toContain("volleyd resolve");
  });
  it("flags a missing volleyd path section", () => {
    const r = validateVolleydPath(FULL_OK.replace("## Volleyd path", "## Something else"));
    expect(r.errors).toEqual(["missing the ## Volleyd path section"]);
  });
  it("slices the shipped SKILL.md between the volleyd and legacy headings", () => {
    const section = volleydPathSection(splitFrontmatter(SHIPPED).body) ?? "";
    expect(section.startsWith("## Volleyd path")).toBe(true);
    expect(section).not.toContain("## Legacy path");
    expect(section).not.toContain("## Batch setup");
  });
  it.each([...REQUIRED_VOLLEYD_PATH])(
    "rejects the shipped SKILL.md when its volleyd path loses %s",
    (needle) => {
      const body = splitFrontmatter(SHIPPED).body;
      const section = volleydPathSection(body) ?? "";
      const stripped = SHIPPED.replace(section, section.split(needle).join(""));
      expect(validateVolleydPath(stripped).errors).toContain(
        `volleyd path must mention: ${needle}`,
      );
    },
  );
});

describe("validateSkill (end-to-end)", () => {
  it("returns ok:true on a fully valid SKILL.md", () => {
    expect(validateSkill(FULL_OK).ok).toBe(true);
  });
  it("fails when the volleyd path loses a command", () => {
    const r = validateSkill(FULL_OK.replace("- volleyd cleanup\n", ""));
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("volleyd cleanup");
  });
  it("accepts the shipped SKILL.md", () => {
    expect(validateSkill(SHIPPED).errors).toEqual([]);
  });
});
