/**
 * The Desk shell: plain background, pannable/zoomable stage, top bar, the
 * agent windows, and a placeholder window per wave. The
 * real wave and coordinators windows, backgrounds, dock and arrange
 * replace the placeholders in later tasks.
 */
import { useEffect, useRef, useState } from "react";
import { Frame, useFocusOrder } from "./canvas/Frame";
import { World } from "./canvas/World";
import { type Rect, useViewport } from "./canvas/useViewport";
import { useDesk } from "./store/context";
import { UNASSIGNED, agentsByWave } from "./store/reducer";
import type { AgentView, DeskState, WaveView } from "./store/types";
import { AgentWindow } from "./windows/agent/AgentWindow";

const WAVE_W = 620;
const AGENT_W = 460;
const WAVE_H = 300;
const AGENT_H = 470;
const GAP = 36;
const CGAP = 96;
const ACCENT = "#6ee7f9";
const NEUTRAL = "#a3abc0";

type Pos = { x: number; y: number };

/** Placeholder layout: one row per wave, its agents in two columns to the right. */
function placeholderLayout(waveIds: string[], groups: Record<string, AgentView[]>) {
  const at: Record<string, Pos> = {};
  let y = 0;
  for (const id of waveIds) {
    at[id] = { x: 0, y };
    const kids = groups[id] ?? [];
    kids.forEach((a, k) => {
      at[a.id] = {
        x: WAVE_W + GAP + (k % 2) * (AGENT_W + GAP),
        y: y + Math.floor(k / 2) * (AGENT_H + GAP),
      };
    });
    y += Math.max(WAVE_H, Math.ceil(kids.length / 2) * (AGENT_H + GAP) - GAP) + CGAP;
  }
  return at;
}

function leaseSummary(state: DeskState): string {
  return Object.values(state.leases)
    .map((p) => `${p.pool} ${p.held.length}/${p.capacity}`)
    .join(" · ");
}

export default function App() {
  const { state, connection, demo } = useDesk();
  const { view, fitTo, stageRef, stageHandlers } = useViewport();
  const { z, focus } = useFocusOrder();
  const [moved, setMoved] = useState<Record<string, Pos>>({});

  const groups = agentsByWave(state);
  const waveIds = [
    ...Object.keys(state.waves),
    ...((groups[UNASSIGNED]?.length ?? 0) > 0 ? [UNASSIGNED] : []),
  ];
  const layout = placeholderLayout(waveIds, groups);
  const pos = (id: string): Pos => moved[id] ?? layout[id] ?? { x: 0, y: 0 };
  const move = (id: string) => (dx: number, dy: number) =>
    setMoved((m) => {
      const p = m[id] ?? layout[id] ?? { x: 0, y: 0 };
      return { ...m, [id]: { x: p.x + dx, y: p.y + dy } };
    });

  const rects: Rect[] = waveIds.flatMap((id) => [
    { ...pos(id), w: WAVE_W, h: WAVE_H },
    ...(groups[id] ?? []).map((a) => ({ ...pos(a.id), w: AGENT_W, h: AGENT_H })),
  ]);
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || rects.length === 0) return;
    fitted.current = true;
    fitTo(rects);
  });

  const frame = (id: string, accent: string, width: number) => ({
    id,
    accent,
    width,
    pos: pos(id),
    z: z(id),
    scale: view.s,
    chrome: "glass" as const,
    onMove: move(id),
    onFocus: () => focus(id),
  });

  const agents = Object.values(state.agents);
  return (
    <div className="app">
      <div className="bg-layer bg-plain" aria-hidden />

      <div className="stage" ref={stageRef} {...stageHandlers}>
        <World view={view}>
          {waveIds.map((id) => (
            <PlaceholderWave
              key={id}
              wave={state.waves[id]}
              id={id}
              count={groups[id]?.length ?? 0}
              frame={frame(id, id === UNASSIGNED ? NEUTRAL : ACCENT, WAVE_W)}
            />
          ))}
          {waveIds.flatMap((id) =>
            (groups[id] ?? []).map((a) => (
              // Keyed by bornAt: a window that existed before its registry entry
              // re-mounts with `born` when the entry arrives.
              <AgentWindow
                key={`${a.id}:${a.bornAt ?? ""}`}
                agent={a}
                wave={state.waves[id]}
                accent={ACCENT}
                frame={frame(a.id, ACCENT, AGENT_W)}
              />
            )),
          )}
        </World>
      </div>

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">volley</span>
          <span className="brand-sub">desk</span>
        </div>
        <span className="proto">{demo ? "Demo · sample data" : connection}</span>
        <div className="topbar-mid">
          <span>
            <b>{Object.values(state.waves).filter((w) => w.state !== null).length}</b> waves
          </span>
          <span>
            <b>{agents.filter((a) => a.status?.type === "working").length}</b> agents working
          </span>
          {Object.keys(state.leases).length > 0 && (
            <span className="mono">{leaseSummary(state)}</span>
          )}
        </div>
      </header>
    </div>
  );
}

function PlaceholderWave({
  id,
  wave,
  count,
  frame,
}: {
  id: string;
  wave: WaveView | undefined;
  count: number;
  frame: Omit<Parameters<typeof Frame>[0], "title" | "children">;
}) {
  const s = wave?.state;
  const coordinator = s?.coordinator;
  return (
    <Frame {...frame} title={id}>
      {s ? (
        <>
          <div className="mono dim">
            {s.status} · {s.release_branch} · owner {s.owner ?? "none"}
            {coordinator && ` (${coordinator.state})`}
          </div>
          <ul className="placeholder-tasks">
            {s.tasks.map((t) => (
              <li key={t.id} className="mono">
                {t.id} · {s.spec?.tasks[t.id]?.title ?? `#${t.issue}`} · {t.stage}
              </li>
            ))}
          </ul>
          <div className="dim">
            {Object.values(wave.decisions).filter((d) => !d.resolved).length} open decisions ·{" "}
            {s.gates.length} gates
          </div>
        </>
      ) : id === UNASSIGNED ? (
        <div className="dim">{count} agents with no wave</div>
      ) : (
        <div className="dim">waiting for wave state</div>
      )}
    </Frame>
  );
}
