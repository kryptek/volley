/**
 * Clawd, the Claude Code mascot, as a pixel sprite in the wave title. It hops
 * (`clawd--wait`) while the wave's coordinator is waiting for its human.
 */
const PIXELS = ["..XXXXXXX..", "..XoXXXoX..", "XXXXXXXXXXX", "..XXXXXXX..", "..X.X.X.X.."];
const W = PIXELS[0]?.length ?? 0;
const CELLS = PIXELS.flatMap((row, y) =>
  [...row].flatMap((c, x) => (c === "." ? [] : [{ key: `${x}-${y}`, x, y, eye: c === "o" }])),
);

export function Clawd({ waiting = false }: { waiting?: boolean }) {
  return (
    <svg
      className={`clawd${waiting ? " clawd--wait" : ""}`}
      viewBox={`0 0 ${W} ${PIXELS.length}`}
      width={22}
      height={10}
      role="img"
      aria-label={waiting ? "Claude, waiting for you" : "Claude"}
      shapeRendering="crispEdges"
    >
      {CELLS.map((c) => (
        <rect
          key={c.key}
          x={c.x}
          y={c.y}
          width={1}
          height={1}
          className={c.eye ? "clawd-eye" : "clawd-body"}
        />
      ))}
    </svg>
  );
}
