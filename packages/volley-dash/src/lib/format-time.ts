/**
 * Format a ms-epoch timestamp as `HH:MM:SS` in the local timezone.
 * Used by the live feed timestamp column. Tabular-nums in the consumer
 * keeps the column from jittering.
 */
export function fmtTimeOfDay(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
