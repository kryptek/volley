/**
 * A card drawn on the screen layer, above the canvas: portalled into `document.body` and
 * placed from its anchor's screen rect (`placePopover`), so no window clips it and the
 * canvas's zoom never scales it; it re-places every frame while open, so it follows a pan,
 * a zoom or a window drag. Escape closes it; with `dismiss="outside"` (a dialog) so
 * does a pointer-down anywhere but the anchor and the card. A tooltip's open/close timing
 * stays with its caller (`onPointerEnter` / `onPointerLeave` on the card).
 */
import {
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { type Placement, placePopover } from "./placePopover";

const GAP = 4;
const MARGIN = 8;

export interface PopoverProps {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  role: "tooltip" | "dialog";
  id?: string;
  "aria-label"?: string;
  className?: string;
  dismiss?: "outside" | "none";
  onClose?: () => void;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  children: ReactNode;
}

const stop = (e: SyntheticEvent) => e.stopPropagation();

export function Popover(props: PopoverProps) {
  return props.open ? <Card {...props} /> : null;
}

function Card({
  anchor,
  role,
  id,
  "aria-label": label,
  className,
  dismiss = "none",
  onClose,
  onPointerEnter,
  onPointerLeave,
  children,
}: PopoverProps) {
  const card = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<Placement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  // Each frame while open: the canvas pans and zooms with a transform and a window drag moves
  // its chip, none of which fires a scroll or resize, and live content can change the card's size.
  useLayoutEffect(() => {
    let frame = 0;
    let last = "";
    const place = () => {
      const a = anchor.current;
      const c = card.current;
      if (a && c) {
        const r = a.getBoundingClientRect();
        const size = { w: c.offsetWidth, h: c.offsetHeight };
        const view = { w: window.innerWidth, h: window.innerHeight };
        const key = `${r.left},${r.top},${r.right},${r.bottom},${size.w},${size.h},${view.w},${view.h}`;
        if (key !== last) {
          last = key;
          setAt(placePopover(r, size, view, { gap: GAP, margin: MARGIN }));
        }
      }
      frame = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(frame);
  }, [anchor]);

  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close.current?.();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (card.current?.contains(t) || anchor.current?.contains(t))) return;
      close.current?.();
    };
    document.addEventListener("keydown", onKey);
    if (dismiss === "outside") document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [anchor, dismiss]);

  return createPortal(
    <div
      ref={card}
      role={role}
      id={id}
      aria-label={label}
      className={className ? `host-pop ${className}` : "host-pop"}
      data-side={at?.side ?? "below"}
      style={at ? { left: at.x, top: at.y } : { left: 0, top: 0, visibility: "hidden" }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      // React bubbles a portal's events up its React tree, not the DOM: without this a press on
      // the card would reach the window's title-bar drag and the stage's canvas pan.
      onPointerDown={stop}
      onPointerMove={stop}
      onPointerUp={stop}
      onTouchStart={stop}
      onTouchMove={stop}
    >
      {children}
    </div>,
    document.body,
  );
}
