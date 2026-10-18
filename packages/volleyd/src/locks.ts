import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SpawnError } from "./spawn-error";

/**
 * Per-worktree spawn lock: `$VOLLEYD_HOME/locks/<worktree-path-hash>.lock`, created O_EXCL with
 * the holder `{ wave, task, role, attempt, agent_id, pid, at }`. One agent per worktree: a second
 * spawn into a worktree whose agent is still live is refused with SPAWN_LOCKED — the guard
 * against duplicate launches when a launcher retries after a timeout.
 */

export interface LockInfo {
  wave: string;
  task: string;
  role: string;
  attempt: number;
  agent_id: string;
  /** The process that wrote the lock (the daemon). */
  pid: number;
  at: string;
}

/** What the daemon knows about the holder's agent. */
export interface AgentProbe {
  /** The agent's retained status type, or null when it has none. */
  status(agentId: string): Promise<string | null>;
  /** Whether the agent has a retained registry entry. */
  registered(agentId: string): Promise<boolean>;
  /** Last heartbeat seen from the agent (epoch ms), or null. */
  lastHeartbeat(agentId: string): number | null;
}

/** SPEC §5.1 states after which an agent is gone. */
export const TERMINAL_STATUS: ReadonlySet<string> = new Set(["done", "failed", "reaped"]);

export function lockPath(home: string, worktree: string): string {
  const hash = createHash("sha256").update(resolve(worktree)).digest("hex").slice(0, 16);
  return join(home, "locks", `${hash}.lock`);
}

export function readLock(path: string): LockInfo | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as LockInfo;
  } catch {
    return null;
  }
}

export interface LockFacts {
  status: string | null;
  registered: boolean;
  lastHeartbeat?: number | null;
  /** Whether the lock's writer pid is a live process other than this one. */
  pidAlive: boolean;
  now: number;
  /** "No heartbeat for longer than this" (the heartbeat alarm). */
  staleAfterMs: number;
}

/**
 * `stale` when the holder's agent is terminal, or when nothing shows it was ever alive: no
 * status, no registry entry, no heartbeat (nor lock write) within `staleAfterMs`, and the
 * writing process gone. Anything else is `live`.
 */
export function lockVerdict(lock: LockInfo, f: LockFacts): "live" | "stale" {
  if (f.status !== null) return TERMINAL_STATUS.has(f.status) ? "stale" : "live";
  if (f.registered || f.pidAlive) return "live";
  const at = Date.parse(lock.at);
  const last = Math.max(Number.isNaN(at) ? 0 : at, f.lastHeartbeat ?? 0);
  return f.now - last > f.staleAfterMs ? "stale" : "live";
}

function pidAliveOther(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface WorktreeLock {
  readonly path: string;
  readonly info: LockInfo;
  /** Rewrite the holder (a relaunch: new attempt and agent id under the same lock). */
  update(patch: Partial<LockInfo>): void;
  /** Remove the lock if it still names this holder. Idempotent. */
  release(): void;
}

function writeAtomic(path: string, info: LockInfo): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(info)}\n`);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/**
 * Take the lock at `path` for `info`. An existing lock is asked about through `probe`: a live
 * holder → SpawnError SPAWN_LOCKED (detail.holder); a stale one is removed and taken over.
 */
export async function acquireLock(
  path: string,
  info: LockInfo,
  probe: AgentProbe,
  opts: { staleAfterMs: number; now?: () => number },
): Promise<WorktreeLock> {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const holder = readLock(path);
      if (holder !== null && attempt === 0) {
        const verdict = lockVerdict(holder, {
          status: await probe.status(holder.agent_id),
          registered: await probe.registered(holder.agent_id),
          lastHeartbeat: probe.lastHeartbeat(holder.agent_id),
          pidAlive: pidAliveOther(holder.pid),
          now: (opts.now ?? Date.now)(),
          staleAfterMs: opts.staleAfterMs,
        });
        if (verdict === "live") {
          throw new SpawnError("SPAWN_LOCKED", `worktree is held by ${holder.agent_id}`, {
            lock: path,
            holder,
          });
        }
      } else if (holder !== null || attempt > 0) {
        // Lost a race with another spawn reclaiming the same stale lock.
        throw new SpawnError("SPAWN_LOCKED", "worktree lock is contended", {
          lock: path,
          ...(holder !== null ? { holder } : {}),
        });
      }
      // Stale (or unreadable): take it over.
      try {
        unlinkSync(path);
      } catch {}
      continue;
    }
    try {
      writeSync(fd, `${JSON.stringify(info)}\n`);
    } finally {
      closeSync(fd);
    }
    let current = info;
    return {
      path,
      get info() {
        return current;
      },
      update(patch) {
        current = { ...current, ...patch, at: new Date().toISOString() };
        writeAtomic(path, current);
      },
      release() {
        const onDisk = readLock(path);
        if (onDisk === null || onDisk.agent_id !== current.agent_id) return;
        if (existsSync(path)) {
          try {
            unlinkSync(path);
          } catch {}
        }
      },
    };
  }
  throw new SpawnError("SPAWN_LOCKED", "worktree lock is contended", { lock: path });
}
