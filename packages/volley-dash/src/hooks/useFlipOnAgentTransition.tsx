/**
 * useFlipOnAgentTransition — wraps a `Dispatch<DashAction>` so that
 * `AGENT_TRANSITION` actions trigger a GSAP Flip animation across the
 * grid cards. Status transitions change the sort order; without Flip,
 * a card moves position with a jarring snap.
 *
 * The wrapper is transparent for any other action — it passes them to
 * the raw dispatch unchanged.
 *
 * Capture order (per design-handoff "Motion specs (sum)" #12):
 *   1. `Flip.getState('[data-agent-id]')` while the DOM still reflects
 *      the pre-transition layout
 *   2. `flushSync(dispatch)` commits the reducer update synchronously
 *      so the DOM has the new positions before step 3
 *   3. `Flip.from(state, {duration: 0.28, ease: 'quart.out', absolute: true})`
 *      animates from old → new positions
 *
 * Gating:
 *   - When `prefers-reduced-motion: reduce`, the Flip cycle is skipped
 *     entirely and the dispatch runs through the React 18 batching path.
 *     Cards snap to their new positions — what reduced-motion users want.
 *   - When no `[data-agent-id]` elements are in the DOM (e.g. the grid
 *     hasn't mounted yet, or all agents are filtered out), the Flip cycle
 *     is skipped and dispatch runs untouched.
 */
import { gsap } from "gsap";
import { Flip } from "gsap/Flip";
import { useCallback } from "react";
import { flushSync } from "react-dom";
import type { DashAction } from "../state/reducer";

gsap.registerPlugin(Flip);

export function useFlipOnAgentTransition(
  rawDispatch: React.Dispatch<DashAction>,
): React.Dispatch<DashAction> {
  return useCallback(
    (action: DashAction) => {
      if (action.type !== "AGENT_TRANSITION") {
        rawDispatch(action);
        return;
      }

      if (typeof window === "undefined" || typeof document === "undefined") {
        rawDispatch(action);
        return;
      }

      const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (prefersReducedMotion) {
        rawDispatch(action);
        return;
      }

      const cards = document.querySelectorAll<HTMLElement>("[data-agent-id]");
      if (cards.length === 0) {
        rawDispatch(action);
        return;
      }

      const flipState = Flip.getState(cards);
      flushSync(() => {
        rawDispatch(action);
      });
      Flip.from(flipState, {
        duration: 0.28,
        ease: "quart.out",
        absolute: true,
      });
    },
    [rawDispatch],
  );
}
