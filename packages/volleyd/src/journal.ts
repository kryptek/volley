import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { dateOf, systemClock } from "./clock";
import { DAEMON_DEFAULTS } from "./config-defaults";
import { type WaveRecord, apply, emptyRecord, normalizeRecord, replay } from "./reducer";
import type { JournalEvent, NewEvent } from "./types";

const JOURNAL_FILE = "journal.jsonl";
const SNAPSHOT_FILE = "snapshot.json";

/**
 * Parse a JSONL journal. A trailing fragment without a newline is a write torn by a crash and is
 * ignored (`Journal.open` truncates it). Every complete (newline-terminated) line must parse: a
 * corrupt one throws, naming its 1-based line number in the file.
 */
export function readJournalFile(path: string): JournalEvent[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf-8");
  const lines = text.split("\n");
  // The element after the last "\n" is "" for a clean file, or the torn tail.
  lines.pop();
  const events: JournalEvent[] = [];
  lines.forEach((l, i) => {
    if (l.trim() === "") return;
    try {
      events.push(JSON.parse(l) as JournalEvent);
    } catch (e) {
      throw new Error(`${path}: corrupt journal line ${i + 1}: ${(e as Error).message}`);
    }
  });
  return events;
}

/** Replace `path` atomically and durably: write a tmp file, fsync it, rename it over `path`. */
export function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/**
 * A per-wave append-only JSONL journal: `<dir>/journal.jsonl`, one `{ seq, at, type, task?, data }`
 * per line, fsync'd on every append. `seq` starts at 1 and is monotonic.
 */
export class Journal {
  readonly dir: string;
  readonly path: string;
  private last: number;
  private readonly listeners = new Set<(event: JournalEvent) => void>();

  private constructor(dir: string, lastSeq: number) {
    this.dir = dir;
    this.path = join(dir, JOURNAL_FILE);
    this.last = lastSeq;
  }

  /** Open (creating if needed) the journal in `dir`, truncating a torn trailing write. */
  static open(dir: string): Journal {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, JOURNAL_FILE);
    if (existsSync(path)) {
      const text = readFileSync(path, "utf-8");
      const keep = text.lastIndexOf("\n") + 1;
      if (keep !== text.length) {
        truncateSync(path, Buffer.byteLength(text.slice(0, keep)));
      }
    }
    const events = readJournalFile(path);
    return new Journal(dir, events.at(-1)?.seq ?? 0);
  }

  get lastSeq(): number {
    return this.last;
  }

  /** Append one event durably. Assigns `seq`; `at` defaults to now. */
  // real clock: the default for a caller without a clock (the daemon passes its own)
  append(ev: NewEvent, now: Date = dateOf(systemClock)): JournalEvent {
    const event: JournalEvent = {
      seq: this.last + 1,
      at: ev.at ?? now.toISOString(),
      type: ev.type,
      ...(ev.task !== undefined ? { task: ev.task } : {}),
      data: ev.data,
    };
    const fd = openSync(this.path, "a");
    try {
      writeSync(fd, `${JSON.stringify(event)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.last = event.seq;
    for (const fn of this.listeners) fn(event);
    return event;
  }

  /** Call `fn` after every durable append; returns the unsubscribe (tests await events). */
  onAppend(fn: (event: JournalEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  readAll(): JournalEvent[] {
    return readJournalFile(this.path);
  }

  readAfter(seq: number): JournalEvent[] {
    return this.readAll().filter((e) => e.seq > seq);
  }

  /** Atomically persist a reducer snapshot (write tmp, fsync, rename). */
  writeSnapshot(record: WaveRecord): void {
    writeFileAtomic(join(this.dir, SNAPSHOT_FILE), JSON.stringify({ seq: record.seq, record }));
  }

  readSnapshot(): { seq: number; record: Partial<WaveRecord> } | null {
    const path = join(this.dir, SNAPSHOT_FILE);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as {
        seq: number;
        record: Partial<WaveRecord>;
      };
    } catch {
      return null; // a bad snapshot only costs a full replay
    }
  }
}

/**
 * A journal plus its reduced record, kept in step: every append is applied through the reducer,
 * and a snapshot is written every `snapshotEvery` events so a restart replays only the tail.
 */
export class WaveLog {
  readonly journal: Journal;
  private rec: WaveRecord;
  private readonly snapshotEvery: number;

  private constructor(journal: Journal, rec: WaveRecord, snapshotEvery: number) {
    this.journal = journal;
    this.rec = rec;
    this.snapshotEvery = snapshotEvery;
  }

  static open(dir: string, opts: { snapshotEvery?: number } = {}): WaveLog {
    const journal = Journal.open(dir);
    const snap = journal.readSnapshot();
    const base =
      snap !== null && snap.seq <= journal.lastSeq ? normalizeRecord(snap.record) : emptyRecord();
    const rec = replay(journal.readAfter(base.seq), base);
    return new WaveLog(journal, rec, opts.snapshotEvery ?? DAEMON_DEFAULTS.snapshot_every);
  }

  get record(): WaveRecord {
    return this.rec;
  }

  append(ev: NewEvent, now?: Date): JournalEvent {
    const event = this.journal.append(ev, now);
    this.rec = apply(this.rec, event);
    if (event.seq % this.snapshotEvery === 0) this.journal.writeSnapshot(this.rec);
    return event;
  }
}
