/**
 * Notify settings — three-toggle popover state, persisted to localStorage so
 * the user's choice survives page reloads. Reads on mount, writes on every
 * change (three toggles don't need debouncing). JSON parse failures fall back
 * to the default off-but-sound-ready preset so a corrupted entry can never
 * keep the popover from rendering.
 *
 * Default trigger set mirrors `volley notify`'s CLI default: the three
 * attention-needed lifecycle states.
 */
import { useCallback, useState } from "react";

export interface NotifyOptions {
  enabled: boolean;
  sound: boolean;
  on: string[];
}

const STORAGE_KEY = "volley-dash:notify";

const DEFAULTS: NotifyOptions = {
  enabled: false,
  sound: true,
  on: ["blocked", "failed", "reaped"],
};

function readFromStorage(): NotifyOptions {
  if (typeof localStorage === "undefined") return { ...DEFAULTS, on: [...DEFAULTS.on] };
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) return { ...DEFAULTS, on: [...DEFAULTS.on] };
  try {
    const parsed = JSON.parse(raw) as Partial<NotifyOptions>;
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULTS.enabled,
      sound: typeof parsed.sound === "boolean" ? parsed.sound : DEFAULTS.sound,
      on: Array.isArray(parsed.on)
        ? parsed.on.filter((v): v is string => typeof v === "string")
        : [...DEFAULTS.on],
    };
  } catch {
    return { ...DEFAULTS, on: [...DEFAULTS.on] };
  }
}

export function useNotifySettings(): [NotifyOptions, (next: NotifyOptions) => void] {
  const [settings, setSettings] = useState<NotifyOptions>(readFromStorage);

  const setAndPersist = useCallback((next: NotifyOptions): void => {
    setSettings(next);
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    }
  }, []);

  return [settings, setAndPersist];
}
