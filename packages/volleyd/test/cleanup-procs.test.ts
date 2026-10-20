import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupWave } from "../src/commands/cleanup";
import { exec } from "../src/exec";
import { makeBufferIO } from "../src/io";
import { Journal } from "../src/journal";
import { parsePs } from "../src/procs";
import { tempDir } from "./helpers/tmp";

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
    j.append({ type: "wave_submitted", data: { wave: { repo: join(home, "repo") } } });
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
