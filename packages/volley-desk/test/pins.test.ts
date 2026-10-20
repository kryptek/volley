import { beforeEach, describe, expect, it } from "vitest";
import {
  PINS_STORAGE_KEY,
  type Pin,
  anchorAt,
  avoidAnchored,
  hudBounds,
  loadPins,
  nextPinMode,
  pinButtonLabel,
  pinModeOf,
  savePins,
  screenPos,
  windowKeys,
} from "../src/layout/pins";

const screen = { width: 1600, height: 1000 };

describe("pin modes", () => {
  it("cycle unpinned → pinned in place → anchored to screen → unpinned", () => {
    expect(nextPinMode("none")).toBe("place");
    expect(nextPinMode("place")).toBe("screen");
    expect(nextPinMode("screen")).toBe("none");
  });

  it("the button label names the state and what a click does", () => {
    expect(pinButtonLabel("none")).toBe("Not pinned · pin in place");
    expect(pinButtonLabel("place")).toBe("Pinned in place · anchor to the screen");
    expect(pinButtonLabel("screen")).toBe("Anchored to the screen · unpin");
  });

  it("pinModeOf reads a pin (or none)", () => {
    expect(pinModeOf(undefined)).toBe("none");
    expect(pinModeOf({ mode: "place", x: 1, y: 2 })).toBe("place");
    expect(pinModeOf({ mode: "screen", corner: "tl", dx: 0, dy: 0 })).toBe("screen");
  });
});

describe("anchored to the screen: a corner plus an offset", () => {
  const size = { w: 430, h: 300 };
  const b = hudBounds(screen, false);

  it("a window near the top left anchors to the top-left corner", () => {
    expect(anchorAt({ x: 20, y: 80, ...size }, screen, b)).toEqual({
      mode: "screen",
      corner: "tl",
      dx: 20,
      dy: 80,
    });
  });

  it("a window near the bottom right anchors to that corner, measured from it", () => {
    expect(anchorAt({ x: 1100, y: 600, ...size }, screen, b)).toEqual({
      mode: "screen",
      corner: "br",
      dx: 1600 - 1100 - 430,
      dy: 1000 - 600 - 300,
    });
  });

  it("holds its corner when the viewport resizes", () => {
    const pin = anchorAt({ x: 1100, y: 600, ...size }, screen, b);
    const small = { width: 1200, height: 800 };
    expect(screenPos(pin, size, small, hudBounds(small, false))).toEqual({
      left: 1200 - 70 - 430,
      top: 800 - 100 - 300,
    });
    // and the top-left one stays where it was
    const tl = anchorAt({ x: 20, y: 80, ...size }, screen, b);
    expect(screenPos(tl, size, small, hudBounds(small, false))).toEqual({ left: 20, top: 80 });
  });

  it("is clamped inside the viewport, below the top bar", () => {
    const pin: Pin = { mode: "screen", corner: "tl", dx: -500, dy: -500 };
    expect(screenPos(pin, size, screen, b)).toEqual({ left: b.x, top: b.y });
    const far: Pin = { mode: "screen", corner: "tl", dx: 5000, dy: 5000 };
    expect(screenPos(far, size, screen, b)).toEqual({
      left: b.x + b.w - size.w,
      top: b.y + b.h - size.h,
    });
  });

  it("at phone width it never covers the dock band", () => {
    const phone = { width: 390, height: 844 };
    const pb = hudBounds(phone, true);
    expect(pb.y + pb.h).toBeLessThanOrEqual(844 - 110);
    const pin: Pin = { mode: "screen", corner: "bl", dx: 0, dy: 0 };
    const at = screenPos(pin, { w: 366, h: 44 }, phone, pb);
    expect(at.top + 44).toBeLessThanOrEqual(844 - 110);
  });
});

describe("avoidAnchored: the fit area leaves room for anchored windows", () => {
  const area = { x: 24, y: 64, w: 1552, h: 826 };

  it("no anchored windows: the area is unchanged", () => {
    expect(avoidAnchored(area, [])).toEqual(area);
  });

  it("a tall window on the left pushes the area's left edge past it", () => {
    const r = avoidAnchored(area, [{ x: 24, y: 64, w: 430, h: 700 }]);
    expect(r.x).toBeGreaterThanOrEqual(24 + 430);
    expect(r.x + r.w).toBe(24 + 1552);
    expect(r.y).toBe(64);
    expect(r.h).toBe(826);
  });

  it("a wide window across the top pushes the area's top edge below it", () => {
    const r = avoidAnchored(area, [{ x: 300, y: 64, w: 1000, h: 120 }]);
    expect(r.y).toBeGreaterThanOrEqual(64 + 120);
    expect(r.x).toBe(24);
    expect(r.w).toBe(1552);
  });

  it("a window outside the area changes nothing", () => {
    expect(avoidAnchored(area, [{ x: 0, y: 950, w: 100, h: 40 }])).toEqual(area);
  });

  it("when avoiding would leave too little room, the window is covered instead", () => {
    // a window nearly the whole screen: no cut leaves half the area
    expect(avoidAnchored(area, [{ x: 30, y: 70, w: 1500, h: 800 }])).toEqual(area);
  });
});

describe("window keys: stable across agents coming and going", () => {
  it("panels and waves by name, agents by wave, task and role", () => {
    const k = windowKeys(
      ["coordinators"],
      ["w1"],
      [
        { id: "agent-x1", wave: "w1", task: "T1", role: "implementer" },
        { id: "agent-y2", wave: "__unassigned__", task: null, role: null },
      ],
    );
    expect(k).toEqual({
      coordinators: "panel:coordinators",
      w1: "wave:w1",
      "agent-x1": "task:w1/T1/implementer",
      "agent-y2": "agent:agent-y2",
    });
  });

  it("a respawned agent keeps the slot's pin: the slot key goes to its current holder", () => {
    // The finished predecessor is still in the store (and listed first); the live successor
    // holds the slot in the wave state.
    const k = windowKeys(
      [],
      [],
      [
        { id: "old", wave: "w1", task: "T1", role: "fixup", holds: false },
        { id: "new", wave: "w1", task: "T1", role: "fixup", holds: true },
      ],
    );
    expect(k.new).toBe("task:w1/T1/fixup");
    expect(k.old).toBe("agent:old");
  });

  it("the key does not depend on the order agents arrive in", () => {
    const k = windowKeys(
      [],
      [],
      [
        { id: "new", wave: "w1", task: "T1", role: "fixup", holds: true },
        { id: "old", wave: "w1", task: "T1", role: "fixup", holds: false },
      ],
    );
    expect(k.new).toBe("task:w1/T1/fixup");
    expect(k.old).toBe("agent:old");
  });

  it("with no holder known (no wave state yet), the first agent of the slot takes it", () => {
    const k = windowKeys(
      [],
      [],
      [
        { id: "a1", wave: "w1", task: "T1", role: "spec_reviewer" },
        { id: "a2", wave: "w1", task: "T1", role: "spec_reviewer" },
      ],
    );
    expect(k.a1).toBe("task:w1/T1/spec_reviewer");
    expect(k.a2).toBe("agent:a2");
  });
});

describe("persistence: per window key, per device class", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips desktop and phone layouts independently", () => {
    savePins({
      desktop: { "panel:coordinators": { mode: "screen", corner: "tl", dx: 16, dy: 72 } },
      phone: { "wave:w1": { mode: "place", x: 10, y: 20 } },
    });
    expect(loadPins()).toEqual({
      desktop: { "panel:coordinators": { mode: "screen", corner: "tl", dx: 16, dy: 72 } },
      phone: { "wave:w1": { mode: "place", x: 10, y: 20 } },
    });
  });

  it("drops malformed entries and survives garbage", () => {
    localStorage.setItem(
      PINS_STORAGE_KEY,
      JSON.stringify({
        desktop: {
          ok: { mode: "place", x: 1, y: 2 },
          bad: { mode: "screen", corner: "middle", dx: 0, dy: 0 },
          nan: { mode: "place", x: "1", y: 2 },
        },
        phone: 7,
      }),
    );
    expect(loadPins()).toEqual({ desktop: { ok: { mode: "place", x: 1, y: 2 } }, phone: {} });
    localStorage.setItem(PINS_STORAGE_KEY, "{not json");
    expect(loadPins()).toEqual({ desktop: {}, phone: {} });
  });
});
