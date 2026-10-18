import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** A lock file older than this is treated as abandoned by a crashed hook. */
export const LOCK_STALE_MS = 5000;

/**
 * Create `path` exclusively (O_EXCL). Returns false while another process holds it; a lock
 * whose mtime is older than `staleMs` is broken and re-taken.
 */
export function tryLock(path: string, staleMs = LOCK_STALE_MS): boolean {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let age: number;
      try {
        age = Date.now() - statSync(path).mtimeMs;
      } catch {
        continue; // released between our open and stat: try again
      }
      if (age <= staleMs) return false;
      try {
        unlinkSync(path);
      } catch {
        // another process broke it first
      }
    }
  }
  return false;
}

export function releaseLock(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

/** Run `fn` holding `path`, waiting (polling) up to `waitMs` for it. */
async function withLock<T>(path: string, fn: () => T, waitMs = 2000): Promise<T> {
  const deadline = Date.now() + waitMs;
  while (!tryLock(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 5 + Math.random() * 10));
  }
  try {
    return fn();
  } finally {
    releaseLock(path);
  }
}

/** Write `data` to `path` atomically: temp file, fsync, rename. */
export function writeFileAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/**
 * The next per-agent hook sequence number (SPEC §4.3 `payload.seq`): a counter in
 * `<stateDir>/seq`, incremented under `seq.lock` so concurrent hooks never share a value.
 */
export function nextSeq(stateDir: string): Promise<number> {
  const counter = join(stateDir, "seq");
  return withLock(join(stateDir, "seq.lock"), () => {
    let current = 0;
    try {
      const n = Number.parseInt(readFileSync(counter, "utf-8").trim(), 10);
      if (Number.isSafeInteger(n) && n >= 0) current = n;
    } catch {
      // first use
    }
    const next = current + 1;
    writeFileAtomic(counter, `${next}\n`);
    return next;
  });
}
