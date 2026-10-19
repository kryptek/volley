import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli";
import {
  ARTIFACTS_OK,
  PR_HEAD,
  type SupervisedEnv,
  makeSupervisedEnv,
} from "./helpers/supervised-env";

/**
 * `volleyd merged <wave> <task> --sha <sha>`: the owner says a gated PR landed outside GitHub's
 * merge button. volleyd checks it first (read-only git through the fence): the sha is on the
 * release branch and carries the gated head (as an ancestor, as equivalent patches, or as one
 * squashed patch). Then `merged_by_operator`, and the task proceeds; anything else is refused.
 */

const SHA = "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";
const RELEASE = "origin/release/w1";

describe("volleyd merged", () => {
  let s: SupervisedEnv;
  /** Answers of the git probes the verb runs, by what they ask. */
  let onBranch: boolean;
  let headInSha: boolean;
  let cherry: string;
  let patches: { squash: string; head: string };

  beforeEach(async () => {
    onBranch = true;
    headInSha = true;
    cherry = "";
    patches = { squash: "", head: "" };
    s = await makeSupervisedEnv({ exec: ARTIFACTS_OK });
    s.host.fake.on(["git"], (argv) => {
      const [verb, ...rest] = argv.slice(3);
      if (verb === "merge-base" && rest[0] === "--is-ancestor") {
        if (rest[1] === SHA && rest[2] === RELEASE) return { code: onBranch ? 0 : 1 };
        if (rest[1] === PR_HEAD && rest[2] === SHA) return { code: headInSha ? 0 : 1 };
        return { code: 1 };
      }
      if (verb === "log" && rest.includes("--cherry-pick")) return { stdout: cherry };
      if (verb === "show") return { stdout: patches.squash };
      if (verb === "diff" && rest.length === 2) return { stdout: patches.head };
      if (argv.includes("--show-toplevel")) return { stdout: `${argv[2]}\n` };
      return { stdout: `${PR_HEAD}\n` };
    });
    // The implementer's done verifies; [implement] goes straight to the gate.
    await s.status("done");
    await s.event((e) => e.type === "stage_entered" && e.data.stage === "merge_ready");
    await s.settled();
    expect((await runCli(["claim", "w1", "--by", "coord-1"], s.env.env)).exitCode).toBe(0);
  });
  afterEach(async () => s.cleanup());

  const merged = (by: string, sha = SHA) =>
    runCli(["merged", "w1", "T1", "--sha", sha, "--by", by], s.env.env);

  it("the owner, a sha on the release branch that contains the gated head → merged_by_operator, done", async () => {
    const r = await merged("coord-1");
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toContain("T1");
    const ev = await s.event("merged_by_operator");
    expect(ev.data).toMatchObject({ by: "coord-1", sha: SHA, head: PR_HEAD, how: "ancestor" });
    await s.event((e) => e.type === "stage_entered" && e.data.stage === "done");
    const verified = s
      .journal()
      .find((e) => e.type === "artifact_verified" && e.data.role === "merged");
    expect(verified?.data).toMatchObject({ via: "operator", sha: SHA, by: "coord-1" });
  });

  it("a squash commit whose patch is the PR's whole diff counts", async () => {
    headInSha = false;
    cherry = `>${PR_HEAD}\n`;
    const diff = "diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
    patches = { squash: diff.replace("index 1..2", "index 9..8"), head: diff };
    const r = await merged("coord-1");
    expect(r.exitCode, r.stderr).toBe(0);
    expect((await s.event("merged_by_operator")).data).toMatchObject({ how: "squash" });
  });

  it("a sha not on the release branch is refused", async () => {
    onBranch = false;
    const r = await merged("coord-1");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(`not on ${RELEASE}`);
    expect(s.journal().some((e) => e.type === "merged_by_operator")).toBe(false);
  });

  it("a sha on the branch without the head's patch is refused", async () => {
    headInSha = false;
    cherry = `>${PR_HEAD}\n`;
    patches = { squash: "diff --git a/y b/y\n+other\n", head: "diff --git a/x b/x\n+b\n" };
    const r = await merged("coord-1");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("does not contain");
    expect(s.journal().some((e) => e.type === "merged_by_operator")).toBe(false);
  });

  it("anyone but the owner is refused", async () => {
    const r = await merged("intruder");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("owned by coord-1");
    expect(s.journal().some((e) => e.type === "merged_by_operator")).toBe(false);
  });

  it("a malformed sha is a usage error", async () => {
    const r = await runCli(["merged", "w1", "T1", "--sha", "not-a-sha"], s.env.env);
    expect(r.exitCode).toBe(2);
  });
});
