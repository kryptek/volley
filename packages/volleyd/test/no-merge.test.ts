import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURES } from "./helpers/fake-host";
import { type Harness, pipelineHarness, sha } from "./helpers/pipeline-harness";

/**
 * volleyd never merges, pushes or re-runs CI. The fence (T3) denies those verbs at exec time;
 * this holds the pipeline to it statically (no source builds such an argv) and dynamically (a
 * fake exec WITHOUT the fence, that would happily run anything, never sees one).
 */

const SRC = new URL("../src/", import.meta.url).pathname;
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

describe("volleyd never merges", () => {
  it("no source outside the fence builds an argv with pr merge, git merge, push or workflow run", () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const file of sourceFiles(SRC)) {
      // The fence names these verbs in order to deny them.
      if (file.endsWith("/fence.ts")) continue;
      for (const argv of argvWords(readFileSync(file, "utf-8"))) {
        seen++;
        if (argv.some((w) => FORBIDDEN.includes(w))) offenders.push(`${file}: ${argv.join(" ")}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(seen).toBeGreaterThan(10); // the scan really sees the argvs (artifacts, worktree, …)
  });

  it("the grep catches a forbidden argv (self-test)", () => {
    expect(argvWords('exec(["gh", "pr", "merge", "7"])')).toEqual([["gh", "pr", "merge", "7"]]);
    expect(argvWords('git("push", "origin")')).toEqual([["git", "push"]]);
  });

  it("an unfenced exec that would accept anything is never asked to merge, push or re-run CI across a full pipeline", async () => {
    h = pipelineHarness({ fence: false });
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
    expect(h.task()?.stage).toBe("merge_ready");
    h.world.prState[7] = "MERGED";
    h.elapse(60 * 60 * 1000);
    await h.tick();
    expect(h.task()?.stage).toBe("done");

    expect(h.calls.length).toBeGreaterThan(20);
    const bad = h.calls.filter(
      (argv) =>
        (argv[0] === "gh" &&
          (argv.includes("merge") ||
            argv.includes("rerun") ||
            (argv[1] === "workflow" && argv[2] === "run"))) ||
        (argv[0] === "git" && argv.some((w) => w === "merge" || w === "push" || w === "rebase")),
    );
    expect(bad).toEqual([]);
  });
});
