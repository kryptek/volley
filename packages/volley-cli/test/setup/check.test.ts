import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pkg from "../../package.json";
import { setup } from "../../src/commands/setup";
import { makeBufferIO } from "../../src/io";
import { type FakeDynsec, startFakeDynsec } from "../helpers/fake-dynsec";
import { type FakeMachine, NOW, fakeMachine } from "../helpers/setup-machine";
import { tempDir } from "../helpers/tmp";

/** Commands that only read state. */
const READ_ONLY = (a: string[]) =>
  a.includes("--dry-run") ||
  (a[0] === "launchctl" && a[1] === "print") ||
  (a[0] === "security" && a[1] === "find-generic-password") ||
  a[0] === "lsof" ||
  a[0] === "ss" ||
  (a[0] === "claude" && a[1] === "auth" && a[2] === "status") ||
  (a[0] === "gh" && a[1] === "auth" && a[2] === "status") ||
  (a[0] === "gh" && a[1] === "api" && a[2] === "user");

const STEP_NAMES = [
  "detect",
  "security",
  "accounts",
  "signin",
  "claude-code",
  "terminal",
  "services",
  "phone",
];

describe("volley setup --check", () => {
  let dir: string;
  let fake: FakeDynsec;
  let m: FakeMachine;
  beforeEach(async () => {
    dir = tempDir("volley-check-");
    fake = await startFakeDynsec();
    m = fakeMachine(fake, dir);
  });
  afterEach(async () => {
    await fake.close();
  });

  const env = () => ({
    HOME: m.ctx.home,
    VOLLEYD_HOME: m.ctx.volleydHome,
    VOLLEY_AUTH_DIR: m.layout.authDir,
    VOLLEY_BROKER_URL: fake.url,
  });
  const run = async (argv: string[]) => {
    const io = makeBufferIO({ now: () => new Date(NOW) });
    const code = await setup({ argv, env: env(), io }, m.deps);
    return { code, stdout: io.readStdout(), stderr: io.readStderr() };
  };

  it("on a fresh machine: one row per step, pending with its changes; exits 1; runs only reads and asks nothing", async () => {
    const r = await run(["--check"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("");
    for (const title of ["Security", "Sign-ins", "Claude Code", "Terminal", "Services"]) {
      expect(r.stdout).toMatch(new RegExp(`→ ${title} +pending`));
    }
    // Accounts needs the broker the security step sets up: blocked until then, saying so.
    expect(r.stdout).toMatch(/✗ Accounts +blocked: the broker does not take the admin login yet/);
    expect(r.stdout).toContain(
      "      → Register the volley MCP server with Claude Code (new; no password in it)",
    );
    expect(r.stdout).toMatch(/✓ Broker +done/);
    expect(r.stdout).toContain("      → Restart the broker (brew services restart mosquitto)");
    expect(r.stdout).toContain("run `volley setup` to apply.");
    expect(m.execCalls.every(READ_ONLY)).toBe(true);
    expect(m.questions).toEqual([]);
    expect(m.asked).toEqual([]);
    expect(m.secretPrompts).toEqual([]);
    expect(m.auth.ctrlCalls).toEqual([]);
    // A check writes no journal, no record and no metrics.
    expect(() => readFileSync(join(m.ctx.volleydHome, "setup.log"))).toThrow();
    expect(() => readFileSync(join(m.ctx.volleydHome, "setup.json"))).toThrow();
    expect(() => readFileSync(join(m.ctx.volleydHome, "setup-metrics.json"))).toThrow();
  });

  it("after a --yes run every row is done and it exits 0", async () => {
    expect((await run(["--yes", "--lan"])).code).toBe(0);
    const calls = m.execCalls.length;
    const r = await run(["--check"]);
    expect(r.stdout).not.toContain("pending");
    expect(r.stdout.match(/ done\n/g)).toHaveLength(8);
    expect(r.stdout).toContain("Nothing is missing.");
    expect(r.code).toBe(0);
    expect(m.execCalls.slice(calls).every(READ_ONLY)).toBe(true);
  });

  it("the Services row names the Desk's broker: served once setup.json has broker_host", async () => {
    expect((await run(["--yes", "--lan"])).code).toBe(0);
    expect((await run(["--check"])).stdout).toContain(
      "      Desk: broker on the page's host (port 9001)",
    );
    const file = join(m.ctx.volleydHome, "setup.json");
    const record = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...record, broker_host: "box-a" }));
    const r = await run(["--check"]);
    expect(r.stdout).toContain(
      "      Desk: broker box-a:9001 (served to the page at /desk-config.json)",
    );
    // The Desk's unit does not carry the flag yet: a run would rewrite it.
    expect(r.stdout).toMatch(/→ Services +pending/);
    expect(r.code).toBe(1);
    // And the run that applies it keeps broker_host on record.
    expect((await run(["--yes", "--step", "services"])).code).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf-8")).broker_host).toBe("box-a");
    expect((await run(["--check"])).code).toBe(0);
  });

  it("a blocked step prints blocked: <why> and exits 1", async () => {
    m.present.delete("/usr/bin/tmux");
    expect((await run(["--yes", "--lan"])).code).toBe(1);
    const r = await run(["--check", "--step", "terminal"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/✗ Terminal +blocked: neither cmux nor tmux is installed/);
  });

  it("a step skipped by policy (the phone, LAN access off) prints skipped and still exits 0", async () => {
    expect((await run(["--yes"])).code).toBe(0);
    const r = await run(["--check"]);
    expect(r.stdout).toMatch(/– Phone +skipped: /);
    expect(r.code).toBe(0);
  });

  it("--check --json prints exactly the report, nothing else", async () => {
    const r = await run(["--check", "--json"]);
    expect(r.code).toBe(1);
    const j = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(Object.keys(j).sort()).toEqual(["setup_at", "steps", "version"]);
    expect(j.version).toBe(pkg.version);
    expect(j.setup_at).toBeNull();
    const steps = j.steps as Record<string, unknown>[];
    expect(steps.map((s) => s.name)).toEqual(STEP_NAMES);
    for (const s of steps) {
      const keys = Object.keys(s).sort();
      expect(
        [
          ["changes", "name", "status", "title"],
          ["blocked", "changes", "name", "status", "title"],
          ["changes", "name", "skipped", "status", "title"],
        ].map((k) => k.join(",")),
      ).toContain(keys.join(","));
    }
    const security = steps.find((s) => s.name === "security") as {
      status: string;
      changes: string[];
    };
    expect(security.status).toBe("pending");
    expect(security.changes).toContain("Restart the broker (brew services restart mosquitto)");
    // After a run: setup_at is setup.log's newest line.
    expect((await run(["--yes", "--lan"])).code).toBe(0);
    const again = JSON.parse((await run(["--check", "--json"])).stdout) as { setup_at: string };
    expect(again.setup_at).toBe(new Date(NOW).toISOString());
  });

  it("the sign-in and Claude Code rows say what each thing is", async () => {
    expect((await run(["--yes", "--lan"])).code).toBe(0);
    const r = await run(["--check", "--step", "signin", "--step", "claude-code"]);
    expect(r.stdout).toContain("      ✓ Claude Code: signed in (max)\n");
    expect(r.stdout).toContain("      ✓ GitHub: signed in as o•••\n");
    expect(r.stdout).toContain("      ✓ coordinator: coord-studio\n");
    expect(r.stdout).toMatch(
      / {6}✓ MCP: volley registered \(mqtt:\/\/127\.0\.0\.1:\d+, no secret\)\n/,
    );
    expect(r.stdout).toContain("      ✓ skills: volley, volley-issues, volley-wait\n");
    expect(r.stdout).toContain("      ✓ hooks: installed\n");
    expect(r.code).toBe(0);
  });

  it("is the same on Linux (no keychain)", async () => {
    m = fakeMachine(fake, tempDir("volley-check-linux-"), { platform: "linux" });
    expect((await run(["--yes", "--lan"])).code).toBe(0);
    const r = await run(["--check", "--step", "signin", "--step", "claude-code"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/✓ Sign-ins +done/);
    expect(r.stdout).toMatch(/✓ Claude Code +done/);
  });

  it("refuses --check with --yes or --repair, and --json without --check", async () => {
    for (const argv of [["--check", "--yes"], ["--check", "--repair"], ["--json"]]) {
      const r = await run(argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.stdout).toBe("");
    }
  });
});
