import { dirname, join } from "node:path";
import type { Check, Disk, Facts, Memory, StatFs } from "../doctor";

/**
 * The machine itself: memory and the disk that holds its agent worktrees. Pure arithmetic over
 * numbers the shell gathers, shared by the doctor and every heartbeat (which runs no command).
 */

/** volleyd's default worktree root beside a remote repo (its REMOTE_HOST_DEFAULTS.worktree_dir). */
export const WORKTREE_DIR = ".volley-worktrees";

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;
const pct = (n: number) => Math.min(100, Math.max(0, round(n, 1)));

/** Where this machine's worktrees go: beside the repo, else the home directory. */
export const worktreeRoot = (repo: string | null, home: string) =>
  repo !== null ? join(dirname(repo), WORKTREE_DIR) : home;

export function memoryOf(total: number, free: number, pressurePct: number | null = null): Memory {
  return {
    total_mb: Math.max(1, Math.round(total / 1024 ** 2)),
    available_pct:
      pressurePct !== null ? pct(pressurePct) : pct(total > 0 ? (free / total) * 100 : 0),
  };
}

/** macOS: `memory_pressure`'s "System-wide memory free percentage: 63%" (free + reclaimable). */
export function pressurePct(out: string): number | null {
  const m = /memory free percentage:\s*(\d{1,3})%/i.exec(out);
  return m !== null ? Number(m[1]) : null;
}

export function diskOf(path: string, st: StatFs): Disk {
  return {
    path,
    free_gb: Math.max(0, round((st.bavail * st.bsize) / 1024 ** 3, 2)),
    free_pct: pct(st.blocks > 0 ? (st.bavail / st.blocks) * 100 : 0),
  };
}

export function machineChecks(f: Facts): Check[] {
  const m = f.machine;
  const checks: Check[] = [
    m.memory.available_pct >= m.limits.mem_low_pct
      ? {
          id: "machine.memory",
          ok: true,
          severity: "warn",
          detail: `${m.memory.available_pct}% of ${m.memory.total_mb} MB memory available`,
        }
      : {
          id: "machine.memory",
          ok: false,
          severity: "warn",
          detail: `only ${m.memory.available_pct}% of ${m.memory.total_mb} MB memory available`,
          fix: {
            command: "close what you do not need on this machine; placement avoids it meanwhile",
          },
        },
  ];
  if (m.disk === null) {
    checks.push({
      id: "machine.disk",
      ok: false,
      severity: "warn",
      detail: "could not read the free space where worktrees go",
    });
  } else if (m.disk.free_gb >= m.limits.disk_low_gb) {
    checks.push({
      id: "machine.disk",
      ok: true,
      severity: "warn",
      detail: `${m.disk.free_gb} GB (${m.disk.free_pct}%) free at ${m.disk.path}`.slice(0, 200),
    });
  } else {
    checks.push({
      id: "machine.disk",
      ok: false,
      severity: "warn",
      detail: `only ${m.disk.free_gb} GB free at ${m.disk.path}`.slice(0, 200),
      fix: { command: `free space on the disk that holds ${m.disk.path}` },
    });
  }
  return checks;
}
