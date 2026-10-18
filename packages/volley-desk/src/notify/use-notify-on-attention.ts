/**
 * useNotifyOnAttention — fires a browser notification and the bundled chime
 * when an item's attention tier moves into `you`. Ported from volley-dash's
 * `useNotifyOnAgentEvent`, with the same two gates:
 *
 *   - `settings.enabled` + `Notification.permission === "granted"` → a
 *     desktop notification, `tag` = the item key so repeats collapse.
 *   - `settings.sound` + no `prefers-reduced-motion` → reset and play the
 *     chime (reduced motion silences it; the notification still fires).
 *
 * An item fires once per entry into `you`: it must leave `you` (be seen at
 * another tier) before it can fire again. An item that disappears keeps its
 * last tier for `forgetAfterMs`. While `quiet` (the store is `settling`: the
 * first replay, or a reconnect's resync and replay) tiers are tracked but
 * nothing fires, so whatever needed you when the page loaded or the Desk
 * reconnected stays quiet, and so do the transient tiers of a resync.
 */
import { useEffect, useRef } from "react";
import type { Tier } from "../attention";
import type { NotifyOptions } from "./use-notify-settings";

export interface AttentionItem {
  /** Stable id, e.g. `wave:<id>` or `agent:<id>`; also the notification tag. */
  key: string;
  tier: Tier;
  title: string;
  body: string;
}

export interface NotifyOnAttentionOptions {
  /** Track tiers without firing (pass the store's `settling`). */
  quiet?: boolean;
  /** Extra quiet period after mount (default 0: `quiet` covers the replay). */
  armAfterMs?: number;
  /** How long a vanished item's tier is remembered (default 30 s). */
  forgetAfterMs?: number;
  audioSrc?: string;
}

const FORGET_AFTER_MS = 30_000;

export function useNotifyOnAttention(
  settings: NotifyOptions,
  items: readonly AttentionItem[],
  {
    quiet = false,
    armAfterMs = 0,
    forgetAfterMs = FORGET_AFTER_MS,
    audioSrc = "/notify.mp3",
  }: NotifyOnAttentionOptions = {},
): void {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mountedAt = useRef(Date.now());
  const seen = useRef(new Map<string, { you: boolean; missingSince?: number }>());

  useEffect(() => {
    if (audioRef.current !== null) return;
    if (typeof window === "undefined" || typeof window.Audio === "undefined") return;
    audioRef.current = new window.Audio(audioSrc);
  }, [audioSrc]);

  useEffect(() => {
    const now = Date.now();
    const armed = !quiet && now - mountedAt.current >= armAfterMs;
    const fresh: AttentionItem[] = [];
    const present = new Set<string>();
    for (const it of items) {
      present.add(it.key);
      const you = it.tier === "you";
      const prev = seen.current.get(it.key);
      if (you && !prev?.you && armed) fresh.push(it);
      seen.current.set(it.key, { you });
    }
    for (const [key, s] of seen.current) {
      if (present.has(key)) continue;
      if (s.missingSince === undefined) seen.current.set(key, { ...s, missingSince: now });
      else if (now - s.missingSince > forgetAfterMs) seen.current.delete(key);
    }
    if (fresh.length === 0) return;

    const N = typeof window !== "undefined" ? window.Notification : undefined;
    const canNotify = settings.enabled && N !== undefined && N.permission === "granted";
    const reduceMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const canSound = settings.sound && !reduceMotion;

    if (canNotify && N !== undefined) {
      for (const it of fresh) new N(`Volley: ${it.title}`, { body: it.body, tag: it.key });
    }
    // One chime per render, however many items arrived together.
    if (canSound && audioRef.current !== null) {
      audioRef.current.currentTime = 0;
      void audioRef.current.play()?.catch(() => {
        // Autoplay policies may reject until the page has had a user gesture.
      });
    }
  }, [settings, items, quiet, armAfterMs, forgetAfterMs]);
}
