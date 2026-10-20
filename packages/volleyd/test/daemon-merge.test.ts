import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  ARTIFACTS_OK,
  PR_HEAD,
  type SupervisedEnv,
  type SupervisedEnvOptions,
  makeSupervisedEnv,
} from "./helpers/supervised-env";

/**
 * The daemon wires autopilot merging (SPEC §4.6.16): a wave file without `merge:` takes the
 * `autopilot.merge` tunable (default auto), and the merge runs through the real fence (the fake
 * exec checks every argv with its options, so the gate's MergeToken must reach it).
 */

const HEAD = "abc1230000000000000000000000000000000001";
const MERGED = "e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1";

/** ARTIFACTS_OK at a full-length head (a MergeToken names a 40-hex head). */
const replies = (): NonNullable<SupervisedEnvOptions["exec"]> => [
  ...ARTIFACTS_OK.map(([prefix, reply]) => {
    if (typeof reply === "function")
      return [
        prefix,
        (argv: string[], opts: Parameters<typeof reply>[1]) => {
          const r = reply(argv, opts) as { stdout?: string };
          return {
            ...r,
            ...(r.stdout !== undefined ? { stdout: r.stdout.replace(PR_HEAD, HEAD) } : {}),
          };
        },
      ] as [string[], typeof reply];
    const r = reply as { stdout?: string };
    return [
      prefix,
      { ...r, ...(r.stdout !== undefined ? { stdout: r.stdout.replaceAll(PR_HEAD, HEAD) } : {}) },
    ] as [string[], typeof reply];
  }),
  [
    ["gh", "pr", "view"],
    (argv: string[]) => ({
      stdout: JSON.stringify(
        merged
          ? {
              state: "MERGED",
              headRefOid: HEAD,
              mergeCommit: { oid: MERGED },
              baseRefName: "release/w1",
            }
          : argv.includes("mergeCommit,state")
            ? { state: "OPEN", mergeCommit: null }
            : { state: "OPEN", headRefOid: HEAD, baseRefName: "release/w1" },
      ),
    }),
  ],
  [
    ["gh", "pr", "merge"],
    () => {
      merged = true;
      return {};
    },
  ],
];

let merged = false;
let s: SupervisedEnv | undefined;
afterEach(async () => {
  merged = false;
  await s?.cleanup();
  s = undefined;
});

describe("daemon: autopilot merging", () => {
  it("a one-task wave without merge: is merged by volleyd at the gated head (autopilot.merge default auto)", async () => {
    s = await makeSupervisedEnv({ merge: null, exec: replies() });
    await s.status("done");
    await s.event("merged_by_supervisor");
    await s.event((e) => e.type === "stage_entered" && e.data.stage === "done");
    await s.settled();
    expect(s.host.fake.argvs(["gh", "pr", "merge"])).toEqual([
      ["gh", "pr", "merge", "7", "--squash", "--match-head-commit", HEAD],
    ]);
    const gate = s.journal().find((e) => e.type === "artifact_verified" && e.data.role === "gate");
    expect(readFileSync(gate?.data.evidence_path as string, "utf-8")).toContain(
      "volleyd merges this PR itself (merge: auto)",
    );
    expect(
      s.journal().find((e) => e.type === "artifact_verified" && e.data.role === "merged")?.data,
    ).toMatchObject({ via: "supervisor", merge_sha: MERGED });
  });

  it("merge: manual in the wave file: no merge, the task waits at the gate", async () => {
    s = await makeSupervisedEnv({ merge: "manual", exec: replies() });
    await s.status("done");
    await s.event((e) => e.type === "stage_entered" && e.data.stage === "merge_ready");
    await s.settled();
    expect(s.host.fake.argvs(["gh", "pr", "merge"])).toEqual([]);
  });
});
