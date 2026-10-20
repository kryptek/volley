import { DAEMON_AGENT_ID } from "./control";
import { openDecisions, resolveEvent, waveDecisionId } from "./decisions";
import type { WaveRecord } from "./reducer";
import type { JournalEvent, NewEvent, Tunables, WaveId, WaveStatus } from "./types";

/**
 * Archiving an ended wave (SPEC §4.6.18). Pure: the daemon reads the record, the clock and the
 * effective config, and journals what this returns.
 */

/** The answer an archive closes every open decision with. */
export const ARCHIVED_ANSWER = "archived";
/** A manual archive's reason. */
export const MANUAL_REASON = "volleyd archive";
/** The reason when an admin archives through the account-op topic. */
export const ADMIN_REASON = "volleyd archive (admin)";

export type ArchiveTunables = Pick<Tunables, "archive_ended_after_h" | "archive_on_ack">;

/** What the auto-archive verdict needs from a wave's record. */
export interface ArchiveFacts {
  wave: WaveId | null;
  status: WaveStatus | null;
  /** When the wave last ended; null while it runs. */
  endedAt: string | null;
  /**
   * Its `wave_complete` decision was answered by someone outside volleyd: autopilot's own
   * `acknowledged` (by `volleyd`) is not the owner reading the outcome, and an archive's close is
   * not an answer.
   */
  waveCompleteResolved: boolean;
}

/** One `volley/_waves/_archive` entry (archive.schema.json). */
export interface ArchiveEntry {
  wave: WaveId;
  status: "stopped" | "complete";
  archived_at: string;
  by: string;
  reason: string;
}

/** The `_archive` index payload. */
export interface ArchiveIndex {
  archived: ArchiveEntry[];
  updated_at: string;
}

const ENDED: ReadonlySet<WaveStatus> = new Set(["stopped", "complete"]);

/** null when the wave may be archived by hand (it has ended); otherwise why not. */
export function archiveRefusal(rec: WaveRecord): string | null {
  const s = rec.state;
  if (s == null) return "wave was never submitted";
  if (s.status === "archived") return `wave '${s.wave}' is archived already`;
  if (!ENDED.has(s.status))
    return `wave '${s.wave}' is ${s.status}; only a stopped or complete wave can be archived (stop it first)`;
  return null;
}

/** The `at` of the last `wave_stopped` / `wave_complete`, null when a resume followed it. */
export function endedAt(events: Iterable<JournalEvent>): string | null {
  let at: string | null = null;
  for (const e of events) {
    if (e.type === "wave_stopped" || e.type === "wave_complete") at = e.at;
    else if (e.type === "wave_resumed") at = null;
  }
  return at;
}

/**
 * The facts of a record; `legacyEndedAt` reads the end time from the journal (`endedAt`) for a
 * record whose snapshot predates `ended_at`.
 */
export function archiveFacts(rec: WaveRecord, legacyEndedAt?: () => string | null): ArchiveFacts {
  const s = rec.state;
  const status = s?.status ?? null;
  const ended = status !== null && ENDED.has(status);
  const wc = s != null ? rec.decisions[waveDecisionId("wave_complete", s.wave)] : undefined;
  return {
    wave: s?.wave ?? null,
    status,
    endedAt: !ended ? null : (rec.ended_at ?? legacyEndedAt?.() ?? null),
    waveCompleteResolved:
      wc?.resolved !== undefined &&
      wc.resolved.answer !== ARCHIVED_ANSWER &&
      wc.resolved.by !== DAEMON_AGENT_ID,
  };
}

/** Whether the daemon archives the wave now (`archive_on_ack`, `archive_ended_after_h`). */
export function archivable(
  f: ArchiveFacts,
  now: number,
  cfg: ArchiveTunables,
): { ok: true; reason: string } | { ok: false; why: string } {
  if (f.status === null || !ENDED.has(f.status))
    return { ok: false, why: `wave '${f.wave}' is ${f.status ?? "not submitted"}` };
  if (f.status === "complete" && cfg.archive_on_ack && f.waveCompleteResolved)
    return { ok: true, reason: "wave_complete acknowledged (archive_on_ack)" };
  if (cfg.archive_ended_after_h <= 0) return { ok: false, why: "archive_ended_after_h is 0" };
  if (f.endedAt === null) return { ok: false, why: "end time unknown" };
  const ended = Date.parse(f.endedAt);
  if (!Number.isFinite(ended)) return { ok: false, why: `end time '${f.endedAt}' is unparsable` };
  const hours = Math.floor((now - ended) / 3_600_000);
  if (hours < cfg.archive_ended_after_h)
    return { ok: false, why: `ended ${hours} h ago (< ${cfg.archive_ended_after_h} h)` };
  return { ok: true, reason: `ended ${hours} h ago (archive_ended_after_h)` };
}

/** One `decision_resolved` (answer `archived`) per open decision, then `wave_archived`. */
export function archiveEvents(rec: WaveRecord, by: string, reason: string, now: Date): NewEvent[] {
  const closed: string[] = [];
  const events: NewEvent[] = [];
  for (const d of openDecisions(rec)) {
    const r = resolveEvent(rec, d.decision_id, { answer: ARCHIVED_ANSWER, by }, now);
    if (!("event" in r)) continue;
    events.push(r.event);
    closed.push(d.decision_id);
  }
  events.push({ type: "wave_archived", data: { by, reason, closed_decisions: closed } });
  return events;
}

/** The index entry for an archived record (null when it is not archived). */
export function indexEntry(rec: WaveRecord): ArchiveEntry | null {
  const s = rec.state;
  if (s == null || s.status !== "archived" || rec.archived === undefined) return null;
  return {
    wave: s.wave,
    status: rec.archived.from,
    archived_at: rec.archived.at,
    by: rec.archived.by,
    reason: rec.archived.reason,
  };
}

/** The `_archive` payload: newest first, at most `max` entries. */
export function indexPayload(entries: ArchiveEntry[], max: number, now: string): ArchiveIndex {
  const archived = [...entries]
    .sort((a, b) => b.archived_at.localeCompare(a.archived_at))
    .slice(0, Math.max(0, max));
  return { archived, updated_at: now };
}
