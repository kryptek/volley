/**
 * The wave window, ported from the prototype `WaveWindow`: Clawd + wave id +
 * owner chip in the title, chat and gear glyphs (their panels land with the
 * steering panel and settings tasks), a banner slot for the Needs-you / claim
 * banners, the dependency graph or the wave file, and a footer rail with one
 * segment per task and the wave's completion.
 */
import { BubbleChatIcon, Settings01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useState } from "react";
import { Frame, type FrameProps } from "../../canvas/Frame";
import type { CoordinatorState, WaveStatePayload, WaveView } from "../../store/types";
import { Clawd } from "./Clawd";
import { Dag, type DagNode } from "./Dag";
import { WaveYaml } from "./WaveYaml";
import { accentFor } from "./accent";
import { STAGE_LABEL, deskStage, wavePct } from "./stages";
import "../../styles/wave.css";

export const WAVE_W = 620;

export interface WaveWindowProps {
  wave: WaveView;
  /** This browser's coordinator agent id (`?me=`); `null` = no wave is mine. */
  me: string | null;
  /** The store's view of the owner coordinator; falls back to the wave state's `coordinator`. */
  coordinatorState?: CoordinatorState | undefined;
  /** ms when the wave started (its earliest agent); omitted → no age shown. */
  startedAt?: number | null | undefined;
  now?: number;
  frame: Omit<FrameProps, "id" | "title" | "accent" | "width" | "actions" | "footer" | "children">;
  /** Needs-you / claim banners. */
  banner?: ReactNode;
  onChat?: (wave: string) => void;
  onSettings?: (wave: string) => void;
}

/** Desk read of `?me=<agent_id>`: the coordinator this browser speaks for. */
export function meFromSearch(search: string): string | null {
  return new URLSearchParams(search).get("me") || null;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function ago(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

/** Graph nodes in wave-file order; tasks the spec does not list are appended. */
export function dagNodes(s: WaveStatePayload): DagNode[] {
  const stage = new Map(s.tasks.map((t) => [t.id, deskStage(t.stage)]));
  const fromSpec: DagNode[] = Object.entries(s.spec?.tasks ?? {}).map(([id, t]) => ({
    id,
    after: t.after,
    stage: stage.get(id) ?? "queued",
    ...(t.title ? { title: t.title } : {}),
  }));
  const listed = new Set(fromSpec.map((n) => n.id));
  const extra = s.tasks
    .filter((t) => !listed.has(t.id))
    .map((t): DagNode => ({ id: t.id, after: [], stage: deskStage(t.stage) }));
  return [...fromSpec, ...extra];
}

export function WaveWindow(p: WaveWindowProps) {
  const [view, setView] = useState<"graph" | "file">("graph");
  const s = p.wave.state;
  const id = p.wave.id;
  const waiting = (p.coordinatorState ?? s?.coordinator?.state) === "awaiting_input";
  const mine = p.me !== null && s?.owner === p.me;
  const nodes = s ? dagNodes(s) : [];
  const pct = wavePct(nodes.map((n) => n.stage));

  const title = (
    <>
      <Clawd waiting={waiting} />
      <span className="t-name ell">{id}</span>
      {mine ? (
        <span className="chip chip--mine">★ yours</span>
      ) : (
        s && <span className="chip mono">{s.owner ?? "no owner"}</span>
      )}
    </>
  );

  const actions = (
    <>
      <button
        type="button"
        className="icon-btn"
        aria-label="Steer wave"
        title="Steer wave"
        onClick={() => p.onChat?.(id)}
      >
        <HugeiconsIcon icon={BubbleChatIcon} size={16} />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label="Wave settings"
        title="Wave settings"
        onClick={() => p.onSettings?.(id)}
      >
        <HugeiconsIcon icon={Settings01Icon} size={16} />
      </button>
    </>
  );

  const footer = s && (
    <div className="rail-row">
      <div className="rail">
        {nodes.map((n) => (
          <span
            key={n.id}
            className={`rail-seg rail-seg--${n.stage}`}
            title={`${n.id} · ${STAGE_LABEL[n.stage]}`}
          />
        ))}
      </div>
      <span className="rail-pct mono">{pct}%</span>
      {p.startedAt != null && (
        <span className="rail-age dim">started {ago((p.now ?? Date.now()) - p.startedAt)}</span>
      )}
    </div>
  );

  return (
    <Frame
      {...p.frame}
      id={id}
      title={title}
      accent={accentFor(id)}
      width={WAVE_W}
      actions={actions}
      footer={footer}
    >
      {p.banner}
      {s ? (
        <>
          <div className="wave-meta">
            <span className="mono dim ell min0">
              {s.status} · {s.release_branch}
            </span>
            <span className="wave-counts">
              {plural(s.open_decisions.length, "decision")} · {plural(s.gates.length, "gate")}
            </span>
          </div>
          <div className="wave-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={view === "graph"}
              className={`pill${view === "graph" ? " pill--on" : ""}`}
              onClick={() => setView("graph")}
            >
              graph
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === "file"}
              className={`pill${view === "file" ? " pill--on" : ""}`}
              onClick={() => setView("file")}
            >
              wave file
            </button>
          </div>
          {view === "graph" ? <Dag nodes={nodes} /> : <WaveYaml wave={s} />}
        </>
      ) : (
        <div className="dim">waiting for wave state</div>
      )}
    </Frame>
  );
}
