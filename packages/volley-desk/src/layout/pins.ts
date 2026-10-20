/**
 * Window pinning (C12). Pure: the pin modes and their labels, where a window
 * anchored to the screen sits, the fit area that leaves room for those
 * windows, the stable key a window's pin is saved under and the saved layout.
 *
 * A window is unpinned, pinned in place (it keeps its canvas position: arrange
 * skips it, and it still pans and zooms with the canvas) or anchored to the
 * screen (fixed in the viewport like a HUD, above the canvas windows: pan,
 * zoom, fit and arrange never move it). An anchored window is saved as the
 * viewport corner nearest its centre plus its offset from that corner, so it
 * holds that corner when the viewport resizes.
 *
 * Pins are kept per window key (a panel name, a wave id, an agent's wave, task
 * and role, which outlive the agent) in this browser's `volley-desk:layout`
 * entry, one layout for the desktop and one for the phone width.
 */
import type { Rect } from "../canvas/useViewport";

export type PinMode = "none" | "place" | "screen";
export type Corner = "tl" | "tr" | "bl" | "br";
export type ScreenPin = { mode: "screen"; corner: Corner; dx: number; dy: number };
export type Pin = { mode: "place"; x: number; y: number } | ScreenPin;
/** Pins by window key. */
export type Pins = Record<string, Pin>;
export type DeviceClass = "desktop" | "phone";
export type Layouts = Record<DeviceClass, Pins>;

/** The saved layouts in localStorage. */
export const PINS_STORAGE_KEY = "volley-desk:layout";

/** The top bar's band: an anchored window stays below it. */
const TOP_BAND = 64;
/** The dock's band at phone width, which an anchored window never covers. */
const DOCK_BAND = 110;
/** Gap between an anchored window and the viewport's edges. */
const EDGE = 8;
/** Gap kept between the fit area and an anchored window. */
const AVOID_GAP = 16;
/** Avoiding an anchored window must leave at least this share of the fit area's width and height. */
const MIN_ROOM = 0.5;

const NEXT: Record<PinMode, PinMode> = { none: "place", place: "screen", screen: "none" };
export const nextPinMode = (m: PinMode): PinMode => NEXT[m];

export const PIN_LABEL: Record<PinMode, string> = {
  none: "Not pinned",
  place: "Pinned in place",
  screen: "Anchored to the screen",
};
const VERB: Record<PinMode, string> = {
  none: "unpin",
  place: "pin in place",
  screen: "anchor to the screen",
};
/** The toggle's name and tooltip: the state, then what a click does. */
export const pinButtonLabel = (m: PinMode): string => `${PIN_LABEL[m]} · ${VERB[NEXT[m]]}`;

export const pinModeOf = (p: Pin | undefined): PinMode => p?.mode ?? "none";

/** Where an anchored window may sit: below the top bar, inside the edges, above the dock on a phone. */
export function hudBounds(screen: { width: number; height: number }, narrow: boolean): Rect {
  const bottom = narrow ? DOCK_BAND : EDGE;
  return {
    x: EDGE,
    y: TOP_BAND,
    w: Math.max(0, screen.width - 2 * EDGE),
    h: Math.max(0, screen.height - TOP_BAND - bottom),
  };
}

/** `v` kept in [lo, hi]; `lo` wins when the window is larger than the room. */
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

function clampInto(left: number, top: number, size: { w: number; h: number }, b: Rect) {
  return {
    left: clamp(left, b.x, b.x + b.w - size.w),
    top: clamp(top, b.y, b.y + b.h - size.h),
  };
}

/** An anchored window's top-left on screen at this viewport size. */
export function screenPos(
  pin: ScreenPin,
  size: { w: number; h: number },
  screen: { width: number; height: number },
  bounds: Rect,
): { left: number; top: number } {
  const left = pin.corner[1] === "l" ? pin.dx : screen.width - size.w - pin.dx;
  const top = pin.corner[0] === "t" ? pin.dy : screen.height - size.h - pin.dy;
  return clampInto(left, top, size, bounds);
}

/** The anchor for a window at screen rect `r` (clamped into `bounds`): its nearest corner and offset. */
export function anchorAt(
  r: Rect,
  screen: { width: number; height: number },
  bounds: Rect,
): ScreenPin {
  const { left, top } = clampInto(r.x, r.y, r, bounds);
  const v = top + r.h / 2 < screen.height / 2 ? "t" : "b";
  const h = left + r.w / 2 < screen.width / 2 ? "l" : "r";
  return {
    mode: "screen",
    corner: `${v}${h}` as Corner,
    dx: h === "l" ? left : screen.width - left - r.w,
    dy: v === "t" ? top : screen.height - top - r.h,
  };
}

const intersects = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * The fit area less the windows anchored to the screen: for each one that
 * overlaps it (largest first), the area gives up the side that keeps the most
 * room. A window that cannot be avoided without leaving less than half the
 * area's width or height is covered instead.
 */
export function avoidAnchored(area: Rect, anchored: readonly Rect[]): Rect {
  let a = area;
  const byArea = [...anchored].sort((p, q) => q.w * q.h - p.w * p.h);
  for (const r of byArea) {
    if (!intersects(a, r)) continue;
    const right = a.x + a.w;
    const bottom = a.y + a.h;
    const left = r.x + r.w + AVOID_GAP;
    const top = r.y + r.h + AVOID_GAP;
    const cuts: Rect[] = [
      { x: left, y: a.y, w: right - left, h: a.h },
      { x: a.x, y: a.y, w: r.x - AVOID_GAP - a.x, h: a.h },
      { x: a.x, y: top, w: a.w, h: bottom - top },
      { x: a.x, y: a.y, w: a.w, h: r.y - AVOID_GAP - a.y },
    ].filter((c) => c.w >= area.w * MIN_ROOM && c.h >= area.h * MIN_ROOM);
    let best: Rect | undefined;
    for (const c of cuts) if (!best || c.w * c.h > best.w * best.h) best = c;
    if (best) a = best;
  }
  return a;
}

export interface KeyedAgent {
  id: string;
  wave: string;
  task: string | null;
  role: string | null;
  /** The agent holds its task's role slot in the wave state now (`tasks[].agents[role]`). */
  holds?: boolean;
}

/**
 * Each window's pin key: `panel:<name>`, `wave:<id>`, and for an agent its
 * slot `task:<wave>/<task>/<role>`, else `agent:<id>`. The slot key goes to
 * the agent that holds the slot now, so a respawned agent's window keeps the
 * pin while its finished predecessor (still in the store) is keyed by its id;
 * whatever order the agents arrived in. A slot no agent is known to hold
 * (no wave state yet) goes to its first agent.
 */
export function windowKeys(
  panels: readonly string[],
  waves: readonly string[],
  agents: readonly KeyedAgent[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of panels) out[p] = `panel:${p}`;
  for (const w of waves) out[w] = `wave:${w}`;
  const slotOf = (a: KeyedAgent) =>
    a.task && a.role ? `task:${a.wave}/${a.task}/${a.role}` : null;
  const taken = new Set<string>();
  for (const a of agents) {
    const slot = slotOf(a);
    if (slot && a.holds && !taken.has(slot)) {
      taken.add(slot);
      out[a.id] = slot;
    }
  }
  for (const a of agents) {
    if (out[a.id]) continue;
    const slot = slotOf(a);
    const held = slot !== null && agents.some((b) => b.holds && slotOf(b) === slot);
    if (slot && !held && !taken.has(slot)) {
      taken.add(slot);
      out[a.id] = slot;
    } else {
      out[a.id] = `agent:${a.id}`;
    }
  }
  return out;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const CORNERS: readonly string[] = ["tl", "tr", "bl", "br"];

function isPin(v: unknown): v is Pin {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  if (p.mode === "place") return num(p.x) && num(p.y);
  return (
    p.mode === "screen" &&
    typeof p.corner === "string" &&
    CORNERS.includes(p.corner) &&
    num(p.dx) &&
    num(p.dy)
  );
}

function readPins(v: unknown): Pins {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v).filter(([, p]) => isPin(p))) as Pins;
}

/** The saved layouts; a missing, malformed or unreadable entry reads as none. */
export function loadPins(): Layouts {
  try {
    const v = JSON.parse(localStorage.getItem(PINS_STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    return { desktop: readPins(v?.desktop), phone: readPins(v?.phone) };
  } catch {
    return { desktop: {}, phone: {} };
  }
}

export function savePins(layouts: Layouts): void {
  try {
    localStorage.setItem(PINS_STORAGE_KEY, JSON.stringify(layouts));
  } catch {
    // A blocked localStorage keeps the pins for this page only.
  }
}
