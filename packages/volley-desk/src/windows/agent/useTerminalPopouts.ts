/**
 * The Terminal popouts' state: which agents' terminals are open, bottom to top
 * (the last is the topmost, the one Escape closes), and the text size every
 * popout shares, remembered in this browser (`TERMINAL_FONT_KEY`).
 */
import { useCallback, useState } from "react";

/** localStorage key for the popout's text size, in px. */
export const TERMINAL_FONT_KEY = "volley-desk:terminal-font-px";
export const TERMINAL_FONT_MIN = 9;
export const TERMINAL_FONT_MAX = 20;
export const TERMINAL_FONT_DEFAULT = 12;

const clamp = (px: number) => Math.max(TERMINAL_FONT_MIN, Math.min(TERMINAL_FONT_MAX, px));

function readFontPx(): number {
  try {
    const v = Number.parseInt(localStorage.getItem(TERMINAL_FONT_KEY) ?? "", 10);
    return Number.isFinite(v) ? clamp(v) : TERMINAL_FONT_DEFAULT;
  } catch {
    return TERMINAL_FONT_DEFAULT;
  }
}

export interface TerminalPopouts {
  /** Agent ids, bottom → top. */
  open: readonly string[];
  /** Opens `agentId`'s terminal, or raises it when it is already open. */
  openFor: (agentId: string) => void;
  close: (agentId: string) => void;
  raise: (agentId: string) => void;
  /** Closes the topmost; `false` when none is open. */
  closeTop: () => boolean;
  fontPx: number;
  setFontPx: (px: number) => void;
}

export function useTerminalPopouts(): TerminalPopouts {
  const [open, setOpen] = useState<readonly string[]>([]);
  const [fontPx, setFont] = useState(readFontPx);
  const raise = (id: string) =>
    setOpen((o) => (o[o.length - 1] === id ? o : [...o.filter((x) => x !== id), id]));
  const close = useCallback((id: string) => setOpen((o) => o.filter((x) => x !== id)), []);
  return {
    open,
    openFor: raise,
    close,
    raise,
    closeTop: () => {
      const top = open[open.length - 1];
      if (top === undefined) return false;
      close(top);
      return true;
    },
    fontPx,
    setFontPx: (px) => {
      const next = clamp(Math.round(px));
      setFont(next);
      try {
        localStorage.setItem(TERMINAL_FONT_KEY, String(next));
      } catch {
        // A blocked localStorage only forgets the size on reload.
      }
    },
  };
}
