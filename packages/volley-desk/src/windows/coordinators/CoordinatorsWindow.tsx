/**
 * The coordinators window, ported from the prototype `CoordinatorsWindow`: one
 * row per wave with its coordinator's state (`Working` / `Waiting for your
 * answer` / `No coordinator · claim it`), the wave's progress, go-to (fit the
 * viewport to the wave and its agents) and show/hide. A wave that has ended
 * shows a neutral `Complete` / `Stopped` instead: its coordinator is gone
 * because the work is done, and there is nothing to claim. Hidden waves keep
 * running and still count towards the top-bar pill and notifications.
 */
import { Cancel01Icon, CenterFocusIcon, EyeIcon, ViewOffIcon } from "@hugeicons/core-free-icons";
import type { EffectiveCoordinator } from "../../attention";
import { Frame, type FrameProps } from "../../canvas/Frame";
import type { Rect } from "../../canvas/useViewport";
import type { CoordinatorState, WaveView } from "../../store/types";
import { Clawd } from "../wave/Clawd";
import { IconBtn, dagNodes } from "../wave/WaveWindow";
import { accentFor } from "../wave/accent";
import { wavePct } from "../wave/stages";
import "../../styles/attention.css";

export const COORDS_ID = "coordinators";
export const COORDS_W = 430;

export const STATE_LABEL: Record<CoordinatorState, string> = {
  working: "Working",
  awaiting_input: "Waiting for your answer",
  gone: "No coordinator · claim it",
};

/** Labels for waves that have ended (`waveAttention` gives them tier `none`). */
export const ENDED_LABEL: Partial<Record<string, string>> = {
  complete: "Complete",
  stopped: "Stopped",
};

export interface CoordinatorsWindowProps {
  /** Waves with state, in display order. */
  waves: WaveView[];
  /** Each wave's effective coordinator (`coordinatorFor`), by wave id. */
  coordinators: Record<string, EffectiveCoordinator>;
  /** The title chip's count: waves whose coordinator is not working (as in the prototype). */
  needsYou: number;
  me: string | null;
  hidden: ReadonlySet<string>;
  frame: Omit<
    FrameProps,
    "id" | "title" | "label" | "accent" | "width" | "actions" | "footer" | "children"
  >;
  onToggle: (wave: string) => void;
  /** Go-to: called after the viewport is fitted (show the wave if hidden, raise it). */
  onGoTo: (wave: string) => void;
  /** Viewport fit and the wave's cluster rectangles (wave window + its agents). */
  fitTo?: (rects: readonly Rect[]) => void;
  clusterOf?: (wave: string) => Rect[];
  onClose: () => void;
}

function pctOf(w: WaveView): number {
  return w.state
    ? wavePct(
        dagNodes(w.state)
          .filter((t) => !t.cancelled)
          .map((t) => t.stage),
      )
    : 0;
}

export function CoordinatorsWindow(p: CoordinatorsWindowProps) {
  const goTo = (id: string) => {
    const rects = p.clusterOf?.(id) ?? [];
    if (rects.length) p.fitTo?.(rects);
    p.onGoTo(id);
  };
  const title = (
    <>
      <span className="t-name">Wave coordinators</span>
      {p.needsYou > 0 && <span className="chip chip--hot">{p.needsYou} need you</span>}
    </>
  );
  return (
    <Frame
      {...p.frame}
      id={COORDS_ID}
      title={title}
      label="Wave coordinators"
      accent="#e8ecf4"
      width={COORDS_W}
      actions={<IconBtn label="Close coordinators" i={Cancel01Icon} onClick={p.onClose} />}
    >
      <ul className="coord-list">
        {p.waves.map((w) => {
          const c = p.coordinators[w.id] ?? { id: null, state: "gone" as const };
          const accent = accentFor(w.id);
          const hidden = p.hidden.has(w.id);
          const mine = p.me !== null && w.state?.owner === p.me;
          const ended = ENDED_LABEL[w.state?.status ?? ""];
          return (
            <li
              key={w.id}
              aria-label={w.id}
              className={`coord st-${ended ? "ended" : c.state}${hidden ? " coord--hidden" : ""}`}
            >
              <span className="coord-dot" style={{ background: accent }} />
              <div className="coord-main">
                <div className="coord-name">
                  <Clawd size={16} waiting={!ended && c.state === "awaiting_input"} /> {w.id}{" "}
                  {mine && <span className="chip chip--mine">★ yours</span>}
                </div>
                <div className="coord-sub">
                  {c.id ?? "no owner"} ·{" "}
                  <span className="coord-state">{ended ?? STATE_LABEL[c.state]}</span>
                </div>
                <div className="coord-bar">
                  <span style={{ width: `${pctOf(w)}%`, background: accent }} />
                </div>
              </div>
              <div className="coord-actions">
                <IconBtn label={`Go to ${w.id}`} i={CenterFocusIcon} onClick={() => goTo(w.id)} />
                <IconBtn
                  label={hidden ? `Show ${w.id}` : `Hide ${w.id}`}
                  i={hidden ? ViewOffIcon : EyeIcon}
                  onClick={() => p.onToggle(w.id)}
                />
              </div>
            </li>
          );
        })}
      </ul>
      <p className="coord-note">
        Hidden waves keep running. A wave that needs you still counts in the top bar and raises a
        notification while hidden.
      </p>
    </Frame>
  );
}
