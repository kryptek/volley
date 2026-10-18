/**
 * The infinite canvas viewport, ported from the prototype `App.tsx`: drag
 * empty space to pan (pointer capture), wheel to pan, ⌘/Ctrl-wheel (and
 * trackpad pinch, which browsers report as ctrl-wheel) to zoom around the
 * cursor, scale clamped to [0.3, 1.6], and `fitTo(rects)` to frame a set of
 * world rectangles below the top bar. Touch (D8): one finger pans, two
 * fingers pinch-zoom around their midpoint; `panBy` serves the arrow keys.
 * Phones (< 700 px, `useNarrow`) start zoomed out and clamp window widths.
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

/** Pointer-downs on these start no pan: windows and fixed chrome handle their own. */
const NO_PAN = ".win, .look, .dock-wrap, .topbar, .modal-scrim";
/** Wheel inside these scrolls the content instead of the canvas. */
const NO_WHEEL = ".feed, .term, .yaml, .dag-scroll, .look, .modal";

/** Below this viewport width the Desk is in its phone layout. */
export const NARROW_PX = 700;
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

/** `true` while the viewport is phone-width. */
export const useNarrow = (): boolean => useViewportWidth() < NARROW_PX;

/** A window's width at viewport width `vw`: on a phone, `min(460, 100vw - 24)`. */
export function clampWindowWidth(width: number, vw: number): number {
  return vw < NARROW_PX ? Math.min(width, PHONE_WIN_MAX, vw - 24) : width;
}

/** The prototype's initial view; phones (< 700 px) start zoomed out. */
export function initialView(): View {
  const narrow = isNarrow();
  return { x: narrow ? 8 : 40, y: narrow ? 70 : 76, s: narrow ? 0.5 : 0.82 };
}

const clamp = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

export function useViewport(opts: { initial?: View } = {}) {
  const [view, setView] = useState<View>(() => opts.initial ?? initialView());
  const stageRef = useRef<HTMLDivElement>(null);
  /** Pointers down on empty canvas (pointerId → last position): one pans, two pinch. */
  const pointers = useRef(new Map<number, { x: number; y: number }>());

  const zoomAt = useCallback(
    (factor: number, cx = window.innerWidth / 2, cy = window.innerHeight / 2) =>
      setView((v) => {
        const s = clamp(v.s * factor);
        return { s, x: cx - ((cx - v.x) * s) / v.s, y: cy - ((cy - v.y) * s) / v.s };
      }),
    [],
  );

  const fitTo = useCallback((rects: readonly Rect[]) => {
    if (!rects.length) return;
    const minX = Math.min(...rects.map((r) => r.x));
    const minY = Math.min(...rects.map((r) => r.y));
    const maxX = Math.max(...rects.map((r) => r.x + r.w));
    const maxY = Math.max(...rects.map((r) => r.y + r.h));
    const W = window.innerWidth;
    const H = window.innerHeight - 170;
    const s = Math.min(
      FIT_MAX_SCALE,
      Math.max(MIN_SCALE, Math.min(W / (maxX - minX + 80), H / (maxY - minY + 80))),
    );
    setView({
      s,
      x: (W - (maxX - minX) * s) / 2 - minX * s,
      y: 70 + (H - (maxY - minY) * s) / 2 - minY * s,
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
    pointers.current.delete(e.pointerId);
  };
  const stageHandlers = {
    onPointerDown: (e: React.PointerEvent) => {
      if ((e.target as Element).closest(NO_PAN)) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const ps = pointers.current;
      const last = ps.get(e.pointerId);
      if (!last) return;
      const now = { x: e.clientX, y: e.clientY };
      const other = [...ps].find(([id]) => id !== e.pointerId)?.[1];
      ps.set(e.pointerId, now);
      if (!other) {
        panBy(now.x - last.x, now.y - last.y);
        return;
      }
      // Pinch: scale by the change in finger distance around the midpoint,
      // and follow the midpoint as it moves.
      const d0 = Math.hypot(last.x - other.x, last.y - other.y);
      const d1 = Math.hypot(now.x - other.x, now.y - other.y);
      const m0 = { x: (last.x + other.x) / 2, y: (last.y + other.y) / 2 };
      const m1 = { x: (now.x + other.x) / 2, y: (now.y + other.y) / 2 };
      setView((v) => {
        const s = d0 > 0 ? clamp((v.s * d1) / d0) : v.s;
        return { s, x: m1.x - ((m0.x - v.x) * s) / v.s, y: m1.y - ((m0.y - v.y) * s) / v.s };
      });
    },
    onPointerUp: release,
    onPointerCancel: release,
  };

  return { view, setView, zoomAt, panBy, fitTo, stageRef, stageHandlers };
}
