/**
 * Notify settings, ported from volley-dash: browser notifications on/off,
 * sound on/off and the dashboard's trigger list, persisted to localStorage
 * under volley-dash's key so preferences carry over to the Desk. The Desk
 * fires on attention tier `you` and keeps `on` only so the shared entry
 * round-trips intact. A corrupt entry falls back to the defaults.
 */
import { useCallback, useRef, useState } from "react";

export interface NotifyOptions {
  enabled: boolean;
  sound: boolean;
  on: string[];
}

/** The next settings, or how to get them from the latest ones (for answers that arrive late). */
export type NotifyUpdate = NotifyOptions | ((prev: NotifyOptions) => NotifyOptions);
export type SetNotify = (next: NotifyUpdate) => void;

export const NOTIFY_STORAGE_KEY = "volley-dash:notify";

const DEFAULTS: NotifyOptions = {
  enabled: false,
  sound: true,
  on: ["blocked", "failed", "reaped"],
};

function readFromStorage(): NotifyOptions {
  const fallback = { ...DEFAULTS, on: [...DEFAULTS.on] };
  if (typeof localStorage === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(NOTIFY_STORAGE_KEY);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw) as Partial<NotifyOptions>;
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULTS.enabled,
      sound: typeof parsed.sound === "boolean" ? parsed.sound : DEFAULTS.sound,
      on: Array.isArray(parsed.on)
        ? parsed.on.filter((v): v is string => typeof v === "string")
        : [...DEFAULTS.on],
    };
  } catch {
    return fallback;
  }
}

export function useNotifySettings(): [NotifyOptions, SetNotify] {
  const [settings, setSettings] = useState<NotifyOptions>(readFromStorage);
  /** The settings as last set, so an updater never sees a stale render's value. */
  const latest = useRef(settings);

  const setAndPersist = useCallback((update: NotifyUpdate): void => {
    const next = typeof update === "function" ? update(latest.current) : update;
    latest.current = next;
    setSettings(next);
    try {
      localStorage.setItem(NOTIFY_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage blocked (private mode, quota): the choice lasts for this page only.
    }
  }, []);

  return [settings, setAndPersist];
}
