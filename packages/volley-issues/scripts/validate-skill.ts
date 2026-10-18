import { readFileSync } from "node:fs";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

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
  // Conformance is the audit-trail anchor mapping SPEC §7.5 clauses to spawn-brief
  // behaviors. Required so a future editor can't accidentally drop the "yes, we
  // ship a conforming Volley agent" claim without the validator catching it.
  "## Conformance with Volley v0.1",
] as const;

/**
 * Strings the volleyd path must name verbatim: the helper, where the wave file goes, and the
 * exact commands of each step, so an edit can't silently drop one.
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
] as const;

/** Split a markdown file into its frontmatter block and body. */
export function splitFrontmatter(source: string): { frontmatter: string | null; body: string } {
  if (!source.startsWith("---\n")) return { frontmatter: null, body: source };
  const closeIdx = source.indexOf("\n---\n", 4);
  if (closeIdx === -1) return { frontmatter: null, body: source };
  return { frontmatter: source.slice(4, closeIdx), body: source.slice(closeIdx + 5) };
}

/** Tiny YAML parser — same scope as volley-skill's: 3 fields, no nesting. */
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

export function validateVolleydPath(source: string): ValidationResult {
  const { body } = splitFrontmatter(source);
  const errors = REQUIRED_VOLLEYD_PATH.filter((needle) => !body.includes(needle)).map(
    (needle) => `volleyd path must mention: ${needle}`,
  );
  return { ok: errors.length === 0, errors };
}

export function validateSkill(source: string): ValidationResult {
  const results = [
    validateFrontmatter(source),
    validateSections(source),
    validateVolleydPath(source),
  ];
  return { ok: results.every((r) => r.ok), errors: results.flatMap((r) => r.errors) };
}

if (import.meta.main) {
  const path = process.argv[2];
  if (typeof path !== "string") {
    process.stderr.write("usage: bun run validate-skill.ts <path-to-SKILL.md>\n");
    process.exit(2);
  }
  const result = validateSkill(readFileSync(path, "utf8"));
  if (result.ok) {
    process.stdout.write(`SKILL.md OK (${path})\n`);
    process.exit(0);
  }
  for (const e of result.errors) process.stderr.write(`  - ${e}\n`);
  process.exit(1);
}
