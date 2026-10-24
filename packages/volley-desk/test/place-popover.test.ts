import { describe, expect, it } from "vitest";
import { placePopover } from "../src/look/placePopover";

const OPTS = { gap: 4, margin: 8 };
const VIEW = { w: 1440, h: 900 };
const rect = (left: number, top: number, w = 80, h = 22) => ({
  left,
  top,
  right: left + w,
  bottom: top + h,
});

describe("placePopover", () => {
  it("fits below: under the anchor, aligned to its left edge", () => {
    expect(placePopover(rect(100, 100), { w: 300, h: 120 }, VIEW, OPTS)).toEqual({
      x: 100,
      y: 126,
      side: "below",
    });
  });

  it("no room below but room above: flipped above the anchor", () => {
    const a = rect(100, 820);
    expect(placePopover(a, { w: 300, h: 120 }, VIEW, OPTS)).toEqual({
      x: 100,
      y: 820 - 4 - 120,
      side: "above",
    });
  });

  it("overflowing the right edge: shifted left to the margin", () => {
    const p = placePopover(rect(1300, 100), { w: 300, h: 120 }, VIEW, OPTS);
    expect(p.x + 300).toBe(1440 - 8);
  });

  it("on a 390-wide phone a 360-wide card ends at the margin; a full-width one starts at it", () => {
    const phone = { w: 390, h: 844 };
    expect(placePopover(rect(200, 100), { w: 360, h: 120 }, phone, OPTS).x).toBe(390 - 8 - 360);
    // max-width: calc(100vw - 16px)
    expect(placePopover(rect(200, 100), { w: 374, h: 120 }, phone, OPTS).x).toBe(8);
  });

  it("an anchor left of the screen: the card never starts before the margin", () => {
    expect(placePopover(rect(-50, 100), { w: 300, h: 120 }, VIEW, OPTS).x).toBe(8);
  });

  it("taller than both halves: clamped inside the margins, never negative", () => {
    const p = placePopover(rect(100, 400), { w: 300, h: 600 }, { w: 1440, h: 700 }, OPTS);
    expect(p.y).toBeGreaterThanOrEqual(8);
    expect(p.y).toBeLessThanOrEqual(700 - 8 - 600);
    const huge = placePopover(rect(100, 400), { w: 300, h: 900 }, { w: 1440, h: 700 }, OPTS);
    expect(huge.y).toBe(8);
  });
});
