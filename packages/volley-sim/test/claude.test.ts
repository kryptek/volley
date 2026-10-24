import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { CLAUDE_VERSION, runClaude } from "../src/claude";
import { SIM_BIN } from "../src/env";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { git, makeRepo } from "./helpers/repo";
import { tempDir } from "./helpers/tmp";

let home: string;
let config: string;
let dir: string;
const env = () => ({ VOLLEY_SIM_HOME: home, VOLLEY_SIMULATED: "1", CLAUDE_CONFIG_DIR: config });
const claude = (argv: string[], cwd = dir) => runClaude(argv, { cwd, env: env() });
/** `mcpServers` of the profile's `.claude.json`, read the way peer/provision.ts reads it. */
const servers = () =>
  (JSON.parse(readFileSync(join(config, ".claude.json"), "utf8")) as { mcpServers?: unknown })
    .mcpServers;

beforeEach(() => {
  dir = tempDir("volley-sim-claude-");
  home = join(dir, "sim");
  config = join(dir, "profile");
  mkdirSync(config);
});

describe("claude auth", () => {
  it("reports signed out until `claude auth login` ran once", async () => {
    const out = await claude(["auth", "status"]);
    expect(out.code).toBe(1);
    expect(JSON.parse(out.stdout)).toMatchObject({ loggedIn: false });
    expect((await claude(["auth", "login"])).code).toBe(0);
    const s = await claude(["auth", "status"]);
    expect(s.code).toBe(0);
    expect(JSON.parse(s.stdout)).toMatchObject({ loggedIn: true, subscriptionType: "max" });
    // Another profile (CLAUDE_CONFIG_DIR) is its own login.
    const other = await runClaude(["auth", "status"], {
      cwd: dir,
      env: { ...env(), CLAUDE_CONFIG_DIR: join(dir, "other") },
    });
    expect(other.code).toBe(1);
  });

  it("`--version` prints a plausible Claude Code version", async () => {
    const r = await claude(["--version"]);
    expect(r).toMatchObject({ code: 0, stdout: `${CLAUDE_VERSION} (Claude Code)\n` });
    expect(CLAUDE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("claude mcp", () => {
  it("add-json / list / get / remove keep mcpServers in $CLAUDE_CONFIG_DIR/.claude.json", async () => {
    const entry = { type: "stdio", command: "bun", args: ["run", "/path/to/index.ts"], env: {} };
    const add = await claude(["mcp", "add-json", "-s", "user", "volley", JSON.stringify(entry)]);
    expect(add.code).toBe(0);
    expect(servers()).toEqual({ volley: entry });
    expect((await claude(["mcp", "list"])).stdout).toContain("volley: bun run /path/to/index.ts");
    expect((await claude(["mcp", "get", "volley"])).code).toBe(0);
    expect((await claude(["mcp", "get", "nope"])).code).toBe(1);
    expect(await claude(["mcp", "add-json", "-s", "user", "bad", "{not json"])).toMatchObject({
      code: 1,
    });
    expect((await claude(["mcp", "remove", "-s", "user", "volley"])).code).toBe(0);
    expect(servers()).toEqual({});
    expect((await claude(["mcp", "remove", "-s", "user", "volley"])).code).toBe(1);
  });

  it("keeps the rest of .claude.json as it was", async () => {
    writeFileSync(join(config, ".claude.json"), JSON.stringify({ projects: { "/x": {} } }));
    await claude(["mcp", "add-json", "-s", "user", "v", JSON.stringify({ command: "x" })]);
    const j = JSON.parse(readFileSync(join(config, ".claude.json"), "utf8"));
    expect(j).toEqual({ projects: { "/x": {} }, mcpServers: { v: { command: "x" } } });
  });
});

describe("claude launched the way volleyd's launch.sh does", () => {
  let broker: TestBroker;
  let watcher: VolleyBroker;
  beforeEach(async () => {
    broker = await startTestBroker();
    watcher = new VolleyBroker();
    await watcher.connect({ url: broker.url, agentId: "watcher" });
  });
  afterEach(async () => {
    await watcher.disconnect();
    await broker.close();
  });

  it("runs the simulated agent from the worktree's .volley/agent.json", async () => {
    const { work } = makeRepo(dir);
    git(work, "checkout", "-b", "w1/r1-spec_reviewer-1");
    mkdirSync(join(work, ".volley"));
    const id = "w1-r1-spec_reviewer-1";
    writeFileSync(
      join(work, ".volley", "agent.json"),
      JSON.stringify({
        agent_id: id,
        namespace: "default",
        parent_id: "volleyd",
        wave: "w1",
        task: "R1",
        role: "spec_reviewer",
        broker_url: broker.url,
      }),
    );
    writeFileSync(join(work, ".volley", "brief.md"), "# Review R1\n");
    const code = await new Promise<number | null>((resolve) => {
      const p = spawn(
        join(SIM_BIN, "claude"),
        [
          "--dangerously-skip-permissions",
          "--model",
          "claude-opus-5-5",
          "--settings",
          "/path/to/settings.json",
          "--strict-mcp-config",
          `--mcp-config=${join(work, ".volley", "mcp.json")}`,
          "--name",
          id,
          "--",
          "# Review R1",
        ],
        {
          cwd: work,
          env: { ...process.env, ...env(), VOLLEY_SIM_AGENT_LINGER: "0" },
          stdio: "ignore",
        },
      );
      p.on("close", resolve);
    });
    expect(code).toBe(0);
    const status = await watcher.queryRetained(`volley/default/${id}/status`, 2000);
    expect(JSON.parse(status as string)).toMatchObject({ type: "done", agent_id: id });
    const result = await watcher.queryRetained(`volley/default/${id}/result`, 2000);
    expect(JSON.parse(result as string)).toMatchObject({
      type: "review",
      payload: { verdict: "approve", findings: [] },
    });
  }, 30000);

  it("without .volley/agent.json, an argv it does not model is an unknown argv", async () => {
    const r = await claude(["-p", "hello"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^unknown argv: claude -p hello/);
    expect(readFileSync(join(home, "unknown.jsonl"), "utf8")).toContain('"claude","-p","hello"');
  });
});
