/**
 * The infinite canvas viewport, ported from the prototype `App.tsx`: drag
 * empty space to pan (pointer capture), wheel to pan, ⌘/Ctrl-wheel (and
 * trackpad pinch, which browsers report as ctrl-wheel) to zoom around the
 * cursor, scale clamped to [0.3, 1.6], and `fitTo(rects)` to frame a set of
 * world rectangles below the top bar (or inside a given screen area, C12:
 * leaving room for windows anchored to the screen). A fit may go below the wheel minimum
 * (down to `FIT_MIN_SCALE`) so everything shows; from there the wheel zooms
 * back in smoothly and never further out. Touch (D8): one finger on empty canvas
 * pans, two fingers pinch-zoom around their midpoint, on empty canvas or on a
 * window's body alike (windows fill a phone screen); `panBy` serves the arrow
 * keys. A pointer pan or pinch never renders per move: it writes the world
 * element's transform (`worldRef`) once per animation frame and commits
 * `view` when a finger lifts (pointer up or cancel). The wheel, `zoomAt`,
 * `panBy` and `fitTo` set `view` directly. Phones (< `NARROW_PX`) start zoomed out and clamp window widths
 * (`clampWindowWidth`).
 */
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";

export interface View {
  x: number;
  y: number;
  s: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MIN_SCALE = 0.3;
export const MAX_SCALE = 1.6;
const FIT_MAX_SCALE = 1.1;
/** The lowest scale a fit (or arrange & fit) sets: far enough out to show a whole busy Desk. */
export const FIT_MIN_SCALE = 0.05;

/** Pointer-downs on fixed chrome never move the canvas. */
const CHROME = ".look, .dock-wrap, .topbar, .modal-scrim";
/**
 * Inside a window a mouse or a lone finger never pans (the window handles its
 * own), but a touch counts toward a pinch unless it lands on the title bar
 * (drag) or a control that a finger drags or types into. Buttons (feed rows,
 * tabs) count: a lone tap still clicks, and a two-finger gesture never does.
 */
const NO_PINCH = ".win-bar, input, select, textarea, [contenteditable], [role='slider']";
/** Wheel inside these scrolls the content instead of the canvas. */
const NO_WHEEL = ".feed, .term, .yaml, .dag-scroll, .look, .modal";

/** Below this viewport width the Desk is in its phone layout. */
export const NARROW_PX = 700;
/** The screen area `fitTo` frames into by default: below the top bar, above the dock band. */
export function fitToArea(screen: { width: number; height: number }): Rect {
  return { x: 0, y: 70, w: screen.width, h: screen.height - 170 };
}

/** The widest a window gets on a phone (the agent window's width). */
const PHONE_WIN_MAX = 460;

const vw = () => (typeof window === "undefined" ? 1024 : window.innerWidth);
const isNarrow = () => vw() < NARROW_PX;

/** The viewport width; follows resizes and rotation. */
export function useViewportWidth(): number {
  const [w, setW] = useState(vw);
  useEffect(() => {
    const on = () => setW(vw());
    on();
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

/** The viewport size; follows resizes and rotation. */
const readScreen = () =>
  typeof window === "undefined"
    ? { width: 1024, height: 768 }
    : { width: window.innerWidth, height: window.innerHeight };

export function useScreenSize(): { width: number; height: number } {
  const [size, setSize] = useState(readScreen);
  useEffect(() => {
    const on = () =>
      setSize((s) => {
        const n = readScreen();
        return n.width === s.width && n.height === s.height ? s : n;
      });
    on();
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return size;
}

/** The widest a window gets on a phone of width `vw`: `min(460, 100vw - 24)`. */
export const phoneMaxWidth = (vw: number): number => Math.min(PHONE_WIN_MAX, vw - 24);

/** A window's width at viewport width `vw`: clamped to `phoneMaxWidth` on a phone. */
export function clampWindowWidth(width: number, vw: number): number {
  return vw < NARROW_PX ? Math.min(width, phoneMaxWidth(vw)) : width;
}

/** The prototype's initial view; phones (< 700 px) start zoomed out. */
export function initialView(): View {
  const narrow = isNarrow();
  return { x: narrow ? 8 : 40, y: narrow ? 70 : 76, s: narrow ? 0.5 : 0.82 };
}

/** The world layer's transform for a view (the one place it is built). */
export const worldTransform = (v: View): string => `translate(${v.x}px, ${v.y}px) scale(${v.s})`;

/** Zoom from `from` to `s`, clamped; below `MIN_SCALE` (after a fit) zooming out stays put. */
const clamp = (s: number, from: number) =>
  Math.min(MAX_SCALE, Math.max(Math.min(MIN_SCALE, from), s));

export function useViewport(opts: { initial?: View } = {}) {
  const [view, setView] = useState<View>(() => opts.initial ?? initialView());
  const stageRef = useRef<HTMLDivElement>(null);
  /**
   * Tracked pointers (pointerId → last position): one on empty canvas pans,
   * any two pinch. `canvas` is false for a touch on a window's body.
   */
  const pointers = useRef(new Map<number, { x: number; y: number; canvas: boolean }>());
  /** The world layer, moved directly during a gesture. */
  const worldRef = useRef<HTMLDivElement>(null);
  /** The view as the current gesture has moved it; `view` catches up on release. */
  const live = useRef(view);
  const moved = useRef(false);
  const frame = useRef(0);
  useEffect(() => {
    live.current = view;
  }, [view]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  /** Move the gesture's view and write it to the world element on the next frame. */
  const glide = (next: View) => {
    live.current = next;
    moved.current = true;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (worldRef.current) worldRef.current.style.transform = worldTransform(live.current);
    });
  };

  const zoomAt = useCallback(
    (factor: number, cx = window.innerWidth / 2, cy = window.innerHeight / 2) =>
      setView((v) => {
        const s = clamp(v.s * factor, v.s);
        return { s, x: cx - ((cx - v.x) * s) / v.s, y: cy - ((cy - v.y) * s) / v.s };
      }),
    [],
  );

  const fitTo = useCallback((rects: readonly Rect[], area?: Rect) => {
    if (!rects.length) return;
    const a = area ?? fitToArea({ width: window.innerWidth, height: window.innerHeight });
    const minX = Math.min(...rects.map((r) => r.x));
    const minY = Math.min(...rects.map((r) => r.y));
    const maxX = Math.max(...rects.map((r) => r.x + r.w));
    const maxY = Math.max(...rects.map((r) => r.y + r.h));
    const s = Math.min(
      FIT_MAX_SCALE,
      Math.max(FIT_MIN_SCALE, Math.min(a.w / (maxX - minX + 80), a.h / (maxY - minY + 80))),
    );
    setView({
      s,
      x: a.x + (a.w - (maxX - minX) * s) / 2 - minX * s,
      y: a.y + (a.h - (maxY - minY) * s) / 2 - minY * s,
    });
  }, []);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if ((e.target as Element).closest(NO_WHEEL)) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
      else setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [zoomAt]);

  const panBy = useCallback(
    (dx: number, dy: number) => setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy })),
    [],
  );

  const release = (e: React.PointerEvent) => {
    if (!pointers.current.delete(e.pointerId) || !moved.current) return;
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    moved.current = false;
    setView(live.current);
  };
  const stageHandlers = {
    onPointerDown: (e: React.PointerEvent) => {
      const target = e.target as Element;
      if (target.closest(CHROME)) return;
      if (target.closest(".win")) {
        if (e.pointerType !== "touch" || target.closest(NO_PINCH)) return;
        // No capture: the window keeps its taps; the touch's moves bubble up to the stage.
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY, canvas: false });
        return;
      }
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY, canvas: true });
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const ps = pointers.current;
      const last = ps.get(e.pointerId);
      if (!last) return;
      const now = { x: e.clientX, y: e.clientY };
      const other = [...ps].find(([id]) => id !== e.pointerId)?.[1];
      ps.set(e.pointerId, { ...now, canvas: last.canvas });
      if (!other) {
        if (last.canvas) {
          const v = live.current;
          glide({ ...v, x: v.x + now.x - last.x, y: v.y + now.y - last.y });
        }
        return;
      }
      // Pinch: scale by the change in finger distance around the midpoint,
      // and follow the midpoint as it moves.
      const d0 = Math.hypot(last.x - other.x, last.y - other.y);
      const d1 = Math.hypot(now.x - other.x, now.y - other.y);
      const m0 = { x: (last.x + other.x) / 2, y: (last.y + other.y) / 2 };
      const m1 = { x: (now.x + other.x) / 2, y: (now.y + other.y) / 2 };
      const v = live.current;
      const s = d0 > 0 ? clamp((v.s * d1) / d0, v.s) : v.s;
      glide({ s, x: m1.x - ((m0.x - v.x) * s) / v.s, y: m1.y - ((m0.y - v.y) * s) / v.s });
    },
    onPointerUp: release,
    onPointerCancel: release,
  };

  return { view, setView, zoomAt, panBy, fitTo, stageRef, worldRef, stageHandlers };
}
