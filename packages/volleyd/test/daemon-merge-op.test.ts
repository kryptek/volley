import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli";
import {
  ARTIFACTS_OK,
  PR_HEAD,
  type SupervisedEnv,
  type SupervisedEnvOptions,
  makeSupervisedEnv,
} from "./helpers/supervised-env";

/**
 * `volleyd merge <wave> <task>` (A6, SPEC §4.6.17): the owner merges one gated task now, through
 * the same fenced verb the merge queue uses — under `merge: manual` too, where nothing else
 * merges. Owner only; the task must be at merge_ready.
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

async function gatedManual() {
  s = await makeSupervisedEnv({ merge: "manual", exec: replies() });
  await s.status("done");
  await s.event((e) => e.type === "stage_entered" && e.data.stage === "merge_ready");
  await s.settled();
  expect((await runCli(["claim", "w1", "--by", "coord-1"], s.env.env)).exitCode).toBe(0);
}

const merge = (by: string, task = "T1") =>
  runCli(["merge", "w1", task, "--by", by], (s as SupervisedEnv).env.env);

describe("volleyd merge", () => {
  it("by a non-owner is refused, naming the owner", async () => {
    await gatedManual();
    const r = await merge("someone-else");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("owned by coord-1");
    expect(s?.host.fake.argvs(["gh", "pr", "merge"])).toEqual([]);
  });

  it("by the owner at merge_ready merges the gated head: merged_by_supervisor, merge_sha in the answer", async () => {
    await gatedManual();
    const r = await merge("coord-1");
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain(MERGED);
    expect(s?.host.fake.argvs(["gh", "pr", "merge"])).toEqual([
      ["gh", "pr", "merge", "7", "--squash", "--match-head-commit", HEAD],
    ]);
    const ev = await (s as SupervisedEnv).event("merged_by_supervisor");
    expect(ev.data).toMatchObject({
      task: "T1",
      head: HEAD,
      merge_sha: MERGED,
      requested_by: "coord-1",
    });
    await (s as SupervisedEnv).event((e) => e.type === "stage_entered" && e.data.stage === "done");
  });

  it("a task that is not merge_ready is refused", async () => {
    s = await makeSupervisedEnv({ merge: "manual", exec: replies() });
    expect((await runCli(["claim", "w1", "--by", "coord-1"], s.env.env)).exitCode).toBe(0);
    const r = await merge("coord-1");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("task 'T1' is not merge_ready");
  });

  it("an unknown task is refused", async () => {
    await gatedManual();
    const r = await merge("coord-1", "T9");
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("unknown task 'T9'");
  });
});
