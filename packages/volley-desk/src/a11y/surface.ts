/**
 * The lite surface: on a touch screen, or when the user asks for reduced
 * transparency, the Desk draws its windows, dock, sheets and sign-in card
 * without `backdrop-filter` (styles/lite.css) and `liquid` renders as the CSS
 * glass. A backdrop filter re-blurs whatever is behind it on every frame the
 * canvas moves, which is a phone GPU's whole frame budget. It is automatic:
 * no setting turns it on or off.
 */
import { useEffect, useState } from "react";

export const LITE_SURFACE_QUERY =
  "(hover: none) and (pointer: coarse), (prefers-reduced-transparency: reduce)";

const query = (): MediaQueryList | null =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(LITE_SURFACE_QUERY)
    : null;

/** `true` while the Desk draws the lite surface; follows changes to the media. */
export function useLiteSurface(): boolean {
  const [lite, setLite] = useState(() => query()?.matches ?? false);
  useEffect(() => {
    const mq = query();
    if (!mq) return;
    const on = () => setLite(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return lite;
}
