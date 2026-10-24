import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setup } from "../../src/commands/setup";
import { makeBufferIO } from "../../src/io";
import {
  COORDINATOR_QUESTION,
  MCP_REMOVE,
  defaultCoordinator,
  planClaudeCode,
} from "../../src/setup/claude-code";
import { readSetupInstall } from "../../src/setup/journal";
import { setupFence } from "../../src/setup/step";
import { type FakeDynsec, startFakeDynsec } from "../helpers/fake-dynsec";
import { type FakeMachine, NOW, fakeMachine } from "../helpers/setup-machine";
import { tempDir } from "../helpers/tmp";

describe("the Claude Code step", () => {
  let fake: FakeDynsec;
  let m: FakeMachine;
  beforeEach(async () => {
    fake = await startFakeDynsec();
    m = fakeMachine(fake, tempDir("volley-claude-code-"));
  });
  afterEach(async () => {
    await fake.close();
  });

  const repo = () => m.deps.repoRoot as string;
  const entry = () => join(repo(), "packages", "volley-mcp", "src", "index.ts");
  const volleyEntry = () =>
    (JSON.parse(readFileSync(m.claudeJson, "utf-8")) as { mcpServers: Record<string, unknown> })
      .mcpServers.volley;
  const applyAll = async () => {
    const plan = await planClaudeCode(m.ctx);
    for (const c of plan.changes) await c.apply();
    return { plan, problems: (await plan.verify?.()) ?? [] };
  };
  const run = async (argv: string[]) => {
    const io = makeBufferIO({ now: () => new Date(NOW) });
    const env = {
      HOME: m.ctx.home,
      VOLLEYD_HOME: m.ctx.volleydHome,
      VOLLEY_AUTH_DIR: m.layout.authDir,
      VOLLEY_BROKER_URL: fake.url,
    };
    const code = await setup({ argv, env, io }, m.deps);
    return { code, stdout: io.readStdout(), stderr: io.readStderr() };
  };

  it("a fresh profile: `claude mcp add-json -s user volley` with non-secret env only", async () => {
    m.ctx.yes = true;
    const { problems } = await applyAll();
    expect(problems).toEqual([]);
    const add = m.execCalls.find((a) => a[0] === "claude" && a[2] === "add-json") as string[];
    expect(add.slice(0, 6)).toEqual(["claude", "mcp", "add-json", "-s", "user", "volley"]);
    expect(JSON.parse(add[6] as string)).toEqual({
      type: "stdio",
      command: "bun",
      args: ["run", entry()],
      env: {
        VOLLEY_AGENT_ID: "coordinator",
        VOLLEY_COORDINATOR: "coord-studio",
        VOLLEY_NAMESPACE: "default",
        VOLLEY_BROKER_URL: m.ctx.tcpUrl,
        VOLLEY_AUTH_DIR: m.ctx.auth.dir,
      },
    });
    expect(readFileSync(m.claudeJson, "utf-8")).not.toMatch(/PASSWORD|"password"/);
  });

  it("an entry with the person's own keys is left alone, and the command that replaces it printed", async () => {
    const own = {
      command: "bun",
      args: ["run", entry()],
      env: { VOLLEY_AGENT_ID: "coordinator", VOLLEY_AUTH_PASSWORD: "hunter2-secret" },
    };
    writeFileSync(m.claudeJson, JSON.stringify({ mcpServers: { volley: own } }));
    const plan = await planClaudeCode(m.ctx);
    expect(plan.changes.some((c) => c.summary.includes("MCP"))).toBe(false);
    const note = plan.found.find((f) => f.includes("settings of its own")) as string;
    expect(note).toContain("VOLLEY_AUTH_PASSWORD");
    expect(note).toContain(MCP_REMOVE.join(" "));
    expect(JSON.stringify(plan)).not.toContain("hunter2");
    expect(volleyEntry()).toEqual(own);
  });

  it("--broker-url rewrites VOLLEY_BROKER_URL in an existing entry and in the hooks", async () => {
    m.ctx.yes = true;
    await applyAll();
    m.ctx.tcpUrl = "mqtt://10.0.0.5:1883";
    m.ctx.brokerFlag = "mqtt://10.0.0.5:1883";
    const plan = await planClaudeCode(m.ctx);
    expect(plan.changes.map((c) => c.summary)).toEqual([
      "Re-register the volley MCP server with Claude Code (VOLLEY_BROKER_URL differs; no password in it)",
      `Install the Volley hooks for coordinator sessions into ${m.settingsFile} (for mqtt://10.0.0.5:1883)`,
    ]);
    for (const c of plan.changes) await c.apply();
    expect((volleyEntry() as { env: Record<string, string> }).env.VOLLEY_BROKER_URL).toBe(
      "mqtt://10.0.0.5:1883",
    );
    expect(readFileSync(m.settingsFile, "utf-8")).toContain(
      "VOLLEY_BROKER_URL=mqtt://10.0.0.5:1883 ",
    );
    // A later run without the flag keeps both.
    const { brokerFlag: _flag, ...rest } = m.ctx;
    m.ctx = rest;
    expect((await planClaudeCode(m.ctx)).changes.map((c) => c.summary)).toEqual([]);
  });

  it("links the three skills through their installers; a folder of its own is backed up, not replaced", async () => {
    const skills = join(m.ctx.home, ".claude", "skills");
    mkdirSync(join(skills, "volley-wait"), { recursive: true });
    writeFileSync(join(skills, "volley-wait", "SKILL.md"), "mine\n");
    m.ctx.yes = true;
    const plan = await planClaudeCode(m.ctx);
    expect(plan.changes.find((c) => c.summary.startsWith("Link"))?.summary).toContain(
      "volley-wait: a folder of its own (backed up, not replaced)",
    );
    for (const c of plan.changes) await c.apply();
    for (const [name, pkg] of [
      ["volley", "volley-skill"],
      ["volley-issues", "volley-issues"],
      ["volley-wait", "volley-wait"],
    ]) {
      expect(lstatSync(join(skills, name as string)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(skills, name as string))).toBe(
        join(repo(), "packages", pkg as string),
      );
    }
    const backup = readdirSync(skills).find((f) => f.startsWith("volley-wait.backup."));
    expect(readFileSync(join(skills, backup as string, "SKILL.md"), "utf-8")).toBe("mine\n");
    expect(m.execCalls).toContainEqual([
      "bash",
      join(repo(), "packages", "volley-wait", "scripts", "install.sh"),
    ]);
  });

  it("installs the hooks", async () => {
    m.ctx.yes = true;
    await applyAll();
    expect(readFileSync(m.settingsFile, "utf-8")).toContain("volley-hooks");
  });

  it("asks for the coordinator name once (validated), saves it; later runs do not ask", async () => {
    m.typed = ["Not Valid!", "coord-main"];
    const out = m.freshIO();
    const plan = await planClaudeCode(m.ctx);
    expect(m.asked).toEqual([
      COORDINATOR_QUESTION("coord-studio"),
      COORDINATOR_QUESTION("coord-studio"),
    ]);
    expect(out.readStdout()).toContain('"Not Valid!" is not one');
    for (const c of plan.changes) await c.apply();
    expect(readSetupInstall(m.ctx.volleydHome)?.coordinator).toBe("coord-main");
    m.asked = [];
    // A later run (a fresh context) reads the name from setup.json.
    const { coordinator: _name, ...later } = m.ctx;
    const again = await planClaudeCode(later);
    expect(m.asked).toEqual([]);
    expect(again.changes).toEqual([]);
    expect(again.row).toContain("✓ coordinator: coord-main");
  });

  it("Enter takes the default; --yes and --check never ask", async () => {
    m.typed = [""];
    await planClaudeCode(m.ctx);
    expect(m.asked).toHaveLength(1);
    m.asked = [];
    await planClaudeCode({ ...m.ctx, yes: true });
    await planClaudeCode({ ...m.ctx, check: true });
    expect(m.asked).toEqual([]);
  });

  it("the default name is coord-<this machine, slugged>", () => {
    expect(defaultCoordinator("Studio.local")).toBe("coord-studio");
    expect(defaultCoordinator("Dev's MacBook Pro")).toBe("coord-dev-s-macbook-pro");
    expect(defaultCoordinator("---")).toBe("coord-main");
    expect(defaultCoordinator("x".repeat(100))).toMatch(/^[a-z0-9][a-z0-9_-]{0,62}$/);
  });

  it("the whole run counts the name as a question and the hooks are not planned twice", async () => {
    m.answers = [true, true, true, true, true, true, true, true];
    m.typed = ["coord-main"];
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("(9 questions, 0 sign-ins, 0 sudo)");
    expect(
      m.execCalls.filter(
        (a) =>
          a[0] === "bash" && a[1]?.endsWith("volley-hooks/scripts/install.sh") && a.length === 2,
      ),
    ).toHaveLength(1);
  });

  it("the fence allows the volley entry's `claude mcp` commands, and refuses a registration carrying a password", () => {
    const fence = setupFence({ restart: "x", repoRoot: "/path/to/repo", bun: "bun" });
    const add = (env: Record<string, string>) => [
      "claude",
      "mcp",
      "add-json",
      "-s",
      "user",
      "volley",
      JSON.stringify({ command: "bun", args: [], env }),
    ];
    expect(() => fence(add({ VOLLEY_AUTH_DIR: "/path/to/auth" }))).not.toThrow();
    expect(() => fence(["claude", "mcp", "get", "volley"])).not.toThrow();
    expect(() => fence(["claude", "mcp", "remove", "-s", "user", "volley"])).not.toThrow();
    expect(() => fence(add({ VOLLEY_AUTH_PASSWORD: "x" }))).toThrow(/does not run/);
    // Nor a login in a value: a broker URL with user:pw@.
    expect(() => fence(add({ VOLLEY_BROKER_URL: "mqtt://coord:pw@broker.example:1883" }))).toThrow(
      /does not run/,
    );
    expect(() => fence(add({ VOLLEY_BROKER_URL: "mqtt://broker.example:1883" }))).not.toThrow();
    expect(() => fence(["claude", "mcp", "remove", "-s", "user", "github"])).toThrow(
      /does not run/,
    );
    expect(() =>
      fence(["bash", "/path/to/repo/packages/volley-wait/scripts/install.sh"]),
    ).not.toThrow();
    expect(() =>
      fence([
        "bash",
        "/path/to/repo/packages/volley-hooks/scripts/install.sh",
        "--broker-url",
        "mqtt://h:1883",
        "--dry-run",
      ]),
    ).not.toThrow();
    expect(() =>
      fence(["bash", "/path/to/repo/packages/volley-hooks/scripts/install.sh", "--uninstall"]),
    ).toThrow(/does not run/);
  });
});
