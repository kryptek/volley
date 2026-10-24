/**
 * The agent-window Clawd's grid and colours (the approved pixel spec, #350):
 * a 16×14 grid, origin top-left, drawn at 8 fps.
 */
export const W = 16;
export const H = 14;

export const C = {
  body: "#d97757",
  bodyHi: "#f09a7a",
  eye: "#151826",
  white: "#f3f5fa",
  key: "#566079",
  keyHi: "#7d89a6",
  base: "#353d55",
  cyan: "#79c0ff",
  green: "#7ee787",
  grey: "#9aa4bd",
  steel: "#c9d1d9",
  paper: "#eef1f6",
  ink: "#9aa3b5",
  gold: "#f2cc60",
  yellow: "#ffe58f",
  red: "#ff6b5e",
  brown: "#9a6a3a",
  pink: "#ff8bd1",
  violet: "#b392f0",
  steam: "#aab3c8",
} as const;

/** The darker body of the `failed` sprite. */
export const BODY_FAILED = "#b0634a";
/** The Halo's shadow on the floor. */
export const SHADOW = "#2a3150";
/** A code bit near the top of the Code stream, fading out. */
export const CODE_DIM = "#3f7a4a";
