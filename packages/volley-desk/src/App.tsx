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
 * Hardening (D8): the phone layout (`useScreenSize`), the look degraded
 * without WebGL (`degradeLook`), and the keyboard (`a11y/keys.ts`) on a
 * focusable, labelled stage. Desk round 2 (S6): stopped / complete waves fold
 * off the canvas with their agents under "Show finished" (and get no tethers
 * when shown); the reconnect / resume grace (`syncing`) holds every liveness
 * judgement; a task's parallel reviewers carry the `review (spec + quality)` chip.
 * Pinning (C12, `layout/pins.ts`): each window's title bar cycles it through
 * pinned in place (arrange skips it) and anchored to the screen (rendered in the
 * `.hud` layer above the canvas, untouched by pan, zoom, fit and arrange, which
 * leave room for it; collapsed to its title bar at phone width), saved per
 * window key and device class; Settings, General, Reset layout clears them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  staleProgressFor,
  waveAttention,
} from "./attention";
import { SignInPreview } from "./auth/SignInGate";
import { type Attention, Frame, useFocusOrder } from "./canvas/Frame";
import { World } from "./canvas/World";
import {
  NARROW_PX,
  type Rect,
  clampWindowWidth,
  fitToArea,
  phoneMaxWidth,
  useScreenSize,
  useViewport,
} from "./canvas/useViewport";
import {
  CGAP,
  type Cluster,
  GAP,
  fitArea as arrangeArea,
  arrange as arrangeLayout,
} from "./layout/arrange";
import {
  type Pin,
  anchorAt,
  avoidAnchored,
  hudBounds,
  nextPinMode,
  pinModeOf,
  screenPos,
  windowKeys,
} from "./layout/pins";
import { ARRANGE_ANIM_MS, useAutoArrange } from "./layout/useAutoArrange";
import { usePins } from "./layout/usePins";
import { plural } from "./lib/plural";
import { Background, degradeLook, useWebGL } from "./look/Background";
import { DeskDock } from "./look/DeskDock";
import { type Tether, Tethers } from "./look/Tethers";
import { progressBeat } from "./look/tetherPulses";
import { useLook } from "./look/useLook";
import { type AttentionItem, useNotifyOnAttention } from "./notify/use-notify-on-attention";
import { useNotifySettings } from "./notify/use-notify-settings";
import { MOVE_ACCOUNT_TIMEOUT_MS } from "./settings/ClaudeAccounts";
import { agentsOnMachines, sshHost } from "./settings/Machines";
import { PeerSignin, peerAccount } from "./settings/PeerSigninSheet";
import { SettingsModal } from "./settings/SettingsModal";
import { SettingsWindow } from "./settings/SettingsWindow";
import { SetupWizard } from "./settings/SetupWizard";
import { DAEMON_AGENT_ID, createConfigTransport } from "./settings/configTransport";
import type { SectionKey } from "./settings/sections";
import { emitSound } from "./sounds/emit";
import { useNotifyMirror, useSoundSettings } from "./sounds/settings";
import { useFlipSound, useSoundManager } from "./sounds/useSoundManager";
import { ClaimButton } from "./steer/SteerPanel";
import { useSteering, waveChatTarget } from "./steer/useSteering";
import { type RegistryAccount, accountChoices, accountList, resolveFields } from "./store/claude";
import { useDesk } from "./store/context";
import { createAuthOps, deskUrl, readSessionRole, takeFirstRun } from "./store/control";
import { createPeerOps, keepAdminSeen } from "./store/peerOps";
import {
  UNASSIGNED,
  agentsByWave,
  endedWaves,
  finishedAgents,
  isLiveAgent,
  isSession,
  isSupervisorId,
  localAgentCount,
  stageChip,
  supervisorHealth,
  supervisorList,
  supervisorNamespace,
  unclassifiedAgents,
} from "./store/reducer";
import type { AgentView, DeskState } from "./store/types";
import { TopBar } from "./topbar/TopBar";
import { AGENT_WIDTH, AgentWindow, ROLE_LABEL } from "./windows/agent/AgentWindow";
import { machineFor } from "./windows/agent/machine";
import { TerminalPopout } from "./windows/agent/TerminalPopout";
import { headlineOf, purposeOf } from "./windows/agent/purpose";
import { useTerminalPopouts } from "./windows/agent/useTerminalPopouts";
import {
  COORDS_ID,
  COORDS_W,
  CoordinatorsWindow,
  ENDED_LABEL,
} from "./windows/coordinators/CoordinatorsWindow";
import { AttentionLine, MachineDown, NeedsYou } from "./windows/wave/NeedsYou";
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

/** The group of interactive sessions (`isSession`): its own card, apart from `unassigned`. */
export const SESSIONS = "_sessions";
/** The groups that are not waves: a card listing their agents, a side cluster. */
const isLooseGroup = (id: string) => id === UNASSIGNED || id === SESSIONS;

const accentOf = (wave: string) => (isLooseGroup(wave) ? NEUTRAL_ACCENT : accentFor(wave));

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

/** localStorage key for the ended waves dismissed from this Desk (wave ids). */
export const DISMISSED_WAVES_KEY = "volley-desk:dismissed-waves";

function readDismissed(): ReadonlySet<string> {
  try {
    const v = JSON.parse(localStorage.getItem(DISMISSED_WAVES_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/** Ended waves dismissed from this Desk: Desk-side only, kept in this browser. */
function useDismissedWaves() {
  const [dismissed, set] = useState<ReadonlySet<string>>(readDismissed);
  const update = (next: ReadonlySet<string>) => {
    set(next);
    try {
      localStorage.setItem(DISMISSED_WAVES_KEY, JSON.stringify([...next]));
    } catch {
      // A blocked localStorage only forgets the dismissal on reload.
    }
  };
  return [dismissed, update] as const;
}

export default function App() {
  const { state, connection, demo, settling, offline, syncing, writer, identity, brokerUrl } =
    useDesk();
  const { view, setView, zoomAt, panBy, fitTo: fitView, stageRef, stageHandlers } = useViewport();
  const screenSize = useScreenSize();
  const vw = screenSize.width;
  const narrow = vw < NARROW_PX;
  const {
    pins,
    setPin,
    save: savePinsNow,
    reset: resetPins,
  } = usePins(narrow ? "phone" : "desktop");
  /** The screen-anchored layer, above the canvas (C12). */
  const [hud, setHud] = useState<HTMLDivElement | null>(null);
  /** Anchored windows expanded at phone width (they start collapsed to their title bar). */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const { z, focus } = useFocusOrder();
  const [moved, setMoved] = useState<Record<string, Pos>>({});
  const [me] = useState(() => meFromSearch(window.location.search));
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  /** Ended waves put back on the canvas one by one (the coordinators window's Show). */
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set());
  const [dismissed, setDismissed] = useDismissedWaves();
  /** An ended wave just shown: the viewport fits to it once it has a place on the canvas. */
  const fitPending = useRef<string | null>(null);
  const [coordsOpen, setCoordsOpen] = useState(true);
  const [notify, setNotify] = useNotifySettings();
  // Sound themes: the manager plays what the store and the Desk's controls do.
  const [sound, setSound] = useSoundSettings();
  const sounds = useSoundManager({ state, settling, connection, settings: sound });
  useNotifyMirror(sound, setSound, notify.sound, (on) =>
    setNotify((prev) => ({ ...prev, sound: on })),
  );
  const steering = useSteering(state, writer, identity);
  // volleyd's control channel for the Claude account ops; demo mode has no daemon to answer them.
  const control = demo ? null : (steering.transport?.control ?? null);
  // volleyd's profile registry, as Settings › Claude accounts last fetched it (nothing is asked at load).
  const [registry, setRegistry] = useState<RegistryAccount[]>([]);
  const accounts = accountList(state.claudeAccounts, registry);
  const choices = accountChoices(accounts);
  /** The window whose steering panel is open (a wave id or an agent id). */
  const [steerOpen, setSteerOpen] = useState<string | null>(null);
  // Terminal popouts (the Terminal tab's ⤢): bottom → top; Escape closes the topmost first.
  const popouts = useTerminalPopouts();
  // A popout's agent left the store (pruned, or its retained topics cleared): close it.
  const goneTerm = popouts.open.filter((id) => !state.agents[id]).join(" ");
  const closePopout = popouts.close;
  useEffect(() => {
    for (const id of goneTerm.split(" ").filter(Boolean)) closePopout(id);
  }, [goneTerm, closePopout]);
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
  useFlipSound(saved.tethers, "tethers_on", "tethers_off", emitSound);
  /** The Settings window's section while it is open; setup once after an admin token sign-in. */
  const [deskSettings, setDeskSettings] = useState<SectionKey | null>(() =>
    takeFirstRun() ? "setup" : null,
  );
  /** The machine an agent window's machine chip asked Settings › Machines to show. */
  const [focusMachine, setFocusMachine] = useState<string | null>(null);
  const openMachine = useCallback((name: string) => {
    setFocusMachine(name);
    setDeskSettings("machines");
  }, []);
  useEffect(() => {
    if (deskSettings === null) setFocusMachine(null);
  }, [deskSettings]);
  /** volleyd's admin channel (account and setup ops); the Desk's own account must be an admin. */
  const authOps = useMemo(
    () => (writer && identity && !demo ? createAuthOps(writer, { identity }) : null),
    [writer, identity, demo],
  );
  // Settings › Machines: the pairing ops ride the same admin channel (and its reply key).
  const peerOps = useMemo(
    () => (authOps ? createPeerOps(authOps, { role: readSessionRole(authOps.identity) }) : null),
    [authOps],
  );
  // Ask whether this Desk is an admin as soon as it can write, so Machines rarely waits on it;
  // an admin Desk then checks in with volleyd hourly, so Broker accounts never calls it stale.
  useEffect(() => {
    if (peerOps === null || authOps === null) return;
    return keepAdminSeen(peerOps, authOps);
  }, [peerOps, authOps]);
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
  // Interactive sessions leave the unassigned agents for a Sessions group of their own.
  {
    const loose = allGroups[UNASSIGNED] ?? [];
    allGroups[SESSIONS] = loose.filter(isSession);
    allGroups[UNASSIGNED] = loose.filter((a) => !isSession(a));
  }
  // Agents that finished longer ago than the grace leave the canvas unless "show finished" is on,
  // and so do old records with no status that nothing live has been heard from.
  const graceMs = look.finishedGraceMin * 60_000;
  const unclassified = unclassifiedAgents(state, now, graceMs);
  const finished = finishedAgents(state, now, graceMs);
  for (const id of unclassified.stale) finished.add(id);
  const finishedCount = Object.values(allGroups).reduce(
    (n, l) => n + l.filter((a) => finished.has(a.id)).length,
    0,
  );
  const finishedHidden = look.showFinished ? 0 : finishedCount;
  // While the Desk (re)syncs, an agent with no status (its registry entry replayed ahead of
  // it, or a reconnect's resync) may be finished: it is not laid out until its status says
  // which (C11). One already on the canvas keeps its place. Once synced, an agent that still
  // has none is shown, with its "no signal" mark.
  const onCanvas = useRef<ReadonlySet<string>>(new Set());
  const classifying = settling || syncing;
  const offCanvas = (a: AgentView) =>
    (classifying && unclassified.all.has(a.id) && !onCanvas.current.has(a.id)) ||
    (finishedHidden > 0 && finished.has(a.id));
  const groups =
    finishedHidden === 0 && (!classifying || unclassified.all.size === 0)
      ? allGroups
      : Object.fromEntries(
          Object.entries(allGroups).map(([id, l]) => [id, l.filter((a) => !offCanvas(a))]),
        );
  onCanvas.current = new Set(Object.values(groups).flatMap((l) => l.map((a) => a.id)));
  const firstStart = useRef<Record<string, number>>({});
  const startedAt = (id: string): number | null => {
    const t = waveStartedAt(allGroups[id] ?? []);
    const prev = firstStart.current[id];
    if (t !== null && (prev === undefined || t < prev)) firstStart.current[id] = t;
    return firstStart.current[id] ?? null;
  };
  // A dismissed wave leaves the Desk while it stays ended. A dismissal ends once its wave is
  // seen running: a reused id that runs (and ends) again is back. An id that is only missing
  // is kept, since on a slow link a wave's retained state can arrive after the replay settles.
  const ended = endedWaves(state);
  const gone = (id: string) => ended.has(id) && dismissed.has(id);
  const rerun = [...dismissed].filter((id) => state.waves[id] !== undefined && !ended.has(id));
  useEffect(() => {
    if (rerun.length > 0) setDismissed(new Set([...dismissed].filter((id) => !rerun.includes(id))));
  });
  /** An ended wave is on the canvas under "Show finished" or once shown on its own. */
  const endedShown = (id: string) => look.showFinished || revealed.has(id);
  const waveIds = [
    ...Object.keys(state.waves).filter((id) => !gone(id)),
    ...[UNASSIGNED, SESSIONS].filter((id) => (groups[id]?.length ?? 0) > 0),
  ];
  /** A window's rendered width: the prototype width, clamped on a phone. */
  const clampW = (w: number) => clampWindowWidth(w, vw);
  // Stopped / complete waves fold off the canvas, agents and all, unless "show finished" is
  // on; a folded wave takes no slot in the layout, so it leaves no gap.
  const layout = placeholderLayout(
    waveIds.filter((id) => !ended.has(id) || endedShown(id)),
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
      const shown = shownIds().filter((id) => !anchored(id));
      const taken: Rect[] = [];
      const isPlaced = (id: string) => placedAt(id) !== undefined;
      for (const id of [...shown.filter(isPlaced), ...shown.filter((x) => !isPlaced(x))]) {
        const b = { id, ...dims(id) };
        const { w, h } = sizeOf(b.id, b.w, b.h);
        const at = placedAt(b.id) ?? layout[b.id] ?? { x: 0, y: 0 };
        let y = at.y;
        if (!isPlaced(b.id)) {
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
  const pos = (id: string): Pos => placedAt(id) ?? slotOf(id);
  const move = (id: string) => (dx: number, dy: number) => {
    // A pinned window's pin follows the drag through updaters, saved on the drop (`onDrag`).
    const pin = pinOf(id);
    if (pin?.mode === "screen") {
      const { w, h } = sizeOf(id, dims(id).w, dims(id).h);
      setPin(
        keyOf(id),
        (p) => {
          if (p?.mode !== "screen") return p;
          const { left, top } = screenPos(p, { w, h }, screenSize, bounds);
          return anchorAt({ x: left + dx, y: top + dy, w, h }, screenSize, bounds);
        },
        { save: false },
      );
      return;
    }
    if (pin?.mode === "place") {
      setPin(keyOf(id), (p) => (p?.mode === "place" ? { ...p, x: p.x + dx, y: p.y + dy } : p), {
        save: false,
      });
      return;
    }
    setMoved((m) => {
      const p = m[id] ?? pos(id);
      return { ...m, [id]: { x: p.x + dx, y: p.y + dy } };
    });
  };

  // ------------------------------------------------------------ pinning (C12)
  const keys = windowKeys(
    [COORDS_ID],
    waveIds,
    Object.values(state.agents).map((a) => ({
      id: a.id,
      wave: a.wave,
      task: a.task,
      role: a.role,
      holds:
        !!a.task &&
        !!a.role &&
        state.waves[a.wave]?.state?.tasks.find((t) => t.id === a.task)?.agents[a.role] === a.id,
    })),
  );
  const keyOf = (id: string) => keys[id] ?? id;
  const pinOf = (id: string): Pin | undefined => pins[keyOf(id)];
  const anchored = (id: string) => pinOf(id)?.mode === "screen";
  /** A window pinned in place or placed by a drag or an arrange; undefined until then. */
  const placedAt = (id: string): Pos | undefined => {
    const pin = pinOf(id);
    return pin?.mode === "place" ? { x: pin.x, y: pin.y } : moved[id];
  };
  /** A window's default size: the coordinators window, a wave window or an agent window. */
  const dims = (id: string) =>
    id === COORDS_ID
      ? { w: COORDS_W, h: coordsH(coordsRows) }
      : waveIds.includes(id)
        ? { w: WAVE_W, h: WAVE_H }
        : { w: AGENT_W, h: AGENT_H };
  /** Every window shown: the visible waves and their agents, then the coordinators window. */
  const shownIds = () => [
    ...visible.flatMap((w) => [w, ...(groups[w] ?? []).map((a) => a.id)]),
    ...(coordsShown ? [COORDS_ID] : []),
  ];
  const bounds = hudBounds(screenSize, narrow);
  /** An anchored window's rect on screen (its measured size, or its default). */
  const hudRect = (id: string): Rect | undefined => {
    const pin = pinOf(id);
    if (pin?.mode !== "screen") return undefined;
    const { w, h } = sizeOf(id, dims(id).w, dims(id).h);
    const { left, top } = screenPos(pin, { w, h }, screenSize, bounds);
    return { x: left, y: top, w, h };
  };
  const hudRects = () => shownIds().flatMap((id) => hudRect(id) ?? []);
  /** Fit the view to world rects, leaving room for the windows anchored to the screen. */
  const fitTo = (rs: readonly Rect[]) =>
    fitView(rs, avoidAnchored(fitToArea(screenSize), hudRects()));
  /** The pin toggle: unpinned, then pinned in place, then anchored to the screen, then unpinned. */
  const cyclePin = (id: string) => {
    const key = keyOf(id);
    const mode = nextPinMode(pinModeOf(pinOf(id)));
    const { w, h } = sizeOf(id, dims(id).w, dims(id).h);
    if (mode === "place") {
      setPin(key, { mode: "place", ...pos(id) });
    } else if (mode === "screen") {
      // Anchored where it is on screen now, at its full size.
      const p = pos(id);
      setPin(
        key,
        anchorAt({ x: view.x + p.x * view.s, y: view.y + p.y * view.s, w, h }, screenSize, bounds),
      );
    } else {
      // Back on the canvas under where it was on screen.
      const r = hudRect(id);
      if (r)
        setMoved((m) => ({
          ...m,
          [id]: { x: (r.x - view.x) / view.s, y: (r.y - view.y) / view.s },
        }));
      setPin(key, null);
      setExpanded((e) => {
        if (!e.has(id)) return e;
        const next = new Set(e);
        next.delete(id);
        return next;
      });
    }
  };

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
  // A window anchored to the screen is not on the canvas: no fit frames it.
  const clusterOf = (id: string): Rect[] =>
    [id, ...(groups[id] ?? []).map((a) => a.id)]
      .filter((x) => !anchored(x))
      .map((x) => rectOf(x, dims(x).w, dims(x).h));
  const endedHidden = waveIds.filter((id) => ended.has(id) && !endedShown(id)).length;
  // Only what is shown takes part in a fit or an arrange: a folded or hidden wave is not on the canvas.
  const visible = waveIds.filter((id) => !hidden.has(id) && (!ended.has(id) || endedShown(id)));
  const waveList = Object.values(state.waves).filter((w) => w.state !== null && !gone(w.id));
  // The coordinators window's supervisor row; the demo has no volleyd to report as absent.
  const supervisors = demo ? undefined : supervisorList(state);
  // One clock for both, so the pill and the row show the same age.
  const supNow = useNow(supervisors?.length ? SUPERVISOR_TICK_MS : null);
  const coordsRows = waveList.length + (supervisors ? Math.max(1, supervisors.length) : 0);
  // Also shown with no wave while there are finished agents, so the toggle stays reachable.
  const coordsShown = coordsOpen && (waveList.length > 0 || finishedCount > 0);
  // The first fit frames only the unpinned windows.
  const rects: Rect[] = shownIds()
    .filter((id) => pinOf(id) === undefined)
    .map((id) => rectOf(id, dims(id).w, dims(id).h));
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
        ...(isLooseGroup(id) ? { side: true } : {}),
      })),
      ...(coordsShown
        ? [{ main: sizeOf(COORDS_ID, COORDS_W, coordsH(coordsRows)), kids: [], side: true }]
        : []),
    ];
    // Pinned windows are skipped: one pinned in place is kept clear of, and the fit
    // area leaves room for those anchored to the screen.
    const scr = { width: window.innerWidth, height: window.innerHeight };
    const shownNow = shownIds();
    const r = arrangeLayout(clusters, scr, {
      area: avoidAnchored(arrangeArea(scr), hudRects()),
      pinned: Object.fromEntries(
        shownNow
          .filter((id) => pinOf(id)?.mode === "place")
          .map((id) => [id, rectOf(id, dims(id).w, dims(id).h)]),
      ),
      skip: new Set(shownNow.filter(anchored)),
    });
    if (!r) return;
    setAnimating(true);
    setMoved((m) => ({ ...m, ...r.place }));
    // An ended wave just shown: fit to it in its new place rather than to everything.
    const shown = fitPending.current;
    fitPending.current = null;
    const fitRects = shown
      ? [
          { id: shown, w: WAVE_W, h: WAVE_H },
          ...(groups[shown] ?? []).map((a) => ({ id: a.id, w: AGENT_W, h: AGENT_H })),
        ].flatMap((b) => {
          const at = r.place[b.id];
          if (!at) return [];
          const { w, h } = sizeOf(b.id, b.w, b.h);
          return [{ ...at, w, h }];
        })
      : [];
    if (fitRects.length > 0) fitTo(fitRects);
    else setView(r.view);
    clearTimeout(animEnd.current);
    animEnd.current = setTimeout(() => setAnimating(false), ARRANGE_ANIM_MS);
  };
  // A window anchored to the screen leaves the canvas (or comes back): that re-arranges too.
  const layoutKey = [
    coordsShown ? "c" : "",
    ...visible,
    ...visible.flatMap((id) => (groups[id] ?? []).map((a) => a.id)),
    ...shownIds()
      .filter(anchored)
      .map((id) => `@${id}`),
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
  // Settings, General, Reset layout: arrange once the cleared pins have rendered.
  const [resetTick, setResetTick] = useState(0);
  const arrangeNow = useRef(arrange);
  arrangeNow.current = arrange;
  useEffect(() => {
    if (resetTick > 0) arrangeNow.current();
  }, [resetTick]);

  // Without auto-arrange nothing re-lays the canvas: fit to the shown wave once it is rendered.
  useEffect(() => {
    const id = fitPending.current;
    if (id === null || autoArrange || !visible.includes(id)) return;
    fitPending.current = null;
    fitTo(clusterOf(id));
    focus(id);
  });
  const showEnded = (id: string) => {
    if (visible.includes(id)) {
      // Already on the canvas: fit to it now.
      fitTo(clusterOf(id));
      focus(id);
      return;
    }
    fitPending.current = id;
    setRevealed((r) => new Set(r).add(id));
    setHidden((h) => {
      if (!h.has(id)) return h;
      const next = new Set(h);
      next.delete(id);
      return next;
    });
    focus(id);
  };
  const dismiss = (id: string) => {
    setDismissed(new Set(dismissed).add(id));
    setRevealed((r) => {
      if (!r.has(id)) return r;
      const next = new Set(r);
      next.delete(id);
      return next;
    });
  };
  const dismissedCount = [...ended].filter((id) => dismissed.has(id)).length;

  const place = (id: string, attn?: Attention) => ({
    ...placeOnScreen(id),
    pin: { mode: pinModeOf(pinOf(id)), onCycle: () => cyclePin(id) },
    z: z(id),
    chrome: look.chrome,
    attnStyle: look.attn,
    onMove: move(id),
    onFocus: () => focus(id),
    onDrag: (on: boolean) => {
      setDragging((d) => (on ? id : d === id ? null : d));
      if (!on && pinOf(id)) savePinsNow();
    },
    // A window not laid out yet (0 × 0) keeps its fallback size.
    onSize: (w: number, h: number) => {
      if (w > 0 && h > 0) sizes.current[id] = { w, h };
    },
    ...(narrow ? { maxWidth: phoneMaxWidth(vw) } : {}),
    ...(attn ? { attn } : {}),
  });
  /** On the canvas at its world position, or anchored: in the `.hud` layer, unscaled. */
  function placeOnScreen(id: string) {
    const r = hudRect(id);
    if (!r) return { pos: pos(id), scale: view.s };
    const open = !narrow || expanded.has(id);
    return {
      pos: { x: r.x, y: r.y },
      scale: 1,
      layer: hud,
      ...(narrow
        ? {
            collapsed: !open,
            onCollapse: (c: boolean) =>
              setExpanded((e) => {
                const next = new Set(e);
                if (c) next.delete(id);
                else next.add(id);
                return next;
              }),
          }
        : {}),
    };
  }
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
    if (anchored(t.id)) {
      // Already on screen: open it if it is collapsed.
      if (narrow) setExpanded((e) => new Set(e).add(t.id));
    } else {
      fitTo(t.kind === "wave" ? clusterOf(t.id) : [rectOf(t.id, AGENT_W, AGENT_H)]);
    }
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
        title: `${purposeOf(a, state.waves[a.wave]).label} needs you`,
        body: agentAttn[a.id]?.reason ?? "",
      })),
  ];
  useNotifyOnAttention(notify, items, { quiet: settling });

  // Tethers: wave window → each of its agents, for visible waves.
  // None to or from a window anchored to the screen: it is not on the canvas.
  const tethers: Tether[] = visible
    .filter((id) => !ended.has(id) && !anchored(id))
    .flatMap((id) =>
      (groups[id] ?? [])
        .filter((a) => !anchored(a.id))
        .map((a) => ({
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
    // Top first: the modal sheets and the Settings windows sit above the popout layer.
    closeTop: () => {
      if (preview) setPreview(false);
      else if (setupWizard !== null) closeSetupWizard();
      else if (settings !== null) setSettings(null);
      else if (deskSettings !== null) setDeskSettings(null);
      else if (popouts.closeTop()) return true;
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
              shownEnded={new Set([...ended].filter(endedShown))}
              onShowEnded={showEnded}
              onDismiss={dismiss}
              dismissed={{
                count: dismissedCount,
                onRestore: () =>
                  setDismissed(new Set([...dismissed].filter((id) => !ended.has(id)))),
              }}
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
              const members = groups[id] ?? [];
              const sessions = id === SESSIONS;
              return (
                <Frame
                  key={id}
                  {...frame(id, NEUTRAL_ACCENT, WAVE_W)}
                  title={sessions ? "Sessions" : id}
                >
                  <div className="dim">
                    {sessions
                      ? plural(members.length, "interactive session")
                      : `${plural(members.length, "agent")} with no wave`}
                  </div>
                  <ul className="loose-list">
                    {members.map((a) => (
                      <li key={a.id} className="ell" title={a.id}>
                        {purposeOf(a, undefined).label}
                      </li>
                    ))}
                  </ul>
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
                  <>
                    {needsYou && coordinator && (
                      <NeedsYou
                        wave={id}
                        coordinator={coordinator}
                        openDecisions={openDecisions(wave).length}
                        now={now}
                        claim={<ClaimButton wave={id} transport={steering.transport} />}
                      />
                    )}
                    {openDecisions(wave)
                      .filter((d) => d.kind === "machine_down")
                      .map((d) => (
                        <MachineDown
                          key={d.decision_id}
                          decision={d}
                          onAnswer={
                            control
                              ? (answer) =>
                                  control(
                                    "resolve",
                                    resolveFields(d, answer),
                                    `volleyd resolve ${d.decision_id}`,
                                  )
                              : undefined
                          }
                        />
                      ))}
                  </>
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
                  stale={staleProgressFor(a, state.waves[a.wave], ctx)?.label ?? null}
                  syncing={syncing && !ended.has(a.wave)}
                  stageChip={a.task ? stageChip(state, a.wave, a.task) : null}
                  usage={state.usage?.[a.id] ?? null}
                  accounts={choices}
                  machine={machineFor(a, state.waves[a.wave], state)}
                  onOpenMachine={openMachine}
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
                  onPopout={popouts.openFor}
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
                      // The window's own name, as its title bar and chat button say it.
                      label: [headlineOf(a, state.waves[a.wave]), a.role && ROLE_LABEL[a.role]]
                        .filter(Boolean)
                        .join(" · "),
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

      <div className="hud" ref={setHud} />

      {popouts.open.length > 0 &&
        createPortal(
          <div className="popout-layer">
            {/* A stable DOM order (by id) so raising one never re-parents it; the stack is `z`. */}
            {[...popouts.open].sort().map((id) => {
              const a = state.agents[id];
              if (!a) return null;
              return (
                <TerminalPopout
                  key={id}
                  agent={a}
                  wave={state.waves[a.wave]}
                  noSignal={noSignalFor(a, state.waves[a.wave], ctx)}
                  z={popouts.open.indexOf(id) + 1}
                  cascade={popouts.open.indexOf(id)}
                  onClose={() => popouts.close(id)}
                  onRaise={() => popouts.raise(id)}
                  fontPx={popouts.fontPx}
                  onFont={(d) => popouts.setFontPx(popouts.fontPx + d)}
                />
              );
            })}
          </div>,
          document.body,
        )}

      {/* A coalesced burst of sounds, read out: "12 agents completed". */}
      <output className="sr-only" aria-live="polite">
        {sounds.announcement}
      </output>

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
          sound={{
            sound,
            setSound,
            loadTheme: sounds.loadTheme,
            audition: sounds.audition,
            disposeAudition: sounds.disposeAudition,
            canVibrate: sounds.player.canVibrate(),
          }}
          webgl={webgl}
          identity={identity}
          demo={demo}
          config={state.config}
          transport={configTransport}
          leases={state.leases}
          claude={{
            accounts: state.claudeAccounts ?? {},
            signins: state.signins ?? {},
            waves: state.waves,
            control,
            onRegistry: setRegistry,
          }}
          machines={{
            machines: state.machines ?? {},
            hosts: Object.keys(state.config?.hosts ?? {}),
            hubUp: !supervisorHealth(state.supervisors[DAEMON_AGENT_ID]).down,
            hubAgents: localAgentCount(state),
            ops: peerOps,
            host: sshHost(brokerUrl),
            readiness: state.readiness ?? {},
            localName: state.config?.fleet?.local_name,
            focus: focusMachine ?? undefined,
            configTransport,
            accounts: state.claudeAccounts ?? {},
            agentsOn: agentsOnMachines(
              Object.values(state.waves).flatMap((w) => (w.state ? [w.state] : [])),
              (id) => isLiveAgent(state, id),
            ),
            // A paired machine's Claude sign-in (volleyd's `primary@<name>`), on its card and in
            // Add a machine's step 4.
            ...(control
              ? {
                  signIn: (name: string) => (
                    <PeerSignin
                      machine={name}
                      signin={state.signins?.[peerAccount(name)]}
                      signedIn={state.machines?.[name]?.auth?.claude === "signed_in"}
                      control={control}
                      ops={peerOps}
                    />
                  ),
                }
              : {}),
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
          onResetLayout={() => {
            resetPins();
            setExpanded(new Set());
            setResetTick((t) => t + 1);
          }}
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
