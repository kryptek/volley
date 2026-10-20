import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { prefixOf } from "./check-tmp-leaks";

/**
 * Grep-guard: a test never creates a temp dir by hand. Every one goes through `tempDir` /
 * `tempDirForAll` in its package's `test/helpers/tmp.ts`, which removes it when the test (or
 * file) ends; see scripts/check-tmp-leaks.ts for why.
 */

const ROOT = join(import.meta.dir, "..");
const PACKAGES = join(ROOT, "packages");
const HELPER = join("test", "helpers", "tmp.ts");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.name === "node_modules"
      ? []
      : d.isDirectory()
        ? files(join(dir, d.name))
        : /\.tsx?$/.test(d.name)
          ? [join(dir, d.name)]
          : [],
  );
}

const packages = readdirSync(PACKAGES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => join(PACKAGES, d.name));

const testFiles = packages.flatMap((pkg) => {
  try {
    return files(join(pkg, "test"));
  } catch {
    return []; // a package without tests
  }
});

describe("temp dirs in tests", () => {
  test("no test file calls mkdtemp outside test/helpers/tmp.ts", () => {
    const offenders = testFiles
      .filter((f) => !f.endsWith(HELPER))
      .flatMap((f) =>
        readFileSync(f, "utf8")
          .split("\n")
          .flatMap((line, i) =>
            /\bmkdtemp(Sync)?\b/.test(line)
              ? [`${relative(ROOT, f)}:${i + 1}: ${line.trim()}`]
              : [],
          ),
      );
    expect(offenders).toEqual([]);
  });

  test("every tempDir prefix is one check-tmp-leaks watches", () => {
    const prefixes = testFiles
      .filter((f) => !f.endsWith(HELPER))
      .flatMap((f) =>
        [...readFileSync(f, "utf8").matchAll(/\btempDir(?:ForAll)?\("([^"]+)"/g)].map((m) => m[1]),
      );
    expect(prefixes.length).toBeGreaterThan(0);
    expect([...new Set(prefixes)].filter((p) => prefixOf(`${p}abc123`) === undefined)).toEqual([]);
  });

  test("every package's test/helpers/tmp.ts is the same file", () => {
    const copies = packages.flatMap((pkg) => {
      try {
        return [[relative(ROOT, pkg), readFileSync(join(pkg, HELPER), "utf8")] as const];
      } catch {
        return [];
      }
    });
    expect(copies.length).toBeGreaterThan(0);
    const [, first] = copies[0] as readonly [string, string];
    expect(copies.filter(([, text]) => text !== first).map(([pkg]) => pkg)).toEqual([]);
  });
});
