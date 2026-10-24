/**
 * The look's option tables, each defined once: the Appearance segments
 * (key, label, in the prototype's order), the stored-value validators in
 * `useLook` and the `Chrome`, `AttnStyle`, `NarrationFx`, `AgentIcons` and `StepFx` types all derive
 * from them. The theme table lives with the palettes in `themes.ts`.
 */
export { THEME_LABEL } from "./themes";

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

/** The agent window's title mark: the Clawd character (#350) or the classic status ring. */
export const ICON_LABEL = [
  ["clawd", "Clawd characters"],
  ["classic", "Classic spinner"],
] as const;

/**
 * The current pipeline step's effect (`styles/stepfx.css`, keyed off `data-fx` on <html>), with
 * the line its Appearance card shows. Glint is the default; Classic is the flat look.
 */
export const STEP_FX_LABEL = [
  ["glint", "Glint", "A slow sheen sweeps across the step"],
  ["pulse", "Pulse", "A soft accent halo breathes around it"],
  ["aurora", "Aurora", "A rainbow border turns around the step"],
  ["scan", "Scanline", "A bright line scans down through it"],
  ["ember", "Ember", "Warm coals glow and flicker underneath"],
  ["liquid", "Liquid", "The step fills with a gently rolling wave"],
  ["circuit", "Circuit", "A dashed border marches around it"],
  ["prism", "Prism", "Colours drift through the step, with a glint"],
  ["classic", "Classic", "The flat look: a tinted step, no depth"],
] as const;

export type Chrome = (typeof CHROME_LABEL)[number][0];
/** The Needs-you effect; `pulse` is the owner's default. */
export type AttnStyle = (typeof ATTN_LABEL)[number][0];
export type NarrationFx = (typeof NARR_LABEL)[number][0];
export type AgentIcons = (typeof ICON_LABEL)[number][0];
export type StepFx = (typeof STEP_FX_LABEL)[number][0];

const keys = <K extends string>(table: readonly (readonly [K, string])[]): readonly K[] =>
  table.map(([k]) => k);
export const CHROMES = keys(CHROME_LABEL);
export const ATTN_STYLES = keys(ATTN_LABEL);
export const NARRATION_FX = keys(NARR_LABEL);
export const ICONS = keys(ICON_LABEL);
export const STEP_FX: readonly StepFx[] = STEP_FX_LABEL.map(([k]) => k);
