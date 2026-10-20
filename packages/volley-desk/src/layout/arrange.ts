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
 *
 * Pinned windows (C12, `pins.ts`) are skipped: a window pinned in place keeps
 * its position and the rest are laid out clear of it (moved right, or down on
 * a portrait fit area, past any it would cover); a pinned wave window's agents
 * still pack as its cluster. The fit area may be narrowed to leave room for
 * windows anchored to the screen (`avoidAnchored`).
 */
import { FIT_MIN_SCALE, type Rect, type View } from "../canvas/useViewport";

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
  // A pinned wave window (zero-sized, see `unpinned`) leaves no column of its own.
  const lead = cl.main.w > 0 ? cl.main.w + GAP : 0;
  const colH: number[] = Array(cols).fill(0);
  const kidW = Math.max(0, ...cl.kids.map((k) => k.w));
  const at: Record<string, Pos> = { [cl.main.id]: { x: 0, y: 0 } };
  for (const k of cl.kids) {
    const i = colH.indexOf(Math.min(...colH));
    at[k.id] = { x: lead + i * (kidW + GAP), y: colH[i] ?? 0 };
    colH[i] = (colH[i] ?? 0) + k.h + GAP;
  }
  const w = cl.kids.length ? lead + cols * kidW + (cols - 1) * GAP : cl.main.w;
  const h = Math.max(cl.main.h, ...colH.map((x) => x - GAP));
  return { at, w, h };
}

/** The fit area: the screen less 24 px side gutters, the top bar (64) and the dock band (110). */
export function fitArea(screen: Screen): Rect {
  return { x: 24, y: 64, w: screen.width - 48, h: screen.height - 64 - 110 };
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
export function candidates(
  clusters: readonly Cluster[],
  screen: Screen,
  area: Rect = fitArea(screen),
): Candidate[] {
  const { w: vw, h: vh } = area;
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

/**
 * The clusters without the pinned windows: a pinned agent leaves its cluster,
 * a pinned wave window becomes a zero-sized head (its agents still pack, from
 * the cluster's left edge), and a cluster with nothing left goes.
 */
function unpinned(clusters: readonly Cluster[], pinned: ReadonlySet<string>): Cluster[] {
  return clusters.flatMap((cl) => {
    const kids = cl.kids.filter((k) => !pinned.has(k.id));
    if (!pinned.has(cl.main.id)) return [{ ...cl, kids }];
    if (kids.length === 0) return [];
    return [{ ...cl, main: { id: cl.main.id, w: 0, h: 0 }, kids }];
  });
}

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Where a W × H block starts so it covers none of `pinned`: moved right (`across`) or down past each. */
function clearOf(W: number, H: number, pinned: readonly Rect[], across: boolean): Pos {
  const at = { x: 0, y: 0 };
  for (let hit = true; hit; ) {
    hit = false;
    for (const r of pinned) {
      if (!overlaps({ ...at, w: W + CGAP, h: H + CGAP }, { ...r, w: r.w + CGAP, h: r.h + CGAP })) {
        continue;
      }
      if (across) at.x = r.x + r.w + CGAP;
      else at.y = r.y + r.h + CGAP;
      hit = true;
    }
  }
  return at;
}

export interface ArrangeOptions {
  /** The screen area to fit into (default `fitArea`): less any windows anchored to the screen. */
  area?: Rect;
  /** Windows pinned in place, by id, at their world rects: skipped and kept clear of. */
  pinned?: Readonly<Record<string, Rect>>;
  /** Windows off the canvas (anchored to the screen): skipped. */
  skip?: ReadonlySet<string>;
}

/** The zoom-maximising placement and the view centring it in the fit area; null when empty. */
export function arrange(
  clusters: readonly Cluster[],
  screen: Screen,
  opts: ArrangeOptions = {},
): Arrangement | null {
  const area = opts.area ?? fitArea(screen);
  const pinned = opts.pinned ?? {};
  const ids = new Set([...Object.keys(pinned), ...(opts.skip ?? [])]);
  let best: Candidate | null = null;
  for (const c of candidates(unpinned(clusters, ids), screen, area)) {
    if (!best || c.s > best.s + EPS) best = c;
  }
  if (!best) return null;
  const s = Math.max(ARRANGE_MIN_SCALE, best.s);
  const off = clearOf(best.W, best.H, Object.values(pinned), area.w >= area.h);
  const place: Record<string, Pos> = {};
  for (const [id, p] of Object.entries(best.place)) {
    if (!ids.has(id)) place[id] = { x: off.x + p.x, y: off.y + p.y };
  }
  return {
    place,
    view: {
      s,
      x: area.x + (area.w - best.W * s) / 2 - off.x * s,
      y: area.y + (area.h - best.H * s) / 2 - off.y * s,
    },
  };
}
