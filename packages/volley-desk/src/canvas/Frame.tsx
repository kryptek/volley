/**
 * The window frame, ported from the prototype `windows.tsx` `Frame`: title
 * bar drag (pointer delta ÷ zoom scale), focus on any pointer-down, the
 * `win--born` entrance kept for 4 s, and `ResizeObserver` sizing via `onSize`.
 * Chromes (D7): `glass` (default) and `solid` are CSS; `liquid` lays a React
 * Bits `GlassSurface` under the content, `spotlight` wraps it in a
 * `SpotlightCard` and `glow` in a `BorderGlow`, all tinted by the accent. A
 * window at attention tier `you` is wrapped in its Needs-you effect
 * (`attnStyle`): the pulse (the owner's default), an `ElectricBorder` or a
 * `StarBorder`. The `wrapAttention` slot overrides the effect.
 * Depth (D10): every chrome is the sign-in card's raised, lit object
 * (`win-depth` in desk.css: layered shadows, gradient body, glass) with a
 * `win-edge` overlay drawing the lit top edge, dark bottom edge and inner
 * highlight ring above the content. The window tilts toward the pointer by up
 * to `TILT_MAX_DEG` (`--rx` / `--ry` + `data-tilt`, set on the element, so no
 * re-render); never while dragged, under reduced motion or at phone width. The
 * box and the gate are read once per hover (again after a drag), not on every
 * pointer move. `onDrag` reports the title-bar drag (the tethers sway then).
 * Pinning (C12): `pin` puts the pin toggle in the title bar (a click cycles
 * unpinned → pinned in place → anchored to the screen; its name and tooltip
 * say the state); `layer` moves the window into the screen-anchored layer
 * instead of the canvas. The window always renders into its own host element,
 * which is moved between its place on the canvas and the layer, so pinning
 * never remounts it (its state is kept) and the focus is restored after the
 * move; `collapsed` shows only the title bar, and a tap on
 * the bar (or the Expand button) calls `onCollapse`.
 */
import type React from "react";
import "../styles/attention.css";
import "../styles/look.css";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Pin02Icon,
  PinIcon,
  PinOffIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { REDUCED_MOTION_QUERY } from "../a11y/motion";
import { type PinMode, pinButtonLabel } from "../layout/pins";
import type { AttnStyle, Chrome } from "../look/options";
import BorderGlow from "../rb/BorderGlow/BorderGlow";
import ElectricBorder from "../rb/ElectricBorder/ElectricBorder";
import GlassSurface from "../rb/GlassSurface/GlassSurface";
import SpotlightCard from "../rb/SpotlightCard/SpotlightCard";
import StarBorder from "../rb/StarBorder/StarBorder";
import { emitSound } from "../sounds/emit";
import { NARROW_PX } from "./useViewport";

export type { AttnStyle, Chrome } from "../look/options";
export type Attention = "you" | "coordinator" | "info";
/** The Needs-you colour (prototype `--hot`). */
const HOT = "#ff7a59";

/** How long a new window keeps its `win--born` class. */
export const BORN_MS = 4000;
/** A title-bar press that moves less than this (px) is a tap. */
const TAP_PX = 5;
/** The most a window tilts toward the pointer, in degrees. */
export const TILT_MAX_DEG = 2;

/** Tilt only with motion allowed and outside the phone layout. */
const tiltAllowed = (): boolean =>
  window.innerWidth >= NARROW_PX && !window.matchMedia?.(REDUCED_MOTION_QUERY).matches;

/** The default Needs-you effect: a pulsing border (styles/attention.css). */
export function pulse(framed: ReactNode): ReactNode {
  return <div className="win-attn win-attn-pulse">{framed}</div>;
}

/** The Needs-you wrapper for an effect (props from the prototype `Frame`). */
export function attentionEffect(style: AttnStyle): (framed: ReactNode) => ReactNode {
  if (style === "electric") {
    return (framed) => (
      <ElectricBorder
        color={HOT}
        borderRadius={14}
        speed={1}
        chaos={0.6}
        thickness={2}
        className="win-attn"
      >
        {framed}
      </ElectricBorder>
    );
  }
  if (style === "star") {
    return (framed) => (
      // A div, not StarBorder's default <button>: the window holds buttons of its own.
      <StarBorder
        as="div"
        className="win-attn win-attn-star"
        color={HOT}
        duration={4}
        thickness={2}
      >
        {framed}
      </StarBorder>
    );
  }
  return pulse;
}

/** `#rrggbb` → `rgba(r,g,b,a)`. */
export function hexA(hex: string, a: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** `#rrggbb` → `"h s l"` (degrees, percent, percent), BorderGlow's `glowColor` format. */
export function hexToHsl(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return `${Math.round(h * 360)} ${Math.round(s * 100)} ${Math.round(l * 100)}`;
}

export interface FrameProps {
  id: string;
  title: ReactNode;
  /** Accessible name for the window; defaults to `title` when that is a string. */
  label?: string;
  accent: string;
  pos: { x: number; y: number };
  width: number;
  /** Caps `width` (phones: `clampWindowWidth`). */
  maxWidth?: number;
  z: number;
  scale: number;
  chrome: Chrome;
  attn?: Attention;
  /** The Needs-you effect at tier `you` (default `pulse`). */
  attnStyle?: AttnStyle;
  /** Wraps the framed window at tier `you`, overriding `attnStyle`. */
  wrapAttention?: (framed: ReactNode) => ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  onMove: (dx: number, dy: number) => void;
  onFocus: () => void;
  onSize?: (w: number, h: number) => void;
  /** The title bar is grabbed (`true`) or let go (`false`). */
  onDrag?: (dragging: boolean) => void;
  born?: boolean;
  /** The pin toggle: the window's pin mode and what a click does. */
  pin?: { mode: PinMode; onCycle: () => void };
  /** Render into this element (the screen-anchored layer) instead of in place. */
  layer?: Element | null;
  /** Only the title bar shows. */
  collapsed?: boolean;
  /** Collapsing is offered: a tap on the bar or the Expand / Collapse button asks for the other state. */
  onCollapse?: (collapsed: boolean) => void;
}

const PIN_ICON = { none: PinOffIcon, place: PinIcon, screen: Pin02Icon } as const;

export function Frame(p: FrameProps) {
  const last = useRef<{ x: number; y: number } | null>(null);
  /** Where the current title-bar press started (a tap is one that barely moved). */
  const start = useRef<{ x: number; y: number } | null>(null);
  /** Whether the current press has moved out of tap range (it sounded `ui_drag_start`). */
  const dragged = useRef(false);
  const box = useRef<HTMLElement>(null);
  const onSize = useRef(p.onSize);
  onSize.current = p.onSize;
  const [born, setBorn] = useState(p.born ?? false);

  useEffect(() => {
    if (!born) return;
    const t = setTimeout(() => setBorn(false), BORN_MS);
    return () => clearTimeout(t);
  }, [born]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => onSize.current?.(el.offsetWidth, el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The hovered box and whether tilt is allowed, until the pointer leaves or a drag moves the window.
  const hovered = useRef<{ r: DOMRect; allowed: boolean } | null>(null);
  const untilt = () => {
    const el = box.current;
    if (!el?.hasAttribute("data-tilt")) return;
    el.removeAttribute("data-tilt");
    el.style.removeProperty("--rx");
    el.style.removeProperty("--ry");
  };
  const tilt = (e: React.PointerEvent) => {
    const el = box.current;
    if (!el || last.current || e.pointerType === "touch") return;
    hovered.current ??= { r: el.getBoundingClientRect(), allowed: tiltAllowed() };
    const { r, allowed } = hovered.current;
    if (!allowed || r.width <= 0 || r.height <= 0) return;
    const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const fy = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    el.style.setProperty("--rx", `${((0.5 - fy) * 2 * TILT_MAX_DEG).toFixed(2)}deg`);
    el.style.setProperty("--ry", `${((fx - 0.5) * 2 * TILT_MAX_DEG).toFixed(2)}deg`);
    el.setAttribute("data-tilt", "");
  };

  const down = (e: React.PointerEvent) => {
    if ((e.target as Element).closest("button")) return;
    untilt();
    hovered.current = null;
    last.current = { x: e.clientX, y: e.clientY };
    start.current = last.current;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    p.onDrag?.(true);
  };
  const move = (e: React.PointerEvent) => {
    if (!last.current) return;
    const s0 = start.current;
    // A drag sounds once it leaves tap range: a tap is a collapse, not a drag.
    if (!dragged.current && s0 && Math.hypot(e.clientX - s0.x, e.clientY - s0.y) >= TAP_PX) {
      dragged.current = true;
      emitSound("ui_drag_start");
    }
    p.onMove((e.clientX - last.current.x) / p.scale, (e.clientY - last.current.y) / p.scale);
    last.current = { x: e.clientX, y: e.clientY };
  };
  const up = (e: React.PointerEvent) => {
    if (!last.current) return;
    const s0 = start.current;
    last.current = null;
    start.current = null;
    hovered.current = null;
    p.onDrag?.(false);
    if (dragged.current) emitSound("ui_drop");
    dragged.current = false;
    const tap =
      s0 !== null &&
      e.type === "pointerup" &&
      Math.hypot(e.clientX - s0.x, e.clientY - s0.y) < TAP_PX;
    if (tap) p.onCollapse?.(!p.collapsed);
  };
  const name = p.label ?? (typeof p.title === "string" ? p.title : "window");

  // The host the window renders into, and the marker for its place on the canvas. Checked
  // after every render: the host follows its marker when React reorders the windows.
  const [host] = useState(() => document.createElement("div"));
  const marker = useRef<HTMLSpanElement>(null);
  const layer = p.layer ?? null;
  useLayoutEffect(() => {
    const home = marker.current;
    const into = layer ?? home?.parentNode;
    if (!into) return;
    if (host.parentNode === into && (layer || host.previousSibling === home)) return;
    const active = document.activeElement;
    const refocus = active instanceof HTMLElement && host.contains(active) ? active : null;
    if (layer) layer.appendChild(host);
    else home?.after(host);
    refocus?.focus();
  });
  useLayoutEffect(() => () => host.remove(), [host]);

  const inner = (
    <div className={`win-inner win-depth chrome-${p.chrome}`}>
      {p.chrome === "liquid" && (
        <div className="win-glass" aria-hidden>
          <GlassSurface
            width="100%"
            height="100%"
            borderRadius={14}
            brightness={22}
            opacity={0.88}
            blur={14}
            backgroundOpacity={0.18}
            saturation={1.4}
          />
        </div>
      )}
      <header
        className="win-bar"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        <span className="win-acc" />
        <div className="win-title">{p.title}</div>
        <div className="win-actions">
          {p.actions}
          {p.onCollapse && (
            <button
              type="button"
              className="icon-btn"
              aria-expanded={!p.collapsed}
              aria-label={`${p.collapsed ? "Expand" : "Collapse"} ${name}`}
              title={p.collapsed ? "Expand" : "Collapse"}
              onClick={() => p.onCollapse?.(!p.collapsed)}
            >
              <HugeiconsIcon
                icon={p.collapsed ? ArrowDown01Icon : ArrowUp01Icon}
                size={15}
                strokeWidth={1.8}
              />
            </button>
          )}
          {p.pin && (
            <button
              type="button"
              className={`icon-btn win-pin win-pin--${p.pin.mode}`}
              aria-pressed={p.pin.mode !== "none"}
              aria-label={pinButtonLabel(p.pin.mode)}
              title={pinButtonLabel(p.pin.mode)}
              onClick={p.pin.onCycle}
            >
              <HugeiconsIcon icon={PIN_ICON[p.pin.mode]} size={15} strokeWidth={1.8} />
            </button>
          )}
        </div>
      </header>
      <div className="win-body" hidden={p.collapsed}>
        {p.children}
      </div>
      {p.footer && (
        <footer className="win-foot" hidden={p.collapsed}>
          {p.footer}
        </footer>
      )}
      <span className="win-edge" aria-hidden="true" />
    </div>
  );

  let framed: ReactNode = inner;
  if (p.chrome === "spotlight") {
    framed = (
      <SpotlightCard className="win-wrap" spotlightColor={hexA(p.accent, 0.22)} ambient>
        {inner}
      </SpotlightCard>
    );
  } else if (p.chrome === "glow") {
    framed = (
      <BorderGlow
        className="win-wrap"
        glowColor={hexToHsl(p.accent)}
        backgroundColor="rgba(14,16,26,.78)"
        borderRadius={14}
        glowRadius={28}
        colors={[p.accent, "#a78bfa", "#f472b6"]}
      >
        {inner}
      </BorderGlow>
    );
  }
  const wrap = p.wrapAttention ?? attentionEffect(p.attnStyle ?? "pulse");

  const section = (
    <section
      ref={box}
      className={`win${born ? " win--born" : ""}${p.attn ? ` win--attn-${p.attn}` : ""}${
        p.pin?.mode === "screen" ? " win--anchored" : ""
      }${p.collapsed ? " win--collapsed" : ""}`}
      style={
        {
          left: p.pos.x,
          top: p.pos.y,
          width: p.maxWidth === undefined ? p.width : Math.min(p.width, p.maxWidth),
          zIndex: p.z,
          "--acc": p.accent,
        } as CSSProperties
      }
      onPointerDownCapture={p.onFocus}
      onPointerEnter={() => {
        hovered.current = null;
      }}
      onPointerMove={tilt}
      onPointerLeave={() => {
        hovered.current = null;
        untilt();
      }}
      aria-label={p.label ?? (typeof p.title === "string" ? p.title : undefined)}
    >
      {p.attn === "you" ? wrap(framed) : framed}
    </section>
  );
  return (
    <>
      <span ref={marker} hidden />
      {createPortal(section, host)}
    </>
  );
}

/** Z-order for a set of windows: `focus(id)` raises one above all others. */
export function useFocusOrder() {
  const [order, setOrder] = useState<Record<string, number>>({});
  const top = useRef(10);
  const focus = useCallback((id: string) => {
    top.current += 1;
    const z = top.current;
    setOrder((m) => ({ ...m, [id]: z }));
  }, []);
  const z = useCallback((id: string) => order[id] ?? 1, [order]);
  return { z, focus };
}
