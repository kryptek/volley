import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURES } from "./helpers/fake-host";
import { type Harness, pipelineHarness, sha } from "./helpers/pipeline-harness";

/**
 * volleyd never pushes or re-runs CI, and merges only under autopilot merging (`merge: auto`,
 * SPEC §4.6.16): exactly `gh pr merge <n> --squash --match-head-commit <gated head>`, built only
 * by src/autopilot/merge.ts. The fence (T3) denies everything else at exec time; this holds the
 * pipeline to it statically (no other source builds such an argv) and dynamically (a fake exec
 * WITHOUT the fence, that would happily run anything, sees only that one merge, and only under
 * `merge: auto`).
 */

const SRC = new URL("../src/", import.meta.url).pathname;
/** The one module that may build `gh pr merge` (and nothing else forbidden). */
const MERGE_MODULE = join(SRC, "autopilot", "merge.ts");
const FORBIDDEN = ["merge", "push", "rebase", "rerun", "workflow"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? sourceFiles(join(dir, d.name))
      : d.name.endsWith(".ts")
        ? [join(dir, d.name)]
        : [],
  );
}

/** The verbs of every argv a source file builds: `["git", …]`/`["gh", …]` literals and `git("…")` helpers. */
function argvWords(text: string): string[][] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const out: string[][] = [];
  for (const m of code.matchAll(/\[\s*"(?:git|gh)"[^\]]*\]/g)) {
    out.push([...m[0].matchAll(/"([^"]*)"/g)].map((x) => x[1] as string));
  }
  for (const m of code.matchAll(/\bgit\(\s*"([^"]+)"/g)) out.push(["git", m[1] as string]);
  return out;
}

const result = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, "review-results", `${name}.json`), "utf-8"));

let h: Harness;
afterEach(() => h?.cleanup());

/** Every argv but `gh pr merge` that a merge, push, rebase, re-run or workflow run would be. */
const forbidden = (argv: readonly string[]) =>
  (argv[0] === "gh" &&
    ((argv.includes("merge") && !(argv[1] === "pr" && argv[2] === "merge")) ||
      argv.includes("rerun") ||
      (argv[1] === "workflow" && argv[2] === "run"))) ||
  (argv[0] === "git" && argv.some((w) => w === "merge" || w === "push" || w === "rebase"));

const prMerges = (calls: readonly string[][]) =>
  calls.filter((a) => a[0] === "gh" && a[1] === "pr" && a[2] === "merge");

/** A full pipeline (reviews, a fixup, a rebase, the re-review) to the gate at H3; returns H3. */
async function fullPipeline(merge?: "auto" | "manual"): Promise<string> {
  h = pipelineHarness({ fence: false, ...(merge !== undefined ? { merge } : {}) });
  const H1 = sha(1);
  const H2 = sha(2);
  const H3 = sha(3);
  await h.start();
  h.openPr(H1);
  await h.finish("implementer", { head: H1, ci: "green" });
  await h.finish("spec_reviewer", { result: result("spec-p1") });
  await h.finish("quality_reviewer", { result: result("quality-p1-elsewhere") });
  h.world.mergeBase[H2] = sha(0xdead); // the release branch moved: a rebase runs too
  await h.finish("fixup", { head: H2, ci: "green", result: result("fixup-resolved") });
  h.world.diffNames[`${H2}..${H3}`] = ["src/api.ts"];
  await h.finish("rebase", { head: H3, ci: "green" });
  await h.finish("spec_reviewer", { result: result("approve-empty") });
  return H3;
}

describe("volleyd merges only behind the fence", () => {
  it("no source but the fence and src/autopilot/merge.ts builds a merge, push or workflow-run argv", () => {
    const offenders: string[] = [];
    let seen = 0;
    let merges = 0;
    for (const file of sourceFiles(SRC)) {
      // The fence names these verbs in order to deny them.
      if (file.endsWith("/fence.ts")) continue;
      for (const argv of argvWords(readFileSync(file, "utf-8"))) {
        seen++;
        const prMerge = argv[0] === "gh" && argv[1] === "pr" && argv[2] === "merge";
        if (file === MERGE_MODULE && prMerge) {
          merges++;
          // Even there: squash at a matched head only, never --admin / --auto / another strategy
          // (the PR number and head are variables between these literals).
          expect(argv).toEqual([
            "gh",
            "pr",
            "merge",
            "--squash",
            "--match-head-commit",
            "--delete-branch",
          ]);
          continue;
        }
        if (argv.some((w) => FORBIDDEN.includes(w))) offenders.push(`${file}: ${argv.join(" ")}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(merges).toBe(1); // the exemption is used, by exactly one argv
    expect(seen).toBeGreaterThan(10); // the scan really sees the argvs (artifacts, worktree, …)
    const merge = readFileSync(MERGE_MODULE, "utf-8");
    expect(merge).toContain('"--squash",\n    "--match-head-commit",');
    for (const flag of ["--admin", "--auto", '"--merge"', '"--rebase"'])
      expect(merge.replace(/\/\*[\s\S]*?\*\//g, "")).not.toContain(flag);
  });

  it("the grep catches a forbidden argv (self-test)", () => {
    expect(argvWords('exec(["gh", "pr", "merge", "7"])')).toEqual([["gh", "pr", "merge", "7"]]);
    expect(argvWords('git("push", "origin")')).toEqual([["git", "push"]]);
  });

  it("merge: manual — an unfenced exec that would accept anything is never asked to merge, push or re-run CI across a full pipeline", async () => {
    await fullPipeline("manual");
    expect(h.task()?.stage).toBe("merge_ready");
    h.world.prState[7] = "MERGED";
    h.elapse(60 * 60 * 1000);
    await h.tick();
    expect(h.task()?.stage).toBe("done");

    expect(h.calls.length).toBeGreaterThan(20);
    expect(prMerges(h.calls)).toEqual([]);
    expect(h.calls.filter(forbidden)).toEqual([]);
  });

  it("merge: auto — the same pipeline merges exactly once, exactly the gated head, and nothing else", async () => {
    const H3 = await fullPipeline("auto");
    expect(h.task()?.stage).toBe("done");
    h.elapse(60 * 60 * 1000);
    await h.tick();
    expect(h.calls.length).toBeGreaterThan(20);
    expect(prMerges(h.calls)).toEqual([
      ["gh", "pr", "merge", "7", "--squash", "--match-head-commit", H3],
    ]);
    expect(h.calls.filter(forbidden)).toEqual([]);
    expect(h.events.find((e) => e.type === "merged_by_supervisor")?.data).toMatchObject({
      head: H3,
      by: "volleyd",
    });
  });
});
