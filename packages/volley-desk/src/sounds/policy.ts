/**
 * Whether and how often a sound event plays: per-event gating, mute, quiet
 * hours, the hidden-tab rule and reduced motion, then rate limiting. Pure:
 * the clock, the tab's visibility and the local time all come in `env`, and
 * the rate-limit memory is a `PolicyState` value the caller keeps.
 *
 * Rate limiting: an event that plays opens a coalescing window for its id
 * (`COALESCE_MS`, or its minimum gap when that is shorter); repeats inside
 * the window are folded into it and counted, and `flush` reports the total
 * once the window closes (so 20 completions read "20 agents completed").
 * After the window, a repeat inside the id's minimum gap is dropped.
 */
import { SOUND_EVENTS, type SoundEventId } from "./events";
import { type SoundSettings, minutesOf } from "./settings";

// ------------------------------------------------------------- tunables

/** Repeats of one id this close together are one play. */
export const COALESCE_MS = 250;
/** The shortest time between two plays of one id. */
export const DEFAULT_MIN_GAP_MS = 400;
export const MIN_GAP_MS: Partial<Record<SoundEventId, number>> = {
  // Clicks follow the hand.
  ui_click: 60,
  // Every attention entry is its own chime.
  attention_needed: 0,
};

// ------------------------------------------------------------------ types

export interface PolicyEnv {
  now: number;
  /** The Desk tab is hidden (its visibility state). */
  hidden: boolean;
  /** `prefers-reduced-motion: reduce`. */
  reducedMotion: boolean;
  /** Local minutes since midnight. */
  localMinutes: number;
}

export interface Play {
  id: SoundEventId;
  count: number;
}

interface Bucket {
  count: number;
  /** Repeats folded in after the play. */
  folded: number;
  until: number;
}

export interface PolicyState {
  lastPlayedAt: Partial<Record<SoundEventId, number>>;
  pending: Partial<Record<SoundEventId, Bucket>>;
}

export const POLICY0: PolicyState = { lastPlayedAt: {}, pending: {} };

export const minGap = (id: SoundEventId): number => MIN_GAP_MS[id] ?? DEFAULT_MIN_GAP_MS;

/** Whether `localMinutes` falls in `[from, to)`; a range that ends before it starts wraps midnight. */
export function inQuietHours(from: string, to: string, localMinutes: number): boolean {
  const f = minutesOf(from);
  const t = minutesOf(to);
  if (f === t) return false;
  return f < t ? localMinutes >= f && localMinutes < t : localMinutes >= f || localMinutes < t;
}

/** Whether one event may sound at all now, before rate limiting. */
export function allowed(id: SoundEventId, s: SoundSettings, env: PolicyEnv): boolean {
  if (s.muted || !s.events[id]) return false;
  if (env.reducedMotion && s.followReducedMotion) return false;
  const cls = SOUND_EVENTS[id].class;
  if (s.quietHours.on && inQuietHours(s.quietHours.from, s.quietHours.to, env.localMinutes)) {
    if (cls !== "attention" || s.quietHours.attentionToo) return false;
  }
  if (cls === "ui" && env.hidden) return false;
  if (cls === "signal" && s.signalsOnlyWhenHidden && !env.hidden) return false;
  return true;
}

/** Closes the windows that ended by `now`, reporting those that folded repeats. */
export function flush(state: PolicyState, now: number): { done: Play[]; state: PolicyState } {
  const done: Play[] = [];
  const pending: PolicyState["pending"] = {};
  for (const [id, b] of Object.entries(state.pending) as [SoundEventId, Bucket][]) {
    if (b.until > now) pending[id] = b;
    else if (b.folded > 0) done.push({ id, count: b.count });
  }
  return { done, state: { lastPlayedAt: state.lastPlayedAt, pending } };
}

export function decide(
  events: readonly SoundEventId[],
  settings: SoundSettings,
  env: PolicyEnv,
  state: PolicyState,
): { play: Play[]; done: Play[]; state: PolicyState } {
  const counts = new Map<SoundEventId, number>();
  for (const id of events)
    if (allowed(id, settings, env)) counts.set(id, (counts.get(id) ?? 0) + 1);
  const closed = flush(state, env.now);
  const lastPlayedAt = { ...closed.state.lastPlayedAt };
  const pending = { ...closed.state.pending };
  const play: Play[] = [];
  for (const [id, n] of counts) {
    const open = pending[id];
    if (open) {
      pending[id] = { ...open, count: open.count + n, folded: open.folded + n };
      continue;
    }
    const last = lastPlayedAt[id];
    if (last !== undefined && env.now - last < minGap(id)) continue;
    play.push({ id, count: n });
    lastPlayedAt[id] = env.now;
    const span = Math.min(COALESCE_MS, minGap(id));
    if (span > 0) pending[id] = { count: n, folded: 0, until: env.now + span };
  }
  return { play, done: closed.done, state: { lastPlayedAt, pending } };
}
