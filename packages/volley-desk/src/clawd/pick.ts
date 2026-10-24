/**
 * Which of a state's variants an agent window shows: random-looking but
 * stable, so the same agent in the same state shows the same sprite across
 * re-renders, reloads and devices, and different agents tend to differ.
 */

/** FNV-1a, 32-bit (as `store/fixtures.ts` `hash`). */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h;
}

/** The variant index in `[0, n)` for `agentId` in `state`. */
export function pickVariant(agentId: string, state: string, n: number): number {
  return n > 0 ? fnv1a(`${agentId}\u0000${state}`) % n : 0;
}
