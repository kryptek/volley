import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AgentProbe,
  type LockInfo,
  acquireLock,
  lockPath,
  lockVerdict,
  readLock,
} from "../src/locks";
import { SpawnError } from "../src/spawn-error";

const MIN = 60_000;
const DEAD_PID = 2 ** 22 + 12345; // above any default pid_max

function info(over: Partial<LockInfo> = {}): LockInfo {
  return {
    wave: "w1",
    task: "T1",
    role: "implementer",
    attempt: 1,
    agent_id: "w1-t1-implementer-1",
    pid: process.pid,
    at: new Date().toISOString(),
    ...over,
  };
}

function probe(status: string | null, registered = false, lastHeartbeat: number | null = null) {
  return {
    status: async () => status,
    registered: async () => registered,
    lastHeartbeat: () => lastHeartbeat,
  } satisfies AgentProbe;
}

describe("lockPath", () => {
  it("is $VOLLEYD_HOME/locks/<hash of the worktree path>.lock, stable per path", () => {
    const a = lockPath("/h", "/wt/w1/T1-implementer");
    expect(a).toMatch(/^\/h\/locks\/[0-9a-f]{16}\.lock$/);
    expect(lockPath("/h", "/wt/w1/T1-implementer")).toBe(a);
    expect(lockPath("/h", "/wt/w1/T2-implementer")).not.toBe(a);
  });
});

describe("lockVerdict", () => {
  const now = Date.parse("2026-10-18T12:00:00Z");
  const old = new Date(now - 11 * MIN).toISOString();
  const base = { now, staleAfterMs: 10 * MIN, pidAlive: false };

  it("a live (non-terminal) agent status holds the lock", () => {
    for (const s of ["spawning", "registered", "working", "blocked"]) {
      expect(lockVerdict(info({ at: old }), { ...base, status: s, registered: true })).toBe("live");
    }
  });

  it("a terminal status frees it", () => {
    for (const s of ["done", "failed", "reaped"]) {
      expect(lockVerdict(info(), { ...base, status: s, registered: true })).toBe("stale");
    }
  });

  it("dead pid + no registry entry + no heartbeat for > 10 min is stale", () => {
    const facts = { ...base, status: null, registered: false, lastHeartbeat: null };
    expect(lockVerdict(info({ at: old, pid: DEAD_PID }), facts)).toBe("stale");
  });

  it("is live while any of those does not hold", () => {
    const facts = { ...base, status: null, registered: false, lastHeartbeat: null };
    // fresh lock (a spawn in progress)
    expect(lockVerdict(info({ pid: DEAD_PID }), facts)).toBe("live");
    // a registry entry exists
    expect(lockVerdict(info({ at: old, pid: DEAD_PID }), { ...facts, registered: true })).toBe(
      "live",
    );
    // a recent heartbeat
    expect(
      lockVerdict(info({ at: old, pid: DEAD_PID }), { ...facts, lastHeartbeat: now - MIN }),
    ).toBe("live");
    // the writer is another live process (mid-spawn)
    expect(lockVerdict(info({ at: old, pid: 1 }), { ...facts, pidAlive: true })).toBe("live");
  });
});

describe("acquireLock", () => {
  let home: string;
  const wt = "/wt/w1/T1-implementer";
  const opts = { staleAfterMs: 10 * MIN };
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "volleyd-locks-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("creates the lock exclusively with {wave, task, role, attempt, pid, at}", async () => {
    const lock = await acquireLock(lockPath(home, wt), info(), probe(null), opts);
    const onDisk = JSON.parse(readFileSync(lock.path, "utf-8"));
    expect(onDisk).toMatchObject({ wave: "w1", task: "T1", role: "implementer", attempt: 1 });
    expect(onDisk.pid).toBe(process.pid);
    expect(typeof onDisk.at).toBe("string");
  });

  it("a second spawn for the same worktree while the first agent is working → SPAWN_LOCKED", async () => {
    const path = lockPath(home, wt);
    await acquireLock(path, info(), probe(null), opts);
    const err = await acquireLock(path, info({ attempt: 2 }), probe("working", true), opts).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SpawnError);
    expect((err as SpawnError).code).toBe("SPAWN_LOCKED");
    expect((err as SpawnError).detail).toMatchObject({
      holder: { agent_id: "w1-t1-implementer-1" },
    });
    expect(readLock(path)?.attempt).toBe(1);
  });

  it("after the agent is done the lock is reclaimable", async () => {
    const path = lockPath(home, wt);
    await acquireLock(path, info(), probe(null), opts);
    const lock = await acquireLock(path, info({ attempt: 2 }), probe("done", true), opts);
    expect(readLock(path)?.attempt).toBe(2);
    lock.release();
    expect(existsSync(path)).toBe(false);
  });

  it("a stale lock (dead pid, no registry, quiet > 10 min) is reclaimed", async () => {
    const path = lockPath(home, wt);
    await acquireLock(path, info(), probe(null), opts);
    const old = new Date(Date.now() - 11 * MIN).toISOString();
    writeFileSync(path, JSON.stringify(info({ pid: DEAD_PID, at: old })));
    const lock = await acquireLock(path, info({ attempt: 2 }), probe(null), opts);
    expect(lock.info.attempt).toBe(2);
  });

  it("update() rewrites the holder (a relaunch keeps the same lock)", async () => {
    const path = lockPath(home, wt);
    const lock = await acquireLock(path, info(), probe(null), opts);
    lock.update({ attempt: 2, agent_id: "w1-t1-implementer-2" });
    expect(readLock(path)).toMatchObject({ attempt: 2, agent_id: "w1-t1-implementer-2" });
  });

  it("release() only removes a lock it still holds", async () => {
    const path = lockPath(home, wt);
    const lock = await acquireLock(path, info(), probe(null), opts);
    writeFileSync(path, JSON.stringify(info({ attempt: 9, agent_id: "someone-else" })));
    lock.release();
    expect(existsSync(path)).toBe(true);
  });
});
