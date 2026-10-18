/**
 * Claude's pixel mascot, drawn on a 12×9 grid (ported from the prototype
 * `Clawd`). It hops (`clawd--wait`) while the wave's coordinator is waiting
 * for its human.
 */
const PX = [
  "..XXXXXXXX..",
  "..XXXXXXXX..",
  "XXXX.XX.XXXX",
  "XXXXXXXXXXXX",
  "..XXXXXXXX..",
  "..XXXXXXXX..",
  "..X.X..X.X..",
  "..X.X..X.X..",
  "............",
];
const CELLS = PX.flatMap((row, y) =>
  [...row].flatMap((c, x) => (c === "X" ? [{ key: `${x}-${y}`, x, y }] : [])),
);

export function Clawd({ size = 22, waiting = false }: { size?: number; waiting?: boolean }) {
  return (
    <svg
      className={`clawd${waiting ? " clawd--wait" : ""}`}
      width={size}
      height={(size * 9) / 12}
      viewBox="0 0 12 9"
      aria-label="Claude coordinator"
      role="img"
    >
      {CELLS.map((c) => (
        <rect key={c.key} x={c.x} y={c.y} width="1.02" height="1.02" fill="#d97757" />
      ))}
    </svg>
  );
}
