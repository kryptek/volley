/**
 * Where a popover card goes on screen (`Popover.tsx`). Every rect is in screen pixels (the
 * anchor's `getBoundingClientRect()`, the card's size, the viewport), so the canvas's zoom
 * and pan need no special case. Below the anchor by default, above it when only that fits,
 * shifted horizontally into the viewport and clamped to `margin` on every side.
 */
export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Placement {
  x: number;
  y: number;
  side: "below" | "above";
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

export function placePopover(
  anchor: AnchorRect,
  size: { w: number; h: number },
  viewport: { w: number; h: number },
  { gap, margin }: { gap: number; margin: number },
): Placement {
  const x = clamp(anchor.left, margin, Math.max(margin, viewport.w - margin - size.w));
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - size.h;
  const maxY = Math.max(margin, viewport.h - margin - size.h);
  if (below + size.h <= viewport.h - margin) return { x, y: below, side: "below" };
  if (above >= margin) return { x, y: above, side: "above" };
  // Fits neither way: keep the side with more room, clamped inside the margins.
  const roomBelow = viewport.h - anchor.bottom;
  const side = roomBelow >= anchor.top ? "below" : "above";
  return { x, y: clamp(side === "below" ? below : above, margin, maxY), side };
}
