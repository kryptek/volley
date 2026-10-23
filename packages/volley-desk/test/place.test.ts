import { describe, expect, it } from "vitest";
import { GAP } from "../src/layout/arrange";
import { placeInRegion } from "../src/layout/place";

type R = { x: number; y: number; w: number; h: number };
const overlaps = (a: R, b: R) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("placeInRegion (#404)", () => {
  const region = { x: 100, y: 50, w: 1000, h: 800 };
  const size = { w: 300, h: 200 };

  it("an empty region places at its top-left", () => {
    expect(placeInRegion(region, size, [])).toEqual({ x: 100, y: 50 });
  });

  it("returns free space inside the region, clear of every occupied box, nearest the top-left", () => {
    const occupied = [
      { x: 100, y: 50, w: 400, h: 300 },
      { x: 100 + 400 + GAP, y: 50, w: 300, h: 100 },
    ];
    const p = placeInRegion(region, size, occupied);
    const r = { ...p, ...size };
    expect(r.x).toBeGreaterThanOrEqual(region.x);
    expect(r.y).toBeGreaterThanOrEqual(region.y);
    expect(r.x + r.w).toBeLessThanOrEqual(region.x + region.w);
    expect(r.y + r.h).toBeLessThanOrEqual(region.y + region.h);
    for (const o of occupied) {
      expect(overlaps(r, { x: o.x - GAP, y: o.y - GAP, w: o.w + 2 * GAP, h: o.h + 2 * GAP })).toBe(
        false,
      );
    }
    // nearest the region's top-left: under the first box (336 away), not under the second (457)
    expect(p).toEqual({ x: 100, y: 50 + 300 + GAP });
  });

  it("ignores boxes outside the region", () => {
    expect(placeInRegion(region, size, [{ x: 5000, y: 5000, w: 100, h: 100 }])).toEqual({
      x: 100,
      y: 50,
    });
  });

  it("a full region extends downward, under its lowest box", () => {
    const occupied = [{ x: 100, y: 50, w: 1000, h: 800 }];
    expect(placeInRegion(region, size, occupied)).toEqual({ x: 100, y: 50 + 800 + GAP });
  });

  it("a window wider than the region goes under it, at its left edge", () => {
    expect(placeInRegion({ x: 0, y: 0, w: 100, h: 100 }, size, [])).toEqual({ x: 0, y: 0 });
    expect(
      placeInRegion({ x: 0, y: 0, w: 100, h: 100 }, size, [{ x: 0, y: 0, w: 100, h: 100 }]),
    ).toEqual({ x: 0, y: 100 + GAP });
  });
});

describe("placeInRegion: a full region, twice", () => {
  it("a second window lands under the first one placed below the region", () => {
    const region = { x: 0, y: 0, w: 460, h: 470 };
    const size = { w: 460, h: 470 };
    const first = placeInRegion(region, size, [{ x: 0, y: 0, w: 460, h: 470 }]);
    expect(first).toEqual({ x: 0, y: 470 + GAP });
    const second = placeInRegion(region, size, [
      { x: 0, y: 0, w: 460, h: 470 },
      { ...first, ...size },
    ]);
    expect(second).toEqual({ x: 0, y: 2 * (470 + GAP) });
  });
});
