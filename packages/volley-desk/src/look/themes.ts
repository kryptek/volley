/**
 * The theme registry (#364): each theme is a token set the Desk's stylesheets
 * read as CSS custom properties (`TOKEN_PROPERTY`). Volley is today's Desk and
 * its values are the `:root` block of `styles/desk.css`, so applying it writes
 * nothing (`applyLook.ts`). `THEME_IDS` fixes the picker's order; an id without
 * an entry yet falls back to Volley (`themeById`).
 */
import { oklabMix } from "./color";

export type Tone = "dark" | "light";

/** The picker's ids and names, in the approved order. */
export const THEME_LABEL = [
  ["volley", "Volley"],
  ["oceanic", "Material Oceanic"],
  ["darker", "Material Darker"],
  ["palenight", "Material Palenight"],
  ["deepocean", "Material Deep Ocean"],
  ["lighter", "Material Lighter"],
  ["dracula", "Dracula"],
  ["nightowl", "Night Owl"],
  ["onedark", "One Dark"],
  ["github", "GitHub Dark"],
  ["monokai", "Monokai Pro"],
  ["solarized", "Solarized Dark"],
] as const;

export type ThemeId = (typeof THEME_LABEL)[number][0];
export const THEME_IDS: readonly ThemeId[] = THEME_LABEL.map(([id]) => id);
/** The light-toned themes, which the picker notes (their entries may not exist yet). */
export const LIGHT_THEME_IDS: readonly ThemeId[] = ["lighter"];

/** A theme's token set. Every key but `cur1`, `cur2`, `accText` and the `*Ink` keys is required. */
export interface ThemeTokens {
  bg: string;
  bgGlow1: string;
  bgGlow2: string;
  win1: string;
  win2: string;
  panel: string;
  edge: string;
  ink: string;
  dim: string;
  mute: string;
  narr: string;
  acc: string;
  ok: string;
  link: string;
  well: string;
  pit: string;
  onAcc: string;
  onHi: string;
  shade: string;
  hl: string;
  hlStrong: string;
  cur1?: string;
  cur2?: string;
  accText?: string;
  /** Text-on-surface variants of the semantic colours; the dark default is in `:root`. */
  hotInk?: string;
  amberInk?: string;
  okInk?: string;
  badInk?: string;
  infoInk?: string;
  mineInk?: string;
}
export interface ThemeDef {
  id: ThemeId;
  name: string;
  tone: Tone;
  v: ThemeTokens;
}

/** The token → CSS custom property map (the Desk's names). */
export const TOKEN_PROPERTY: { readonly [K in keyof ThemeTokens]-?: string } = {
  bg: "--ground",
  bgGlow1: "--bg-glow1",
  bgGlow2: "--bg-glow2",
  win1: "--win1",
  win2: "--win2",
  panel: "--panel-solid",
  edge: "--line",
  ink: "--ink",
  dim: "--dim",
  mute: "--mute",
  narr: "--narr",
  acc: "--t-acc",
  ok: "--ok",
  link: "--link",
  well: "--well",
  pit: "--pit",
  onAcc: "--on-acc",
  onHi: "--on-hi",
  shade: "--shade",
  hl: "--hl",
  hlStrong: "--hl-strong",
  cur1: "--cur1",
  cur2: "--cur2",
  accText: "--acc-text",
  hotInk: "--hot-ink",
  amberInk: "--amber-ink",
  okInk: "--ok-ink",
  badInk: "--bad-ink",
  infoInk: "--info-ink",
  mineInk: "--mine-ink",
};

const OPTIONAL = new Set<keyof ThemeTokens>([
  "cur1",
  "cur2",
  "accText",
  "hotInk",
  "amberInk",
  "okInk",
  "badInk",
  "infoInk",
  "mineInk",
]);
export const REQUIRED_TOKENS = (Object.keys(TOKEN_PROPERTY) as (keyof ThemeTokens)[]).filter(
  (k) => !OPTIONAL.has(k),
);

const DARK = {
  onAcc: "#ffffff",
  onHi: "#04221e",
  shade: "rgba(0, 0, 0, 0.75)",
  hl: "rgba(255, 255, 255, 0.08)",
  hlStrong: "rgba(255, 255, 255, 0.35)",
};

/** The palettes with values. The rest of `THEME_IDS` arrive with #369 (the dark ten). */
export const THEMES: readonly ThemeDef[] = [
  // Today's Desk, verbatim from desk.css `:root` (not the mockup's approximation): T0 is zero visual change.
  {
    id: "volley",
    name: "Volley",
    tone: "dark",
    v: {
      ...DARK,
      bg: "#07080d",
      bgGlow1: "rgba(110, 231, 249, 0.07)",
      bgGlow2: "rgba(196, 181, 253, 0.06)",
      win1: "#1a1d2c",
      win2: "#0b0c15",
      panel: "#0f111b",
      edge: "rgba(214, 224, 255, 0.1)",
      ink: "#e8ecf4",
      dim: "#7c859d",
      mute: "#a3abc0",
      narr: "#dfe5f2",
      acc: "#6ee7f9",
      ok: "#4ade80",
      link: "#6ee7f9",
      well: "#080b15",
      pit: "#0b0f1c",
      cur1: "#3a7182", // AA: derived #468c9d gave white 3.8:1; these are 5.4 / 12.4
      cur2: "#1f3746",
    },
  },
  {
    id: "lighter",
    name: "Material Lighter",
    tone: "light",
    v: {
      bg: "#eceff1",
      bgGlow1: "#e0f7fa",
      bgGlow2: "#f3e5f5",
      win1: "#ffffff",
      win2: "#fafafa",
      panel: "#ffffff",
      edge: "rgba(84, 110, 122, 0.18)",
      ink: "#263238",
      dim: "#5e6c73" /* AA: #90a4ae */,
      mute: "#546e7a",
      narr: "#37474f",
      acc: "#00bcd4",
      ok: "#43a047",
      link: "#4f6b98" /* AA: #6182b8 */,
      well: "#eef1f3",
      pit: "#e7ecef",
      onAcc: "#ffffff",
      onHi: "#00363d",
      cur1: "#00798a", // AA: #00a5b8 / #00798a gave white 3.0 / 5.1; these are 5.1 / 8.4
      cur2: "#005662",
      accText: "#006974", // AA: #00838f was 3.8:1 on the surfaces
      shade: "rgba(38, 50, 56, 0.18)",
      hl: "rgba(255, 255, 255, 0.9)",
      hlStrong: "rgba(255, 255, 255, 0.6)",
      hotInk: "#a83a12",
      amberInk: "#92400e",
      okInk: "#1b5e20",
      badInk: "#b71c1c",
      infoInk: "#075985",
      mineInk: "#755c00",
    },
  },
];

const VOLLEY = THEMES[0] as ThemeDef;

/** The theme with this id; one without an entry yet is Volley. */
export function themeById(id: string): ThemeDef {
  return THEMES.find((t) => t.id === id) ?? VOLLEY;
}

/** The derived tokens, as `color-mix(in oklab, …)` computes them; a theme's explicit value wins. */
export function deriveTokens(t: ThemeDef): {
  accHi: string;
  accLo: string;
  cur1: string;
  cur2: string;
  accText: string;
} {
  const { acc, pit } = t.v;
  const accHi = oklabMix(acc, "#ffffff", 0.55);
  return {
    accHi,
    accLo: oklabMix(acc, "#000000", 0.45),
    cur1: t.v.cur1 ?? oklabMix(acc, pit, 0.62),
    cur2: t.v.cur2 ?? oklabMix(acc, pit, 0.34),
    accText: t.v.accText ?? accHi,
  };
}
