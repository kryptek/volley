/**
 * Tethers, ported from the prototype `App.tsx` and given a 3D cable look
 * (D10): a cubic from the right edge of each wave window (120 px down) to the
 * left edge of each of its agent windows (26 px down, the title bar), hanging
 * with a slight sag, in the wave accent. Rendered inside the world, so the
 * cables pan and zoom with the windows; off when the look's `tethers` is off.
 *
 * Everything is one SVG layer with one shared blur filter, applied once to a
 * group of soft drop shadows and once to a group of accent glows; above them
 * each cable is a bright core and a thin specular highlight lifted 1 px. Each
 * time an agent publishes `progress` (`beat`) an energy pulse runs from the
 * wave window to the agent window (a short dash on a CSS `stroke-dashoffset`
 * animation, pooled by `PulsePool`, each retired by one timer at the pool's
 * `nextEnd`), and dragging a window (`dragging`: the id of the window whose
 * title bar is held) sways its cables on a damped spring; windows moved by
 * arrange or fit do not sway. One `requestAnimationFrame` loop runs only
 * while a sway is live. Under reduced motion, at phone width or with the
 * tethers off nothing moves: no pulses, no sway.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useReducedMotion } from "../a11y/motion";
import { NARROW_PX, useViewportWidth } from "../canvas/useViewport";
import { PULSE_MS, PulsePool, type Sway, kickSway, stepSway, swaySettled } from "./tetherPulses";

type Pos = { x: number; y: number };

export interface Tether {
  /** The agent id. */
  id: string;
  /** The wave window's id: dragging it sways all of its cables. */
  waveId?: string;
  /** The wave window's top-left and width. */
  wave: Pos & { w: number };
  /** The agent window's top-left. */
  agent: Pos;
  accent: string;
  /** When the agent last published `progress` (`progressBeat`); a change sends a pulse. */
  beat?: number | null;
}

export const TETHER_WAVE_DY = 120;
export const TETHER_AGENT_DY = 26;
/** Sag as a share of the cable's length, capped at `SAG_MAX` px. */
export const SAG_FACTOR = 0.06;
export const SAG_MAX = 48;

export function tetherControls(t: Tether, sag = 0): { p0: Pos; c1: Pos; c2: Pos; p3: Pos } {
  const x1 = t.wave.x + t.wave.w;
  const y1 = t.wave.y + TETHER_WAVE_DY;
  const x2 = t.agent.x;
  const y2 = t.agent.y + TETHER_AGENT_DY;
  const mx = (x1 + x2) / 2;
  return {
    p0: { x: x1, y: y1 },
    c1: { x: mx, y: y1 + sag },
    c2: { x: mx, y: y2 + sag },
    p3: { x: x2, y: y2 },
  };
}

/** The cable's resting sag: longer cables hang lower. */
export function sagOf(t: Tether): number {
  const { p0, p3 } = tetherControls(t);
  return Math.min(SAG_MAX, SAG_FACTOR * Math.hypot(p3.x - p0.x, p3.y - p0.y));
}

const r = (n: number) => Math.round(n * 10) / 10;

export function tetherPath(t: Tether, sag = 0): string {
  const { p0, c1, c2, p3 } = tetherControls(t, sag);
  return `M${p0.x},${p0.y} C${r(c1.x)},${r(c1.y)} ${r(c2.x)},${r(c2.y)} ${p3.x},${p3.y}`;
}

/** `#rrggbb` mixed toward white by `k` (0–1): the specular highlight. */
export function tint(hex: string, k: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = (shift: number) => {
    const c = (n >> shift) & 255;
    return Math.round(c + (255 - c) * k)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

type Ends = { x1: number; y1: number; x2: number; y2: number; beat: number | null };
const ends = (t: Tether): Ends => ({
  x1: t.wave.x + t.wave.w,
  y1: t.wave.y,
  x2: t.agent.x,
  y2: t.agent.y,
  beat: t.beat ?? null,
});

export function Tethers({
  on,
  tethers,
  dragging = null,
}: {
  on: boolean;
  tethers: readonly Tether[];
  /** The window being dragged by its title bar, if any. */
  dragging?: string | null;
}) {
  const id = useId().replace(/:/g, "");
  const reduced = useReducedMotion();
  const narrow = useViewportWidth() < NARROW_PX;
  const still = reduced || narrow;
  // Nothing moves on cables that are static or not drawn.
  const idle = still || !on;

  const pool = useRef(new PulsePool());
  const sways = useRef(new Map<string, Sway>());
  const seen = useRef(new Map<string, Ends>());
  const raf = useRef(0);
  const last = useRef(0);
  const retireAt = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, setFrame] = useState(0);

  // One timer, at the end of the oldest pulse in flight; the pulse itself is CSS.
  const disarm = () => {
    if (retireAt.current !== null) clearTimeout(retireAt.current);
    retireAt.current = null;
  };
  const arm = () => {
    disarm();
    const end = pool.current.nextEnd();
    if (end === null) return;
    retireAt.current = setTimeout(
      () => {
        retireAt.current = null;
        pool.current.retire(performance.now());
        setFrame((f) => f + 1);
        arm();
      },
      Math.max(0, end - performance.now()),
    );
  };

  const loop = useRef<(now: number) => void>(() => {});
  loop.current = (now: number) => {
    raf.current = 0;
    const dt = last.current ? now - last.current : 16;
    last.current = now;
    for (const [agent, s] of sways.current) {
      const next = stepSway(s, dt);
      if (swaySettled(next)) sways.current.delete(agent);
      else sways.current.set(agent, next);
    }
    setFrame((f) => f + 1);
    if (sways.current.size > 0) raf.current = requestAnimationFrame((t) => loop.current(t));
  };
  const wake = () => {
    if (raf.current) return;
    last.current = 0;
    raf.current = requestAnimationFrame((t) => loop.current(t));
  };

  // New beats and dragged ends since the last render: pulses and sways.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `wake`, `arm` and `disarm` only touch refs
  useLayoutEffect(() => {
    const now = performance.now();
    let pulsed = false;
    let swayed = false;
    const ids = new Set<string>();
    for (const t of tethers) {
      ids.add(t.id);
      const cur = ends(t);
      const prev = seen.current.get(t.id);
      seen.current.set(t.id, cur);
      if (!prev || idle) continue;
      if (cur.beat !== null && cur.beat !== prev.beat) {
        pool.current.add(t.id, now);
        pulsed = true;
      }
      if (dragging === null || (dragging !== t.id && dragging !== t.waveId)) continue;
      const dx = cur.x2 - prev.x2 - (cur.x1 - prev.x1);
      const dy = cur.y2 - prev.y2 - (cur.y1 - prev.y1);
      if (dx !== 0 || dy !== 0) {
        sways.current.set(t.id, kickSway(sways.current.get(t.id), dx, dy));
        swayed = true;
      }
    }
    for (const agent of seen.current.keys()) {
      if (!ids.has(agent)) {
        seen.current.delete(agent);
        sways.current.delete(agent);
      }
    }
    if (idle) {
      sways.current.clear();
      pool.current.retire(Number.POSITIVE_INFINITY);
      disarm();
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    }
    if (pulsed) arm();
    if (swayed) wake();
    if (pulsed || swayed) setFrame((f) => f + 1);
  }, [tethers, idle, dragging]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `disarm` only touches refs
  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      raf.current = 0;
      disarm();
    },
    [],
  );

  if (!on) return null;
  const blur = `${id}-blur`;
  const drawn = tethers.map((t) => {
    const sway = sways.current.get(t.id);
    return { t, sway, d: tetherPath(t, sagOf(t) + (sway?.x ?? 0)) };
  });
  const byAgent = new Map(drawn.map((c) => [c.t.id, c]));
  const pulses = still ? [] : pool.current.list();

  return (
    <svg
      className="tethers"
      width="6000"
      height="4000"
      aria-hidden="true"
      data-still={still ? "" : undefined}
    >
      <defs>
        <filter id={blur} x="-10%" y="-10%" width="120%" height="120%">
          <feGaussianBlur stdDeviation="4" />
        </filter>
      </defs>
      <g className="tether-shadows" filter={`url(#${blur})`} transform="translate(0 12)">
        {drawn.map(({ t, d }) => (
          <path key={t.id} className="tether-shadow" d={d} />
        ))}
      </g>
      <g className="tether-glows" filter={`url(#${blur})`}>
        {drawn.map(({ t, d }) => (
          <path key={t.id} className="tether-glow" d={d} stroke={t.accent} data-agent={t.id} />
        ))}
      </g>
      {drawn.map(({ t, d, sway }) => (
        <g key={t.id} className="tether" data-agent={t.id} data-sway={sway ? "" : undefined}>
          <path className="tether-core" d={d} stroke={t.accent} />
          <path
            className="tether-hi"
            d={d}
            stroke={tint(t.accent, 0.65)}
            transform="translate(0 -1)"
          />
        </g>
      ))}
      {!still && (
        <g className="tether-pulses">
          {pulses.map((p) => {
            const c = byAgent.get(p.agent);
            if (!c) return null;
            return (
              <path
                key={p.id}
                className="tether-pulse"
                d={c.d}
                stroke={tint(c.t.accent, 0.35)}
                pathLength={100}
                data-agent={p.agent}
                style={{ animationDuration: `${PULSE_MS}ms` }}
              />
            );
          })}
        </g>
      )}
    </svg>
  );
}
