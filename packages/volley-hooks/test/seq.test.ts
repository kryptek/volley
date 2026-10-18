import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nextSeq, releaseLock, tryLock } from "../src/lib/seq";

const tmp = () => mkdtempSync(join(tmpdir(), "volley-hooks-seq-"));

describe("seq counter", () => {
  it("is monotonic and persisted", async () => {
    const dir = tmp();
    expect(await nextSeq(dir)).toBe(1);
    expect(await nextSeq(dir)).toBe(2);
    expect(readFileSync(join(dir, "seq"), "utf-8").trim()).toBe("2");
  });

  it("hands out unique values under concurrency", async () => {
    const dir = tmp();
    const seqs = await Promise.all(Array.from({ length: 20 }, () => nextSeq(dir)));
    expect(new Set(seqs).size).toBe(20);
    expect(Math.max(...seqs)).toBe(20);
  });
});

describe("lock files", () => {
  it("only one holder at a time", () => {
    const path = join(tmp(), "drain.lock");
    expect(tryLock(path, 5000)).toBe(true);
    expect(tryLock(path, 5000)).toBe(false);
    releaseLock(path);
    expect(existsSync(path)).toBe(false);
    expect(tryLock(path, 5000)).toBe(true);
  });

  it("breaks a stale lock", () => {
    const path = join(tmp(), "drain.lock");
    writeFileSync(path, "123");
    const old = new Date(Date.now() - 10_000);
    utimesSync(path, old, old);
    expect(tryLock(path, 5000)).toBe(true);
  });
});
