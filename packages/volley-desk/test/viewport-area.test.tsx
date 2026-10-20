import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { fitToArea, useViewport } from "../src/canvas/useViewport";

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1600 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 1000 });
});

describe("fitTo with an area (C12: room for anchored windows)", () => {
  it("the default area is the screen below the top bar and above the dock band", () => {
    expect(fitToArea({ width: 1600, height: 1000 })).toEqual({ x: 0, y: 70, w: 1600, h: 830 });
  });

  it("frames the rects inside the given area", () => {
    const { result } = renderHook(() => useViewport({ initial: { x: 0, y: 0, s: 1 } }));
    const area = { x: 500, y: 70, w: 1100, h: 830 };
    act(() => result.current.fitTo([{ x: 0, y: 0, w: 900, h: 600 }], area));
    const v = result.current.view;
    expect(v.x).toBeGreaterThanOrEqual(500);
    expect(v.x + 900 * v.s).toBeLessThanOrEqual(1600);
  });

  it("without an area it frames as before C12 (the pre-change formula's numbers)", () => {
    const { result } = renderHook(() => useViewport({ initial: { x: 0, y: 0, s: 1 } }));
    act(() => result.current.fitTo([{ x: 10, y: 20, w: 900, h: 600 }]));
    // W = 1600, H = 1000 - 170 = 830: s = min(1.1, 1600 / 980, 830 / 680) = 1.1,
    // x = (1600 - 900 * 1.1) / 2 - 10 * 1.1, y = 70 + (830 - 600 * 1.1) / 2 - 20 * 1.1.
    const v = result.current.view;
    expect(v.s).toBeCloseTo(1.1, 10);
    expect(v.x).toBeCloseTo(294, 10);
    expect(v.y).toBeCloseTo(133, 10);
  });
});
