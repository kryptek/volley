import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Grep-guard: every daemon timer and every wall-clock read goes through src/clock.ts (the `Clock`
 * the daemon is given), so tests drive daemon timing on a fake clock instead of racing it. The
 * real clock itself (`systemClock`, `globalThis` timers) is used only where a line says why
 * (`// real clock: <why>`), and in daemon.ts only as the default of `DaemonOptions.clock`. And no
 * test polls the wall clock around daemon timing: a deadline, an elapsed-time bound or a real
 * timer is allowed only for a broker round-trip or a real process, annotated as one on its own
 * line or the line above.
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

/** Import statements blanked (line numbers kept): importing `systemClock` is not using it. */
const withoutImports = (text: string) =>
  text.replace(/^import\b[\s\S]*?\bfrom\s+["'][^"']+["'];?$/gm, (m) => m.replace(/[^\n]/g, ""));

/** `// <tag> <why>` on the line or the line above it. */
const annotated = (lines: string[], i: number, tag: RegExp) =>
  tag.test(lines[i] ?? "") || tag.test(lines[i - 1] ?? "");

/** Timers and clock reads that bypass the injected `Clock` (not `clock.setTimeout(…)`). */
const SRC_WALL_CLOCK = [
  /(?<![\w.$])(?:setTimeout|setInterval|clearTimeout|clearInterval|setImmediate)\s*\(/,
  /(?<![\w.$])Date\.now\b/,
  /(?<![\w.$])performance\.now\b/,
  /\bnew Date\(\s*\)/,
];

/** The real clock reached past the injected one: allowed only on a `real clock:` line. */
const SRC_REAL_CLOCK = [
  /\bsystemClock\b/,
  /\bglobalThis\s*\.\s*(?:setTimeout|setInterval|clearTimeout|clearInterval|setImmediate|Date|performance)\b/,
];
const REAL_CLOCK = /\/\/\s*real clock: \S/;

function srcViolations(text: string): string[] {
  const lines = withoutImports(text).split("\n");
  return lines.flatMap((line, i) => {
    if (isCommentLine(line)) return [];
    const c = code(line);
    if (SRC_WALL_CLOCK.some((re) => re.test(c))) return [`${i + 1}: ${line.trim()}`];
    if (!SRC_REAL_CLOCK.some((re) => re.test(c))) return [];
    return annotated(lines, i, REAL_CLOCK) ? [] : [`${i + 1}: ${line.trim()}`];
  });
}

/** daemon.ts reads `systemClock` only as the default of `DaemonOptions.clock`. */
const DAEMON_DEFAULT_CLOCK = /^\s*this\.time = withNow\(opts\.clock \?\? systemClock, opts\.now\);/;

function daemonRealClockUses(text: string): string[] {
  return withoutImports(text)
    .split("\n")
    .flatMap((line, i) =>
      !isCommentLine(line) &&
      SRC_REAL_CLOCK.some((re) => re.test(code(line))) &&
      !DAEMON_DEFAULT_CLOCK.test(line)
        ? [`${i + 1}: ${line.trim()}`]
        : [],
    );
}

/**
 * A test timing something on the wall clock: a deadline (`Date.now() + ms`, `Date.now() < end`),
 * an elapsed-time bound (`expect(Date.now() - t0)`), a `performance.now()` sum or comparison, or
 * any real timer (`setTimeout`/`setInterval`, bare or on `globalThis`: a sleep, a race, a delayed
 * start). Allowed only with a `broker round-trip:` or `real process:` annotation on the line or
 * the one above it; a fake clock's `clock.setTimeout(…)` is not a real timer.
 */
const TEST_WALL_CLOCK = [
  /=\s*(?:Date|performance)\.now\(\)\s*\+/,
  /(?:Date|performance)\.now\(\)\s*[<>]/,
  /[<>]=?\s*(?:Date|performance)\.now\(\)/,
  /expect\(\s*(?:Date|performance)\.now\(\)\s*-/,
  /performance\.now\(\)\s*-/,
  /(?:(?<![\w.$])|\bglobalThis\s*\.\s*)(?:setTimeout|setInterval)\s*\(/,
];
const ANNOTATION = /\/\/\s*(?:broker round-trip|real process): \S/;

function testViolations(text: string): string[] {
  const lines = text.split("\n");
  return lines.flatMap((line, i) => {
    if (isCommentLine(line)) return [];
    if (!TEST_WALL_CLOCK.some((re) => re.test(code(line)))) return [];
    return annotated(lines, i, ANNOTATION) ? [] : [`${i + 1}: ${line.trim()}`];
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

  it("the src detector catches the real clock reached past the injected one, not annotated uses", () => {
    expect(srcViolations("this.timer = systemClock.setTimeout(() => tick(), ms);")).toHaveLength(1);
    expect(srcViolations("const now = systemClock.now();")).toHaveLength(1);
    expect(srcViolations("const at = dateOf(systemClock);")).toHaveLength(1);
    expect(srcViolations("this.clock = deps.clock ?? systemClock;")).toHaveLength(1);
    expect(srcViolations("globalThis.setTimeout(fn, 10);")).toHaveLength(1);
    expect(srcViolations("const t = globalThis.Date.now();")).toHaveLength(1);
    expect(srcViolations("// real clock: a child process\nconst t = systemClock.now();")).toEqual(
      [],
    );
    expect(srcViolations("const t = systemClock.now(); // real clock: a file mtime")).toEqual([]);
    expect(srcViolations("// real clock:\nconst t = systemClock.now();")).toHaveLength(1);
    expect(srcViolations('import { dateOf, systemClock } from "./clock";')).toEqual([]);
    expect(srcViolations('import {\n  type Clock,\n  systemClock,\n} from "./clock";')).toEqual([]);
  });

  it("daemon.ts uses the real clock only as the default of DaemonOptions.clock", () => {
    expect(
      daemonRealClockUses("    this.time = withNow(opts.clock ?? systemClock, opts.now);"),
    ).toEqual([]);
    expect(
      daemonRealClockUses("    // real clock: why\n    this.t = systemClock.setTimeout(f, 1);"),
    ).toHaveLength(1);
    expect(daemonRealClockUses("  now: () => number = systemClock.now,")).toHaveLength(1);
    expect(daemonRealClockUses(readFileSync(join(SRC, "daemon.ts"), "utf-8"))).toEqual([]);
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
    // Deadline races, sleeps on any callback, delayed starts.
    expect(
      testViolations("const x = await new Promise((r) => setTimeout(() => r(null), 3000));"),
    ).toHaveLength(1);
    expect(testViolations("await new Promise((done) => setTimeout(done, 100));")).toHaveLength(1);
    expect(testViolations("setTimeout(async () => { await go(); }, 20);")).toHaveLength(1);
    expect(
      testViolations('await Promise.race([p, new Promise((r) => setTimeout(() => r("x"), 200))]);'),
    ).toHaveLength(1);
    expect(testViolations("const t = setInterval(poll, 50);")).toHaveLength(1);
    expect(testViolations("globalThis.setTimeout(r, 10);")).toHaveLength(1);
    // Deadline loops and elapsed-time bounds, on either clock.
    expect(testViolations("while (Date.now() < end) await tick();")).toHaveLength(1);
    expect(testViolations("const end = performance.now() + 5000;")).toHaveLength(1);
    expect(testViolations("expect(Date.now() - started).toBeLessThan(2000);")).toHaveLength(1);
    expect(testViolations("const ms = performance.now() - t0;")).toHaveLength(1);
    expect(
      testViolations(
        "// real process: a child's kill on the real clock\nexpect(Date.now() - t0).toBeLessThan(3000);",
      ),
    ).toEqual([]);
    expect(
      testViolations("// broker round-trip:\nawait sleep(10);\nsetTimeout(r, 1);"),
    ).toHaveLength(1);
    expect(
      testViolations(
        "// broker round-trip: the retained state arrives over MQTT\nawait new Promise((r) => setTimeout(r, 10));",
      ),
    ).toEqual([]);
    expect(testViolations("clock.setTimeout(() => go(), 20);")).toEqual([]);
    expect(
      testViolations('expect(violations("setTimeout(check, 1000);")).toHaveLength(1);'),
    ).toEqual([]);
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
