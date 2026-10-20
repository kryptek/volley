import { describe, expect, it } from "vitest";
import {
  type ArchiveTunables,
  archivable,
  archiveEvents,
  archiveFacts,
  archiveRefusal,
  endedAt,
  indexPayload,
} from "../src/archive";
import { waveDecisionId } from "../src/decisions";
import { apply, replay } from "../src/reducer";
import type { JournalEvent, NewEvent } from "../src/types";
import { parseWaveFile } from "../src/wave-file";
import { envelope, schemaErrors } from "./helpers/schema";

const WAVE = "w-arch";
const T0 = "2026-10-20T10:00:00.000Z";
const H = 3_600_000;
const wave = parseWaveFile(`wave: ${WAVE}
repo: example-org/example-repo
release_branch: release/${WAVE}
model: claude-opus-5-5
pipeline: [implement, merge_ready]
tasks:
  A: { issue: 1 }
`);
const WC = waveDecisionId("wave_complete", WAVE);

/** Hand-written events, numbered and stamped `T0 + i minutes`. */
function journal(...evs: NewEvent[]): JournalEvent[] {
  return evs.map((e, i) => ({
    seq: i + 1,
    at: new Date(Date.parse(T0) + i * 60_000).toISOString(),
    ...e,
  }));
}

const submitted: NewEvent = { type: "wave_submitted", data: { wave, owner: "coord-a" } };
const queued: NewEvent = { type: "task_queued", task: "A", data: { issue: 1 } };
const blocked: NewEvent = {
  type: "decision_opened",
  task: "A",
  data: {
    decision_id: "d-blocked",
    kind: "agent_blocked",
    question: "?",
    options: ["retry"],
  },
};
const stopped: NewEvent = { type: "wave_stopped", data: { by: "coord-a" } };
const done: NewEvent = { type: "stage_entered", task: "A", data: { stage: "done" } };
const wcOpened: NewEvent = {
  type: "decision_opened",
  data: { decision_id: WC, kind: "wave_complete", question: "done", options: ["acknowledged"] },
};
const complete: NewEvent = { type: "wave_complete", data: { done: ["A"], cancelled: [] } };
const ack: NewEvent = {
  type: "decision_resolved",
  data: { decision_id: WC, answer: "acknowledged", by: "coord-a", at: T0 },
};

const CFG: ArchiveTunables = { archive_ended_after_h: 24, archive_on_ack: true };

describe("archiveRefusal: only an ended wave is archived", () => {
  it("refuses running, paused and awaiting_decision, naming the status; accepts stopped and complete", () => {
    expect(archiveRefusal(replay(journal(submitted, queued)))).toContain("running");
    const paused = replay(journal(submitted, queued, { type: "wave_paused", data: { by: "x" } }));
    expect(archiveRefusal(paused)).toContain("paused");
    const rec = replay(journal(submitted, queued));
    const awaiting = { ...rec, state: { ...rec.state, status: "awaiting_decision" as const } };
    expect(archiveRefusal(awaiting as typeof rec)).toContain("awaiting_decision");
    expect(archiveRefusal(replay(journal(submitted, queued, stopped)))).toBeNull();
    expect(archiveRefusal(replay(journal(submitted, queued, done, wcOpened, complete)))).toBeNull();
  });

  it("refuses an archived wave", () => {
    const evs = journal(submitted, queued, stopped);
    const rec = replay(evs);
    const more = archiveEvents(rec, "coord-a", "volleyd archive", new Date(T0));
    const archived = replay(journal(submitted, queued, stopped, ...more));
    expect(archiveRefusal(archived)).toContain("archived");
  });
});

describe("archiveEvents", () => {
  it("closes each open decision as archived, then journals wave_archived; re-applying is a no-op", () => {
    const base = journal(submitted, queued, blocked, stopped);
    const rec = replay(base);
    expect(rec.state?.open_decisions).toEqual(["d-blocked"]);
    const at = new Date("2026-10-21T00:00:00.000Z");
    const evs = archiveEvents(rec, "coord-a", "volleyd archive", at);
    expect(evs).toEqual([
      {
        type: "decision_resolved",
        task: "A",
        data: {
          decision_id: "d-blocked",
          answer: "archived",
          by: "coord-a",
          at: at.toISOString(),
        },
      },
      {
        type: "wave_archived",
        data: { by: "coord-a", reason: "volleyd archive", closed_decisions: ["d-blocked"] },
      },
    ]);
    const all = journal(submitted, queued, blocked, stopped, ...evs);
    const after = replay(all);
    expect(after.state?.open_decisions).toEqual([]);
    expect(after.decisions["d-blocked"]?.resolved?.answer).toBe("archived");
    expect(after.state?.status).toBe("archived");
    expect(after.archived).toEqual({
      at: all.at(-1)?.at,
      by: "coord-a",
      reason: "volleyd archive",
      from: "stopped",
    });
    expect(apply(after, all.at(-1) as JournalEvent)).toBe(after);
    expect(
      schemaErrors("wave-state.schema.json", envelope("_waves/state", "wave_state", after.state)),
    ).toEqual([]);
  });

  it("a wave with no open decision journals only wave_archived", () => {
    const rec = replay(journal(submitted, queued, stopped));
    expect(archiveEvents(rec, "volleyd", "r", new Date(T0))).toEqual([
      { type: "wave_archived", data: { by: "volleyd", reason: "r", closed_decisions: [] } },
    ]);
  });
});

describe("endedAt and the auto-archive verdict", () => {
  it("endedAt is the at of the last wave_stopped / wave_complete; a resume clears it", () => {
    const evs = journal(submitted, queued, stopped);
    expect(endedAt(evs)).toBe(evs[2]?.at);
    expect(replay(evs).ended_at).toBe(evs[2]?.at);
    const resumed = journal(submitted, queued, stopped, {
      type: "wave_resumed",
      data: { by: "x" },
    });
    expect(endedAt(resumed)).toBeNull();
    expect(replay(resumed).ended_at).toBeNull();
    expect(endedAt(journal(submitted, queued))).toBeNull();
  });

  it("archive_ended_after_h: not at 23 h, at 24 h; 0 never", () => {
    const evs = journal(submitted, queued, stopped);
    const ended = Date.parse(evs[2]?.at as string);
    const facts = archiveFacts(replay(evs));
    expect(archivable(facts, ended + 23 * H, CFG).ok).toBe(false);
    const due = archivable(facts, ended + 24 * H, CFG);
    expect(due).toEqual({ ok: true, reason: "ended 24 h ago (archive_ended_after_h)" });
    const never = { ...CFG, archive_ended_after_h: 0 };
    expect(archivable(facts, ended + 1000 * H, never).ok).toBe(false);
  });

  it("a running wave is never archivable, whatever the time", () => {
    const facts = archiveFacts(replay(journal(submitted, queued)));
    const v = archivable(facts, Date.parse(T0) + 1000 * H, CFG);
    expect(v).toMatchObject({ ok: false, why: expect.stringContaining("running") });
  });

  it("archive_on_ack: a complete wave whose wave_complete is answered is archivable at once", () => {
    const evs = journal(submitted, queued, done, wcOpened, complete, ack);
    const facts = archiveFacts(replay(evs));
    const now = Date.parse(evs.at(-1)?.at as string);
    expect(archivable(facts, now, CFG)).toEqual({
      ok: true,
      reason: "wave_complete acknowledged (archive_on_ack)",
    });
    expect(archivable(facts, now, { ...CFG, archive_on_ack: false }).ok).toBe(false);
    const ended = Date.parse(evs[4]?.at as string);
    expect(archivable(facts, ended + 24 * H, { ...CFG, archive_on_ack: false }).ok).toBe(true);
    // Not yet answered: waits for the TTL.
    const open = archiveFacts(replay(journal(submitted, queued, done, wcOpened, complete)));
    expect(archivable(open, now, CFG).ok).toBe(false);
  });

  it("archiveFacts falls back to the journal when the record predates ended_at", () => {
    const evs = journal(submitted, queued, stopped);
    const { ended_at: _e, ...legacy } = replay(evs);
    expect(archiveFacts(legacy).endedAt).toBeNull();
    expect(archiveFacts(legacy, () => endedAt(evs)).endedAt).toBe(evs[2]?.at);
  });
});

describe("indexPayload", () => {
  it("newest first, at most max entries, schema-valid", () => {
    const entries = [1, 2, 3].map((i) => ({
      wave: `w${i}`,
      status: "stopped" as const,
      archived_at: `2026-10-2${i}T00:00:00.000Z`,
      by: "volleyd",
      reason: "volleyd archive",
    }));
    const p = indexPayload(entries, 2, "2026-10-24T00:00:00.000Z");
    expect(p.archived.map((e) => e.wave)).toEqual(["w3", "w2"]);
    expect(p.updated_at).toBe("2026-10-24T00:00:00.000Z");
    expect(schemaErrors("archive.schema.json", envelope("_waves/_archive", "archive", p))).toEqual(
      [],
    );
  });
});
