/**
 * Re-check `pred` until it holds, for state that arrives over a broker round-trip with no journal
 * event to await (a retained topic, a fake host's call made in reply to an MQTT message). It has no
 * deadline of its own: vitest's test timeout bounds it, so a loaded machine only makes it slower.
 * Daemon timing is never waited for this way: drive the fake clock and await the journal
 * (journal-wait.ts) instead.
 */
export async function eventually(pred: () => boolean | Promise<boolean>): Promise<void> {
  while (!(await pred())) {
    // broker round-trip: an MQTT delivery has no event of its own to await; yield and re-check.
    await new Promise((r) => setTimeout(r, 10));
  }
}
