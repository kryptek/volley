/**
 * The one 8 fps clock every Clawd sprite draws from: a module-level interval
 * that starts with the first subscriber and stops with the last (never a
 * timer per sprite), read through `useSyncExternalStore` so a tick re-renders
 * the sprites only. It stops while the page is hidden, and never runs under
 * `prefers-reduced-motion: reduce`, where every sprite shows frame 0.
 */
import { useSyncExternalStore } from "react";
import { REDUCED_MOTION_QUERY } from "../a11y/motion";

/** 8 fps. */
export const CLAWD_FRAME_MS = 125;

const listeners = new Set<() => void>();
let tick = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let reduced = false;
let mq: MediaQueryList | null = null;

const emit = () => {
  for (const l of listeners) l();
};

function sync(): void {
  const run = listeners.size > 0 && !reduced && !document.hidden;
  if (run && timer === null) {
    timer = setInterval(() => {
      tick++;
      emit();
    }, CLAWD_FRAME_MS);
  } else if (!run && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

const onVisibility = () => sync();
const onMotion = () => {
  reduced = mq?.matches ?? false;
  sync();
  emit();
};

export function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    mq = typeof window.matchMedia === "function" ? window.matchMedia(REDUCED_MOTION_QUERY) : null;
    reduced = mq?.matches ?? false;
    mq?.addEventListener?.("change", onMotion);
    document.addEventListener("visibilitychange", onVisibility);
  }
  listeners.add(listener);
  sync();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      mq?.removeEventListener?.("change", onMotion);
      mq = null;
      document.removeEventListener("visibilitychange", onVisibility);
    }
    sync();
  };
}

/** The current frame: `0` under reduced motion. */
export const getSnapshot = (): number => (reduced ? 0 : tick);

/** The shared frame counter `t` (8 fps). */
export function useClawdTick(): number {
  return useSyncExternalStore(subscribe, getSnapshot, () => 0);
}
