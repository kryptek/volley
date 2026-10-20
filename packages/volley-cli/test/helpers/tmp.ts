import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, onTestFinished } from "vitest";

// The only place a test creates a temp dir (a grep guard enforces it): every dir is removed when
// its test (or file) ends, pass or fail. Copied verbatim into each package's test/helpers/.

function remove(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}

/**
 * A fresh directory under the OS temp dir, removed when the current test finishes, after its
 * `afterEach` hooks (so a daemon an `afterEach` stops is gone before its dir is). Call it inside
 * a test or a `beforeEach`, or in a helper they call.
 */
export function tempDir(prefix: string): string {
  const made: string[] = [];
  try {
    // vitest silently drops an `afterEach` registered once tests run; `onTestFinished` is the
    // hook both vitest and bun's runner honour from inside a test or a `beforeEach`.
    onTestFinished(() => {
      for (const dir of made) remove(dir);
    });
  } catch {
    throw new Error(
      `tempDir("${prefix}") must be called inside a test or a beforeEach; for a dir shared by a file or describe, use tempDirForAll at that scope`,
    );
  }
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/**
 * A directory shared by every test in the enclosing file or `describe`: created before its first
 * test, removed after its last. Call it at file or `describe` scope; read the path through the
 * returned function, from a hook or test. A skipped describe never creates it. vitest stops at the
 * first `afterAll` that throws, so keep the scope's own `afterAll` hooks from throwing.
 */
export function tempDirForAll(prefix: string): () => string {
  let dir: string | undefined;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), prefix));
  });
  afterAll(() => {
    if (dir !== undefined) remove(dir);
    dir = undefined;
  });
  return () => {
    if (dir === undefined) throw new Error(`tempDirForAll("${prefix}") is read outside its scope`);
    return dir;
  };
}
