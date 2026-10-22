/** How long a broker-wait helper waits, and what it says it waited for when it gives up. */
export interface WaitOptions {
  /** Real milliseconds before the wait fails (default 5 s, well inside vitest's test timeout). */
  deadlineMs?: number;
  /** What was awaited, named in the failure. */
  what?: string;
}

export const WAIT_DEADLINE_MS = 5_000;

/**
 * Re-check `pred` until it holds, for state that arrives over a broker round-trip with no journal
 * event to await (a retained topic, a fake host's call made in reply to an MQTT message). `pred`
 * may also throw (an `expect`): the throw counts as "not yet". Past `deadlineMs` it rejects with
 * `what` and the last error, so a missed publish is a readable failure, never a vitest timeout.
 * Daemon timing is never waited for this way: drive the fake clock and await the journal
 * (journal-wait.ts) instead.
 */
export async function eventually(
  pred: () => boolean | Promise<boolean>,
  { deadlineMs = WAIT_DEADLINE_MS, what = "a broker round-trip" }: WaitOptions = {},
): Promise<void> {
  // broker round-trip: a deadline on the real clock, so a missed MQTT delivery fails readably.
  const end = Date.now() + deadlineMs;
  let last: unknown;
  for (;;) {
    try {
      if (await pred()) return;
      last = undefined;
    } catch (e) {
      last = e;
    }
    // broker round-trip: the deadline passed with the state never arriving.
    if (Date.now() >= end) {
      const why = last instanceof Error ? last.message : last !== undefined ? String(last) : "";
      throw new Error(
        `waited ${deadlineMs} ms for ${what}${why !== "" ? `; last error: ${why}` : ": still false"}`,
        { cause: last },
      );
    }
    // broker round-trip: an MQTT delivery has no event of its own to await; yield and re-check.
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** `eventually` for a `check` that throws (an `expect`) until it holds. */
export const until = (check: () => void | Promise<void>, opts: WaitOptions = {}): Promise<void> =>
  eventually(async () => {
    await check();
    return true;
  }, opts);
