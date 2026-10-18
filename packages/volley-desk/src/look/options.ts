/**
 * The look's option tables, each defined once: the Appearance segments
 * (key, label, in the prototype's order), the stored-value validators in
 * `useLook` and the `Chrome`, `AttnStyle` and `NarrationFx` types all derive
 * from them.
 */
export const CHROME_LABEL = [
  ["glass", "Frosted glass"],
  ["liquid", "Liquid glass"],
  ["spotlight", "Spotlight"],
  ["glow", "Border glow"],
  ["solid", "Solid"],
] as const;
export const ATTN_LABEL = [
  ["electric", "Electric border"],
  ["star", "Star border"],
  ["pulse", "Pulse"],
] as const;
export const NARR_LABEL = [
  ["decrypt", "Decrypt"],
  ["shiny", "Shiny"],
  ["plain", "Plain"],
] as const;

export type Chrome = (typeof CHROME_LABEL)[number][0];
/** The Needs-you effect; `pulse` is the owner's default. */
export type AttnStyle = (typeof ATTN_LABEL)[number][0];
export type NarrationFx = (typeof NARR_LABEL)[number][0];

const keys = <K extends string>(table: readonly (readonly [K, string])[]): readonly K[] =>
  table.map(([k]) => k);
export const CHROMES = keys(CHROME_LABEL);
export const ATTN_STYLES = keys(ATTN_LABEL);
export const NARRATION_FX = keys(NARR_LABEL);
