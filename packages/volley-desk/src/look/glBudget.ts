/**
 * The page's budget of live WebGL contexts for Specular buttons (#417). Every `SpecularButton`
 * draws its rim on a WebGL2 context of its own, and browsers cap live contexts per page
 * (Chromium: 16), evicting the oldest past the cap: a burst of Needs-you cards painted their
 * buttons' lost canvases as white boxes. A button asks for a slot before it calls `getContext`;
 * refused, it renders flat (`.specular-button--flat`) and upgrades when a slot frees.
 */

/** Live Specular contexts per page; the rest of the page's WebGL (the background) stays clear of the cap. */
export const GL_BUTTON_BUDGET = 6;

export interface GlBudget {
  /** A slot for `id` (already held: still granted); `false` once `limit` are held. */
  acquire(id: string): boolean;
  release(id: string): void;
  /** Called after every release (for `useSyncExternalStore`); returns the unsubscribe. */
  subscribe(fn: () => void): () => void;
  /** How many slots are held. */
  live(): number;
  /** How many releases so far: `useSyncExternalStore`'s snapshot (a waiting button retries on each). */
  releases(): number;
}

export function createGlBudget(limit: number): GlBudget {
  const held = new Set<string>();
  const listeners = new Set<() => void>();
  let releases = 0;
  return {
    acquire(id) {
      if (held.has(id)) return true;
      if (held.size >= limit) return false;
      held.add(id);
      return true;
    },
    release(id) {
      if (!held.delete(id)) return;
      releases++;
      for (const fn of [...listeners]) fn();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    live: () => held.size,
    releases: () => releases,
  };
}

const page = createGlBudget(GL_BUTTON_BUDGET);

export const acquireGl = page.acquire;
export const releaseGl = page.release;
export const subscribeGl = page.subscribe;
export const glBudgetLive = page.live;
export const glBudgetReleases = page.releases;
