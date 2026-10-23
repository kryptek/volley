import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/tmp";
import {
  assignShards,
  hashShard,
  listTestFiles,
  parseJunit,
  parseShard,
  readTimings,
} from "./test-shards";

const SCRIPT = join(import.meta.dir, "test-shards.ts");
const VOLLEYD = join(import.meta.dir, "..", "packages", "volleyd");

/** A skewed spread of file times, like a real suite: a few heavy files, a long light tail. */
function sampleTimings(): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < 60; i++)
    out[`test/f${String(i).padStart(2, "0")}.test.ts`] = 1 + ((i * 37) % 23);
  out["test/heavy-a.test.ts"] = 40;
  out["test/heavy-b.test.ts"] = 35;
  return out;
}

function loads(shards: string[][], timings: Record<string, number>): number[] {
  return shards.map((files) => files.reduce((s, f) => s + (timings[f] ?? 0), 0));
}

describe("assignShards", () => {
  test("every file lands in exactly one shard", () => {
    const timings = sampleTimings();
    const files = Object.keys(timings);
    const shards = assignShards(files, timings, 4);
    expect(shards).toHaveLength(4);
    const all = shards.flat();
    expect(all.length).toBe(files.length);
    expect(new Set(all)).toEqual(new Set(files));
  });

  test("the heaviest shard is within 20% of the mean", () => {
    const timings = sampleTimings();
    const shards = assignShards(Object.keys(timings), timings, 4);
    const l = loads(shards, timings);
    const mean = l.reduce((a, b) => a + b, 0) / l.length;
    expect(Math.max(...l)).toBeLessThanOrEqual(mean * 1.2);
  });

  test("a file missing from the timings still lands in exactly one shard, by its hash", () => {
    const timings = sampleTimings();
    const files = [...Object.keys(timings), "test/brand-new.test.ts"];
    const shards = assignShards(files, timings, 4);
    const holding = shards.filter((s) => s.includes("test/brand-new.test.ts"));
    expect(holding).toHaveLength(1);
    expect(shards[hashShard("test/brand-new.test.ts", 4)]).toContain("test/brand-new.test.ts");
  });

  test("a new file does not move any timed file to another shard", () => {
    const timings = sampleTimings();
    const before = assignShards(Object.keys(timings), timings, 4);
    const after = assignShards([...Object.keys(timings), "test/brand-new.test.ts"], timings, 4);
    for (let i = 0; i < 4; i++) {
      expect(after[i]?.filter((f) => f !== "test/brand-new.test.ts")).toEqual(before[i] ?? []);
    }
  });

  test("timings for files that no longer exist are ignored", () => {
    const shards = assignShards(
      ["test/a.test.ts"],
      { "test/a.test.ts": 1, "test/gone.test.ts": 99 },
      2,
    );
    expect(shards.flat()).toEqual(["test/a.test.ts"]);
  });

  test("the output is deterministic, whatever order the files come in", () => {
    const timings = sampleTimings();
    const files = Object.keys(timings);
    const a = assignShards(files, timings, 4);
    const b = assignShards([...files].reverse(), timings, 4);
    expect(b).toEqual(a);
    // Each shard lists its files sorted, so the command line is stable too.
    for (const s of a) expect(s).toEqual([...s].sort());
  });

  test("one shard holds everything", () => {
    const timings = sampleTimings();
    const shards = assignShards(Object.keys(timings), timings, 1);
    expect(shards).toHaveLength(1);
    expect(shards[0]?.length).toBe(Object.keys(timings).length);
  });
});

describe("parseShard", () => {
  test("reads <i>/<n>, 1-based", () => {
    expect(parseShard("1/4")).toEqual({ index: 0, total: 4 });
    expect(parseShard("4/4")).toEqual({ index: 3, total: 4 });
  });

  test("rejects anything else", () => {
    for (const bad of ["0/4", "5/4", "1/0", "a/b", "1", "", "1/4/2"]) {
      expect(parseShard(bad)).toBeUndefined();
    }
  });
});

describe("parseJunit", () => {
  test("sums each file's test case times (bun leaves the file suite's own time at 0)", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" time="3.5">
  <testsuite name="test/a.test.ts" file="test/a.test.ts" tests="2" time="0">
    <testsuite name="nested" file="test/a.test.ts" line="3" tests="2" time="0">
      <testcase name="x" classname="nested" time="0.5" file="test/a.test.ts" line="4" />
      <testcase name="a &quot;quoted&quot; one" classname="nested" time="0.75" file="test/a.test.ts" />
    </testsuite>
  </testsuite>
  <testsuite name="test/sub/b.test.ts" file="test/sub/b.test.ts" tests="1" time="0">
    <testcase name="y" classname="" time="2.25" file="test/sub/b.test.ts">
      <skipped />
    </testcase>
  </testsuite>
</testsuites>`;
    expect(parseJunit(xml)).toEqual({ "test/a.test.ts": 1.25, "test/sub/b.test.ts": 2.25 });
  });
});

describe("listTestFiles", () => {
  test("every *.test.ts under test/, sorted and relative to the package", () => {
    const dir = tempDir("vly-shards-");
    mkdirSync(join(dir, "test", "sub"), { recursive: true });
    mkdirSync(join(dir, "test", "node_modules"), { recursive: true });
    for (const f of ["test/b.test.ts", "test/a.test.ts", "test/sub/c.test.ts", "test/helper.ts"]) {
      writeFileSync(join(dir, f), "");
    }
    writeFileSync(join(dir, "test", "node_modules", "x.test.ts"), "");
    expect(listTestFiles(dir)).toEqual(["test/a.test.ts", "test/b.test.ts", "test/sub/c.test.ts"]);
  });
});

describe("volleyd's committed timings", () => {
  test("cover every volleyd test file (rerun `timings` after adding a slow one)", () => {
    const timings = readTimings(VOLLEYD);
    const missing = listTestFiles(VOLLEYD).filter((f) => !(f in timings));
    // A handful of new, untimed files is fine (they shard by hash); a stale table is not.
    expect(missing.length).toBeLessThanOrEqual(10);
  });

  test("split the way CI splits them (8 shards), every file runs once and no shard is heavy", () => {
    const timings = readTimings(VOLLEYD);
    const files = listTestFiles(VOLLEYD);
    const shards = assignShards(files, timings, 8);
    expect(shards).toHaveLength(8);
    expect(shards.flat().sort()).toEqual(files);
    const l = loads(shards, timings);
    const mean = l.reduce((a, b) => a + b, 0) / l.length;
    expect(Math.max(...l)).toBeLessThanOrEqual(mean * 1.2);
  });
});

describe("the CLI", () => {
  function run(args: string[]) {
    const r = Bun.spawnSync(["bun", SCRIPT, ...args], { stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  }

  test("`list <i>/<n>` prints one shard's files; the shards together are the whole suite", () => {
    const seen: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const r = run(["list", `${i}/4`, "--dir", VOLLEYD]);
      expect(r.code).toBe(0);
      seen.push(...r.out.trim().split("\n").filter(Boolean));
    }
    expect(seen.sort()).toEqual(listTestFiles(VOLLEYD));
  });

  test("a bad shard is a usage error", () => {
    expect(run(["list", "5/4", "--dir", VOLLEYD]).code).toBe(2);
    expect(run(["frobnicate"]).code).toBe(2);
  });

  test("`timings <junit.xml>` writes test/timings.json, rounded and sorted", () => {
    const dir = tempDir("vly-shards-");
    mkdirSync(join(dir, "test"), { recursive: true });
    const xml = join(dir, "junit.xml");
    writeFileSync(
      xml,
      `<testsuites><testcase name="b" time="2.3456" file="test/b.test.ts" /><testcase name="a" time="0.0001" file="test/a.test.ts" /></testsuites>`,
    );
    expect(run(["timings", xml, "--dir", dir]).code).toBe(0);
    const text = readFileSync(join(dir, "test", "timings.json"), "utf8");
    expect(Object.keys(JSON.parse(text))).toEqual(["test/a.test.ts", "test/b.test.ts"]);
    expect(JSON.parse(text)).toEqual({ "test/a.test.ts": 0.01, "test/b.test.ts": 2.35 });
  });

  test("`timings` merges a partial report: files it lacks keep their time, deleted files drop", () => {
    const dir = tempDir("vly-shards-");
    mkdirSync(join(dir, "test"), { recursive: true });
    for (const f of ["a", "b"]) writeFileSync(join(dir, "test", `${f}.test.ts`), "");
    writeFileSync(
      join(dir, "test", "timings.json"),
      JSON.stringify({ "test/a.test.ts": 5, "test/b.test.ts": 7, "test/gone.test.ts": 9 }),
    );
    const xml = join(dir, "junit.xml");
    writeFileSync(
      xml,
      `<testsuites><testcase name="b" time="1.5" file="test/b.test.ts" /></testsuites>`,
    );
    expect(run(["timings", xml, "--dir", dir]).code).toBe(0);
    expect(readTimings(dir)).toEqual({ "test/a.test.ts": 5, "test/b.test.ts": 1.5 });
  });
});
