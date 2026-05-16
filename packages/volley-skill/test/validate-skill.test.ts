import { describe, expect, it } from "vitest";
import {
  REQUIRED_SUBCOMMANDS,
  type Subcommand,
  parseSimpleYaml,
  splitFrontmatter,
  validateDispatch,
  validateFrontmatter,
  validateSkill,
} from "../scripts/validate-skill";

const GOOD_FRONTMATTER = `---
name: volley
description: Inspect and steer Volley agents
user_invocable: true
---
`;

function withSubcommands(subcommands: Subcommand[]): string {
  return `${GOOD_FRONTMATTER}\n# /volley\n\n${subcommands
    .map((s) => {
      const tool = REQUIRED_SUBCOMMANDS[s][0];
      return `### \`${s}\` — does the thing\n\nCall \`${tool}\` and render.\n`;
    })
    .join("\n")}`;
}

describe("splitFrontmatter", () => {
  it("returns the frontmatter block and the body when both exist", () => {
    const r = splitFrontmatter(`${GOOD_FRONTMATTER}body\nmore\n`);
    expect(r.frontmatter).toContain("name: volley");
    expect(r.body.trim()).toBe("body\nmore");
  });
  it("returns frontmatter:null when the file does not start with ---", () => {
    expect(splitFrontmatter("# heading\nbody\n").frontmatter).toBeNull();
  });
  it("returns frontmatter:null when the second --- is missing", () => {
    expect(splitFrontmatter("---\nname: volley\nno-close").frontmatter).toBeNull();
  });
});

describe("parseSimpleYaml", () => {
  it("parses string and boolean values", () => {
    expect(parseSimpleYaml("name: volley\nuser_invocable: true\n")).toEqual({
      name: "volley",
      user_invocable: true,
    });
  });
  it("ignores blank and comment lines", () => {
    expect(parseSimpleYaml("# comment\nname: volley\n\nuser_invocable: false\n")).toEqual({
      name: "volley",
      user_invocable: false,
    });
  });
  it("strips quotes from quoted values", () => {
    expect(parseSimpleYaml('name: "volley"\n')).toEqual({ name: "volley" });
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
    const r = validateFrontmatter("# /volley\nno frontmatter\n");
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("missing YAML frontmatter");
  });
  it("rejects frontmatter with a wrong name field", () => {
    const bad = "---\nname: not-volley\ndescription: x\nuser_invocable: true\n---\n";
    expect(validateFrontmatter(bad).errors.join(" ")).toContain('name must be "volley"');
  });
  it("rejects frontmatter with user_invocable: false", () => {
    const bad = "---\nname: volley\ndescription: x\nuser_invocable: false\n---\n";
    expect(validateFrontmatter(bad).errors.join(" ")).toContain("user_invocable must be true");
  });
});

describe("validateDispatch", () => {
  it("accepts a body that lists all five subcommands with their required MCP tools", () => {
    const r = validateDispatch(withSubcommands(["list", "watch", "msg", "inspect", "tap"]));
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });
  it("flags a missing subcommand section", () => {
    const r = validateDispatch(withSubcommands(["list", "watch", "msg", "inspect"])); // no tap
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("`tap`");
  });
  it("flags a subcommand section that fails to mention its MCP tool", () => {
    const body = `${GOOD_FRONTMATTER}\n### \`list\` — does the thing\n\nCall the wrong tool.\n### \`watch\` — x\n\nCall vol_subscribe.\n### \`msg\` — x\n\nCall vol_send_mailbox.\n### \`inspect\` — x\n\nCall vol_query.\n### \`tap\` — x\n\nCall vol_tap.\n`;
    const r = validateDispatch(body);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("vol_list_agents");
  });
});

describe("validateSkill (end-to-end)", () => {
  it("returns ok:true on a fully valid SKILL.md text", () => {
    const r = validateSkill(withSubcommands(["list", "watch", "msg", "inspect", "tap"]));
    expect(r.ok).toBe(true);
  });
});
