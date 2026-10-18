/**
 * The Desk shell: plain background, pannable/zoomable stage, top bar, the
 * coordinators window, a wave window per wave and an agent window per agent
 * (a plain frame for agents with no wave). Every window carries its attention
 * tier (`attention.ts`); the top bar counts what needs you and notifications
 * fire when something starts to. Arrange & fit (`layout/arrange.ts`) packs
 * the windows into per-wave clusters and re-runs on structural changes while
 * auto-arrange is on. The look (D7, `look/`): the picked React Bits
 * background under its dim, the window chrome, Needs-you and narration
 * effects, tethers, the Appearance panel, the dock and toasts.
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
import { ARRANGE_ANIM_MS, useAutoArrange } from "./layout/useAutoArrange";
import { Appearance } from "./look/Appearance";
import { Background } from "./look/Background";
import { DeskDock, DeskToast, useToast } from "./look/DeskDock";
import { type Tether, Tethers } from "./look/Tethers";
import { useLook } from "./look/useLook";
import { type AttentionItem, useNotifyOnAttention } from "./notify/use-notify-on-attention";
import { useNotifySettings } from "./notify/use-notify-settings";
import { SettingsModal } from "./settings/SettingsModal";
import { useDesk } from "./store/context";
import { UNASSIGNED, agentsByWave } from "./store/reducer";
import type { AgentView, DeskState } from "./store/types";
import { TopBar } from "./topbar/TopBar";
import { AGENT_WIDTH, AgentWindow } from "./windows/agent/AgentWindow";
import {
  COORDS_ID,
  COORDS_W,
  CoordinatorsWindow,
  ENDED_LABEL,
} from "./windows/coordinators/CoordinatorsWindow";
import { AttentionLine, NeedsYou } from "./windows/wave/NeedsYou";
import { WAVE_W, WaveWindow, meFromSearch } from "./windows/wave/WaveWindow";
import { NEUTRAL_ACCENT, accentFor } from "./windows/wave/accent";

const AGENT_W = AGENT_WIDTH;
// Sizes until a window has been measured (Frame `onSize`), shared by the
// placeholder layout, the fits and arrange. The prototype's arrange guessed
// 620 / 520; in a browser the ResizeObserver reports before arrange runs, so
// one set of guesses is kept on purpose.
const WAVE_H = 440;
const AGENT_H = 470;
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

/** Rough coordinators window height for the initial fit: header + one row per wave + note. */
const coordsH = (waves: number) => 150 + 66 * waves;

/**
 * Placeholder layout: one row per wave, its agents in two columns to the
 * right; the coordinators window below the waves, as in the prototype.
 */
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
  at[COORDS_ID] = { x: 0, y };
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
 * carry no time, and escalation needs one. Entries for cleared gates are
 * dropped, except while the store is settling: a reconnect's resync empties
 * the waves, and the replay should not restart the escalation clock.
 */
function useGateSince(state: DeskState, settling: boolean): Record<string, number> {
  const since = useRef<Record<string, number>>({});
  const at = Date.now();
  const next: Record<string, number> = settling ? { ...since.current } : {};
  for (const w of Object.values(state.waves)) {
    for (const t of w.state?.gates ?? []) {
      const k = `${w.id}/${t}`;
      next[k] = since.current[k] ?? at;
    }
  }
  useEffect(() => {
    since.current = next;
  });
  return next;
}

export default function App() {
  const { state, connection, demo, settling, offline } = useDesk();
  const { view, setView, zoomAt, fitTo, stageRef, stageHandlers } = useViewport();
  const { z, focus } = useFocusOrder();
  const [moved, setMoved] = useState<Record<string, Pos>>({});
  const [me] = useState(() => meFromSearch(window.location.search));
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [coordsOpen, setCoordsOpen] = useState(true);
  const [notify, setNotify] = useNotifySettings();
  const now = useNow(ATTN_TICK_MS);
  const gateSince = useGateSince(state, settling);
  const ctxOpts = { now, me, gateSince, offline };
  const ctx = ctxFrom(state, ctxOpts);
  const [settings, setSettings] = useState<string | null>(null);
  // The settings modal closes for good when its wave goes away; it must not reopen if it returns.
  const settingsWaveGone = settings !== null && !state.waves[settings];
  useEffect(() => {
    if (settingsWaveGone) setSettings(null);
  }, [settingsWaveGone]);

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

  const sizes = useRef<Record<string, { w: number; h: number }>>({});
  const sizeOf = (id: string, w: number, h: number) => ({ id, ...(sizes.current[id] ?? { w, h }) });
  const rectOf = (id: string, w: number, h: number): Rect => {
    const { w: sw, h: sh } = sizeOf(id, w, h);
    return { ...pos(id), w: sw, h: sh };
  };
  const clusterOf = (id: string): Rect[] => [
    rectOf(id, WAVE_W, WAVE_H),
    ...(groups[id] ?? []).map((a) => rectOf(a.id, AGENT_W, AGENT_H)),
  ];
  const visible = waveIds.filter((id) => !hidden.has(id));
  const waveList = Object.values(state.waves).filter((w) => w.state !== null);
  const coordsShown = coordsOpen && waveList.length > 0;
  const rects: Rect[] = [
    ...visible.flatMap(clusterOf),
    ...(coordsShown ? [{ ...pos(COORDS_ID), w: COORDS_W, h: coordsH(waveList.length) }] : []),
  ];
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || rects.length === 0) return;
    fitted.current = true;
    fitTo(rects);
  });

  // ------------------------------------------------------------ look (D7)
  const [look, setLook] = useLook();
  const [lookOpen, setLookOpen] = useState(false);
  const [toast, say, closeToast] = useToast();

  // ------------------------------------------------------- arrange & fit
  const autoArrange = look.autoArrange;
  const [animating, setAnimating] = useState(false);
  const animEnd = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(animEnd.current), []);
  const arrange = () => {
    // Forget the sizes of windows that have left the store.
    for (const id of Object.keys(sizes.current)) {
      if (id !== COORDS_ID && !state.agents[id] && !waveIds.includes(id)) delete sizes.current[id];
    }
    const clusters: Cluster[] = [
      ...(coordsShown
        ? [{ main: sizeOf(COORDS_ID, COORDS_W, coordsH(waveList.length)), kids: [] }]
        : []),
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
  // A reconnect's resync empties the waves and the replay rebuilds them: hold the
  // key until it settles, so only windows that really came or went re-arrange.
  // The first connect (and demo load) settles too, but arranges as data arrives.
  const settledOnce = useRef(false);
  if (!settling) settledOnce.current = true;
  useAutoArrange({
    enabled: autoArrange,
    layoutKey,
    arrange,
    hold: settling && settledOnce.current,
  });

  const place = (id: string, attn?: Attention) => ({
    pos: pos(id),
    z: z(id),
    scale: view.s,
    chrome: look.chrome,
    attnStyle: look.attn,
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
  const targets = needsYouTargets(state, ctxOpts, { waves: waveAttn, agents: agentAttn });
  const coordinators = Object.fromEntries(
    Object.values(state.waves).map((w) => [w.id, coordinatorFor(w, ctx)]),
  );
  // The coordinators window's chip, as in the prototype: live waves whose coordinator is not working.
  const notWorking = waveList.filter(
    (w) => !ENDED_LABEL[w.state?.status ?? ""] && coordinators[w.id]?.state !== "working",
  ).length;

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
    fitTo(t.kind === "wave" ? clusterOf(t.id) : [rectOf(t.id, AGENT_W, AGENT_H)]);
    focus(t.id);
  };

  // One notification per transition, like the pill: an agent whose wave already
  // needs you is covered by the wave's notification.
  const youWaves = new Set(targets.filter((t) => t.kind === "wave").map((t) => t.wave));
  const items: AttentionItem[] = [
    ...Object.values(state.waves).map((w) => ({
      key: `wave:${w.id}`,
      tier: waveAttn[w.id]?.tier ?? "none",
      title: `${w.id} needs you`,
      body: waveAttn[w.id]?.reason ?? "",
    })),
    ...Object.values(state.agents)
      .filter((a) => !state.coordinators[a.id] && !youWaves.has(a.wave))
      .map((a) => ({
        key: `agent:${a.id}`,
        tier: agentAttn[a.id]?.tier ?? "none",
        title: `${a.task ? `${a.wave} · ${a.task}` : a.id} needs you`,
        body: agentAttn[a.id]?.reason ?? "",
      })),
  ];
  useNotifyOnAttention(notify, items, { quiet: settling });

  // Tethers: wave window → each of its agents, for visible waves.
  const tethers: Tether[] = visible.flatMap((id) =>
    (groups[id] ?? []).map((a) => ({
      id: a.id,
      wave: { ...pos(id), w: WAVE_W },
      agent: pos(a.id),
      accent: accentOf(id),
    })),
  );
  const toggleAutoArrange = () => {
    const on = !look.autoArrange;
    setLook({ autoArrange: on });
    say(
      on ? "Auto-arrange on" : "Auto-arrange off",
      on
        ? "New, hidden or shown windows re-arrange and re-fit automatically."
        : "Windows stay where you put them.",
    );
  };
  return (
    <div className="app">
      <Background which={look.bg} dim={look.dim} />

      <div className="stage" ref={stageRef} {...stageHandlers}>
        <World view={view} animating={animating}>
          <Tethers on={look.tethers} tethers={tethers} />
          {coordsShown && (
            <CoordinatorsWindow
              waves={waveList}
              coordinators={coordinators}
              needsYou={notWorking}
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
            // Only a wave at tier you gets a banner: an ended wave's coordinator is gone
            // because the work is done, not because the wave needs claiming.
            const needsYou = waveAttn[id]?.tier === "you";
            return (
              <WaveWindow
                key={id}
                wave={wave}
                me={me}
                coordinatorState={coordinator?.state}
                startedAt={startedAt(id)}
                frame={place(id, frameAttn(waveAttn[id] ?? { tier: "none" }))}
                banner={
                  needsYou &&
                  coordinator && (
                    <NeedsYou
                      wave={id}
                      coordinator={coordinator}
                      openDecisions={openDecisions(wave).length}
                      now={now}
                    />
                  )
                }
                onSettings={setSettings}
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
                narrationFx={look.narr}
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

      {lookOpen && (
        <Appearance
          look={look}
          setLook={setLook}
          onClose={() => setLookOpen(false)}
          onArrange={arrange}
        />
      )}

      <DeskDock
        coordsOpen={coordsOpen}
        onToggleCoords={() => setCoordsOpen((o) => !o)}
        needsYou={targets.length}
        lookOpen={lookOpen}
        onToggleLook={() => setLookOpen((o) => !o)}
        tethers={look.tethers}
        onToggleTethers={() => setLook({ tethers: !look.tethers })}
        onArrange={arrange}
        autoArrange={look.autoArrange}
        onToggleAutoArrange={toggleAutoArrange}
        onZoom={(f) => zoomAt(f)}
      />

      <DeskToast toast={toast} onClose={closeToast} />

      {settings !== null && state.waves[settings] && (
        // No config transport until the Desk signs in with broker credentials: read-only.
        <SettingsModal
          wave={state.waves[settings]}
          config={state.config}
          transport={null}
          onClose={() => setSettings(null)}
        />
      )}
    </div>
  );
}
