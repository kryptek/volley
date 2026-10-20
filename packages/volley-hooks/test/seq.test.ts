import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { breakStaleLock, drainLockStaleMs, nextSeq, releaseLock, tryLock } from "../src/lib/seq";

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
    const token = tryLock(path, 5000);
    expect(token).not.toBeNull();
    expect(tryLock(path, 5000)).toBeNull();
    releaseLock(path, token as string);
    expect(existsSync(path)).toBe(false);
    expect(tryLock(path, 5000)).not.toBeNull();
  });

  it("breaks a stale lock", () => {
    const path = join(tmp(), "drain.lock");
    writeFileSync(path, "123");
    const old = new Date(Date.now() - 10_000);
    utimesSync(path, old, old);
    expect(tryLock(path, 5000)).not.toBeNull();
  });

  it("release only removes the caller's own lock", () => {
    const path = join(tmp(), "drain.lock");
    const mine = tryLock(path, 5000) as string;
    // Our lock was judged stale and broken; another hook now holds a fresh one.
    unlinkSync(path);
    const theirs = tryLock(path, 5000) as string;
    releaseLock(path, mine);
    expect(readFileSync(path, "utf-8")).toBe(theirs);
  });

  it("breaking a stale lock never removes a fresh one taken in the meantime", () => {
    const path = join(tmp(), "drain.lock");
    // Two hooks judged the same stale lock ("old"); one already broke it and re-took it.
    const fresh = tryLock(path, 5000) as string;
    expect(breakStaleLock(path, "old")).toBe(false);
    expect(readFileSync(path, "utf-8")).toBe(fresh);
    expect(readdirSync(dirname(path))).toEqual(["drain.lock"]);
  });

  it("the drain lock outlives the longest a hook can hold it", () => {
    expect(drainLockStaleMs({})).toBeGreaterThan(10_000);
    expect(drainLockStaleMs({ VOLLEY_HOOKS_TIMEOUT_MS: "30000" })).toBeGreaterThan(30_000);
  });
});
