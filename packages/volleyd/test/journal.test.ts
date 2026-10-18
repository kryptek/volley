import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Journal, WaveLog, readJournalFile } from "../src/journal";
import { replay } from "../src/reducer";
import type { JournalEvent, NewEvent } from "../src/types";

const fixture: JournalEvent[] = readFileSync(
  new URL("./fixtures/journal.jsonl", import.meta.url),
  "utf-8",
)
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));

/** The fixture as un-sequenced events, so a journal re-assigns seq/at. */
const fresh: NewEvent[] = fixture.map(({ seq: _s, at, ...rest }) => ({ ...rest, at }));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "volleyd-journal-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("Journal", () => {
  it("assigns monotonic seq starting at 1 and reads back after reopen", () => {
    const j = Journal.open(dir);
    const a = j.append(fresh[0] as NewEvent);
    const b = j.append(fresh[1] as NewEvent);
    expect([a.seq, b.seq]).toEqual([1, 2]);

    const reopened = Journal.open(dir);
    expect(reopened.lastSeq).toBe(2);
    expect(reopened.readAll()).toEqual([a, b]);
    expect(reopened.append(fresh[2] as NewEvent).seq).toBe(3);
  });

  it("survives a simulated crash mid-write: the torn line is dropped and appends continue", () => {
    const j = Journal.open(dir);
    for (const e of fresh.slice(0, 3)) j.append(e);
    // Crash while writing event 4: half a line, no newline.
    appendFileSync(join(dir, "journal.jsonl"), '{"seq":4,"at":"2026-10-20T09:0');

    expect(readJournalFile(join(dir, "journal.jsonl")).map((e) => e.seq)).toEqual([1, 2, 3]);
    const reopened = Journal.open(dir);
    expect(reopened.lastSeq).toBe(3);
    const next = reopened.append(fresh[3] as NewEvent);
    expect(next.seq).toBe(4);
    expect(
      Journal.open(dir)
        .readAll()
        .map((e) => e.seq),
    ).toEqual([1, 2, 3, 4]);
  });

  it("readAfter returns only the tail", () => {
    const j = Journal.open(dir);
    for (const e of fresh.slice(0, 5)) j.append(e);
    expect(j.readAfter(3).map((e) => e.seq)).toEqual([4, 5]);
  });
});

describe("WaveLog", () => {
  it("snapshot + tail replay equals full replay", () => {
    const log = WaveLog.open(dir, { snapshotEvery: 4 });
    for (const e of fresh) log.append(e);
    const full = replay(Journal.open(dir).readAll());
    expect(log.record).toEqual(full);

    const snap = Journal.open(dir).readSnapshot();
    expect(snap?.seq).toBe(12); // last multiple of 4 ≤ 15
    const restored = WaveLog.open(dir, { snapshotEvery: 4 });
    expect(restored.record).toEqual(full);
    expect(restored.record.seq).toBe(fresh.length);
  });

  it("restores from journal alone when there is no snapshot", () => {
    const log = WaveLog.open(dir, { snapshotEvery: 1000 });
    for (const e of fresh) log.append(e);
    expect(Journal.open(dir).readSnapshot()).toBeNull();
    expect(WaveLog.open(dir, { snapshotEvery: 1000 }).record).toEqual(log.record);
  });
});
