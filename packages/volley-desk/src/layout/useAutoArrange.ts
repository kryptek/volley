/**
 * Auto-arrange, ported from the prototype `App.tsx` effects: when ON, arrange
 * runs 400 ms after the first layout, 120 ms after the layout key changes
 * (a window opens or closes, a wave is hidden or shown, the coordinators
 * window is toggled) and 200 ms after the last browser resize. As in the
 * prototype, only the first schedule waits 400 ms: a key change after mount
 * waits 120 ms even if the first arrange has not run yet. A drag moves a
 * window without touching the layout key, so it never re-arranges. The ON/OFF
 * setting (default ON) is the Desk look's `autoArrange` (`look/useLook.ts`).
 *
 * `hold` (not in the prototype, which has no broker) freezes the layout key
 * while a reconnect's resync and retained replay settle: the replay rebuilds
 * the same windows, which must not re-arrange or reset the view. When the
 * hold lifts, a key that differs from the one held (a window really came or
 * went) arranges as usual.
 */
import { useEffect, useRef } from "react";

export const FIRST_ARRANGE_MS = 400;
export const RELAYOUT_MS = 120;
export const RESIZE_MS = 200;
/** How long `world--anim` stays on after an arrange (desk.css transitions). */
export const ARRANGE_ANIM_MS = 650;

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
