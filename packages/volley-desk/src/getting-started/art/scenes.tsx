/**
 * The seven Getting started scenes, one per wizard step, each a complete `<svg>` composed from
 * the otter builder. Only the ground shadows, floor lines and the dashed toss path use theme
 * tokens (`var(--line)`); everything else is the fixed `PALETTE`.
 */
import type { ReactNode } from "react";
import { useReducedMotion } from "../../a11y/motion";
import { SCENE_ALT, type SceneId } from "./ids";
import { Ball, Confetti, Otter, PALETTE as P, PropArt, Shadow } from "./otter";

export interface SceneProps {
  /** Width and height in px; omitted, the art fills its container (`.gs-art`). */
  size?: number;
  className?: string;
}

function Scene({
  id,
  size,
  className,
  children,
  ...data
}: SceneProps & { id: SceneId; children: ReactNode; "data-motion"?: string }) {
  return (
    <svg
      viewBox="0 0 240 240"
      role="img"
      aria-label={SCENE_ALT[id]}
      data-scene={id}
      className={className ? `gs-art ${className}` : "gs-art"}
      width={size}
      height={size}
      style={size === undefined ? undefined : { width: size, height: size }}
      {...data}
    >
      <title>{SCENE_ALT[id]}</title>
      {children}
    </svg>
  );
}

/** The ground line the single-otter scenes stand on. */
const Floor = ({ y = 212 }: { y?: number }) => (
  <path d={`M 24 ${y} H 216`} stroke="var(--line)" strokeWidth={2.4} strokeLinecap="round" />
);

/** The ball's loop between the three otters' raised paws: left → back → right → over the top. */
export const TOSS_PATH = "M 48 110 Q 82 48 120 86 Q 158 48 192 110 Q 120 -12 48 110 Z";
/** Where the ball hangs when motion is reduced: the top of the long arc. */
export const BALL_STILL = [120, 49] as const;

export function WelcomeScene(props: SceneProps) {
  const reduced = useReducedMotion();
  return (
    <Scene id="welcome" {...props} data-motion={reduced ? "reduced" : "full"}>
      <path
        d={TOSS_PATH}
        fill="none"
        stroke="var(--line)"
        strokeWidth={2}
        strokeDasharray="5 7"
        strokeLinecap="round"
      />
      <Otter x={120} y={184} scale={0.82} look="up" mouth="o" armsUp bob delay={0.8} />
      <Otter x={50} y={220} scale={1.02} look="up" armsUp bob />
      <Otter x={190} y={220} scale={1.02} flip look="up" mouth="cheer" armsUp bob delay={1.6} />
      {reduced ? (
        <g data-part="ball" transform={`translate(${BALL_STILL[0]} ${BALL_STILL[1]})`}>
          <Ball r={12} />
        </g>
      ) : (
        <g data-part="ball" className="gs-toss" style={{ offsetPath: `path("${TOSS_PATH}")` }}>
          <Ball r={12} />
        </g>
      )}
    </Scene>
  );
}

export function ThisComputerScene(props: SceneProps) {
  return (
    <Scene id="this-computer" {...props}>
      <Floor />
      <Otter x={112} y={210} scale={1.4} look="right" hat="hard" prop="wrench" />
    </Scene>
  );
}

export function MachinesScene(props: SceneProps) {
  return (
    <Scene id="machines" {...props}>
      <Floor />
      <Shadow x={180} y={211} rx={36} ry={4} />
      <rect
        x={146}
        y={176}
        width={68}
        height={34}
        rx={3}
        fill={P.card}
        stroke={P.ink}
        strokeWidth={2.4}
      />
      <path d="M 146 188 H 214" stroke={P.cardDark} strokeWidth={2} />
      <path
        d="M 158 124 H 210 a 3 3 0 0 1 3 3 V 168 H 155 V 127 a 3 3 0 0 1 3 -3 Z"
        fill={P.screen}
        stroke={P.ink}
        strokeWidth={2.4}
        strokeLinejoin="round"
      />
      <path
        d="M 164 140 l 6 4 l -6 4 M 174 150 h 10"
        fill="none"
        stroke={P.stripe}
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M 146 168 H 220 L 216 176 H 150 Z"
        fill={P.steel}
        stroke={P.ink}
        strokeWidth={2.4}
        strokeLinejoin="round"
      />
      <rect x={144} y={169} width={5} height={5} rx={1} fill={P.ink} />
      <Otter x={76} y={210} scale={1.15} look="right" mouth="o" prop="plug" />
    </Scene>
  );
}

export function ReposScene(props: SceneProps) {
  return (
    <Scene id="repos" {...props}>
      <Floor />
      <Otter x={120} y={210} scale={1.4} hat="cap" prop="box" />
    </Scene>
  );
}

export function PeopleScene(props: SceneProps) {
  return (
    <Scene id="people" {...props}>
      <Floor />
      <Otter x={74} y={210} scale={1.05} look="right" hat="crown" />
      <Otter x={168} y={210} scale={1.05} look="left" mouth="cheer" prop="badge" />
    </Scene>
  );
}

export function AccessScene(props: SceneProps) {
  return (
    <Scene id="access" {...props}>
      <Floor />
      <Otter x={104} y={210} scale={1.35} look="right" hat="headset" prop="globe" />
      <Shadow x={188} y={211} rx={14} ry={3} />
      <PropArt prop="phone" x={162} y={268} scale={1.4} />
    </Scene>
  );
}

export function DoneScene(props: SceneProps) {
  return (
    <Scene id="done" {...props}>
      <Confetti />
      <Otter x={56} y={214} scale={0.84} look="right" mouth="cheer" hat="party" armsUp />
      <Otter x={184} y={214} scale={0.84} flip look="right" mouth="cheer" hat="party" armsUp />
      <Otter x={114} y={208} scale={0.92} mouth="cheer" hat="party" prop="flag" />
    </Scene>
  );
}

export const SCENES: Record<SceneId, (p: SceneProps) => ReactNode> = {
  welcome: WelcomeScene,
  "this-computer": ThisComputerScene,
  machines: MachinesScene,
  repos: ReposScene,
  people: PeopleScene,
  access: AccessScene,
  done: DoneScene,
};
