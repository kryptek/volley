import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exec } from "../src/exec";
import type { ExecFn } from "../src/exec";
import { LSOF_ARGV } from "../src/fence";
import {
  listProcessesUnder,
  mcpConfigOf,
  parseLsofCwd,
  parsePs,
  reapUnder,
  sessionsRunningIn,
  stopProcesses,
  underRoot,
} from "../src/procs";
import { tempDir } from "./helpers/tmp";

/** The reaper that stops a retired agent's claude process, matched on its `--mcp-config=` argv. */

describe("procs (pure)", () => {
  it("parsePs reads pid and the full command line", () => {
    const long = `/usr/local/bin/claude --model x ${"a".repeat(3000)} --mcp-config=/r/w1/T1-implementer/.volley/mcp.json -- go`;
    expect(parsePs(`  101 /bin/zsh\n 2202 ${long}\n\n  junk\n`)).toEqual([
      { pid: 101, command: "/bin/zsh" },
      { pid: 2202, command: long },
    ]);
  });

  it("mcpConfigOf reads the launch form and quoted forms", () => {
    expect(
      mcpConfigOf("claude --strict-mcp-config --mcp-config=/r/w1/T1/.volley/mcp.json -- p"),
    ).toBe("/r/w1/T1/.volley/mcp.json");
    expect(mcpConfigOf("claude '--mcp-config='/r/a b/.volley/mcp.json")).toBeNull();
    expect(mcpConfigOf(`claude --mcp-config='/r/a b/.volley/mcp.json' -- p`)).toBe(
      "/r/a b/.volley/mcp.json",
    );
    expect(mcpConfigOf(`claude --mcp-config="/r/c/.volley/mcp.json"`)).toBe(
      "/r/c/.volley/mcp.json",
    );
    expect(mcpConfigOf("claude --mcp-config /r/c/.volley/mcp.json")).toBeNull();
    expect(mcpConfigOf("claude --no-mcp-config=/x")).toBeNull();
  });

  it("underRoot: inside the root, never a sibling with the same prefix or a path outside", () => {
    const root = tempDir("volleyd-procs-");
    mkdirSync(join(root, "w1"));
    mkdirSync(join(root, "w10"));
    expect(underRoot(join(root, "w1", "T1-fixup", ".volley", "mcp.json"), join(root, "w1"))).toBe(
      true,
    );
    expect(underRoot(join(root, "w1"), join(root, "w1"))).toBe(true);
    expect(underRoot(join(root, "w10", "T1-fixup"), join(root, "w1"))).toBe(false);
    expect(underRoot("/elsewhere/w1/T1", join(root, "w1"))).toBe(false);
  });

  it("underRoot never resolves the process's path, only the root (a protected folder blocks)", () => {
    const real = tempDir("volleyd-procs-real-");
    const alias = join(tempDir("volleyd-procs-alias-"), "link");
    symlinkSync(real, alias);
    mkdirSync(join(real, "w1"));
    // A root given through a symlink matches the resolved path the kernel reports, and the path
    // as written into an agent's argv.
    expect(underRoot(join(realpathSync(real), "w1", "T1"), join(alias, "w1"))).toBe(true);
    expect(underRoot(join(alias, "w1", "T1"), join(alias, "w1"))).toBe(true);
    // The path itself is never resolved: one that reaches the root only through a symlink is
    // outside (a path in a protected folder would block the caller).
    expect(underRoot(join(alias, "w1", "T1"), join(realpathSync(real), "w1"))).toBe(false);
  });

  it("stopProcesses: SIGTERM, then SIGKILL for what outlives the grace; gone pids skipped", async () => {
    const alive = new Set([1, 2]);
    const sent: [number, string | 0][] = [];
    const kill = (pid: number, sig: NodeJS.Signals | 0) => {
      if (!alive.has(pid)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      sent.push([pid, sig]);
      // 1 exits on SIGTERM; 2 ignores it.
      if ((pid === 1 && sig === "SIGTERM") || sig === "SIGKILL") alive.delete(pid);
    };
    const stopped = await stopProcesses([1, 2, 3], { kill, graceMs: 200 });
    expect(stopped).toEqual([
      { pid: 1, signal: "SIGTERM" },
      { pid: 2, signal: "SIGKILL" },
    ]);
    expect(sent.filter(([, s]) => s !== 0)).toEqual([
      [1, "SIGTERM"],
      [2, "SIGTERM"],
      [2, "SIGKILL"],
    ]);
  });
});

describe("sessionsRunningIn", () => {
  it("counts the agent sessions whose launch.sh runs them in that profile", async () => {
    const root = tempDir("volleyd-procs-");
    const wt = (name: string, profile: string | null) => {
      mkdirSync(join(root, name, ".volley"), { recursive: true });
      writeFileSync(
        join(root, name, ".volley", "launch.sh"),
        `#!/bin/bash\n${profile !== null ? `export CLAUDE_CONFIG_DIR='${profile}'\n` : ""}exec claude\n`,
      );
      return join(root, name, ".volley", "mcp.json");
    };
    const a = wt("a", "/p/claude/work");
    const b = wt("b", "/p/claude/work");
    const c = wt("c", "/p/claude/home");
    const d = wt("d", null);
    const ps: ExecFn = async () => ({
      code: 0,
      stdout: [a, b, c, d, `${root}/gone/.volley/mcp.json`]
        .map((m, i) => ` ${100 + i} claude --mcp-config=${m} -- go`)
        .join("\n"),
      stderr: "",
      timedOut: false,
    });
    expect(await sessionsRunningIn(ps, "/p/claude/work")).toBe(2);
    expect(await sessionsRunningIn(ps, "/p/claude/home")).toBe(1);
    expect(await sessionsRunningIn(ps, "/p/claude/none")).toBe(0);
  });
});

describe("reapUnder (real processes)", () => {
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

  /** A long-lived process whose argv carries `--mcp-config=<worktree>/.volley/mcp.json`. */
  const sleeper = (worktree: string): number => {
    const c = spawn(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)", "--", `--mcp-config=${worktree}/.volley/mcp.json`],
      { stdio: "ignore" },
    );
    children.push(c);
    return c.pid as number;
  };

  /** Until `ps` lists every pid (a fresh spawn can take a moment to show its final argv). */
  const listed = async (pids: number[]) => {
    for (let i = 0; i < 50; i++) {
      const r = await exec(["ps", "-axo", "pid=,command="]);
      const seen = parsePs(r.stdout).filter((p) => p.command.includes("--mcp-config="));
      if (pids.every((pid) => seen.some((p) => p.pid === pid))) return;
      // real process: waiting for ps to show the spawned sleepers
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  it("stops the processes under the wave's root and leaves one outside it", async () => {
    const dir = tempDir("volleyd-reap-");
    const a = sleeper(join(dir, "w1", "T1-implementer"));
    const b = sleeper(join(dir, "w1", "T2-fixup"));
    const c = sleeper(join(dir, "other", "T1-implementer"));
    const d = sleeper(join(dir, "w10", "T1-implementer"));
    await listed([a, b, c, d]);
    const r = await reapUnder(exec, join(dir, "w1"), { graceMs: 2000 });
    expect(r.stopped.map((s) => s.pid).sort()).toEqual([a, b].sort());
    expect(r.stopped.find((s) => s.pid === a)?.mcp).toBe(
      join(dir, "w1", "T1-implementer", ".volley", "mcp.json"),
    );
    expect(alive(c)).toBe(true);
    expect(alive(d)).toBe(true);
    for (let i = 0; i < 50 && (alive(a) || alive(b)); i++)
      // real process: the stopped sleepers are reaped by this test's own process
      await new Promise((r) => setTimeout(r, 20));
    expect(alive(a) || alive(b)).toBe(false);
  });

  it("an excluded worktree (a live agent's) is left alone", async () => {
    const dir = tempDir("volleyd-reap-");
    const a = sleeper(join(dir, "w1", "T1-implementer"));
    const b = sleeper(join(dir, "w1", "T2-fixup"));
    await listed([a, b]);
    const r = await reapUnder(exec, join(dir, "w1"), {
      graceMs: 2000,
      exclude: [join(dir, "w1", "T2-fixup")],
    });
    expect(r.stopped.map((s) => s.pid)).toEqual([a]);
    expect(alive(b)).toBe(true);
  });
});

describe("listProcessesUnder (by argv or by working directory)", () => {
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const c of children.splice(0)) {
      try {
        process.kill(c.pid as number, "SIGKILL");
      } catch {}
    }
  });

  /** A long-lived process started in `cwd`, with `argv` after the script. */
  const child = (cwd: string, argv: string[] = []): number => {
    const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", "--", ...argv], {
      stdio: "ignore",
      cwd,
    });
    children.push(c);
    return c.pid as number;
  };

  it.skipIf(process.platform !== "linux")(
    "finds a dev server by its cwd and an agent by its argv, never a <wt>10 sibling (Linux /proc)",
    async () => {
      const dir = tempDir("volleyd-cwd-");
      const wt = join(dir, "w1", "T1-implementer");
      mkdirSync(join(wt, "web"), { recursive: true });
      mkdirSync(`${wt}10`, { recursive: true });
      const dev = child(join(wt, "web"));
      const agent = child(dir, [`--mcp-config=${wt}/.volley/mcp.json`]);
      const sibling = child(`${wt}10`);
      let found: number[] = [];
      for (let i = 0; i < 50; i++) {
        found = (await listProcessesUnder(exec, [wt])).map((p) => p.pid);
        if (found.includes(dev) && found.includes(agent)) break;
        // real process: waiting for ps to list the fresh children
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(found).toContain(dev);
      expect(found).toContain(agent);
      expect(found).not.toContain(sibling);
      expect(found).not.toContain(process.pid);
      const excluded = (await listProcessesUnder(exec, [wt], { exclude: [join(wt, "web")] })).map(
        (p) => p.pid,
      );
      expect(excluded).not.toContain(dev);
      expect(excluded).toContain(agent);
    },
  );

  it("parseLsofCwd reads lsof's -F pn records", () => {
    expect(parseLsofCwd("p101\nfcwd\nn/r/w1/T1\np202\nfcwd\nn/\n")).toEqual(
      new Map([
        [101, "/r/w1/T1"],
        [202, "/"],
      ]),
    );
  });

  it("on macOS the cwd comes from the one fenced lsof argv", async () => {
    const calls: string[][] = [];
    const fake: ExecFn = async (argv) => {
      calls.push([...argv]);
      const stdout =
        argv[0] === "ps"
          ? "  11 npm run dev\n  12 claude --mcp-config=/r/w1/T2/.volley/mcp.json\n  13 vim\n"
          : "p11\nfcwd\nn/r/w1/T1/web\np12\nfcwd\nn/elsewhere\np13\nfcwd\nn/r/w1/T10\n";
      return { code: 0, stdout, stderr: "", timedOut: false };
    };
    const found = await listProcessesUnder(fake, ["/r/w1/T1", "/r/w1/T2"], { platform: "darwin" });
    expect(found.map((p) => p.pid)).toEqual([11, 12]);
    expect(calls).toEqual([["ps", "-axo", "pid=,command="], [...LSOF_ARGV]]);
    expect(LSOF_ARGV).toEqual(["lsof", "-a", "-d", "cwd", "-F", "pn"]);
  });
});
