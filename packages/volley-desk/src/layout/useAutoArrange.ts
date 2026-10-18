/**
 * Auto-arrange, ported from the prototype `App.tsx` effects: when ON, arrange
 * runs 400 ms after the first layout, 120 ms after the layout key changes
 * (a window opens or closes, a wave is hidden or shown, the coordinators
 * window is toggled) and 200 ms after the last browser resize. As in the
 * prototype, only the first schedule waits 400 ms: a key change after mount
 * waits 120 ms even if the first arrange has not run yet. A drag moves a
 * window without touching the layout key, so it never re-arranges. The ON/OFF
 * setting (default ON) lives in the Desk look entry, `autoArrange`.
 *
 * `hold` (not in the prototype, which has no broker) freezes the layout key
 * while a reconnect's resync and retained replay settle: the replay rebuilds
 * the same windows, which must not re-arrange or reset the view. When the
 * hold lifts, a key that differs from the one held (a window really came or
 * went) arranges as usual.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export const FIRST_ARRANGE_MS = 400;
export const RELAYOUT_MS = 120;
export const RESIZE_MS = 200;
/** How long `world--anim` stays on after an arrange (desk.css transitions). */
export const ARRANGE_ANIM_MS = 650;
/** The Desk look entry in localStorage (D7's appearance settings share it). */
export const LOOK_STORAGE_KEY = "volley-desk-look";

function readLook(): Record<string, unknown> {
  if (typeof localStorage === "undefined") return {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LOOK_STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Auto-arrange ON/OFF, persisted per browser; a missing or corrupt entry means
 * ON. The value is per hook instance: App owns the only instance, and D7's
 * dock and appearance settings must share App's `[on, set]` (or lift this into
 * their `useLook`) rather than call it again.
 */
export function useAutoArrangeSetting(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => readLook().autoArrange !== false);
  const set = useCallback((next: boolean) => {
    setOn(next);
    try {
      localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify({ ...readLook(), autoArrange: next }));
    } catch {
      // private window: the setting lasts for this page only
    }
  }, []);
  return [on, set];
}

export function useAutoArrange({
  enabled,
  layoutKey,
  arrange,
  hold = false,
}: {
  enabled: boolean;
  layoutKey: string;
  arrange: () => void;
  /** Keep the last key seen without a hold (a reconnect is settling). */
  hold?: boolean;
}): void {
  const run = useRef(arrange);
  run.current = arrange;
  const first = useRef(true);
  const held = useRef(layoutKey);
  if (!hold) held.current = layoutKey;
  const key = held.current;

  // biome-ignore lint/correctness/useExhaustiveDependencies: key is the trigger
  useEffect(() => {
    if (!enabled) return;
    const t = setTimeout(() => run.current(), first.current ? FIRST_ARRANGE_MS : RELAYOUT_MS);
    first.current = false;
    return () => clearTimeout(t);
  }, [key, enabled]);

  useEffect(() => {
    if (!enabled) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      clearTimeout(t);
      t = setTimeout(() => run.current(), RESIZE_MS);
    };
    window.addEventListener("resize", onResize);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", onResize);
    };
  }, [enabled]);
}
