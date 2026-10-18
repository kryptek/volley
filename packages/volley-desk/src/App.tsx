/**
 * The Desk shell: plain background, pannable/zoomable stage, top bar, a wave
 * window per wave and an agent window per agent (a plain frame for agents with
 * no wave). The coordinators window, backgrounds, dock and arrange come in later
 * tasks.
 */
import { useEffect, useRef, useState } from "react";
import { Frame, useFocusOrder } from "./canvas/Frame";
import { World } from "./canvas/World";
import { type Rect, useViewport } from "./canvas/useViewport";
import { useDesk } from "./store/context";
import { UNASSIGNED, agentsByWave } from "./store/reducer";
import type { AgentView, DeskState } from "./store/types";
import { AGENT_WIDTH, AgentWindow } from "./windows/agent/AgentWindow";
import { WAVE_W, WaveWindow, meFromSearch } from "./windows/wave/WaveWindow";
import { NEUTRAL_ACCENT, accentFor } from "./windows/wave/accent";

const AGENT_W = AGENT_WIDTH;
// Guesses until D6's arrange measures real windows.
const WAVE_H = 440;
const AGENT_H = 470;
const GAP = 36;
const CGAP = 96;

const accentOf = (wave: string) => (wave === UNASSIGNED ? NEUTRAL_ACCENT : accentFor(wave));

/**
 * Earliest start among a wave's agents (registry `started_at`, else first
 * sighting). Wave state has no start time; App keeps the earliest value ever
 * seen per wave so the age does not jump when early agents leave the store.
 */
function waveStartedAt(agents: readonly AgentView[]): number | null {
  const starts = agents
    .map((a) => Date.parse(a.registry?.started_at ?? "") || a.bornAt)
    .filter((t): t is number => typeof t === "number" && Number.isFinite(t));
  return starts.length ? Math.min(...starts) : null;
}

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
  const [me] = useState(() => meFromSearch(window.location.search));

  const groups = agentsByWave(state);
  const firstStart = useRef<Record<string, number>>({});
  const startedAt = (id: string): number | null => {
    const t = waveStartedAt(groups[id] ?? []);
    const prev = firstStart.current[id];
    if (t !== null && (prev === undefined || t < prev)) firstStart.current[id] = t;
    return firstStart.current[id] ?? null;
  };
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

  const place = (id: string) => ({
    pos: pos(id),
    z: z(id),
    scale: view.s,
    chrome: "glass" as const,
    onMove: move(id),
    onFocus: () => focus(id),
  });
  const frame = (id: string, accent: string, width: number) => ({
    id,
    accent,
    width,
    ...place(id),
  });

  const agents = Object.values(state.agents);
  return (
    <div className="app">
      <div className="bg-layer bg-plain" aria-hidden />

      <div className="stage" ref={stageRef} {...stageHandlers}>
        <World view={view}>
          {waveIds.map((id) => {
            const wave = state.waves[id];
            if (!wave) {
              return (
                <Frame key={id} {...frame(id, NEUTRAL_ACCENT, WAVE_W)} title={id}>
                  <div className="dim">{groups[id]?.length ?? 0} agents with no wave</div>
                </Frame>
              );
            }
            const owner = wave.state?.owner;
            return (
              <WaveWindow
                key={id}
                wave={wave}
                me={me}
                coordinatorState={owner ? state.coordinators[owner]?.state : undefined}
                startedAt={startedAt(id)}
                frame={place(id)}
              />
            );
          })}
          {waveIds.flatMap((id) =>
            (groups[id] ?? []).map((a) => (
              // Keyed by bornAt: a window that existed before its registry entry
              // re-mounts with `born` when the entry arrives.
              <AgentWindow
                key={`${a.id}:${a.bornAt ?? ""}`}
                agent={a}
                wave={state.waves[id]}
                accent={accentOf(id)}
                frame={place(a.id)}
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
