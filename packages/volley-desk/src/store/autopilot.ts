/**
 * What the Desk shows of autopilot (SPEC §4.6.16–19): the line for each of its two journal
 * events, the merge queue as one line, and which tasks a synthetic fixer task fixes. Pure.
 */
import type { Envelope, MergeQueueEntry, WaveTask } from "./types";

/** The journal events autopilot writes, kept from each wave's `events` mirror. */
export const AUTOPILOT_EVENTS: ReadonlySet<string> = new Set([
  "decision_auto_resolved",
  "decision_escalated",
]);

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * `Autopilot · <answer> (<policy>): <rationale>` for an automatic answer,
 * `Autopilot could not resolve (<why>)` for an escalation; `null` for any other envelope.
 */
export function autopilotLine(env: Envelope): string | null {
  if (!AUTOPILOT_EVENTS.has(env.type)) return null;
  const p = env.payload as { data?: Record<string, unknown> } | null | undefined;
  const d = p?.data ?? {};
  if (env.type === "decision_escalated") {
    return `Autopilot could not resolve (${str(d.why) ?? "unknown"})`;
  }
  const rationale = str(d.rationale);
  return `Autopilot · ${str(d.answer) ?? "?"} (${str(d.policy) ?? "?"})${rationale ? `: ${rationale}` : ""}`;
}

const QUEUE_ORDER: readonly MergeQueueEntry["state"][] = [
  "merging",
  "updating",
  "queued",
  "refused",
];

/** `merging T3 · updating T5 · queued T7, T9`: by state, each state's tasks in merge order. */
export function mergeQueueLine(queue: readonly MergeQueueEntry[]): string {
  return QUEUE_ORDER.flatMap((state) => {
    const tasks = queue.filter((e) => e.state === state).map((e) => e.task);
    return tasks.length ? [`${state} ${tasks.join(", ")}`] : [];
  }).join(" · ");
}

const ids = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** The tasks a synthetic fixer task fixes (`synthetic.for`, else `remediation.for`); `null` for a wave-file task. */
export function fixerFor(t: WaveTask): string[] | null {
  if (!t.synthetic) return null;
  const own = typeof t.synthetic === "object" ? ids(t.synthetic.for) : [];
  return own.length ? own : ids(t.remediation?.for);
}
