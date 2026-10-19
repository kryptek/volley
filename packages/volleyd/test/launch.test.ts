import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addAccount, profileDir } from "../src/claude/profiles";
import { FenceError, sealLaunchScript } from "../src/fence";
import { LocalCmuxHost } from "../src/hosts/local-cmux";
import {
  HOOKS_DIR,
  LAUNCH_CLAUDE_CHECK,
  LAUNCH_COMMAND,
  MCP_ENTRY,
  hooksSettingsPath,
  mcpConfigPath,
  renderLaunchScript,
  renderMcpConfig,
} from "../src/launch";
import { spawnAgent } from "../src/spawn";
import { type SpawnEnv, makeSpawnEnv } from "./helpers/fake-host";
import { stubEnv } from "./helpers/with-env";

describe("launch.sh", () => {
  const script = renderLaunchScript({
    hooksDir: "/opt/volley/packages/volley-hooks",
    model: "claude-opus-5-5",
    agentId: "w1-t1-implementer-1",
    worktree: "/wt/w1/T1-implementer",
  });

  it("is a bash script that exports VOLLEY_HOOKS_DIR and passes the hooks via --settings", () => {
    expect(script.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(script).toContain("export VOLLEY_HOOKS_DIR='/opt/volley/packages/volley-hooks'");
    expect(script).toContain(
      "--settings '/opt/volley/packages/volley-hooks/settings.volley-hooks.json'",
    );
    expect(script).toContain("--model 'claude-opus-5-5'");
    expect(script).toContain("--name 'w1-t1-implementer-1'");
    expect(script).toContain('"$(cat .volley/brief.md)"');
  });

  it("wires volleyd's own MCP server: --strict-mcp-config, the = form, then --, the prompt last", () => {
    const exec = script.split("\n").find((l) => l.startsWith("exec claude ")) as string;
    expect(exec).toContain(" --strict-mcp-config ");
    expect(exec).toContain(" --mcp-config='/wt/w1/T1-implementer/.volley/mcp.json' ");
    // never the variadic space form, which would swallow the prompt
    expect(exec).not.toMatch(/--mcp-config /);
    expect(exec.endsWith(' -- "$(cat .volley/brief.md)"')).toBe(true);
    expect(exec.indexOf("--strict-mcp-config")).toBeLessThan(exec.indexOf(" -- "));
    expect(mcpConfigPath("/wt/w1/T1-implementer")).toBe("/wt/w1/T1-implementer/.volley/mcp.json");
  });

  it("checks claude is on the session's PATH first: a missing one leaves the reason on screen", async () => {
    const lines = script.split("\n");
    expect(lines.at(-3)).toBe(LAUNCH_CLAUDE_CHECK);
    expect(LAUNCH_CLAUDE_CHECK).toContain("~/.zshenv");
    expect(() => sealLaunchScript("/wt/w1/T1-implementer", script)).not.toThrow();
    // Run it in bash with a PATH that has no claude: the reason is printed, and the session stays.
    const dir = mkdtempSync(join(tmpdir(), "launch-check-"));
    try {
      const probe = `${LAUNCH_CLAUDE_CHECK.replace("exec tail -f /dev/null", "exit 127")}\necho started\n`;
      const r = spawnSync("/bin/bash", ["-c", probe], {
        encoding: "utf-8",
        env: { PATH: dir },
      });
      expect(r.status).toBe(127);
      expect(r.stderr).toContain(
        "volleyd: cannot start the agent: claude is not on this session's PATH",
      );
      expect(r.stderr).toContain(dir);
      expect(r.stdout).not.toContain("started");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mcp.json runs this checkout's volley-mcp and holds no credential", () => {
    expect(MCP_ENTRY.endsWith("/packages/volley-mcp/src/index.ts")).toBe(true);
    expect(existsSync(MCP_ENTRY)).toBe(true);
    expect(JSON.parse(renderMcpConfig(MCP_ENTRY))).toEqual({
      mcpServers: { volley: { command: "bun", args: ["run", MCP_ENTRY] } },
    });
  });

  it("under a Claude account profile: exports CLAUDE_CONFIG_DIR and strips credential env", () => {
    // A registered profile in the profiles root: the only CLAUDE_CONFIG_DIR the fence seals.
    const root = join(realpathSync(mkdtempSync(join(tmpdir(), "launch-profile-"))), "claude");
    const restore = stubEnv({ VOLLEY_CLAUDE_DIR: root, VOLLEYD_HOME: join(root, "..", "vd") });
    try {
      underProfile(
        profileDir(root, addAccount(root, { label: "work" }, "2026-10-19T00:00:00Z").id),
      );
    } finally {
      restore();
      rmSync(join(root, ".."), { recursive: true, force: true });
    }
  });

  function underProfile(claudeConfigDir: string) {
    const vars = {
      hooksDir: "/opt/volley/packages/volley-hooks",
      model: "claude-opus-5-5",
      agentId: "w1-t1-implementer-1",
      worktree: "/wt/w1/T1-implementer",
      claudeConfigDir,
    };
    const s = renderLaunchScript(vars);
    const lines = s.split("\n");
    expect(lines).toContain(`export CLAUDE_CONFIG_DIR='${claudeConfigDir}'`);
    expect(lines).toContain(
      "unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN CLAUDE_SECURESTORAGE_CONFIG_DIR",
    );
    expect(lines.findIndex((l) => l.startsWith("export CLAUDE_CONFIG_DIR"))).toBeLessThan(
      lines.findIndex((l) => l.startsWith("exec claude")),
    );
    // The fence seals it like any other launch script; a tampered profile line is refused.
    expect(() => sealLaunchScript(vars.worktree, s)).not.toThrow();
    expect(() =>
      sealLaunchScript(vars.worktree, s.replace(`'${claudeConfigDir}'`, "'relative/dir'")),
    ).toThrow(FenceError);
    expect(() => sealLaunchScript(vars.worktree, s.replace(/^unset .*$/m, "unset PATH"))).toThrow(
      FenceError,
    );
    // The primary profile: no CLAUDE_CONFIG_DIR line at all.
    expect(script).not.toContain("CLAUDE_CONFIG_DIR");
  }

  it("the hooks settings template exists where HOOKS_DIR points", () => {
    expect(JSON.parse(readFileSync(hooksSettingsPath(HOOKS_DIR), "utf-8")).hooks).toBeDefined();
  });
});

describe("launch (local cmux host)", () => {
  let env: SpawnEnv;
  afterEach(() => env.cleanup());

  async function launchWithCmux() {
    env = await makeSpawnEnv();
    const fake = env.host.fake
      .on(["git", "-C", env.repo, "rev-parse", "--git-common-dir"], { stdout: ".git\n" })
      // the release branch, local and on origin at the same commit
      .on(["git", "-C", env.repo, "rev-parse", "--verify", "--quiet", "refs/heads/release/w1"], {
        stdout: `${"a".repeat(40)}\n`,
      })
      .on(
        [
          "git",
          "-C",
          env.repo,
          "rev-parse",
          "--verify",
          "--quiet",
          "refs/remotes/origin/release/w1",
        ],
        { stdout: `${"a".repeat(40)}\n` },
      )
      .on(["cmux", "new-workspace"], { stdout: "OK workspace:7\n" });
    env.deps.host = new LocalCmuxHost(fake.exec);
    const out = await spawnAgent(env.request(), env.deps);
    return { out, fake };
  }

  it("cmux --command is exactly '  bash .volley/launch.sh' and no argv carries the brief", async () => {
    const { out, fake } = await launchWithCmux();
    expect(out.kind).toBe("launched");
    if (out.kind === "launched") expect(out.workspace).toBe("workspace:7");
    const cmux = fake.argvs(["cmux", "new-workspace"]);
    expect(cmux).toEqual([
      [
        "cmux",
        "new-workspace",
        "--cwd",
        env.worktree,
        "--name",
        "w1 T1 implementer",
        "--command",
        "  bash .volley/launch.sh",
      ],
    ]);
    expect(LAUNCH_COMMAND).toBe("  bash .volley/launch.sh");
    const brief = readFileSync(join(env.worktree, ".volley", "brief.md"), "utf-8");
    const line = brief.split("\n").find((l) => l.includes("Volley protocol")) as string;
    for (const c of fake.calls) {
      expect(c.argv.join("\n")).not.toContain(line);
      expect(c.argv.join(" ")).not.toContain("--mcp-config");
    }
    // nothing but the launch command is ever typed into the pane
    expect(fake.argvs(["cmux", "send"])).toEqual([]);
    expect(fake.argvs(["cmux", "send-key"])).toEqual([]);
  });

  it("writes .volley/mcp.json for volleyd's MCP server; no credential in it or in launch.sh", async () => {
    const { out } = await launchWithCmux();
    expect(out.kind).toBe("launched");
    const mcp = readFileSync(join(env.worktree, ".volley", "mcp.json"), "utf-8");
    expect(JSON.parse(mcp)).toEqual({
      mcpServers: { volley: { command: "bun", args: ["run", env.deps.mcpEntry] } },
    });
    const script = readFileSync(join(env.worktree, ".volley", "launch.sh"), "utf-8");
    const agent = JSON.parse(readFileSync(join(env.worktree, ".volley", "agent.json"), "utf-8"));
    const password = agent.broker.password as string;
    expect(password).toMatch(/^pw-/);
    for (const text of [mcp, script]) {
      expect(text).not.toContain(password);
      expect(text).not.toContain("VOLLEY_AUTH");
    }
    expect(script).toContain(`--mcp-config='${join(env.worktree, ".volley", "mcp.json")}'`);
  });

  it("cuts the worktree from the release branch and keeps .volley/ out of git", async () => {
    const { out, fake } = await launchWithCmux();
    // the release branch is fetched first, so a branch pushed from another clone is found
    expect(fake.argvs(["git", "-C", env.repo, "fetch"])).toEqual([
      ["git", "-C", env.repo, "fetch", "--quiet", "origin", "release/w1"],
    ]);
    expect(fake.argvs(["git", "-C", env.repo, "worktree", "add"])).toEqual([
      [
        "git",
        "-C",
        env.repo,
        "worktree",
        "add",
        env.worktree,
        "-b",
        "w1/T1-implementer-1",
        "release/w1",
      ],
    ]);
    const exclude = readFileSync(join(env.repo, ".git", "info", "exclude"), "utf-8");
    expect(exclude.split("\n")).toContain(".volley/");
    // once only, however often agents are spawned into the repo
    if (out.kind === "launched") out.lock.release();
    fake
      .on(["git", "-C", env.worktree, "rev-parse", "--is-inside-work-tree"], { stdout: "true\n" })
      .on(["git", "-C", env.worktree, "rev-parse", "--abbrev-ref", "HEAD"], {
        stdout: "w1/T1-implementer-1\n",
      });
    expect((await spawnAgent(env.request({ attempt: 2 }), env.deps)).kind).toBe("launched");
    // a reused worktree reports the branch it really has
    const reused = env.events.filter((e) => e.type === "agent_spawned").at(-1);
    expect(reused?.data).toMatchObject({ worktree_reused: true, branch: "w1/T1-implementer-1" });
    expect(fake.argvs(["git", "-C", env.repo, "worktree", "add"])).toHaveLength(1);
    const again = readFileSync(join(env.repo, ".git", "info", "exclude"), "utf-8");
    expect(again.split("\n").filter((l) => l === ".volley/")).toHaveLength(1);
  });

  it("launch.sh, run by bash, execs claude with the brief as one positional argument", async () => {
    await launchWithCmux();
    // A stand-in claude that records its argv and env.
    const bin = join(env.dir, "bin");
    mkdirSync(bin);
    const record = join(env.dir, "claude-args");
    writeFileSync(
      join(bin, "claude"),
      `#!/usr/bin/env bash\nprintf '%s\\0' "$VOLLEY_HOOKS_DIR" "$@" > ${JSON.stringify(record)}\n`,
    );
    chmodSync(join(bin, "claude"), 0o755);
    execFileSync("bash", [".volley/launch.sh"], {
      cwd: env.worktree,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: env.dir },
    });
    const [hooksDir, ...args] = readFileSync(record, "utf-8").split("\0").slice(0, -1);
    const brief = readFileSync(join(env.worktree, ".volley", "brief.md"), "utf-8");
    expect(hooksDir).toBe("/opt/volley/packages/volley-hooks");
    expect(args).toEqual([
      "--dangerously-skip-permissions",
      "--model",
      "claude-opus-5-5",
      "--settings",
      "/opt/volley/packages/volley-hooks/settings.volley-hooks.json",
      "--strict-mcp-config",
      `--mcp-config=${join(env.worktree, ".volley", "mcp.json")}`,
      "--name",
      "w1-t1-implementer-1",
      "--",
      brief.replace(/\n+$/, ""), // $(…) strips trailing newlines
    ]);
  });
});
