import type { Sample } from "../admission";
import { DAEMON_DEFAULTS } from "../config-defaults";
import type { ExecFn } from "../exec";
import { bounded, runSampler } from "./run";

/** macOS kernel memory-pressure level: 1 normal, 2 warn, 4 critical. Read-only (fenced exactly). */
export const SYSCTL_ARGV = ["sysctl", "-n", "kern.memorystatus_vm_pressure_level"] as const;
/** Fallback: with no arguments `memory_pressure` only reports (fenced exactly: no options). */
export const MEMORY_PRESSURE_ARGV = ["memory_pressure"] as const;

/** `4` (sysctl -n) or `kern.memorystatus_vm_pressure_level: 4`. */
export function parseSysctlPressure(out: string): Sample {
  const m = /^(?:kern\.memorystatus_vm_pressure_level:\s*)?([0-9]+)\s*$/.exec(out.trim());
  const level = m?.[1] !== undefined ? Number.parseInt(m[1], 10) : Number.NaN;
  return Number.isInteger(level) && level >= 1
    ? { ok: true, value: level, raw: bounded(out) }
    : { ok: false, raw: bounded(out), error: "no memory pressure level in sysctl output" };
}

/** `System-wide memory free percentage: 6%` → a level, using the fallback heuristic thresholds. */
export function parseMemoryPressure(out: string): Sample {
  const m = /memory free percentage:\s*([0-9]+)%/i.exec(out);
  if (m?.[1] === undefined) {
    return { ok: false, raw: bounded(out), error: "no free percentage in memory_pressure output" };
  }
  const free = Number.parseInt(m[1], 10);
  const level =
    free <= DAEMON_DEFAULTS.memory_free_critical_pct
      ? 4
      : free <= DAEMON_DEFAULTS.memory_free_warn_pct
        ? 2
        : 1;
  return { ok: true, value: level, raw: bounded(m[0]) };
}

/** The OS memory-pressure level: sysctl, else memory_pressure, else unknown. */
export async function sampleMemory(exec: ExecFn, timeoutMs: number): Promise<Sample> {
  const first = await runSampler(exec, SYSCTL_ARGV, { timeoutMs }, parseSysctlPressure);
  if (first.ok) return first;
  const second = await runSampler(exec, MEMORY_PRESSURE_ARGV, { timeoutMs }, parseMemoryPressure);
  return second.ok ? second : { ...second, error: `${first.error}; ${second.error}` };
}
