/**
 * The otter raft's character builder. `Otter` draws one sea otter standing on the ground at
 * (`x`, `y`): round head, two small ears, a lighter muzzle, whiskers, paws held up and a tail,
 * with an optional hat and prop from the tables below. Local units: the otter stands about 100
 * tall above its feet (y = 0), centred on x = 0, before `scale`. Every outline is `LINE` wide on
 * screen whatever the scale. The palette is fixed so the otters read the same on every theme;
 * only the ground shadow uses a theme token.
 */
import type { ReactNode } from "react";

export const PALETTE = {
  body: "#8b5a36",
  belly: "#e9cfa8",
  dark: "#5e3a20",
  mid: "#7a4a2a",
  ink: "#3a2313",
  stripe: "#2f9fd0",
  ball: "#ffffff",
  blush: "#e3907c",
  mouth: "#9c3b33",
  gold: "#f2bf3c",
  goldDark: "#c9952a",
  red: "#e0574f",
  pink: "#ec6f98",
  green: "#5fb36a",
  steel: "#b7c2cc",
  steelDark: "#7d8a96",
  screen: "#22303c",
  card: "#c98d4e",
  cardDark: "#a46c36",
} as const;

const P = PALETTE;

/** Outline width in scene units (the scenes' viewBox is 240 wide). */
export const LINE = 2.4;

export type Hat = "hard" | "crown" | "cap" | "party" | "headset";
export type Prop = "wrench" | "plug" | "box" | "badge" | "globe" | "phone" | "flag";
export type Look = "front" | "left" | "right" | "up";
export type Mouth = "smile" | "o" | "cheer";
type Pt = readonly [number, number];

const SHOULDER_L: Pt = [-19, -54];
const SHOULDER_R: Pt = [19, -54];
const PAWS_CHEST: [Pt, Pt] = [
  [-8, -45],
  [8, -45],
];
const PAWS_UP: [Pt, Pt] = [
  [-30, -97],
  [30, -97],
];

/** Hats, drawn over the head (centre (0, -78), radius 24). `sw` is the local outline width. */
const HATS: Record<Hat, (sw: number) => ReactNode> = {
  hard: (sw) => (
    <>
      <path d="M -23 -91 A 23 21 0 0 1 23 -91 Z" fill={P.gold} stroke={P.ink} strokeWidth={sw} />
      <path d="M -6 -111 Q 0 -113 6 -111 L 5 -92 L -5 -92 Z" fill={P.goldDark} />
      <rect
        x={-30}
        y={-94}
        width={60}
        height={7}
        rx={3.5}
        fill={P.gold}
        stroke={P.ink}
        strokeWidth={sw}
      />
    </>
  ),
  crown: (sw) => (
    <>
      <path
        d="M -17 -97 L -19 -119 L -9 -108 L 0 -123 L 9 -108 L 19 -119 L 17 -97 Z"
        fill={P.gold}
        stroke={P.ink}
        strokeWidth={sw}
        strokeLinejoin="round"
      />
      <circle cx={0} cy={-104} r={3} fill={P.red} />
      <circle cx={-10} cy={-102} r={2.2} fill={P.stripe} />
      <circle cx={10} cy={-102} r={2.2} fill={P.stripe} />
    </>
  ),
  cap: (sw) => (
    <>
      <path
        d="M 2 -93 Q 30 -98 40 -89 Q 26 -85 2 -88 Z"
        fill={P.red}
        stroke={P.ink}
        strokeWidth={sw}
        strokeLinejoin="round"
      />
      <path d="M -22 -89 A 22 20 0 0 1 22 -89 Z" fill={P.red} stroke={P.ink} strokeWidth={sw} />
      <circle cx={0} cy={-110} r={3} fill={P.ink} />
    </>
  ),
  party: (sw) => (
    <g transform="rotate(-12 0 -100)">
      <path
        d="M -13 -98 L 0 -134 L 13 -98 Z"
        fill={P.pink}
        stroke={P.ink}
        strokeWidth={sw}
        strokeLinejoin="round"
      />
      <path
        d="M -8 -112 L 6 -108 M -4 -123 L 4 -121"
        stroke={P.gold}
        strokeWidth={3.2}
        strokeLinecap="round"
      />
      <circle cx={0} cy={-135} r={4.5} fill={P.gold} stroke={P.ink} strokeWidth={sw} />
    </g>
  ),
  headset: (sw) => (
    <>
      <path d="M -25 -80 A 25 27 0 0 1 25 -80" fill="none" stroke={P.ink} strokeWidth={4} />
      <rect
        x={-30}
        y={-89}
        width={9}
        height={17}
        rx={4}
        fill={P.screen}
        stroke={P.ink}
        strokeWidth={sw}
      />
      <rect
        x={21}
        y={-89}
        width={9}
        height={17}
        rx={4}
        fill={P.screen}
        stroke={P.ink}
        strokeWidth={sw}
      />
      <path
        d="M -26 -73 Q -25 -60 -12 -61"
        fill="none"
        stroke={P.ink}
        strokeWidth={2.4}
        strokeLinecap="round"
      />
      <circle cx={-11} cy={-61} r={3} fill={P.stripe} stroke={P.ink} strokeWidth={sw * 0.6} />
    </>
  ),
};

interface PropSpec {
  /** Where the paws go while holding it (left, right); omitted paws keep the pose. */
  paws?: [Pt | null, Pt | null];
  draw: (sw: number) => ReactNode;
}

/** Props, in the otter's local units. A prop is drawn under the paws so they grip it. */
const PROPS: Record<Prop, PropSpec> = {
  wrench: {
    paws: [null, [30, -50]],
    draw: (sw) => (
      <g transform="translate(30 -50) rotate(28)">
        <rect
          x={-3.5}
          y={-30}
          width={7}
          height={40}
          rx={3.5}
          fill={P.steel}
          stroke={P.ink}
          strokeWidth={sw}
        />
        <path
          d="M -3.5 -36 V -47.4 A 10 10 0 1 0 3.5 -47.4 V -36 Z"
          fill={P.steel}
          stroke={P.ink}
          strokeWidth={sw}
          strokeLinejoin="round"
        />
        <circle cx={0} cy={4} r={1.6} fill={P.steelDark} />
      </g>
    ),
  },
  plug: {
    paws: [null, [38, -30]],
    draw: (sw) => (
      <>
        <path
          d="M 34 -28 C 22 -10 0 4 -30 2"
          fill="none"
          stroke={P.ink}
          strokeWidth={3.6}
          strokeLinecap="round"
        />
        <rect
          x={34}
          y={-37}
          width={14}
          height={14}
          rx={3}
          fill={P.screen}
          stroke={P.ink}
          strokeWidth={sw}
        />
        <path
          d="M 48 -33 h 6 M 48 -27 h 6"
          stroke={P.steelDark}
          strokeWidth={2.4}
          strokeLinecap="round"
        />
      </>
    ),
  },
  box: {
    paws: [
      [-27, -40],
      [27, -40],
    ],
    draw: (sw) => (
      <>
        <rect
          x={-27}
          y={-60}
          width={54}
          height={40}
          rx={2.5}
          fill={P.card}
          stroke={P.ink}
          strokeWidth={sw}
        />
        <path
          d="M -27 -60 L -20 -68 L 20 -68 L 27 -60 Z"
          fill={P.cardDark}
          stroke={P.ink}
          strokeWidth={sw}
          strokeLinejoin="round"
        />
        <rect x={-4} y={-60} width={8} height={11} fill={P.belly} opacity={0.8} />
        <text
          x={0}
          y={-30}
          textAnchor="middle"
          fontSize={13}
          fontWeight={700}
          fill={P.ink}
          style={{ fontFamily: "var(--f-mono, ui-monospace, monospace)" }}
        >
          repo
        </text>
      </>
    ),
  },
  badge: {
    paws: [
      [-10, -36],
      [31, -94],
    ],
    draw: (sw) => (
      <>
        <path
          d="M -9 -60 L 0 -44 L 9 -60"
          fill="none"
          stroke={P.stripe}
          strokeWidth={2.6}
          strokeLinejoin="round"
        />
        <rect
          x={-9}
          y={-46}
          width={18}
          height={22}
          rx={2.5}
          fill={P.ball}
          stroke={P.ink}
          strokeWidth={sw}
        />
        <rect x={-9} y={-46} width={18} height={6} rx={2} fill={P.stripe} />
        <circle cx={0} cy={-33} r={3.4} fill={P.body} />
        <path d="M -5 -27 h 10" stroke={P.steelDark} strokeWidth={1.6} strokeLinecap="round" />
      </>
    ),
  },
  globe: {
    paws: [
      [-15, -40],
      [15, -40],
    ],
    draw: (sw) => (
      <g transform="translate(0 -44)">
        <circle r={17} fill={P.stripe} stroke={P.ink} strokeWidth={sw} />
        <path
          d="M -12 -9 q 6 -4 10 0 q 2 5 -3 8 q -6 2 -8 -2 z M 3 2 q 7 -3 10 2 q -1 7 -7 9 q -4 -4 -3 -11 z M 2 -14 q 5 -1 7 2 l -5 2 z"
          fill={P.green}
        />
        <ellipse rx={7.5} ry={17} fill="none" stroke={P.ball} strokeWidth={1.2} opacity={0.7} />
        <path d="M -17 0 H 17" stroke={P.ball} strokeWidth={1.2} opacity={0.7} />
      </g>
    ),
  },
  phone: {
    paws: [null, [26, -52]],
    draw: (sw) => (
      <g transform="translate(26 -58)">
        <rect
          x={-8}
          y={-15}
          width={16}
          height={28}
          rx={3}
          fill={P.screen}
          stroke={P.ink}
          strokeWidth={sw}
        />
        <rect x={-5.5} y={-11} width={11} height={18} rx={1} fill={P.stripe} />
        <circle cx={0} cy={10} r={1.4} fill={P.steel} />
      </g>
    ),
  },
  flag: {
    paws: [null, [30, -66]],
    draw: (sw) => (
      <>
        <path d="M 30 -30 V -140" stroke={P.ink} strokeWidth={3.4} strokeLinecap="round" />
        <path
          d="M 31 -138 C 44 -144 54 -130 70 -136 L 70 -110 C 54 -104 44 -118 31 -112 Z"
          fill={P.stripe}
          stroke={P.ink}
          strokeWidth={sw}
          strokeLinejoin="round"
        />
        <circle cx={50} cy={-123} r={6} fill={P.ball} stroke={P.ink} strokeWidth={sw * 0.7} />
      </>
    ),
  },
};

const PUPIL: Record<Look, Pt> = {
  front: [0, 0],
  left: [-1.6, 0],
  right: [1.6, 0],
  up: [0.6, -1.8],
};

function Arm({ from, to, sw }: { from: Pt; to: Pt; sw: number }) {
  // A gentle elbow: bend the limb away from the body's centre line.
  const mx = (from[0] + to[0]) / 2 + (from[0] < 0 ? -4 : 4);
  const my = (from[1] + to[1]) / 2 + 3;
  const d = `M ${from[0]} ${from[1]} Q ${mx} ${my} ${to[0]} ${to[1]}`;
  return (
    <>
      <path d={d} fill="none" stroke={P.ink} strokeWidth={10 + 2 * sw} strokeLinecap="round" />
      <path d={d} fill="none" stroke={P.body} strokeWidth={10} strokeLinecap="round" />
      <circle cx={to[0]} cy={to[1]} r={6} fill={P.dark} stroke={P.ink} strokeWidth={sw} />
    </>
  );
}

function Face({
  look,
  mouth,
  sw,
  blink,
  stagger,
}: {
  look: Look;
  mouth: Mouth;
  sw: number;
  blink: boolean;
  stagger: { animationDelay: string } | undefined;
}) {
  const [px, py] = PUPIL[look];
  return (
    <>
      <ellipse cx={0} cy={-70} rx={15.5} ry={11.5} fill={P.belly} />
      <circle cx={-15} cy={-67} r={3.6} fill={P.blush} opacity={0.65} />
      <circle cx={15} cy={-67} r={3.6} fill={P.blush} opacity={0.65} />
      <g className={blink ? "gs-blink" : undefined} style={blink ? stagger : undefined}>
        {[-9, 9].map((ex) => (
          <g key={ex}>
            <ellipse cx={ex + px} cy={-83 + py} rx={3.2} ry={3.9} fill={P.ink} />
            <circle cx={ex + px + 1.1} cy={-84.4 + py} r={1.1} fill={P.ball} />
          </g>
        ))}
      </g>
      <ellipse cx={0} cy={-74.5} rx={4.8} ry={3.2} fill={P.ink} />
      {mouth === "smile" && (
        <path
          d="M -6 -69 Q -3 -65 0 -68.5 Q 3 -65 6 -69"
          fill="none"
          stroke={P.ink}
          strokeWidth={sw * 0.8}
          strokeLinecap="round"
        />
      )}
      {mouth === "o" && (
        <ellipse
          cx={0}
          cy={-66}
          rx={2.6}
          ry={3.2}
          fill={P.mouth}
          stroke={P.ink}
          strokeWidth={sw * 0.7}
        />
      )}
      {mouth === "cheer" && (
        <path
          d="M -7 -69 Q 0 -57 7 -69 Z"
          fill={P.mouth}
          stroke={P.ink}
          strokeWidth={sw * 0.8}
          strokeLinejoin="round"
        />
      )}
      <path
        d="M -12 -72 L -27 -75 M -12 -69 L -28 -69 M -11 -66 L -26 -62 M 12 -72 L 27 -75 M 12 -69 L 28 -69 M 11 -66 L 26 -62"
        stroke={P.ink}
        strokeWidth={sw * 0.5}
        strokeLinecap="round"
        opacity={0.75}
      />
    </>
  );
}

/** The ground shadow under a character or object: the one theme-tinted shape. */
export function Shadow({
  x = 0,
  y = 0,
  rx = 30,
  ry = 5,
}: { x?: number; y?: number; rx?: number; ry?: number }) {
  return (
    <ellipse data-part="shadow" cx={x} cy={y} rx={rx} ry={ry} fill="var(--line)" opacity={0.9} />
  );
}

export interface OtterProps {
  x: number;
  y: number;
  scale?: number;
  /** Mirror left to right. */
  flip?: boolean;
  look?: Look;
  mouth?: Mouth;
  hat?: Hat;
  prop?: Prop;
  armsUp?: boolean;
  /** Bob gently and blink (CSS `gs-bob`, `gs-blink`); `delay` staggers both, in seconds. */
  bob?: boolean;
  delay?: number;
}

/** One sea otter, standing on the ground at (`x`, `y`). */
export function Otter({
  x,
  y,
  scale = 1,
  flip = false,
  look = "front",
  mouth = "smile",
  hat,
  prop,
  armsUp = false,
  bob = false,
  delay = 0,
}: OtterProps) {
  const sw = LINE / scale;
  const stagger = delay ? { animationDelay: `${-delay}s` } : undefined;
  const spec = prop ? PROPS[prop] : undefined;
  const pose = armsUp ? PAWS_UP : PAWS_CHEST;
  const left = spec?.paws?.[0] ?? pose[0];
  const right = spec?.paws?.[1] ?? pose[1];
  return (
    <g
      data-part="otter"
      transform={`translate(${x} ${y}) scale(${flip ? -scale : scale} ${scale})`}
    >
      <Shadow rx={32} ry={5.5} />
      <g className={bob ? "gs-bob" : undefined} style={stagger}>
        <path
          d="M 14 -12 C 40 -8 56 -22 52 -44 C 46 -32 34 -26 14 -28 Z"
          fill={P.mid}
          stroke={P.ink}
          strokeWidth={sw}
          strokeLinejoin="round"
        />
        <ellipse cx={-12} cy={-4} rx={11} ry={5.5} fill={P.dark} stroke={P.ink} strokeWidth={sw} />
        <ellipse cx={12} cy={-4} rx={11} ry={5.5} fill={P.dark} stroke={P.ink} strokeWidth={sw} />
        <path
          d="M -24 -11 C -29 -40 -22 -63 0 -65 C 22 -63 29 -40 24 -11 C 19 -3 -19 -3 -24 -11 Z"
          fill={P.body}
          stroke={P.ink}
          strokeWidth={sw}
        />
        <path
          d="M 9 -63 C 25 -57 29 -33 23 -12 C 20 -7 14 -5 8 -5 C 19 -18 22 -42 9 -63 Z"
          fill={P.mid}
        />
        <ellipse cx={0} cy={-31} rx={14.5} ry={21} fill={P.belly} />
        {[-18, 18].map((ex) => (
          <g key={ex}>
            <circle cx={ex} cy={-96} r={6.5} fill={P.body} stroke={P.ink} strokeWidth={sw} />
            <circle cx={ex} cy={-96} r={3} fill={P.dark} />
          </g>
        ))}
        <circle cx={0} cy={-78} r={24} fill={P.body} stroke={P.ink} strokeWidth={sw} />
        <path d="M 10 -99.5 A 24 24 0 0 1 10 -56.5 A 30 30 0 0 0 10 -99.5 Z" fill={P.mid} />
        <Face look={look} mouth={mouth} sw={sw} blink={bob} stagger={stagger} />
        {hat && <g data-hat={hat}>{HATS[hat](sw)}</g>}
        {spec && <g data-prop={prop}>{spec.draw(sw)}</g>}
        <Arm from={SHOULDER_L} to={left} sw={sw} />
        <Arm from={SHOULDER_R} to={right} sw={sw} />
      </g>
    </g>
  );
}

/** A prop standing on its own at (`x`, `y`) (the phone beside the Access otter). */
export function PropArt({
  prop,
  x,
  y,
  scale = 1,
}: { prop: Prop; x: number; y: number; scale?: number }) {
  return (
    <g data-prop={prop} transform={`translate(${x} ${y}) scale(${scale})`}>
      {PROPS[prop].draw(LINE / scale)}
    </g>
  );
}

/** The volleyball, centred on (0, 0): white with the stripe colour's seams. */
export function Ball({ r = 11 }: { r?: number }) {
  const k = r / 11;
  return (
    <g transform={k === 1 ? undefined : `scale(${k})`}>
      <circle r={11} fill={P.ball} stroke={P.ink} strokeWidth={LINE / k} />
      <path
        d="M -9 -6 Q 0 -2 4 -10 M -10 4 Q 2 2 8 -7 M -3 10 Q 4 2 11 2"
        fill="none"
        stroke={P.stripe}
        strokeWidth={2.6}
        strokeLinecap="round"
      />
    </g>
  );
}

/** Deterministic confetti: [x, y, rotation, colour index, shape]. */
const CONFETTI: readonly (readonly [number, number, number, number, 0 | 1])[] = [
  [28, 34, 20, 0, 0],
  [58, 18, -30, 1, 1],
  [92, 40, 45, 2, 0],
  [126, 14, 10, 3, 0],
  [160, 30, -20, 0, 1],
  [196, 20, 60, 1, 0],
  [214, 52, -45, 2, 0],
  [20, 72, 30, 3, 1],
  [70, 58, -10, 2, 0],
  [178, 64, 15, 3, 0],
  [140, 50, 70, 1, 1],
  [108, 72, -60, 0, 0],
  [40, 104, 50, 1, 0],
  [206, 96, -25, 0, 1],
  [16, 140, 5, 2, 0],
  [222, 134, 35, 3, 0],
];

export function Confetti() {
  const colours = [P.stripe, P.pink, P.gold, P.green];
  return (
    <g data-part="confetti">
      {CONFETTI.map(([cx, cy, rot, c, shape]) =>
        shape === 0 ? (
          <rect
            key={`${cx}-${cy}`}
            x={cx - 4}
            y={cy - 2}
            width={8}
            height={4}
            rx={1}
            fill={colours[c]}
            transform={`rotate(${rot} ${cx} ${cy})`}
          />
        ) : (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={2.8} fill={colours[c]} />
        ),
      )}
    </g>
  );
}
