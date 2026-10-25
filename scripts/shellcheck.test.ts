import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "shellcheck.ts");

/** Runs the wrapper on a PATH with no shellcheck. */
function run(env: Record<string, string>) {
  const r = Bun.spawnSync([process.execPath, SCRIPT], {
    env: { PATH: "/nonexistent", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: `${r.stdout.toString()}${r.stderr.toString()}` };
}

describe("the shellcheck lint step", () => {
  test("locally without shellcheck: skipped with a notice", () => {
    const r = run({});
    expect(r.code).toBe(0);
    expect(r.out).toContain("shellcheck is not installed");
  });

  test("in CI without shellcheck: fails", () => {
    const r = run({ CI: "true" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("shellcheck is not installed");
  });
});

describe("the files it checks", () => {
  const files = [...readFileSync(SCRIPT, "utf8").matchAll(/^ {2}"([^"]+)",$/gm)].map((m) => m[1]);

  test("every one exists, verify.sh among them, and none of the retired macOS layer's", () => {
    for (const f of files) expect(existsSync(join(import.meta.dir, "..", f as string))).toBe(true);
    expect(files).toContain("scripts/install-tests/verify.sh");
    expect(files.filter((f) => /vm-macos|run-layer3/.test(f as string))).toEqual([]);
    expect(files.filter((f) => f?.includes("/stubs/"))).toEqual([
      "scripts/install-tests/stubs/multipass",
      "scripts/install-tests/stubs/ssh",
      "scripts/install-tests/stubs/gh",
    ]);
  });
});
