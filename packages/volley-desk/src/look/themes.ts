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

/** The palettes with values: Volley, Material Lighter (#368) and the ten dark palettes (#369). */
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
  {
    id: "oceanic",
    name: "Material Oceanic",
    tone: "dark",
    v: {
      ...DARK,
      bg: "#1e272c",
      bgGlow1: "#263238",
      bgGlow2: "#1b2b33",
      win1: "#2b3a42",
      win2: "#263238",
      panel: "#32424a",
      edge: "rgba(176, 190, 197, 0.12)",
      ink: "#eeffff",
      dim: "#98afb6" /* AA: #607b86 */,
      mute: "#b0bec5",
      narr: "#d7e3e8",
      acc: "#009688",
      ok: "#c3e88d",
      link: "#82aaff",
      well: "#1e272c",
      pit: "#222e34",
    },
  },
  {
    id: "darker",
    name: "Material Darker",
    tone: "dark",
    v: {
      ...DARK,
      bg: "#1a1a1a",
      bgGlow1: "#2a2116",
      bgGlow2: "#1c1c1c",
      win1: "#262626",
      win2: "#212121",
      panel: "#2a2a2a",
      edge: "rgba(255, 255, 255, 0.08)",
      ink: "#eeffff",
      dim: "#8d9191" /* AA: #6b6b6b */,
      mute: "#b0bec5",
      narr: "#d9d9d9",
      acc: "#ff9800",
      ok: "#c3e88d",
      link: "#82aaff",
      well: "#171717",
      pit: "#1c1c1c",
      onHi: "#2b1600",
      cur1: "#ad6200", // AA: #e08600 / #a65f00 gave white 2.8 / 4.9; these are 4.6 / 7.9
      cur2: "#7a4400",
    },
  },
  {
    id: "palenight",
    name: "Material Palenight",
    tone: "dark",
    v: {
      ...DARK,
      bg: "#202331",
      bgGlow1: "#3a2d5c",
      bgGlow2: "#22263a",
      win1: "#2f3347",
      win2: "#292d3e",
      panel: "#34324a",
      edge: "rgba(166, 172, 205, 0.14)",
      ink: "#eeffff",
      dim: "#929db9" /* AA: #676e95 */,
      mute: "#a6accd",
      narr: "#d6daf0",
      acc: "#ab47bc",
      ok: "#c3e88d",
      link: "#82aaff",
      well: "#1c1f2b",
      pit: "#232637",
    },
  },
  {
    id: "deepocean",
    name: "Material Deep Ocean",
    tone: "dark",
    v: {
      ...DARK,
      bg: "#090b10",
      bgGlow1: "#0b1a2e",
      bgGlow2: "#0b1220",
      win1: "#141824",
      win2: "#0f111a",
      panel: "#181c29",
      edge: "rgba(143, 147, 162, 0.12)",
      ink: "#eeffff",
      dim: "#7a8498" /* AA: #4b526d */,
      mute: "#8f93a2",
      narr: "#cdd3e0",
      acc: "#84ffff",
      ok: "#c3e88d",
      link: "#82aaff",
      well: "#07080c",
      pit: "#0b0d14",
      onAcc: "#041a1a",
      onHi: "#041a1a",
      cur1: "#84ffff",
      cur2: "#45cfcf",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    tone: "dark",
    v: {
      ...DARK,
      bg: "#21222c",
      bgGlow1: "#3b2a4d",
      bgGlow2: "#282a36",
      win1: "#2f3142",
      win2: "#282a36",
      panel: "#343746",
      edge: "rgba(98, 114, 164, 0.25)",
      ink: "#f8f8f2",
      dim: "#94a0c0" /* AA: #6272a4 */,
      mute: "#bdc3dd",
      narr: "#e9e9e4",
      acc: "#bd93f9",
      ok: "#50fa7b",
      link: "#8be9fd",
      well: "#1e1f29",
      pit: "#242632",
      onHi: "#1c0f33",
    },
  },
  {
    id: "nightowl",
    name: "Night Owl",
    tone: "dark",
    v: {
      ...DARK,
      bg: "#011627",
      bgGlow1: "#0b2942",
      bgGlow2: "#01111d",
      win1: "#0b2338",
      win2: "#011627",
      panel: "#0b253a",
      edge: "rgba(95, 126, 151, 0.22)",
      ink: "#d6deeb",
      dim: "#718da4" /* AA: #5f7e97 */,
      mute: "#a6b5c7",
      narr: "#d6deeb",
      acc: "#7e57c2",
      ok: "#addb67",
      link: "#82aaff",
      well: "#010e1a",
      pit: "#021320",
    },
  },
  {
    id: "onedark",
    name: "One Dark",
    tone: "dark",
    v: {
      ...DARK,
      bg: "#21252b",
      bgGlow1: "#2c313c",
      bgGlow2: "#21252b",
      win1: "#2c313a",
      win2: "#282c34",
      panel: "#2f343e",
      edge: "rgba(171, 178, 191, 0.12)",
      ink: "#e6e9ef",
      dim: "#979da7" /* AA: #5c6370 */,
      mute: "#abb2bf",
      narr: "#d7dae0",
      acc: "#61afef",
      ok: "#98c379",
      link: "#c980df" /* AA: #c678dd */,
      well: "#1e2227",
      pit: "#23272e",
      onHi: "#08223a",
    },
  },
  {
    id: "github",
    name: "GitHub Dark",
    tone: "dark",
    v: {
      ...DARK,
      bg: "#010409",
      bgGlow1: "#0d1b2a",
      bgGlow2: "#0d1117",
      win1: "#161b22",
      win2: "#0d1117",
      panel: "#161b22",
      edge: "rgba(240, 246, 252, 0.10)",
      ink: "#f0f6fc",
      dim: "#7d8590",
      mute: "#c9d1d9",
      narr: "#e6edf3",
      acc: "#2f81f7",
      ok: "#3fb950",
      link: "#a5d6ff",
      well: "#010409",
      pit: "#0a0e14",
    },
  },
  {
    id: "monokai",
    name: "Monokai Pro",
    tone: "dark",
    v: {
      ...DARK,
      bg: "#221f22",
      bgGlow1: "#3a3020",
      bgGlow2: "#2d2a2e",
      win1: "#353036",
      win2: "#2d2a2e",
      panel: "#363237",
      edge: "rgba(252, 252, 250, 0.10)",
      ink: "#fcfcfa",
      dim: "#9c9b9b" /* AA: #727072 */,
      mute: "#c1c0c0",
      narr: "#e8e8e6",
      acc: "#ffd866",
      ok: "#a9dc76",
      link: "#78dce8",
      well: "#1f1c1f",
      pit: "#262326",
      onAcc: "#2d2a2e",
      onHi: "#2d2a2e",
      cur1: "#ffd866",
      cur2: "#d9b34a",
    },
  },
  {
    id: "solarized",
    name: "Solarized Dark",
    tone: "dark",
    v: {
      ...DARK,
      bg: "#00212b",
      bgGlow1: "#073642",
      bgGlow2: "#002b36",
      win1: "#073642",
      win2: "#002b36",
      panel: "#0a3a47",
      edge: "rgba(147, 161, 161, 0.16)",
      ink: "#eee8d5",
      dim: "#949f9c" /* AA: #586e75 */,
      mute: "#93a1a1",
      narr: "#c9d2d0",
      acc: "#268bd2",
      ok: "#859900",
      link: "#52aba0" /* AA: #2aa198 */,
      well: "#001f27",
      pit: "#00252f",
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
