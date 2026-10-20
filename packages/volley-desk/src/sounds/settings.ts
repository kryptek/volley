/**
 * Settings › Sound, persisted per browser in the `volley-desk-sound`
 * localStorage entry and validated key by key like `useLook`: a stored value
 * of the wrong kind falls back to its default and never reaches the UI.
 *
 * The legacy dashboard shares `volley-dash:notify`'s `sound` flag, so every
 * save mirrors `!muted && events.attention_needed` into it (its other keys
 * kept), and a first load with no sound entry seeds `attention_needed` from it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { NOTIFY_STORAGE_KEY } from "../notify/use-notify-settings";
import { SOUND_EVENTS, SOUND_EVENT_IDS, type SoundEventId } from "./events";
import { DEFAULT_THEME, type ThemeId, isThemeId } from "./themes";

export const SOUND_STORAGE_KEY = "volley-desk-sound";

export interface QuietHours {
  on: boolean;
  /** Local time, `HH:MM`. */
  from: string;
  to: string;
  /** Silence attention sounds in quiet hours too (they play by default). */
  attentionToo: boolean;
}

export interface SoundSettings {
  theme: ThemeId;
  /** Master volume, 0–1. */
  volume: number;
  muted: boolean;
  events: Record<SoundEventId, boolean>;
  /** Signal events play only while the Desk tab is hidden. */
  signalsOnlyWhenHidden: boolean;
  quietHours: QuietHours;
  /** `prefers-reduced-motion: reduce` silences every sound. */
  followReducedMotion: boolean;
  /** Vibrate on attention (phones). */
  vibrate: boolean;
}

/** What a change may carry: `events` and `quietHours` merge into the current ones. */
export type SoundChange = Partial<Omit<SoundSettings, "events" | "quietHours">> & {
  events?: Partial<Record<SoundEventId, boolean>>;
  quietHours?: Partial<QuietHours>;
};

const defaultEvents = (): Record<SoundEventId, boolean> =>
  Object.fromEntries(SOUND_EVENT_IDS.map((id) => [id, SOUND_EVENTS[id].defaultOn])) as Record<
    SoundEventId,
    boolean
  >;

export const SOUND0: SoundSettings = {
  theme: DEFAULT_THEME,
  volume: 0.7,
  muted: false,
  events: defaultEvents(),
  signalsOnlyWhenHidden: false,
  quietHours: { on: false, from: "22:00", to: "07:00", attentionToo: false },
  followReducedMotion: true,
  vibrate: true,
};

const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isVolume = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
export const isHHMM = (v: unknown): v is string =>
  typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

/** Minutes since midnight of an `HH:MM`. */
export const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function readJson(key: string): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    return obj(JSON.parse(raw));
  } catch {
    return {};
  }
}

/** Validates a stored entry key by key; `seed` is `attention_needed` for a first load. */
export function validSound(entry: Record<string, unknown>): SoundSettings {
  const ev = obj(entry.events);
  const qh = obj(entry.quietHours);
  const events = defaultEvents();
  for (const id of SOUND_EVENT_IDS) if (isBool(ev[id])) events[id] = ev[id];
  const pick = <T>(v: unknown, ok: (v: unknown) => v is T, d: T): T => (ok(v) ? v : d);
  const q0 = SOUND0.quietHours;
  return {
    theme: pick(entry.theme, isThemeId, SOUND0.theme),
    volume: pick(entry.volume, isVolume, SOUND0.volume),
    muted: pick(entry.muted, isBool, SOUND0.muted),
    events,
    signalsOnlyWhenHidden: pick(entry.signalsOnlyWhenHidden, isBool, SOUND0.signalsOnlyWhenHidden),
    quietHours: {
      on: pick(qh.on, isBool, q0.on),
      from: pick(qh.from, isHHMM, q0.from),
      to: pick(qh.to, isHHMM, q0.to),
      attentionToo: pick(qh.attentionToo, isBool, q0.attentionToo),
    },
    followReducedMotion: pick(entry.followReducedMotion, isBool, SOUND0.followReducedMotion),
    vibrate: pick(entry.vibrate, isBool, SOUND0.vibrate),
  };
}

export function loadSoundSettings(): SoundSettings {
  const entry = readJson(SOUND_STORAGE_KEY);
  if (entry !== null) return validSound(entry);
  // First load: the attention sound follows the shared notify flag.
  const notify = readJson(NOTIFY_STORAGE_KEY);
  const s = validSound({});
  if (notify && isBool(notify.sound)) s.events.attention_needed = notify.sound;
  return s;
}

export function saveSoundSettings(s: SoundSettings): void {
  try {
    localStorage.setItem(SOUND_STORAGE_KEY, JSON.stringify(s));
    const notify = readJson(NOTIFY_STORAGE_KEY) ?? {};
    localStorage.setItem(
      NOTIFY_STORAGE_KEY,
      JSON.stringify({ ...notify, sound: !s.muted && s.events.attention_needed }),
    );
  } catch {
    // Storage blocked (private mode, quota): the choice lasts for this page only.
  }
}

export function mergeSound(s: SoundSettings, change: SoundChange): SoundSettings {
  return {
    ...s,
    ...change,
    events: { ...s.events, ...change.events },
    quietHours: { ...s.quietHours, ...change.quietHours },
  } as SoundSettings;
}

/** `[settings, setSound]`: `setSound` merges a partial change and saves the result. */
export function useSoundSettings(): [SoundSettings, (change: SoundChange) => void] {
  const [settings, setRaw] = useState<SoundSettings>(loadSoundSettings);
  const setSound = useCallback((change: SoundChange) => {
    setRaw((s) => {
      const next = mergeSound(s, change);
      saveSoundSettings(next);
      return next;
    });
  }, []);
  return [settings, setSound];
}

/**
 * Keeps `notify.sound` (the top bar's speaker, the legacy dashboard) and the
 * sound settings in step: a sound change writes `!muted && attention_needed`
 * into it, and a change to it from elsewhere switches `attention_needed`
 * (turning it on also unmutes, or the attention sound would stay silent).
 */
export function useNotifyMirror(
  sound: SoundSettings,
  setSound: (change: SoundChange) => void,
  notifySound: boolean,
  setNotifySound: (on: boolean) => void,
): void {
  const mirrored = !sound.muted && sound.events.attention_needed;
  const last = useRef({ mirrored, notifySound });
  useEffect(() => {
    const was = last.current;
    last.current = { mirrored, notifySound };
    if (mirrored === notifySound) return;
    if (notifySound !== was.notifySound)
      setSound(
        notifySound
          ? { muted: false, events: { attention_needed: true } }
          : { events: { attention_needed: false } },
      );
    else setNotifySound(mirrored);
  }, [mirrored, notifySound, setSound, setNotifySound]);
}
