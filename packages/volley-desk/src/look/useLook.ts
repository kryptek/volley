/**
 * The Desk look, ported from the prototype `App.tsx` (`Look`, `LOOK0`, load /
 * save): background, dim, window chrome, Needs-you effect, narration effect,
 * tethers and auto-arrange, persisted per browser in the `volley-desk-look`
 * localStorage entry; D6's saved `autoArrange` lives in the same entry and
 * carries over. Unlike the prototype, a stored value of the wrong kind falls
 * back to its default instead of reaching the UI.
 */
import { useCallback, useState } from "react";
import { isBackground } from "./backgrounds";
import {
  ATTN_STYLES,
  type AttnStyle,
  CHROMES,
  type Chrome,
  NARRATION_FX,
  type NarrationFx,
} from "./options";

export type { NarrationFx };

/** The Desk look entry in localStorage. */
export const LOOK_STORAGE_KEY = "volley-desk-look";

export interface Look {
  bg: string;
  dim: number;
  chrome: Chrome;
  attn: AttnStyle;
  narr: NarrationFx;
  tethers: boolean;
  autoArrange: boolean;
}

export const LOOK0: Look = {
  bg: "GradientWaves",
  dim: 0.2,
  chrome: "glass",
  attn: "pulse",
  narr: "decrypt",
  tethers: true,
  autoArrange: true,
};

/** The dim slider's range (prototype: 0–0.85 in 0.05 steps). */
export const DIM_MAX = 0.85;

const oneOf =
  <T>(list: readonly T[]) =>
  (v: unknown): v is T =>
    list.includes(v as T);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isDim = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= DIM_MAX;

const VALID: { [K in keyof Look]: (v: unknown) => v is Look[K] } = {
  bg: isBackground,
  dim: isDim,
  chrome: oneOf(CHROMES),
  attn: oneOf(ATTN_STYLES),
  narr: oneOf(NARRATION_FX),
  tethers: isBool,
  autoArrange: isBool,
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
