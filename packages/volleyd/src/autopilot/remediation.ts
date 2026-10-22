import type { DecisionRecord, HeldOn } from "../decisions";
import type { WaveRecord } from "../reducer";
import type { FixerRemediation, NewEvent, TaskId, WaveTask } from "../types";
import { markerOf } from "./budgets";
import type { Budget } from "./policy";

/**
 * Self-healing CI (2), SPEC §4.6.16: a flake's dedicated fixer, as a synthetic task of the wave.
 * Pure: what to do about a `remediation_requested { kind: fix_flake }` given the wave's record.
 */

/** A `remediation_requested { kind: fix_flake }`, as the fixer needs it. */
export interface FixRequest {
  /** The task whose red head it is (the blocked one). */
  task: TaskId;
  test: string;
  test_file: string | null;
  run_urls: string[];
  head?: string;
}

/** The budget key a fixer request past `autopilot.fix_flake_max` escalates with. */
export const FIX_FLAKE_BUDGET = "fix_flake_max";

/** The longest slug a fixer's task id carries (after `fix-`). */
const SLUG_MAX = 40;

/** A journaled `remediation_requested` as a FixRequest (null: not a fix_flake request). */
export function requestOf(ev: Pick<NewEvent, "type" | "task" | "data">): FixRequest | null {
  const d = ev.data;
  if (ev.type !== "remediation_requested" || d.kind !== "fix_flake") return null;
  if (ev.task === undefined || typeof d.test !== "string") return null;
  return {
    task: ev.task,
    test: d.test,
    test_file: typeof d.test_file === "string" ? d.test_file : null,
    run_urls: Array.isArray(d.run_urls)
      ? d.run_urls.filter((u): u is string => typeof u === "string")
      : [],
    ...(typeof d.head === "string" ? { head: d.head } : {}),
  };
}

/**
 * The fixer's task id for `test`: `fix-` and the test lowercased, every run of other characters
 * one dash, trimmed, at most 40 characters; `-2`, `-3`, … when `taken` has it.
 */
export function slugOf(test: string, taken: ReadonlySet<string> = new Set()): string {
  const slug =
    test
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, SLUG_MAX)
      .replace(/-+$/, "") || "test";
  const base = `fix-${slug}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** The wave's flake fixers (synthetic tasks), in the order they were added. */
export function fixers(rec: WaveRecord): WaveTask[] {
  const w = rec.wave;
  if (w == null) return [];
  return w.task_order
    .map((id) => w.tasks[id])
    .filter((t): t is WaveTask => t?.synthetic === true && t.remediation?.kind === "fix_flake");
}

/** The fixer of `test` in the wave, if one was added (closed or not). */
export const fixerOf = (rec: WaveRecord, test: string): WaveTask | undefined =>
  fixers(rec).find((t) => t.remediation?.test === test);

export type FixerVerdict =
  /** A fixer for the test is running: the request joins it (the reducer adds it to `for`). */
  | { reuse: TaskId }
  /** Add the fixer: journal this `task_queued`. */
  | { add: NewEvent }
  /** `autopilot.fix_flake_max` fixers already: the owner decides (`budget_exhausted`). */
  | { over_budget: Budget }
  /** No fixer can take it (its fixer closed, or it is the fixer's own head): the owner decides. */
  | { refuse: string };

/**
 * What a fix_flake request gets: one fixer per distinct test per wave (a second request joins
 * it), at most `max` fixers per wave.
 */
export function fixerFor(rec: WaveRecord, req: FixRequest, max: number): FixerVerdict {
  const existing = fixerOf(rec, req.test);
  if (existing !== undefined) {
    if (existing.id === req.task)
      return { refuse: `${req.test} fails on its own fixer's head (${existing.id})` };
    if (existing.remediation?.outcome !== undefined)
      return {
        refuse: `${existing.id}, the fixer of ${req.test}, already closed (${existing.remediation.outcome})`,
      };
    return { reuse: existing.id };
  }
  const used = fixers(rec).length;
  if (used >= max) return { over_budget: { key: FIX_FLAKE_BUDGET, used, max } };
  const taken = new Set([
    ...Object.keys(rec.wave?.tasks ?? {}),
    ...(rec.state?.tasks.map((t) => t.id) ?? []),
  ]);
  const remediation: FixerRemediation = {
    kind: "fix_flake",
    test: req.test,
    test_file: req.test_file,
    run_urls: req.run_urls,
    for: [req.task],
  };
  return {
    add: {
      type: "task_queued",
      task: slugOf(req.test, taken),
      data: { issue: 0, synthetic: true, title: flakeTitle(req.test), remediation },
    },
  };
}

/** A fixer task's title. */
export const flakeTitle = (test: string): string => `Fix flaky test ${test}`;

/**
 * The tasks a fixer's merge releases: those in its `for` still parked on its test (a head that
 * moved off the flake, a cancelled or finished task is not waiting any more).
 */
export function releasedBy(rec: WaveRecord, fixer: TaskId): TaskId[] {
  const r = rec.wave?.tasks[fixer]?.remediation;
  if (r === undefined) return [];
  const stage = new Map(rec.state?.tasks.map((t) => [t.id, t.stage]) ?? []);
  return r.for.filter((id) => {
    const s = stage.get(id);
    const parked = rec.pipeline[id]?.remediation;
    return (
      s !== undefined &&
      s !== "done" &&
      s !== "cancelled" &&
      parked !== undefined &&
      parked.test === r.test &&
      parked.landed !== true
    );
  });
}

/** A red head's decision: a ci_failed, or a blocked agent's on a red PR head. */
export const isRedHead = (d: DecisionRecord): boolean => {
  const on = markerOf(d)?.on;
  return on === "ci_failed" || on === "agent_blocked_ci";
};

/**
 * The holds autopilot adds (#335): each open red-head decision of a task parked on a flake whose
 * fixer is still at work is held on that fixer task, so it waits amber rather than escalating.
 * A decision held or released before is never held again (the owner's release stands).
 */
export function autoHolds(rec: WaveRecord): { decision_id: string; on: HeldOn; note: string }[] {
  const open = new Set(rec.state?.open_decisions ?? []);
  return Object.values(rec.decisions).flatMap((d) => {
    if (!open.has(d.decision_id) || d.task === null || !isRedHead(d)) return [];
    if (d.held !== undefined || d.released !== undefined) return [];
    const r = rec.pipeline[d.task]?.remediation;
    if (r === undefined || r.landed === true) return [];
    const fixer = fixerOf(rec, r.test);
    if (fixer === undefined || fixer.id === d.task || fixer.remediation?.outcome !== undefined)
      return [];
    return [
      {
        decision_id: d.decision_id,
        on: { task: fixer.id },
        note: `CI flake in ${r.test}: its fixer ${fixer.id} is on it`,
      },
    ];
  });
}
