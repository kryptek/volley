import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PINS_STORAGE_KEY, type Pin } from "../src/layout/pins";
import { usePins } from "../src/layout/usePins";

beforeEach(() => localStorage.clear());

const moveBy =
  (dx: number, dy: number) =>
  (p: Pin | undefined): Pin | undefined =>
    p?.mode === "place" ? { ...p, x: p.x + dx, y: p.y + dy } : p;

describe("usePins", () => {
  it("drag moves compose even when several land before a render", () => {
    const { result } = renderHook(() => usePins("desktop"));
    act(() => result.current.setPin("wave:w1", { mode: "place", x: 0, y: 0 }));
    act(() => {
      // two pointer moves in one batch, both from the same (stale) render
      result.current.setPin("wave:w1", moveBy(10, 5), { save: false });
      result.current.setPin("wave:w1", moveBy(10, 5), { save: false });
    });
    expect(result.current.pins["wave:w1"]).toEqual({ mode: "place", x: 20, y: 10 });
  });

  it("a drag writes localStorage once, on the drop, not on every move", () => {
    const { result } = renderHook(() => usePins("desktop"));
    act(() => result.current.setPin("wave:w1", { mode: "place", x: 0, y: 0 }));
    const set = vi.spyOn(Storage.prototype, "setItem");
    for (let i = 0; i < 5; i++) {
      act(() => result.current.setPin("wave:w1", moveBy(1, 1), { save: false }));
    }
    expect(set).not.toHaveBeenCalled();
    act(() => result.current.save());
    expect(set).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(PINS_STORAGE_KEY) ?? "{}").desktop["wave:w1"]).toEqual({
      mode: "place",
      x: 5,
      y: 5,
    });
    set.mockRestore();
  });

  it("a pin set or cleared outside a drag is saved at once; reset clears both layouts", () => {
    const { result } = renderHook(() => usePins("phone"));
    act(() => result.current.setPin("panel:coordinators", { mode: "place", x: 1, y: 2 }));
    expect(JSON.parse(localStorage.getItem(PINS_STORAGE_KEY) ?? "{}").phone).toEqual({
      "panel:coordinators": { mode: "place", x: 1, y: 2 },
    });
    act(() => result.current.setPin("panel:coordinators", null));
    expect(JSON.parse(localStorage.getItem(PINS_STORAGE_KEY) ?? "{}").phone).toEqual({});
    act(() => result.current.reset());
    expect(localStorage.getItem(PINS_STORAGE_KEY)).toBe(JSON.stringify({ desktop: {}, phone: {} }));
  });
});
