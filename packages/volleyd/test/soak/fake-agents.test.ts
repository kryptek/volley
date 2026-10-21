import { afterEach, describe, expect, it } from "vitest";
import { type SoakEnv, WAVE, makeSoakEnv } from "../helpers/soak-env";

/**
 * The fake fleet on the real daemon, one task (a 1-task soak): every role it plays — implementer,
 * both reviewers, fixup, rebase, release — drives the task from launch to `release_go`.
 */

const PLAYBOOK = `version: 1
stages:
  - { name: notes, brief: Write the release notes. }
  - { name: ship, brief: Ship it., gate: owner }
`;

let s: SoakEnv | undefined;
afterEach(async () => {
  await s?.cleanup();
  s = undefined;
});

const of = (env: SoakEnv, type: string) => env.journal().filter((e) => e.type === type);
const decision = (env: SoakEnv, kind: string) =>
  of(env, "decision_opened").find((e) => e.data.kind === kind);

describe("the fake fleet (one task)", () => {
  it(
    "implements, is reviewed with a finding, fixed up, rebased after a tip move, merged and released",
    { timeout: 120_000 },
    async () => {
      s = await makeSoakEnv({
        tasks: ["T1"],
        playbook: PLAYBOOK,
        behaviour: (a) =>
          a.role === "spec_reviewer" && a.nth === 1
            ? {
                kind: "work",
                findings: [{ severity: "P1", file: "src/t1.ts", text: "missing a case" }],
              }
            : { kind: "work" },
      });
      const env = s;
      const t1 = () => env.daemon.snapshot(WAVE)?.tasks.find((t) => t.id === "T1");
      // While the fixup works, another PR merges: T1's branch is behind the release tip.
      await env.until(
        () => env.fleet.launches.some((a) => a.role === "fixup"),
        "the fixup's launch",
      );
      const moved = env.world.pushRelease({ "docs/other.md": "o1" }, "docs: another change (#99)");
      await env.until(() => t1()?.stage === "done", "T1 done");
      const roles = env.fleet.launches.map((a) => a.role);
      expect(roles).toEqual(
        expect.arrayContaining([
          "implementer",
          "spec_reviewer",
          "quality_reviewer",
          "fixup",
          "rebase",
        ]),
      );
      // The merged head is the rebased one: on the moved tip, with the fixup's change.
      const merged = of(env, "merged_by_supervisor")[0];
      expect(merged?.task).toBe("T1");
      const head = merged?.data.head as string;
      expect(env.world.isAncestor(moved, head)).toBe(true);
      expect(env.world.get(env.world.tip()).files["src/t1.ts"]).toBe("T1-fixup-1");

      // The release train: notes, then ship waits on the owner's stage_go, then release_go.
      await env.until(() => decision(env, "stage_go") !== undefined, "stage_go");
      expect(env.fleet.launches.filter((a) => a.role === "release").map((a) => a.stage)).toEqual([
        "notes",
      ]);
      await env.resolve(decision(env, "stage_go")?.data.decision_id as string, "go");
      await env.until(() => decision(env, "release_go") !== undefined, "release_go");
      expect(env.fleet.launches.filter((a) => a.role === "release").map((a) => a.stage)).toEqual([
        "notes",
        "ship",
      ]);
      expect(env.daemon.snapshot(WAVE)?.status).toBe("releasing");
      // Every escalation was the owner's by rule.
      expect(of(env, "decision_escalated").map((e) => e.data.why)).toEqual([
        "owner_only",
        "owner_only",
      ]);
    },
  );
});

describe("the soak env's wall-clock budget", () => {
  it("until() past the deadline throws with the report, before vitest's timeout can", async () => {
    s = await makeSoakEnv({ tasks: ["T1"], deadline: Date.now() });
    await expect(s.until(() => false, "never", 1_000)).rejects.toThrow(
      /soak: never not reached within the wall-clock budget[\s\S]*journal tail/,
    );
    expect(s.steps()).toBe(0);
  });
});
