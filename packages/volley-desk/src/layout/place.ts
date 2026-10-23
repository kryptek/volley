/**
 * Where a window opened after an arrange goes (#404): free space in its region,
 * nearest the region's top-left, a gap clear of every window already there, so
 * opening a window never moves another. Pure. The positions tried are the
 * region's left and top edges and a gap past each occupied box's right and
 * bottom edges; when none is free inside the region, the window goes under the
 * region's lowest box at its left edge, and further down past any window
 * already there (a full region extends downward).
 */
import type { Rect } from "../canvas/useViewport";
import { GAP } from "./arrange";

type Pos = { x: number; y: number };
type Size = { w: number; h: number };

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** `r` grown by GAP on every side: a box must stay that far from it. */
const padded = (r: Rect): Rect => ({
  x: r.x - GAP,
  y: r.y - GAP,
  w: r.w + 2 * GAP,
  h: r.h + 2 * GAP,
});

export function placeInRegion(region: Rect, size: Size, occupied: readonly Rect[]): Pos {
  const right = region.x + region.w;
  const bottom = region.y + region.h;
  const near = occupied.filter((r) => overlaps(r, region));
  // A window wider (or taller) than the region still starts at its left (top) edge.
  const xs = [region.x, ...near.map((r) => r.x + r.w + GAP)].filter(
    (x) => x === region.x || (x >= region.x && x + size.w <= right),
  );
  const ys = [region.y, ...near.map((r) => r.y + r.h + GAP)].filter(
    (y) => y === region.y || (y >= region.y && y + size.h <= bottom),
  );
  const tries = xs
    .flatMap((x) => ys.map((y) => ({ x, y })))
    .sort(
      (a, b) =>
        Math.hypot(a.x - region.x, a.y - region.y) - Math.hypot(b.x - region.x, b.y - region.y) ||
        a.y - b.y ||
        a.x - b.x,
    );
  const free = (p: Pos) => !occupied.some((r) => overlaps({ ...p, ...size }, padded(r)));
  for (const p of tries) if (free(p)) return p;
  // Full: under the region's lowest box, then down past any window already below it.
  const at = { x: region.x, y: Math.max(region.y - GAP, ...near.map((r) => r.y + r.h)) + GAP };
  const hit = () => occupied.find((r) => overlaps({ ...at, ...size }, padded(r)));
  for (let r = hit(); r; r = hit()) at.y = r.y + r.h + GAP;
  return at;
}
