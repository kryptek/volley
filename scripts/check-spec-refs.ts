#!/usr/bin/env bun
/**
 * SPEC numbering + cross-reference check.
 *
 * 1. The numbered headings in `spec/SPEC.md` are contiguous at every level (no §4.4 → §4.6 jump).
 * 2. Every section reference resolves to a heading: `§N.N` inside SPEC.md, and `SPEC §N.N`
 *    (plus any `§` that follows it in a list: `SPEC §3, §4.3`; `§§` too), `SPEC N.N` or
 *    `spec section N.N` in every other tracked file.
 * 3. No tracked file cites the design doc by section: it is local-only (gitignored), so a
 *    reader of the public repo cannot follow the reference.
 * 4. The SPEC's one-item-per-line lists (`<!-- spec-list: <name> -->` … `<!-- /spec-list -->`)
 *    equal what they mirror: the decision kinds `decision.schema.json`'s `kind` enum, the wave
 *    events `wave-event.schema.json`'s `type` enum, the tunables every key of
 *    `config.schema.json#/$defs/tunableProperties` (recursively: `autopilot.*`, `placement.*`).
 * 5. Each `§N.N` row of `spec/RESERVED.md` either names a section not written yet or one whose
 *    heading carries the reserved topic, and no number is reserved twice.
 *
 * Exit code 0 when clean; 1 with one line per problem otherwise.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SPEC = "spec/SPEC.md";
const RESERVED = "spec/RESERVED.md";

/** `## 4. Channels` → "4"; `#### 4.6.1 Wave state` → "4.6.1". */
const HEADING = /^#{2,6}\s+(\d+(?:\.\d+)*)\.?\s/;

export function specSections(spec: string): string[] {
  const out: string[] = [];
  for (const line of spec.split("\n")) {
    const m = HEADING.exec(line);
    if (m?.[1] !== undefined) out.push(m[1]);
  }
  return out;
}

/** Gaps and duplicates in the heading numbering, e.g. "§4.6 follows §4.4". */
export function numberingProblems(sections: string[]): string[] {
  const problems: string[] = [];
  const last = new Map<string, number>();
  for (const s of sections) {
    const parts = s.split(".").map(Number);
    const n = parts.pop() as number;
    const parent = parts.join(".");
    if (parent !== "" && !sections.includes(parent))
      problems.push(`§${s} has no parent §${parent}`);
    const prev = last.get(parent) ?? 0;
    if (n !== prev + 1) {
      problems.push(
        prev === 0
          ? `§${s} is the first under ${parent === "" ? "the top level" : `§${parent}`}`
          : `§${s} follows §${parent === "" ? "" : `${parent}.`}${prev}`,
      );
    }
    last.set(parent, n);
  }
  return problems;
}

/** Section numbers a file cites. Inside SPEC.md every `§`; elsewhere only SPEC references. */
export function citedSections(text: string, isSpec: boolean): { ref: string; line: number }[] {
  const refs: { ref: string; line: number }[] = [];
  text.split("\n").forEach((line, i) => {
    const push = (ref: string) => refs.push({ ref: ref.replace(/\.$/, ""), line: i + 1 });
    if (isSpec) {
      for (const m of line.matchAll(/§\s?(\d+(?:\.\d+)*)/g)) push(m[1] as string);
      return;
    }
    for (const m of line.matchAll(
      /SPEC(?:\.md)?\s+((?:§§?\s?\d+(?:\.\d+)*(?:\s*(?:,|and|\/|&)\s*)?)+)/g,
    )) {
      for (const r of (m[1] as string).matchAll(/§\s?(\d+(?:\.\d+)*)/g)) push(r[1] as string);
    }
    for (const m of line.matchAll(/SPEC(?:\.md)?\s+(\d+\.\d+(?:\.\d+)*)/g)) push(m[1] as string);
    for (const m of line.matchAll(/spec section (\d+(?:\.\d+)*)/gi)) push(m[1] as string);
  });
  return refs;
}

/** A citation of the local-only design doc by section: `design doc §8.5`, `design doc section 8.5`. */
export function citesDesignDoc(line: string): boolean {
  return /design doc(?:'s)? (?:§|section\s+\d)|design §/i.test(line);
}

/** The lines of the named list and whether its `<!-- /spec-list -->` closes it; null when absent. */
function specListBody(spec: string, name: string): { lines: string[]; closed: boolean } | null {
  const lines = spec.split("\n");
  const start = lines.findIndex((l) => l.trim() === `<!-- spec-list: ${name} -->`);
  if (start < 0) return null;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "<!-- /spec-list -->") return { lines: body, closed: true };
    // The next list's opener ends this one unclosed, so its closer is not taken for ours.
    if (line.trim().startsWith("<!-- spec-list: ")) break;
    body.push(line);
  }
  return { lines: body, closed: false };
}

/** The first code span of each top-level `- ` item of the named list; null when it is absent. */
export function specListItems(spec: string, name: string): string[] | null {
  const body = specListBody(spec, name);
  if (body === null) return null;
  return body.lines.flatMap((line) => {
    const m = /^- `([^`]+)`/.exec(line);
    return m?.[1] !== undefined ? [m[1]] : [];
  });
}

/** The top-level `- ` lines of the named list that do not open with a code span, so are not counted. */
function specListMalformed(spec: string, name: string): string[] {
  return (specListBody(spec, name)?.lines ?? []).filter(
    (line) => line.startsWith("- ") && !/^- `[^`]+`/.test(line),
  );
}

/** Whether the named list ends in its own `<!-- /spec-list -->` marker. */
function specListClosed(spec: string, name: string): boolean {
  return specListBody(spec, name)?.closed === true;
}

/** How the SPEC list `name` differs from `expected` (read from `source`), one line per item. */
export function listProblems(
  name: string,
  items: string[],
  expected: readonly string[],
  source: string,
): string[] {
  const problems: string[] = [];
  const have = new Set(items);
  const want = new Set(expected);
  for (const [i, item] of items.entries()) {
    if (items.indexOf(item) !== i) problems.push(`the ${name} list has \`${item}\` twice`);
  }
  for (const item of want) {
    if (!have.has(item)) problems.push(`the ${name} list lacks \`${item}\` (in ${source})`);
  }
  for (const item of have) {
    if (!want.has(item))
      problems.push(`the ${name} list has \`${item}\`, which ${source} does not`);
  }
  return problems;
}

interface SchemaNode {
  properties?: Record<string, SchemaNode>;
  /** Any other JSON Schema keyword (`type`, `default`, `additionalProperties`, …). */
  [keyword: string]: unknown;
}

/** Every tunable key, dotted: objects with fixed `properties` recurse, maps and scalars are keys. */
export function tunableKeys(properties: Record<string, SchemaNode>, prefix = ""): string[] {
  return Object.entries(properties).flatMap(([k, v]) =>
    v.properties === undefined ? [`${prefix}${k}`] : tunableKeys(v.properties, `${prefix}${k}.`),
  );
}

export interface ListSources {
  decisionKinds: readonly string[];
  events: readonly string[];
  tunables: readonly string[];
}

/** What each list mirrors, read from the schemas. */
export function listSources(): ListSources {
  const schema = (f: string) => JSON.parse(readFileSync(join(ROOT, "spec/schemas", f), "utf-8"));
  const decision = schema("decision.schema.json");
  const event = schema("wave-event.schema.json");
  const config = schema("config.schema.json");
  return {
    decisionKinds: decision.allOf[1].properties.payload.properties.kind.enum,
    events: event.allOf[1].properties.type.enum,
    tunables: tunableKeys(config.$defs.tunableProperties.properties),
  };
}

export function specListProblems(spec: string, sources: ListSources): string[] {
  const lists: [string, readonly string[], string][] = [
    ["decision-kinds", sources.decisionKinds, "decision.schema.json"],
    ["events", sources.events, "wave-event.schema.json"],
    ["tunables", sources.tunables, "config.schema.json"],
  ];
  return lists.flatMap(([name, expected, source]) => {
    const items = specListItems(spec, name);
    if (items === null) return [`no \`<!-- spec-list: ${name} -->\` list`];
    if (!specListClosed(spec, name)) {
      return [`the ${name} list has no closing \`<!-- /spec-list -->\``];
    }
    const malformed = specListMalformed(spec, name).map(
      (line) => `the ${name} list has an item that does not open with a code span: \`${line}\``,
    );
    return [...malformed, ...listProblems(name, items, expected, source)];
  });
}

export interface Reservation {
  section: string;
  issue: string;
  topic: string;
  line: number;
}

/** The `| §N.N | #issue | topic |` rows of spec/RESERVED.md; other rows are notes. */
export function parseReserved(text: string): Reservation[] {
  const out: Reservation[] = [];
  text.split("\n").forEach((line, i) => {
    const m = /^\|\s*§\s?(\d+(?:\.\d+)*)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/.exec(line);
    if (m !== null) {
      out.push({
        section: m[1] as string,
        issue: m[2] as string,
        topic: m[3] as string,
        line: i + 1,
      });
    }
  });
  return out;
}

/**
 * A reserved number is free, or its heading carries the reserved topic (case-insensitively);
 * a heading with another topic means a sibling PR took the number.
 */
export function reservationProblems(spec: string, reserved: Reservation[]): string[] {
  const titles = new Map<string, string>();
  for (const line of spec.split("\n")) {
    const m = HEADING.exec(line);
    if (m?.[1] !== undefined) titles.set(m[1], line.slice(m[0].length).trim());
  }
  const problems: string[] = [];
  const seen = new Map<string, number>();
  for (const r of reserved) {
    const first = seen.get(r.section);
    if (first !== undefined) {
      problems.push(`${RESERVED}:${r.line}: §${r.section} is already reserved on line ${first}`);
      continue;
    }
    seen.set(r.section, r.line);
    if (r.topic === "") {
      problems.push(
        `${RESERVED}:${r.line}: §${r.section} is reserved for ${r.issue} with no topic`,
      );
      continue;
    }
    const title = titles.get(r.section);
    if (title !== undefined && !title.toLowerCase().includes(r.topic.toLowerCase())) {
      problems.push(
        `${RESERVED}:${r.line}: §${r.section} is reserved for ${r.issue} (${r.topic}), but SPEC.md's §${r.section} is "${title}"`,
      );
    }
  }
  return problems;
}

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf-8" })
    .split("\n")
    .filter((f) => /\.(ts|tsx|md|json|yaml|yml|conf|sh)$/.test(f) && f !== "bun.lock");
}

/** The problems in tracked file `f` (repo-relative path) with contents `text`. */
export function fileProblems(f: string, text: string, known: Set<string>): string[] {
  const problems: string[] = [];
  for (const { ref, line } of citedSections(text, f === SPEC)) {
    if (!known.has(ref)) problems.push(`${f}:${line}: cites SPEC §${ref}, which does not exist`);
  }
  text.split("\n").forEach((l, i) => {
    if (citesDesignDoc(l)) {
      problems.push(`${f}:${i + 1}: cites the local-only design doc by section`);
    }
  });
  return problems;
}

export function check(): string[] {
  const spec = readFileSync(join(ROOT, SPEC), "utf-8");
  const sections = specSections(spec);
  const known = new Set(sections);
  const problems = numberingProblems(sections).map((p) => `${SPEC}: ${p}`);
  problems.push(...specListProblems(spec, listSources()).map((p) => `${SPEC}: ${p}`));
  let reserved = "";
  try {
    reserved = readFileSync(join(ROOT, RESERVED), "utf-8");
  } catch {
    // no reservations
  }
  problems.push(...reservationProblems(spec, parseReserved(reserved)));
  for (const f of trackedFiles()) {
    if (f === "scripts/check-spec-refs.ts") continue;
    let text: string;
    try {
      text = readFileSync(join(ROOT, f), "utf-8");
    } catch {
      continue; // deleted in the working tree
    }
    problems.push(...fileProblems(f, text, known));
  }
  return problems;
}

if (import.meta.main) {
  const problems = check();
  for (const p of problems) console.error(p);
  if (problems.length > 0) {
    console.error(`\n${problems.length} SPEC reference problem(s)`);
    process.exit(1);
  }
  console.log("SPEC numbering, references, lists and reservations ok");
}
