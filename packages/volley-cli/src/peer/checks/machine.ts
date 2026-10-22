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

/** `available`: macOS's `vmStatAvailablePct`; otherwise `free` (Linux: MemAvailable) over `total`. */
export function memoryOf(total: number, free: number, available: number | null = null): Memory {
  return {
    total_mb: Math.max(1, Math.round(total / 1024 ** 2)),
    available_pct: available !== null ? pct(available) : pct(total > 0 ? (free / total) * 100 : 0),
  };
}

/**
 * macOS: the available-memory percentage from `vm_stat` (SPEC §4.6.15): free, inactive,
 * speculative and purgeable pages (what the kernel can hand out without paging anything active
 * out), times the page size, over the machine's total memory. Free pages alone under-count: a
 * healthy Mac keeps them in single digits. Linux's figure is the kernel's MemAvailable
 * (`os.freemem()`), the same notion. null: not `vm_stat` output.
 */
export function vmStatAvailablePct(out: string, totalBytes: number): number | null {
  const size = /page size of (\d+) bytes/.exec(out);
  if (size === null || totalBytes <= 0) return null;
  const pages = (label: string) => {
    const m = new RegExp(`^Pages ${label}:\\s+(\\d+)\\.?\\s*$`, "m").exec(out);
    return m !== null ? Number(m[1]) : null;
  };
  const free = pages("free");
  if (free === null) return null;
  const counted = ["inactive", "speculative", "purgeable"].reduce(
    (n, l) => n + (pages(l) ?? 0),
    free,
  );
  return pct((counted * Number(size[1]) * 100) / totalBytes);
}

/** Cores per supervised agent, and memory (MB) per agent, a paired machine is sized by. */
const CORES_PER_AGENT = 3;
const MB_PER_AGENT = 4096;
/** The bounds of a derived `max_agents`. */
const AGENTS_MIN = 2;
const AGENTS_MAX = 16;

/**
 * A paired machine's `hosts.<name>.max_agents` from its size (SPEC §4.6.15):
 * `clamp(min(floor(cores / 3), floor(memory_total_mb / 4096)), 2, 16)` — a 32-core / 60 GB box
 * gets 10, a 10-core / 32 GB laptop 3. null when either figure is unknown (volleyd then uses 4).
 */
export function derivedMaxAgents(
  cores: number | undefined,
  memoryTotalMb: number | undefined,
): number | null {
  if (cores === undefined || memoryTotalMb === undefined) return null;
  if (!(cores > 0) || !(memoryTotalMb > 0)) return null;
  const n = Math.min(Math.floor(cores / CORES_PER_AGENT), Math.floor(memoryTotalMb / MB_PER_AGENT));
  return Math.min(AGENTS_MAX, Math.max(AGENTS_MIN, n));
}

/** `max_agents 10 (derived from 32 cores, 60 GB)`; null when the size is unknown. */
export function derivedLine(cores: number, memoryTotalMb: number): string | null {
  const n = derivedMaxAgents(cores, memoryTotalMb);
  return n === null
    ? null
    : `max_agents ${n} (derived from ${cores} cores, ${Math.round(memoryTotalMb / 1024)} GB)`;
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
  // What volleyd sizes this machine at when it pairs (an explicit hosts.<name>.max_agents wins).
  const size = derivedLine(m.cores, m.memory.total_mb);
  if (size !== null) checks.push({ id: "machine.size", ok: true, severity: "warn", detail: size });
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
