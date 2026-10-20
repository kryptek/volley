/**
 * A fake Web Audio context and a `fetch` keyed by URL, for the sound player's
 * tests: jsdom has neither audio nor a network. `installFakeAudio` puts the
 * context on `window`, `installFetch` replaces `fetch`; both return what they
 * record and `restore` puts the originals back.
 */
import { vi } from "vitest";

export interface FakeSource {
  buffer: unknown;
  connectedTo: unknown;
  started: boolean;
}

export interface FakeAudio {
  contexts: FakeContext[];
  /** Bytes whose decode rejects. */
  undecodable: Set<string>;
  restore: () => void;
}

export class FakeContext {
  state: "suspended" | "running" = "suspended";
  readonly destination = { node: "destination" };
  readonly gains: { gain: { value: number }; connectedTo: unknown }[] = [];
  readonly sources: FakeSource[] = [];
  constructor(private readonly fake: { undecodable: Set<string> }) {}
  resume = vi.fn(async () => {
    this.state = "running";
  });
  close = vi.fn(async () => {});
  createGain() {
    const g = {
      gain: { value: 1 },
      connectedTo: null as unknown,
      connect(to: unknown) {
        g.connectedTo = to;
      },
    };
    this.gains.push(g);
    return g;
  }
  createBufferSource() {
    const s: FakeSource & { connect: (to: unknown) => void; start: () => void } = {
      buffer: null,
      connectedTo: null,
      started: false,
      connect(to) {
        s.connectedTo = to;
      },
      start() {
        s.started = true;
      },
    };
    this.sources.push(s);
    return s;
  }
  decodeAudioData = vi.fn(async (data: ArrayBuffer) => {
    const text = new TextDecoder().decode(data);
    if (this.fake.undecodable.has(text)) throw new Error("decode failed");
    return { decoded: text };
  });
}

export function installFakeAudio(): FakeAudio {
  const w = window as unknown as { AudioContext?: unknown };
  const had = Object.hasOwn(w, "AudioContext");
  const before = w.AudioContext;
  const fake: FakeAudio = {
    contexts: [],
    undecodable: new Set(),
    restore: () => {
      if (had) w.AudioContext = before;
      else Reflect.deleteProperty(w, "AudioContext");
    },
  };
  w.AudioContext = class extends FakeContext {
    constructor() {
      super(fake);
      fake.contexts.push(this);
    }
  };
  return fake;
}

export interface FakeFetch {
  /** Every URL requested, in order. */
  calls: string[];
  restore: () => void;
}

/** `fetch` answering from `routes` (JSON for objects, bytes for strings); anything else is a 404. */
export function installFetch(routes: Record<string, unknown>): FakeFetch {
  const before = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (!(url in routes)) return new Response("missing", { status: 404 });
    const body = routes[url];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = before;
    },
  };
}

/** A manifest with one clip per id, `<id>.ogg`, whose bytes are `<theme>/<id>`. */
export function themeRoutes(
  theme: string,
  ids: readonly string[],
  base = "/sounds",
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    [`${base}/${theme}/manifest.json`]: {
      theme,
      label: theme,
      version: 1,
      generated_at: "2026-10-19T00:00:00Z",
      clips: Object.fromEntries(ids.map((id) => [id, { file: `${id}.ogg`, ms: 500, variant: 1 }])),
      ...extra,
    },
    ...Object.fromEntries(ids.map((id) => [`${base}/${theme}/${id}.ogg`, `${theme}/${id}`])),
  };
}
