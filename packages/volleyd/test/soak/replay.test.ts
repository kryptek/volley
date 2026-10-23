import { readFileSync } from "node:fs";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { type Tree, footprintOf } from "../../src/footprint";
import { type PlanTask, planWave } from "../../src/overlap-plan";
import type { JournalEvent } from "../../src/types";
import { type SoakEnv, type SoakTask, WAVE, makeSoakEnv } from "../helpers/soak-env";
import { stubEnv } from "../helpers/with-env";

/**
 * The replay soak: the dogfood batch (the 26 issues of test/fixtures/replay/, their Files lists
 * resolved against the tree) through the real daemon on the fake clock, twice, with no injected
 * faults — the baseline (one task per issue, no `after`, no merge train, every behind task updated
 * before its gate as before #383) and the epic (the overlap planner's wave: bundles, chains and
 * cluster caps, the merge train on). It measures branch-update and merge rounds from each journal
 * and asserts the epic's targets against the baseline. Opt-in: `REPLAY=1 bun run test:soak --
 * replay` (it prints the table on every run); SOAK_SEED replays a run. The epic test reads the
 * baseline's metrics, so it runs after the baseline in this file: `-t epic` alone fails by design.
 */

const SEED = Number(process.env.SOAK_SEED ?? 1);
/** Each wave's wall-clock budget. */
const BUDGET_MS = 12 * 60_000;
/** Steps per issue before a wave gives up (each step is 5 s of the wave's clock). */
const STEPS_PER_ISSUE = 60;

const read = (f: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/replay/${f}`, import.meta.url), "utf8"));
const issues = read("dogfood-26.json") as { id: string; issue: number; files: string[] }[];
const tree = read("tree.json") as Tree;

/** Each issue as a task with its resolved footprint. */
const resolved = (): PlanTask[] =>
  issues.map((i) => {
    const fp = footprintOf(`## Files\n\n${i.files.map((f) => `- \`${f}\``).join("\n")}\n`, tree);
    return {
      id: i.id,
      issue: i.issue,
      files: fp.files,
      footprint: { confidence: fp.confidence },
      after: [],
    };
  });

export interface ReplayMetrics {
  /** Branch updates (`stage_entered { rebase: true }`) plus merge-train integrator spawns. */
  update_rounds: number;
  /** Merges to the release branch: single PRs (`merged_by_supervisor` not via a train) and trains. */
  merge_rounds: number;
  /** `spawn_budget_exhausted` decisions opened while the held spawn was churn. */
  churn_budget_decisions: number;
  spawns: number;
}

const of = (j: JournalEvent[], type: string) => j.filter((e) => e.type === type);

/** A held spawn is churn: a branch update or a train's role, or a re-review step's. */
function heldChurn(j: JournalEvent[], at: number, d: JournalEvent): boolean {
  const role = d.data.role as string | undefined;
  if (role === "rebase" || role === "integrator") return true;
  if (d.task == null) return false;
  const step = j
    .slice(0, at)
    .reverse()
    .find((e) => e.type === "stage_entered" && e.task === d.task);
  return step?.data.rebase === true || step?.data.cause !== undefined;
}

export function metricsOf(j: JournalEvent[]): ReplayMetrics {
  return {
    update_rounds:
      of(j, "stage_entered").filter((e) => e.data.rebase === true).length +
      of(j, "agent_spawned").filter((e) => e.data.role === "integrator").length,
    merge_rounds:
      of(j, "merged_by_supervisor").filter((e) => e.data.via !== "train").length +
      of(j, "train_merged").length,
    churn_budget_decisions: j.filter(
      (e, k) =>
        e.type === "decision_opened" &&
        e.data.kind === "spawn_budget_exhausted" &&
        heldChurn(j, k, e),
    ).length,
    spawns: of(j, "agent_spawned").length,
  };
}

const runs: {
  baseline?: ReplayMetrics & { tasks: number };
  epic?: ReplayMetrics & { tasks: number };
} = {};

function table(): string {
  const keys = [
    "tasks",
    "update_rounds",
    "merge_rounds",
    "churn_budget_decisions",
    "spawns",
  ] as const;
  const cell = (r: (ReplayMetrics & { tasks: number }) | undefined, k: (typeof keys)[number]) =>
    String(r?.[k] ?? "-").padStart(8);
  return [
    `replay (seed ${SEED})          baseline     epic`,
    ...keys.map((k) => `  ${k.padEnd(24)}${cell(runs.baseline, k)} ${cell(runs.epic, k)}`),
  ].join("\n");
}

let s: SoakEnv | undefined;
afterEach(async () => {
  await s?.cleanup();
  s = undefined;
});
afterAll(() => {
  console.log(table());
});

/** Run the wave to `wave_complete`; its metrics, and every real task's stage. */
async function replay(tasks: SoakTask[], config?: string) {
  const started = Date.now();
  s = await makeSoakEnv({
    tasks,
    tree,
    seed: SEED,
    deadline: started + BUDGET_MS,
    ...(config !== undefined ? { config } : {}),
  });
  const env = s;
  try {
    await env.until(
      () => env.journal().some((e) => e.type === "wave_complete"),
      "wave_complete",
      issues.length * STEPS_PER_ISSUE,
    );
  } catch (e) {
    console.log(env.report(80));
    throw e;
  }
  const j = env.journal();
  const real = (env.daemon.snapshot(WAVE)?.tasks ?? []).filter((t) => t.synthetic !== true);
  return { m: { ...metricsOf(j), tasks: tasks.length }, real };
}

// Only under vitest.soak.config.ts with REPLAY=1: the 8-task soak step does not run it.
describe.skipIf(process.env.VOLLEYD_SOAK !== "1" || process.env.REPLAY !== "1")(
  `the replay soak (dogfood-26, seed ${SEED})`,
  () => {
    it(
      "baseline: 26 tasks one per issue, no train, updated before the gate",
      { timeout: BUDGET_MS + 60_000 },
      async () => {
        const restore = stubEnv({ VOLLEYD_REPLAY_BASELINE: "1" });
        try {
          const tasks = resolved().map((t) => ({ id: t.id, issue: t.issue, files: t.files }));
          const { m, real } = await replay(tasks, "autopilot: { merge_train: false }");
          runs.baseline = m;
          expect(real).toHaveLength(26);
          for (const t of real) expect(t.stage, t.id).toBe("done");
        } finally {
          restore();
        }
      },
    );

    it(
      "epic: the planner's wave, the train on — the targets against the baseline",
      { timeout: BUDGET_MS + 60_000 },
      async () => {
        const plan = planWave({ tasks: resolved(), tree });
        expect(plan.tasks.length, "the planner's task count").toBeLessThanOrEqual(16);
        const tasks: SoakTask[] = plan.tasks.map((t) => ({
          id: t.id,
          issue: t.issue,
          ...(t.issues.length > 1 ? { issues: t.issues } : {}),
          files: t.files,
          after: t.after,
          footprint: t.footprint,
          plan: t.plan,
        }));
        const { m, real } = await replay(tasks);
        runs.epic = m;
        expect(real.map((t) => t.id).sort()).toEqual(tasks.map((t) => t.id).sort());
        for (const t of real) expect(t.stage, t.id).toBe("done");

        const base = runs.baseline;
        expect(base, "the baseline ran first").toBeDefined();
        if (base === undefined) return;
        console.log(table());
        expect(m.update_rounds, "update_rounds ≤ 0.3 × baseline").toBeLessThanOrEqual(
          0.3 * base.update_rounds,
        );
        expect(m.merge_rounds, "merge_rounds ≤ 0.5 × baseline").toBeLessThanOrEqual(
          0.5 * base.merge_rounds,
        );
        expect(m.churn_budget_decisions).toBe(0);
      },
    );
  },
);
