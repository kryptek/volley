import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * The skill's frontmatter `version:`: the `major.minor` of this package's version, so a release
 * bump of `package.json` is what moves it (SKILL.md's field must follow). `scripts/install.sh
 * --check` compares an installed copy's version with this repo's.
 */
export const SKILL_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version
  .split(".")
  .slice(0, 2)
  .join(".");

/** Major section headings that must be present in the SKILL.md body. */
export const REQUIRED_SECTIONS = [
  "## Prerequisites",
  "## Usage",
  // The volleyd path is the default dispatch path; the hand-launched flow stays, labelled legacy.
  "## Choosing a dispatch path",
  "## Volleyd path",
  "## Legacy path",
  "## Batch setup",
  "## Workflow per issue",
  "## Coordinator loop",
  "## Release branch merge",
  "## Cleanup",
  // Conformance is the audit-trail anchor mapping SPEC §11 clauses to spawn-brief
  // behaviors. Required so a future editor can't accidentally drop the "yes, we
  // ship a conforming Volley agent" claim without the validator catching it.
  "## Conformance with Volley v0.1",
] as const;

/**
 * Strings `## Choosing a dispatch path` must name (#571): an unreachable supervisor (`volleyd`
 * exits 69 `SUPERVISOR_UNREACHABLE`) is relayed to the owner and asked about, never answered by
 * switching brokers or modes, and never by the legacy path.
 */
export const REQUIRED_DISPATCH_PATH = [
  "exit 69",
  "SUPERVISOR_UNREACHABLE",
  "volleyd status --json",
  "verbatim",
  "never switch",
  "do not fall back to the legacy path",
] as const;

/**
 * Strings the volleyd path (the text from `## Volleyd path` to `## Legacy path`) must name
 * verbatim: the helper, where the wave file goes, and the exact commands of each step, so an
 * edit can't silently drop one.
 */
export const REQUIRED_VOLLEYD_PATH = [
  "scripts/wave-from-issues.ts",
  ".volley/waves/",
  "volleyd status",
  "volleyd validate",
  "volleyd run",
  "--owner",
  "volley sub --pattern",
  "volley/_waves/",
  "volleyd decisions",
  "volleyd resolve",
  "volleyd cleanup",
  "--yes",
  // A go/no-go is asked as a picker (the needs-you inbox answers it from any device), not prose.
  "AskUserQuestion",
  "`go`, `hold`, `cancel`",
] as const;

/**
 * The planning section (#390): between Step 2 and Step 3 of the volleyd path, it tells the planner
 * that a task's Files list is the footprint the overlap planner relies on and how to write one,
 * when to bundle at filing time, and how to override the plan. Steps 3 and 4 point at it.
 */
export const PLANNING_HEADING = "### Planning a batch: footprints and overlap";

/** How Steps 3 and 4 name the planning section. */
export const PLANNING_REFERENCE = "**Planning a batch**";

/** Strings the planning section must name verbatim: its five rules and `--plan-only`. */
export const REQUIRED_PLANNING = [
  // (1) the Files list is the footprint, and how to write it
  "is the task's footprint",
  "one per bullet",
  "`(new)`",
  "globs",
  "in parentheses after the path",
  "`changes/<issue>.<type>.md` last",
  // (2) look before filing or submitting
  "--plan-only",
  // (3) bundle at filing time
  "When to bundle at filing time",
  "`T0a`, `T0b`",
  // (4) what the plan lines mean, and the overrides
  "`after:`",
  "`issues:`",
  "--no-plan",
  // (5) a strong pair the planner would chain
  "`Depends on:`",
  "the chain is yours, not the planner's",
] as const;

/** The issue-planning brief, relative to the skill's directory. */
export const ISSUE_PLAN_TEMPLATE = "templates/issue-plan.md";

/** The plan format's headings, as the template shows them. */
export const REQUIRED_TEMPLATE_HEADINGS = [
  "## Problem",
  "## Done when",
  "## Design facts",
  "## Files",
  "## Steps",
  "## Out of scope",
  "## Gates",
] as const;

/** Strings the template must name verbatim: the header line and the rules it carries. */
export const REQUIRED_TEMPLATE = [
  "REQUIRED SUB-SKILL",
  "`(new)`",
  "in parentheses after the path",
  "`changes/<issue>.<type>.md` last",
  "--plan-only",
  "`T0a`, `T0b`",
  "`Depends on:`",
  "Public-repo hygiene",
] as const;

/** The body text from the planning heading up to the next `### ` or `## ` heading, or null. */
export function planningSection(body: string): string | null {
  const at = body.indexOf(`${PLANNING_HEADING}\n`);
  if (at === -1) return null;
  const rest = body.slice(at + PLANNING_HEADING.length);
  const end = /^#{2,3} /m.exec(rest);
  return body.slice(at, at + PLANNING_HEADING.length + (end?.index ?? rest.length));
}

export function validatePlanning(source: string): ValidationResult {
  const body = splitFrontmatter(source).body;
  const section = planningSection(body);
  if (section === null) return { ok: false, errors: [`missing the ${PLANNING_HEADING} section`] };
  const errors: string[] = REQUIRED_PLANNING.filter((needle) => !section.includes(needle)).map(
    (needle) => `planning section must mention: ${needle}`,
  );
  const path = volleydPathSection(body) ?? "";
  const at = path.indexOf(section);
  const step2 = path.indexOf("### Step 2");
  const step3 = path.indexOf("### Step 3");
  if (at === -1 || step2 === -1 || step3 === -1 || !(step2 < at && at < step3)) {
    errors.push(`${PLANNING_HEADING} must sit between Step 2 and Step 3 of the volleyd path`);
  }
  for (const step of ["### Step 3", "### Step 4"]) {
    const from = path.indexOf(step);
    const next = path.indexOf("### ", from + step.length);
    const text = from === -1 ? "" : path.slice(from, next === -1 ? undefined : next);
    if (!text.includes(PLANNING_REFERENCE)) {
      errors.push(`${step} must reference ${PLANNING_REFERENCE}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** The template's text, or null when it does not exist. */
export function validateIssuePlanTemplate(source: string | null): ValidationResult {
  if (source === null) {
    return { ok: false, errors: [`missing the issue-plan template: ${ISSUE_PLAN_TEMPLATE}`] };
  }
  const errors = [
    ...REQUIRED_TEMPLATE_HEADINGS.filter((h) => !new RegExp(`^${h}\\b`, "m").test(source)).map(
      (h) => `issue-plan template must show the plan heading: ${h}`,
    ),
    ...REQUIRED_TEMPLATE.filter((needle) => !source.includes(needle)).map(
      (needle) => `issue-plan template must mention: ${needle}`,
    ),
  ];
  return { ok: errors.length === 0, errors };
}

/**
 * Strings the `## Release branch merge` section must name verbatim (#313): CI's changelog guards
 * pass a release PR only when its squash subject starts with `release:` and, when it touches
 * packages/ without a fragment, it carries the `no-changelog` label, which the first command
 * creates in a repository that lacks it.
 */
export const REQUIRED_RELEASE_MERGE = [
  "bun scripts/changelog-ci.ts labels --ensure",
  '--title "release:',
  "--label no-changelog",
  '--subject "release:',
] as const;

/**
 * The brief title (P2-2): an issue title is attacker-controlled text, and the cmux line nests it
 * in a single-quoted prompt inside a double-quoted `--command`, so a quote ends the prompt early
 * and a backtick or `$(…)` runs in the coordinator's shell. SKILL.md must route the title through
 * `scripts/brief-title.ts` (stdin in, shell-safe line out) and use only that output on the line.
 */
export const BRIEF_TITLE_RULES = [
  "gh issue view <N> --json title -q .title | bun <skill-dir>/scripts/brief-title.ts <N> implementer",
  '--name "<brief-title>"',
  'title=\\"<brief-title>\\"',
] as const;

/** A raw issue-title placeholder on a shell line: the cmux name/command, a commit or PR title. */
const RAW_TITLE_ON_SHELL_LINE =
  /(--name|--title|rename-workspace|title=|-m )[^\n]*<(short[- ])?title>/;

export function validateBriefTitle(source: string): ValidationResult {
  const { body } = splitFrontmatter(source);
  const errors: string[] = BRIEF_TITLE_RULES.filter((needle) => !body.includes(needle)).map(
    (needle) => `brief title must use the helper: ${needle}`,
  );
  const raw = RAW_TITLE_ON_SHELL_LINE.exec(body);
  if (raw !== null) {
    errors.push(`raw issue title on a shell line (use the brief-title.ts output): ${raw[0]}`);
  }
  return { ok: errors.length === 0, errors };
}

/** Split a markdown file into its frontmatter block and body. */
export function splitFrontmatter(source: string): { frontmatter: string | null; body: string } {
  if (!source.startsWith("---\n")) return { frontmatter: null, body: source };
  const closeIdx = source.indexOf("\n---\n", 4);
  if (closeIdx === -1) return { frontmatter: null, body: source };
  return { frontmatter: source.slice(4, closeIdx), body: source.slice(closeIdx + 5) };
}

/** Tiny YAML parser — same scope as volley-skill's: flat scalar fields, no nesting. */
export function parseSimpleYaml(yaml: string): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const rawLine of yaml.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) throw new Error(`unparseable YAML line: ${rawLine}`);
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (value === "true") out[key] = true;
    else if (value === "false") out[key] = false;
    else out[key] = value.replace(/^["']|["']$/g, "");
  }
  return out;
}

export function validateFrontmatter(source: string): ValidationResult {
  const errors: string[] = [];
  const { frontmatter } = splitFrontmatter(source);
  if (frontmatter === null) {
    errors.push("missing YAML frontmatter block");
    return { ok: false, errors };
  }
  let parsed: Record<string, string | boolean>;
  try {
    parsed = parseSimpleYaml(frontmatter);
  } catch (e) {
    errors.push(`frontmatter parse error: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, errors };
  }
  if (parsed.name !== "volley-issues") {
    errors.push(`frontmatter.name must be "volley-issues", got ${JSON.stringify(parsed.name)}`);
  }
  if (typeof parsed.description !== "string" || parsed.description.length === 0) {
    errors.push("frontmatter.description must be a non-empty string");
  }
  if (parsed.user_invocable !== true) {
    errors.push("frontmatter.user_invocable must be true");
  }
  if (parsed.version !== SKILL_VERSION) {
    errors.push(
      `frontmatter.version must be "${SKILL_VERSION}", got ${JSON.stringify(parsed.version)}`,
    );
  }
  return { ok: errors.length === 0, errors };
}

export function validateSections(source: string): ValidationResult {
  const errors: string[] = [];
  const { body } = splitFrontmatter(source);
  for (const heading of REQUIRED_SECTIONS) {
    // Case-sensitive (markdown headings should match exactly), allow extra trailing
    // content on the heading line (e.g. `## Cleanup — additional notes`).
    const re = new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b.*$`, "m");
    if (!re.test(body)) {
      errors.push(`missing required section: ${heading}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** The body text from the `## Volleyd path` heading up to `## Legacy path`, or null. */
export function volleydPathSection(body: string): string | null {
  const start = /^## Volleyd path\b.*$/m.exec(body);
  if (start === null) return null;
  const rest = body.slice(start.index);
  const end = /^## Legacy path\b/m.exec(rest);
  return end === null ? rest : rest.slice(0, end.index);
}

export function validateVolleydPath(source: string): ValidationResult {
  const section = volleydPathSection(splitFrontmatter(source).body);
  if (section === null) return { ok: false, errors: ["missing the ## Volleyd path section"] };
  const errors = REQUIRED_VOLLEYD_PATH.filter((needle) => !section.includes(needle)).map(
    (needle) => `volleyd path must mention: ${needle}`,
  );
  return { ok: errors.length === 0, errors };
}

/** The body text from the `## Choosing a dispatch path` heading up to the next `## `, or null. */
export function dispatchPathSection(body: string): string | null {
  const start = /^## Choosing a dispatch path\b.*$/m.exec(body);
  if (start === null) return null;
  const rest = body.slice(start.index + start[0].length);
  const end = /^## /m.exec(rest);
  return body.slice(start.index, start.index + start[0].length + (end?.index ?? rest.length));
}

export function validateDispatchPath(source: string): ValidationResult {
  const section = dispatchPathSection(splitFrontmatter(source).body);
  if (section === null)
    return { ok: false, errors: ["missing the ## Choosing a dispatch path section"] };
  const errors = REQUIRED_DISPATCH_PATH.filter((needle) => !section.includes(needle)).map(
    (needle) => `dispatch path must mention: ${needle}`,
  );
  return { ok: errors.length === 0, errors };
}

/** The body text from the `## Release branch merge` heading up to the next `## ` heading, or null. */
export function releaseMergeSection(body: string): string | null {
  const start = /^## Release branch merge\b.*$/m.exec(body);
  if (start === null) return null;
  const rest = body.slice(start.index + start[0].length);
  const end = /^## /m.exec(rest);
  return body.slice(start.index, start.index + start[0].length + (end?.index ?? rest.length));
}

/** `gh pr merge` followed directly by a flag, so no PR is named. */
const BARE_PR_MERGE = /gh pr merge --\S*/;

export function validateReleaseMerge(source: string): ValidationResult {
  const section = releaseMergeSection(splitFrontmatter(source).body);
  if (section === null)
    return { ok: false, errors: ["missing the ## Release branch merge section"] };
  const errors = REQUIRED_RELEASE_MERGE.filter((needle) => !section.includes(needle)).map(
    (needle) => `release branch merge must mention: ${needle}`,
  );
  // A bare `gh pr merge` resolves to the checked-out branch's PR; after step 2 that is the
  // release-prep PR, already merged, not the release->main PR.
  const bare = BARE_PR_MERGE.exec(section);
  if (bare !== null) errors.push(`gh pr merge must name its PR: ${bare[0]}`);
  return { ok: errors.length === 0, errors };
}

export function validateSkill(source: string): ValidationResult {
  const results = [
    validateFrontmatter(source),
    validateSections(source),
    validateDispatchPath(source),
    validateVolleydPath(source),
    validateReleaseMerge(source),
    validateBriefTitle(source),
    validatePlanning(source),
  ];
  return { ok: results.every((r) => r.ok), errors: results.flatMap((r) => r.errors) };
}

if (import.meta.main) {
  const path = process.argv[2];
  if (typeof path !== "string") {
    process.stderr.write("usage: bun run validate-skill.ts <path-to-SKILL.md>\n");
    process.exit(2);
  }
  const template = join(dirname(path), ISSUE_PLAN_TEMPLATE);
  const results = [
    validateSkill(readFileSync(path, "utf8")),
    validateIssuePlanTemplate(existsSync(template) ? readFileSync(template, "utf8") : null),
  ];
  const result = { ok: results.every((r) => r.ok), errors: results.flatMap((r) => r.errors) };
  if (result.ok) {
    process.stdout.write(`SKILL.md OK (${path})\n`);
    process.exit(0);
  }
  for (const e of result.errors) process.stderr.write(`  - ${e}\n`);
  process.exit(1);
}
