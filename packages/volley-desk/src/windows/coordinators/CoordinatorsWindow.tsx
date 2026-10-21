/**
 * The coordinators window, ported from the prototype `CoordinatorsWindow`: one
 * row per wave with its coordinator's state (`Working` / `Waiting for your
 * answer` / `Coordinator reconnecting · 4m` / `No coordinator · claim it`), the wave's progress, go-to (fit the
 * viewport to the wave and its agents) and show/hide. Every row carries a status
 * chip (`working`, `needs you`, a neutral `reconnecting`, `completed`, `stopped`), apart from its left
 * bar, which is the wave's identity colour (the supervisor row's bar is neutral
 * and its health is a chip too, red when down), so a colour never means two things.
 * Active waves come first; ended ones (their coordinator is gone because the
 * work is done, nothing to claim) sit in a collapsed `Ended · N` group at the
 * bottom. With its agents an ended wave folds off the canvas under "Show
 * finished" like finished agents; its row offers Show (put its window back on
 * the canvas and fit to it) and Dismiss (drop it from this Desk: Desk-side
 * state only, the wave and its journal are untouched). A wave archived by the
 * supervisor (`volleyd archive`) leaves every Desk; a footer line counts them. A
 * coordinator idle with a background wait armed reads `Working · waiting on
 * events`: it wakes on the wave's events, nobody has to answer. Hidden waves keep
 * running and still count towards the top-bar pill and notifications. The
 * first row is the supervisor (`volleyd`) with the top-bar pill's health: it
 * runs the waves, but it is not an agent and has no window of its own.
 */
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  CenterFocusIcon,
  EyeIcon,
  ViewOffIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useState } from "react";
import { type EffectiveCoordinator, reconnectingLabel } from "../../attention";
import { Frame, type FrameProps } from "../../canvas/Frame";
import type { Rect } from "../../canvas/useViewport";
import { noun, plural } from "../../lib/plural";
import { usePanelSound } from "../../sounds/usePanelSound";
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
  reconnecting: "Coordinator reconnecting",
  gone: "No coordinator · claim it",
};

/** A working coordinator idle with a background wait armed. */
export const WAITING_ON_EVENTS_LABEL = "Working · waiting on events";

/** Labels for waves that have ended (`waveAttention` gives them tier `none`). */
export const ENDED_LABEL: Partial<Record<string, string>> = {
  complete: "Complete",
  stopped: "Stopped",
  // Seen only in the one publish before an archived wave's state is cleared (SPEC §4.6.20).
  archived: "Archived",
};

const Icon = ({ i }: { i: typeof Cancel01Icon }) => (
  <HugeiconsIcon icon={i} size={13} strokeWidth={1.8} />
);

export type StatusChip =
  | "working"
  | "needs"
  | "reconnecting"
  | "completed"
  | "stopped"
  | "archived"
  | "failed";

const ENDED_CHIP: Partial<Record<string, StatusChip>> = {
  complete: "completed",
  stopped: "stopped",
  archived: "archived",
};

export const CHIP_LABEL: Record<StatusChip, string> = {
  working: "working",
  needs: "needs you",
  reconnecting: "reconnecting",
  completed: "completed",
  stopped: "stopped",
  archived: "archived",
  failed: "failed",
};

/** A wave row's status chip: its end state once ended, else whether its coordinator needs you. */
export function waveChip(w: WaveView, c: EffectiveCoordinator): StatusChip {
  const ended = ENDED_CHIP[w.state?.status ?? ""];
  if (ended) return ended;
  if (c.state === "reconnecting") return "reconnecting";
  return c.state === "working" ? "working" : "needs";
}

export function Chip({ kind, label }: { kind: StatusChip; label?: string }) {
  return <span className={`chip st-chip st-chip--${kind}`}>{label ?? CHIP_LABEL[kind]}</span>;
}

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
  /**
   * The "show finished" toggle: agents that finished more than `graceMin` ago
   * (`hidden`) and stopped / complete waves with their agents (`waves`) are hidden.
   */
  finished?: {
    hidden: number;
    waves?: number;
    shown: boolean;
    graceMin: number;
    onToggle: () => void;
  };
  /** Ended waves on the canvas (Show, or "Show finished"); the rest of the ended ones are folded. */
  shownEnded?: ReadonlySet<string>;
  /** Show: put an ended wave's window back on the canvas and fit the viewport to it. */
  onShowEnded?: (wave: string) => void;
  /** Dismiss: drop an ended wave from this Desk (Desk-side only). */
  onDismiss?: (wave: string) => void;
  /** How many ended waves are dismissed, and how to bring them back. */
  dismissed?: { count: number; onRestore: () => void };
  /** How many waves the supervisor archived (its `_archive` index): gone from every Desk. */
  archived?: number;
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
      <span className="coord-dot coord-dot--neutral" />
      <div className="coord-main">
        <div className="coord-name">
          Supervisor{" "}
          <Chip kind={h.down ? "failed" : "working"} label={h.down ? "down" : "running"} />
        </div>
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

/** A wave's row: identity bar, name, status chip, coordinator line, progress; `children` are its actions. */
function WaveRow({
  w,
  c,
  p,
  hidden,
  children,
}: {
  w: WaveView;
  c: EffectiveCoordinator;
  p: CoordinatorsWindowProps;
  hidden: boolean;
  children: ReactNode;
}) {
  const accent = accentFor(w.id);
  const mine = isMine(w.state?.owner, p.me, p.identity);
  const ended = ENDED_LABEL[w.state?.status ?? ""];
  return (
    <li
      aria-label={w.id}
      className={`coord st-${ended ? "ended" : c.state}${hidden ? " coord--hidden" : ""}`}
    >
      <span className="coord-dot" style={{ background: accent }} />
      <div className="coord-main">
        <div className="coord-name">
          <Clawd size={16} waiting={!ended && c.state === "awaiting_input"} /> {w.id}{" "}
          <Chip kind={waveChip(w, c)} />
          {mine && <span className="chip chip--mine">★ yours</span>}
        </div>
        <div className="coord-sub">
          {c.id ?? "no owner"} ·{" "}
          <span className="coord-state">
            {ended ??
              (c.state === "working" && c.waitingOnEvents
                ? WAITING_ON_EVENTS_LABEL
                : c.state === "reconnecting"
                  ? reconnectingLabel(c, p.now ?? Date.now())
                  : STATE_LABEL[c.state])}
          </span>
          {ended && hidden && <span className="dim"> · hidden</span>}
        </div>
        <div className="coord-bar">
          <span style={{ width: `${pctOf(w)}%`, background: accent }} />
        </div>
      </div>
      <div className="coord-actions">{children}</div>
    </li>
  );
}

export function CoordinatorsWindow(p: CoordinatorsWindowProps) {
  usePanelSound();
  const [endedOpen, setEndedOpen] = useState(false);
  const isEnded = (w: WaveView) => ENDED_LABEL[w.state?.status ?? ""] !== undefined;
  const active = p.waves.filter((w) => !isEnded(w));
  const ended = p.waves.filter(isEnded);
  const goTo = (id: string) => {
    const rects = p.clusterOf?.(id) ?? [];
    if (rects.length) p.fitTo?.(rects);
    p.onGoTo(id);
  };
  const title = (
    <>
      <span className="t-name">Wave coordinators</span>
      {p.needsYou > 0 && (
        <span className="chip chip--hot">
          {p.needsYou} {noun(p.needsYou, "needs", "need")} you
        </span>
      )}
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
        {active.map((w) => {
          const c = p.coordinators[w.id] ?? { id: null, state: "gone" as const };
          const hidden = p.hidden.has(w.id);
          return (
            <WaveRow key={w.id} w={w} c={c} p={p} hidden={hidden}>
              <IconBtn label={`Go to ${w.id}`} i={CenterFocusIcon} onClick={() => goTo(w.id)} />
              <IconBtn
                label={hidden ? `Show ${w.id}` : `Hide ${w.id}`}
                i={hidden ? ViewOffIcon : EyeIcon}
                onClick={() => p.onToggle(w.id)}
              />
            </WaveRow>
          );
        })}
        {(ended.length > 0 || (p.dismissed?.count ?? 0) > 0) && (
          <li className="coord-group" aria-label="Ended waves">
            <button
              type="button"
              className="coord-group-head"
              aria-expanded={endedOpen}
              onClick={() => setEndedOpen((o) => !o)}
            >
              <Icon i={endedOpen ? ArrowDown01Icon : ArrowRight01Icon} />
              Ended · {ended.length}
            </button>
            {endedOpen && (
              <ul className="coord-list">
                {ended.map((w) => {
                  const c = p.coordinators[w.id] ?? { id: null, state: "gone" as const };
                  const onCanvas = p.shownEnded?.has(w.id) ?? false;
                  return (
                    <WaveRow key={w.id} w={w} c={c} p={p} hidden={!onCanvas}>
                      <button
                        type="button"
                        className="coord-btn"
                        aria-label={`Show ${w.id} on the canvas`}
                        onClick={() => p.onShowEnded?.(w.id)}
                      >
                        Show
                      </button>
                      <button
                        type="button"
                        className="coord-btn"
                        aria-label={`Dismiss ${w.id} from the Desk`}
                        title="Hide it from this Desk (the wave and its journal are not touched)"
                        onClick={() => p.onDismiss?.(w.id)}
                      >
                        Dismiss
                      </button>
                    </WaveRow>
                  );
                })}
                {(p.dismissed?.count ?? 0) > 0 && (
                  <li className="coord-dismissed">
                    {plural(p.dismissed?.count ?? 0, "dismissed wave")} ·{" "}
                    <button type="button" className="coord-link" onClick={p.dismissed?.onRestore}>
                      Bring back
                    </button>
                  </li>
                )}
              </ul>
            )}
          </li>
        )}
        {(p.archived ?? 0) > 0 && (
          <li className="coord-archived">
            {p.archived} archived (<code>volleyd archive</code>)
          </li>
        )}
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
          {!p.finished.shown && (p.finished.waves ?? 0) > 0 && (
            <span className="dim"> · {plural(p.finished.waves ?? 0, "ended wave")} hidden</span>
          )}
        </label>
      )}
    </Frame>
  );
}
