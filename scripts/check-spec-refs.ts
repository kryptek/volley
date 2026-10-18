#!/usr/bin/env bun
/**
 * SPEC numbering + cross-reference check.
 *
 * 1. The numbered headings in `spec/SPEC.md` are contiguous at every level (no §4.4 → §4.6 jump).
 * 2. Every section reference resolves to a heading: `§N.N` inside SPEC.md, and `SPEC §N.N`
 *    (plus any `§` that follows it in a list: `SPEC §3, §4.3`) or `spec section N.N` in every
 *    other tracked file.
 * 3. No tracked file cites the design doc by section: it is local-only (gitignored), so a
 *    reader of the public repo cannot follow the reference.
 *
 * Exit code 0 when clean; 1 with one line per problem otherwise.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SPEC = "spec/SPEC.md";

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
      /SPEC(?:\.md)?\s+((?:§\s?\d+(?:\.\d+)*(?:\s*(?:,|and|\/|&)\s*)?)+)/g,
    )) {
      for (const r of (m[1] as string).matchAll(/§\s?(\d+(?:\.\d+)*)/g)) push(r[1] as string);
    }
    for (const m of line.matchAll(/spec section (\d+(?:\.\d+)*)/gi)) push(m[1] as string);
  });
  return refs;
}

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf-8" })
    .split("\n")
    .filter((f) => /\.(ts|tsx|md|json|yaml|yml|conf|sh)$/.test(f) && f !== "bun.lock");
}

export function check(): string[] {
  const spec = readFileSync(join(ROOT, SPEC), "utf-8");
  const sections = specSections(spec);
  const known = new Set(sections);
  const problems = numberingProblems(sections).map((p) => `${SPEC}: ${p}`);
  for (const f of trackedFiles()) {
    if (f === "scripts/check-spec-refs.ts") continue;
    let text: string;
    try {
      text = readFileSync(join(ROOT, f), "utf-8");
    } catch {
      continue; // deleted in the working tree
    }
    for (const { ref, line } of citedSections(text, f === SPEC)) {
      if (!known.has(ref)) problems.push(`${f}:${line}: cites SPEC §${ref}, which does not exist`);
    }
    text.split("\n").forEach((l, i) => {
      if (/design doc(?:'s)? §|design §/i.test(l)) {
        problems.push(`${f}:${i + 1}: cites the local-only design doc by section`);
      }
    });
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
  console.log("SPEC numbering and references ok");
}
