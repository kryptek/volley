/**
 * The infinite canvas viewport, ported from the prototype `App.tsx`: drag
 * empty space to pan (pointer capture), wheel to pan, ⌘/Ctrl-wheel (and
 * trackpad pinch, which browsers report as ctrl-wheel) to zoom around the
 * cursor, scale clamped to [0.3, 1.6], and `fitTo(rects)` to frame a set of
 * world rectangles below the top bar.
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

/** The prototype's initial view; phones (< 700 px) start zoomed out. */
export function initialView(): View {
  const narrow = typeof window !== "undefined" && window.innerWidth < 700;
  return { x: narrow ? 8 : 40, y: narrow ? 70 : 76, s: narrow ? 0.5 : 0.82 };
}

const clamp = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

export function useViewport(opts: { initial?: View } = {}) {
  const [view, setView] = useState<View>(() => opts.initial ?? initialView());
  const stageRef = useRef<HTMLDivElement>(null);
  const panning = useRef<{ x: number; y: number } | null>(null);

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

  const stageHandlers = {
    onPointerDown: (e: React.PointerEvent) => {
      if ((e.target as Element).closest(NO_PAN)) return;
      panning.current = { x: e.clientX, y: e.clientY };
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const last = panning.current;
      if (!last) return;
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      panning.current = { x: e.clientX, y: e.clientY };
      setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
    },
    onPointerUp: () => {
      panning.current = null;
    },
    onPointerCancel: () => {
      panning.current = null;
    },
  };

  return { view, setView, zoomAt, fitTo, stageRef, stageHandlers };
}
