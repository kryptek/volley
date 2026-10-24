/**
 * An agent window's Clawd: the state's variant (picked per agent, stably),
 * drawn at the shared clock's frame as one `<path>` of unit squares per
 * colour in a 16×14 SVG. `merge_ready` gets the glow (`.clawd-sprite--glow`,
 * dropped on touch screens and under reduced transparency by the CSS).
 */
import { useMemo } from "react";
import type { Frame } from "./canvas";
import { useClawdTick } from "./clock";
import { H, W } from "./palette";
import { pickVariant } from "./pick";
import { CLAWD_LABEL, type ClawdState, VARIANTS } from "./variants";

/** `[colour, d]` per colour in the frame, in first-seen order. */
function paths(frame: Frame): [string, string][] {
  const byColour = new Map<string, string>();
  for (const p of frame) {
    byColour.set(p.c, `${byColour.get(p.c) ?? ""}M${p.x} ${p.y}h1v1h-1z`);
  }
  return [...byColour];
}

export function ClawdSprite({
  agentId,
  state,
  size = 24,
}: {
  agentId: string;
  state: ClawdState;
  /** Width in px; the height keeps the grid's 16:14. */
  size?: number;
}) {
  const t = useClawdTick();
  const list = VARIANTS[state];
  const variant = list[pickVariant(agentId, state, list.length)] ?? list[0];
  const d = useMemo(() => (variant ? paths(variant.frame(t)) : []), [variant, t]);
  const label = CLAWD_LABEL[state];
  return (
    <svg
      className={`clawd-sprite${state === "merge_ready" ? " clawd-sprite--glow" : ""}`}
      role="img"
      aria-label={label}
      viewBox={`0 0 ${W} ${H}`}
      width={size}
      height={(size * H) / W}
      shapeRendering="crispEdges"
      data-state={state}
      data-variant={variant?.name}
    >
      <title>{label}</title>
      {d.map(([fill, path]) => (
        <path key={fill} fill={fill} d={path} />
      ))}
    </svg>
  );
}
