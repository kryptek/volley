import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, it } from "vitest";
import { tempDir } from "../helpers/tmp";

// Run by tmp-sweep.test.ts under `bun test`: an afterEach that throws, after a test that made a
// tempDir. The dir's path goes to $TMPDIR/made so the caller can check it was there.
afterEach(() => {
  throw new Error("afterEach throws on purpose");
});

it("makes a temp dir", () => {
  const dir = tempDir("vly-sweep-fixture-");
  writeFileSync(join(process.env.TMPDIR as string, "made"), dir);
});
