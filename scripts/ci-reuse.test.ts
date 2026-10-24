import { describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Api, lookup, mergedPr, newestRun, recordedTree } from "./ci-reuse";
import { tempDir } from "./helpers/tmp";

const SCRIPT = join(import.meta.dir, "ci-reuse.ts");
const BRANCH = "release/2026-10-23-overlap";
const SHA = "f67a14d1e9e3c693f999c4eb57d069a87a276f6e";
const HEAD = "a".repeat(40);
const TREE = "e97c56f0".padEnd(40, "0");
const OTHER_TREE = "b".repeat(40);

/** `commits/<sha>/pulls` on a squash: the PR it merged (#491), beside an unrelated open PR. */
const PULLS = [
  {
    number: 491,
    merge_commit_sha: SHA,
    merged_at: "2026-10-23T22:30:00Z",
    base: { ref: BRANCH },
    head: { sha: HEAD },
  },
  {
    number: 488,
    merge_commit_sha: "c".repeat(40),
    merged_at: null,
    base: { ref: BRANCH },
    head: { sha: "d".repeat(40) },
  },
];

const run = (id: number, status = "completed", conclusion: string | null = "success") => ({
  id,
  status,
  conclusion,
  html_url: `https://github.com/example/repo/actions/runs/${id}`,
});

/** The four GETs a lookup makes, answered from a table; a path it lacks is a `gh` failure. */
function fakeApi(o: { pulls?: unknown; runs?: unknown[]; artifacts?: string[] } = {}): Api {
  const table: Record<string, unknown> = {
    [`repos/{owner}/{repo}/git/commits/${SHA}`]: { sha: SHA, tree: { sha: TREE } },
    [`repos/{owner}/{repo}/commits/${SHA}/pulls`]: o.pulls ?? PULLS,
    [`repos/{owner}/{repo}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${HEAD}&per_page=5`]:
      { workflow_runs: o.runs ?? [run(40033955734), run(40033000000)] },
    "repos/{owner}/{repo}/actions/runs/40033955734/artifacts": {
      artifacts: (o.artifacts ?? ["parity-report", `tested-tree-${TREE}`]).map((name) => ({
        name,
      })),
    },
  };
  return (path) => {
    if (!(path in table)) throw new Error(`HTTP 404: Not Found (${path})`);
    return table[path];
  };
}

describe("mergedPr", () => {
  test("the PR whose squash is this commit, merged into this branch", () => {
    expect(mergedPr(SHA, BRANCH, PULLS)?.number).toBe(491);
  });

  test("an open PR, another branch's PR or another commit's PR is none", () => {
    expect(mergedPr("c".repeat(40), BRANCH, PULLS)).toBeUndefined();
    expect(mergedPr(SHA, "release/other", PULLS)).toBeUndefined();
    expect(mergedPr("9".repeat(40), BRANCH, PULLS)).toBeUndefined();
    expect(mergedPr(SHA, BRANCH, [])).toBeUndefined();
  });
});

describe("newestRun", () => {
  test("the highest id, green when completed + success", () => {
    expect(newestRun([run(1, "completed", "failure"), run(5), run(3)])).toMatchObject({
      run: { id: 5 },
      green: true,
    });
  });

  test("a newest run still running or red is not green, whatever an older one says", () => {
    expect(newestRun([run(1), run(2, "in_progress", null)])).toMatchObject({ green: false });
    expect(newestRun([run(1), run(2, "completed", "failure")])).toMatchObject({ green: false });
  });

  test("no runs: none", () => {
    expect(newestRun([])).toBeUndefined();
  });
});

describe("recordedTree", () => {
  test("the one tested-tree-<sha> among the artifact names", () => {
    expect(recordedTree(["parity-report", `tested-tree-${TREE}`])).toBe(TREE);
  });

  test("none, a malformed name or two different trees: none", () => {
    expect(recordedTree(["parity-report"])).toBeUndefined();
    expect(recordedTree(["tested-tree-xyz"])).toBeUndefined();
    expect(recordedTree([`tested-tree-${TREE}`, `tested-tree-${OTHER_TREE}`])).toBeUndefined();
  });
});

describe("lookup", () => {
  test("the PR's newest run passed and recorded this commit's tree: reuse it", () => {
    expect(lookup(SHA, BRANCH, fakeApi())).toEqual({
      run: 40033955734,
      url: "https://github.com/example/repo/actions/runs/40033955734",
      pr: 491,
      tree: TREE,
    });
  });

  test("a commit that is no PR's squash: no reuse", () => {
    expect(lookup(SHA, BRANCH, fakeApi({ pulls: [] }))).toEqual({
      why: `${SHA.slice(0, 7)} is not a PR's squash into ${BRANCH}`,
    });
  });

  test("the PR has no pull_request run: no reuse", () => {
    expect(lookup(SHA, BRANCH, fakeApi({ runs: [] }))).toEqual({
      why: `PR #491 has no pull_request run of ci.yml on ${HEAD.slice(0, 7)}`,
    });
  });

  test("the newest run is not green: no reuse", () => {
    const r = lookup(SHA, BRANCH, fakeApi({ runs: [run(40033955734, "completed", "failure")] }));
    expect(r).toEqual({ why: "run 40033955734 is completed/failure, not green" });
  });

  test("the run recorded no tree (it predates the recorder): no reuse", () => {
    const r = lookup(SHA, BRANCH, fakeApi({ artifacts: ["parity-report"] }));
    expect(r).toEqual({ why: "run 40033955734 recorded no tested tree" });
  });

  test("the run tested another tree (the PR merged behind its base): no reuse", () => {
    const r = lookup(SHA, BRANCH, fakeApi({ artifacts: [`tested-tree-${OTHER_TREE}`] }));
    expect(r).toEqual({
      why: `run 40033955734 tested tree ${OTHER_TREE.slice(0, 7)}, not ${TREE.slice(0, 7)}`,
    });
  });

  test("any API failure: no reuse, naming it", () => {
    const r = lookup(SHA, BRANCH, () => {
      throw new Error("HTTP 403: rate limited");
    });
    expect(r).toEqual({ why: "lookup failed: HTTP 403: rate limited" });
  });
});

describe("the CLI", () => {
  /** A fake `gh` first on PATH: `gh api <path>` prints the fixture file named after the path. */
  function fakeGh(fixtures: Record<string, unknown>): string {
    const dir = tempDir("vly-ci-reuse-");
    const file = (path: string) => join(dir, path.replace(/[^A-Za-z0-9]/g, "_"));
    for (const [path, body] of Object.entries(fixtures))
      writeFileSync(file(path), JSON.stringify(body));
    writeFileSync(
      join(dir, "gh"),
      `#!/bin/sh\nf="${dir}/$(printf %s "$2" | tr -c 'A-Za-z0-9' _)"\n[ "$1" = api ] && [ -f "$f" ] && exec cat "$f"\necho "HTTP 404: Not Found" >&2\nexit 1\n`,
    );
    chmodSync(join(dir, "gh"), 0o755);
    return dir;
  }

  function cli(args: string[], ghDir: string) {
    const r = Bun.spawnSync(["bun", SCRIPT, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: `${ghDir}:${process.env.PATH}` },
    });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  }

  const allFixtures = (o: Parameters<typeof fakeApi>[0] = {}) => {
    const a = fakeApi(o);
    const out: Record<string, unknown> = {};
    for (const p of [
      `repos/{owner}/{repo}/git/commits/${SHA}`,
      `repos/{owner}/{repo}/commits/${SHA}/pulls`,
      `repos/{owner}/{repo}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${HEAD}&per_page=5`,
      "repos/{owner}/{repo}/actions/runs/40033955734/artifacts",
    ])
      out[p] = a(p);
    return out;
  };

  test("a match prints run=, url=, pr=, tree= for $GITHUB_OUTPUT", () => {
    const r = cli(["lookup", SHA, "--branch", BRANCH], fakeGh(allFixtures()));
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      `run=40033955734\nurl=https://github.com/example/repo/actions/runs/40033955734\npr=491\ntree=${TREE}\n`,
    );
  });

  test("a mismatch prints nothing to stdout, the reason to stderr, and exits 0", () => {
    const r = cli(
      ["lookup", SHA, "--branch", BRANCH],
      fakeGh(allFixtures({ artifacts: [`tested-tree-${OTHER_TREE}`] })),
    );
    expect(r).toMatchObject({ code: 0, out: "" });
    expect(r.err).toContain("no reuse: run 40033955734 tested tree");
  });

  test("gh failing is no reuse, exit 0", () => {
    const r = cli(["lookup", SHA, "--branch", BRANCH], fakeGh({}));
    expect(r).toMatchObject({ code: 0, out: "" });
    expect(r.err).toContain("no reuse: lookup failed:");
  });

  test("a missing argument is a usage error", () => {
    const gh = fakeGh({});
    expect(cli(["lookup", SHA], gh).code).toBe(2);
    expect(cli(["lookup", "--branch", BRANCH], gh).code).toBe(2);
    expect(cli(["frobnicate"], gh).code).toBe(2);
  });
});

describe("ci.yml's reuse lookup", () => {
  test("a failure in the lookup job is no reuse, never a red run", async () => {
    const text = await Bun.file(join(import.meta.dir, "../.github/workflows/ci.yml")).text();
    const ci = Bun.YAML.parse(text) as { jobs: Record<string, { "continue-on-error"?: boolean }> };
    expect(ci.jobs.reuse?.["continue-on-error"]).toBe(true);
  });
});

describe("ci.yml's run: steps", () => {
  const read = () => Bun.file(join(import.meta.dir, "../.github/workflows/ci.yml")).text();

  test("ci-reused reports the whole line", async () => {
    const ci = Bun.YAML.parse(await read()) as {
      jobs: Record<string, { steps?: { run?: string }[] }>;
    };
    const run = ci.jobs["ci-reused"]?.steps?.[0]?.run;
    expect(run).toContain('tee -a "$GITHUB_STEP_SUMMARY"');
    expect(run).toContain("tree $TREE");
  });

  test("no run: step loses its tail to a YAML comment", async () => {
    // A plain scalar ends at ` #`: the rest of the line is a comment, not part of the command.
    // Only plain scalars: the lookahead sits after all the blanks, so a quoted or block value is skipped.
    const plain = [...(await read()).matchAll(/^[ \t]*(?:- )?run:[ \t]+(?![\s"'|>])(.*\S)[ \t]*$/gm)].map(
      (m) => m[1],
    );
    expect(plain.length).toBeGreaterThan(0);
    expect(plain.filter((value) => /[ \t]#/.test(value ?? ""))).toEqual([]);
  });
});
