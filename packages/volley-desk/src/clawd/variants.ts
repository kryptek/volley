/**
 * The agent window's Clawd sprites (the approved pixel spec, #350): three
 * variants for each pipeline step and one for each rest state. The frame
 * logic is the mockup's, line for line; `failed` and `done` are still.
 */
import { type Canvas, type Draw, type Frame, alt, frameOf, keyboard, plus } from "./canvas";
import { BODY_FAILED, C, CODE_DIM, SHADOW } from "./palette";

export const CLAWD_STATES = [
  "implement",
  "review",
  "fixup",
  "merge_ready",
  "done",
  "failed",
  "needs_you",
  "dozing",
] as const;
export type ClawdState = (typeof CLAWD_STATES)[number];

/** The sprite's accessible name (and `title`) per state. */
export const CLAWD_LABEL: Record<ClawdState, string> = {
  implement: "implementing",
  review: "reviewing",
  fixup: "fixing up",
  merge_ready: "merge-ready",
  done: "done",
  failed: "failed",
  needs_you: "needs you",
  dozing: "waiting",
};

export interface Variant {
  name: string;
  frame: (t: number) => Frame;
}

const v = (name: string, draw: Draw): Variant => ({ name, frame: (t) => frameOf(draw, t) });
const typing = (t: number) => [alt(t, 1, 2), 2, 2, alt(t, 2, 1)];
const at = (list: readonly number[], i: number) => list[i % list.length] ?? 0;

const keyboardHammer = (t: number, s: Canvas) => {
  s.clawd({ eyes: "normal", legs: typing(t) });
  keyboard(s.set, t);
  const p = t % 4;
  s.set(13, 3 + p, C.cyan);
  if (p < 2) s.set(14, 2 + p, C.cyan);
  if (t % 4 < 2) {
    s.set(3, 2, C.white);
    s.set(6, 1, C.white);
    s.set(9, 2, C.white);
    s.set(3, 1, C.white);
    s.set(9, 1, C.white);
  }
};

const codeStream = (t: number, s: Canvas) => {
  s.clawd({ eyes: Math.floor(t / 4) % 2 ? "look-r" : "look-l", legs: typing(t) });
  keyboard(s.set, t, 3, 12);
  for (const [x, k] of [
    [0, 0],
    [1, 5],
    [14, 2],
    [15, 7],
    [0, 9],
    [15, 11],
  ] as const) {
    const y = 11 - ((t + k) % 12);
    if (y >= 0) s.set(x, y, y < 3 ? CODE_DIM : C.green);
  }
};

const deadlinePanic = (t: number, s: Canvas) => {
  const j = at([0, 1, 0, -1], t);
  s.clawd({
    ox: 2 + j,
    eyes: "wide",
    legs: [alt(t, 1, 2), alt(t, 2, 1), alt(t, 1, 2), alt(t, 2, 1)],
  });
  keyboard(s.set, t);
  if (t % 2 === 0) {
    for (const x of [3, 12]) {
      s.set(x, 0, C.yellow);
      s.set(x, 1, C.yellow);
      s.set(x, 3, C.yellow);
    }
  }
  const p = t % 3;
  s.set(1 - p, 5 + p, C.cyan);
  s.set(14 + p, 5 + p, C.cyan);
};

const spectacles = (t: number, s: Canvas) => {
  s.clawd({ ox: 1, eyes: "normal", legs: [2, 2, 2, 1] });
  for (const [x, y] of [
    [4, 5],
    [5, 5],
    [6, 5],
    [7, 5],
    [8, 5],
    [9, 5],
    [4, 6],
    [6, 6],
    [7, 6],
    [9, 6],
    [3, 5],
    [10, 5],
  ] as const) {
    s.set(x, y, C.white);
  }
  s.set(5, 6, C.eye);
  s.set(8, 6, C.eye);
  if (t % 8 < 2) {
    s.set(5, 6, C.cyan);
    s.set(8, 6, C.cyan);
  }
  for (let y = 6; y <= 12; y++) for (let x = 12; x <= 15; x++) s.set(x, y, C.paper);
  for (const y of [7, 9, 11]) {
    s.set(13, y, C.ink);
    s.set(14, y, C.ink);
  }
  const line = at([7, 9, 11], Math.floor(t / 3));
  s.set(13, line, C.cyan);
  s.set(14, line, C.cyan);
  for (let i = 0; i < Math.floor(t / 3) % 4; i++) s.set(9 + i * 2, 1, C.white);
};

const magnifier = (t: number, s: Canvas) => {
  const pos = at([1, 3, 5, 7, 9, 11, 9, 7, 5, 3], t);
  s.clawd({ oy: 2, eyes: pos < 6 ? "look-l" : "look-r" });
  for (let x = 0; x < 16; x++) {
    s.set(x, 12, C.paper);
    s.set(x, 13, C.paper);
  }
  for (const x of [2, 5, 9, 12]) {
    s.set(x, 12, C.ink);
    s.set(x + 1, 12, C.ink);
  }
  for (const [dx, dy] of [
    [0, 0],
    [1, 0],
    [2, 0],
    [0, 1],
    [2, 1],
    [0, 2],
    [1, 2],
    [2, 2],
  ] as const) {
    s.set(pos + dx, 10 + dy, C.steel);
  }
  s.set(pos + 1, 11, C.cyan);
  s.set(pos + 3, 13, C.brown);
};

const checklist = (t: number, s: Canvas) => {
  s.clawd({ ox: 4, eyes: "look-l", legs: [1, 2, 2, 2] });
  for (let y = 5; y <= 12; y++) {
    for (let x = 0; x <= 4; x++) s.set(x, y, x === 0 || x === 4 || y === 12 ? C.brown : C.paper);
  }
  s.set(1, 4, C.grey);
  s.set(2, 4, C.grey);
  s.set(3, 4, C.grey);
  const done = Math.floor(t / 4) % 4;
  [7, 9, 11].forEach((y, i) => {
    s.set(1, y, C.ink);
    if (i < done) {
      s.set(2, y, C.green);
      s.set(3, y - 1, C.green);
    } else s.set(3, y, C.ink);
  });
};

const grr = (t: number, s: Canvas) => {
  const j = t % 2 ? 1 : 0;
  s.clawd({ ox: 2 + j, eyes: "squint" });
  if (t % 4 < 2) {
    for (const [x, y] of [
      [12, 1],
      [14, 1],
      [12, 3],
      [14, 3],
      [13, 2],
    ] as const) {
      s.set(x, y, C.red);
    }
  }
  const p = t % 4;
  s.set(3, 3 - p, p > 2 ? C.base : C.steam);
  s.set(11, 3 - p, p > 2 ? C.base : C.steam);
  if (p < 2) s.set(2, 3 - p, C.steam);
};

const wrench = (t: number, s: Canvas) => {
  const up = t % 2 === 0;
  s.clawd({ ox: 1, eyes: "squint", legs: [2, 2, 2, 1] });
  s.set(14, 9, C.grey);
  s.set(14, 10, C.base);
  const handle = up
    ? [
        [11, 10],
        [12, 10],
        [13, 9],
      ]
    : [
        [11, 9],
        [12, 9],
        [13, 9],
      ];
  for (const [x = 0, y = 0] of handle) s.set(x, y, C.steel);
  s.set(15, 8, C.steel);
  s.set(15, 10, C.steel);
  if (!up) {
    s.set(15, 6, C.yellow);
    s.set(13, 7, C.yellow);
    s.set(15, 12, C.yellow);
  }
};

const hammerTime = (t: number, s: Canvas) => {
  const ph = t % 4;
  const hit = ph === 3;
  s.clawd({ oy: hit ? 5 : 4, eyes: "squint", legs: hit ? [1, 1, 1, 1] : [2, 2, 2, 2] });
  s.set(14, 12, C.grey);
  s.set(14, 13, C.grey);
  if (ph < 2) {
    for (let y = 3; y <= 7; y++) s.set(13, y, C.brown);
    s.set(12, 2, C.steel);
    s.set(13, 2, C.steel);
    s.set(14, 2, C.steel);
  } else if (ph === 2) {
    s.set(12, 7, C.brown);
    s.set(13, 6, C.brown);
    s.set(14, 5, C.brown);
    s.set(15, 4, C.steel);
    s.set(15, 5, C.steel);
    s.set(14, 4, C.steel);
  } else {
    s.set(12, 10, C.brown);
    s.set(13, 10, C.brown);
    s.set(14, 9, C.steel);
    s.set(14, 10, C.steel);
    s.set(14, 11, C.steel);
    plus(s.set, 15, 11, 2, C.yellow);
    s.set(12, 12, C.yellow);
  }
};

const sparkle = (t: number, s: Canvas) => {
  s.clawd({ eyes: "shine", color: t % 4 < 2 ? C.body : C.bodyHi });
  for (const [x, y, k] of [
    [1, 2, 0],
    [14, 3, 2],
    [0, 10, 1],
    [15, 11, 3],
    [8, 1, 2],
    [12, 0, 1],
  ] as const) {
    const ph = (t + k) % 4;
    plus(s.set, x, y, ph === 1 ? 2 : ph === 0 || ph === 2 ? 1 : 0, C.yellow);
  }
};

const halo = (t: number, s: Canvas) => {
  const up = t % 8 >= 4;
  const oy = up ? 4 : 5;
  s.clawd({ oy, eyes: "happy" });
  for (let x = 5; x <= 10; x++) s.set(x, oy - 3, C.gold);
  s.set(4, oy - 2, C.gold);
  s.set(11, oy - 2, C.gold);
  s.set(5 + (t % 6), oy - 3, C.white);
  for (let x = up ? 5 : 4; x <= (up ? 10 : 11); x++) s.set(x, 13, SHADOW);
};

const CONFETTI = [C.yellow, C.pink, C.cyan, C.green, C.violet, C.red];
const victoryHop = (t: number, s: Canvas) => {
  const hop = at([0, -1, -2, -2, -1, 0, 0, 0], t);
  s.clawd({ oy: 5 + hop, eyes: "happy", legs: hop < 0 ? [1, 2, 2, 1] : [2, 2, 2, 2] });
  [0, 3, 6, 9, 12, 15, 2, 13].forEach((x, k) => {
    const y = (t + k * 3) % 14;
    s.set(x, y, CONFETTI[k % CONFETTI.length] ?? C.yellow);
  });
};

const dozing = (t: number, s: Canvas) => {
  s.clawd({ oy: 5, eyes: "closed" });
  const p = t % 8;
  [
    [11, 4],
    [13, 2],
    [15, 0],
  ].forEach(([x = 0, y = 0], i) => {
    if (p >= i * 2) {
      s.set(x, y, C.steel);
      s.set(x + 1, y, C.steel);
    }
  });
};

const needsYou = (t: number, s: Canvas) => {
  const hop = at([0, -1, 0, 0], t);
  s.clawd({ oy: 5 + hop, eyes: "normal" });
  for (const [x, y] of [
    [12, 0],
    [13, 0],
    [14, 1],
    [13, 2],
    [13, 4],
  ] as const) {
    s.set(x, y, C.yellow);
  }
};

const failed = (_t: number, s: Canvas) => {
  s.clawd({ oy: 5, eyes: "x", color: BODY_FAILED });
};

const done = (_t: number, s: Canvas) => {
  s.clawd({ oy: 5, eyes: "happy" });
  for (const [x, y] of [
    [11, 2],
    [12, 3],
    [13, 2],
    [14, 1],
    [15, 0],
  ] as const) {
    s.set(x, y, C.green);
  }
};

export const VARIANTS: Record<ClawdState, readonly Variant[]> = {
  implement: [
    v("Keyboard hammer", keyboardHammer),
    v("Code stream", codeStream),
    v("Deadline panic", deadlinePanic),
  ],
  review: [v("Spectacles", spectacles), v("Magnifier", magnifier), v("Checklist", checklist)],
  fixup: [v("Grr", grr), v("Wrench", wrench), v("Hammer time", hammerTime)],
  merge_ready: [v("Sparkle", sparkle), v("Halo", halo), v("Victory hop", victoryHop)],
  done: [v("Done", done)],
  failed: [v("Failed", failed)],
  needs_you: [v("Needs you", needsYou)],
  dozing: [v("Dozing", dozing)],
};
