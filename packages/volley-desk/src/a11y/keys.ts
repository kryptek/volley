/**
 * The Desk's keyboard (D8). With the stage focused the arrow keys pan; from
 * anywhere but a text field `+` / `-` zoom around the centre and `f` runs
 * arrange & fit; Escape closes the top dialog (a wave's settings or the
 * Settings window, then the steering panel). Modified keys are left to the browser (⌘F is find)
 * and a key a control already handled (`preventDefault`, or stopped like the
 * settings field's Escape) does nothing here. Inside a modal dialog only
 * Escape reaches the Desk: the canvas behind the scrim keeps still.
 * `useFocusTrap` keeps Tab inside a modal.
 */
import { type RefObject, useEffect, useRef } from "react";

/** Screen pixels per arrow key press. */
export const PAN_STEP = 80;
/** Zoom factor per `+` / `-` press. */
export const ZOOM_STEP = 1.2;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** The keyboard-reachable elements inside `root`, in DOM order. */
export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.closest("[inert], [hidden]") && el.getAttribute("aria-hidden") !== "true",
  );
}

/** Text fields keep their keys: typing `f` in a search box must not arrange the Desk. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (!(target instanceof HTMLInputElement)) return false;
  return !["button", "checkbox", "radio", "range", "submit", "reset", "color"].includes(
    target.type,
  );
}

/** A modal dialog owns the keyboard: `f` and `+` / `-` must not act on the canvas behind it. */
export const inModal = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest('[aria-modal="true"]') !== null;

export interface DeskKeys {
  stageRef: RefObject<HTMLElement | null>;
  panBy: (dx: number, dy: number) => void;
  zoomAt: (factor: number) => void;
  arrange: () => void;
  /** Closes the top dialog; `false` when none is open. */
  closeTop: () => boolean;
}

const PAN: Record<string, [number, number]> = {
  ArrowLeft: [PAN_STEP, 0],
  ArrowRight: [-PAN_STEP, 0],
  ArrowUp: [0, PAN_STEP],
  ArrowDown: [0, -PAN_STEP],
};

export function useDeskKeys(keys: DeskKeys): void {
  const latest = useRef(keys);
  latest.current = keys;
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = latest.current;
      if (e.key === "Escape") {
        if (k.closeTop()) e.preventDefault();
        return;
      }
      if (isTyping(e.target) || inModal(e.target)) return;
      const pan = PAN[e.key];
      if (pan) {
        if (e.target !== k.stageRef.current) return;
        e.preventDefault();
        k.panBy(...pan);
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        k.zoomAt(ZOOM_STEP);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        k.zoomAt(1 / ZOOM_STEP);
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        k.arrange();
      }
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, []);
}

/** Keeps Tab and Shift+Tab cycling inside `ref` while it is mounted. */
export function useFocusTrap(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const down = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusables(root);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        e.preventDefault();
        root.focus();
        return;
      }
      const at = document.activeElement;
      const outside = !(at instanceof Node) || !root.contains(at) || at === root;
      if (e.shiftKey && (at === first || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || outside)) {
        e.preventDefault();
        first.focus();
      }
    };
    root.addEventListener("keydown", down);
    return () => root.removeEventListener("keydown", down);
  }, [ref]);
}
