/**
 * The Desk look, ported from the prototype `App.tsx` (`Look`, `LOOK0`, load /
 * save): background, dim, window chrome, Needs-you effect, narration effect,
 * tethers, auto-arrange, the theme (`themes.ts`) and the agent windows' icons (Clawd characters or the classic ring), persisted per browser in the `volley-desk-look`
 * localStorage entry; D6's saved `autoArrange` lives in the same entry and
 * carries over. The same entry keeps whether finished agents are shown (the
 * coordinators window's toggle) and after how many minutes a finished agent
 * leaves the canvas (`finishedGraceMin`, Settings › General). Unlike the
 * prototype, a stored value of the wrong kind falls back to its default
 * instead of reaching the UI.
 */
import { useCallback, useState } from "react";
import { isBackground } from "./backgrounds";
import {
  ATTN_STYLES,
  type AgentIcons,
  type AttnStyle,
  CHROMES,
  type Chrome,
  ICONS,
  NARRATION_FX,
  type NarrationFx,
} from "./options";
import { THEME_IDS, type ThemeId } from "./themes";

export type { AgentIcons, NarrationFx };

/** The Desk look entry in localStorage. */
export const LOOK_STORAGE_KEY = "volley-desk-look";

export interface Look {
  bg: string;
  dim: number;
  chrome: Chrome;
  attn: AttnStyle;
  narr: NarrationFx;
  tethers: boolean;
  /** The colour theme (`themes.ts`); Volley is today's Desk. */
  theme: ThemeId;
  /** The agent window's title mark: the Clawd character or the classic status ring. */
  icons: AgentIcons;
  autoArrange: boolean;
  /** Show agents that finished (done, failed, reaped) more than `finishedGraceMin` ago. */
  showFinished: boolean;
  /** Minutes a finished agent stays on the canvas while `showFinished` is off. */
  finishedGraceMin: number;
}

export const LOOK0: Look = {
  bg: "GradientWaves",
  dim: 0.2,
  chrome: "glass",
  attn: "pulse",
  narr: "decrypt",
  tethers: true,
  theme: "volley",
  icons: "clawd",
  autoArrange: true,
  showFinished: false,
  finishedGraceMin: 10,
};

/** The longest `finishedGraceMin` (a day). */
export const FINISHED_GRACE_MAX_MIN = 1440;

/** The dim slider's range (prototype: 0–0.85 in 0.05 steps). */
export const DIM_MAX = 0.85;

const oneOf =
  <T>(list: readonly T[]) =>
  (v: unknown): v is T =>
    list.includes(v as T);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isDim = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= DIM_MAX;
export const isGraceMin = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= FINISHED_GRACE_MAX_MIN;

const VALID: { [K in keyof Look]: (v: unknown) => v is Look[K] } = {
  bg: isBackground,
  dim: isDim,
  chrome: oneOf(CHROMES),
  attn: oneOf(ATTN_STYLES),
  narr: oneOf(NARRATION_FX),
  tethers: isBool,
  theme: oneOf(THEME_IDS),
  icons: oneOf(ICONS),
  autoArrange: isBool,
  showFinished: isBool,
  finishedGraceMin: isGraceMin,
};

function readEntry(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LOOK_STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function loadLook(): Look {
  const entry = readEntry();
  const look: Record<string, unknown> = { ...LOOK0 };
  for (const key of Object.keys(VALID) as (keyof Look)[]) {
    if (VALID[key](entry[key])) look[key] = entry[key];
  }
  return look as unknown as Look;
}

function saveLook(look: Look): void {
  try {
    localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify(look));
  } catch {
    // private window: the look lasts for this page only
  }
}

/** `[look, setLook]`: `setLook` merges a partial change and saves the result. */
export function useLook(): [Look, (change: Partial<Look>) => void] {
  const [look, setRaw] = useState<Look>(loadLook);
  const setLook = useCallback((change: Partial<Look>) => {
    setRaw((l) => {
      const next = { ...l, ...change };
      saveLook(next);
      return next;
    });
  }, []);
  return [look, setLook];
}
