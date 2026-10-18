/**
 * Wave accent colour: an FNV-1a hash of the wave id picks a palette entry, so
 * every client paints a wave (and its agents and tethers) the same colour
 * with no shared state.
 */
export const ACCENT_PALETTE: readonly string[] = [
  "#6ee7f9",
  "#fbbf24",
  "#c4b5fd",
  "#f9a8d4",
  "#86efac",
  "#fdba74",
  "#93c5fd",
  "#5eead4",
];

/** For the `unassigned` pseudo-wave and anything without a wave. */
export const NEUTRAL_ACCENT = "#a3abc0";

export function accentFor(waveId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < waveId.length; i++) h = Math.imul(h ^ waveId.charCodeAt(i), 0x01000193);
  return ACCENT_PALETTE[(h >>> 0) % ACCENT_PALETTE.length] as string;
}
