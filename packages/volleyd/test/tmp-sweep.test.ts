import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers/tmp";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

describe("bun test: the preload sweep (bunfig.toml)", () => {
  it("removes a tempDir whose test's afterEach threw", () => {
    // bun skips `onTestFinished` after a throwing afterEach; the preloaded afterAll catches it.
    const tmp = tempDir("vly-sweep-");
    const r = spawnSync("bun", ["test", "./test/fixtures/tmp-throwing-after-each.ts"], {
      cwd: PACKAGE,
      env: { ...process.env, TMPDIR: tmp },
      encoding: "utf8",
    });
    expect(r.status, `${r.stdout}${r.stderr}`).not.toBe(0); // the afterEach did throw
    const made = readFileSync(join(tmp, "made"), "utf8");
    expect(made.startsWith(join(tmp, "vly-sweep-fixture-"))).toBe(true);
    expect(existsSync(made)).toBe(false);
    expect(readdirSync(tmp)).toEqual(["made"]);
  });
});
