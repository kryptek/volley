#!/usr/bin/env bun
/**
 * Temp-dir leak guard: `bun scripts/check-tmp-leaks.ts [--dir <path>] -- <command...>`.
 *
 * Runs the command, then fails if it left Volley-prefixed entries (`volley-*`, `volleyd-*`,
 * `vly-*`, …) in the temp dir, listing them grouped by prefix with the source files that spell
 * the prefix out. A test suite that mkdtemps without cleanup once filled a build machine's /tmp
 * with ~27k dirs and exhausted its inodes.
 *
 * By default the command runs with `TMPDIR` (and `TMP`/`TEMP`) set to a private dir under the OS
 * temp dir, so test suites or agents running concurrently on the machine cannot show up as this
 * command's leaks; the private dir is removed afterwards, leaks included. `--dir <path>` watches
 * `<path>` instead and leaves it as found: only entries created during the command count.
 *
 * Exit code: the command's own when it fails; else 1 when it leaked, 0 when clean; 2 on usage.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** The names Volley's code and tests give their temp dirs start with one of these. */
const PREFIXES = [
  "volley-",
  "volleyd-",
  "vly-",
  "wave-from-issues-",
  "validate-brief-",
  "desk-rb-",
  "rb-llms-",
  "lease-",
  "launch-profile-",
  "launch-check-",
  "fence-profiles-",
];

/** At most this many entry names per prefix in the report. */
const SHOWN = 3;

/** `volley-hooks-Ab12Cd` → `volley-hooks-` (mkdtemp's suffix has no `-`); undefined if not ours. */
export function prefixOf(name: string): string | undefined {
  if (!PREFIXES.some((p) => name.startsWith(p))) return undefined;
  return name.slice(0, name.lastIndexOf("-") + 1);
}

/** The Volley entries in `after` that are not in `before`, grouped by prefix. */
export function groupLeaks(before: string[], after: string[]): Map<string, string[]> {
  const old = new Set(before);
  const out = new Map<string, string[]>();
  for (const name of [...after].sort()) {
    const prefix = prefixOf(name);
    if (prefix === undefined || old.has(name)) continue;
    out.set(prefix, [...(out.get(prefix) ?? []), name]);
  }
  return out;
}

/** One line per prefix: `volley-x-: 2 (volley-x-abc, volley-x-def) — created in a.test.ts`. */
export function leakReport(leaks: Map<string, string[]>, owners: (prefix: string) => string[]) {
  const total = [...leaks.values()].reduce((n, names) => n + names.length, 0);
  const lines = [`check-tmp-leaks: ${total} temp entries left behind`];
  for (const [prefix, names] of leaks) {
    const shown = names.slice(0, SHOWN).join(", ") + (names.length > SHOWN ? ", …" : "");
    const files = owners(prefix);
    const where = files.length > 0 ? ` — created in ${files.join(", ")}` : "";
    lines.push(`  ${prefix}: ${names.length} (${shown})${where}`);
  }
  lines.push(
    "Every temp dir a test creates goes through tempDir / tempDirForAll (test/helpers/tmp.ts).",
  );
  return lines.join("\n");
}

/** The source files under `root` that spell out `"<prefix>"`: the likely creators. */
export function ownersOf(prefix: string, root = ROOT): string[] {
  const needles = [`"${prefix}"`, `'${prefix}'`, `\`${prefix}`];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      // The guard spells out every prefix; it owns none of them.
      if (entry.name.startsWith("check-tmp-leaks")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|sh)$/.test(entry.name)) {
        const text = readFileSync(path, "utf8");
        if (needles.some((n) => text.includes(n))) out.push(relative(root, path));
      }
    }
  };
  for (const top of ["packages", "scripts"]) {
    try {
      walk(join(root, top));
    } catch {
      // A root without that directory has no owners in it.
    }
  }
  return out.sort();
}

function main(argv: string[]): number {
  // `bun script -- cmd` hands the script no `--` when it comes first, so it is optional.
  let rest = argv;
  let given: string | undefined;
  if (rest[0] === "--dir") {
    given = rest[1];
    rest = rest.slice(2);
  }
  if (rest[0] === "--") rest = rest.slice(1);
  const command = rest;
  if (command.length === 0 || given === "") {
    console.error("usage: bun scripts/check-tmp-leaks.ts [--dir <path>] -- <command...>");
    return 2;
  }
  const dir = given ?? mkdtempSync(join(tmpdir(), "volley-leakcheck-"));
  try {
    const before = readdirSync(dir);
    const r = spawnSync(command[0] as string, command.slice(1), {
      stdio: "inherit",
      env: { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir },
    });
    if (r.error) throw r.error;
    const leaks = groupLeaks(before, readdirSync(dir));
    if (leaks.size > 0) console.error(leakReport(leaks, (p) => ownersOf(p)));
    if (r.status !== 0) return r.status ?? 1;
    return leaks.size > 0 ? 1 : 0;
  } finally {
    if (given === undefined) rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
