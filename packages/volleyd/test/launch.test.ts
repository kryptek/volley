import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
  VOLLEY_MCP_SERVER,
  allowedMcpServers,
  approvedProjectServers,
  hooksSettingsPath,
  mcpConfigPath,
  renderLaunchScript,
  renderMcpConfig,
  strayVolleyServers,
} from "../src/launch";
import { spawnAgent } from "../src/spawn";
import { type SpawnEnv, makeSpawnEnv } from "./helpers/fake-host";
import { tempDir } from "./helpers/tmp";
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
    // A coordinator name exported in the person's profile never reaches a worker.
    expect(script).toContain("unset VOLLEY_COORDINATOR\n");
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
    const dir = tempDir("launch-check-");
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
    const root = join(realpathSync(tempDir("launch-profile-")), "claude");
    const restore = stubEnv({ VOLLEY_CLAUDE_DIR: root, VOLLEYD_HOME: join(root, "..", "vd") });
    try {
      underProfile(
        profileDir(root, addAccount(root, { label: "work" }, "2026-10-19T00:00:00Z").id),
      );
    } finally {
      restore();
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
    // The auto-compact window comes right after the profile's unset line, and seals.
    const compact = renderLaunchScript({ ...vars, autoCompactWindow: 850000 }).split("\n");
    const unset = compact.findIndex((l) => l.startsWith("unset ANTHROPIC_API_KEY"));
    expect(compact[unset + 1]).toBe("export CLAUDE_CODE_AUTO_COMPACT_WINDOW='850000'");
    expect(() => sealLaunchScript(vars.worktree, compact.join("\n"))).not.toThrow();
  }

  it("agent_mcp: inherit drops --strict-mcp-config but keeps volleyd's own `volley` server", () => {
    const vars = {
      hooksDir: "/opt/volley/packages/volley-hooks",
      model: "claude-opus-5-5",
      agentId: "w1-t1-implementer-1",
      worktree: "/wt/w1/T1-implementer",
      agentMcp: "inherit" as const,
    };
    const s = renderLaunchScript(vars);
    const exec = s.split("\n").find((l) => l.startsWith("exec claude ")) as string;
    // The user's MCP servers (plugins, connectors) load beside volleyd's...
    expect(exec).not.toContain("--strict-mcp-config");
    expect(exec).toContain(" --mcp-config='/wt/w1/T1-implementer/.volley/mcp.json' ");
    expect(exec.endsWith(' -- "$(cat .volley/brief.md)"')).toBe(true);
    // ...and that server is named `volley`, the name Claude Code lets an --mcp-config entry take
    // over from a user-scope one: an everyday `volley` (the coordinator's) never starts.
    expect(Object.keys(JSON.parse(renderMcpConfig(MCP_ENTRY)).mcpServers)).toEqual([
      VOLLEY_MCP_SERVER,
    ]);
    expect(VOLLEY_MCP_SERVER).toBe("volley");
    // `strict` (and absent) is the script as before.
    expect(renderLaunchScript({ ...vars, agentMcp: "strict" })).toBe(script);
    // The fence seals both; a script whose strict flag was swapped for another is refused.
    expect(() => sealLaunchScript(vars.worktree, s)).not.toThrow();
    expect(() => sealLaunchScript(vars.worktree, script)).not.toThrow();
    expect(() =>
      sealLaunchScript(vars.worktree, script.replace("--strict-mcp-config", "--debug")),
    ).toThrow(FenceError);
  });

  it("agent_mcp_allow: inherit with an allowlist launches strict, its mcp.json naming the allowed servers", () => {
    const vars = {
      hooksDir: "/opt/volley/packages/volley-hooks",
      model: "claude-opus-5-5",
      agentId: "w1-t1-implementer-1",
      worktree: "/wt/w1/T1-implementer",
    };
    const strict = renderLaunchScript(vars);
    // Only the named servers start: claude gets them in mcp.json and loads nothing else.
    const allowed = renderLaunchScript({ ...vars, agentMcp: "inherit", mcpAllow: ["x"] });
    expect(allowed).toContain(" --strict-mcp-config ");
    expect(allowed).toBe(strict);
    expect(() => sealLaunchScript(vars.worktree, allowed)).not.toThrow();
    // An empty list is every server, as before.
    expect(renderLaunchScript({ ...vars, agentMcp: "inherit", mcpAllow: [] })).not.toContain(
      "--strict-mcp-config",
    );
    // volleyd's `volley` comes first and is never replaced by an entry of that name.
    const migrations = { command: "npx", args: ["migrations-mcp"], env: { TOKEN: "t" } };
    const cfg = JSON.parse(renderMcpConfig(MCP_ENTRY, { migrations, volley: { command: "evil" } }));
    expect(cfg).toEqual({
      mcpServers: { volley: { command: "bun", args: ["run", MCP_ENTRY] }, migrations },
    });
    expect(Object.keys(cfg.mcpServers)).toEqual(["volley", "migrations"]);
  });

  it("allowedMcpServers: the named entries, a later source winning, and the names found nowhere", () => {
    const user = {
      mcpServers: { a: { command: "a" }, b: { command: "b-user" }, c: { command: "c" } },
    };
    const repo = { mcpServers: { b: { command: "b-repo" } } };
    expect(
      allowedMcpServers(
        ["b", "zzz", "volley"],
        [
          { source: "~/.claude.json", config: user },
          { source: ".mcp.json", config: repo },
          { source: ".mcp.json", config: null },
        ],
      ),
    ).toEqual({ servers: { b: { command: "b-repo" } }, missing: ["zzz"], malformed: [] });
  });

  it("allowedMcpServers: an entry of a shape a paired machine's fence refuses is skipped as malformed, and overrides a broader one", () => {
    const user = {
      mcpServers: {
        good: { command: "g", args: ["x"], env: { T: "t" } },
        numArg: { command: "n", args: [1] },
        numEnv: { command: "e", env: { T: 1 } },
        neither: { type: "stdio" },
        remote: { url: "https://x", headers: { A: "b" } },
        both: { command: "repo-bad" },
      },
    };
    const repo = { mcpServers: { both: { command: "c", args: [2] } } };
    expect(
      allowedMcpServers(
        ["good", "numArg", "numEnv", "neither", "remote", "both"],
        [
          { source: "~/.claude.json", config: user },
          { source: ".mcp.json", config: repo },
        ],
      ),
    ).toEqual({
      servers: {
        good: { command: "g", args: ["x"], env: { T: "t" } },
        remote: { url: "https://x", headers: { A: "b" } },
      },
      missing: [],
      malformed: ["numArg", "numEnv", "neither", "both"],
    });
  });

  it("approvedProjectServers: only the .mcp.json entries the profile approved for the repository", () => {
    const repo = { mcpServers: { a: { command: "a" }, b: { command: "b" }, c: { command: "c" } } };
    // No approval (a PR that adds .mcp.json): nothing of it is copied.
    expect(approvedProjectServers(repo, null)).toEqual({ mcpServers: {} });
    expect(approvedProjectServers(repo, { hasTrustDialogAccepted: true })).toEqual({
      mcpServers: {},
    });
    expect(approvedProjectServers(repo, { enabledMcpjsonServers: ["b", 1] })).toEqual({
      mcpServers: { b: { command: "b" } },
    });
    expect(
      approvedProjectServers(repo, {
        enableAllProjectMcpServers: true,
        disabledMcpjsonServers: ["c"],
      }),
    ).toEqual({ mcpServers: { a: { command: "a" }, b: { command: "b" } } });
    expect(
      approvedProjectServers(repo, {
        enabledMcpjsonServers: ["a"],
        disabledMcpjsonServers: ["a"],
      }),
    ).toEqual({ mcpServers: {} });
    expect(approvedProjectServers(null, { enableAllProjectMcpServers: true })).toBeNull();
  });

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

  it("agent_mcp: inherit (tunable) drops --strict-mcp-config; mcp.json's one server is `volley` and agent.json holds the agent's own id", async () => {
    env = await makeSpawnEnv();
    env.deps.tunables = { ...env.deps.tunables, agent_mcp: "inherit" };
    const out = await spawnAgent(env.request(), env.deps);
    expect(out.kind).toBe("launched");
    const script = readFileSync(join(env.worktree, ".volley", "launch.sh"), "utf-8");
    expect(script).not.toContain("--strict-mcp-config");
    expect(script).toContain(`--mcp-config='${join(env.worktree, ".volley", "mcp.json")}'`);
    // volleyd's server is named `volley` (it takes over a user-scope `volley` entry), and the
    // identity it reads is the agent's own, never a coordinator's.
    const mcp = JSON.parse(readFileSync(join(env.worktree, ".volley", "mcp.json"), "utf-8"));
    expect(Object.keys(mcp.mcpServers)).toEqual(["volley"]);
    const agent = JSON.parse(readFileSync(join(env.worktree, ".volley", "agent.json"), "utf-8"));
    expect(agent.agent_id).toBe("w1-t1-implementer-1");
    expect(agent.agent_id).not.toMatch(/^coordinator/);
    expect(env.events.find((e) => e.type === "agent_spawned")?.data).toMatchObject({
      agent_mcp: "inherit",
    });
  });

  it("agent_mcp: inherit warns (journal + log) about a volley-mcp server under another name", async () => {
    env = await makeSpawnEnv();
    const lines: string[] = [];
    env.deps.tunables = { ...env.deps.tunables, agent_mcp: "inherit" };
    env.deps.log = (line) => lines.push(line);
    const cfg = JSON.parse(readFileSync(env.claudeJson, "utf-8"));
    cfg.mcpServers = {
      volley: { command: "bunx", args: ["volley-mcp"] },
      "volley-coord": {
        command: "bun",
        args: ["run", "/opt/volley/packages/volley-mcp/src/index.ts"],
      },
      other: { command: "npx", args: ["some-server"] },
    };
    writeFileSync(env.claudeJson, JSON.stringify(cfg));
    mkdirSync(env.worktree, { recursive: true });
    writeFileSync(
      join(env.worktree, ".mcp.json"),
      JSON.stringify({ mcpServers: { vol: { command: "volley-mcp" } } }),
    );
    expect((await spawnAgent(env.request(), env.deps)).kind).toBe("launched");
    const alarm = env.events.find(
      (e) => e.type === "alarm_raised" && e.data.alarm === "agent_mcp_stray_volley",
    );
    expect(alarm?.data).toMatchObject({
      role: "implementer",
      agent_id: "w1-t1-implementer-1",
      servers: [
        { source: env.claudeJson, name: "volley-coord" },
        { source: ".mcp.json", name: "vol" },
      ],
    });
    expect(lines).toEqual([expect.stringContaining("'volley-coord'")]);
  });

  it("agent_mcp_allow: mcp.json holds volley plus the allowed servers (an approved .mcp.json entry and local scope win), launched strict", async () => {
    env = await makeSpawnEnv();
    const lines: string[] = [];
    env.deps.log = (line) => lines.push(line);
    env.deps.tunables = {
      ...env.deps.tunables,
      agent_mcp: "inherit",
      agent_mcp_allow: ["b", "c", "d"],
    };
    const cfg = JSON.parse(readFileSync(env.claudeJson, "utf-8"));
    // `claude mcp add` (local scope) keeps a server under the repository's project entry.
    cfg.projects[env.repo].mcpServers = { d: { command: "d-local" }, a: { command: "a-local" } };
    cfg.projects[env.repo].enabledMcpjsonServers = ["c"];
    cfg.mcpServers = {
      a: { command: "a" },
      b: { command: "b", env: { SECRET_TOKEN: "s3cret" } },
      c: { command: "c-user" },
    };
    writeFileSync(env.claudeJson, JSON.stringify(cfg));
    mkdirSync(env.worktree, { recursive: true });
    writeFileSync(
      join(env.worktree, ".mcp.json"),
      JSON.stringify({ mcpServers: { c: { command: "c-repo" } } }),
    );
    expect((await spawnAgent(env.request(), env.deps)).kind).toBe("launched");
    const mcp = JSON.parse(readFileSync(join(env.worktree, ".volley", "mcp.json"), "utf-8"));
    expect(mcp.mcpServers).toEqual({
      volley: { command: "bun", args: ["run", env.deps.mcpEntry] },
      b: { command: "b", env: { SECRET_TOKEN: "s3cret" } },
      c: { command: "c-repo" },
      d: { command: "d-local" },
    });
    // The copied entries carry the user's secrets: owner-only, like agent.json.
    expect(statSync(join(env.worktree, ".volley", "mcp.json")).mode & 0o777).toBe(0o600);
    const script = readFileSync(join(env.worktree, ".volley", "launch.sh"), "utf-8");
    expect(script).toContain(" --strict-mcp-config ");
    expect(env.events.find((e) => e.type === "agent_spawned")?.data).toMatchObject({
      agent_mcp: "inherit",
      agent_mcp_allow: ["b", "c", "d"],
    });
    // The entries' secrets are never journaled or logged: names only.
    expect(JSON.stringify(env.events)).not.toContain("s3cret");
    expect(lines.join("\n")).not.toContain("s3cret");
  });

  it("agent_mcp_allow: a .mcp.json entry the profile never approved is not copied (the user's entry stays)", async () => {
    env = await makeSpawnEnv();
    env.deps.tunables = {
      ...env.deps.tunables,
      agent_mcp: "inherit",
      agent_mcp_allow: ["playwright", "fresh"],
    };
    const cfg = JSON.parse(readFileSync(env.claudeJson, "utf-8"));
    cfg.mcpServers = { playwright: { command: "npx", args: ["@playwright/mcp"] } };
    writeFileSync(env.claudeJson, JSON.stringify(cfg));
    mkdirSync(env.worktree, { recursive: true });
    // The branch checked out (a PR head) brings its own .mcp.json.
    writeFileSync(
      join(env.worktree, ".mcp.json"),
      JSON.stringify({
        mcpServers: { playwright: { command: "evil" }, fresh: { command: "evil-too" } },
      }),
    );
    expect((await spawnAgent(env.request(), env.deps)).kind).toBe("launched");
    const mcp = JSON.parse(readFileSync(join(env.worktree, ".volley", "mcp.json"), "utf-8"));
    expect(mcp.mcpServers).toEqual({
      volley: { command: "bun", args: ["run", env.deps.mcpEntry] },
      playwright: { command: "npx", args: ["@playwright/mcp"] },
    });
    expect(
      env.events.find(
        (e) => e.type === "alarm_raised" && e.data.alarm === "agent_mcp_allow_missing",
      )?.data,
    ).toMatchObject({
      name: "fresh",
      message: expect.stringContaining("not approved for this repository"),
    });
  });

  it("agent_mcp_allow: a name found nowhere raises one agent_mcp_allow_missing alarm per wave; the spawn goes on", async () => {
    env = await makeSpawnEnv();
    env.deps.tunables = { ...env.deps.tunables, agent_mcp: "inherit", agent_mcp_allow: ["zzz"] };
    env.deps.journaled = (match) => env.events.some((e) => match(e));
    const out = await spawnAgent(env.request(), env.deps);
    expect(out.kind).toBe("launched");
    const mcp = JSON.parse(readFileSync(join(env.worktree, ".volley", "mcp.json"), "utf-8"));
    expect(Object.keys(mcp.mcpServers)).toEqual(["volley"]);
    if (out.kind === "launched") out.lock.release();
    expect((await spawnAgent(env.request({ attempt: 2 }), env.deps)).kind).toBe("launched");
    const alarms = env.events.filter(
      (e) => e.type === "alarm_raised" && e.data.alarm === "agent_mcp_allow_missing",
    );
    expect(alarms).toHaveLength(1);
    expect(alarms[0]?.data).toMatchObject({ name: "zzz" });
  });

  it("agent_mcp_allow: an unapproved .mcp.json entry of an odd shape is still reported as not approved", async () => {
    env = await makeSpawnEnv();
    env.deps.tunables = { ...env.deps.tunables, agent_mcp: "inherit", agent_mcp_allow: ["odd"] };
    mkdirSync(env.worktree, { recursive: true });
    writeFileSync(
      join(env.worktree, ".mcp.json"),
      JSON.stringify({ mcpServers: { odd: { command: "odd", args: [3000] } } }),
    );
    expect((await spawnAgent(env.request(), env.deps)).kind).toBe("launched");
    expect(
      env.events.find(
        (e) => e.type === "alarm_raised" && e.data.alarm === "agent_mcp_allow_missing",
      )?.data,
    ).toMatchObject({
      name: "odd",
      message: expect.stringContaining("not approved for this repository"),
    });
  });

  it("agent_mcp_allow: several missing names read the journal once per spawn", async () => {
    env = await makeSpawnEnv();
    env.deps.tunables = {
      ...env.deps.tunables,
      agent_mcp: "inherit",
      agent_mcp_allow: ["zz1", "zz2", "zz3"],
    };
    let reads = 0;
    env.deps.journaled = (match) => {
      reads++;
      return env.events.some((e) => match(e));
    };
    const out = await spawnAgent(env.request(), env.deps);
    if (out.kind === "launched") out.lock.release();
    expect(reads).toBe(1);
    expect((await spawnAgent(env.request({ attempt: 2 }), env.deps)).kind).toBe("launched");
    expect(reads).toBe(2);
    const alarms = env.events.filter(
      (e) => e.type === "alarm_raised" && e.data.alarm === "agent_mcp_allow_missing",
    );
    expect(alarms.map((a) => a.data.name)).toEqual(["zz1", "zz2", "zz3"]);
  });

  it("agent_mcp_allow: a malformed entry is skipped with the alarm; the good one is copied", async () => {
    env = await makeSpawnEnv();
    env.deps.tunables = {
      ...env.deps.tunables,
      agent_mcp: "inherit",
      agent_mcp_allow: ["ok", "odd"],
    };
    const cfg = JSON.parse(readFileSync(env.claudeJson, "utf-8"));
    cfg.mcpServers = { ok: { command: "ok" }, odd: { command: "odd", args: [3000] } };
    writeFileSync(env.claudeJson, JSON.stringify(cfg));
    expect((await spawnAgent(env.request(), env.deps)).kind).toBe("launched");
    const mcp = JSON.parse(readFileSync(join(env.worktree, ".volley", "mcp.json"), "utf-8"));
    expect(Object.keys(mcp.mcpServers)).toEqual(["volley", "ok"]);
    const alarms = env.events.filter(
      (e) => e.type === "alarm_raised" && e.data.alarm === "agent_mcp_allow_missing",
    );
    expect(alarms).toHaveLength(1);
    expect(alarms[0]?.data).toMatchObject({
      name: "odd",
      message: expect.stringContaining("cannot copy"),
    });
  });

  it("agent_mcp_allow: the missing-name alarm is per machine and names the machine", async () => {
    env = await makeSpawnEnv();
    env.deps.tunables = { ...env.deps.tunables, agent_mcp: "inherit", agent_mcp_allow: ["zzz"] };
    env.deps.journaled = (match) => env.events.some((e) => match(e));
    const out = await spawnAgent(env.request(), env.deps);
    if (out.kind === "launched") out.lock.release();
    const local = env.deps.host.name;
    env.deps.host = { ...env.deps.host, name: "box-b" };
    env.deps.remoteTrust = {
      host: "box-b",
      target: "dev@box-b",
      read: async () => ({
        projects: { [realpathSync(env.repo)]: { hasTrustDialogAccepted: true } },
      }),
    };
    expect((await spawnAgent(env.request({ attempt: 2 }), env.deps)).kind).toBe("launched");
    const alarms = env.events.filter(
      (e) => e.type === "alarm_raised" && e.data.alarm === "agent_mcp_allow_missing",
    );
    expect(alarms.map((a) => a.data.host)).toEqual([local, "box-b"]);
    expect(alarms[1]?.data.message).toContain("on box-b");
  });

  it("agent_mcp_allow: a stray volley under a local-scope name says it is local scope", async () => {
    env = await makeSpawnEnv();
    env.deps.tunables = { ...env.deps.tunables, agent_mcp: "inherit", agent_mcp_allow: ["vol2"] };
    const cfg = JSON.parse(readFileSync(env.claudeJson, "utf-8"));
    cfg.projects ??= {};
    cfg.projects[realpathSync(env.repo)] = {
      ...(cfg.projects[realpathSync(env.repo)] ?? {}),
      mcpServers: { vol2: { command: "bun", args: ["run", env.deps.mcpEntry] } },
    };
    writeFileSync(env.claudeJson, JSON.stringify(cfg));
    expect((await spawnAgent(env.request(), env.deps)).kind).toBe("launched");
    const stray = env.events.find(
      (e) => e.type === "alarm_raised" && e.data.alarm === "agent_mcp_stray_volley",
    );
    expect(stray?.data.message).toContain("local scope");
  });

  it("agent_mcp_allow on a paired machine reads the box's own ~/.claude.json", async () => {
    env = await makeSpawnEnv();
    env.deps.tunables = { ...env.deps.tunables, agent_mcp: "inherit", agent_mcp_allow: ["b"] };
    env.deps.remoteTrust = {
      host: "box-a",
      target: "dev@box-a",
      read: async () => ({
        projects: { [realpathSync(env.repo)]: { hasTrustDialogAccepted: true } },
        mcpServers: { a: { command: "a" }, b: { command: "b-remote" }, c: { command: "c" } },
      }),
    };
    expect((await spawnAgent(env.request(), env.deps)).kind).toBe("launched");
    const mcp = JSON.parse(readFileSync(join(env.worktree, ".volley", "mcp.json"), "utf-8"));
    expect(mcp.mcpServers).toEqual({
      volley: { command: "bun", args: ["run", env.deps.mcpEntry] },
      b: { command: "b-remote" },
    });
  });

  it("agent_mcp: strict never warns: no user server starts", async () => {
    env = await makeSpawnEnv();
    const cfg = JSON.parse(readFileSync(env.claudeJson, "utf-8"));
    cfg.mcpServers = { "volley-coord": { command: "bunx", args: ["volley-mcp"] } };
    writeFileSync(env.claudeJson, JSON.stringify(cfg));
    expect((await spawnAgent(env.request(), env.deps)).kind).toBe("launched");
    expect(env.events.filter((e) => e.type === "alarm_raised")).toEqual([]);
  });

  it("agent_mcp defaults to strict", async () => {
    env = await makeSpawnEnv();
    expect((await spawnAgent(env.request(), env.deps)).kind).toBe("launched");
    const script = readFileSync(join(env.worktree, ".volley", "launch.sh"), "utf-8");
    expect(script).toContain(" --strict-mcp-config ");
    expect(env.events.find((e) => e.type === "agent_spawned")?.data).not.toHaveProperty(
      "agent_mcp",
    );
  });

  it("agent_auto_compact_pct (default 85) exports the model's compact window after VOLLEY_HOOKS_DIR", async () => {
    env = await makeSpawnEnv();
    env.deps.tunables = { ...env.deps.tunables, agent_auto_compact_pct: 85 };
    expect((await spawnAgent(env.request(), env.deps)).kind).toBe("launched");
    const lines = readFileSync(join(env.worktree, ".volley", "launch.sh"), "utf-8").split("\n");
    const hooks = lines.findIndex((l) => l.startsWith("export VOLLEY_HOOKS_DIR="));
    expect(lines[hooks + 1]).toBe("export CLAUDE_CODE_AUTO_COMPACT_WINDOW='850000'");
    expect(lines.filter((l) => l.includes("CLAUDE_CODE_AUTO_COMPACT_WINDOW"))).toHaveLength(1);
    expect(env.events.find((e) => e.type === "agent_spawned")?.data).toMatchObject({
      auto_compact_window: 850000,
    });
  });

  it("agent_auto_compact_pct: 0 exports no compact window and journals none", async () => {
    env = await makeSpawnEnv();
    env.deps.tunables = { ...env.deps.tunables, agent_auto_compact_pct: 0 };
    expect((await spawnAgent(env.request(), env.deps)).kind).toBe("launched");
    const script = readFileSync(join(env.worktree, ".volley", "launch.sh"), "utf-8");
    expect(script).not.toContain("CLAUDE_CODE_AUTO_COMPACT_WINDOW");
    expect(env.events.find((e) => e.type === "agent_spawned")?.data).not.toHaveProperty(
      "auto_compact_window",
    );
  });

  it("launch.sh, run by bash, execs claude with the brief as one positional argument", async () => {
    await launchWithCmux();
    // A stand-in claude that records its argv and env.
    const bin = join(env.dir, "bin");
    mkdirSync(bin);
    const record = join(env.dir, "claude-args");
    writeFileSync(
      join(bin, "claude"),
      `#!/usr/bin/env bash\nprintf '%s\\0' "$VOLLEY_HOOKS_DIR" "$CLAUDE_CODE_AUTO_COMPACT_WINDOW" "$@" > ${JSON.stringify(record)}\n`,
    );
    chmodSync(join(bin, "claude"), 0o755);
    execFileSync("bash", [".volley/launch.sh"], {
      cwd: env.worktree,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: env.dir },
    });
    const [hooksDir, compact, ...args] = readFileSync(record, "utf-8").split("\0").slice(0, -1);
    const brief = readFileSync(join(env.worktree, ".volley", "brief.md"), "utf-8");
    expect(hooksDir).toBe("/opt/volley/packages/volley-hooks");
    expect(compact).toBe("850000");
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

describe("strayVolleyServers", () => {
  it("finds volley-mcp entries not named `volley`; skips `volley`, URL servers and others", () => {
    expect(
      strayVolleyServers([
        {
          source: "a",
          config: {
            mcpServers: {
              volley: { command: "bunx", args: ["volley-mcp"] },
              coord: { command: "bunx", args: ["volley-mcp@0.3.0"] },
              remote: { type: "http", url: "https://example.test/volley-mcp" },
              other: { command: "npx", args: ["x"] },
            },
          },
        },
        { source: "b", config: null },
        { source: "c", config: { mcpServers: "nope" } },
        { source: "d", config: { mcpServers: { v: { command: "/usr/bin/volley-mcp" } } } },
      ]),
    ).toEqual([
      { source: "a", name: "coord" },
      { source: "d", name: "v" },
    ]);
  });
});
