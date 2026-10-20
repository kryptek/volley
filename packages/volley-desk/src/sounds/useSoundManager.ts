/**
 * The sound manager: the thin shell around the pure core. Every store change
 * goes through `deriveSoundEvents` (previous state → this one), every
 * `emitSound` from the Desk (clicks, drags, panels, the notify hook) joins
 * it, and both pass `decide` (settings, the tab's visibility, reduced
 * motion, the local time) before the player plays them. A burst folded into
 * one play is announced as "<count> <many>" for the Desk's `aria-live` line.
 *
 * The first `pointerdown` or `keydown` unlocks the audio context (browsers
 * start it suspended until a gesture); a delegated `pointerdown` listener
 * plays `ui_click` for any element marked `data-sound="click"`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "../a11y/motion";
import type { DeskState } from "../store/types";
import { type SoundConnection, deriveSoundEvents } from "./derive";
import { onSound } from "./emit";
import { SOUND_EVENTS, type SoundEventId } from "./events";
import { type Player, createPlayer } from "./player";
import { COALESCE_MS, POLICY0, type Play, type PolicyState, decide, flush } from "./policy";
import type { SoundSettings } from "./settings";

/** The attention buzz on phones. */
export const VIBRATE_PATTERN = [80, 40, 80];
/** Below this width the Desk is on a phone (vibrate even when the tab is visible). */
const PHONE_PX = 700;

export interface SoundManagerInput {
  state: DeskState;
  settling: boolean;
  connection: SoundConnection;
  settings: SoundSettings;
  /** Clips' base URL (`public/sounds`). */
  baseUrl?: string;
  /** A player to use instead of a new one (tests). */
  player?: Player;
}

export interface SoundManager {
  player: Player;
  /** The last coalesced burst, for the `aria-live` status line. */
  announcement: string;
  /** Loads a theme (resolves once its clips are decoded). */
  loadTheme: (theme: string) => Promise<void>;
  audition: (theme: string, id: SoundEventId) => Promise<void>;
  disposeAudition: () => void;
}

const hiddenNow = () => typeof document !== "undefined" && document.visibilityState === "hidden";
const phoneNow = () => typeof window !== "undefined" && window.innerWidth < PHONE_PX;
const localMinutes = (d: Date) => d.getHours() * 60 + d.getMinutes();

export function useSoundManager({
  state,
  settling,
  connection,
  settings,
  baseUrl = "/sounds",
  player: given,
}: SoundManagerInput): SoundManager {
  const player = useMemo(() => given ?? createPlayer({ baseUrl }), [given, baseUrl]);
  const reducedMotion = useReducedMotion();
  const [announcement, setAnnouncement] = useState("");
  const policy = useRef<PolicyState>(POLICY0);
  const live = useRef({ settings, reducedMotion });
  live.current = { settings, reducedMotion };

  const announce = useCallback((plays: readonly Play[]) => {
    const burst = plays.filter((p) => p.count > 1);
    if (burst.length)
      setAnnouncement(burst.map((p) => `${p.count} ${SOUND_EVENTS[p.id].many}`).join(", "));
  }, []);

  const run = useCallback(
    (ids: readonly SoundEventId[]) => {
      if (ids.length === 0) return;
      const now = new Date();
      const { settings: s, reducedMotion: rm } = live.current;
      const hidden = hiddenNow();
      const r = decide(
        ids,
        s,
        { now: now.getTime(), hidden, reducedMotion: rm, localMinutes: localMinutes(now) },
        policy.current,
      );
      policy.current = r.state;
      for (const p of r.play) {
        void player.play(p.id);
        if (p.id === "attention_needed" && s.vibrate && (hidden || phoneNow()))
          player.vibrate(VIBRATE_PATTERN);
      }
      announce([...r.done, ...r.play]);
    },
    [player, announce],
  );

  // The store: what changed since the last state.
  const prev = useRef<DeskState | null>(null);
  const prevConn = useRef<SoundConnection>(connection);
  useEffect(() => {
    const ids = deriveSoundEvents(prev.current, state, {
      now: Date.now(),
      settling,
      connection,
      prevConnection: prevConn.current,
    });
    prev.current = state;
    if (connection !== "connecting") prevConn.current = connection;
    run(ids);
  }, [state, settling, connection, run]);

  // Everything else the Desk emits.
  useEffect(() => onSound((id, count) => run(Array.from({ length: count }, () => id))), [run]);

  // Close coalescing windows and announce what they folded.
  useEffect(() => {
    const t = setInterval(() => {
      const r = flush(policy.current, Date.now());
      policy.current = r.state;
      announce(r.done);
    }, COALESCE_MS);
    return () => clearInterval(t);
  }, [announce]);

  useEffect(() => {
    void player.loadTheme(settings.theme);
  }, [player, settings.theme]);

  useEffect(() => {
    player.setVolume(settings.volume);
  }, [player, settings.volume]);

  // Every gesture asks the context to start (a no-op once running, a retry after a refusal or
  // a suspension); a marked control clicks.
  useEffect(() => {
    const gesture = () => {
      void player.unlock();
    };
    const down = (e: PointerEvent) => {
      gesture();
      const el = e.target instanceof Element ? e.target.closest("[data-sound]") : null;
      if (el?.getAttribute("data-sound") === "click") run(["ui_click"]);
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", gesture, true);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", gesture, true);
    };
  }, [player, run]);

  useEffect(() => () => player.dispose(), [player]);

  return {
    player,
    announcement,
    loadTheme: useCallback((theme: string) => player.loadTheme(theme), [player]),
    audition: useCallback(
      (theme: string, id: SoundEventId) => player.audition(theme, id),
      [player],
    ),
    disposeAudition: useCallback(() => player.disposeAudition(), [player]),
  };
}

/** Emits `on` when `value` turns true and `off` when it turns false (not on mount). */
export function useFlipSound(
  value: boolean,
  on: SoundEventId,
  off: SoundEventId,
  emit: (id: SoundEventId) => void,
): void {
  const was = useRef(value);
  useEffect(() => {
    if (was.current === value) return;
    was.current = value;
    emit(value ? on : off);
  }, [value, on, off, emit]);
}
