import type { JournalEvent } from "./types";

/**
 * The terminal-status watchdog (pure): an agent's terminal status (`done`, `blocked`, `failed`)
 * that nothing in the wave journal has handled since it arrived is a status the daemon dropped.
 * The daemon raises `terminal_status_unjournaled` for it once, and clears it when the status is
 * finally handled. A `blocked` is handled only by a decision or a retire naming the agent
 * (`decidedAgent`); a `done` or `failed` by any event naming it but noise (`namedAgent`).
 * A `done` / `failed` still unhandled `terminal_recover_ms` after its alarm is recovered: the
 * daemon hands its retained status over again (`recoverableTerminals`).
 */

/** The watchdog's own alarm: never counts as the daemon having handled the status. */
export const TERMINAL_ALARM = "terminal_status_unjournaled";

/** A `blocked` status the daemon could not hand to the pipeline: says why, and asks itself. */
export const BLOCKED_ALARM = "blocked_unhandled";

/** The daemon's journal entry for a terminal status it recovered after the alarm. */
export const TERMINAL_RECOVERED = "terminal_status_recovered";

/** Events that name an agent without handling its status. */
const NOISE: ReadonlySet<string> = new Set(["reconciled", "agent_registered"]);

/** Events that settle a `blocked`: someone is asked, or the agent is done with. */
const DECIDING: ReadonlySet<string> = new Set([
  "decision_opened",
  "agent_retired",
  "agent_force_retired",
  "relaunched",
]);

export const WATCHED_STATUS: ReadonlySet<string> = new Set(["done", "blocked", "failed"]);

/** A terminal status as the daemon received it. */
export interface TerminalSeen {
  agent_id: string;
  role: string;
  task: string;
  status: string;
  /** The status envelope's `wall_time` (the agent's clock): what the alarm reports as `since`. */
  wall_time: string;
  /** When the daemon received it (its own clock, epoch ms): the age is measured from here. */
  seen_at: number;
  /** The wave journal's seq when it arrived: only an event after it counts as handling it. */
  after_seq: number;
}

const agentOf = (ev: Pick<JournalEvent, "data">): string | undefined => {
  const id = ev.data.agent_id ?? ev.data.from_agent;
  return typeof id === "string" ? id : undefined;
};

/**
 * The agent a journal event is about (`agent_id`, or a relaunch's `from_agent`), if any — except
 * noise (a reconcile, a registration) and the watchdog's and blocked_unhandled alarms.
 */
export function namedAgent(ev: Pick<JournalEvent, "type" | "data">): string | undefined {
  if (NOISE.has(ev.type)) return undefined;
  if (
    (ev.type === "alarm_raised" || ev.type === "alarm_cleared") &&
    (ev.data.alarm === TERMINAL_ALARM ||
      ev.data.alarm === BLOCKED_ALARM ||
      // The status handoff's own error: the status is still not handled.
      (ev.data.alarm === "pipeline_error" && ev.data.check === "status"))
  )
    return undefined;
  return agentOf(ev);
}

/** The agent a decision, a retire or a relaunch names: what handles a `blocked`. */
export const decidedAgent = (ev: Pick<JournalEvent, "type" | "data">): string | undefined =>
  DECIDING.has(ev.type) ? agentOf(ev) : undefined;

/**
 * The status was handled after it arrived: a `blocked` by a decision or a retire (`lastDecided`),
 * a `done` / `failed` by any event naming the agent (`lastNamed`).
 */
export const journaledSince = (
  t: TerminalSeen,
  lastNamed: ReadonlyMap<string, number>,
  lastDecided: ReadonlyMap<string, number> = new Map(),
): boolean =>
  ((t.status === "blocked" ? lastDecided : lastNamed).get(t.agent_id) ?? -1) > t.after_seq;

/**
 * The statuses nothing has handled for longer than `thresholdMs`. `lastNamed` / `lastDecided`:
 * per agent, the seq of the latest journal event `namedAgent` / `decidedAgent` names it in.
 */
export function unjournaledTerminals(
  seen: readonly TerminalSeen[],
  lastNamed: ReadonlyMap<string, number>,
  now: number,
  thresholdMs: number,
  lastDecided: ReadonlyMap<string, number> = new Map(),
): { agent_id: string; role: string; task: string; status: string; since: string }[] {
  return seen
    .filter((t) => WATCHED_STATUS.has(t.status))
    .filter((t) => !journaledSince(t, lastNamed, lastDecided) && now - t.seen_at > thresholdMs)
    .map((t) => ({
      agent_id: t.agent_id,
      role: t.role,
      task: t.task,
      status: t.status,
      since: t.wall_time,
    }));
}

/** A terminal status's identity: one alarm, one recovery each. */
export const terminalKey = (t: Pick<TerminalSeen, "agent_id" | "wall_time">): string =>
  `${t.agent_id}@${t.wall_time}`;

/** The statuses a recovery hands over again (a `blocked` is the blocked invariant's). */
const RECOVERED_STATUS: ReadonlySet<string> = new Set(["done", "failed"]);

/**
 * The `done` / `failed` statuses still unhandled `recoverMs` after their alarm. `alarmed`: when
 * each alarm was raised (epoch ms), by `terminalKey`.
 */
export function recoverableTerminals(
  seen: readonly TerminalSeen[],
  alarmed: ReadonlyMap<string, number>,
  lastNamed: ReadonlyMap<string, number>,
  now: number,
  recoverMs: number,
  lastDecided: ReadonlyMap<string, number> = new Map(),
): TerminalSeen[] {
  return seen.filter((t) => {
    if (!RECOVERED_STATUS.has(t.status) || journaledSince(t, lastNamed, lastDecided)) return false;
    const at = alarmed.get(terminalKey(t));
    return at !== undefined && now - at >= recoverMs;
  });
}
