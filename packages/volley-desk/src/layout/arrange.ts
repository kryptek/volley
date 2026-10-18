/**
 * Arrange & fit, ported from the prototype `App.tsx` `arrange()`. Pure: the
 * App hands in the visible clusters (the coordinators window, then each
 * visible wave window with its agents in task order) with their measured
 * sizes, and gets back every window's world position plus the view that fits
 * them. Each cluster packs its agents shortest-column-first to the right of
 * the wave window; for 1–3 agent columns and every row count, clusters are
 * laid out in rows and the placement with the largest fitting scale wins.
 */
import type { View } from "../canvas/useViewport";

/** Gap between windows inside a cluster. */
export const GAP = 36;
/** Gap between clusters. */
export const CGAP = 96;
export const ARRANGE_MAX_SCALE = 1.1;
/** Lowest scale arrange will set (below the wheel-zoom minimum, as in the prototype). */
export const ARRANGE_MIN_SCALE = 0.2;
const MAX_COLS = 3;
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

/** Every placement arrange considers, in the order it considers them. */
export function candidates(clusters: readonly Cluster[], screen: Screen): Candidate[] {
  const { vw, vh } = fitArea(screen);
  const out: Candidate[] = [];
  for (let c = 1; c <= MAX_COLS; c++) {
    const lays = clusters.map((cl) => layoutCluster(cl, c));
    for (let rows = 1; rows <= lays.length; rows++) {
      const per = Math.ceil(lays.length / rows);
      const place: Record<string, Pos> = {};
      let y = 0;
      let W = 0;
      for (let r = 0; r * per < lays.length; r++) {
        const row = lays.slice(r * per, r * per + per);
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
