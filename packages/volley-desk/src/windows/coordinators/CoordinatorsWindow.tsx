/**
 * The coordinators window, ported from the prototype `CoordinatorsWindow`: one
 * row per wave with its coordinator's state (`Working` / `Waiting for your
 * answer` / `No coordinator · claim it`), the wave's progress, go-to (fit the
 * viewport to the wave and its agents) and show/hide. A wave that has ended
 * shows a neutral `Complete` / `Stopped` instead: its coordinator is gone
 * because the work is done, and there is nothing to claim. Hidden waves keep
 * running and still count towards the top-bar pill and notifications. The
 * first row is the supervisor (`volleyd`) with the top-bar pill's health: it
 * runs the waves, but it is not an agent and has no window of its own.
 */
import { Cancel01Icon, CenterFocusIcon, EyeIcon, ViewOffIcon } from "@hugeicons/core-free-icons";
import type { EffectiveCoordinator } from "../../attention";
import { Frame, type FrameProps } from "../../canvas/Frame";
import type { Rect } from "../../canvas/useViewport";
import { plural } from "../../lib/plural";
import { supervisorHealth } from "../../store/reducer";
import type { CoordinatorState, SupervisorView, WaveView } from "../../store/types";
import { age } from "../agent/AgentWindow";
import { Clawd } from "../wave/Clawd";
import { IconBtn, dagNodes, isMine } from "../wave/WaveWindow";
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
  /** The Desk's broker identity: a wave it claimed is mine too. */
  identity?: string | null | undefined;
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
  /** The "show finished" toggle: agents that finished more than `graceMin` ago are hidden. */
  finished?: { hidden: number; shown: boolean; graceMin: number; onToggle: () => void };
  /** The supervisors for the first row; `[]` says volleyd is absent, omitted shows no row (demo). */
  supervisors?: readonly SupervisorView[];
  /** Clock for the supervisor's age (the App's attention tick). */
  now?: number;
}

function SupervisorRow({ sup, now }: { sup: SupervisorView | undefined; now: number }) {
  const id = sup?.id ?? "volleyd";
  const h = supervisorHealth(sup);
  const parts = [id, h.label, ...(h.since === null ? [] : [age(now - h.since)])];
  if (!h.down && sup?.wavesOwned != null) parts.push(plural(sup.wavesOwned, "wave"));
  return (
    <li
      aria-label={`Supervisor ${id}`}
      className={`coord coord--sup st-${h.down ? "gone" : "working"}`}
    >
      <span className="coord-dot" style={{ background: h.down ? "#ff7a59" : "#34d399" }} />
      <div className="coord-main">
        <div className="coord-name">Supervisor</div>
        <div className="coord-sub">
          <span className="coord-state">{parts.join(" · ")}</span>
          {sup?.version && <span className="dim"> · v{sup.version}</span>}
        </div>
      </div>
    </li>
  );
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
        {p.supervisors && p.supervisors.length === 0 && (
          <SupervisorRow sup={undefined} now={p.now ?? Date.now()} />
        )}
        {p.supervisors?.map((s) => (
          <SupervisorRow key={s.id} sup={s} now={p.now ?? Date.now()} />
        ))}
        {p.waves.map((w) => {
          const c = p.coordinators[w.id] ?? { id: null, state: "gone" as const };
          const accent = accentFor(w.id);
          const hidden = p.hidden.has(w.id);
          const mine = isMine(w.state?.owner, p.me, p.identity);
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
      {p.finished && (
        <label className="coord-finished">
          <input type="checkbox" checked={p.finished.shown} onChange={p.finished.onToggle} /> Show
          finished agents
          {!p.finished.shown && p.finished.hidden > 0 && (
            <span className="dim">
              {" "}
              · {p.finished.hidden} finished more than {p.finished.graceMin} min ago{" "}
              {p.finished.hidden === 1 ? "is" : "are"} hidden
            </span>
          )}
        </label>
      )}
    </Frame>
  );
}
