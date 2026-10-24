import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, onTestFinished } from "vitest";

// The only place a test creates a temp dir (a grep guard enforces it): every dir is removed when
// its test (or file) ends, pass or fail. Copied verbatim into each package's test/helpers/.

/** Every dir made here and not removed yet; shared by every copy of this module in the process. */
const registry = globalThis as { [k: symbol]: Set<string> | undefined };
const KEY = Symbol.for("volley.test.tempDirs");
const live: Set<string> = registry[KEY] ?? new Set();
registry[KEY] = live;

function remove(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  live.delete(dir);
}

/**
 * Removes every dir a hook missed. Under bun's runner a throwing `afterEach` skips the
 * `onTestFinished` callbacks after it, so volleyd's bunfig.toml preloads `tmp-preload.ts`, which
 * calls this once every test file has run. (vitest always runs `onTestFinished`.)
 */
export function removeLeftoverTempDirs(): void {
  for (const dir of [...live]) remove(dir);
}

function create(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  live.add(dir);
  return dir;
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
  } catch (e) {
    throw new Error(
      `tempDir("${prefix}") must be called inside a test or a beforeEach; for a dir shared by a file or describe, use tempDirForAll at that scope`,
      { cause: e },
    );
  }
  const dir = create(prefix);
  made.push(dir);
  return dir;
}

/**
 * A directory shared by every test in the enclosing file or `describe`: created before its first
 * test, removed after its last. Call it at file or `describe` scope; read the path through the
 * returned function, from a hook or test. A skipped describe never creates it.
 *
 * vitest runs `afterAll` hooks last-registered-first and stops at the first that throws: keep the
 * scope's own `afterAll` hooks from throwing. bun runs them first-registered-first: call this after
 * the hooks that stop anything using the dir. (A dir a hook missed goes in the bun preload sweep.)
 */
export function tempDirForAll(prefix: string): () => string {
  let dir: string | undefined;
  beforeAll(() => {
    dir = create(prefix);
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
