/**
 * Auto-arrange, ported from the prototype `App.tsx` effects: when ON, arrange
 * runs 400 ms after the first layout (the first render with windows on the
 * canvas: `ready`) and 200 ms after the last browser resize. Nothing else
 * re-arranges (#404): a window opened or closed later, a wave hidden or shown,
 * a reconnect's resync and replay or a drag leaves every other window where it
 * is (the App places a newly opened window in free space instead, `place.ts`).
 * Turning the setting back ON arranges once. The ON/OFF setting (default ON)
 * is the Desk look's `autoArrange` (`look/useLook.ts`); Arrange & fit (the
 * Dock, `f`) arranges whatever the setting.
 */
import { useEffect, useRef } from "react";

export const FIRST_ARRANGE_MS = 400;
export const RESIZE_MS = 200;
/** How long `world--anim` stays on after an arrange (desk.css transitions). */
export const ARRANGE_ANIM_MS = 650;

export function useAutoArrange({
  enabled,
  ready,
  arrange,
}: {
  enabled: boolean;
  /** There are windows to lay out: the first layout runs once this turns true. */
  ready: boolean;
  arrange: () => void;
}): void {
  const run = useRef(arrange);
  run.current = arrange;
  const done = useRef(false);

  useEffect(() => {
    if (!enabled) {
      // Turned OFF: turning it back ON arranges again.
      done.current = false;
      return;
    }
    if (!ready || done.current) return;
    const t = setTimeout(() => {
      done.current = true;
      run.current();
    }, FIRST_ARRANGE_MS);
    return () => clearTimeout(t);
  }, [ready, enabled]);

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
