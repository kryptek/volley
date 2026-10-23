import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BRIEF_TITLE_RULES,
  ISSUE_PLAN_TEMPLATE,
  PLANNING_HEADING,
  PLANNING_REFERENCE,
  REQUIRED_PLANNING,
  REQUIRED_RELEASE_MERGE,
  REQUIRED_SECTIONS,
  REQUIRED_TEMPLATE,
  REQUIRED_TEMPLATE_HEADINGS,
  REQUIRED_VOLLEYD_PATH,
  SKILL_VERSION,
  parseSimpleYaml,
  planningSection,
  releaseMergeSection,
  splitFrontmatter,
  validateBriefTitle,
  validateFrontmatter,
  validateIssuePlanTemplate,
  validatePlanning,
  validateReleaseMerge,
  validateSections,
  validateSkill,
  validateVolleydPath,
  volleydPathSection,
} from "../scripts/validate-skill";
import { tempDir } from "./helpers/tmp";

const GOOD_FRONTMATTER = `---
name: volley-issues
description: Dispatch GitHub issues to autonomous Claude agents coordinated via Volley
user_invocable: true
version: ${SKILL_VERSION}
---
`;

const PLANNING_NEEDLES = REQUIRED_PLANNING.map((needle) => `- ${needle}\n`).join("");
const VOLLEYD_NEEDLES = `${REQUIRED_VOLLEYD_PATH.map((needle) => `- ${needle}\n`).join("")}
### Step 2: derive dependencies

body

${PLANNING_HEADING}

${PLANNING_NEEDLES}
### Step 3: write the wave file

See ${PLANNING_REFERENCE}.

### Step 4: validate and submit

See ${PLANNING_REFERENCE}.

### Step 5: submit and leave
`;
const RELEASE_NEEDLES = REQUIRED_RELEASE_MERGE.map((needle) => `- ${needle}\n`).join("");
const ALL_SECTIONS = REQUIRED_SECTIONS.map((h) =>
  h === "## Volleyd path"
    ? `${h}\n\n${VOLLEYD_NEEDLES}`
    : h === "## Release branch merge"
      ? `${h}\n\n${RELEASE_NEEDLES}`
      : `${h}\n\nbody\n`,
).join("\n");
const BRIEF_TITLE_NEEDLES = BRIEF_TITLE_RULES.map((needle) => `- ${needle}\n`).join("");
const FULL_OK = `${GOOD_FRONTMATTER}\n# /volley-issues\n\n${ALL_SECTIONS}\n${BRIEF_TITLE_NEEDLES}`;

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
    const bad = `---\nname: not-volley-issues\ndescription: x\nuser_invocable: true\nversion: ${SKILL_VERSION}\n---\n`;
    expect(validateFrontmatter(bad).errors.join(" ")).toContain('name must be "volley-issues"');
  });
  it("rejects user_invocable: false", () => {
    const bad = "---\nname: volley-issues\ndescription: x\nuser_invocable: false\n---\n";
    expect(validateFrontmatter(bad).errors.join(" ")).toContain("user_invocable must be true");
  });
  it("rejects a missing or different version", () => {
    const missing = GOOD_FRONTMATTER.replace(`version: ${SKILL_VERSION}\n`, "");
    expect(validateFrontmatter(missing).errors.join(" ")).toContain(
      `version must be "${SKILL_VERSION}"`,
    );
    const old = GOOD_FRONTMATTER.replace(`version: ${SKILL_VERSION}`, "version: 0.1");
    expect(validateFrontmatter(old).errors.join(" ")).toContain("version must be");
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

describe("validateReleaseMerge (#313: release PRs pass the changelog guards)", () => {
  it("accepts a body that names every release command inside the release section", () => {
    expect(validateReleaseMerge(FULL_OK).errors).toEqual([]);
  });
  it.each([...REQUIRED_RELEASE_MERGE])("flags a release section that loses %s", (needle) => {
    expect(validateReleaseMerge(FULL_OK.replace(`- ${needle}\n`, "")).errors).toContain(
      `release branch merge must mention: ${needle}`,
    );
  });
  it("flags a bare gh pr merge, which resolves to the checked-out branch's PR", () => {
    const bare = FULL_OK.replace(
      "- --label no-changelog\n",
      '- --label no-changelog\n   gh pr merge --squash --subject "release: x"\n',
    );
    expect(validateReleaseMerge(bare).errors.join(" ")).toContain("gh pr merge must name its PR");
  });
  it("names the PR on every merge in the shipped SKILL.md (the coordinator sits on release-prep/<v>)", () => {
    const section = releaseMergeSection(splitFrontmatter(SHIPPED).body) ?? "";
    expect(section).toContain("gh pr merge release-prep/<v> --squash");
    expect(section).toContain("gh pr merge release/<date>-<theme> --squash");
    expect(section).not.toMatch(/gh pr merge --/);
  });
  it("guards the shipped SKILL.md's release section", () => {
    const section = releaseMergeSection(splitFrontmatter(SHIPPED).body) ?? "";
    expect(section.startsWith("## Release branch merge")).toBe(true);
    expect(validateReleaseMerge(SHIPPED).errors).toEqual([]);
    // The capital-R title the changelog guard once rejected is gone.
    expect(section).not.toContain('--title "Release:');
  });
});

describe("validateBriefTitle (P2-2 regression guard)", () => {
  it("accepts a body that pipes the issue title through the helper", () => {
    expect(validateBriefTitle(FULL_OK).errors).toEqual([]);
  });
  it.each([...BRIEF_TITLE_RULES])("flags a body that loses %s", (needle) => {
    expect(validateBriefTitle(FULL_OK.replace(`- ${needle}\n`, "")).errors).toContain(
      `brief title must use the helper: ${needle}`,
    );
  });
  it.each(["<short-title>", "<short title>", "<title>"])(
    "flags a raw issue title (%s) placed in the cmux line",
    (raw) => {
      const bad = `${FULL_OK}\n   --name "Issue-<N>: ${raw}" \\\n`;
      expect(validateBriefTitle(bad).errors.join(" ")).toContain("raw issue title");
    },
  );
  it("guards the shipped SKILL.md", () => {
    expect(validateBriefTitle(SHIPPED).errors).toEqual([]);
    const raw = SHIPPED.replace('--name "<brief-title>"', '--name "Issue-<N>: <short-title>"');
    expect(validateBriefTitle(raw).ok).toBe(false);
  });
});

describe("validatePlanning (#390: footprints, bundling and the planner)", () => {
  it("accepts a body whose planning section sits between Step 2 and Step 3", () => {
    expect(validatePlanning(FULL_OK).errors).toEqual([]);
  });
  it.each([...REQUIRED_PLANNING])("flags a planning section that loses %s", (needle) => {
    expect(validatePlanning(FULL_OK.replace(`- ${needle}\n`, "")).errors).toContain(
      `planning section must mention: ${needle}`,
    );
  });
  it("flags a missing planning section", () => {
    const r = validatePlanning(FULL_OK.replace(PLANNING_HEADING, "### Something else"));
    expect(r.errors).toEqual([`missing the ${PLANNING_HEADING} section`]);
  });
  it("flags a planning section that is not between Step 2 and Step 3", () => {
    const section = planningSection(splitFrontmatter(FULL_OK).body) ?? "";
    const moved = `${FULL_OK.replace(section, "")}\n${section}`;
    expect(validatePlanning(moved).errors).toContain(
      `${PLANNING_HEADING} must sit between Step 2 and Step 3 of the volleyd path`,
    );
  });
  it.each(["### Step 3", "### Step 4"])("flags a %s that does not reference it", (step) => {
    const body = splitFrontmatter(FULL_OK).body;
    const at = body.indexOf(step);
    const stepText = body.slice(at, body.indexOf("### Step", at + 1));
    const without = FULL_OK.replace(stepText, stepText.replace(PLANNING_REFERENCE, "it"));
    expect(validatePlanning(without).errors).toContain(
      `${step} must reference ${PLANNING_REFERENCE}`,
    );
  });
  it("guards the shipped SKILL.md", () => {
    expect(validatePlanning(SHIPPED).errors).toEqual([]);
    const section = planningSection(splitFrontmatter(SHIPPED).body) ?? "";
    expect(section.startsWith(PLANNING_HEADING)).toBe(true);
    expect(section).not.toContain("### Step 3");
  });
});

const TEMPLATE_PATH = fileURLToPath(new URL(`../${ISSUE_PLAN_TEMPLATE}`, import.meta.url));

describe("validateIssuePlanTemplate (#390: the issue-planning brief)", () => {
  const ok = `# Planning a batch\n\n${REQUIRED_TEMPLATE_HEADINGS.map((h) => `${h}\n\nbody\n`).join("\n")}\n${REQUIRED_TEMPLATE.map((n) => `- ${n}\n`).join("")}`;
  it("accepts a template with every heading and rule", () => {
    expect(validateIssuePlanTemplate(ok).errors).toEqual([]);
  });
  it("flags a missing template", () => {
    expect(validateIssuePlanTemplate(null).errors).toEqual([
      `missing the issue-plan template: ${ISSUE_PLAN_TEMPLATE}`,
    ]);
  });
  it.each([...REQUIRED_TEMPLATE_HEADINGS])("flags a template without %s", (heading) => {
    expect(validateIssuePlanTemplate(ok.replace(`${heading}\n`, "")).errors).toContain(
      `issue-plan template must show the plan heading: ${heading}`,
    );
  });
  it.each([...REQUIRED_TEMPLATE])("flags a template that loses %s", (needle) => {
    expect(validateIssuePlanTemplate(ok.replace(`- ${needle}\n`, "")).errors).toContain(
      `issue-plan template must mention: ${needle}`,
    );
  });
  it("guards the shipped template", () => {
    expect(existsSync(TEMPLATE_PATH)).toBe(true);
    expect(validateIssuePlanTemplate(readFileSync(TEMPLATE_PATH, "utf8")).errors).toEqual([]);
  });
  it("the CLI fails a SKILL.md whose directory has no template, and passes the shipped one", () => {
    const script = fileURLToPath(new URL("../scripts/validate-skill.ts", import.meta.url));
    const dir = tempDir("volley-issues-skill-");
    writeFileSync(join(dir, "SKILL.md"), SHIPPED);
    const bare = spawnSync("bun", ["run", script, join(dir, "SKILL.md")], { encoding: "utf-8" });
    expect(bare.status).toBe(1);
    expect(bare.stderr).toContain(`missing the issue-plan template: ${ISSUE_PLAN_TEMPLATE}`);
    const shipped = fileURLToPath(new URL("../SKILL.md", import.meta.url));
    expect(spawnSync("bun", ["run", script, shipped], { encoding: "utf-8" }).status).toBe(0);
  });
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

describe("skill version", () => {
  it("the shipped SKILL.md declares the package's major.minor version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(`${SKILL_VERSION}.`).toBe(pkg.version.replace(/\d+$/, ""));
    const { frontmatter } = splitFrontmatter(SHIPPED);
    expect(parseSimpleYaml(frontmatter ?? "").version).toBe(SKILL_VERSION);
  });
  it("the Prerequisites prose names the same version as the frontmatter", () => {
    const declared = [...SHIPPED.matchAll(/declares `version: ([\d.]+)`/g)].map((m) => m[1]);
    expect(declared).toEqual([SKILL_VERSION]);
  });
});

describe("install.sh --check", () => {
  const INSTALL = fileURLToPath(new URL("../scripts/install.sh", import.meta.url));
  const SKILL_DIR = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

  /** A throwaway $HOME, optionally with an installed copy of the skill at the given version. */
  function home(installed?: string | "symlink"): string {
    const h = tempDir("volley-issues-home-");
    const skills = join(h, ".claude", "skills");
    mkdirSync(skills, { recursive: true });
    if (installed === "symlink") symlinkSync(SKILL_DIR, join(skills, "volley-issues"));
    else if (installed !== undefined) {
      const dir = join(skills, "volley-issues");
      mkdirSync(dir);
      const fm = installed === "" ? "" : `version: ${installed}\n`;
      writeFileSync(join(dir, "SKILL.md"), `---\nname: volley-issues\n${fm}---\n# old\n`);
    }
    return h;
  }
  const check = (h: string) =>
    spawnSync("bash", [INSTALL, "--check"], {
      encoding: "utf-8",
      env: { ...process.env, HOME: h },
    });

  it("exits 1 against an installed copy declaring version: 0.1, printing both versions", () => {
    const r = check(home("0.1"));
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain("installed 0.1");
    expect(r.stdout + r.stderr).toContain(`repo ${SKILL_VERSION}`);
  });

  it("exits 1 against a v0.1 copy with no version field, and when nothing is installed", () => {
    expect(check(home("")).status).toBe(1);
    expect(check(home()).status).toBe(1);
  });

  it("exits 0 when the installed copy is this repo's skill, and never changes anything", () => {
    const h = home("symlink");
    const r = check(h);
    expect(r.stdout + r.stderr).toContain(`installed ${SKILL_VERSION}`);
    expect(r.status).toBe(0);
    const old = home("0.1");
    check(old);
    const kept = readFileSync(join(old, ".claude/skills/volley-issues/SKILL.md"), "utf8");
    expect(kept).toContain("version: 0.1");
  });

  it("prints the installed and repo versions on a plain install", () => {
    const h = home("0.1");
    const r = spawnSync("bash", [INSTALL], {
      encoding: "utf-8",
      env: { ...process.env, HOME: h },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("installed 0.1");
    expect(r.stdout).toContain(`repo ${SKILL_VERSION}`);
    expect(check(h).status).toBe(0);
  });
});

describe("the coordinator's go/no-go convention", () => {
  it("SKILL.md asks go/no-go through AskUserQuestion with go, hold, cancel", () => {
    const skill = readFileSync(fileURLToPath(new URL("../SKILL.md", import.meta.url)), "utf-8");
    const section = volleydPathSection(splitFrontmatter(skill).body) ?? "";
    expect(section).toMatch(/go\/no-go through `AskUserQuestion`/);
    expect(section).toContain("options `go`, `hold`, `cancel`");
  });

  it("a volleyd path without it is refused", () => {
    const without = FULL_OK.replace("- AskUserQuestion\n", "");
    expect(validateVolleydPath(without).errors).toEqual([
      "volleyd path must mention: AskUserQuestion",
    ]);
  });
});
