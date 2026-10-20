/**
 * Arrange & fit, ported from the prototype `App.tsx` `arrange()`. Pure: the
 * App hands in the visible clusters (the coordinators window, then each
 * visible wave window with its agents in task order) with their measured
 * sizes, and gets back every window's world position plus the view that fits
 * them. Each cluster packs its agents shortest-column-first to the right of
 * the wave window; for 1 to max(3, the most agents in a cluster) agent
 * columns and every row count, clusters are laid out in rows and the
 * placement with the largest fitting scale wins, so one big cluster spreads
 * to the viewport's aspect instead of a tall strip.
 *
 * Side clusters (the unassigned group, the coordinators window) are not
 * spread over rows with the waves: they form one block, side by side or
 * stacked (unassigned above coordinators), that closes the first row right
 * after its waves and before any overflow row, so it sits next to the waves
 * instead of trailing far behind them. On a portrait screen the block may
 * instead start the second row, under the first wave; the scale decides. A
 * side cluster packs its agents in a near-square block (⌈√n⌉ columns)
 * whatever the waves use, which bounds its tethers.
 */
import { FIT_MIN_SCALE, type View } from "../canvas/useViewport";

/** Gap between windows inside a cluster. */
export const GAP = 36;
/** Gap between clusters. */
export const CGAP = 96;
export const ARRANGE_MAX_SCALE = 1.1;
/** Lowest scale arrange will set (below the wheel-zoom minimum): the fit minimum. */
export const ARRANGE_MIN_SCALE = FIT_MIN_SCALE;
/** Agent columns always tried; a cluster with more agents also tries up to one column each. */
const MIN_MAX_COLS = 3;
/** A candidate must beat the best so far by this much to replace it. */
const EPS = 0.005;

type Pos = { x: number; y: number };

export interface Box {
  id: string;
  w: number;
  h: number;
}

export interface Cluster {
  main: Box;
  kids: Box[];
  /** Laid out at the end of the first row, after its waves (see the module comment). */
  side?: boolean;
}

/** The browser viewport (`window.innerWidth` / `innerHeight`). */
export interface Screen {
  width: number;
  height: number;
}

export interface Candidate {
  cols: number;
  rows: number;
  /** Fitting scale, before the floor. */
  s: number;
  place: Record<string, Pos>;
  W: number;
  H: number;
}

export interface Arrangement {
  place: Record<string, Pos>;
  view: View;
}

/** One cluster with `c` agent columns, shortest column first; positions are cluster-relative. */
export function layoutCluster(
  cl: Cluster,
  c: number,
): { at: Record<string, Pos>; w: number; h: number } {
  const cols = Math.max(1, Math.min(c, cl.kids.length));
  const colH: number[] = Array(cols).fill(0);
  const kidW = Math.max(0, ...cl.kids.map((k) => k.w));
  const at: Record<string, Pos> = { [cl.main.id]: { x: 0, y: 0 } };
  for (const k of cl.kids) {
    const i = colH.indexOf(Math.min(...colH));
    at[k.id] = { x: cl.main.w + GAP + i * (kidW + GAP), y: colH[i] ?? 0 };
    colH[i] = (colH[i] ?? 0) + k.h + GAP;
  }
  const w = cl.main.w + (cl.kids.length ? GAP + cols * kidW + (cols - 1) * GAP : 0);
  const h = Math.max(cl.main.h, ...colH.map((x) => x - GAP));
  return { at, w, h };
}

/** The fit area: the screen less 24 px side gutters, the top bar (64) and the dock band (110). */
function fitArea(screen: Screen) {
  return { vw: screen.width - 48, vh: screen.height - 64 - 110 };
}

type Laid = ReturnType<typeof layoutCluster>;

/** Laid-out clusters side by side (`across`) or stacked, CGAP apart, as one block. */
function block(lays: readonly Laid[], across: boolean): Laid {
  const at: Record<string, Pos> = {};
  let off = 0;
  for (const l of lays) {
    for (const [id, p] of Object.entries(l.at)) {
      at[id] = across ? { x: off + p.x, y: p.y } : { x: p.x, y: off + p.y };
    }
    off += (across ? l.w : l.h) + CGAP;
  }
  const w = across ? off - CGAP : Math.max(...lays.map((l) => l.w));
  const h = across ? Math.max(...lays.map((l) => l.h)) : off - CGAP;
  return { at, w, h };
}

/** Every placement arrange considers, in the order it considers them. */
export function candidates(clusters: readonly Cluster[], screen: Screen): Candidate[] {
  const { vw, vh } = fitArea(screen);
  const out: Candidate[] = [];
  const waves = clusters.filter((cl) => !cl.side);
  const sides = clusters
    .filter((cl) => cl.side)
    .map((cl) => layoutCluster(cl, Math.ceil(Math.sqrt(cl.kids.length))));
  if (waves.length === 0 && sides.length === 0) return out;
  // The side block, side by side and (for two or more) stacked.
  const blocks = sides.length === 0 ? [] : [block(sides, true)];
  if (sides.length > 1) blocks.push(block(sides, false));
  // Where it goes: closing the first row, or (portrait, with waves) as the second row.
  const below = waves.length > 0 && vw < vh ? [false, true] : [false];
  const maxCols = Math.max(MIN_MAX_COLS, ...waves.map((cl) => cl.kids.length));
  for (let c = 1; c <= maxCols; c++) {
    const lays = waves.map((cl) => layoutCluster(cl, c));
    for (let rows = 1; rows <= Math.max(1, lays.length); rows++) {
      const per = Math.ceil(lays.length / rows);
      const waveRows: Laid[][] = [];
      for (let r = 0; r === 0 || r * per < lays.length; r++) {
        waveRows.push(lays.slice(r * per, r * per + per));
      }
      for (const side of blocks.length ? blocks : [null]) {
        for (const under of below) {
          const grid = waveRows.map((row) => [...row]);
          if (side && under) grid.splice(1, 0, [side]);
          else if (side) grid[0]?.push(side);
          const place: Record<string, Pos> = {};
          let y = 0;
          let W = 0;
          for (const row of grid) {
            let x = 0;
            for (const l of row) {
              for (const [id, p] of Object.entries(l.at)) place[id] = { x: x + p.x, y: y + p.y };
              x += l.w + CGAP;
            }
            W = Math.max(W, x - CGAP);
            y += Math.max(...row.map((l) => l.h)) + CGAP;
          }
          const H = y - CGAP;
          out.push({ cols: c, rows, s: Math.min(ARRANGE_MAX_SCALE, vw / W, vh / H), place, W, H });
        }
      }
    }
  }
  return out;
}

/** The zoom-maximising placement and the view centring it below the top bar; null when empty. */
export function arrange(clusters: readonly Cluster[], screen: Screen): Arrangement | null {
  let best: Candidate | null = null;
  for (const c of candidates(clusters, screen)) if (!best || c.s > best.s + EPS) best = c;
  if (!best) return null;
  const { vw, vh } = fitArea(screen);
  const s = Math.max(ARRANGE_MIN_SCALE, best.s);
  return {
    place: best.place,
    view: { s, x: 24 + (vw - best.W * s) / 2, y: 64 + (vh - best.H * s) / 2 },
  };
}
