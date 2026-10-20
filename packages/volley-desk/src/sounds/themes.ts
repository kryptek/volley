/**
 * The Desk's twelve sound themes: id, label and the one-line sonic brief the
 * generation prompts (`sounds/prompts.yaml`) turn into each theme's style.
 * A theme's clips live in `public/sounds/<id>/` with a `manifest.json`.
 */

export interface ThemeDef {
  id: string;
  label: string;
  brief: string;
}

export const THEMES = [
  {
    id: "synthwave",
    label: "Synthwave",
    brief:
      "80s analogue synth: short saw and square blips, soft neon pads on success, a low detuned thud on failure.",
  },
  {
    id: "arcade",
    label: "Arcade 8-bit",
    brief:
      "NES-style square and triangle chiptune: 1-bit clicks, two-note rising jingles, a descending buzz on failure.",
  },
  {
    id: "glass",
    label: "Glass",
    brief:
      "Struck crystal and wine-glass tones: bell-like, airy, long but quiet tails; cracked-glass tick for failure.",
  },
  {
    id: "soft-ui",
    label: "Soft UI",
    brief:
      "Rounded, muted sine pops and gentle marimba taps: the quietest theme, nothing above a whisper.",
  },
  {
    id: "mech-keys",
    label: "Mechanical keyboard",
    brief:
      "Tactile switch clicks, keycap thocks, a spacebar for drops, a key-chord for success, a stuck-key rattle for failure.",
  },
  {
    id: "sci-fi",
    label: "Sci-fi bridge",
    brief:
      "Starship console: filtered sweeps, confirmation chirps, a klaxon-shaped low tone for failure, a warp swell for wave start.",
  },
  {
    id: "wood",
    label: "Nature / wood",
    brief:
      "Wood blocks, bamboo chimes, pebbles and a water drop for drops; a dull knock for failure, birdsong fragment for success.",
  },
  {
    id: "retro-mac",
    label: "Retro Mac",
    brief:
      "Early-90s desktop: sampled-sounding boops, a drawer slide for panels, a startup-chord fragment for wave start, a classic quack on failure.",
  },
  {
    id: "pizzicato",
    label: "Orchestral pizzicato",
    brief:
      "Plucked strings and a harp glissando for success, a low cello pluck for failure, a timpani touch for wave events.",
  },
  {
    id: "lo-fi",
    label: "Lo-fi tape",
    brief:
      "Cassette-warm keys and tape stops: wow-and-flutter chords, a tape-stop for failure, a rewind for drag start.",
  },
  {
    id: "space",
    label: "Space ambient",
    brief:
      "Deep pads and soft sub pulses: a distant ping for clicks, a slow bloom for success, a hollow drop for failure.",
  },
  {
    id: "minimal",
    label: "Minimal clicks",
    brief:
      "Barely-there ticks and single sine dots: the theme for people who want feedback, not music.",
  },
] as const satisfies readonly ThemeDef[];

export type ThemeId = (typeof THEMES)[number]["id"];

export const DEFAULT_THEME: ThemeId = "synthwave";

export const isThemeId = (v: unknown): v is ThemeId => THEMES.some((t) => t.id === v);
