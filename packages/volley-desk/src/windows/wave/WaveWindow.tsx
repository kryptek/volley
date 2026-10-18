/**
 * The wave window, ported from the prototype `WaveWindow`: Clawd + wave id +
 * owner chip in the title, chat and gear glyphs (their panels land with the
 * steering panel and settings tasks), a banner slot for the Needs-you / claim
 * banners, the dependency graph above the wave file, and a footer rail with
 * one segment per task, the wave's completion and its counts.
 */
import { BubbleChatIcon, Settings02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useEffect, useState } from "react";
import { Frame, type FrameProps } from "../../canvas/Frame";
import type { CoordinatorState, WaveStatePayload, WaveView } from "../../store/types";
import { Clawd } from "./Clawd";
import { Dag, type DagNode } from "./Dag";
import { WaveYaml } from "./WaveYaml";
import { accentFor } from "./accent";
import { STAGE_LABEL, STAGE_WEIGHT, deskStage, wavePct } from "./stages";
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
  /** Fixed clock for tests; otherwise the window re-renders every 5 s. */
  now?: number;
  frame: Omit<FrameProps, "id" | "title" | "accent" | "width" | "actions" | "footer" | "children">;
  /** Needs-you / claim banners, shown above the graph. */
  banner?: ReactNode;
  /** Children after the wave file (the steering panel). */
  children?: ReactNode;
  /** Highlights the chat glyph while the steering panel is open. */
  steerOpen?: boolean;
  onChat?: (wave: string) => void;
  onSettings?: (wave: string) => void;
}

/** Desk read of `?me=<agent_id>`: the coordinator this browser speaks for. */
export function meFromSearch(search: string): string | null {
  return new URLSearchParams(search).get("me") || null;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`;
}

function useNow(fixed: number | undefined, ms = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (fixed !== undefined) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [fixed, ms]);
  return fixed ?? now;
}

function IconBtn(p: {
  label: string;
  i: typeof BubbleChatIcon;
  onClick: () => void;
  hot?: boolean;
}) {
  return (
    <button
      type="button"
      className={`icon-btn${p.hot ? " icon-btn--hot" : ""}`}
      onClick={p.onClick}
      aria-label={p.label}
      title={p.label}
    >
      <HugeiconsIcon icon={p.i} size={15} strokeWidth={1.8} />
    </button>
  );
}

/** Graph nodes in wave-file order; tasks the spec does not list are appended. */
export function dagNodes(s: WaveStatePayload): DagNode[] {
  const stage = new Map(s.tasks.map((t) => [t.id, deskStage(t.stage)]));
  const fromSpec: DagNode[] = Object.entries(s.spec?.tasks ?? {}).map(([id, t]) => ({
    id,
    issue: t.issue,
    after: t.after,
    stage: stage.get(id) ?? "queued",
    ...(t.title ? { title: t.title } : {}),
  }));
  const listed = new Set(fromSpec.map((n) => n.id));
  const extra = s.tasks
    .filter((t) => !listed.has(t.id))
    .map((t): DagNode => ({ id: t.id, issue: t.issue, after: [], stage: deskStage(t.stage) }));
  return [...fromSpec, ...extra];
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function WaveWindow(p: WaveWindowProps) {
  const now = useNow(p.now);
  const s = p.wave.state;
  const id = p.wave.id;
  const accent = accentFor(id);
  const waiting = (p.coordinatorState ?? s?.coordinator?.state) === "awaiting_input";
  const mine = p.me !== null && s?.owner === p.me;
  const tasks = s ? dagNodes(s) : [];
  const pct = wavePct(tasks.map((t) => t.stage));
  const merged = tasks.filter((t) => t.stage === "merged").length;
  // Count unresolved decisions from the store, not state.open_decisions: a resolved decision can linger in the
  // retained state until the supervisor re-publishes it (D0 fixup, "ghost" decisions).
  const openDecisions = Object.values(p.wave.decisions).filter((d) => !d.resolved).length;

  const title = (
    <>
      <Clawd waiting={waiting} />
      <span className="t-name">{id}</span>
      {s && (
        <span className={`chip${mine ? " chip--mine" : ""}`}>
          {mine ? "★ yours" : (s.owner ?? "no owner")}
        </span>
      )}
    </>
  );

  const actions = (
    <>
      <IconBtn
        label={`Message the coordinator of ${id}`}
        i={BubbleChatIcon}
        onClick={() => p.onChat?.(id)}
        hot={p.steerOpen ?? false}
      />
      <IconBtn label={`Settings for ${id}`} i={Settings02Icon} onClick={() => p.onSettings?.(id)} />
    </>
  );

  const footer = s && (
    <div className="rail">
      {/* biome-ignore lint/a11y/useFocusableInteractive: a progressbar is a read-only status, not a control */}
      <div
        className="rail-bar"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${id} progress`}
      >
        {tasks.map((t) => (
          <span
            key={t.id}
            className={`rail-seg st-${t.stage}`}
            title={`${t.id} · ${STAGE_LABEL[t.stage]}`}
          >
            <span style={{ width: `${STAGE_WEIGHT[t.stage] * 100}%` }} />
          </span>
        ))}
      </div>
      <div className="rail-meta">
        <span className="rail-pct">{pct}%</span>
        <span>
          {merged} of {tasks.length} merged
        </span>
        <span>
          {plural(openDecisions, "decision")} · {plural(s.gates.length, "gate")}
        </span>
        {p.startedAt != null && <span className="mono dim">running {ago(now - p.startedAt)}</span>}
      </div>
    </div>
  );

  return (
    <Frame
      {...p.frame}
      id={id}
      title={title}
      accent={accent}
      width={WAVE_W}
      actions={actions}
      footer={footer}
    >
      {p.banner}
      {s ? (
        <div className="wave-grid">
          <div>
            <div className="lbl">Dependency graph</div>
            <Dag tasks={tasks} accent={accent} />
          </div>
          <div className="min0">
            <div className="lbl">
              Wave file <span className="dim mono">v{s.spec?.version ?? s.version}</span>
            </div>
            <WaveYaml wave={s} />
          </div>
        </div>
      ) : (
        <div className="dim">waiting for wave state</div>
      )}
      {p.children}
    </Frame>
  );
}
