import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Grep-guard: every daemon timer and every wall-clock read goes through src/clock.ts (the `Clock`
 * the daemon is given), so tests drive daemon timing on a fake clock instead of racing it. And no
 * test polls the wall clock around daemon timing: a deadline loop or a bare sleep is allowed only
 * for a broker round-trip, annotated as one on its own line or the line above.
 */

const ROOT = new URL("../", import.meta.url).pathname;
const SRC = join(ROOT, "src");
const TEST = join(ROOT, "test");

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? tsFiles(join(dir, d.name))
      : d.name.endsWith(".ts")
        ? [join(dir, d.name)]
        : [],
  );
}

/** A line with comments and string contents blanked (template literals keep their `${…}`). */
const code = (line: string) =>
  line
    .replace(/\/\/.*$/, "")
    .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')
    .replace(/`[^`$]*`/g, '""');

const isCommentLine = (line: string) => /^\s*(\/\*|\*|\/\/)/.test(line);

/** Timers and clock reads that bypass the injected `Clock` (not `clock.setTimeout(…)`). */
const SRC_WALL_CLOCK = [
  /(?<![\w.$])(?:setTimeout|setInterval|clearTimeout|clearInterval|setImmediate)\s*\(/,
  /(?<![\w.$])Date\.now\b/,
  /(?<![\w.$])performance\.now\b/,
  /\bnew Date\(\s*\)/,
];

function srcViolations(text: string): string[] {
  return text.split("\n").flatMap((line, i) => {
    if (isCommentLine(line)) return [];
    const c = code(line);
    return SRC_WALL_CLOCK.some((re) => re.test(c)) ? [`${i + 1}: ${line.trim()}`] : [];
  });
}

/**
 * A test polling the wall clock: a deadline (`Date.now() + ms`, `Date.now() > end`) or a bare
 * sleep (`new Promise((r) => setTimeout(r, ms))`). Allowed only with a `broker round-trip:`
 * annotation on the line or the one above it.
 */
const TEST_WALL_CLOCK = [
  /=\s*Date\.now\(\)\s*\+/,
  /Date\.now\(\)\s*>/,
  /[<>]=?\s*Date\.now\(\)/,
  /setTimeout\(\s*(?:r|res|resolve)\s*,/,
];
const ANNOTATION = /broker round-trip:/;

function testViolations(text: string): string[] {
  const lines = text.split("\n");
  return lines.flatMap((line, i) => {
    if (isCommentLine(line)) return [];
    if (!TEST_WALL_CLOCK.some((re) => re.test(line.replace(/\/\/.*$/, "")))) return [];
    if (ANNOTATION.test(line) || ANNOTATION.test(lines[i - 1] ?? "")) return [];
    return [`${i + 1}: ${line.trim()}`];
  });
}

describe("no wall clock outside src/clock.ts", () => {
  it("the src detector catches what it guards against", () => {
    expect(srcViolations("const t = setTimeout(fn, 10);")).toHaveLength(1);
    expect(srcViolations("clearInterval(this.timer);")).toHaveLength(1);
    expect(srcViolations("now: () => number = Date.now,")).toHaveLength(1);
    expect(srcViolations("const at = new Date().toISOString();")).toHaveLength(1);
    expect(srcViolations("mono: performance.now(),")).toHaveLength(1);
    expect(srcViolations("this.timer = this.clock.setInterval(() => tick(), ms);")).toEqual([]);
    expect(srcViolations("const d = new Date(this.clock.now());")).toEqual([]);
    expect(srcViolations(" * a doc comment naming setTimeout( and Date.now")).toEqual([]);
    expect(srcViolations('log("setTimeout(") // Date.now')).toEqual([]);
  });

  it("src/ uses timers and clock reads only through clock.ts", () => {
    const offenders = tsFiles(SRC)
      .filter((f) => relative(SRC, f) !== "clock.ts")
      .flatMap((f) =>
        srcViolations(readFileSync(f, "utf-8")).map((v) => `${relative(SRC, f)}:${v}`),
      );
    expect(offenders).toEqual([]);
  });

  it("the test detector catches deadline polls and bare sleeps, not annotated ones", () => {
    expect(testViolations("const end = Date.now() + ms;")).toHaveLength(1);
    expect(testViolations("if (Date.now() > end) throw new Error();")).toHaveLength(1);
    expect(testViolations("await new Promise((r) => setTimeout(r, 100));")).toHaveLength(1);
    expect(
      testViolations(
        "// broker round-trip: the retained state arrives over MQTT\nawait new Promise((r) => setTimeout(r, 10));",
      ),
    ).toEqual([]);
    expect(testViolations("clock.setTimeout(() => go(), 20);")).toEqual([]);
    expect(testViolations("const at = new Date(Date.now() - HOUR).toISOString();")).toEqual([]);
    expect(testViolations("vi.setSystemTime(Date.now() + ms);")).toEqual([]);
  });

  it("test/ never polls the wall clock around daemon timing", () => {
    const offenders = tsFiles(TEST)
      .filter((f) => f !== new URL(import.meta.url).pathname)
      .flatMap((f) =>
        testViolations(readFileSync(f, "utf-8")).map((v) => `${relative(TEST, f)}:${v}`),
      );
    expect(offenders).toEqual([]);
  });
});
