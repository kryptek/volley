/**
 * Auto-arrange, ported from the prototype `App.tsx` effects: when ON, arrange
 * runs 400 ms after the first layout, 120 ms after the layout key changes
 * (a window opens or closes, a wave is hidden or shown, the coordinators
 * window is toggled) and 200 ms after the last browser resize. A drag moves a
 * window without touching the layout key, so it never re-arranges. The ON/OFF
 * setting (default ON) lives in the Desk look entry, `autoArrange`.
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

/** Auto-arrange ON/OFF, persisted per browser; a missing or corrupt entry means ON. */
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
}: {
  enabled: boolean;
  layoutKey: string;
  arrange: () => void;
}): void {
  const run = useRef(arrange);
  run.current = arrange;
  const first = useRef(true);

  // biome-ignore lint/correctness/useExhaustiveDependencies: layoutKey is the trigger
  useEffect(() => {
    if (!enabled) return;
    const t = setTimeout(
      () => {
        first.current = false;
        run.current();
      },
      first.current ? FIRST_ARRANGE_MS : RELAYOUT_MS,
    );
    return () => clearTimeout(t);
  }, [layoutKey, enabled]);

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
