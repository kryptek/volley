import { join } from "node:path";
import type { Daemon } from "../../src/daemon";
import { readJournalFile } from "../../src/journal";
import type { JournalEvent } from "../../src/types";
import { WAIT_DEADLINE_MS } from "./broker-wait";
import { flushMicrotasks } from "./fake-clock";

/**
 * An event type, a predicate over events, or a predicate with `what` it waits for (named in the
 * timeout message, as `WaitOptions.what` is for `eventually`).
 */
export type EventMatch =
  | string
  | ((e: JournalEvent) => boolean)
  | { what: string; test: (e: JournalEvent) => boolean };

const matcher = (m: EventMatch) =>
  typeof m === "string" ? (e: JournalEvent) => e.type === m : typeof m === "function" ? m : m.test;
const label = (m: EventMatch) =>
  typeof m === "string" ? m : typeof m === "function" ? "a matching event" : m.what;

/**
 * Await journal events as the daemon appends them: the promise is resolved by the append itself
 * (Daemon.onJournal), never by a polling loop. Events already in the journal count, so a wait
 * started after the event landed resolves at once. An event that never lands rejects after
 * `deadlineMs` (default 5 s) naming what was awaited, never as a vitest timeout.
 */
export interface JournalWait {
  /** The `n`-th event (1-based) of `wave` matching `match`, within `deadlineMs`. */
  event(wave: string, match: EventMatch, n?: number, deadlineMs?: number): Promise<JournalEvent>;
  /** Every event of `wave` so far. */
  events(wave: string): JournalEvent[];
  /**
   * The daemon is idle: its queue drained, no spawn launching, every append published, and the
   * promise continuations those released (e.g. supervision attaching after a verification) run.
   */
  settled(): Promise<void>;
}

/** `home` is $VOLLEYD_HOME; `daemon()` the daemon running now (a restart replaces it). */
export function journalWait(home: string, daemon: () => Daemon): JournalWait {
  const events = (wave: string) => readJournalFile(join(home, "waves", wave, "journal.jsonl"));
  return {
    events,
    async settled() {
      await daemon().settled();
      await flushMicrotasks();
    },
    event(wave, match, n = 1, deadlineMs = WAIT_DEADLINE_MS) {
      const pred = matcher(match);
      // Read, then subscribe, in one synchronous step: no append can fall between the two.
      const seen = events(wave).filter(pred);
      if (seen.length >= n) return Promise.resolve(seen[n - 1] as JournalEvent);
      let count = seen.length;
      const what = label(match);
      return new Promise((resolve, reject) => {
        // broker round-trip: the append follows MQTT deliveries; an event that never lands fails.
        const timer = setTimeout(() => {
          off();
          const types = events(wave).map((e) => e.type);
          reject(
            new Error(
              `waited ${deadlineMs} ms for ${what} #${n} in wave ${wave} (saw ${count}); journal: ${types.join(", ")}`,
            ),
          );
        }, deadlineMs);
        const off = daemon().onJournal((w, e) => {
          if (w !== wave || !pred(e) || ++count < n) return;
          off();
          clearTimeout(timer);
          resolve(e);
        });
      });
    },
  };
}
