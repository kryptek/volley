import type { JournalEvent } from "./types";

/**
 * The terminal-status watchdog (pure): an agent's terminal status (`done`, `blocked`, `failed`)
 * that nothing in the wave journal has named since it arrived is a status the daemon dropped.
 * The daemon raises `terminal_status_unjournaled` for it once, and clears it when something
 * finally names the agent.
 */

/** The watchdog's own alarm: never counts as the daemon having handled the status. */
export const TERMINAL_ALARM = "terminal_status_unjournaled";

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

/** The agent a journal event is about (`agent_id`, or a relaunch's `from_agent`), if any. */
export function namedAgent(ev: Pick<JournalEvent, "type" | "data">): string | undefined {
  if (
    (ev.type === "alarm_raised" || ev.type === "alarm_cleared") &&
    ev.data.alarm === TERMINAL_ALARM
  )
    return undefined;
  const id = ev.data.agent_id ?? ev.data.from_agent;
  return typeof id === "string" ? id : undefined;
}

/** Something was journaled about the agent after its status arrived. */
export const journaledSince = (t: TerminalSeen, lastNamed: ReadonlyMap<string, number>): boolean =>
  (lastNamed.get(t.agent_id) ?? -1) > t.after_seq;

/**
 * The statuses nothing has been journaled about for longer than `thresholdMs`. `lastNamed`: per
 * agent, the seq of the latest journal event `namedAgent` names it in.
 */
export function unjournaledTerminals(
  seen: readonly TerminalSeen[],
  lastNamed: ReadonlyMap<string, number>,
  now: number,
  thresholdMs: number,
): { agent_id: string; role: string; task: string; status: string; since: string }[] {
  return seen
    .filter((t) => WATCHED_STATUS.has(t.status))
    .filter((t) => !journaledSince(t, lastNamed) && now - t.seen_at > thresholdMs)
    .map((t) => ({
      agent_id: t.agent_id,
      role: t.role,
      task: t.task,
      status: t.status,
      since: t.wall_time,
    }));
}
