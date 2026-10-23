import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import type { Digest } from "../../src/autopilot/digest";
import type { JournalEvent } from "../../src/types";
import { runCli } from "../helpers/run-cli";
import { type SoakEnv, WAVE, makeSoakEnv } from "../helpers/soak-env";
import {
  type Applied,
  FLAKE,
  IDLE_GRACE_S,
  PLAYBOOK,
  SPAWN_TIMEOUT_S,
  apply,
  behaviour,
  flakyOverride,
  scenario,
  slowLaunches,
} from "./scenario";

/**
 * The simulated soak (SPEC §4.6.16–§4.6.19 end to end): SOAK_TASKS tasks (default 32) through the
 * real daemon on Aedes, the fake host, the soak world and the fake fleet, with every fault of
 * scenario.ts injected. It must finish unattended: the only questions left for a person are the
 * owner-gated stage's `stage_go` and the final `release_go`. A failing run prints the journal
 * tail and the open decisions; SOAK_SEED replays it.
 */

const TASKS = Number(process.env.SOAK_TASKS ?? 32);
const SEED = Number(process.env.SOAK_SEED ?? 1);
/** The run's wall-clock budget. */
const BUDGET_MS = 20 * 60_000;
/** Steps per task before the soak gives up (each step is 5 s of the wave's clock). */
const STEPS_PER_TASK = 60;
/** The screen publisher's slow-read bound (ms of the fake clock). */
const SCREEN_SLOW_MS = 2_000;

const applied: Applied = {
  moved: [],
  ownerDropped: false,
  ownerBack: null,
  slow: false,
  green: new Set(),
  flakyHead: null,
};

let s: SoakEnv | undefined;
afterAll(async () => {
  await s?.cleanup();
});

/** A failed run: the journal tail and the open decisions (and SOAK_DUMP=<file>: the whole journal). */
function explain(env: SoakEnv): void {
  console.log(env.report(120));
  const dump = process.env.SOAK_DUMP;
  if (dump !== undefined)
    writeFileSync(
      dump,
      env
        .journal()
        .map((e) => JSON.stringify(e))
        .join("\n"),
    );
}

const of = (j: JournalEvent[], type: string) => j.filter((e) => e.type === type);

// Only under vitest.soak.config.ts (`bun run test:soak`, which sets VOLLEYD_SOAK): `bun test`
// (the bun-runner CI job) collects every *.test.ts, and the soak is not a 15 s unit test.
describe.skipIf(process.env.VOLLEYD_SOAK !== "1")(`the soak (${TASKS} tasks, seed ${SEED})`, () => {
  it(
    "finishes unattended: everything merged, the flake fixed, only stage_go and release_go asked",
    // Above the budget: the soak's own deadline throws first, so a slow run still explains itself.
    { timeout: BUDGET_MS + 2 * 60_000 },
    async () => {
      // real process: the soak's own budget is wall time, the whole run.
      const started = Date.now();
      // Here, not at module load: a skipped soak never builds a scenario (SOAK_TASKS < 8 throws).
      const sc = scenario(SEED, TASKS);
      try {
        s = await makeSoakEnv({
          tasks: sc.tasks,
          seed: SEED,
          flake: FLAKE,
          flaky: (head) => flakyOverride(applied)(head),
          behaviour: behaviour(sc, () => s?.journal() ?? []),
          playbook: PLAYBOOK,
          config: `spawn_timeout_s: ${SPAWN_TIMEOUT_S}, idle_grace_s: ${IDLE_GRACE_S}`,
          screenSlowMs: SCREEN_SLOW_MS,
          deadline: started + BUDGET_MS,
          prepare: (host) => slowLaunches(sc, host),
        });
        const env = s;
        apply(sc, env, applied);
        const opened = (kind: string) =>
          of(env.journal(), "decision_opened").find((e) => e.data.kind === kind);
        const budget = TASKS * STEPS_PER_TASK;

        await env.until(() => opened("stage_go") !== undefined, "stage_go", budget);
        expect(env.daemon.snapshot(WAVE)?.status).toBe("releasing");
        await env.resolve(opened("stage_go")?.data.decision_id as string, "go");
        await env.until(() => opened("release_go") !== undefined, "release_go", 200);

        const j = env.journal();
        const state = env.daemon.snapshot(WAVE);
        const tasks = state?.tasks ?? [];
        const real = tasks.filter((t) => t.synthetic !== true);
        const fixers = tasks.filter((t) => t.synthetic === true && t.remediation !== undefined);
        const trains = tasks.filter((t) => t.synthetic === true && t.train !== undefined);
        expect(real.map((t) => t.id)).toEqual(sc.tasks);

        // Every task merged by the supervisor, and the fixer too.
        const merged = new Set(of(j, "merged_by_supervisor").map((e) => e.task));
        for (const t of real) {
          expect(t.stage, t.id).toBe("done");
          expect(merged.has(t.id), `${t.id} merged_by_supervisor`).toBe(true);
        }
        expect(fixers).toHaveLength(1);
        const fixer = fixers[0]?.id as string;
        expect(merged.has(fixer)).toBe(true);
        expect(env.world.fixedBy()).not.toBeNull();

        // Merge trains formed and merged (SPEC §4.6.23): each with its members done via the train.
        const trainMerged = of(j, "train_merged");
        expect(trainMerged.length, "a merge train merged").toBeGreaterThanOrEqual(1);
        for (const e of trainMerged) {
          expect(trains.find((t) => t.id === e.data.train)?.stage).toBe("done");
          for (const m of e.data.tasks as string[])
            expect(
              of(j, "merged_by_supervisor").some(
                (x) => x.task === m && x.data.via === "train" && x.data.train_pr === e.data.pr,
              ),
              `${m} merged via ${e.data.train}`,
            ).toBe(true);
        }

        // The fix released every task the flake blocked.
        const blocked = new Set(
          of(j, "remediation_requested").flatMap((e) => [e.data.for as string]),
        );
        expect(blocked.size).toBeGreaterThan(0);
        const closed = of(j, "remediation_closed");
        expect(closed).toHaveLength(1);
        expect(closed[0]?.data).toMatchObject({ outcome: "landed", task: fixer });
        expect(new Set(closed[0]?.data.released as string[])).toEqual(blocked);

        // Nobody was asked anything but the owner-only stage_go and release_go.
        const kindOf = new Map(
          of(j, "decision_opened").map((e) => [e.data.decision_id, e.data.kind]),
        );
        expect(
          of(j, "decision_escalated").map((e) => [kindOf.get(e.data.decision_id), e.data.why]),
        ).toEqual([
          ["stage_go", "owner_only"],
          ["release_go", "owner_only"],
        ]);

        // Every fault happened.
        const spawned = of(j, "agent_spawned");
        const ids = spawned.map((e) => e.data.agent_id);
        expect(new Set(ids).size, "no agent id spawned twice (#193)").toBe(ids.length);
        expect(of(j, "spawn_adopted").length, "two launch timeouts adopted").toBeGreaterThanOrEqual(
          2,
        );
        expect(applied.moved).toHaveLength(sc.moved);
        const accepted = of(j, "decision_auto_resolved").filter(
          (e) => e.data.policy === "pr_head_moved/accept",
        );
        expect(new Set(accepted.map((e) => e.task))).toEqual(
          new Set(applied.moved.map((m) => m.task)),
        );
        expect(of(j, "pr_head_moved").map((e) => e.task)).toEqual(
          expect.arrayContaining(applied.moved.map((m) => m.task)),
        );
        expect(of(j, "owner_reconnected")).toHaveLength(1);
        for (const [task, role] of [
          [sc.stalled, "quality_reviewer"],
          [sc.failed, "implementer"],
          [sc.unparseable, "spec_reviewer"],
        ])
          expect(
            spawned.filter((e) => e.task === task && e.data.role === role).length,
            `${task} ${role} respawned`,
          ).toBe(2);
        expect(env.fleet.launches.filter((a) => a.behaviour.kind === "conflict")).toHaveLength(1);

        // Gated at the reviewed head (#383): before a task first queues, a branch update is only
        // for a CONFLICTING PR or a landed flake fix; a merely behind task waits for its turn.
        for (const t of [...real, ...fixers]) {
          const mine = j.filter((e) => e.task === t.id);
          const queuedAt = mine.findIndex((e) => e.type === "merge_queued");
          const early = mine
            .slice(0, queuedAt < 0 ? mine.length : queuedAt)
            .filter((e) => e.type === "stage_entered" && e.data.rebase === true)
            .filter((e) => e.data.conflicting !== true && e.data.fix_landed === undefined);
          expect(
            early.map((e) => e.seq),
            `${t.id}: updated before it queued`,
          ).toEqual([]);
        }
        expect(
          env.host.screenReads.filter((r) => (r.delayMs ?? 0) > SCREEN_SLOW_MS).length,
          "screen reads over screen_slow_ms",
        ).toBeGreaterThan(0);

        // No retired agent's workspace stays open (#194).
        for (const e of of(j, "agent_retired")) {
          const ws = e.data.workspace as string | undefined;
          if (ws !== undefined) expect(env.host.closed, `${e.data.agent_id}'s ${ws}`).toContain(ws);
        }

        // `volleyd status` and the digest agree.
        const digest = (await env.control.request("digest", { wave: WAVE })).result as Digest;
        expect(digest.shipped.filter((x) => x.task !== fixer)).toHaveLength(TASKS);
        expect(digest.auto.flakes_fixed).toHaveLength(1);
        expect(digest.auto.flakes_fixed[0]).toMatchObject({ test: FLAKE.test, fixer });
        const status = await runCli(["status", WAVE], env.env.env);
        expect(status.exitCode).toBe(0);
        const rows = [
          ...status.stdout.matchAll(/^ {2}(\S+)\s+(?:#\d+\s+)?(\w+)\s.*PR #(\d+)\s*$/gm),
        ];
        const listed = new Map(rows.map((m) => [m[1], { stage: m[2], pr: Number(m[3]) }]));
        for (const x of digest.shipped)
          expect(listed.get(x.task), `status row of ${x.task}`).toEqual({
            stage: "done",
            pr: x.pr.number,
          });
        // A merge train is a row of its own (its PR), and ships nothing itself.
        for (const t of trains)
          expect(listed.get(t.id)?.stage, `status row of ${t.id}`).toBe("done");
        expect(listed.size).toBe(digest.shipped.length + trains.length);
        expect(status.stdout).toContain(
          `autopilot: on · ${digest.auto.decisions_resolved} auto-resolved`,
        );
        // real process: the soak's own budget is wall time, the whole run.
        expect(Date.now() - started).toBeLessThan(BUDGET_MS);
      } catch (e) {
        if (s !== undefined) explain(s);
        throw e;
      }
    },
  );
});
