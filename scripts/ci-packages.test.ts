import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PACKAGES = join(import.meta.dir, "..", "packages");

// ci.yml's `test` job selects every package but volleyd and volley-desk by `--filter=<directory
// name>`, and bun matches the package.json name: a package whose name differs would leave CI.
describe("ci.yml package selection", () => {
  test("every packages/* directory is named like its package and has a test script", () => {
    const dirs = readdirSync(PACKAGES).filter((d) => existsSync(join(PACKAGES, d, "package.json")));
    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) {
      const pkg = JSON.parse(readFileSync(join(PACKAGES, dir, "package.json"), "utf8"));
      expect({ dir, name: pkg.name }).toEqual({ dir, name: dir });
      expect({ dir, test: typeof pkg.scripts?.test }).toEqual({ dir, test: "string" });
    }
  });
});
