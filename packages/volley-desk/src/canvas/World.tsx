import type { ReactNode } from "react";
import type { View } from "./useViewport";

/**
 * The transformed world layer: every window is positioned in world
 * coordinates inside it. `animating` turns on the arrange transition
 * (`world--anim`).
 */
export function World({
  view,
  animating = false,
  children,
}: {
  view: View;
  animating?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`world${animating ? " world--anim" : ""}`}
      style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}
    >
      {children}
    </div>
  );
}
