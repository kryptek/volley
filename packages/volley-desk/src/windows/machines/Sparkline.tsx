/**
 * A Machines-window sparkline: one series (load per core, or memory used) over the fixed
 * 10-minute window ending at `now`, as a plain SVG polyline (no React Bits component). x is time,
 * so a fresh Desk's line grows in from the right; y is 0–100 % (load per core clamped at 100 %).
 * One sample is a dot; a down machine is a flat grey baseline, never its stale points. The line's
 * state class (`spark--warn` ≥ 70, `spark--bad` ≥ 90) follows the latest reading. Decorative
 * (`aria-hidden`): the row's summary says the numbers and the state in words.
 */
import { HISTORY_MS } from "../../store/machineHistory";

export type SparkLevel = "ok" | "warn" | "bad";

const WARN_AT = 70;
const BAD_AT = 90;
/** The viewBox height; y keeps 1 unit clear of each edge so the stroke is not clipped. */
const H = 24;

export interface SparkSample {
  at: number;
  /** The reading, %; null when the record had none. */
  value: number | null;
}

/** A reading's level: amber at or above 70 %, red at or above 90 %. */
export function sparkLevel(v: number | null): SparkLevel {
  if (v === null) return "ok";
  return v >= BAD_AT ? "bad" : v >= WARN_AT ? "warn" : "ok";
}

/** The samples inside the window, as viewBox points (x 0–100 by time, y 0 at the top). */
export function sparkPoints(
  samples: readonly SparkSample[],
  now: number,
  windowMs = HISTORY_MS,
): { x: number; y: number }[] {
  const start = now - windowMs;
  return samples.flatMap((s) => {
    if (s.value === null || s.at < start) return [];
    const x = Math.min(100, ((s.at - start) / windowMs) * 100);
    const v = Math.max(0, Math.min(100, s.value));
    return [{ x, y: H - 1 - (v / 100) * (H - 2) }];
  });
}

/** The latest reading that has a value. */
export function latest(samples: readonly SparkSample[]): number | null {
  for (let i = samples.length - 1; i >= 0; i--) {
    const v = samples[i]?.value;
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

export function Sparkline({
  kind,
  samples,
  now,
  down = false,
}: {
  kind: "load" | "mem";
  samples: readonly SparkSample[];
  now: number;
  down?: boolean;
}) {
  const level = down ? "down" : sparkLevel(latest(samples));
  const pts = down ? [] : sparkPoints(samples, now);
  const last = pts[pts.length - 1];
  return (
    <svg
      className={`spark spark--${kind}${level === "ok" ? "" : ` spark--${level}`}`}
      viewBox={`0 0 100 ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {down ? (
        <line
          className="spark-base"
          x1={0}
          x2={100}
          y1={H - 1}
          y2={H - 1}
          vectorEffect="non-scaling-stroke"
        />
      ) : pts.length >= 2 ? (
        <polyline
          fill="none"
          points={pts.map((p) => `${round(p.x)},${round(p.y)}`).join(" ")}
          vectorEffect="non-scaling-stroke"
        />
      ) : last ? (
        <circle cx={round(last.x)} cy={round(last.y)} r={1.5} />
      ) : null}
    </svg>
  );
}

const round = (n: number) => Math.round(n * 100) / 100;
