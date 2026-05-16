/**
 * useNotifyOnAgentEvent — side-effect hook that bridges Plan 8's event ring
 * buffer to the browser Notification API and a bundled chime. Pure
 * side-effect: no state, no reducer dispatch.
 *
 * Strategy: snapshot `events[0].id` on mount so pre-existing history doesn't
 * fire a flurry of notifications; on each subsequent change, walk newest→
 * oldest until we re-meet that id, then dispatch the collected events in
 * chronological order. The "last seen" id ref tolerates the ring buffer
 * dropping old events off the tail.
 *
 * Two gates per event:
 *   - `settings.enabled` + `Notification.permission === "granted"` → fire
 *     a desktop banner with `tag = agent_id` so rapid transitions collapse.
 *   - `settings.sound` + no `prefers-reduced-motion` → reset + play the
 *     bundled audio. Reduced-motion silences the chime but the banner still
 *     fires (the chime is the motion-equivalent affordance per WCAG SC 2.3.3).
 */
import { useEffect, useRef } from "react";
import type { FeedEvent } from "../types";
import type { NotifyOptions } from "./use-notify-settings";

export function useNotifyOnAgentEvent(settings: NotifyOptions, events: FeedEvent[]): void {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastSeenIdRef = useRef<string | null>(null);
  const initializedRef = useRef(false);

  useEffect(() => {
    if (audioRef.current !== null) return;
    if (typeof window === "undefined" || typeof window.Audio === "undefined") return;
    audioRef.current = new window.Audio("/notify.mp3");
  }, []);

  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      lastSeenIdRef.current = events[0]?.id ?? null;
      return;
    }

    const fresh: FeedEvent[] = [];
    for (const ev of events) {
      if (ev.id === lastSeenIdRef.current) break;
      fresh.push(ev);
    }
    const head = events[0];
    if (head !== undefined) {
      lastSeenIdRef.current = head.id;
    }
    if (fresh.length === 0) return;

    // Process chronologically (oldest first) so rapid-fire transitions land in
    // intuitive order.
    fresh.reverse();

    const onSet = new Set(settings.on);
    const N = typeof window !== "undefined" ? window.Notification : undefined;
    const canNotify = settings.enabled && N !== undefined && N.permission === "granted";
    const reduceMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const canSound = settings.sound && !reduceMotion;

    for (const ev of fresh) {
      if (ev.ch !== "status") continue;
      if (!onSet.has(ev.type)) continue;

      if (canNotify && N !== undefined) {
        new N(`Volley: ${ev.agent}`, {
          body: ev.type,
          icon: "/favicon.svg",
          tag: ev.agent,
        });
      }
      if (canSound && audioRef.current !== null) {
        audioRef.current.currentTime = 0;
        void audioRef.current.play().catch(() => {
          // Autoplay policies may reject; swallow so a single rejection doesn't
          // break the loop for the next event.
        });
      }
    }
  }, [settings, events]);
}
