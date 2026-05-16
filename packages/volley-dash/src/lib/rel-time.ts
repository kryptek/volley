/**
 * Ported verbatim from the design handoff (`volley-data.jsx`).
 * Format: `now` (<5s), `Ns ago`, `Nm ago`, `Nh ago`, `Nd ago`.
 *
 * Negative deltas (future timestamps) are clamped to 0 so clock skew renders
 * as `now` rather than negative noise.
 */
export function relTime(ts: number, now: number = Date.now()): string {
  const d = Math.max(0, Math.floor((now - ts) / 1000));
  if (d < 5) return "now";
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}
