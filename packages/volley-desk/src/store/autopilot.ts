/**
 * What the Desk shows of autopilot (SPEC §4.6.16–19) and of the overlap plan: the line for each
 * of their journal events, the merge queue and its trains as one line, a cluster's badge and
 * strategy, and which tasks a synthetic fixer task fixes. Pure.
 */
import { plural } from "../lib/plural";
import type { Envelope, MergeQueueEntry, PlanCluster, WaveTask, WaveTrain } from "./types";

/** The journal events autopilot writes, kept from each wave's `events` mirror. */
export const AUTOPILOT_EVENTS: ReadonlySet<string> = new Set([
  "decision_auto_resolved",
  "decision_escalated",
]);

/** The overlap plan's journal events: the plan, a cluster's strategy change and the trains. */
export const PLAN_EVENTS: ReadonlySet<string> = new Set([
  "wave_planned",
  "cluster_strategy_changed",
  "train_started",
  "train_merged",
  "train_failed",
]);

/** Every journal event kept in a wave's feed. */
export const WAVE_FEED_EVENTS: ReadonlySet<string> = new Set([...AUTOPILOT_EVENTS, ...PLAN_EVENTS]);

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const ids = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * `Autopilot · <answer> (<policy>): <rationale>` for an automatic answer,
 * `Autopilot could not resolve (<why>)` for an escalation, the plan's events as `planned · 2
 * clusters`, `cluster A → hold: <why>`, `train train-1 started (T2, T4)`, `… merged in #12` and
 * `… failed: <why>`; `null` for any other envelope.
 */
export function autopilotLine(env: Envelope): string | null {
  if (!WAVE_FEED_EVENTS.has(env.type)) return null;
  const p = env.payload as { data?: Record<string, unknown> } | null | undefined;
  const d = p?.data ?? {};
  const train = `train ${str(d.train) ?? "?"}`;
  switch (env.type) {
    case "wave_planned": {
      return `planned · ${plural(Array.isArray(d.clusters) ? d.clusters.length : 0, "cluster")}`;
    }
    case "cluster_strategy_changed": {
      const why = str(d.why);
      return `cluster ${str(d.cluster) ?? "?"} → ${str(d.to) ?? "?"}${why ? `: ${why}` : ""}`;
    }
    case "train_started":
      return `${train} started (${ids(d.tasks).join(", ")})`;
    case "train_merged":
      return `${train} merged${typeof d.pr === "number" ? ` in #${d.pr}` : ""}`;
    case "train_failed":
      return `${train} failed: ${str(d.why) ?? "unknown"}`;
  }
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

/** A merge train as the queue line reads it: `train-1 (T2, T4) integrating`. */
export const trainLine = (t: WaveTrain): string => `${t.id} (${t.tasks.join(", ")}) ${t.state}`;

/** The trains still running (neither merged nor failed), in the order they formed. */
export const liveTrains = (trains: readonly WaveTrain[] | undefined): WaveTrain[] =>
  (trains ?? []).filter((t) => t.state !== "merged" && t.state !== "failed");

/** A cluster's strategy: `5 bundles · 2 chains · cap 4`, or `independent`. */
export function strategyLine(st: PlanCluster["strategy"]): string {
  const parts = [
    ...(st.collapse?.length ? [plural(st.collapse.length, "bundle")] : []),
    ...(st.chain?.length ? [plural(st.chain.length, "chain")] : []),
    ...(st.cap !== undefined ? [`cap ${st.cap}`] : []),
  ];
  return parts.length ? parts.join(" · ") : "independent";
}

/** A cluster's graph badge: `A · hold` while held, `A · 4/4` (in flight / cap) when capped, else `A`. */
export function clusterBadge(c: PlanCluster, inFlight: number): string {
  if (c.state === "hold") return `${c.id} · hold`;
  if (c.strategy.cap !== undefined) return `${c.id} · ${inFlight}/${c.strategy.cap}`;
  return c.id;
}

/** Stages a task holds a cluster slot in: started and not yet landed. */
const IDLE_STAGES: ReadonlySet<string> = new Set(["queued", "done", "cancelled"]);
export const inFlight = (t: Pick<WaveTask, "stage">): boolean => !IDLE_STAGES.has(t.stage);

/**
 * The tasks a synthetic fixer task fixes (`synthetic.for`, else `remediation.for`); `null` for a
 * wave-file task or a merge train's.
 */
export function fixerFor(t: WaveTask): string[] | null {
  if (!t.synthetic || t.train) return null;
  const own = typeof t.synthetic === "object" ? ids(t.synthetic.for) : [];
  return own.length ? own : ids(t.remediation?.for);
}
