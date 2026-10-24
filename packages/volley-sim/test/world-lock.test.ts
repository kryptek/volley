import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SIM_BIN } from "../src/env";
import { lockPath, readWorld, withWorld } from "../src/world";
import { makeRepo, pushBranch } from "./helpers/repo";
import { tempDir } from "./helpers/tmp";

/** `bin/gh <argv>` in its own process; resolves with its exit code and stdout. */
function ghProcess(argv: string[], cwd: string, home: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const p = spawn(join(SIM_BIN, "gh"), argv, {
      cwd,
      env: { ...process.env, VOLLEY_SIM_HOME: home, VOLLEY_SIMULATED: "1" },
    });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => {
      stdout += d;
    });
    p.stderr.on("data", (d) => {
      stderr += d;
    });
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("the world file lock", () => {
  it("two concurrent `gh pr create` from different processes get different numbers", async () => {
    const dir = tempDir("volley-sim-lock-");
    const home = join(dir, "sim");
    const { work } = makeRepo(dir);
    const branches = ["w/t1", "w/t2", "w/t3", "w/t4"];
    for (const b of branches) pushBranch(work, b, `${b.replace("/", "-")}.txt`);
    const results = await Promise.all(
      branches.map((b) =>
        ghProcess(
          ["pr", "create", "--title", b, "--body", "", "--base", "main", "--head", b],
          work,
          home,
        ),
      ),
    );
    for (const r of results) expect(r).toMatchObject({ code: 0 });
    const numbers = results.map((r) => Number(/(\d+)\s*$/.exec(r.stdout)?.[1]));
    expect(new Set(numbers).size).toBe(branches.length);
    expect(
      readWorld(home)
        .prs.map((p) => p.number)
        .sort(),
    ).toEqual([...numbers].sort());
  }, 30000);

  it("a lock left by a process that is gone is taken over", () => {
    const home = join(tempDir("volley-sim-stale-"), "sim");
    mkdirSync(home, { recursive: true });
    // A pid no process has (above the kernel's pid_max).
    writeFileSync(lockPath(home), "999999999\n");
    const n = withWorld(home, (w) => {
      w.gh.signedIn = true;
      return 7;
    });
    expect(n).toBe(7);
    expect(readWorld(home).gh.signedIn).toBe(true);
    expect(existsSync(lockPath(home))).toBe(false);
  });

  it("a write that throws leaves the world as it was and releases the lock", () => {
    const home = join(tempDir("volley-sim-throw-"), "sim");
    expect(() =>
      withWorld(home, (w) => {
        w.gh.signedIn = true;
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(readWorld(home).gh.signedIn).toBe(false);
    expect(existsSync(lockPath(home))).toBe(false);
  });
});
