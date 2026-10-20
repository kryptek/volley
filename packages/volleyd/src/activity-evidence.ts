import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Evidence that an idle agent is waiting on its own work, not on a person (liveness.ts): an agent
 * that ended its turn while a background shell runs is woken by the harness when the shell exits,
 * so a "continue" nudge or an `agent_stalled` decision only interrupts it. Pure, except
 * `newestWrite` (a bounded read-only walk of the worktree).
 */
export interface ActivityEvidence {
  /** The hooks' own claim: the last idle/idle_prompt carried background_wait. */
  background_wait: { since: number } | null;
  /** The agent holds (or waits on) a heavy-op lease. */
  lease_held: boolean;
  /** The pool of that lease, for the reason text. */
  lease_pool?: string;
  /** The terminal footer says N shells are still running (null: footer not readable). */
  shells_running: number | null;
  /** Newest mtime under the worktree (excluding .git and .volley); null: unknown / remote. */
  worktree_write_at: number | null;
}

export const NO_EVIDENCE: ActivityEvidence = {
  background_wait: null,
  lease_held: false,
  shells_running: null,
  worktree_write_at: null,
};

const secondsMs = (s: number) => s * 1000;

export interface EvidenceTunables {
  idle_grace_s: number;
  background_wait_max_s: number;
}

/**
 * Why the idle agent is busy with its own work, or null when nothing says it is. `idleSince` is
 * when the idle began: past `background_wait_max_s` of it no evidence counts, so a background task
 * that never exits (a dev server, a hung watch, a lease never granted) still ends in a nudge.
 */
export function ownWorkReason(
  e: ActivityEvidence,
  now: number,
  t: EvidenceTunables,
  idleSince?: number,
): string | null {
  if (idleSince !== undefined && now - idleSince >= secondsMs(t.background_wait_max_s)) return null;
  if (
    e.background_wait !== null &&
    now - e.background_wait.since < secondsMs(t.background_wait_max_s)
  )
    return "waiting on its own background task";
  if (e.lease_held)
    return e.lease_pool !== undefined ? `holds lease ${e.lease_pool}` : "holds a lease";
  const n = e.shells_running;
  if (n !== null && n > 0) return `${n} shell${n === 1 ? "" : "s"} still running`;
  const w = e.worktree_write_at;
  if (w !== null && now - w < secondsMs(t.idle_grace_s))
    return `worktree written ${Math.max(0, Math.floor((now - w) / 1000))} s ago`;
  return null;
}

/** Directories never walked: git's own, volley's, and dependency / build output trees. */
const SKIP = new Set([".git", ".volley", "node_modules", "target", "build"]);

/**
 * The newest file mtime under `root`, breadth first, so the shallow files (logs, reports) are
 * seen first. Returns at the first file written within `freshMs` of `now`; null when more than
 * `maxEntries` entries would be visited, or the tree cannot be read (vanished). Never throws.
 */
export async function newestWrite(
  root: string,
  o: { now: number; freshMs: number; maxEntries: number },
): Promise<number | null> {
  let newest: number | null = null;
  let seen = 0;
  const dirs = [root];
  try {
    for (let dir = dirs.shift(); dir !== undefined; dir = dirs.shift()) {
      const entries = await readdir(dir, { withFileTypes: true });
      seen += entries.length;
      if (seen > o.maxEntries) return null;
      for (const ent of entries) {
        const p = join(dir, ent.name);
        if (ent.isDirectory()) {
          if (!SKIP.has(ent.name)) dirs.push(p);
          continue;
        }
        if (!ent.isFile()) continue;
        const m = await stat(p).then(
          (s) => s.mtimeMs,
          () => null, // removed mid-walk
        );
        if (m === null) continue;
        if (o.now - m < o.freshMs) return m;
        if (newest === null || m > newest) newest = m;
      }
    }
  } catch {
    return null;
  }
  return newest;
}
