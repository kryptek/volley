import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupPlan, cleanupWave, readWave } from "../src/commands/cleanup";
import { type ExecFn, exec } from "../src/exec";
import { makeBufferIO } from "../src/io";
import { Journal } from "../src/journal";
import { parsePs } from "../src/procs";
import { parseWaveFile } from "../src/wave-file";
import { tempDir } from "./helpers/tmp";

/** A one-task wave at `repo` (the journal needs a real one to reduce). */
const minimalWave = (repo: string) =>
  parseWaveFile(
    `wave: w1\nrepo: ${repo}\nrelease_branch: release/w1\nmodel: claude-opus-5-5\npipeline: [implement, merge_ready]\ntasks:\n  T1: { issue: 1 }\n`,
  );

/** `volleyd cleanup <wave> --yes` also stops the retired agents' claude processes. */

describe("cleanup stops retired agents' processes", () => {
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const c of children.splice(0)) {
      try {
        process.kill(c.pid as number, "SIGKILL");
      } catch {}
    }
  });

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  /** A long-lived process launched the way a supervised claude is: `--mcp-config=` in its argv. */
  const sleeper = (worktree: string): number => {
    const c = spawn(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)", "--", `--mcp-config=${worktree}/.volley/mcp.json`],
      { stdio: "ignore" },
    );
    children.push(c);
    return c.pid as number;
  };

  const listed = async (pids: number[]) => {
    for (let i = 0; i < 50; i++) {
      const r = await exec(["ps", "-axo", "pid=,command="]);
      const seen = parsePs(r.stdout).filter((p) => p.command.includes("--mcp-config="));
      if (pids.every((pid) => seen.some((p) => p.pid === pid))) return;
      // real process: waiting for ps to show the spawned sleepers
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  /** Wave w1: two retired agents and one live one, their worktrees under `<home>/wt/w1`. */
  const setup = () => {
    const home = tempDir("volleyd-cleanup-procs-");
    const root = join(home, "wt");
    const j = Journal.open(join(home, "waves", "w1"));
    j.append({ type: "wave_submitted", data: { wave: minimalWave(join(home, "repo")) } });
    const agents: [string, string, boolean][] = [
      ["w1-t1-implementer-1", join(root, "w1", "T1-implementer"), true],
      ["w1-t2-fixup-1", join(root, "w1", "T2-fixup"), true],
      ["w1-t3-implementer-1", join(root, "w1", "T3-implementer"), false],
    ];
    for (const [agent_id, worktree, retired] of agents) {
      j.append({ type: "agent_spawned", task: "T1", data: { agent_id, worktree } });
      if (retired)
        j.append({
          type: "agent_retired",
          task: "T1",
          data: { agent_id, workspace_closed: true },
        });
    }
    return { home, root };
  };

  it("--yes stops the two retired agents' processes, not the live one's or another wave's", async () => {
    const { home, root } = setup();
    const a = sleeper(join(root, "w1", "T1-implementer"));
    const b = sleeper(join(root, "w1", "T2-fixup"));
    const live = sleeper(join(root, "w1", "T3-implementer"));
    const other = sleeper(join(root, "w10", "T1-implementer"));
    await listed([a, b, live, other]);
    const io = makeBufferIO();
    expect(
      await cleanupWave(home, "w1", { yes: true, force: false, reap: { graceMs: 2000 } }, io),
    ).toBe(0);
    const out = io.readStdout();
    expect(out).toContain(`stopped ${a} (w1-t1-implementer-1)\n`);
    expect(out).toContain(`stopped ${b} (w1-t2-fixup-1)\n`);
    expect(out.match(/^stopped /gm)).toHaveLength(2);
    expect(alive(live)).toBe(true);
    expect(alive(other)).toBe(true);
  });

  it("--yes leaves alone a process in a worktree the journal does not name yet (an agent being launched)", async () => {
    const { home, root } = setup();
    const a = sleeper(join(root, "w1", "T1-implementer"));
    // The daemon launches before it journals agent_spawned: this worktree is not in the plan.
    const launching = sleeper(join(root, "w1", "T4-implementer"));
    await listed([a, launching]);
    const io = makeBufferIO();
    await cleanupWave(home, "w1", { yes: true, force: false, reap: { graceMs: 2000 } }, io);
    const out = io.readStdout();
    expect(out).toContain(`stopped ${a} (w1-t1-implementer-1)\n`);
    expect(out).not.toContain(`stopped ${launching} `);
    expect(alive(launching)).toBe(true);
  });

  /** A dev server the agent started: no `--mcp-config=` in its argv, its cwd in the worktree. */
  const devServer = (cwd: string): number => {
    mkdirSync(cwd, { recursive: true });
    const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", cwd });
    children.push(c);
    return c.pid as number;
  };

  it.skipIf(process.platform !== "linux")(
    "a process counted only by its cwd is stopped by --yes and listed by the dry run (#612 D3)",
    async () => {
      const { home, root } = setup();
      const dev = devServer(join(root, "w1", "T1-implementer", "web"));
      const liveDev = devServer(join(root, "w1", "T3-implementer"));
      // real process: let the fresh children reach their working directory
      await new Promise((r) => setTimeout(r, 100));
      const dry = makeBufferIO();
      await cleanupWave(home, "w1", { yes: false, force: false }, dry);
      expect(dry.readStdout()).toContain(`would stop ${dev} (w1-t1-implementer-1)\n`);
      expect(dry.readStdout()).not.toContain(`would stop ${liveDev} `);
      const io = makeBufferIO();
      await cleanupWave(home, "w1", { yes: true, force: false, reap: { graceMs: 2000 } }, io);
      expect(io.readStdout()).toContain(`stopped ${dev} (w1-t1-implementer-1)\n`);
      for (let i = 0; i < 50 && alive(dev); i++)
        // real process: the stopped child is reaped by this test's own process
        await new Promise((r) => setTimeout(r, 20));
      expect(alive(dev)).toBe(false);
      expect(alive(liveDev)).toBe(true);
    },
  );

  it("the dry run only says what it would stop", async () => {
    const { home, root } = setup();
    const a = sleeper(join(root, "w1", "T1-implementer"));
    const live = sleeper(join(root, "w1", "T3-implementer"));
    const launching = sleeper(join(root, "w1", "T4-implementer"));
    await listed([a, live, launching]);
    const io = makeBufferIO();
    await cleanupWave(home, "w1", { yes: false, force: false }, io);
    const out = io.readStdout();
    expect(out).toContain(`would stop ${a} (w1-t1-implementer-1)\n`);
    expect(out).not.toContain(`would stop ${live} `);
    expect(out).not.toContain(`would stop ${launching} `);
    expect(out).not.toMatch(/^stopped /m);
    expect(alive(a)).toBe(true);
  });
});

/** `volleyd cleanup` leaves an unfinished task's worktrees alone (a merge_ready task's PR is still read). */
describe("cleanup skips unfinished tasks", () => {
  /** Wave w1: T1 done, T2 merge_ready; every agent of both retired. */
  const setup = () => {
    const home = tempDir("volleyd-cleanup-stage-");
    const wave = parseWaveFile(
      [
        "wave: w1",
        `repo: ${join(home, "repo")}`,
        "release_branch: release/w1",
        "model: claude-opus-5-5",
        "pipeline: [implement, merge_ready]",
        "tasks:",
        "  T1: { issue: 1 }",
        "  T2: { issue: 2 }",
        "",
      ].join("\n"),
    );
    const j = Journal.open(join(home, "waves", "w1"));
    j.append({ type: "wave_submitted", data: { wave } });
    const wt = (task: string) => join(home, "wt", "w1", `${task}-implementer`);
    for (const [task, stage] of [
      ["T1", "done"],
      ["T2", "merge_ready"],
    ] as const) {
      const agent_id = `w1-${task.toLowerCase()}-implementer-1`;
      j.append({ type: "task_queued", task, data: { issue: 1 } });
      j.append({ type: "stage_entered", task, data: { stage: "implement" } });
      j.append({
        type: "agent_spawned",
        task,
        data: { agent_id, role: "implementer", worktree: wt(task) },
      });
      j.append({ type: "agent_retired", task, data: { agent_id, workspace_closed: true } });
      j.append({ type: "stage_entered", task, data: { stage } });
    }
    return { home, wt };
  };
  /** Answers every command with success; the worktrees "exist" (none are on disk). */
  const fake = () => {
    const argvs: string[][] = [];
    const run: ExecFn = async (argv) => {
      argvs.push([...argv]);
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
    return { argvs, run };
  };

  it("cleanupPlan keeps the merge_ready task's worktree out of the plan; --all puts it back", () => {
    const { home, wt } = setup();
    const { state, events } = readWave(home, "w1");
    const plan = cleanupPlan(state, events);
    expect(plan.targets.map((t) => t.worktree)).toEqual([wt("T1")]);
    expect(plan.held).toEqual([{ task: "T2", stage: "merge_ready" }]);
    const all = cleanupPlan(state, events, { all: true });
    expect(all.targets.map((t) => t.worktree)).toEqual([wt("T1"), wt("T2")]);
    expect(all.held).toEqual([]);
  });

  it("prints `skip T2: merge_ready` and touches only the done task's worktree; --all plans both", async () => {
    const { home, wt } = setup();
    const removed = (argvs: string[][]) =>
      argvs.filter((a) => a.includes("worktree") && a.includes("remove")).map((a) => a.at(-1));
    const io = makeBufferIO();
    const a = fake();
    await cleanupWave(home, "w1", { yes: true, force: false, exec: a.run }, io);
    expect(io.readStdout()).toContain("skip T2: merge_ready\n");
    // Not on disk: reported gone, never removed (and never the merge_ready task's).
    expect(io.readStdout()).toContain(`gone ${wt("T1")}\n`);
    expect(io.readStdout()).not.toContain(wt("T2"));
    expect(removed(a.argvs)).toEqual([]);

    const io2 = makeBufferIO();
    await cleanupWave(home, "w1", { yes: false, force: false, all: true }, io2);
    expect(io2.readStdout()).not.toContain("skip T2");
    expect(io2.readStdout()).toContain(`would remove ${wt("T1")}\n`);
    expect(io2.readStdout()).toContain(`would remove ${wt("T2")}\n`);
  });
});

describe("cleanup closes each local workspace in the terminal its agent ran in", () => {
  it("a tmux agent's session is killed with tmux, a cmux agent's workspace closed with cmux", async () => {
    const home = tempDir("volleyd-cleanup-terminal-");
    const j = Journal.open(join(home, "waves", "w1"));
    j.append({ type: "wave_submitted", data: { wave: minimalWave(join(home, "repo")) } });
    const spawned = [
      ["w1-t1-implementer-1", "T1-implementer", "volley-w1-T1-implementer", "tmux"],
      ["w1-t1-reviewer-1", "T1-reviewer", "workspace:7", undefined],
    ] as const;
    for (const [agent_id, dir, workspace, terminal] of spawned) {
      j.append({
        type: "agent_spawned",
        task: "T1",
        data: {
          agent_id,
          worktree: join(home, "wt", "w1", dir),
          workspace,
          ...(terminal !== undefined ? { terminal } : {}),
        },
      });
      j.append({ type: "agent_retired", task: "T1", data: { agent_id } });
    }
    const argvs: string[][] = [];
    const run: ExecFn = async (argv) => {
      argvs.push([...argv]);
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    };
    await cleanupWave(home, "w1", { yes: true, force: false, exec: run }, makeBufferIO());
    expect(argvs.filter((a) => a[0] === "tmux" || a[0] === "cmux")).toEqual([
      ["tmux", "kill-session", "-t", "=volley-w1-T1-implementer"],
      ["cmux", "close-workspace", "--workspace", "workspace:7"],
    ]);
  });
});
