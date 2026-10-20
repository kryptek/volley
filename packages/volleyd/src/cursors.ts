import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ID_PATTERN } from "volley-mcp/topics";
import { dateOf, systemClock } from "./clock";
import { readJournalFile, writeFileAtomic } from "./journal";
import { type JournalEvent, SYSTEM_WAVE } from "./types";

/**
 * Named journal cursors: `volleyd events <wave> --cursor <name>` prints every event after the
 * cursor, and only `volleyd ack <wave> --cursor <name> --seq N` moves it — a consumer acks AFTER
 * acting, so an event it crashed on is replayed. Cursors live beside the journal and are read
 * straight from disk, so they work while the daemon is down.
 */

export class CursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorError";
  }
}

function waveDir(home: string, wave: string): string {
  if (wave !== SYSTEM_WAVE && !ID_PATTERN.test(wave))
    throw new CursorError(`invalid wave id '${wave}'`);
  const dir = join(home, "waves", wave);
  if (!existsSync(join(dir, "journal.jsonl")))
    throw new CursorError(`unknown wave '${wave}' (no journal in ${dir})`);
  return dir;
}

function cursorFile(dir: string, name: string): string {
  if (!ID_PATTERN.test(name)) {
    throw new CursorError(`invalid cursor name '${name}' (must match [a-z0-9][a-z0-9_-]{0,62})`);
  }
  return join(dir, "cursors", `${name}.json`);
}

/** The last acked seq for a cursor (0 when it has never been acked). */
export function readCursor(home: string, wave: string, name: string): number {
  const file = cursorFile(waveDir(home, wave), name);
  if (!existsSync(file)) return 0;
  return (JSON.parse(readFileSync(file, "utf-8")) as { seq: number }).seq;
}

/** Every journal event after the cursor, in order. Does not move the cursor. */
export function eventsAfter(home: string, wave: string, name: string): JournalEvent[] {
  const dir = waveDir(home, wave);
  const seq = readCursor(home, wave, name);
  return readJournalFile(join(dir, "journal.jsonl")).filter((e) => e.seq > seq);
}

/**
 * Advance a cursor to `seq`. Moving backwards is a no-op (acks are idempotent and may arrive late);
 * acking past the end of the journal is an error.
 */
export function ackCursor(
  home: string,
  wave: string,
  name: string,
  seq: number,
  // real clock: a CLI ack's stamp, in the CLI process
  now: Date = dateOf(systemClock),
): { previous: number; seq: number } {
  const dir = waveDir(home, wave);
  const file = cursorFile(dir, name);
  const previous = readCursor(home, wave, name);
  const last = readJournalFile(join(dir, "journal.jsonl")).at(-1)?.seq ?? 0;
  if (seq > last)
    throw new CursorError(`seq ${seq} is past the end of the ${wave} journal (last ${last})`);
  if (seq <= previous) return { previous, seq: previous };
  mkdirSync(join(dir, "cursors"), { recursive: true });
  writeFileAtomic(file, JSON.stringify({ seq, acked_at: now.toISOString() }));
  return { previous, seq };
}
