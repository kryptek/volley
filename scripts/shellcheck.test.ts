import { describe, expect, test } from "bun:test";
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
