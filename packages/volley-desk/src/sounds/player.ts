/**
 * The Desk's sound player: the only file that touches Web Audio, `fetch` for
 * clips or `navigator.vibrate` (a test guards it). A theme loads lazily, the
 * first time it is asked for: its `manifest.json`, then each clip, decoded
 * once into an `AudioBuffer` cache. Switching theme drops the old buffers and
 * cancels its download; an audition loads another theme into a side cache
 * without switching.
 *
 * Silence is never an error: no `AudioContext`, a missing manifest or clip, a
 * failed decode or a context the browser has not let start (before the first
 * gesture, `unlock`) all resolve quietly. A missing clip is logged once, at
 * `console.debug`.
 */
import type { SoundEventId } from "./events";

/** `public/sounds/<theme>/manifest.json`, written by `scripts/sounds/pick.ts`. */
export interface ThemeManifest {
  theme: string;
  label: string;
  version: number;
  generated_at: string;
  clips: Partial<Record<string, { file: string; ms: number; variant: number; fallback?: string }>>;
  /** Events this theme has no clip for (silence). */
  missing?: string[];
}

export interface PlayOptions {
  /** 0–1, on top of the master volume. */
  gain?: number;
  /** Another loaded theme (an audition); the current one by default. */
  theme?: string;
}

export interface Player {
  /** Loads a theme and makes it current; `keep` loads it beside the current one instead. */
  loadTheme(theme: string, opts?: { keep?: boolean }): Promise<void>;
  /** True once a load of the theme has started (and was not dropped), decoded or not. */
  has(theme: string): boolean;
  /** The current theme, once one was asked for. */
  theme(): string | null;
  play(id: SoundEventId, opts?: PlayOptions): Promise<void>;
  /**
   * Plays one event of any theme now: loads it into the side cache (dropping any other
   * side-cached theme, so at most two are decoded at once), unlocks the context.
   */
  audition(theme: string, id: SoundEventId): Promise<void>;
  /** Drops every side-cached theme. */
  disposeAudition(): void;
  setVolume(v: number): void;
  /** Lets the context start (call from a user gesture). */
  unlock(): Promise<void>;
  canVibrate(): boolean;
  vibrate(pattern: number[]): void;
  dispose(): void;
}

type Ctx = AudioContext;

function newContext(): Ctx | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const C = w.AudioContext ?? w.webkitAudioContext;
  if (!C) return null;
  try {
    return new C();
  } catch {
    return null;
  }
}

/** Whether this browser decodes Ogg/Opus (else a clip's `fallback`, when it has one). */
function opusOk(): boolean {
  try {
    return (
      typeof Audio === "undefined" || new Audio().canPlayType('audio/ogg; codecs="opus"') !== ""
    );
  } catch {
    return true;
  }
}

export function createPlayer({ baseUrl }: { baseUrl: string }): Player {
  let ctx: Ctx | null | undefined;
  let master: GainNode | null = null;
  let volume = 1;
  let current: string | null = null;
  const buffers = new Map<string, Map<string, AudioBuffer>>();
  const loading = new Map<string, { done: Promise<void>; abort: AbortController }>();
  const logged = new Set<string>();

  const context = (): Ctx | null => {
    if (ctx === undefined) {
      ctx = newContext();
      if (ctx) {
        master = ctx.createGain();
        master.gain.value = volume;
        master.connect(ctx.destination);
      }
    }
    return ctx;
  };

  const drop = (theme: string) => {
    buffers.delete(theme);
    loading.get(theme)?.abort.abort();
    loading.delete(theme);
  };

  async function fetchTheme(theme: string, c: Ctx, signal: AbortSignal): Promise<void> {
    const cache = new Map<string, AudioBuffer>();
    buffers.set(theme, cache);
    let manifest: ThemeManifest;
    try {
      const res = await fetch(`${baseUrl}/${theme}/manifest.json`, { signal });
      if (!res.ok) return;
      manifest = (await res.json()) as ThemeManifest;
    } catch {
      return;
    }
    const missing = new Set(manifest.missing ?? []);
    const opus = opusOk();
    await Promise.all(
      Object.entries(manifest.clips).map(async ([id, clip]) => {
        if (!clip || missing.has(id)) return;
        const file = !opus && clip.fallback ? clip.fallback : clip.file;
        try {
          const res = await fetch(`${baseUrl}/${theme}/${file}`, { signal });
          if (!res.ok) return;
          const decoded = await c.decodeAudioData(await res.arrayBuffer());
          if (!signal.aborted) cache.set(id, decoded);
        } catch {
          // A clip that does not load is silence.
        }
      }),
    );
  }

  const load = (theme: string, keep: boolean): Promise<void> => {
    if (!keep && current !== theme) {
      for (const t of [...buffers.keys(), ...loading.keys()]) if (t !== theme) drop(t);
      current = theme;
    }
    const c = context();
    if (!c) return Promise.resolve();
    const inflight = loading.get(theme);
    if (inflight) return inflight.done;
    const abort = new AbortController();
    const done = fetchTheme(theme, c, abort.signal);
    loading.set(theme, { done, abort });
    return done;
  };

  const play = async (id: SoundEventId, opts: PlayOptions = {}): Promise<void> => {
    const theme = opts.theme ?? current;
    const c = ctx;
    if (!theme || !c || !master || c.state !== "running") return;
    await loading.get(theme)?.done;
    const buf = buffers.get(theme)?.get(id);
    if (!buf) {
      const key = `${theme}/${id}`;
      if (buffers.has(theme) && !logged.has(key)) {
        logged.add(key);
        console.debug(`volley-desk: no sound for ${key}`);
      }
      return;
    }
    try {
      const voice = c.createGain();
      voice.gain.value = opts.gain ?? 1;
      voice.connect(master);
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(voice);
      src.start();
    } catch {
      // A context torn down mid-play is silence.
    }
  };

  const unlock = async (): Promise<void> => {
    const c = context();
    if (!c || c.state === "running") return;
    try {
      await c.resume();
    } catch {
      // Refused (no gesture yet): try again on the next one.
    }
  };

  return {
    loadTheme: (theme, opts = {}) => load(theme, opts.keep === true),
    has: (theme) => buffers.has(theme) && !loading.get(theme)?.abort.signal.aborted,
    theme: () => current,
    play,
    audition: async (theme, id) => {
      await unlock();
      for (const t of [...buffers.keys(), ...loading.keys()])
        if (t !== current && t !== theme) drop(t);
      await load(theme, theme !== current);
      await play(id, { theme });
    },
    disposeAudition: () => {
      for (const t of [...buffers.keys()]) if (t !== current) drop(t);
    },
    setVolume: (v) => {
      volume = Math.max(0, Math.min(1, v));
      if (master) master.gain.value = volume;
    },
    unlock,
    canVibrate: () => typeof navigator !== "undefined" && typeof navigator.vibrate === "function",
    vibrate: (pattern) => {
      try {
        if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function")
          navigator.vibrate(pattern);
      } catch {
        // Refused (no gesture, iframe policy): no buzz.
      }
    },
    dispose: () => {
      for (const t of [...buffers.keys(), ...loading.keys()]) drop(t);
      void ctx?.close?.().catch(() => {});
      ctx = undefined;
      master = null;
    },
  };
}
