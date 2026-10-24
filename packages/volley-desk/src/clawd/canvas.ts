/**
 * The drawing routine behind every Clawd sprite, ported from the approved
 * mockup (#350): a canvas of `"x,y"` → colour that ignores out-of-grid writes,
 * Clawd's body (12 wide × 6 tall, four legs) with its eyes, and the shared
 * props (`plus`, `keyboard`). Pure: a frame is a function of `t` alone.
 */
import { C, H, W } from "./palette";

export interface Pixel {
  x: number;
  y: number;
  c: string;
}
/** A frame's pixels, sorted by `y` then `x`. */
export type Frame = readonly Pixel[];

// Clawd's body (12 wide × 6 tall) and the x of its four legs, inside the 16×14 grid.
const PX = [
  "..XXXXXXXX..",
  "..XXXXXXXX..",
  "XXXXXXXXXXXX",
  "XXXXXXXXXXXX",
  "..XXXXXXXX..",
  "..XXXXXXXX..",
];
const LEGX = [2, 4, 7, 9];

export type Eyes =
  | "normal"
  | "look-r"
  | "look-l"
  | "wide"
  | "squint"
  | "happy"
  | "shine"
  | "closed"
  | "x";

export interface ClawdOpts {
  ox?: number;
  oy?: number;
  eyes?: Eyes;
  color?: string;
  /** The length of each of the four legs. */
  legs?: readonly number[];
}

export type SetPixel = (x: number, y: number, c: string) => void;

export interface Canvas {
  px: Map<string, string>;
  set: SetPixel;
  clawd: (opts?: ClawdOpts) => void;
}

export function makeCanvas(): Canvas {
  const px = new Map<string, string>();
  const set: SetPixel = (x, y, c) => {
    if (x >= 0 && x < W && y >= 0 && y < H) px.set(`${x},${y}`, c);
  };
  const clawd = ({
    ox = 2,
    oy = 4,
    eyes = "normal",
    color = C.body,
    legs = [2, 2, 2, 2],
  }: ClawdOpts = {}) => {
    PX.forEach((row, y) => {
      [...row].forEach((ch, x) => {
        if (ch === "X") set(ox + x, oy + y, color);
      });
    });
    LEGX.forEach((lx, i) => {
      for (let k = 0; k < (legs[i] ?? 0); k++) set(ox + lx, oy + 6 + k, color);
    });
    const E = (x: number, y: number, c: string = C.eye) => set(ox + x, oy + y, c);
    switch (eyes) {
      case "look-r":
        E(5, 2);
        E(8, 2);
        break;
      case "look-l":
        E(3, 2);
        E(6, 2);
        break;
      case "wide":
        E(4, 2);
        E(4, 3);
        E(7, 2);
        E(7, 3);
        break;
      case "squint":
        E(3, 2);
        E(4, 2);
        E(7, 2);
        E(8, 2);
        E(4, 1);
        E(7, 1);
        break;
      case "happy":
        E(2, 2);
        E(3, 1);
        E(4, 2);
        E(7, 2);
        E(8, 1);
        E(9, 2);
        break;
      case "shine":
        E(4, 2, C.white);
        E(7, 2, C.white);
        break;
      case "closed":
        E(3, 2);
        E(4, 2);
        E(7, 2);
        E(8, 2);
        break;
      case "x":
        E(2, 1);
        E(4, 1);
        E(3, 2);
        E(2, 3);
        E(4, 3);
        E(7, 1);
        E(9, 1);
        E(8, 2);
        E(7, 3);
        E(9, 3);
        break;
      default:
        E(4, 2);
        E(7, 2);
    }
  };
  return { px, set, clawd };
}

/** A four-point twinkle: size 1 = one pixel, size 2 = a plus with a light centre, 0 = nothing. */
export const plus = (
  set: SetPixel,
  x: number,
  y: number,
  size: number,
  c: string,
  centre: string = C.white,
) => {
  if (size === 1) set(x, y, c);
  if (size === 2) {
    set(x, y, centre);
    set(x - 1, y, c);
    set(x + 1, y, c);
    set(x, y - 1, c);
    set(x, y + 1, c);
  }
};

/** Two keyboard rows along the bottom; one key lights cyan, walking with t. */
export const keyboard = (set: SetPixel, t: number, x0 = 1, x1 = 14, hot = true) => {
  for (let x = x0; x <= x1; x++) {
    set(x, 12, x % 2 ? C.key : C.keyHi);
    set(x, 13, C.base);
  }
  if (hot) set(x0 + ((t * 5) % (x1 - x0 + 1)), 12, C.cyan);
};

/** `a` on odd frames, `b` on even ones. */
export const alt = (t: number, a: number, b: number) => (t % 2 ? a : b);

/** A draw routine: paints frame `t` onto a fresh canvas. */
export type Draw = (t: number, s: Canvas) => void;

/** Runs `draw` for frame `t` and returns its pixels, sorted by `y` then `x`. */
export function frameOf(draw: Draw, t: number): Frame {
  const s = makeCanvas();
  draw(t, s);
  return [...s.px]
    .map(([k, c]) => {
      const [x = 0, y = 0] = k.split(",").map(Number);
      return { x, y, c };
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);
}
