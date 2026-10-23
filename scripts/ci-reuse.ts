#!/usr/bin/env bun
/**
 * Whether a release-branch push can reuse the pull_request run that already tested its tree (#492):
 *
 *   bun scripts/ci-reuse.ts lookup <sha> --branch <release/…>
 *
 * Every pull_request run of ci.yml records the tree it tested (its checkout, the PR's merge
 * commit) as an artifact named `tested-tree-<tree sha>`. A push is reused when it is the squash of
 * a PR merged into `<branch>`, that PR's newest pull_request run of ci.yml on its head completed
 * green, and that run's recorded tree is the pushed commit's tree. Anything else — including any
 * `gh` failure — is "no reuse", and the push runs everything.
 *
 * On reuse, prints `run=<id>`, `url=<url>`, `pr=<n>` and `tree=<sha>` (lines for $GITHUB_OUTPUT);
 * otherwise prints nothing to stdout and `no reuse: <why>` to stderr. Exit code: 0 either way;
 * 2 on usage. Reads through `gh api` (GH_TOKEN in CI); node builtins only, no install needed.
 */
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

/** One GitHub API GET (`gh api <path>`), parsed; throws on any failure. */
export type Api = (path: string) => unknown;

interface Pull {
  number: number;
  merge_commit_sha: string | null;
  merged_at: string | null;
  base: { ref: string };
  head: { sha: string };
}

interface Run {
  id: number;
  status: string;
  conclusion: string | null;
  html_url: string;
}

export type Reuse = { run: number; url: string; pr: number; tree: string } | { why: string };

const REPO = "repos/{owner}/{repo}";
const TREE_ARTIFACT = /^tested-tree-([0-9a-f]{40})$/;

const short = (sha: string) => sha.slice(0, 7);

/** The PR `sha` is the squash of: merged, into `branch`, with `sha` as its merge commit. */
export function mergedPr(sha: string, branch: string, pulls: Pull[]): Pull | undefined {
  return pulls.find(
    (p) => p.merge_commit_sha === sha && p.merged_at !== null && p.base.ref === branch,
  );
}

/** The newest run (highest id), and whether it completed green. */
export function newestRun(runs: Run[]): { run: Run; green: boolean } | undefined {
  const run = [...runs].sort((a, b) => b.id - a.id)[0];
  if (run === undefined) return undefined;
  return { run, green: run.status === "completed" && run.conclusion === "success" };
}

/** The tree a run recorded: its one `tested-tree-<sha>` artifact (two different ones: none). */
export function recordedTree(names: string[]): string | undefined {
  const trees = new Set(names.flatMap((n) => TREE_ARTIFACT.exec(n)?.[1] ?? []));
  return trees.size === 1 ? [...trees][0] : undefined;
}

/** Whether the push of `sha` to `branch` reuses a pull_request run, through `api`. */
export function lookup(sha: string, branch: string, api: Api): Reuse {
  try {
    const tree = (api(`${REPO}/git/commits/${sha}`) as { tree: { sha: string } }).tree.sha;
    const pr = mergedPr(sha, branch, api(`${REPO}/commits/${sha}/pulls`) as Pull[]);
    if (pr === undefined) return { why: `${short(sha)} is not a PR's squash into ${branch}` };
    const runs = (
      api(
        `${REPO}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${pr.head.sha}&per_page=5`,
      ) as { workflow_runs: Run[] }
    ).workflow_runs;
    const newest = newestRun(runs);
    if (newest === undefined)
      return { why: `PR #${pr.number} has no pull_request run of ci.yml on ${short(pr.head.sha)}` };
    const { run, green } = newest;
    if (!green) return { why: `run ${run.id} is ${run.status}/${run.conclusion}, not green` };
    const names = (
      api(`${REPO}/actions/runs/${run.id}/artifacts`) as { artifacts: { name: string }[] }
    ).artifacts.map((a) => a.name);
    const tested = recordedTree(names);
    if (tested === undefined) return { why: `run ${run.id} recorded no tested tree` };
    if (tested !== tree)
      return { why: `run ${run.id} tested tree ${short(tested)}, not ${short(tree)}` };
    return { run: run.id, url: run.html_url, pr: pr.number, tree };
  } catch (e) {
    return { why: `lookup failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

const gh: Api = (path) => {
  const r = spawnSync("gh", ["api", path], { encoding: "utf8" });
  if (r.error !== undefined) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || `gh api exited ${r.status}`).trim());
  return JSON.parse(r.stdout);
};

function main(argv: string[]): number {
  let command: string | undefined;
  let sha: string | undefined;
  let branch: string | undefined;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { branch: { type: "string" } },
    });
    [command, sha] = positionals;
    branch = values.branch;
  } catch {}
  if (command !== "lookup" || sha === undefined || branch === undefined) {
    console.error("usage: bun scripts/ci-reuse.ts lookup <sha> --branch <branch>");
    return 2;
  }
  const r = lookup(sha, branch, gh);
  if ("why" in r) console.error(`no reuse: ${r.why}`);
  else process.stdout.write(`run=${r.run}\nurl=${r.url}\npr=${r.pr}\ntree=${r.tree}\n`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
