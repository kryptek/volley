/**
 * Each machine's recent readings for the Machines window's sparklines (pure): a ring per machine
 * built from the retained records the Desk already receives (`volley/_system/machines/<name>`,
 * SPEC §4.6.14, every 30 s), oldest first. A reading's time is the record's `last_seen` (the
 * machine's clock), which also dedupes it: a QoS 1 redelivery or a reconnect's retained copy
 * adds nothing. A down record carries the LWT's stale values, so only up and local ones append.
 */
import type { MachinePayload } from "./types";

export interface MachineSample {
  /** `Date.parse(last_seen)`: the machine's clock. */
  at: number;
  /** The 1-minute load average per core, as a % (100 = one runnable task per core). */
  load: number | null;
  /** Memory used, %; null for a record without `memory` (a macOS peer before its doctor run). */
  mem: number | null;
}

/** The window the sparklines show. */
export const HISTORY_MS = 600_000;
/** 20 heartbeats in 10 minutes, plus the extra beats a doctor run sends. */
export const HISTORY_MAX = 24;

/** The reading a record carries, or null for a down record or an unreadable time. */
export function sampleOf(record: MachinePayload): MachineSample | null {
  const at = Date.parse(record.last_seen);
  if (record.tunnel === "down" || Number.isNaN(at)) return null;
  const load1 = record.load[0];
  return {
    at,
    load: load1 !== undefined && record.cores > 0 ? (load1 / record.cores) * 100 : null,
    mem: record.memory ? 100 - record.memory.available_pct : null,
  };
}

/** `history` with `record`'s reading appended (when it has one and its time is new). */
export function pushRecord(
  history: readonly MachineSample[] | undefined,
  record: MachinePayload,
): MachineSample[] {
  const s = sampleOf(record);
  return mergeSamples(history ?? [], s ? [s] : []);
}

/** Both series as one ring: deduplicated by time, oldest first, the last 10 minutes, capped. */
export function mergeSamples(
  history: readonly MachineSample[],
  samples: readonly MachineSample[],
): MachineSample[] {
  const byAt = new Map<number, MachineSample>();
  for (const s of history) byAt.set(s.at, s);
  for (const s of samples) if (!byAt.has(s.at)) byAt.set(s.at, s);
  const all = [...byAt.values()].sort((a, b) => a.at - b.at);
  const newest = all[all.length - 1]?.at ?? 0;
  return all.filter((s) => newest - s.at <= HISTORY_MS).slice(-HISTORY_MAX);
}
