import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir, tempDirForAll } from "./helpers/tmp";

// The tests in each describe run in order: a later test checks what an earlier one left behind.

// vitest's `it.fails`, bun's `test.failing` (volleyd's suite also runs under `bun test`).
const failing: (name: string, fn: () => void) => void =
  // biome-ignore lint/suspicious/noExplicitAny: the name differs between the two runners.
  (it as any).fails ?? (it as any).failing;

describe("tempDir", () => {
  let seen = "";
  let fromBeforeEach = "";
  let previousFromBeforeEach = "";
  let existedInAfterEach = false;
  beforeEach(() => {
    previousFromBeforeEach = fromBeforeEach;
    fromBeforeEach = tempDir("vly-tmp-test-each-");
  });
  // Like a daemon's teardown: the test's dir must still be there while an afterEach runs.
  afterEach(() => {
    existedInAfterEach = seen !== "" && existsSync(seen);
  });

  it("is a fresh, writable directory during the test", () => {
    seen = tempDir("vly-tmp-test-");
    expect(existsSync(seen)).toBe(true);
    writeFileSync(join(seen, "file"), "x");
    expect(existsSync(fromBeforeEach)).toBe(true);
  });

  it("is gone, contents and all, in the next test, after the afterEach hooks ran", () => {
    expect(seen).not.toBe("");
    expect(existedInAfterEach).toBe(true);
    expect(existsSync(seen)).toBe(false);
    // The beforeEach one too.
    expect(previousFromBeforeEach).not.toBe("");
    expect(existsSync(previousFromBeforeEach)).toBe(false);
  });

  failing("is removed when its test throws", () => {
    seen = tempDir("vly-tmp-test-");
    throw new Error("boom");
  });

  it("…even then", () => {
    expect(existsSync(seen)).toBe(false);
  });
});

let shared = "";
describe("tempDirForAll", () => {
  const dir = tempDirForAll("vly-tmp-test-all-");

  it("exists for the first test", () => {
    shared = dir();
    expect(existsSync(shared)).toBe(true);
    writeFileSync(join(shared, "file"), "x");
  });

  it("is the same directory, contents kept, in a later test", () => {
    expect(dir()).toBe(shared);
    expect(existsSync(join(shared, "file"))).toBe(true);
  });
});

describe("after the tempDirForAll scope ends", () => {
  it("its directory is gone", () => {
    expect(shared).not.toBe("");
    expect(existsSync(shared)).toBe(false);
  });
});

let collected = "";
try {
  tempDir("vly-tmp-test-");
} catch (e) {
  collected = (e as Error).message;
}

describe("tempDir at file scope", () => {
  it("throws, pointing at tempDirForAll", () => {
    expect(collected).toContain("tempDirForAll");
  });
});
