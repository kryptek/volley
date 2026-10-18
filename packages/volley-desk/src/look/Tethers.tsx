/**
 * Tethers, ported from the prototype `App.tsx`: a dashed SVG cubic from the
 * right edge of each wave window (120 px down) to the left edge of each of
 * its agent windows (26 px down, the title bar), stroked in the wave accent.
 * Rendered inside the world, so the paths pan and zoom with the windows; off
 * when the look's `tethers` is off.
 */
type Pos = { x: number; y: number };

export interface Tether {
  /** The agent id. */
  id: string;
  /** The wave window's top-left and width. */
  wave: Pos & { w: number };
  /** The agent window's top-left. */
  agent: Pos;
  accent: string;
}

export const TETHER_WAVE_DY = 120;
export const TETHER_AGENT_DY = 26;

export function tetherPath(t: Tether): string {
  const x1 = t.wave.x + t.wave.w;
  const y1 = t.wave.y + TETHER_WAVE_DY;
  const x2 = t.agent.x;
  const y2 = t.agent.y + TETHER_AGENT_DY;
  const mx = (x1 + x2) / 2;
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
}

export function Tethers({ on, tethers }: { on: boolean; tethers: readonly Tether[] }) {
  if (!on) return null;
  return (
    <svg className="tethers" width="6000" height="4000" aria-hidden="true">
      {tethers.map((t) => (
        <path key={t.id} d={tetherPath(t)} stroke={t.accent} className="tether" data-agent={t.id} />
      ))}
    </svg>
  );
}
