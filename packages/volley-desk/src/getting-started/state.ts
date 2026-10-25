/**
 * Getting started's progress, kept per browser in `localStorage` under `PROGRESS_KEY`: the step
 * reached, the summary the steps collect, and once it is over whether it was finished or skipped
 * (and when). Pure over a `Storage`-shaped argument; a missing, malformed or other-version value
 * reads as a fresh start, and a blocked storage only forgets.
 */
import { type SceneId, isSceneId } from "./art/ids";

export const PROGRESS_KEY = "volley-desk:getting-started";
export const PROGRESS_VERSION = 1;

export type PersonRole = "admin" | "steer" | "watch";

/** What the steps learnt and did; the Done step lists it. */
export interface Summary {
  /** This computer's name. */
  machine?: string;
  /** Every computer in the pool (this one included). */
  machines: string[];
  /** How the other computers were connected. */
  connectedBy?: "code" | "key" | "password";
  repos: string[];
  people: { name: string; role: PersonRole }[];
  /** How the Desk is reached away from home. */
  network?: "tailscale" | "manual" | "none";
  coordinatorMachine?: string | null;
}

export type DoneKind = "finished" | "skipped";

export interface Progress {
  v: typeof PROGRESS_VERSION;
  step: SceneId;
  summary: Summary;
  done?: { kind: DoneKind; at: string };
}

type Store = Pick<Storage, "getItem" | "setItem">;

/** This browser's `localStorage`, or `null` where it is blocked. */
export function localStore(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export const freshProgress = (): Progress => ({
  v: PROGRESS_VERSION,
  step: "welcome",
  summary: { machines: [], repos: [], people: [] },
});

const strings = (x: unknown): string[] =>
  Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];
const oneOf = <T extends string>(x: unknown, all: readonly T[]): T | undefined =>
  typeof x === "string" && (all as readonly string[]).includes(x) ? (x as T) : undefined;

function parseSummary(raw: unknown): Summary {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const people = Array.isArray(r.people)
    ? r.people.flatMap((p) => {
        const o = p && typeof p === "object" ? (p as Record<string, unknown>) : {};
        const role = oneOf(o.role, ["admin", "steer", "watch"] as const);
        return typeof o.name === "string" && role ? [{ name: o.name, role }] : [];
      })
    : [];
  const connectedBy = oneOf(r.connectedBy, ["code", "key", "password"] as const);
  const network = oneOf(r.network, ["tailscale", "manual", "none"] as const);
  return {
    ...(typeof r.machine === "string" ? { machine: r.machine } : {}),
    machines: strings(r.machines),
    ...(connectedBy ? { connectedBy } : {}),
    repos: strings(r.repos),
    people,
    ...(network ? { network } : {}),
    ...(typeof r.coordinatorMachine === "string" || r.coordinatorMachine === null
      ? { coordinatorMachine: r.coordinatorMachine }
      : {}),
  };
}

/** The stored progress, or a fresh one. */
export function readProgress(storage: Pick<Storage, "getItem"> | null): Progress {
  try {
    const raw = JSON.parse(storage?.getItem(PROGRESS_KEY) ?? "null") as Record<
      string,
      unknown
    > | null;
    if (!raw || raw.v !== PROGRESS_VERSION) return freshProgress();
    const step = typeof raw.step === "string" && isSceneId(raw.step) ? raw.step : "welcome";
    const d = raw.done as { kind?: unknown; at?: unknown } | undefined;
    const kind = oneOf(d?.kind, ["finished", "skipped"] as const);
    return {
      v: PROGRESS_VERSION,
      step,
      summary: parseSummary(raw.summary),
      ...(kind && typeof d?.at === "string" ? { done: { kind, at: d.at } } : {}),
    };
  } catch {
    return freshProgress();
  }
}

export function writeProgress(storage: Pick<Storage, "setItem"> | null, p: Progress): void {
  try {
    storage?.setItem(PROGRESS_KEY, JSON.stringify(p));
  } catch {
    // Storage blocked: Getting started forgets where it was, and opens again next load.
  }
}

/** Mark Getting started finished or skipped at `now`, keeping the step and summary. */
export function markDone(storage: Store | null, kind: DoneKind, now: Date): Progress {
  const p: Progress = { ...readProgress(storage), done: { kind, at: now.toISOString() } };
  writeProgress(storage, p);
  return p;
}
