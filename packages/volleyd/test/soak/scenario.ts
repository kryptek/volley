import type { JournalEvent } from "../../src/types";
import type { Behaviour, FleetAgent } from "../helpers/fake-agents";
import type { SoakEnv } from "../helpers/soak-env";
import { type Flake, unit } from "../helpers/soak-world";

/**
 * The soak's fault schedule, as data: which task's agent stalls, fails, reports an unparseable
 * result; which launches time out; when the owner's MCP server drops and the screens are slow;
 * which PR heads take a release-only merge. Everything is picked from `SOAK_SEED`, so a failing
 * run is replayed by its seed.
 */

export const FLAKE: Flake = {
  test: "test/clock.test.ts > sleep > aborts",
  file: "test/clock.test.ts",
  rate: 0.1,
};

export const PLAYBOOK = `version: 1
stages:
  - { name: notes, brief: Write the release notes. }
  - { name: ship, brief: Ship it., gate: owner }
`;

/** The virtual spawn timeout the soak's wave runs with (its `spawn_timeout_s`). */
export const SPAWN_TIMEOUT_S = 30;
/** The virtual idle grace (its `idle_grace_s`): a stalled agent is nudged, then asked about, sooner. */
export const IDLE_GRACE_S = 30;

export interface Scenario {
  seed: number;
  tasks: string[];
  /** The task whose first implementer head the flake fails whatever the seed. */
  flaky: string;
  /** The task whose quality reviewer stalls (its first launch). */
  stalled: string;
  /** The task whose implementer fails (its first launch). */
  failed: string;
  /** The task whose spec reviewer publishes an unparseable result (its first launch, twice). */
  unparseable: string;
  /** The n-th launches (1-based, across the wave) that outlast the spawn timeout. */
  launchTimeouts: number[];
  /** The owner's MCP server drops after this many merges (and comes back a step later). */
  ownerDropAfterMerges: number;
  /** Screen reads are slow from this many merges until that many. */
  slowScreens: { from: number; to: number };
  /**
   * The tasks whose PR head takes a release-only merge (an "Update branch") while its reviewers
   * work, once the release tip has moved past the PR: their reviews take long enough for the
   * review gate's head check to see it (ci_poll_ms).
   */
  moved: string[];
}

/** How many steps the moved tasks' reviews take (past one head check, ci_poll_ms). */
export const SLOW_REVIEW_STEPS = 16;

/** The soak's task ids: T01 … Tnn. */
export const taskIds = (n: number) =>
  Array.from({ length: n }, (_, i) => `T${String(i + 1).padStart(2, "0")}`);

export function scenario(seed: number, n: number): Scenario {
  if (n < 8) throw new Error(`the soak's faults need at least 8 tasks (SOAK_TASKS=${n})`);
  const tasks = taskIds(n);
  // A seeded shuffle; the faults take distinct tasks.
  const order = [...tasks].sort((a, b) => unit(seed, a) - unit(seed, b));
  return {
    seed,
    tasks,
    flaky: order[0] as string,
    stalled: order[1] as string,
    failed: order[2] as string,
    unparseable: order[3] as string,
    launchTimeouts: [3 + Math.floor(unit(seed, "lt1") * 3), 9 + Math.floor(unit(seed, "lt2") * 4)],
    ownerDropAfterMerges: 2,
    slowScreens: { from: 1, to: 3 },
    moved: [order[4] as string, order[5] as string],
  };
}

/**
 * What each launch does (fake-agents.ts `behaviour`). `journal` is the wave's journal so far (the
 * conflict goes to the first rebase the merge queue asked for).
 */
export function behaviour(
  sc: Scenario,
  journal: () => JournalEvent[],
): (a: Omit<FleetAgent, "behaviour">) => Behaviour {
  let conflicted = false;
  return (a) => {
    if (a.nth === 1 && a.task === sc.stalled && a.role === "quality_reviewer")
      return { kind: "stall" };
    if (a.nth === 1 && a.task === sc.failed && a.role === "implementer")
      return { kind: "fail", reason: "the test runner crashed" };
    if (a.nth === 1 && a.task === sc.unparseable && a.role === "spec_reviewer")
      return { kind: "unparseable" };
    // The merge queue's first branch update hits a conflict it cannot resolve; its respawn succeeds.
    if (a.role === "rebase" && !conflicted && queuedUpdate(journal(), a.task)) {
      conflicted = true;
      return { kind: "conflict", file: `src/${a.task.toLowerCase()}.ts` };
    }
    if (a.nth === 1 && sc.moved.includes(a.task) && a.role.endsWith("_reviewer"))
      return { kind: "work", delaySteps: SLOW_REVIEW_STEPS };
    return { kind: "work" };
  };
}

/** Is `task`'s current rebase the merge queue's (queued, not a fix-landed update)? */
function queuedUpdate(j: JournalEvent[], task: string): boolean {
  const mine = j.filter((e) => e.task === task);
  const last = (pred: (e: JournalEvent) => boolean) =>
    mine.reduce((at, e, i) => (pred(e) ? i : at), -1);
  const queued = last((e) => e.type === "merge_queued");
  const dequeued = last((e) => e.type === "merge_dequeued");
  const update = last((e) => e.type === "stage_entered" && e.data.rebase === true);
  return queued > dequeued && update > queued && mine[update]?.data.fix_landed === undefined;
}

/** What the scenario has done to the world so far (asserted on). */
export interface Applied {
  moved: { task: string; from: string; to: string }[];
  ownerDropped: boolean;
  ownerBack: string | null;
  slow: boolean;
  /** Heads the flake must spare (the release-only merges: their CI is what makes them accepted). */
  green: Set<string>;
  /** The flaky task's first head. */
  flakyHead: string | null;
}

/** The per-head flake override: the flaky task's first head fails, the moved heads never do. */
export function flakyOverride(applied: Applied) {
  return (head: string) =>
    applied.green.has(head) ? false : head === applied.flakyHead ? true : undefined;
}

/** Install the scenario's host knobs and world events on a soak env. */
export function apply(sc: Scenario, env: SoakEnv, applied: Applied): void {
  const { host, world, fleet } = env;
  host.launchDelayMs = () =>
    sc.launchTimeouts.includes(host.launches.length) ? (SPAWN_TIMEOUT_S + 10) * 1000 : 0;
  const merges = () => env.journal().filter((e) => e.type === "merged_by_supervisor").length;
  env.onStep(async () => {
    // The flaky task's first head (its implementer's push) fails on the flake.
    if (applied.flakyHead === null) {
      const b = fleet.prBranch[sc.flaky];
      if (b !== undefined) applied.flakyHead = world.refs[b] ?? null;
    }
    // Slow screens for a while.
    const m = merges();
    applied.slow = m >= sc.slowScreens.from && m < sc.slowScreens.to;
    host.readScreenDelayMs = applied.slow ? 3_000 : 0;
    // The owner's MCP server drops, and comes back under a new agent id the next step.
    if (applied.ownerDropped && applied.ownerBack === null) {
      applied.ownerBack = "coord-soak-b2";
      await env.owner.reconnect(applied.ownerBack);
    } else if (!applied.ownerDropped && m >= sc.ownerDropAfterMerges) {
      applied.ownerDropped = true;
      await env.owner.drop();
    }
    // A PR under review takes a release-only merge ("Update branch") once the tip moved past it.
    for (const a of fleet.launches) {
      if (a.role !== "spec_reviewer" || a.nth !== 1 || !a.registered || a.acted) continue;
      if (!sc.moved.includes(a.task) || applied.moved.some((x) => x.task === a.task)) continue;
      {
        const branch = fleet.prBranch[a.task];
        const from = branch !== undefined ? world.refs[branch] : undefined;
        if (branch === undefined || from === undefined) continue;
        if (world.isAncestor(world.tip(), from)) continue;
        const to = world.merge(from, world.tip(), `Merge branch '${world.release}' into ${branch}`);
        applied.green.add(to);
        world.push(branch, to);
        applied.moved.push({ task: a.task, from, to });
      }
    }
  });
}
