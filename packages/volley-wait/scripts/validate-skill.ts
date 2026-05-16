import { readFileSync } from "node:fs";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** Required section headings (case-insensitive) the /wait SKILL.md body must contain. */
export const REQUIRED_SECTIONS: readonly string[] = [
  "Usage",
  "Flags",
  "Prerequisites",
  "What You Must Do When Invoked",
  "Exit conditions",
];

/** CLI commands the /wait skill backgrounds; the body must mention both verbatim. */
export const REQUIRED_CLI_COMMANDS: readonly string[] = ["volley wait", "volley sub"];

/**
 * Split a markdown file into its frontmatter block (between the first two `---` lines)
 * and its body. Returns null for either part that is missing.
 */
export function splitFrontmatter(source: string): { frontmatter: string | null; body: string } {
  if (!source.startsWith("---\n")) {
    return { frontmatter: null, body: source };
  }
  const closeIdx = source.indexOf("\n---\n", 4);
  if (closeIdx === -1) {
    return { frontmatter: null, body: source };
  }
  return {
    frontmatter: source.slice(4, closeIdx),
    body: source.slice(closeIdx + 5),
  };
}

/**
 * Hand-rolled YAML key:value parser. Adequate for our tiny frontmatter (3 fields,
 * no nesting, no lists, no multiline strings). Throws on unparseable lines.
 */
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
    errors.push("missing YAML frontmatter block (expected `---` at top)");
    return { ok: false, errors };
  }
  let parsed: Record<string, string | boolean>;
  try {
    parsed = parseSimpleYaml(frontmatter);
  } catch (e) {
    errors.push(`frontmatter YAML parse error: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, errors };
  }
  if (parsed.name !== "volley-wait") {
    errors.push(`frontmatter.name must be "volley-wait", got ${JSON.stringify(parsed.name)}`);
  }
  if (typeof parsed.description !== "string" || parsed.description.length === 0) {
    errors.push("frontmatter.description must be a non-empty string");
  }
  if (parsed.user_invocable !== true) {
    errors.push("frontmatter.user_invocable must be true");
  }
  return { ok: errors.length === 0, errors };
}

export function validateDispatch(source: string): ValidationResult {
  const errors: string[] = [];
  const { body } = splitFrontmatter(source);
  for (const section of REQUIRED_SECTIONS) {
    // Match a markdown heading whose text contains the section name, case-insensitive.
    // Allows an optional numeric/alpha prefix like "6. " or "4a. " (used in the real
    // SKILL.md) and optional trailing parenthetical content like " (summary)".
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const headingRe = new RegExp(`^#{1,6}\\s+(?:\\d+[a-z]?\\.\\s+)?${escaped}\\b`, "im");
    if (!headingRe.test(body)) {
      errors.push(`missing section: a markdown heading "${section}" in SKILL.md body`);
    }
  }
  for (const cmd of REQUIRED_CLI_COMMANDS) {
    if (!body.includes(cmd)) {
      errors.push(`body does not mention required CLI command \`${cmd}\``);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function validateSkill(source: string): ValidationResult {
  const fm = validateFrontmatter(source);
  const dispatch = validateDispatch(source);
  return {
    ok: fm.ok && dispatch.ok,
    errors: [...fm.errors, ...dispatch.errors],
  };
}

// CLI entry — `bun run scripts/validate-skill.ts SKILL.md`
if (import.meta.main) {
  const path = process.argv[2];
  if (typeof path !== "string") {
    process.stderr.write("usage: bun run validate-skill.ts <path-to-SKILL.md>\n");
    process.exit(2);
  }
  const source = readFileSync(path, "utf8");
  const result = validateSkill(source);
  if (result.ok) {
    process.stdout.write(`SKILL.md OK (${path})\n`);
    process.exit(0);
  }
  for (const e of result.errors) process.stderr.write(`  - ${e}\n`);
  process.exit(1);
}
