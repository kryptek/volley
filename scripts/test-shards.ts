#!/usr/bin/env bun
/**
 * Test-file shards balanced by measured time: `bun scripts/test-shards.ts <command> [--dir <pkg>]`.
 *
 *   list <i>/<n>          print shard i's test files (1-based), one per line
 *   run <i>/<n>           run shard i under `bun test --timeout 15000` (`--timeout <ms>` overrides),
 *                         or under `vitest run` with `--runner vitest` (its config sets the timeout)
 *   timings <junit.xml>   write <pkg>/test/timings.json from a `bun test --reporter=junit` report
 *
 * `<pkg>` defaults to the current directory. Files are placed heaviest first on the lightest
 * shard, by the seconds in `test/timings.json`; a file the table does not know yet goes to the
 * shard its path hashes to, so adding a test file never moves another one. Every `*.test.ts`
 * under `test/` lands in exactly one shard: the shards together run what one `bun test` would.
 *
 * Exit code: `run` exits with the test run's; 2 on usage.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const TIMINGS = join("test", "timings.json");

/** bun's own per-test default is 5 s; volleyd's vitest.config.ts declares 15 s. */
const DEFAULT_TIMEOUT_MS = "15000";

/** `"2/4"` → `{ index: 1, total: 4 }`; undefined unless 1 ≤ i ≤ n. */
export function parseShard(spec: string): { index: number; total: number } | undefined {
  const m = /^(\d+)\/(\d+)$/.exec(spec);
  if (!m) return undefined;
  const i = Number(m[1]);
  const n = Number(m[2]);
  if (n < 1 || i < 1 || i > n) return undefined;
  return { index: i - 1, total: n };
}

/** A stable shard for a file with no timing yet (FNV-1a over its path). */
export function hashShard(file: string, total: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < file.length; i++) {
    h ^= file.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % total;
}

/** `files` split into `total` shards: timed files greedily by load, untimed ones by hash. */
export function assignShards(
  files: string[],
  timings: Record<string, number>,
  total: number,
): string[][] {
  const shards: string[][] = Array.from({ length: total }, () => []);
  const load: number[] = new Array(total).fill(0);
  const timed = files.filter((f) => f in timings);
  // Heaviest first; ties by name, so the order the files arrive in never matters.
  timed.sort((a, b) => (timings[b] ?? 0) - (timings[a] ?? 0) || (a < b ? -1 : a > b ? 1 : 0));
  for (const file of timed) {
    let best = 0;
    for (let s = 1; s < total; s++) if ((load[s] ?? 0) < (load[best] ?? 0)) best = s;
    shards[best]?.push(file);
    load[best] = (load[best] ?? 0) + (timings[file] ?? 0);
  }
  for (const file of files) if (!(file in timings)) shards[hashShard(file, total)]?.push(file);
  return shards.map((s) => [...new Set(s)].sort());
}

/** Every `*.test.ts` under `<dir>/test`, relative to `dir` and sorted. */
export function listTestFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".test.ts")) out.push(path);
    }
  };
  walk("test");
  return out.sort();
}

/** `<dir>/test/timings.json` (file → seconds), or `{}` when there is none. */
export function readTimings(dir: string): Record<string, number> {
  try {
    return JSON.parse(readFileSync(join(dir, TIMINGS), "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

/** File → seconds from a `bun test` junit report: the sum of each file's test case times. */
export function parseJunit(xml: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of xml.matchAll(/<testcase\s([^>]*)>/g)) {
    const attrs = m[1] ?? "";
    const file = /\sfile="([^"]*)"/.exec(` ${attrs}`)?.[1];
    const time = Number(/\stime="([^"]*)"/.exec(` ${attrs}`)?.[1] ?? Number.NaN);
    if (file !== undefined && Number.isFinite(time)) out[file] = (out[file] ?? 0) + time;
  }
  return out;
}

function usage(): number {
  console.error(
    "usage: bun scripts/test-shards.ts list|run <i>/<n> [--dir <pkg>] [--timeout <ms>] [--runner bun|vitest]\n" +
      "       bun scripts/test-shards.ts timings <junit.xml> [--dir <pkg>]",
  );
  return 2;
}

interface Flags {
  dir: string;
  timeout: string;
  runner: "bun" | "vitest";
}

/** `--dir`, `--timeout`, `--runner` in any order; undefined on anything else. */
function parseFlags(rest: string[]): Flags | undefined {
  const flags: Flags = { dir: process.cwd(), timeout: DEFAULT_TIMEOUT_MS, runner: "bun" };
  for (let i = 0; i < rest.length; i += 2) {
    const value = rest[i + 1];
    if (value === undefined) return undefined;
    if (rest[i] === "--dir") flags.dir = value;
    else if (rest[i] === "--timeout") flags.timeout = value;
    else if (rest[i] === "--runner" && (value === "bun" || value === "vitest"))
      flags.runner = value;
    else return undefined;
  }
  return flags;
}

/** `timings`: the junit report's per-file seconds, rounded to 0.01 s, into test/timings.json. */
function writeTimings(junit: string, dir: string): number {
  const raw = parseJunit(readFileSync(junit, "utf8"));
  const rounded: Record<string, number> = {};
  for (const file of Object.keys(raw).sort()) {
    rounded[file] = Math.max(0.01, Math.round((raw[file] ?? 0) * 100) / 100);
  }
  writeFileSync(join(dir, TIMINGS), `${JSON.stringify(rounded, null, 2)}\n`);
  return 0;
}

/** `run`: one shard's files under the chosen runner. */
function runShard(files: string[], flags: Flags): number {
  if (files.length === 0) return 0;
  // Both runners read their arguments as filters: bun takes a `./` path as that one file, and
  // vitest matches a substring of the absolute path, which an absolute path is only for itself.
  const argv =
    flags.runner === "vitest"
      ? ["bunx", "vitest", "run", ...files.map((f) => resolve(flags.dir, f))]
      : ["bun", "test", "--timeout", flags.timeout, ...files.map((f) => `./${f}`)];
  const r = spawnSync(argv[0] as string, argv.slice(1), { cwd: flags.dir, stdio: "inherit" });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

function main(argv: string[]): number {
  const [command, arg, ...rest] = argv;
  const flags = parseFlags(rest);
  if (flags === undefined || arg === undefined) return usage();
  if (command === "timings") return writeTimings(arg, flags.dir);
  if (command !== "list" && command !== "run") return usage();
  const shard = parseShard(arg);
  if (!shard) return usage();
  const all = assignShards(listTestFiles(flags.dir), readTimings(flags.dir), shard.total);
  const files = all[shard.index] ?? [];
  if (command === "run") return runShard(files, flags);
  for (const f of files) console.log(f);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
