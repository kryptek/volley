/**
 * Arrange & fit, ported from the prototype `App.tsx` `arrange()`. Pure: the
 * App hands in the visible clusters (each visible wave window with its agents
 * in task order, the side windows, the list windows) with their measured
 * sizes, and gets back every window's world position, each region's bounding
 * box and the view that fits them.
 *
 * Windows are laid out in three regions (#397), left to right: the waves
 * region, the side region next to it and the list region at the end.
 * - Waves: each cluster packs its agents shortest-column-first to the right of
 *   the wave window, with a column count of its own: for every target height
 *   each wave takes the fewest columns that keep it within it, so a big wave
 *   spreads out and a small one stays compact. Clusters are laid in rows (every
 *   row count is tried).
 * - Side (the unassigned group, sessions, the coordinators and Machines
 *   windows): one block packed by content size in 1 to n columns, right of the
 *   waves or under them, so it sits next to the waves and never trails at the
 *   screen edge on its own. A side cluster packs its agents in a near-square
 *   block (⌈√n⌉ columns), which bounds its tethers.
 * - List (Needs you): each window capped at the fit area's height
 *   (`capListHeight`; it scrolls inside), so a long list never sets the
 *   layout; after the other two regions, or under them.
 * Candidates are scored by scale first; among those within `EPS` of the best
 * scale the one using most of the fit area wins (`pickBest`), so equal-scale
 * layouts pick the wider, fuller one rather than a tall strip.
 *
 * Pinned windows (C12, `pins.ts`) are skipped: a window pinned in place keeps
 * its position and the rest are laid out clear of it (moved right, or down on
 * a portrait fit area, past any it would cover); a pinned wave window's agents
 * still pack as its cluster. Pinned windows are framed with the rest: each
 * placement is scored, and the view centred, on the bounding box of the
 * arranged block and the pinned windows together. The fit area may be
 * narrowed to leave room for windows anchored to the screen (`avoidAnchored`).
 */
import { FIT_MIN_SCALE, type Rect, type View } from "../canvas/useViewport";

/** Gap between windows inside a cluster. */
export const GAP = 36;
/** Gap between clusters. */
export const CGAP = 96;
export const ARRANGE_MAX_SCALE = 1.1;
/** Lowest scale arrange will set (below the wheel-zoom minimum): the fit minimum. */
export const ARRANGE_MIN_SCALE = FIT_MIN_SCALE;
/** Scales within this of the best count as equal: the fuller layout wins among them. */
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
  /** In the side region, next to the waves (see the module comment). */
  side?: boolean;
  /** A list window (Needs you): in the list region, its height capped at the fit area's. */
  list?: boolean;
}

/** The regions arrange lays windows out in (see the module comment). */
export type RegionName = "waves" | "side" | "list";

/** The browser viewport (`window.innerWidth` / `innerHeight`). */
export interface Screen {
  width: number;
  height: number;
}

export interface Candidate {
  /** Each wave's agent columns, by its wave window's id. */
  cols: Record<string, number>;
  rows: number;
  /** Fitting scale, before the floor. */
  s: number;
  /** The fraction of the fit area the block covers at that scale. */
  used: number;
  place: Record<string, Pos>;
  W: number;
  H: number;
  /** Each region's bounding box (the regions with windows in them). */
  regions: Partial<Record<RegionName, Rect>>;
}

export interface Arrangement {
  place: Record<string, Pos>;
  /** Each region's bounding box in world coordinates, as placed. */
  regions: Partial<Record<RegionName, Rect>>;
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

/** `lays` in `k` columns, each next one into the shortest, CGAP apart: packed by content size. */
function columns(lays: readonly Laid[], k: number): Laid {
  const cols: Laid[][] = Array.from({ length: k }, () => []);
  const hs: number[] = Array(k).fill(0);
  for (const l of lays) {
    const i = hs.indexOf(Math.min(...hs));
    cols[i]?.push(l);
    hs[i] = (hs[i] ?? 0) + l.h + CGAP;
  }
  return block(
    cols.filter((c) => c.length > 0).map((c) => block(c, false)),
    true,
  );
}

/** Rows of laid-out clusters, CGAP apart, as one block. */
function grid(rows: readonly (readonly Laid[])[]): Laid {
  const at: Record<string, Pos> = {};
  let y = 0;
  let w = 0;
  for (const row of rows) {
    let x = 0;
    for (const l of row) {
      for (const [id, p] of Object.entries(l.at)) at[id] = { x: x + p.x, y: y + p.y };
      x += l.w + CGAP;
    }
    w = Math.max(w, x - CGAP);
    y += Math.max(...row.map((l) => l.h)) + CGAP;
  }
  return { at, w, h: y - CGAP };
}

/** A list window's height on the canvas: never taller than the fit area (it scrolls inside). */
export const capListHeight = (h: number, area: Rect): number => Math.min(h, area.h);

/**
 * Each wave's agent columns for every target height: the fewest columns that keep the
 * cluster within it (all of them when none does), so a big wave spreads and a small one
 * stays compact; then every wave at the same count, 1 up to the most agents, which adds
 * the wider layouts that are no shorter. One entry per distinct choice.
 */
function columnChoices(waves: readonly Cluster[]): number[][] {
  const most = (cl: Cluster) => Math.max(1, cl.kids.length);
  const heights = waves.map((cl) =>
    Array.from({ length: most(cl) }, (_, i) => layoutCluster(cl, i + 1).h),
  );
  const targets = [...new Set(heights.flat())].sort((a, b) => b - a);
  const seen = new Set<string>();
  const out: number[][] = [];
  for (const t of targets) {
    const cols = heights.map((hs) => {
      const i = hs.findIndex((h) => h <= t);
      return i < 0 ? hs.length : i + 1;
    });
    const key = cols.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cols);
  }
  for (let c = 1; c <= Math.max(...waves.map(most)); c++) {
    const cols = waves.map((cl) => Math.min(c, most(cl)));
    const key = cols.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cols);
  }
  return out;
}

/** A region's laid-out block placed at `at`, as world positions and its bounding box. */
const put = (l: Laid, at: Pos, place: Record<string, Pos>): Rect => {
  for (const [id, p] of Object.entries(l.at)) place[id] = { x: at.x + p.x, y: at.y + p.y };
  return { ...at, w: l.w, h: l.h };
};

/** Every placement arrange considers, in the order it considers them. */
export function candidates(
  clusters: readonly Cluster[],
  screen: Screen,
  area: Rect = fitArea(screen),
): Candidate[] {
  const { w: vw, h: vh } = area;
  const out: Candidate[] = [];
  const waves = clusters.filter((cl) => !cl.side && !cl.list);
  const sides = clusters
    .filter((cl) => cl.side && !cl.list)
    .map((cl) => layoutCluster(cl, Math.ceil(Math.sqrt(cl.kids.length))));
  const lists = clusters
    .filter((cl) => cl.list)
    .map((cl) =>
      layoutCluster({ ...cl, main: { ...cl.main, h: capListHeight(cl.main.h, area) } }, 1),
    );
  if (waves.length === 0 && sides.length === 0 && lists.length === 0) return out;
  // The side region in 1 to n columns; the list region side by side.
  const sideBlocks = sides.length === 0 ? [null] : sides.map((_, k) => columns(sides, k + 1));
  const listBlock = lists.length === 0 ? null : block(lists, true);
  const choices = waves.length === 0 ? [[]] : columnChoices(waves);
  for (const cols of choices) {
    const lays = waves.map((cl, i) => layoutCluster(cl, cols[i] ?? 1));
    for (let rows = 1; rows <= Math.max(1, lays.length); rows++) {
      const per = Math.ceil(lays.length / rows);
      const waveRows: Laid[][] = [];
      for (let r = 0; r * per < lays.length; r++) waveRows.push(lays.slice(r * per, r * per + per));
      const waveBlock = waveRows.length === 0 ? null : grid(waveRows);
      for (const side of sideBlocks) {
        // The side region goes right of the waves, or under them.
        for (const under of waveBlock && side ? [false, true] : [false]) {
          for (const listUnder of listBlock && (waveBlock || side) ? [false, true] : [false]) {
            const place: Record<string, Pos> = {};
            const regions: Partial<Record<RegionName, Rect>> = {};
            let W = 0;
            let H = 0;
            const add = (name: RegionName, l: Laid, at: Pos) => {
              const r = put(l, at, place);
              regions[name] = r;
              W = Math.max(W, r.x + r.w);
              H = Math.max(H, r.y + r.h);
            };
            if (waveBlock) add("waves", waveBlock, { x: 0, y: 0 });
            if (side) {
              add(
                "side",
                side,
                !waveBlock ? { x: 0, y: 0 } : under ? { x: 0, y: H + CGAP } : { x: W + CGAP, y: 0 },
              );
            }
            if (listBlock) {
              const empty = W === 0 && H === 0;
              add(
                "list",
                listBlock,
                empty ? { x: 0, y: 0 } : listUnder ? { x: 0, y: H + CGAP } : { x: W + CGAP, y: 0 },
              );
            }
            const s = Math.min(ARRANGE_MAX_SCALE, vw / W, vh / H);
            out.push({
              cols: Object.fromEntries(
                waves.map((cl, i) => [
                  cl.main.id,
                  Math.max(1, Math.min(cols[i] ?? 1, cl.kids.length)),
                ]),
              ),
              rows,
              s,
              used: (W * s * H * s) / (vw * vh),
              place,
              W,
              H,
              regions,
            });
          }
        }
      }
    }
  }
  return out;
}

/**
 * The best of scored candidates: the largest scale, then (among those within `EPS` of it)
 * the largest fraction of the fit area used, then the earliest; -1 when there are none.
 */
export function pickBest(scored: readonly { s: number; used: number }[]): number {
  const top = Math.max(...scored.map((c) => c.s));
  let best = -1;
  scored.forEach((c, i) => {
    if (c.s < top - EPS) return;
    if (best < 0 || c.used > (scored[best]?.used ?? 0)) best = i;
  });
  return best;
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

/** The bounding box of `rects` (at least one). */
function union(rects: readonly Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const w = Math.max(...rects.map((r) => r.x + r.w)) - x;
  const h = Math.max(...rects.map((r) => r.y + r.h)) - y;
  return { x, y, w, h };
}

export interface ArrangeOptions {
  /** The screen area to fit into (default `fitArea`): less any windows anchored to the screen. */
  area?: Rect;
  /** Windows pinned in place, by id, at their world rects: skipped and kept clear of. */
  pinned?: Readonly<Record<string, Rect>>;
  /** Windows off the canvas (anchored to the screen): skipped. */
  skip?: ReadonlySet<string>;
}

/**
 * The zoom-maximising placement and the view centring it, with the pinned
 * windows, in the fit area; null when empty.
 */
export function arrange(
  clusters: readonly Cluster[],
  screen: Screen,
  opts: ArrangeOptions = {},
): Arrangement | null {
  const area = opts.area ?? fitArea(screen);
  const pinned = opts.pinned ?? {};
  const pinnedRects = Object.values(pinned);
  const across = area.w >= area.h;
  const ids = new Set([...Object.keys(pinned), ...(opts.skip ?? [])]);
  const scored = candidates(unpinned(clusters, ids), screen, area).map((c) => {
    // With nothing pinned the offset is (0, 0), the union is the block and the score is `c`'s.
    const off = clearOf(c.W, c.H, pinnedRects, across);
    const u = union([{ ...off, w: c.W, h: c.H }, ...pinnedRects]);
    const s = Math.min(ARRANGE_MAX_SCALE, area.w / u.w, area.h / u.h);
    return { c, off, u, s, used: (u.w * s * u.h * s) / (area.w * area.h) };
  });
  const best = scored[pickBest(scored)];
  if (!best) return null;
  const { off, u } = best;
  const s = Math.max(ARRANGE_MIN_SCALE, best.s);
  const place: Record<string, Pos> = {};
  for (const [id, p] of Object.entries(best.c.place)) {
    if (!ids.has(id)) place[id] = { x: off.x + p.x, y: off.y + p.y };
  }
  const regions: Partial<Record<RegionName, Rect>> = {};
  for (const [name, r] of Object.entries(best.c.regions) as [RegionName, Rect][]) {
    regions[name] = { ...r, x: off.x + r.x, y: off.y + r.y };
  }
  return {
    place,
    regions,
    view: {
      s,
      x: area.x + (area.w - u.w * s) / 2 - u.x * s,
      y: area.y + (area.h - u.h * s) / 2 - u.y * s,
    },
  };
}
