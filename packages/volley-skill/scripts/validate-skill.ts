import { readFileSync } from "node:fs";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** The five subcommands the /volley skill must document. */
export type Subcommand = "list" | "watch" | "msg" | "inspect" | "tap";

/** Required subcommand → MCP tool names that must appear in its section. */
export const REQUIRED_SUBCOMMANDS: Record<Subcommand, readonly string[]> = {
  list: ["vol_list_agents"],
  watch: ["vol_subscribe"],
  msg: ["vol_send_mailbox"],
  inspect: ["vol_query"],
  tap: ["vol_tap"],
};

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
  if (parsed.name !== "volley") {
    errors.push(`frontmatter.name must be "volley", got ${JSON.stringify(parsed.name)}`);
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
  for (const [sub, tools] of Object.entries(REQUIRED_SUBCOMMANDS)) {
    const headingRe = new RegExp(`^### \`${sub}\`.*$`, "m");
    if (!headingRe.test(body)) {
      errors.push(`missing section: ### \`${sub}\` ... in SKILL.md body`);
      continue;
    }
    const sectionStart = body.search(headingRe);
    const nextSection = body.slice(sectionStart + 1).search(/^### /m);
    const section =
      nextSection === -1
        ? body.slice(sectionStart)
        : body.slice(sectionStart, sectionStart + 1 + nextSection);
    for (const tool of tools) {
      if (!section.includes(tool)) {
        errors.push(`section \`${sub}\` does not mention required MCP tool \`${tool}\``);
      }
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
