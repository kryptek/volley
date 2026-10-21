import type { ReactNode, Ref } from "react";
import { type View, worldTransform } from "./useViewport";

/**
 * The transformed world layer: every window is positioned in world
 * coordinates inside it. `animating` turns on the arrange transition
 * (`world--anim`). During a pan or pinch `useViewport` moves this element
 * directly (`ref`) and `view` catches up on release; a render mid-gesture (a
 * feed tick) leaves the moved transform alone, since `view` has not changed.
 */
export function World({
  view,
  animating = false,
  ref,
  children,
}: {
  view: View;
  animating?: boolean;
  ref?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <div
      ref={ref}
      className={`world${animating ? " world--anim" : ""}`}
      style={{ transform: worldTransform(view) }}
    >
      {children}
    </div>
  );
}
