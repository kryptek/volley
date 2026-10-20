import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** A lock file older than this is treated as abandoned by a crashed hook (`seq.lock`). */
export const LOCK_STALE_MS = 5000;

/** How long Claude waits on one hook before `runHook`'s deadline exits it. */
export function hookTimeoutMs(env: Record<string, string | undefined>): number {
  const ms = Number(env.VOLLEY_HOOKS_TIMEOUT_MS ?? 10_000);
  return ms > 0 ? ms : 10_000;
}

/**
 * `drain.lock` is held for a whole drain (connects, drain, acks, heartbeat), which the hook
 * deadline bounds; it only counts as stale once its holder must be dead.
 */
export function drainLockStaleMs(env: Record<string, string | undefined>): number {
  return hookTimeoutMs(env) + 5000;
}

/**
 * Create `path` exclusively (O_EXCL) holding a fresh token, and return the token (pass it to
 * `releaseLock`). Returns null while another process holds it; a lock whose mtime is older
 * than `staleMs` is broken and re-taken.
 */
export function tryLock(path: string, staleMs = LOCK_STALE_MS): string | null {
  mkdirSync(dirname(path), { recursive: true });
  const token = `${process.pid}.${randomUUID()}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, token);
      closeSync(fd);
      return token;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let held: string;
      let age: number;
      try {
        held = readFileSync(path, "utf-8");
        age = Date.now() - statSync(path).mtimeMs;
      } catch {
        continue; // released between our open and read: try again
      }
      if (age <= staleMs) return null;
      breakStaleLock(path, held);
    }
  }
  return null;
}

/**
 * Remove the lock at `path` only if it still holds `judged` (the content seen when it was
 * judged stale). The file is moved aside atomically first, so a hook that broke the same
 * stale lock and re-took it a moment earlier keeps its fresh lock: it is put back.
 */
export function breakStaleLock(path: string, judged: string): boolean {
  const aside = `${path}.${process.pid}.${randomUUID()}.stale`;
  try {
    renameSync(path, aside);
  } catch {
    return false; // another process broke it first
  }
  let moved: string | null = null;
  try {
    moved = readFileSync(aside, "utf-8");
  } catch {
    // unreadable: treat as someone else's
  }
  const ours = moved === judged;
  if (!ours) {
    try {
      linkSync(aside, path); // no-clobber restore of the fresh lock
    } catch {
      // the path was re-taken meanwhile; leave the newer lock in place
    }
  }
  try {
    unlinkSync(aside);
  } catch {
    // already gone
  }
  return ours;
}

/** Remove `path` if it is still the lock `token` took (a broken-and-re-taken lock is left). */
export function releaseLock(path: string, token: string): void {
  try {
    if (readFileSync(path, "utf-8") === token) unlinkSync(path);
  } catch {
    // already gone
  }
}

/** Run `fn` holding `path`, waiting (polling) up to `waitMs` for it. */
export async function withLock<T>(path: string, fn: () => T, waitMs = 2000): Promise<T> {
  const deadline = Date.now() + waitMs;
  let token = tryLock(path);
  while (token === null) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 5 + Math.random() * 10));
    token = tryLock(path);
  }
  try {
    return fn();
  } finally {
    releaseLock(path, token);
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
