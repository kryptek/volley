import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { realDeps, runPeer } from "../../src/commands/peer";
import { EXIT } from "../../src/exit-codes";
import { makeBufferIO } from "../../src/io";
import {
  AGENT_BRANCH,
  CLEANUP_DEFAULTS,
  LSOF_CWD_ARGV,
  PS_ARGV,
  type PeerCleanupDeps,
  type PeerCleanupReport,
  listProcesses,
  parseLsofCwd,
  parsePeerCleanupReport,
  realPeerCleanupDeps,
  runPeerCleanup,
} from "../../src/peer/cleanup";
import { tempDir } from "../helpers/tmp";

/** `volley peer cleanup` (#612): what the supervisor runs on a paired machine during cleanup. */

const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) {
    if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  }
});

/** A real `sleep 30` in `cwd`; `argv0` shows up first in its command line (/proc, ps). */
function sleeper(cwd: string, argv0?: string): ChildProcess & { exited: Promise<void> } {
  const c = spawn("sleep", ["30"], { cwd, stdio: "ignore", ...(argv0 ? { argv0 } : {}) });
  children.push(c);
  const exited = new Promise<void>((r) => c.once("exit", () => r()));
  return Object.assign(c, { exited });
}

const alive = (c: ChildProcess) => c.exitCode === null && c.signalCode === null;

/** Wait until /proc (or ps) sees `pid` with its working directory set (spawn returns early). */
async function settled(pid: number, cwd: string) {
  for (let i = 0; i < 50; i++) {
    const procs = await listProcesses(realPeerCleanupDeps());
    if (procs.some((p) => p.pid === pid && p.cwd !== null && p.cwd.endsWith(cwd.slice(-8)))) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

const deps = (over: Partial<PeerCleanupDeps> = {}): PeerCleanupDeps => ({
  ...realPeerCleanupDeps(),
  graceMs: 300,
  ...over,
});

async function run(argv: string[], d: PeerCleanupDeps = deps()) {
  const io = makeBufferIO();
  const code = await runPeerCleanup(argv, io, d);
  const out = io.readStdout();
  return {
    code,
    stdout: out,
    stderr: io.readStderr(),
    report: code === EXIT.OK ? (JSON.parse(out) as PeerCleanupReport) : null,
  };
}

const GIT_ID = [
  "-c",
  "user.name=Volley Test",
  "-c",
  "user.email=test@example.invalid",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "init.defaultBranch=main",
];
function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", [...GIT_ID, "-C", cwd, ...args], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
function commit(repo: string, file: string) {
  writeFileSync(join(repo, file), `${file}\n`);
  git(repo, "add", file);
  git(repo, "commit", "-q", "-m", `add ${file}`);
}

/** A bare origin with one commit on main, and a fresh clone of it at `<dir>/<name>`. */
function originAndClone(dir: string, name = "clone"): { origin: string; clone: string } {
  const origin = join(dir, "origin.git");
  if (!existsSync(origin)) {
    git(dir, "init", "-q", "--bare", "-b", "main", origin);
    const seed = join(dir, "seed");
    git(dir, "clone", "-q", origin, seed);
    commit(seed, "README.md");
    git(seed, "push", "-q", "origin", "HEAD:main");
  }
  const clone = join(dir, name);
  git(dir, "clone", "-q", origin, clone);
  return { origin, clone };
}

describe("peer cleanup: arguments", () => {
  it("refuses a run without --json, a relative path, --branch without --repo, a non-agent branch", async () => {
    const dir = tempDir("volley-peer-cleanup-args-");
    for (const argv of [
      ["--worktree", dir],
      ["--json", "--worktree", "rel/wt"],
      ["--json", "--clone", "rel/clone"],
      ["--json", "--repo", "rel", "--branch", "w1/T1-implementer-1"],
      ["--json", "--branch", "w1/T1-implementer-1"],
      ["--json", "--repo", dir, "--branch", "main"],
      ["--json", "--repo", dir, "--branch", "w1/T1-implementer-0"],
      ["--json", "positional"],
      ["--json", "--frobnicate"],
    ]) {
      const r = await run(argv);
      expect(r.code, argv.join(" ")).toBe(EXIT.USAGE);
      expect(r.stdout, argv.join(" ")).toBe("");
    }
  });

  it("is a verb of volley peer, with its own flags", async () => {
    const io = makeBufferIO();
    expect(await runPeer({ argv: ["cleanup"], env: {}, io }, realDeps())).toBe(EXIT.USAGE);
    expect(io.readStderr()).toContain("--json");
    const ok = makeBufferIO();
    expect(await runPeer({ argv: ["cleanup", "--json"], env: {}, io: ok }, realDeps())).toBe(
      EXIT.OK,
    );
    expect(JSON.parse(ok.readStdout())).toEqual({ worktrees: [], branches: [], clones: [] });
  });

  it("the agent-branch shape matches volleyd's", () => {
    for (const b of ["w1/T1-implementer-1", "w1/T2-quality_reviewer-3", "w1/release-merge-2"])
      expect(AGENT_BRANCH.test(b), b).toBe(true);
    for (const b of ["main", "release/2026-10-25-x", "w1/T1-boss-1", "W1/T1-implementer-1"])
      expect(AGENT_BRANCH.test(b), b).toBe(false);
  });
});

describe("peer cleanup: processes", () => {
  it("lists a process by its working directory or its --mcp-config, never one under <wt>10", async () => {
    const base = tempDir("volley-peer-cleanup-procs-");
    const wt = join(base, "wt1");
    const wt10 = join(base, "wt10");
    const other = join(base, "other");
    for (const d of [wt, wt10, other, join(wt, "sub")]) mkdirSync(d, { recursive: true });
    const devServer = sleeper(join(wt, "sub"));
    const agent = sleeper(other, `sleep --mcp-config=${join(wt, ".volley", "mcp.json")}`);
    const neighbour = sleeper(wt10);
    await settled(devServer.pid as number, "sub");
    await settled(neighbour.pid as number, "wt10");

    const dry = await run(["--json", "--worktree", wt]);
    expect(dry.code).toBe(EXIT.OK);
    expect(dry.stdout.trim().split("\n")).toHaveLength(1);
    const entry = dry.report?.worktrees[0];
    expect(entry?.worktree).toBe(wt);
    expect(entry?.stopped).toBe(false);
    const pids = (entry?.pids ?? []).map((p) => p.pid);
    expect(pids).toContain(devServer.pid);
    expect(pids).toContain(agent.pid);
    expect(pids).not.toContain(neighbour.pid);
    expect(entry?.pids.find((p) => p.pid === agent.pid)?.command).toContain("--mcp-config=");
    expect(alive(devServer) && alive(agent)).toBe(true);

    const real = await run(["--json", "--worktree", wt, "--yes"]);
    expect(real.code).toBe(EXIT.OK);
    expect(real.report?.worktrees[0]?.stopped).toBe(true);
    await Promise.all([devServer.exited, agent.exited]);
    expect(alive(neighbour)).toBe(true);
  });

  it("SIGKILLs a process that outlives the grace", async () => {
    const wt = tempDir("volley-peer-cleanup-stubborn-");
    // A shell that ignores SIGTERM; `exec sleep` would not: keep the shell itself running.
    const c = spawn("sh", ["-c", "trap '' TERM; while :; do sleep 0.1; done"], {
      cwd: wt,
      stdio: "ignore",
    });
    children.push(c);
    const exited = new Promise<void>((r) => c.once("exit", () => r()));
    await settled(c.pid as number, wt);
    const r = await run(["--json", "--worktree", wt, "--yes"], deps({ graceMs: 200 }));
    expect(r.report?.worktrees[0]?.pids.map((p) => p.pid)).toContain(c.pid);
    await exited;
    expect(c.signalCode).toBe("SIGKILL");
  });

  it("never lists itself or its parent", async () => {
    const r = await run(["--json", "--worktree", process.cwd()]);
    const pids = (r.report?.worktrees[0]?.pids ?? []).map((p) => p.pid);
    expect(pids).not.toContain(process.pid);
    expect(pids).not.toContain(process.ppid);
  });

  it("on macOS reads ps and the exact lsof argv", async () => {
    const calls: string[][] = [];
    const d = deps({
      platform: "darwin",
      exec: async (argv) => {
        calls.push(argv);
        if (argv[0] === "ps")
          return {
            code: 0,
            stdout:
              "  101 claude --mcp-config=/w/a/.volley/mcp.json\n  102 npm run dev\n  103 vim\n",
            stderr: "",
          };
        return { code: 1, stdout: "p102\nfcwd\nn/w/a/app\np103\nfcwd\nn/w/a1\n", stderr: "" };
      },
    });
    const procs = await listProcesses(d);
    expect(calls).toEqual([PS_ARGV, LSOF_CWD_ARGV]);
    expect(LSOF_CWD_ARGV).toEqual(["lsof", "-a", "-d", "cwd", "-F", "pn"]);
    expect(procs).toEqual([
      { pid: 101, command: "claude --mcp-config=/w/a/.volley/mcp.json", cwd: null },
      { pid: 102, command: "npm run dev", cwd: "/w/a/app" },
      { pid: 103, command: "vim", cwd: "/w/a1" },
    ]);
    const r = await run(["--json", "--worktree", "/w/a"], d);
    expect(r.report?.worktrees[0]?.pids.map((p) => p.pid)).toEqual([101, 102]);
  });

  it("parseLsofCwd keeps the first name per pid", () => {
    expect([...parseLsofCwd("p1\nfcwd\nn/a\nn/b\np2\nn/c\npx\nn/d\n")]).toEqual([
      [1, "/a"],
      [2, "/c"],
    ]);
  });
});

describe("peer cleanup: branches", () => {
  it("deletes a named agent branch with --yes; a dry run and a missing branch say why", async () => {
    const repo = tempDir("volley-peer-cleanup-branch-");
    git(repo, "init", "-q", "-b", "main");
    commit(repo, "a.txt");
    git(repo, "branch", "w1/T1-implementer-1");

    const dry = await run(["--json", "--repo", repo, "--branch", "w1/T1-implementer-1"]);
    expect(dry.report?.branches).toEqual([
      { branch: "w1/T1-implementer-1", deleted: false, why: "dry run" },
    ]);
    expect(git(repo, "branch", "--list", "w1/T1-implementer-1")).not.toBe("");

    const real = await run([
      "--json",
      "--repo",
      repo,
      "--branch",
      "w1/T1-implementer-1",
      "--branch",
      "w1/T2-implementer-1",
      "--yes",
    ]);
    expect(real.code).toBe(EXIT.OK);
    expect(real.report?.branches).toEqual([
      { branch: "w1/T1-implementer-1", deleted: true },
      { branch: "w1/T2-implementer-1", deleted: false, why: "no such branch" },
    ]);
    expect(git(repo, "branch", "--list", "w1/T1-implementer-1")).toBe("");
    expect(git(repo, "branch", "--list", "main")).not.toBe("");
  });
});

describe("peer cleanup: clones", () => {
  it("removes a clean, fully pushed clone with --yes; never one it was not given", async () => {
    const dir = tempDir("volley-peer-cleanup-clone-");
    const { clone } = originAndClone(dir);
    const { clone: kept } = originAndClone(dir, "other");

    const dry = await run(["--json", "--clone", clone]);
    expect(dry.report?.clones).toEqual([{ clone, removed: false, why: "dry run" }]);
    expect(existsSync(clone)).toBe(true);

    const real = await run(["--json", "--clone", clone, "--yes"]);
    expect(real.report?.clones).toEqual([{ clone, removed: true }]);
    expect(existsSync(clone)).toBe(false);
    expect(existsSync(join(kept, ".git"))).toBe(true);

    const again = await run(["--json", "--clone", clone, "--yes"]);
    expect(again.report?.clones).toEqual([{ clone, removed: false, why: "gone" }]);
  });

  it("keeps a clone with unpushed commits, a dirty tree, a stash or a branch with no upstream", async () => {
    const dir = tempDir("volley-peer-cleanup-kept-");
    const { clone: one } = originAndClone(dir, "one");
    commit(one, "b.txt");
    const { clone: two } = originAndClone(dir, "two");
    commit(two, "b.txt");
    commit(two, "c.txt");
    const { clone: dirty } = originAndClone(dir, "dirty");
    writeFileSync(join(dirty, "scratch.txt"), "x\n");
    const { clone: stashed } = originAndClone(dir, "stashed");
    writeFileSync(join(stashed, "README.md"), "changed\n");
    git(stashed, "stash", "push", "-q", "-m", "wip");
    const { clone: local } = originAndClone(dir, "local");
    git(local, "branch", "topic");

    const r = await run([
      "--json",
      ...[one, two, dirty, stashed, local].flatMap((c) => ["--clone", c]),
      "--yes",
    ]);
    expect(r.code).toBe(EXIT.OK);
    expect(r.report?.clones).toEqual([
      { clone: one, removed: false, why: "1 unpushed commit on main" },
      { clone: two, removed: false, why: "2 unpushed commits on main" },
      { clone: dirty, removed: false, why: "dirty work tree" },
      { clone: stashed, removed: false, why: "stash" },
      { clone: local, removed: false, why: "topic has no upstream" },
    ]);
    for (const c of [one, two, dirty, stashed, local])
      expect(existsSync(join(c, ".git"))).toBe(true);
  });

  it("keeps a clone a worktree is still checked out from, even with every branch pushed", async () => {
    const dir = tempDir("volley-peer-cleanup-linked-");
    const { clone } = originAndClone(dir);
    const wt = join(dir, "wt");
    git(clone, "worktree", "add", "-q", "-b", "side", wt);
    git(wt, "push", "-q", "-u", "origin", "side");
    const r = await run(["--json", "--clone", clone, "--yes"]);
    expect(r.report?.clones).toEqual([
      { clone, removed: false, why: `linked worktree ${realpathSync(wt)}` },
    ]);
    expect(existsSync(join(clone, ".git"))).toBe(true);
  });

  it("keeps a directory that is not a clone's top level", async () => {
    const dir = tempDir("volley-peer-cleanup-notclone-");
    const { clone } = originAndClone(dir);
    const sub = join(clone, "sub");
    mkdirSync(sub);
    const plain = join(dir, "plain");
    mkdirSync(plain);
    const r = await run(["--json", "--clone", sub, "--clone", plain, "--yes"]);
    expect(r.report?.clones).toEqual([
      { clone: sub, removed: false, why: "not a git clone" },
      { clone: plain, removed: false, why: "not a git clone" },
    ]);
    expect(existsSync(sub) && existsSync(plain)).toBe(true);
  });

  it("an agent branch named with --branch is deleted first, so it never blocks the clone", async () => {
    const dir = tempDir("volley-peer-cleanup-merged-");
    const { clone } = originAndClone(dir);
    git(clone, "checkout", "-q", "-b", "w1/T1-implementer-1");
    commit(clone, "work.txt");
    git(clone, "checkout", "-q", "main");

    const blocked = await run(["--json", "--clone", clone, "--yes"]);
    expect(blocked.report?.clones[0]?.why).toBe("w1/T1-implementer-1 has no upstream");

    const r = await run([
      "--json",
      "--repo",
      clone,
      "--branch",
      "w1/T1-implementer-1",
      "--clone",
      clone,
      "--yes",
    ]);
    expect(r.report).toEqual({
      worktrees: [],
      branches: [{ branch: "w1/T1-implementer-1", deleted: true }],
      clones: [{ clone, removed: true }],
    });
    expect(existsSync(clone)).toBe(false);
  });
});

describe("parsePeerCleanupReport", () => {
  const good: PeerCleanupReport = {
    worktrees: [{ worktree: "/w/a", pids: [{ pid: 7, command: "npm run dev" }], stopped: true }],
    branches: [{ branch: "w1/T1-implementer-1", deleted: false, why: "dry run" }],
    clones: [{ clone: "/r/o/n", removed: true }],
  };

  it("reads the report from the last line of stdout", () => {
    expect(parsePeerCleanupReport(`${JSON.stringify(good)}\n`)).toEqual(good);
    expect(parsePeerCleanupReport(`noise\n${JSON.stringify(good)}\n\n`)).toEqual(good);
  });

  it("throws on anything else", () => {
    for (const bad of [
      "",
      "not json",
      "[]",
      JSON.stringify({ ...good, worktrees: undefined }),
      JSON.stringify({
        ...good,
        worktrees: [{ worktree: "/w", pids: [{ pid: "7" }], stopped: true }],
      }),
      JSON.stringify({ ...good, branches: [{ branch: "b", deleted: "yes" }] }),
      JSON.stringify({ ...good, clones: [{ clone: "/c", removed: false, why: 3 }] }),
    ]) {
      expect(() => parsePeerCleanupReport(bad), bad).toThrow();
    }
  });

  it("the grace defaults to 5 s", () => {
    expect(CLEANUP_DEFAULTS.grace_ms).toBe(5000);
    expect(realPeerCleanupDeps().graceMs).toBe(5000);
  });
});
