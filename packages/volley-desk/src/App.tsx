/**
 * The Desk shell: plain background, pannable/zoomable stage, top bar, the
 * coordinators window, a wave window per wave and an agent window per agent
 * (a plain frame for agents with no wave). Every window carries its attention
 * tier (`attention.ts`); the top bar counts what needs you and notifications
 * fire when something starts to. Arrange & fit (`layout/arrange.ts`) packs
 * the windows into per-wave clusters and re-runs on structural changes while
 * auto-arrange is on. The chat glyphs open the steering panel (D4). The look (D7,
 * `look/`): the picked React Bits background under its dim, the window chrome,
 * Needs-you and narration effects, tethers and the dock. The Settings window (O1,
 * `settings/SettingsWindow.tsx`) holds General, Appearance, Supervisor (the global
 * volleyd config), the Onboarding sections and About; a wave's ⚙ opens that wave's
 * effective config. Onboarding (O4): Broker accounts and Setup & Security talk to
 * volleyd over the admin channel (`store/control.ts`); a just-redeemed admin token
 * opens Setup & Security once, its Preview shows the sign-in screen, and Open setup…
 * closes Settings and shows the setup wizard in its own modal (as the prototype).
 * Hardening (D8): the phone layout (`useViewportWidth`), the look degraded
 * without WebGL (`degradeLook`), and the keyboard (`a11y/keys.ts`) on a
 * focusable, labelled stage. Desk round 2 (S6): stopped / complete waves fold
 * off the canvas with their agents under "Show finished" (and get no tethers
 * when shown); the reconnect / resume grace (`syncing`) holds every liveness
 * judgement; a task's parallel reviewers carry the `review (spec + quality)` chip.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useDeskKeys } from "./a11y/keys";
import {
  type Attn,
  type NeedsYouTarget,
  agentAttention,
  coordinatorFor,
  ctxFrom,
  needsYouTargets,
  noSignalFor,
  openDecisions,
  waveAttention,
} from "./attention";
import { SignInPreview } from "./auth/SignInGate";
import { type Attention, Frame, useFocusOrder } from "./canvas/Frame";
import { World } from "./canvas/World";
import {
  NARROW_PX,
  type Rect,
  clampWindowWidth,
  phoneMaxWidth,
  useViewport,
  useViewportWidth,
} from "./canvas/useViewport";
import { CGAP, type Cluster, GAP, arrange as arrangeLayout } from "./layout/arrange";
import { ARRANGE_ANIM_MS, useAutoArrange } from "./layout/useAutoArrange";
import { plural } from "./lib/plural";
import { Background, degradeLook, useWebGL } from "./look/Background";
import { DeskDock } from "./look/DeskDock";
import { type Tether, Tethers } from "./look/Tethers";
import { progressBeat } from "./look/tetherPulses";
import { useLook } from "./look/useLook";
import { type AttentionItem, useNotifyOnAttention } from "./notify/use-notify-on-attention";
import { useNotifySettings } from "./notify/use-notify-settings";
import { MOVE_ACCOUNT_TIMEOUT_MS } from "./settings/ClaudeAccounts";
import { SettingsModal } from "./settings/SettingsModal";
import { SettingsWindow } from "./settings/SettingsWindow";
import { SetupWizard } from "./settings/SetupWizard";
import { DAEMON_AGENT_ID, createConfigTransport } from "./settings/configTransport";
import type { SectionKey } from "./settings/sections";
import { ClaimButton } from "./steer/SteerPanel";
import { useSteering, waveChatTarget } from "./steer/useSteering";
import { type RegistryAccount, accountChoices, accountList } from "./store/claude";
import { useDesk } from "./store/context";
import { createAuthOps, deskUrl, takeFirstRun } from "./store/control";
import {
  UNASSIGNED,
  agentsByWave,
  endedWaves,
  finishedAgents,
  isSupervisorId,
  stageChip,
  supervisorList,
  supervisorNamespace,
} from "./store/reducer";
import type { AgentView, DeskState } from "./store/types";
import { TopBar } from "./topbar/TopBar";
import { AGENT_WIDTH, AgentWindow, ROLE_LABEL } from "./windows/agent/AgentWindow";
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
/** The supervisor's age (top-bar pill, coordinators row) ticks this often while one is shown. */
const SUPERVISOR_TICK_MS = 2000;

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

/**
 * Why an urgent `/stop` must not interrupt `a`, or undefined when it may.
 * volleyd presses Escape in whoever holds `tasks[].agents[role]` now, and an
 * agent keeps its role after the slot moves on to a new agent (the reducer is
 * sticky), so a stale window would interrupt the slot's new agent instead.
 */
function interruptBlocker(state: DeskState, a: AgentView): string | undefined {
  if (a.wave === UNASSIGNED || !a.task) return undefined; // the transport says "no wave task"
  if (!a.role) return `${a.id} has no role on ${a.task}`;
  const holder = state.waves[a.wave]?.state?.tasks.find((t) => t.id === a.task)?.agents[a.role];
  if (holder === a.id) return undefined;
  return `${a.id} no longer holds the ${a.role} slot on ${a.task}${holder ? ` (now ${holder})` : ""}`;
}

type Pos = { x: number; y: number };

/** Rough coordinators window height for the initial fit: header + one row per wave and supervisor + note. */
const coordsH = (rows: number) => 150 + 66 * rows;

/**
 * Placeholder layout: one row per wave, its agents in two columns to the
 * right; the coordinators window below the waves, as in the prototype.
 * `clampW` gives a window's rendered width (clamped on a phone).
 */
function placeholderLayout(
  waveIds: string[],
  groups: Record<string, AgentView[]>,
  clampW: (w: number) => number,
) {
  const at: Record<string, Pos> = {};
  let y = 0;
  for (const id of waveIds) {
    at[id] = { x: 0, y };
    const kids = groups[id] ?? [];
    kids.forEach((a, k) => {
      at[a.id] = {
        x: clampW(WAVE_W) + GAP + (k % 2) * (clampW(AGENT_W) + GAP),
        y: y + Math.floor(k / 2) * (AGENT_H + GAP),
      };
    });
    y += Math.max(WAVE_H, Math.ceil(kids.length / 2) * (AGENT_H + GAP) - GAP) + CGAP;
  }
  at[COORDS_ID] = { x: 0, y };
  return at;
}

const frameAttn = (a: Attn): Attention | undefined => (a.tier === "none" ? undefined : a.tier);

/** A clock ticking every `ms`; `null` stops it. */
function useNow(ms: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (ms === null) return;
    setNow(Date.now());
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

/** Agents whose last status is not terminal (as `volley setup` counts "agents running"), supervisors aside. */
function liveAgentCount(state: DeskState): number {
  return Object.values(state.agents).filter(
    (a) =>
      !isSupervisorId(a.id) &&
      a.status != null &&
      !["done", "failed", "reaped"].includes(a.status.type),
  ).length;
}

export default function App() {
  const { state, connection, demo, settling, offline, syncing, writer, identity, brokerUrl } =
    useDesk();
  const { view, setView, zoomAt, panBy, fitTo, stageRef, stageHandlers } = useViewport();
  const vw = useViewportWidth();
  const narrow = vw < NARROW_PX;
  const { z, focus } = useFocusOrder();
  const [moved, setMoved] = useState<Record<string, Pos>>({});
  const [me] = useState(() => meFromSearch(window.location.search));
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [coordsOpen, setCoordsOpen] = useState(true);
  const [notify, setNotify] = useNotifySettings();
  const steering = useSteering(state, writer, identity);
  // volleyd's control channel for the Claude account ops; demo mode has no daemon to answer them.
  const control = demo ? null : (steering.transport?.control ?? null);
  // volleyd's profile registry, as Settings › Claude accounts last fetched it (nothing is asked at load).
  const [registry, setRegistry] = useState<RegistryAccount[]>([]);
  const accounts = accountList(state.claudeAccounts, registry);
  const choices = accountChoices(accounts);
  /** The window whose steering panel is open (a wave id or an agent id). */
  const [steerOpen, setSteerOpen] = useState<string | null>(null);
  const toggleSteer = (id: string) => setSteerOpen((s) => (s === id ? null : id));
  const now = useNow(ATTN_TICK_MS);
  const gateSince = useGateSince(state, settling);
  const ctxOpts = { now, me, identity, gateSince, offline, syncing };
  const ctx = ctxFrom(state, ctxOpts);
  const [settings, setSettings] = useState<string | null>(null);
  // config_set goes to volleyd's mailbox in its own namespace and is answered on ours there.
  const daemonNs = supervisorNamespace(state, DAEMON_AGENT_ID);
  const configTransport = useMemo(
    () =>
      writer && identity && !demo
        ? createConfigTransport(writer, { identity, namespace: daemonNs })
        : null,
    [writer, identity, demo, daemonNs],
  );
  // The settings modal closes for good when its wave goes away; it must not reopen if it returns.
  const settingsWaveGone = settings !== null && !state.waves[settings];
  useEffect(() => {
    if (settingsWaveGone) setSettings(null);
  }, [settingsWaveGone]);

  // ------------------------------------------------------------ look (D7)
  const [saved, setLook] = useLook();
  const webgl = useWebGL();
  // What this browser can render; the saved look keeps the owner's picks for one that has WebGL.
  const look = degradeLook(saved, webgl);
  /** The Settings window's section while it is open; setup once after an admin token sign-in. */
  const [deskSettings, setDeskSettings] = useState<SectionKey | null>(() =>
    takeFirstRun() ? "setup" : null,
  );
  /** volleyd's admin channel (account and setup ops); the Desk's own account must be an admin. */
  const authOps = useMemo(
    () => (writer && identity && !demo ? createAuthOps(writer, { identity }) : null),
    [writer, identity, demo],
  );
  /** Settings › Setup & Security › Preview: the sign-in screen, until closed. */
  const [preview, setPreview] = useState(false);
  /** Settings › Setup & Security › Open setup…: the wizard's own modal (`repair` for Run setup again). */
  const [setupWizard, setSetupWizard] = useState<{ repair: boolean } | null>(null);
  /** Closing the wizard goes back to where it was opened: Settings › Setup & Security. */
  const closeSetupWizard = () => {
    setSetupWizard(null);
    setDeskSettings("setup");
  };

  const allGroups = agentsByWave(state);
  // Agents that finished longer ago than the grace leave the canvas unless "show finished" is on.
  const finished = finishedAgents(state, now, look.finishedGraceMin * 60_000);
  const finishedCount = Object.values(allGroups).reduce(
    (n, l) => n + l.filter((a) => finished.has(a.id)).length,
    0,
  );
  const finishedHidden = look.showFinished ? 0 : finishedCount;
  const groups =
    finishedHidden === 0
      ? allGroups
      : Object.fromEntries(
          Object.entries(allGroups).map(([id, l]) => [id, l.filter((a) => !finished.has(a.id))]),
        );
  const firstStart = useRef<Record<string, number>>({});
  const startedAt = (id: string): number | null => {
    const t = waveStartedAt(allGroups[id] ?? []);
    const prev = firstStart.current[id];
    if (t !== null && (prev === undefined || t < prev)) firstStart.current[id] = t;
    return firstStart.current[id] ?? null;
  };
  const waveIds = [
    ...Object.keys(state.waves),
    ...((groups[UNASSIGNED]?.length ?? 0) > 0 ? [UNASSIGNED] : []),
  ];
  /** A window's rendered width: the prototype width, clamped on a phone. */
  const clampW = (w: number) => clampWindowWidth(w, vw);
  // Stopped / complete waves fold off the canvas, agents and all, unless "show finished" is
  // on; a folded wave takes no slot in the layout, so it leaves no gap.
  const ended = endedWaves(state);
  const layout = placeholderLayout(
    waveIds.filter((id) => look.showFinished || !ended.has(id)),
    groups,
    clampW,
  );
  // A window the owner or an arrange never placed takes its default slot, pushed down past
  // every window already on the canvas: one that arrives later (a second reviewer while
  // auto-arrange is off) must not land under one placed before it. Placed windows first,
  // then the rest in layout order; resolved once per render.
  let slots: Record<string, Pos> | null = null;
  const slotOf = (id: string): Pos => {
    if (slots === null) {
      const out: Record<string, Pos> = {};
      const shown = [
        ...visible.flatMap((w) => [
          { id: w, w: WAVE_W, h: WAVE_H },
          ...(groups[w] ?? []).map((a) => ({ id: a.id, w: AGENT_W, h: AGENT_H })),
        ]),
        ...(coordsShown ? [{ id: COORDS_ID, w: COORDS_W, h: coordsH(coordsRows) }] : []),
      ];
      const taken: Rect[] = [];
      for (const b of [...shown.filter((x) => moved[x.id]), ...shown.filter((x) => !moved[x.id])]) {
        const { w, h } = sizeOf(b.id, b.w, b.h);
        const at = moved[b.id] ?? layout[b.id] ?? { x: 0, y: 0 };
        let y = at.y;
        if (!moved[b.id]) {
          const hit = () =>
            taken.find((r) => at.x < r.x + r.w && r.x < at.x + w && y < r.y + r.h && r.y < y + h);
          for (let r = hit(); r; r = hit()) y = r.y + r.h + GAP;
        }
        out[b.id] = { x: at.x, y };
        taken.push({ x: at.x, y, w, h });
      }
      slots = out;
    }
    return slots[id] ?? layout[id] ?? { x: 0, y: 0 };
  };
  const pos = (id: string): Pos => moved[id] ?? slotOf(id);
  const move = (id: string) => (dx: number, dy: number) =>
    setMoved((m) => {
      const p = m[id] ?? pos(id);
      return { ...m, [id]: { x: p.x + dx, y: p.y + dy } };
    });

  const sizes = useRef<Record<string, { w: number; h: number }>>({});
  // Until a window is measured it is its (clamped) default size.
  const sizeOf = (id: string, w: number, h: number) => ({
    id,
    ...(sizes.current[id] ?? { w: clampW(w), h }),
  });
  const rectOf = (id: string, w: number, h: number): Rect => {
    const { w: sw, h: sh } = sizeOf(id, w, h);
    return { ...pos(id), w: sw, h: sh };
  };
  const clusterOf = (id: string): Rect[] => [
    rectOf(id, WAVE_W, WAVE_H),
    ...(groups[id] ?? []).map((a) => rectOf(a.id, AGENT_W, AGENT_H)),
  ];
  const endedHidden = look.showFinished ? 0 : ended.size;
  const visible = waveIds.filter((id) => !hidden.has(id) && (look.showFinished || !ended.has(id)));
  const waveList = Object.values(state.waves).filter((w) => w.state !== null);
  // The coordinators window's supervisor row; the demo has no volleyd to report as absent.
  const supervisors = demo ? undefined : supervisorList(state);
  // One clock for both, so the pill and the row show the same age.
  const supNow = useNow(supervisors?.length ? SUPERVISOR_TICK_MS : null);
  const coordsRows = waveList.length + (supervisors ? Math.max(1, supervisors.length) : 0);
  // Also shown with no wave while there are finished agents, so the toggle stays reachable.
  const coordsShown = coordsOpen && (waveList.length > 0 || finishedCount > 0);
  const rects: Rect[] = [
    ...visible.flatMap(clusterOf),
    ...(coordsShown ? [rectOf(COORDS_ID, COORDS_W, coordsH(coordsRows))] : []),
  ];
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || rects.length === 0) return;
    fitted.current = true;
    fitTo(rects);
  });

  // ------------------------------------------------------- arrange & fit
  const autoArrange = look.autoArrange;
  const [animating, setAnimating] = useState(false);
  // The window whose title bar is held: only its tethers sway (D10).
  const [dragging, setDragging] = useState<string | null>(null);
  const animEnd = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(animEnd.current), []);
  const arrange = () => {
    // Forget the sizes of windows that have left the store.
    for (const id of Object.keys(sizes.current)) {
      if (id !== COORDS_ID && !state.agents[id] && !waveIds.includes(id)) delete sizes.current[id];
    }
    // The waves, then the unassigned group and the coordinators window as side
    // clusters: arrange closes the waves' first row with them.
    const clusters: Cluster[] = [
      ...visible.map((id) => ({
        main: sizeOf(id, WAVE_W, WAVE_H),
        kids: (groups[id] ?? []).map((a) => sizeOf(a.id, AGENT_W, AGENT_H)),
        ...(id === UNASSIGNED ? { side: true } : {}),
      })),
      ...(coordsShown
        ? [{ main: sizeOf(COORDS_ID, COORDS_W, coordsH(coordsRows)), kids: [], side: true }]
        : []),
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
    onDrag: (on: boolean) => setDragging((d) => (on ? id : d === id ? null : d)),
    // A window not laid out yet (0 × 0) keeps its fallback size.
    onSize: (w: number, h: number) => {
      if (w > 0 && h > 0) sizes.current[id] = { w, h };
    },
    ...(narrow ? { maxWidth: phoneMaxWidth(vw) } : {}),
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
  const tethers: Tether[] = visible
    .filter((id) => !ended.has(id))
    .flatMap((id) =>
      (groups[id] ?? []).map((a) => ({
        id: a.id,
        waveId: id,
        // The rendered width: on a phone the wave window is clamped.
        wave: rectOf(id, WAVE_W, WAVE_H),
        agent: pos(a.id),
        accent: accentOf(id),
        // A new `progress` envelope sends a pulse down the cable (D10).
        beat: progressBeat(a.feed),
      })),
    );
  useDeskKeys({
    stageRef,
    panBy,
    zoomAt: (f) => zoomAt(f),
    arrange,
    closeTop: () => {
      if (preview) setPreview(false);
      else if (setupWizard !== null) closeSetupWizard();
      else if (settings !== null) setSettings(null);
      else if (deskSettings !== null) setDeskSettings(null);
      else if (steerOpen !== null) setSteerOpen(null);
      else return false;
      return true;
    },
  });

  return (
    <div className="app">
      <Background which={look.bg} dim={look.dim} />

      <div
        className="stage"
        ref={stageRef}
        {...stageHandlers}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the canvas pans with the arrow keys while focused
        tabIndex={0}
        // biome-ignore lint/a11y/useSemanticElements: a pannable canvas of windows, not a document <section>
        role="region"
        aria-label="Desk canvas: arrow keys pan, + and − zoom, f arranges and fits"
      >
        <World view={view} animating={animating}>
          <Tethers on={look.tethers} tethers={tethers} dragging={dragging} />
          {coordsShown && (
            <CoordinatorsWindow
              waves={waveList}
              coordinators={coordinators}
              needsYou={notWorking}
              me={me}
              identity={identity}
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
              {...(supervisors ? { supervisors } : {})}
              now={supNow}
              finished={{
                hidden: finishedHidden,
                waves: endedHidden,
                shown: look.showFinished,
                graceMin: look.finishedGraceMin,
                onToggle: () => setLook({ showFinished: !look.showFinished }),
              }}
            />
          )}
          {visible.map((id) => {
            const wave = state.waves[id];
            if (!wave) {
              return (
                <Frame key={id} {...frame(id, NEUTRAL_ACCENT, WAVE_W)} title={id}>
                  <div className="dim">{plural(groups[id]?.length ?? 0, "agent")} with no wave</div>
                </Frame>
              );
            }
            const coordinator = coordinators[id];
            // Only a wave at tier you gets a banner: an ended wave's coordinator is gone
            // because the work is done, not because the wave needs claiming.
            const needsYou = waveAttn[id]?.tier === "you";
            const chat = waveChatTarget(wave.state?.owner, coordinator, identity);
            return (
              <WaveWindow
                key={id}
                wave={wave}
                me={me}
                identity={identity}
                coordinatorState={coordinator?.state}
                startedAt={startedAt(id)}
                frame={place(id, frameAttn(waveAttn[id] ?? { tier: "none" }))}
                onChat={toggleSteer}
                steerOpen={steerOpen === id}
                banner={
                  needsYou &&
                  coordinator && (
                    <NeedsYou
                      wave={id}
                      coordinator={coordinator}
                      openDecisions={openDecisions(wave).length}
                      now={now}
                      claim={<ClaimButton wave={id} transport={steering.transport} />}
                    />
                  )
                }
                onSettings={setSettings}
              >
                {steerOpen === id &&
                  steering.panel({
                    target: chat.agentId
                      ? {
                          agentId: chat.agentId,
                          namespace: state.agents[chat.agentId]?.namespace ?? "default",
                          coordinator: true,
                          wave: id,
                        }
                      : null,
                    readOnlyReason: "reason" in chat ? chat.reason : undefined,
                    label: id,
                    coordinator: true,
                    onClose: () => setSteerOpen(null),
                  })}
              </WaveWindow>
            );
          })}
          {visible.flatMap((id) =>
            (groups[id] ?? []).map((a) => {
              const blocked = interruptBlocker(state, a);
              return (
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
                  noSignal={noSignalFor(a, state.waves[a.wave], ctx)}
                  syncing={syncing && !ended.has(a.wave)}
                  stageChip={a.task ? stageChip(state, a.wave, a.task) : null}
                  usage={state.usage?.[a.id] ?? null}
                  accounts={choices}
                  {...(control
                    ? {
                        onMoveAccount: (acct: string) =>
                          control(
                            "agent_move_account",
                            { agent: a.id, acct },
                            `volley claude move ${a.id} ${acct}`,
                            MOVE_ACCOUNT_TIMEOUT_MS,
                          ),
                      }
                    : {})}
                  onChat={toggleSteer}
                  steerOpen={steerOpen === a.id}
                  steer={
                    steerOpen === a.id &&
                    steering.panel({
                      target: {
                        agentId: a.id,
                        namespace: a.namespace ?? "default",
                        coordinator: false,
                        ...(a.wave !== UNASSIGNED ? { wave: a.wave } : {}),
                        ...(a.task ? { task: a.task } : {}),
                        ...(a.role ? { role: a.role } : {}),
                        ...(blocked !== undefined ? { noInterrupt: blocked } : {}),
                      },
                      label: a.task && a.role ? `${a.task} · ${ROLE_LABEL[a.role]}` : a.id,
                      coordinator: false,
                      // `volleyd steer` resolves the same slot, so a stale agent gets no command.
                      copy:
                        a.task && a.wave !== UNASSIGNED && blocked === undefined
                          ? { wave: a.wave, task: a.task, ...(a.role ? { role: a.role } : {}) }
                          : null,
                      onClose: () => setSteerOpen(null),
                    })
                  }
                />
              );
            }),
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
        compact={narrow}
        now={supNow}
        syncing={syncing}
      />

      <DeskDock
        coordsOpen={coordsOpen}
        onToggleCoords={() => setCoordsOpen((o) => !o)}
        needsYou={targets.length}
        tethers={look.tethers}
        onToggleTethers={() => setLook({ tethers: !look.tethers })}
        onArrange={arrange}
        onZoom={(f) => zoomAt(f)}
        settingsOpen={deskSettings !== null}
        onToggleSettings={() => setDeskSettings((s) => (s === null ? "general" : null))}
      />

      {deskSettings !== null && (
        // Supervisor rows are read-only until the Desk has signed in (and in demo mode).
        <SettingsWindow
          initial={deskSettings}
          look={look}
          setLook={setLook}
          notify={notify}
          setNotify={setNotify}
          webgl={webgl}
          identity={identity}
          demo={demo}
          config={state.config}
          transport={configTransport}
          claude={{
            accounts: state.claudeAccounts ?? {},
            signins: state.signins ?? {},
            waves: state.waves,
            control,
            onRegistry: setRegistry,
          }}
          onboarding={{
            ops: authOps,
            brokerUrl,
            deskUrl: deskUrl(window.location),
            onPreviewSignIn: () => {
              setDeskSettings(null);
              setPreview(true);
            },
            liveAgents: liveAgentCount(state),
            onOpenSetup: (repair) => {
              setDeskSettings(null);
              setSetupWizard({ repair });
            },
          }}
          onArrange={arrange}
          onClose={() => setDeskSettings(null)}
        />
      )}

      {setupWizard !== null && authOps !== null && (
        <SetupWizard
          ops={authOps}
          deskUrl={deskUrl(window.location)}
          repair={setupWizard.repair}
          onClose={closeSetupWizard}
        />
      )}

      {preview && (
        <SignInPreview
          brokerUrl={brokerUrl ?? "demo"}
          onClose={() => {
            setPreview(false);
            setDeskSettings("setup");
          }}
        />
      )}

      {settings !== null && state.waves[settings] && (
        <SettingsModal
          wave={state.waves[settings]}
          accounts={accounts}
          control={control}
          onClose={() => setSettings(null)}
          onOpenGlobal={() => {
            setSettings(null);
            setDeskSettings("supervisor");
          }}
        />
      )}
    </div>
  );
}
