import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SIM_BIN, simEnvLine } from "../src/env";
import { HEAD_MOVED_STDERR, runGh } from "../src/gh";
import { readWorld } from "../src/world";
import { git, makeRepo, pushBranch } from "./helpers/repo";
import { tempDir } from "./helpers/tmp";

let home: string;
let work: string;
let origin: string;
const gh = (argv: string[], cwd = work, env: Record<string, string> = {}) =>
  runGh(argv, { cwd, env: { VOLLEY_SIM_HOME: home, VOLLEY_SIMULATED: "1", ...env } });
const json = (r: { stdout: string }) => JSON.parse(r.stdout);

beforeEach(() => {
  const dir = tempDir("volley-sim-gh-");
  home = join(dir, "sim");
  ({ work, origin } = makeRepo(dir));
});

/** Open a PR for a fresh branch adding `file`; returns its number and head. */
function openPr(branch: string, file = `${branch.replace(/\//g, "-")}.txt`) {
  const head = pushBranch(work, branch, file);
  const r = gh(["pr", "create", "--title", `feat: ${branch}`, "--body", "b", "--base", "main"]);
  expect(r.code).toBe(0);
  const number = Number(/\/pull\/(\d+)\s*$/.exec(r.stdout)?.[1]);
  return { number, head };
}

describe("gh auth (setup's shapes)", () => {
  it("is signed out until `auth login --web --git-protocol https` ran", () => {
    const before = gh(["auth", "status"]);
    expect(before.code).toBe(1);
    expect(before.stderr).toMatch(/not logged into any GitHub hosts/);
    expect(gh(["auth", "login", "--web", "--git-protocol", "https"]).code).toBe(0);
    const after = gh(["auth", "status"]);
    expect(after.code).toBe(0);
    expect(after.stdout + after.stderr).toMatch(/Logged in to github\.com account volley-sim/);
    expect(gh(["auth", "setup-git"]).code).toBe(0);
  });

  it("`api user` answers the login, and `--jq .login` just the name", () => {
    expect(json(gh(["api", "user"])).login).toBe("volley-sim");
    expect(gh(["api", "user", "--jq", ".login"]).stdout).toBe("volley-sim\n");
    // The three fields setup reads for git's identity (name, else login; <id>+<login>@noreply).
    expect(json(gh(["api", "user"]))).toMatchObject({
      login: "volley-sim",
      id: 1,
      name: "Volley Sim",
    });
    expect(gh(["api", "user", "--jq", ".name"]).stdout).toBe("Volley Sim\n");
  });
});

describe("gh api (volleyd's reads)", () => {
  it("the CI queue: nothing queued (a simulated run is done when it is read)", () => {
    const r = gh(["api", "repos/{owner}/{repo}/actions/runs?status=queued&per_page=1"]);
    expect(r.code).toBe(0);
    expect(json(r)).toEqual({ total_count: 0, workflow_runs: [] });
  });

  it("the CI mode reads (#602): one active workflow, an unprotected branch, no rulesets", () => {
    const w = gh(["api", "repos/{owner}/{repo}/actions/workflows?per_page=100"]);
    expect(w.code).toBe(0);
    expect(json(w).workflows.map((x: { state: string }) => x.state)).toEqual(["active"]);
    const b = gh(["api", "repos/{owner}/{repo}/branches/release/w1"]);
    expect(json(b)).toEqual({ name: "release/w1", protected: false });
    expect(json(gh(["api", "repos/{owner}/{repo}/rules/branches/release/w1"]))).toEqual([]);
  });

  it("tags: `git/matching-refs/tags/<prefix> --paginate --slurp` pages, `git/tags/<sha>` the tagged commit", () => {
    const head = git(work, "rev-parse", "HEAD");
    git(work, "tag", "v1.0.0");
    git(work, "tag", "-a", "v1.1.0", "-m", "v1.1.0");
    git(work, "tag", "other");
    git(work, "push", "-q", "origin", "--tags");
    const r = gh(["api", "repos/{owner}/{repo}/git/matching-refs/tags/v", "--paginate", "--slurp"]);
    expect(r.code).toBe(0);
    const pages = json(r) as { ref: string; object: { sha: string; type: string } }[][];
    expect(pages).toHaveLength(1);
    const refs = pages[0] ?? [];
    expect(refs.map((x) => x.ref)).toEqual(["refs/tags/v1.0.0", "refs/tags/v1.1.0"]);
    expect(refs[0]?.object).toEqual({ sha: head, type: "commit" });
    expect(refs[1]?.object.type).toBe("tag");
    const t = gh(["api", `repos/{owner}/{repo}/git/tags/${refs[1]?.object.sha}`]);
    expect(t.code).toBe(0);
    expect(json(t).object).toEqual({ sha: head, type: "commit" });
    // --slurp without --paginate is refused by the real gh too.
    expect(gh(["api", "repos/{owner}/{repo}/git/matching-refs/tags/v", "--slurp"]).code).toBe(1);
  });

  it("`issue edit|comment|close` refuse a number that is not a positive integer", () => {
    for (const argv of [
      ["issue", "edit", "https://github.com/volley-sim/origin/issues/1", "--add-label", "x"],
      ["issue", "comment", "0", "--body", "b"],
      ["issue", "close", "1.5"],
    ]) {
      const r = gh(argv);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/unknown argv/);
    }
  });

  it("`run watch <id> --exit-status` exits with the run's conclusion", () => {
    const { head } = openPr("feat/watch");
    const list = json(
      gh(["run", "list", "--commit", head, "--json", "databaseId", "--limit", "1"]),
    ) as { databaseId: number }[];
    const id = String(list[0]?.databaseId);
    expect(gh(["run", "watch", id, "--exit-status"]).code).toBe(0);
    expect(gh(["run", "watch", "999999"]).code).toBe(1);
  });
});

describe("gh repo", () => {
  it("`repo view --json` names the repository the checkout's origin is", () => {
    const r = gh(["repo", "view", "--json", "nameWithOwner,url,visibility"]);
    expect(r.code).toBe(0);
    expect(json(r)).toEqual({
      nameWithOwner: "volley-sim/origin",
      url: "https://github.com/volley-sim/origin",
      visibility: "PRIVATE",
    });
  });

  it("`repo create --private --clone` makes a bare origin and clones it; `repo delete --yes` removes it", () => {
    const dir = tempDir("volley-sim-gh-create-");
    const r = gh(["repo", "create", "demo", "--private", "--clone"], dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("https://github.com/volley-sim/demo\n");
    expect(existsSync(join(dir, "demo", ".git"))).toBe(true);
    const url = git(join(dir, "demo"), "remote", "get-url", "origin");
    expect(existsSync(url)).toBe(true);
    const view = gh(["repo", "view", "--json", "nameWithOwner"], join(dir, "demo"));
    expect(json(view).nameWithOwner).toBe("volley-sim/demo");
    expect(gh(["repo", "create", "demo", "--private"], dir).code).toBe(1);
    expect(gh(["repo", "delete", "volley-sim/demo", "--yes"], dir).code).toBe(0);
    expect(existsSync(url)).toBe(false);
    expect(gh(["repo", "view", "volley-sim/demo"], dir).code).toBe(1);
  });
});

describe("gh repo clone and VOLLEY_SIM_ORIGINS (a repository added by slug, #596)", () => {
  it("`repo clone <slug>` clones the world's origin into <name>, or into <dir> when given", () => {
    const dir = tempDir("volley-sim-gh-clone-");
    expect(gh(["repo", "create", "volley-sim/demo", "--private"], dir).code).toBe(0);
    const r = gh(["repo", "clone", "volley-sim/demo"], dir);
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "demo", ".git"))).toBe(true);
    expect(git(join(dir, "demo"), "remote", "get-url", "origin")).toBe(
      join(home, "origins", "volley-sim", "demo.git"),
    );
    expect(gh(["repo", "clone", "volley-sim/demo", join(dir, "elsewhere", "d")], dir).code).toBe(0);
    expect(existsSync(join(dir, "elsewhere", "d", ".git"))).toBe(true);
    // The clone is the repository the world knows.
    const view = gh(["repo", "view", "--json", "nameWithOwner"], join(dir, "demo"));
    expect(json(view).nameWithOwner).toBe("volley-sim/demo");
  });

  it("an unknown slug fails as GitHub does", () => {
    const dir = tempDir("volley-sim-gh-clone-");
    const r = gh(["repo", "clone", "volley-sim/nosuch"], dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(
      "GraphQL: Could not resolve to a Repository with the name 'volley-sim/nosuch'. (repository)\n",
    );
    expect(existsSync(join(dir, "nosuch"))).toBe(false);
  });

  it("with VOLLEY_SIM_ORIGINS=<dir> both `repo create` and `repo clone` use it", () => {
    const dir = tempDir("volley-sim-gh-origins-");
    const origins = join(dir, "shared-origins");
    const env = { VOLLEY_SIM_ORIGINS: origins };
    expect(gh(["repo", "create", "volley-sim/shared", "--private"], dir, env).code).toBe(0);
    expect(existsSync(join(origins, "volley-sim", "shared.git", "HEAD"))).toBe(true);
    expect(existsSync(join(home, "origins"))).toBe(false);
    // Another machine's world (a fresh home) sharing the origins clones it.
    const other = join(dir, "other-sim");
    const r = runGh(["repo", "clone", "volley-sim/shared"], {
      cwd: dir,
      env: { VOLLEY_SIM_HOME: other, VOLLEY_SIMULATED: "1", ...env },
    });
    expect(r.code).toBe(0);
    expect(git(join(dir, "shared"), "remote", "get-url", "origin")).toBe(
      join(origins, "volley-sim", "shared.git"),
    );
  });

  it("`volley sim env` carries VOLLEY_SIM_ORIGINS and VOLLEY_SIM_WORKFLOWS on when set", () => {
    const plain = simEnvLine("/path/to/sim", "/path/to/bin");
    expect(plain).toBe(
      `export PATH='/path/to/bin':"$PATH" VOLLEY_SIM_HOME='/path/to/sim' VOLLEY_SIMULATED=1`,
    );
    expect(
      simEnvLine("/path/to/sim", "/path/to/bin", {
        VOLLEY_SIM_ORIGINS: "volley@10.0.0.1:/path/to/origins",
        VOLLEY_SIM_WORKFLOWS: "0",
      }),
    ).toBe(
      `${plain} VOLLEY_SIM_ORIGINS='volley@10.0.0.1:/path/to/origins' VOLLEY_SIM_WORKFLOWS='0'`,
    );
    expect(simEnvLine("/path/to/sim", "/path/to/bin", { VOLLEY_SIM_ORIGINS: "" })).toBe(plain);
  });
});

describe("VOLLEY_SIM_WORKFLOWS (a repository with no CI, #602)", () => {
  const off = { VOLLEY_SIM_WORKFLOWS: "0" };

  it("=0: `actions/workflows` is empty, and no run is created on a push or listed", () => {
    expect(
      json(gh(["api", "repos/{owner}/{repo}/actions/workflows?per_page=100"], work, off)),
    ).toEqual({
      total_count: 0,
      workflows: [],
    });
    const head = pushBranch(work, "feat/noci", "noci.txt");
    const r = gh(
      ["pr", "create", "--title", "feat: noci", "--body", "b", "--base", "main"],
      work,
      off,
    );
    expect(r.code).toBe(0);
    expect(json(gh(["run", "list", "--commit", head, "--json", "databaseId"], work, off))).toEqual(
      [],
    );
    expect(
      json(gh(["run", "list", "--branch", "feat/noci", "--json", "databaseId"], work, off)),
    ).toEqual([]);
    expect(
      json(gh(["api", `repos/{owner}/{repo}/actions/runs?head_sha=${head}`], work, off)),
    ).toEqual({ total_count: 0, workflow_runs: [] });
    expect(json(gh(["pr", "checks", "feat/noci", "--json", "name"], work, off))).toEqual([]);
    expect(readWorld(home).runs).toEqual([]);
  });

  it("unset or =1: one active workflow and a green run, as before (#602's pin)", () => {
    for (const env of [{}, { VOLLEY_SIM_WORKFLOWS: "1" }]) {
      const w = json(gh(["api", "repos/{owner}/{repo}/actions/workflows?per_page=100"], work, env));
      expect(w.total_count).toBe(1);
      expect(w.workflows.map((x: { state: string }) => x.state)).toEqual(["active"]);
    }
    const head = pushBranch(work, "feat/ci", "ci.txt");
    const runs = json(gh(["run", "list", "--commit", head, "--json", "databaseId,conclusion"]));
    expect(runs).toHaveLength(1);
    expect(runs[0].conclusion).toBe("success");
  });
});

describe("gh issue and label", () => {
  it("creates, views, lists, labels, comments on and closes an issue", () => {
    const c = gh(["issue", "create", "--title", "T1", "--body", "## Goal\n\nOne."]);
    expect(c.code).toBe(0);
    const n = Number(/\/issues\/(\d+)\s*$/.exec(c.stdout)?.[1]);
    expect(n).toBeGreaterThan(0);
    const v = json(gh(["issue", "view", String(n), "--json", "number,title,body,url"]));
    expect(v).toEqual({
      number: n,
      title: "T1",
      body: "## Goal\n\nOne.",
      url: `https://github.com/volley-sim/origin/issues/${n}`,
    });
    expect(
      gh([
        "issue",
        "view",
        String(n),
        "--repo",
        "volley-sim/origin",
        "--json",
        "body",
        "--jq",
        ".body",
      ]).stdout,
    ).toBe("## Goal\n\nOne.\n");
    expect(gh(["label", "list", "--search", "merged-to-release", "--json", "name"]).stdout).toBe(
      "[]\n",
    );
    const lc = ["label", "create", "merged-to-release", "--description", "d", "--color", "0e8a16"];
    expect(gh(lc).code).toBe(0);
    expect(gh(lc).code).toBe(1);
    expect(json(gh(["label", "list", "--search", "merged-to-release", "--json", "name"]))).toEqual([
      { name: "merged-to-release" },
    ]);
    expect(gh(["issue", "edit", String(n), "--add-label", "merged-to-release"]).code).toBe(0);
    expect(gh(["issue", "comment", String(n), "--body", "hi"]).code).toBe(0);
    const list = json(gh(["issue", "list", "--label", "merged-to-release", "--json", "number"]));
    expect(list).toEqual([{ number: n }]);
    expect(gh(["issue", "close", String(n), "--comment", "bye"]).code).toBe(0);
    expect(json(gh(["issue", "view", String(n), "--json", "state"])).state).toBe("CLOSED");
    expect(json(gh(["issue", "list", "--json", "number"]))).toEqual([]);
  });

  it("an issue the world has no record of reads like the soak's (title and goal)", () => {
    const v = json(gh(["issue", "view", "42", "--json", "number,title,body"]));
    expect(v).toEqual({ number: 42, title: "Soak task #42", body: "## Goal\n\nTask 42." });
  });
});

describe("gh pr", () => {
  it("create → list --head → view tracks the branch on the bare origin", () => {
    const { number, head } = openPr("w/a-implementer-1");
    expect(number).toBeGreaterThan(0);
    const list = gh([
      "pr",
      "list",
      "--head",
      "w/a-implementer-1",
      "--state",
      "open",
      "--json",
      "number,url,headRefName,baseRefName,headRefOid",
    ]);
    expect(json(list)).toEqual([
      {
        number,
        url: `https://github.com/volley-sim/origin/pull/${number}`,
        headRefName: "w/a-implementer-1",
        baseRefName: "main",
        headRefOid: head,
      },
    ]);
    // A push moves the PR's head (GitHub reads the branch).
    git(work, "commit", "--allow-empty", "-m", "more");
    git(work, "push", "origin", "HEAD:w/a-implementer-1");
    const moved = git(work, "rev-parse", "HEAD");
    expect(json(gh(["pr", "view", String(number), "--json", "headRefOid"])).headRefOid).toBe(moved);
    expect(json(gh(["pr", "view", String(number), "--json", "files"]))).toEqual({
      files: [{ path: "w-a-implementer-1.txt", additions: 1, deletions: 1 }],
    });
    // A second PR for the same head is refused.
    expect(gh(["pr", "create", "--title", "again", "--body", "", "--base", "main"]).code).toBe(1);
  });

  it("a draft becomes ready with `pr ready`", () => {
    pushBranch(work, "w/d", "d.txt");
    const r = gh(["pr", "create", "--title", "d", "--body", "", "--base", "main", "--draft"]);
    const n = /(\d+)\s*$/.exec(r.stdout)?.[1] as string;
    expect(json(gh(["pr", "view", n, "--json", "isDraft"])).isDraft).toBe(true);
    expect(gh(["pr", "ready", n]).code).toBe(0);
    expect(json(gh(["pr", "view", n, "--json", "isDraft"])).isDraft).toBe(false);
  });

  it("`merge --squash --match-head-commit` lands one commit on the base; a moved head is refused", () => {
    const { number, head } = openPr("w/b");
    const stale = gh([
      "pr",
      "merge",
      String(number),
      "--squash",
      "--match-head-commit",
      "0".repeat(40),
    ]);
    expect(stale).toMatchObject({ code: 1, stderr: `${HEAD_MOVED_STDERR}\n` });
    const before = git(origin, "rev-parse", "main");
    const r = gh([
      "pr",
      "merge",
      String(number),
      "--squash",
      "--match-head-commit",
      head,
      "--delete-branch",
    ]);
    expect(r.code).toBe(0);
    const after = git(origin, "rev-parse", "main");
    expect(git(origin, "rev-parse", `${after}^`)).toBe(before);
    expect(git(origin, "log", "-1", "--format=%s", "main")).toBe(`feat: w/b (#${number})`);
    expect(git(origin, "show", "main:w-b.txt")).toBe("w/b");
    expect(git(origin, "branch", "--list", "w/b")).toBe("");
    const v = json(gh(["pr", "view", String(number), "--json", "mergeCommit,state"]));
    expect(v).toEqual({ state: "MERGED", mergeCommit: { oid: after } });
    expect(gh(["pr", "merge", String(number), "--squash"]).stderr).toMatch(/not open/);
  });

  it("`merge --merge` (a train) makes a merge commit and marks every contained PR merged", () => {
    const a = openPr("w/m1");
    git(work, "checkout", "-B", "w/train", "w/m1");
    writeFileSync(join(work, "t.txt"), "t\n");
    git(work, "add", "t.txt");
    git(work, "commit", "-m", "train");
    git(work, "push", "origin", "HEAD:w/train");
    const t = git(work, "rev-parse", "HEAD");
    const train = gh(["pr", "create", "--title", "train", "--body", "", "--base", "main"]);
    const n = Number(/(\d+)\s*$/.exec(train.stdout)?.[1]);
    expect(gh(["pr", "merge", String(n), "--merge", "--match-head-commit", t]).code).toBe(0);
    const tip = git(origin, "rev-parse", "main");
    expect(git(origin, "log", "-1", "--format=%P", "main").split(" ")).toHaveLength(2);
    expect(json(gh(["pr", "view", String(a.number), "--json", "state,mergeCommit"]))).toEqual({
      state: "MERGED",
      mergeCommit: { oid: tip },
    });
  });

  it("`pr checks`, `run list --commit`, `api …actions/runs?head_sha=`, `run view` agree: green", () => {
    const { number, head } = openPr("w/c");
    const checks = json(
      gh(["pr", "checks", String(number), "--json", "bucket,workflow,event,link"]),
    );
    expect(checks).toEqual([
      expect.objectContaining({ bucket: "pass", workflow: "CI", event: "pull_request" }),
    ]);
    const runs = json(
      gh(["run", "list", "--commit", head, "--json", "databaseId,status,conclusion,headSha,event"]),
    );
    expect(runs).toEqual([
      {
        databaseId: expect.any(Number),
        status: "completed",
        conclusion: "success",
        headSha: head,
        event: "pull_request",
      },
    ]);
    const api = json(
      gh([
        "api",
        `repos/{owner}/{repo}/actions/runs?head_sha=${head}&per_page=50`,
        "--jq",
        "[.workflow_runs[] | {id, name, status, conclusion, html_url, head_sha, event, run_attempt, workflow_id, created_at}]",
      ]),
    );
    expect(api).toEqual([
      expect.objectContaining({ id: runs[0].databaseId, conclusion: "success", head_sha: head }),
    ]);
    const jobs = json(gh(["run", "view", String(runs[0].databaseId), "--json", "jobs"]));
    expect(jobs.jobs[0].conclusion).toBe("success");
    expect(gh(["run", "view", String(runs[0].databaseId), "--log-failed"])).toMatchObject({
      code: 0,
      stdout: "",
    });
    const branch = json(gh(["run", "list", "--branch", "main", "--json", "headSha,event"]));
    expect(branch).toEqual([{ headSha: git(origin, "rev-parse", "main"), event: "push" }]);
  });
});

describe("unknown argv", () => {
  it("exits 1 with `unknown argv` and appends the argv to unknown.jsonl", () => {
    const r = gh(["pr", "merge", "1", "--rebase", "--admin"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^unknown argv: gh pr merge 1 --rebase --admin/);
    expect(gh(["workflow", "run", "x"]).code).toBe(1);
    const lines = readFileSync(join(home, "unknown.jsonl"), "utf8").trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).argv)).toEqual([
      ["gh", "pr", "merge", "1", "--rebase", "--admin"],
      ["gh", "workflow", "run", "x"],
    ]);
  });

  it("the bin wrapper answers from the same world (a separate process)", () => {
    gh(["auth", "login", "--web", "--git-protocol", "https"]);
    const r = spawnSync(join(SIM_BIN, "gh"), ["auth", "status"], {
      cwd: work,
      encoding: "utf8",
      env: { ...process.env, VOLLEY_SIM_HOME: home, VOLLEY_SIMULATED: "1" },
    });
    expect(r.status).toBe(0);
    const bad = spawnSync(join(SIM_BIN, "gh"), ["nope"], {
      cwd: work,
      encoding: "utf8",
      env: { ...process.env, VOLLEY_SIM_HOME: home, VOLLEY_SIMULATED: "1" },
    });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/unknown argv: gh nope/);
    expect(readWorld(home).gh.signedIn).toBe(true);
  });
});
