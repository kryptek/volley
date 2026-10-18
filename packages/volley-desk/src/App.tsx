/**
 * The Desk shell: plain background, pannable/zoomable stage, top bar, the
 * coordinators window, a wave window per wave and an agent window per agent
 * (a plain frame for agents with no wave). Every window carries its attention
 * tier (`attention.ts`); the top bar counts what needs you and notifications
 * fire when something starts to. Arrange & fit (`layout/arrange.ts`) packs
 * the windows into per-wave clusters and re-runs on structural changes while
 * auto-arrange is on. Backgrounds and the dock come in later tasks.
 */
import { useEffect, useRef, useState } from "react";
import {
  type Attn,
  type NeedsYouTarget,
  agentAttention,
  coordinatorFor,
  ctxFrom,
  needsYouTargets,
  openDecisions,
  waveAttention,
} from "./attention";
import { type Attention, Frame, useFocusOrder } from "./canvas/Frame";
import { World } from "./canvas/World";
import { type Rect, useViewport } from "./canvas/useViewport";
import { CGAP, type Cluster, GAP, arrange as arrangeLayout } from "./layout/arrange";
import { ARRANGE_ANIM_MS, useAutoArrange, useAutoArrangeSetting } from "./layout/useAutoArrange";
import { type AttentionItem, useNotifyOnAttention } from "./notify/use-notify-on-attention";
import { useNotifySettings } from "./notify/use-notify-settings";
import { useDesk } from "./store/context";
import { UNASSIGNED, agentsByWave } from "./store/reducer";
import type { AgentView, DeskState } from "./store/types";
import { TopBar } from "./topbar/TopBar";
import { AGENT_WIDTH, AgentWindow } from "./windows/agent/AgentWindow";
import { COORDS_ID, COORDS_W, CoordinatorsWindow } from "./windows/coordinators/CoordinatorsWindow";
import { AttentionLine, NeedsYou } from "./windows/wave/NeedsYou";
import { WAVE_W, WaveWindow, meFromSearch } from "./windows/wave/WaveWindow";
import { NEUTRAL_ACCENT, accentFor } from "./windows/wave/accent";

const AGENT_W = AGENT_WIDTH;
// Sizes until a window has been measured (Frame `onSize`).
const WAVE_H = 440;
const AGENT_H = 470;
const COORDS_H = 360;
/** Re-evaluate time-based attention (staleness, escalation) this often. */
const ATTN_TICK_MS = 15_000;

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

const frameAttn = (a: Attn): Attention | undefined => (a.tier === "none" ? undefined : a.tier);

function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/**
 * When this browser first saw each merge-ready gate (`<wave>/<task>`): gates
 * carry no time, and escalation needs one. Entries for cleared gates are dropped.
 */
function useGateSince(state: DeskState, now: number): Record<string, number> {
  const since = useRef<Record<string, number>>({});
  const next: Record<string, number> = {};
  for (const w of Object.values(state.waves)) {
    for (const t of w.state?.gates ?? []) {
      const k = `${w.id}/${t}`;
      next[k] = since.current[k] ?? now;
    }
  }
  since.current = next;
  return next;
}

export default function App() {
  const { state, connection, demo } = useDesk();
  const { view, setView, fitTo, stageRef, stageHandlers } = useViewport();
  const { z, focus } = useFocusOrder();
  const [moved, setMoved] = useState<Record<string, Pos>>({});
  const [me] = useState(() => meFromSearch(window.location.search));
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [coordsOpen, setCoordsOpen] = useState(true);
  const [notify, setNotify] = useNotifySettings();
  const now = useNow(ATTN_TICK_MS);
  const gateSince = useGateSince(state, now);
  const ctx = ctxFrom(state, { now, me, gateSince });

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
  layout[COORDS_ID] = { x: -(COORDS_W + CGAP), y: 0 };
  const pos = (id: string): Pos => moved[id] ?? layout[id] ?? { x: 0, y: 0 };
  const move = (id: string) => (dx: number, dy: number) =>
    setMoved((m) => {
      const p = m[id] ?? layout[id] ?? { x: 0, y: 0 };
      return { ...m, [id]: { x: p.x + dx, y: p.y + dy } };
    });

  const clusterOf = (id: string): Rect[] => [
    { ...pos(id), w: WAVE_W, h: WAVE_H },
    ...(groups[id] ?? []).map((a) => ({ ...pos(a.id), w: AGENT_W, h: AGENT_H })),
  ];
  const visible = waveIds.filter((id) => !hidden.has(id));
  const rects: Rect[] = visible.flatMap(clusterOf);
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || rects.length === 0) return;
    fitted.current = true;
    fitTo(rects);
  });

  // ------------------------------------------------------- arrange & fit
  const sizes = useRef<Record<string, { w: number; h: number }>>({});
  const sizeOf = (id: string, w: number, h: number) => ({ id, ...(sizes.current[id] ?? { w, h }) });
  // D7's dock adds "Arrange & fit" (calls `arrange`) and the auto-arrange toggle.
  const [autoArrange] = useAutoArrangeSetting();
  const [animating, setAnimating] = useState(false);
  const animEnd = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(animEnd.current), []);
  const coordsShown = coordsOpen && Object.values(state.waves).some((w) => w.state !== null);
  const arrange = () => {
    const clusters: Cluster[] = [
      ...(coordsShown ? [{ main: sizeOf(COORDS_ID, COORDS_W, COORDS_H), kids: [] }] : []),
      ...visible.map((id) => ({
        main: sizeOf(id, WAVE_W, WAVE_H),
        kids: (groups[id] ?? []).map((a) => sizeOf(a.id, AGENT_W, AGENT_H)),
      })),
    ];
    const r = arrangeLayout(clusters, { width: window.innerWidth, height: window.innerHeight });
    if (!r) return;
    setAnimating(true);
    setMoved((m) => ({ ...m, ...r.place }));
    setView(r.view);
    clearTimeout(animEnd.current);
    animEnd.current = setTimeout(() => setAnimating(false), ARRANGE_ANIM_MS);
  };
  const layoutKey = [
    coordsShown ? "c" : "",
    ...visible,
    ...visible.flatMap((id) => (groups[id] ?? []).map((a) => a.id)),
  ].join("|");
  useAutoArrange({ enabled: autoArrange, layoutKey, arrange });

  const place = (id: string, attn?: Attention) => ({
    pos: pos(id),
    z: z(id),
    scale: view.s,
    chrome: "glass" as const,
    onMove: move(id),
    onFocus: () => focus(id),
    // A window not laid out yet (0 × 0) keeps its fallback size.
    onSize: (w: number, h: number) => {
      if (w > 0 && h > 0) sizes.current[id] = { w, h };
    },
    ...(attn ? { attn } : {}),
  });
  const frame = (id: string, accent: string, width: number) => ({
    id,
    accent,
    width,
    ...place(id),
  });

  // ------------------------------------------------------------- attention
  const waveAttn: Record<string, Attn> = {};
  for (const w of Object.values(state.waves)) waveAttn[w.id] = waveAttention(w, ctx);
  const agentAttn: Record<string, Attn> = {};
  for (const a of Object.values(state.agents)) {
    agentAttn[a.id] = agentAttention(a, state.waves[a.wave], ctx);
  }
  const targets = needsYouTargets(state, { now, me, gateSince });
  const coordinators = Object.fromEntries(
    Object.values(state.waves).map((w) => [w.id, coordinatorFor(w, ctx)]),
  );

  const show = (wave: string) =>
    setHidden((h) => {
      if (!h.has(wave)) return h;
      const next = new Set(h);
      next.delete(wave);
      return next;
    });
  const toggle = (wave: string) =>
    setHidden((h) => {
      const next = new Set(h);
      if (!next.delete(wave)) next.add(wave);
      return next;
    });
  const goTo = (t: NeedsYouTarget) => {
    show(t.wave);
    fitTo(t.kind === "wave" ? clusterOf(t.id) : [{ ...pos(t.id), w: AGENT_W, h: AGENT_H }]);
    focus(t.id);
  };

  const items: AttentionItem[] = [
    ...Object.values(state.waves).map((w) => ({
      key: `wave:${w.id}`,
      tier: waveAttn[w.id]?.tier ?? "none",
      title: `${w.id} needs you`,
      body: waveAttn[w.id]?.reason ?? "",
    })),
    ...Object.values(state.agents)
      .filter((a) => !state.coordinators[a.id])
      .map((a) => ({
        key: `agent:${a.id}`,
        tier: agentAttn[a.id]?.tier ?? "none",
        title: `${a.task ? `${a.wave} · ${a.task}` : a.id} needs you`,
        body: agentAttn[a.id]?.reason ?? "",
      })),
  ];
  useNotifyOnAttention(notify, items);

  const waveList = Object.values(state.waves).filter((w) => w.state !== null);
  return (
    <div className="app">
      <div className="bg-layer bg-plain" aria-hidden />

      <div className="stage" ref={stageRef} {...stageHandlers}>
        <World view={view} animating={animating}>
          {coordsShown && (
            <CoordinatorsWindow
              waves={waveList}
              coordinators={coordinators}
              needsYou={targets.length}
              me={me}
              hidden={hidden}
              frame={place(COORDS_ID)}
              onToggle={toggle}
              onGoTo={(id) => {
                show(id);
                focus(id);
              }}
              fitTo={fitTo}
              clusterOf={clusterOf}
              onClose={() => setCoordsOpen(false)}
            />
          )}
          {visible.map((id) => {
            const wave = state.waves[id];
            if (!wave) {
              return (
                <Frame key={id} {...frame(id, NEUTRAL_ACCENT, WAVE_W)} title={id}>
                  <div className="dim">{groups[id]?.length ?? 0} agents with no wave</div>
                </Frame>
              );
            }
            const coordinator = coordinators[id];
            return (
              <WaveWindow
                key={id}
                wave={wave}
                me={me}
                coordinatorState={coordinator?.state}
                startedAt={startedAt(id)}
                frame={place(id, frameAttn(waveAttn[id] ?? { tier: "none" }))}
                banner={
                  wave.state &&
                  coordinator && (
                    <NeedsYou
                      wave={id}
                      coordinator={coordinator}
                      openDecisions={openDecisions(wave).length}
                      now={now}
                    />
                  )
                }
              />
            );
          })}
          {visible.flatMap((id) =>
            (groups[id] ?? []).map((a) => (
              // Keyed by bornAt: a window that existed before its registry entry
              // re-mounts with `born` when the entry arrives.
              <AgentWindow
                key={`${a.id}:${a.bornAt ?? ""}`}
                agent={a}
                wave={state.waves[id]}
                accent={accentOf(id)}
                frame={place(a.id, frameAttn(agentAttn[a.id] ?? { tier: "none" }))}
                attention={<AttentionLine attn={agentAttn[a.id] ?? { tier: "none" }} />}
              />
            )),
          )}
        </World>
      </div>

      <TopBar
        state={state}
        connection={connection}
        demo={demo}
        needsYou={targets.length}
        onNeedsYou={() => {
          const first = targets[0];
          if (first) goTo(first);
        }}
        coordsOpen={coordsOpen}
        onToggleCoords={() => setCoordsOpen((o) => !o)}
        notify={notify}
        setNotify={setNotify}
      />
    </div>
  );
}
