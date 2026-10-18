/**
 * The window frame, ported from the prototype `windows.tsx` `Frame`: title
 * bar drag (pointer delta ÷ zoom scale), focus on any pointer-down, the
 * `win--born` entrance kept for 4 s, and `ResizeObserver` sizing via `onSize`.
 * Chromes here are `glass` and `solid`; the React Bits chromes and the
 * electric/star Needs-you effects plug in later through `chrome` and the
 * `wrapAttention` slot.
 */
import type React from "react";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

export type Chrome = "glass" | "solid";
export type Attention = "you" | "coordinator" | "info";

/** How long a new window keeps its `win--born` class. */
export const BORN_MS = 4000;

export interface FrameProps {
  id: string;
  title: ReactNode;
  accent: string;
  pos: { x: number; y: number };
  width: number;
  z: number;
  scale: number;
  chrome: Chrome;
  attn?: Attention;
  /** Wraps the framed window when it needs attention (pulse, electric border, …). */
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
      aria-label={typeof p.title === "string" ? p.title : undefined}
    >
      {p.wrapAttention ? p.wrapAttention(inner) : inner}
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
