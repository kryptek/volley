/**
 * The Terminal tab's popout: the agent's screen in a floating, macOS-style
 * window in screen space (not a canvas `Frame`: it neither pans nor zooms).
 * Traffic lights (the red one closes; the others are decoration), the agent id
 * with its task and role chips, and a −/+ text size shared by every popout. It
 * renders the store's `agent.screen` through `Terminal`, so a new retained
 * capture updates it in place and `screen_stale` shows `stale` as on the card.
 * No wrapping: it opens as wide as the screen's longest line (in `ch`, at
 * least 80) where the viewport allows and scrolls sideways otherwise; drag
 * it by the title bar, resize it from the corner. Not modal: several can be
 * open and the canvas stays usable, but Tab is kept inside, focus goes back to
 * the ⤢ that opened it, and Escape (`useDeskKeys` in the App) closes the
 * topmost. Below `NARROW_PX` it is a full-screen sheet with no drag or resize.
 * With `onSize` it reports the text box's size in cells once it holds for
 * `TERMINAL_RESIZE_DEBOUNCE_MS` (on open, on a resize, on a text size change),
 * and `"launch"` when it closes: volleyd sizes the agent's terminal to match
 * (#403), so its program wraps at the popout's width.
 */
import { type PointerEvent, useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../../a11y/keys";
import type { NoSignal } from "../../attention";
import { NARROW_PX } from "../../canvas/useViewport";
import { TERMINAL_RESIZE_DEBOUNCE_MS, type TerminalSize } from "../../steer/terminalResize";
import type { AgentView, WaveView } from "../../store/types";
import { ROLE_LABEL, terminalProps } from "./AgentWindow";
import { Terminal } from "./Terminal";
import "../../styles/agent.css";
import "../../styles/popout.css";

/** Each popout opens this much below and right of the one before it. */
export const POPOUT_CASCADE_PX = 24;
/** The first popout's top-left corner (clear of the top bar). */
const ORIGIN = { x: 24, y: 64 };
/** How much of a dragged window stays on screen. */
const KEEP_PX = 80;
/** The narrowest terminal it opens at, in columns. */
const MIN_COLS = 80;
/**
 * Everything across the window that is not text: the popout's border (2), the
 * terminal's margin (16), its recessed border (2) and padding (20), and the
 * scrollbar gutter `.term--popout` reserves (16).
 */
export const POPOUT_CHROME_PX = 56;

/** The window's CSS width: the terminal's columns plus its chrome, capped by the viewport. */
export const popoutWidth = (cols: number): string =>
  `min(calc(100vw - 32px), calc(${cols}ch + ${POPOUT_CHROME_PX}px))`;

/** The cell counts volleyd accepts for a terminal (its `terminal_resize` bounds). */
export const TERMINAL_CELLS = { min: 20, max: 500 } as const;
/** The terminal's line height, as a multiple of its text size (`.term` in agent.css). */
const LINE_HEIGHT = 1.55;

/**
 * The cells a text box of `box` px holds at `cell` px per cell, less the caret's row; null
 * when nothing is laid out (a cell or the box measures 0).
 */
export function fitCells(
  box: { width: number; height: number },
  cell: { width: number; height: number },
): { cols: number; rows: number } | null {
  if (!(cell.width > 0 && cell.height > 0 && box.width > 0 && box.height > 0)) return null;
  const fit = (n: number) =>
    Math.max(TERMINAL_CELLS.min, Math.min(TERMINAL_CELLS.max, Math.floor(n)));
  return { cols: fit(box.width / cell.width), rows: fit(box.height / cell.height - 1) };
}

/** The text box of the popout's terminal and one cell of its font, in px. */
function measure(
  term: HTMLElement,
  probe: HTMLElement,
  fontPx: number,
): { cols: number; rows: number } | null {
  const cs = getComputedStyle(term);
  const px = (v: string) => Number.parseFloat(v) || 0;
  const lineHeight = px(cs.lineHeight) || fontPx * LINE_HEIGHT;
  const box = {
    width: term.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight),
    height: term.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom),
  };
  // The probe is PROBE_CHARS zeros in the terminal's font: one cell is a tenth of it.
  const cell = { width: probe.getBoundingClientRect().width / PROBE_CHARS, height: lineHeight };
  return fitCells(box, cell);
}

const PROBE_CHARS = 10;

/**
 * Report the terminal's size in cells to `onSize` once it holds for the debounce, on open and
 * whenever the box or the text size changes; `"launch"` on unmount, if a size was sent.
 */
function useTerminalCells(
  ref: { current: HTMLElement | null },
  probe: { current: HTMLElement | null },
  fontPx: number,
  onSize: ((size: TerminalSize) => void) | undefined,
) {
  const sent = useRef<string | null>(null);
  const report = useRef(onSize);
  report.current = onSize;
  const enabled = onSize !== undefined;
  useEffect(() => {
    if (!enabled) return;
    const term = ref.current?.querySelector<HTMLElement>(".term--popout");
    if (!term) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const size = probe.current ? measure(term, probe.current, fontPx) : null;
        const key = size && `${size.cols}x${size.rows}`;
        if (size === null || key === sent.current) return;
        sent.current = key;
        report.current?.(size);
      }, TERMINAL_RESIZE_DEBOUNCE_MS);
    };
    schedule();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    observer?.observe(term);
    return () => {
      clearTimeout(timer);
      observer?.disconnect();
    };
  }, [enabled, fontPx, ref, probe]);
  // Closing (any way: the red light, Escape, the agent leaving) hands the terminal back.
  useEffect(
    () => () => {
      if (sent.current !== null) report.current?.("launch");
    },
    [],
  );
}

/** The screen's widest line in code points (a powerline glyph is one column), at least 80. */
export function columns(lines: readonly string[] | undefined): number {
  return Math.max(MIN_COLS, ...(lines ?? []).map((l) => [...l].length));
}

export interface TerminalPopoutProps {
  agent: AgentView;
  wave: WaveView | undefined;
  noSignal?: NoSignal | null;
  /** Stacking order within the popout layer (the topmost is highest). */
  z: number;
  /** How many popouts were open before this one: its cascade step. */
  cascade?: number;
  onClose: () => void;
  onRaise: () => void;
  fontPx: number;
  /** Adds `delta` px to the shared text size (the owner clamps it to 9–20). */
  onFont: (delta: number) => void;
  /** The terminal's size in cells, debounced; `"launch"` once it closes (`terminal_resize`). */
  onSize?: (size: TerminalSize) => void;
}

export function TerminalPopout({
  agent,
  wave,
  noSignal = null,
  z,
  cascade = 0,
  onClose,
  onRaise,
  fontPx,
  onFont,
  onSize,
}: TerminalPopoutProps) {
  const ref = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  useTerminalCells(ref, probe, fontPx, onSize);
  const sheet = window.innerWidth < NARROW_PX;
  const [pos, setPos] = useState(() => ({
    x: ORIGIN.x + cascade * POPOUT_CASCADE_PX,
    y: ORIGIN.y + cascade * POPOUT_CASCADE_PX,
  }));
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  useFocusTrap(ref);
  useEffect(() => {
    const opener = document.activeElement;
    ref.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const task = agent.task;
  const role = agent.role ? ROLE_LABEL[agent.role] : null;
  const cols = columns(agent.screen?.lines);

  const down = (e: PointerEvent<HTMLDivElement>) => {
    // The traffic lights and the size buttons are controls, not handles.
    if (e.button !== 0 || (e.target as Element).closest("button")) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const w = ref.current?.offsetWidth ?? 0;
    setPos({
      x: Math.max(
        Math.min(0, KEEP_PX - w),
        Math.min(window.innerWidth - KEEP_PX, e.clientX - d.dx),
      ),
      y: Math.max(0, Math.min(window.innerHeight - KEEP_PX / 2, e.clientY - d.dy)),
    });
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  return (
    <div
      ref={ref}
      // biome-ignore lint/a11y/useSemanticElements: a non-modal floating window, as the Desk's sheets
      role="dialog"
      aria-modal="false"
      aria-label={`Terminal: ${agent.id}`}
      tabIndex={-1}
      className={`popout${sheet ? " popout--sheet" : ""}`}
      style={
        sheet
          ? { zIndex: z }
          : {
              zIndex: z,
              left: `${pos.x}px`,
              top: `${pos.y}px`,
              fontSize: `${fontPx}px`,
              width: popoutWidth(cols),
            }
      }
      onPointerDownCapture={onRaise}
    >
      <div
        className="popout-bar"
        {...(sheet
          ? {}
          : { "data-drag-handle": "", onPointerDown: down, onPointerMove: move, onPointerUp: up })}
      >
        <span className="popout-lights">
          <button
            type="button"
            className="popout-light popout-light--close"
            aria-label="Close terminal window"
            title="Close"
            onClick={onClose}
          />
          <i className="popout-light popout-light--min" aria-hidden />
          <i className="popout-light popout-light--zoom" aria-hidden />
        </span>
        <span className="popout-title ell min0">
          <b className="mono" title={agent.id}>
            {agent.id}
          </b>
          {task && <span className="chip">{task}</span>}
          {role && <span className="chip chip--role">{role}</span>}
        </span>
        <span className="popout-size">
          <button
            type="button"
            className="icon-btn"
            aria-label="Smaller terminal text"
            title="Smaller text"
            onClick={() => onFont(-1)}
          >
            −
          </button>
          <span className="mono dim">{fontPx}px</span>
          <button
            type="button"
            className="icon-btn"
            aria-label="Larger terminal text"
            title="Larger text"
            onClick={() => onFont(1)}
          >
            +
          </button>
        </span>
      </div>
      <Terminal
        {...terminalProps(agent, wave, noSignal)}
        className="term--popout"
        style={{ fontSize: `${fontPx}px` }}
      />
      <span ref={probe} className="popout-probe" style={{ fontSize: `${fontPx}px` }} aria-hidden>
        {"0".repeat(PROBE_CHARS)}
      </span>
    </div>
  );
}
