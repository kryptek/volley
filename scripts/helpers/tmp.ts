import { onTestFinished } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The root scripts' counterpart of each package's test/helpers/tmp.ts (bun's runner, not
// vitest): the only place a scripts test creates a temp dir, removed when its test ends.

/** A fresh directory under the OS temp dir, removed when the current test finishes. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
}
