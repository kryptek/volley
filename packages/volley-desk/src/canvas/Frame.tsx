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
 */
import type React from "react";
import "../styles/attention.css";
import "../styles/look.css";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import BorderGlow from "../rb/BorderGlow/BorderGlow";
import ElectricBorder from "../rb/ElectricBorder/ElectricBorder";
import GlassSurface from "../rb/GlassSurface/GlassSurface";
import SpotlightCard from "../rb/SpotlightCard/SpotlightCard";
import StarBorder from "../rb/StarBorder/StarBorder";

export type Chrome = "glass" | "liquid" | "spotlight" | "glow" | "solid";
export type Attention = "you" | "coordinator" | "info";
/** The Needs-you effect; `pulse` is the owner's default. */
export type AttnStyle = "electric" | "star" | "pulse";
/** The Needs-you colour (prototype `--hot`). */
const HOT = "#ff7a59";

/** How long a new window keeps its `win--born` class. */
export const BORN_MS = 4000;

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
  born?: boolean;
}

export function Frame(p: FrameProps) {
  const last = useRef<{ x: number; y: number } | null>(null);
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

  const down = (e: React.PointerEvent) => {
    if ((e.target as Element).closest("button")) return;
    last.current = { x: e.clientX, y: e.clientY };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    if (!last.current) return;
    p.onMove((e.clientX - last.current.x) / p.scale, (e.clientY - last.current.y) / p.scale);
    last.current = { x: e.clientX, y: e.clientY };
  };
  const up = () => {
    last.current = null;
  };

  const inner = (
    <div className={`win-inner chrome-${p.chrome}`}>
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
        <div className="win-actions">{p.actions}</div>
      </header>
      <div className="win-body">{p.children}</div>
      {p.footer && <footer className="win-foot">{p.footer}</footer>}
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

  return (
    <section
      ref={box}
      className={`win${born ? " win--born" : ""}${p.attn ? ` win--attn-${p.attn}` : ""}`}
      style={
        {
          left: p.pos.x,
          top: p.pos.y,
          width: p.width,
          zIndex: p.z,
          "--acc": p.accent,
        } as CSSProperties
      }
      onPointerDownCapture={p.onFocus}
      aria-label={p.label ?? (typeof p.title === "string" ? p.title : undefined)}
    >
      {p.attn === "you" ? wrap(framed) : framed}
    </section>
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
