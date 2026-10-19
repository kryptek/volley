import { lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { DEFAULT_SHARING } from "volleyd/claude/sharing";
import { type PeerDeps, peerFile, runPeer } from "../../src/commands/peer";
import { makeBufferIO } from "../../src/io";
import { type DoctorOptions, type DoctorReport, doctor } from "../../src/peer/doctor";
import { PROFILE_CHECKS, type ProfileTarget } from "../../src/peer/provision";
import { type TestBroker, startTestBroker } from "../helpers/aedes-broker";
import {
  type FakeMachineOptions,
  type FakePeerMachine,
  fakeHooksSettings,
  fakeMcpEntry,
  fakePeerMachine,
} from "../helpers/fake-peer-machine";

const TUNNEL = "mqtt://127.0.0.1:21883";

let box: FakePeerMachine | null = null;
afterEach(() => {
  box?.cleanup();
  box = null;
});
const machine = (o: FakeMachineOptions = {}) => {
  box = fakePeerMachine({ trusted: true, ...o });
  return box;
};

/** A paired machine's profile target: the tunnel's URL, its namespace, the supervisor's modes. */
const target = (over: Partial<ProfileTarget> = {}): ProfileTarget => ({
  brokerUrl: TUNNEL,
  namespace: null,
  sharing: { ...DEFAULT_SHARING },
  from: "supervisor",
  ...over,
});

async function run(m: FakePeerMachine, opts: Partial<DoctorOptions> = {}) {
  const io = makeBufferIO();
  const exit = await doctor(io, m.deps(), { repo: m.repoPath, profile: target(), ...opts });
  return { exit, stdout: io.readStdout(), stderr: io.readStderr() };
}
const report = async (m: FakePeerMachine, opts: Partial<DoctorOptions> = {}) =>
  JSON.parse((await run(m, { ...opts, json: true })).stdout) as DoctorReport;
const check = (r: DoctorReport, id: string) => r.checks.find((c) => c.id === id);

/** The installer runs (`env … bash <installer>`), by package. */
const installs = (m: FakePeerMachine, pkg: string) =>
  m.calls
    .map((c) => c.argv)
    .filter((a) => a[0] === "env" && a.some((w) => w.endsWith(`/${pkg}/scripts/install.sh`)));
const mcpCalls = (m: FakePeerMachine) =>
  m.calls.map((c) => c.argv).filter((a) => basename(a[0] ?? "") === "claude" && a[1] === "mcp");
const flagOf = (argv: string[] | undefined, flag: string) => {
  const i = argv?.indexOf(flag) ?? -1;
  return i >= 0 ? argv?.[i + 1] : undefined;
};
const linkOf = (p: string) => (lstatSync(p).isSymbolicLink() ? readlinkSync(p) : null);

describe("volley peer doctor: the Claude profile's skills", () => {
  it("no ~/.claude/skills/volley: skills fails with the installers as its fix; --fix runs both once", async () => {
    const m = machine({ profile: { skills: "absent", url: TUNNEL } });
    const r = await report(m);
    expect(check(r, "skills")).toMatchObject({ ok: false, severity: "warn" });
    expect(check(r, "skills")?.fix).toContain(
      join(m.volleyDir, "packages", "volley-skill", "scripts", "install.sh"),
    );
    expect(check(r, "skills")?.fix).toContain(
      join(m.volleyDir, "packages", "volley-issues", "scripts", "install.sh"),
    );
    expect(installs(m, "volley-skill")).toEqual([]);

    m.calls.length = 0;
    const fixed = await run(m, { fix: true, yes: true });
    expect(installs(m, "volley-skill")).toHaveLength(1);
    expect(installs(m, "volley-issues")).toHaveLength(1);
    expect(installs(m, "volley-skill")[0]).toContain(`HOME=${m.home}`);
    expect(linkOf(join(m.skillsDir, "volley"))).toBe(join(m.volleyDir, "packages", "volley-skill"));
    expect(fixed.stdout).toMatch(/^✓ skills: /m);
  });

  it("a symlink already pointing at the checkout is ok and runs nothing", async () => {
    const m = machine({ profile: { url: TUNNEL } });
    const r = await report(m);
    expect(check(r, "skills")).toMatchObject({ ok: true, severity: "warn" });
    m.calls.length = 0;
    const fixed = await run(m, { fix: true, yes: true });
    expect(installs(m, "volley-skill")).toEqual([]);
    expect(installs(m, "volley-issues")).toEqual([]);
    for (const id of PROFILE_CHECKS) {
      expect(fixed.stdout).toMatch(new RegExp(`^✓ ${id}: already done`, "m"));
    }
  });

  it("a link to another checkout is re-pointed by the installer", async () => {
    const m = machine({ profile: { skills: "elsewhere", url: TUNNEL } });
    const r = await report(m);
    expect(check(r, "skills")?.ok).toBe(false);
    expect(check(r, "skills")?.detail).toContain("another folder");
    await run(m, { fix: true, yes: true });
    expect(linkOf(join(m.skillsDir, "volley-issues"))).toBe(
      join(m.volleyDir, "packages", "volley-issues"),
    );
  });

  it("a dangling link is a broken link, and the installer re-links it", async () => {
    const m = machine({ profile: { skills: "broken", url: TUNNEL } });
    const r = await report(m);
    expect(check(r, "skills")?.ok).toBe(false);
    expect(check(r, "skills")?.detail).toContain("volley is a broken link");
    await run(m, { fix: true, yes: true });
    expect(linkOf(join(m.skillsDir, "volley"))).toBe(join(m.volleyDir, "packages", "volley-skill"));
    expect(check(await report(m), "skills")?.ok).toBe(true);
  });

  it("skills: copy repairs a dangling link (the link removed, then the copy made)", async () => {
    const m = machine({ profile: { skills: "broken", url: TUNNEL } });
    const sharing = { ...DEFAULT_SHARING, skills: "copy" as const };
    const r = await report(m, { profile: target({ sharing }) });
    expect(check(r, "skills")).toMatchObject({ ok: false, severity: "warn" });
    expect(check(r, "skills")?.detail).toContain("volley is a broken link");
    const at = join(m.skillsDir, "volley");
    expect(check(r, "skills")?.fix).toContain(`rm ${at} && cp -R`);
    await run(m, { profile: target({ sharing }), fix: true, yes: true });
    expect(lstatSync(at).isDirectory()).toBe(true);
    expect(check(await report(m, { profile: target({ sharing }) }), "skills")?.ok).toBe(true);
  });

  it("skills: copy copies a missing skill once and keeps one that is there", async () => {
    const m = machine({ profile: { skills: "absent", url: TUNNEL } });
    const sharing = { ...DEFAULT_SHARING, skills: "copy" as const };
    const r = await report(m, { profile: target({ sharing }) });
    expect(check(r, "skills")).toMatchObject({ ok: false, severity: "warn" });
    await run(m, { profile: target({ sharing }), fix: true, yes: true });
    expect(installs(m, "volley-skill")).toEqual([]);
    expect(
      m.calls.filter((c) => c.argv[0] === "cp" && c.argv.includes(join(m.skillsDir, "volley"))),
    ).toHaveLength(1);

    // A stray folder is the profile's own copy: kept.
    box?.cleanup();
    const kept = machine({ profile: { skills: "stray", url: TUNNEL } });
    const k = await report(kept, { profile: target({ sharing }) });
    expect(check(k, "skills")?.ok).toBe(true);
    expect(check(k, "skills")?.detail).toContain("copy");
  });

  it("sharing with skills: own leaves the symlink alone and reports it left as is", async () => {
    const m = machine({ profile: { skills: "elsewhere", url: TUNNEL } });
    const sharing = { ...DEFAULT_SHARING, skills: "own" as const };
    const before = linkOf(join(m.skillsDir, "volley"));
    const r = await report(m, { profile: target({ sharing }) });
    expect(check(r, "skills")).toMatchObject({ ok: true, severity: "warn" });
    expect(check(r, "skills")?.detail).toContain("left as is");
    expect(check(r, "sharing")?.detail).toContain("left as is");
    const fixed = await run(m, { profile: target({ sharing }), fix: true, yes: true });
    expect(fixed.exit).toBe(0);
    expect(installs(m, "volley-skill")).toEqual([]);
    expect(linkOf(join(m.skillsDir, "volley"))).toBe(before);
  });
});

describe("volley peer doctor: the Claude profile's hooks", () => {
  it("compares the installer's dry run with settings.json and installs with CLAUDE_SETTINGS and the tunnel's URL", async () => {
    const m = machine({ profile: { hooks: "absent", url: TUNNEL } });
    const r = await report(m);
    expect(check(r, "hooks")).toMatchObject({ ok: false, severity: "warn" });
    const dry = installs(m, "volley-hooks");
    expect(dry).toHaveLength(1);
    expect(dry[0]).toContain("--dry-run");
    expect(dry[0]).toContain(`CLAUDE_SETTINGS=${m.settingsFile}`);
    expect(flagOf(dry[0], "--broker-url")).toBe(TUNNEL);
    // The URL is a flag, never the installer's env (it ignores an ambient VOLLEY_BROKER_URL).
    expect(dry[0]?.some((w) => w.startsWith("VOLLEY_BROKER_URL="))).toBe(false);

    m.calls.length = 0;
    await run(m, { fix: true, yes: true });
    const ran = installs(m, "volley-hooks").filter((a) => !a.includes("--dry-run"));
    expect(ran).toHaveLength(1);
    expect(ran[0]).toContain(`CLAUDE_SETTINGS=${m.settingsFile}`);
    expect(flagOf(ran[0], "--broker-url")).toBe("mqtt://127.0.0.1:21883");
    expect(readFileSync(m.settingsFile, "utf-8")).toBe(fakeHooksSettings(m.volleyDir, TUNNEL));
    expect(check(await report(m), "hooks")?.ok).toBe(true);
  });

  it("a namespace other than the default is passed to the hooks; the default is not", async () => {
    const m = machine({ profile: { url: TUNNEL } });
    const r = await report(m, { profile: target({ namespace: "team-a" }) });
    expect(check(r, "hooks")?.ok).toBe(false);
    expect(flagOf(installs(m, "volley-hooks")[0], "--namespace")).toBe("team-a");
    await run(m, { profile: target({ namespace: "team-a" }), fix: true, yes: true });
    expect(readFileSync(m.settingsFile, "utf-8")).toBe(
      fakeHooksSettings(m.volleyDir, TUNNEL, "team-a"),
    );
    m.calls.length = 0;
    expect(check(await report(m, { profile: target({ namespace: "default" }) }), "hooks")?.ok).toBe(
      false,
    );
    expect(installs(m, "volley-hooks")[0]).not.toContain("--namespace");
  });

  it("a URL with a login is never handed to the hooks: the login is dropped, and said so", async () => {
    const m = machine({ profile: { url: TUNNEL } });
    const r = await report(m, {
      profile: target({ brokerUrl: "mqtt://someone:pw-not-printed@127.0.0.1:21883" }),
    });
    expect(flagOf(installs(m, "volley-hooks")[0], "--broker-url")).toBe(TUNNEL);
    expect(check(r, "hooks")?.ok).toBe(true);
    expect(check(r, "hooks")?.detail).toContain("login");
    expect(JSON.stringify(r)).not.toContain("pw-not-printed");
  });

  it("hooks installed for another port differ and are re-installed", async () => {
    const m = machine({ profile: { url: "mqtt://127.0.0.1:21999" } });
    const r = await report(m);
    expect(check(r, "hooks")?.ok).toBe(false);
    expect(check(r, "hooks")?.detail).toContain(TUNNEL);
  });

  it("settings.json: own is left as is: no dry run, no install", async () => {
    const m = machine({ profile: { hooks: "absent", url: TUNNEL } });
    const sharing = { ...DEFAULT_SHARING, "settings.json": "own" as const };
    const r = await report(m, { profile: target({ sharing }) });
    expect(check(r, "hooks")).toMatchObject({ ok: true });
    expect(check(r, "hooks")?.detail).toContain("left as is");
    await run(m, { profile: target({ sharing }), fix: true, yes: true });
    expect(installs(m, "volley-hooks")).toEqual([]);
  });

  it("without bun the hooks cannot be checked, and nothing runs the installer", async () => {
    const m = machine({
      profile: { hooks: "absent", url: TUNNEL },
      tools: { bun: { path: null, sshPath: null } },
    });
    const r = await report(m);
    expect(check(r, "hooks")).toMatchObject({ ok: false, severity: "warn" });
    expect(check(r, "hooks")?.detail).toContain("bun");
    expect(installs(m, "volley-hooks")).toEqual([]);
  });
});

describe("volley peer doctor: the Claude profile's MCP server", () => {
  it("missing: --fix runs exactly one claude mcp add-json -s user volley naming this checkout and the tunnel", async () => {
    const m = machine({ profile: { mcp: "absent", url: TUNNEL } });
    const r = await report(m);
    expect(check(r, "mcp")).toMatchObject({ ok: false, severity: "warn" });
    expect(mcpCalls(m)).toEqual([]);
    await run(m, { fix: true, yes: true });
    const calls = mcpCalls(m);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(1, 6)).toEqual(["mcp", "add-json", "-s", "user", "volley"]);
    const json = JSON.parse(calls[0]?.[6] as string) as {
      args: string[];
      env: Record<string, string>;
    };
    expect(json.args).toContain(join(m.volleyDir, "packages", "volley-mcp", "src", "index.ts"));
    expect(json.env.VOLLEY_BROKER_URL).toBe(TUNNEL);
    expect(json.env.VOLLEY_AGENT_ID).toBe("coordinator");
    expect(check(await report(m), "mcp")?.ok).toBe(true);
  });

  it("an entry with the wrong port is re-registered", async () => {
    const m = machine({ profile: { url: "mqtt://127.0.0.1:21999" } });
    expect(check(await report(m), "mcp")?.ok).toBe(false);
    m.calls.length = 0;
    await run(m, { fix: true, yes: true });
    expect(mcpCalls(m).map((a) => a.slice(1, 3))).toEqual([
      ["mcp", "remove"],
      ["mcp", "add-json"],
    ]);
    const entry = (m.readClaudeJson().mcpServers as Record<string, { env: unknown }>).volley;
    expect(entry?.env).toMatchObject({ VOLLEY_BROKER_URL: TUNNEL });
  });

  it("an entry with settings of its own is never rewritten: its fix is printed", async () => {
    const own = {
      ...fakeMcpEntry("/elsewhere/volley", "mqtt://127.0.0.1:21999"),
      env: { VOLLEY_AUTH_USERNAME: "someone", VOLLEY_AUTH_PASSWORD: "hunter2-not-printed" },
    };
    const m = machine({ profile: { mcp: own, url: TUNNEL } });
    const r = await run(m, { fix: true, yes: true });
    expect(mcpCalls(m)).toEqual([]);
    expect(r.stdout).toMatch(/mcp: run it yourself/);
    expect(r.stdout).not.toContain("hunter2");
    expect(r.stdout).not.toContain("someone");
    // The printed re-registration keeps the entry's own settings (by name, never by value).
    const fix = check(await report(m), "mcp")?.fix ?? "";
    expect(fix).toContain('"VOLLEY_AUTH_USERNAME":"<yours>"');
    expect(fix).toContain('"VOLLEY_AUTH_PASSWORD":"<yours>"');
    expect(fix).toContain(`"VOLLEY_BROKER_URL":"${TUNNEL}"`);
  });

  it("an entry with an agent id of its own is the person's: kept in the printed fix, never rewritten", async () => {
    const mine = {
      ...fakeMcpEntry("/elsewhere/volley", "mqtt://127.0.0.1:21999"),
      env: { VOLLEY_AGENT_ID: "laptop", VOLLEY_BROKER_URL: "mqtt://127.0.0.1:21999" },
    };
    const m = machine({ profile: { mcp: mine, url: TUNNEL } });
    const r = await report(m);
    expect(check(r, "mcp")?.fix).toContain('"VOLLEY_AGENT_ID":"laptop"');
    await run(m, { fix: true, yes: true });
    expect(mcpCalls(m)).toEqual([]);
  });

  it("mcp: own is left as is", async () => {
    const m = machine({ profile: { mcp: "absent", url: TUNNEL } });
    const sharing = { ...DEFAULT_SHARING, mcp: "own" as const };
    const r = await report(m, { profile: target({ sharing }) });
    expect(check(r, "mcp")).toMatchObject({ ok: true });
    expect(check(r, "mcp")?.detail).toContain("left as is");
    await run(m, { profile: target({ sharing }), fix: true, yes: true });
    expect(mcpCalls(m)).toEqual([]);
  });

  it("an unreadable ~/.claude.json is reported and never overwritten", async () => {
    const m = machine({ profile: { url: TUNNEL } });
    writeFileSync(m.claudeJsonFile, "{ not json");
    const r = await run(m, { fix: true, yes: true, json: true });
    expect(check(JSON.parse(r.stdout), "mcp")?.ok).toBe(false);
    expect(mcpCalls(m)).toEqual([]);
    expect(readFileSync(m.claudeJsonFile, "utf-8")).toBe("{ not json");
  });
});

describe("volley peer doctor: the Claude profile overall", () => {
  it("every profile check is a warn, in the documented order, and the sharing row names its modes' source", async () => {
    const m = machine({ profile: { skills: "absent", hooks: "absent", mcp: "absent" } });
    const r = await report(m);
    const ids = r.checks.map((c) => c.id).filter((id) => PROFILE_CHECKS.includes(id as never));
    expect(ids).toEqual(["skills", "hooks", "mcp", "sharing"]);
    for (const id of PROFILE_CHECKS) {
      expect(check(r, id)).toMatchObject({ ok: false, severity: "warn" });
    }
    expect(check(r, "sharing")?.detail).toContain("from the supervisor");
    // Each item carries its own fix: the sharing row has none (it would run nothing).
    expect(check(r, "sharing")?.fix).toBeUndefined();
    const d = await report(m, { profile: target({ from: "defaults" }) });
    expect(check(d, "sharing")?.detail).toContain("default");
  });

  it("a fixed profile reads healthy, and a second --fix runs nothing", async () => {
    const m = machine({ profile: { skills: "absent", hooks: "absent", mcp: "absent" } });
    const first = await run(m, { fix: true, yes: true, json: true });
    const after = JSON.parse(first.stdout) as DoctorReport;
    for (const id of PROFILE_CHECKS) expect(check(after, id)?.ok).toBe(true);
    m.calls.length = 0;
    await run(m, { fix: true, yes: true });
    expect(installs(m, "volley-skill")).toEqual([]);
    expect(installs(m, "volley-hooks").filter((a) => !a.includes("--dry-run"))).toEqual([]);
    expect(mcpCalls(m)).toEqual([]);
  });

  it("not paired (no URL to expect): the hooks keep the URL they carry, and the MCP URL is not compared", async () => {
    const m = machine({ profile: { url: "mqtt://broker.example:1883" } });
    const r = await report(m, { profile: target({ brokerUrl: null, from: "defaults" }) });
    expect(check(r, "hooks")?.ok).toBe(true);
    expect(check(r, "mcp")?.ok).toBe(true);
    expect(flagOf(installs(m, "volley-hooks")[0], "--broker-url")).toBe(
      "mqtt://broker.example:1883",
    );
    // No URL anywhere: the dry run passes none.
    box?.cleanup();
    const bare = machine();
    // No profile target at all (the doctor's default): the default modes, no URL.
    const io = makeBufferIO();
    await doctor(io, bare.deps(), { repo: bare.repoPath, json: true });
    const b = JSON.parse(io.readStdout()) as DoctorReport;
    expect(check(b, "sharing")?.detail).toContain("default");
    expect(check(b, "hooks")?.ok).toBe(true);
    expect(installs(bare, "volley-hooks")[0]).not.toContain("--broker-url");
  });

  for (const token of [
    "sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
  ]) {
    it(`a token in any output or in the MCP entry never reaches the result (${token.slice(0, 7)}…)`, async () => {
      const m = machine({
        plant: token,
        profile: {
          skills: "absent",
          hooks: "absent",
          mcp: { ...fakeMcpEntry("/x"), env: { VOLLEY_AUTH_PASSWORD: token, OTHER: token } },
        },
      });
      const json = await run(m, { json: true });
      expect(json.stdout).not.toContain(token);
      expect(json.stderr).not.toContain(token);
      const human = await run(m, { fix: true, yes: true });
      expect(human.stdout).not.toContain(token);
      expect(human.stderr).not.toContain(token);
    });
  }
});

describe("volley peer doctor: where the sharing modes come from", () => {
  let tb: TestBroker;
  beforeEach(async () => {
    tb = await startTestBroker();
  });
  afterEach(async () => {
    await tb.close();
  });

  const pair = (m: FakePeerMachine) => {
    mkdirSync(join(m.home, ".volley"), { recursive: true });
    writeFileSync(
      peerFile(m.home),
      JSON.stringify({
        name: "box-a",
        host: "dev@host",
        target: "dev@box-a",
        namespace: "default",
        broker: { host: "127.0.0.1", port: 1883 },
        remote_port: 21883,
        username: "box-a",
        password: "peer-secret",
        repo: m.repoPath,
        joined_at: "2026-10-19T09:00:00.000Z",
      }),
      { mode: 0o600 },
    );
  };
  const readiness = async (agentId: string, requirements: Record<string, unknown>) => {
    const b = new VolleyBroker();
    await b.connect({ url: tb.url, agentId });
    await b.publish(
      "volley/_system/machines/box-a/readiness",
      JSON.stringify(
        buildEnvelope({
          agentId,
          parentId: null,
          channel: "_system/machines",
          type: "readiness",
          payload: { name: "box-a", requirements: { volley: "0.4.0", ...requirements } },
        }),
      ),
      { qos: 1, retain: true },
    );
    await b.disconnect();
  };
  const verb = async (m: FakePeerMachine, argv: string[] = []) => {
    const deps: PeerDeps = {
      ...m.deps(),
      hostname: () => "box-a",
      uid: () => 501,
      arch: "x64",
      cpus: () => 8,
      loadavg: () => [0, 0, 0],
      monotonic: () => 0,
      envPath: () => "/usr/bin:/bin",
      sleep: async () => {},
      readStdin: async () => "",
      volleyArgv: ["/usr/bin/bun", "/opt/volley/packages/volley-cli/src/cli.ts"],
      connect: async (_url, auth) => {
        const b = new VolleyBroker();
        await b.connect({ url: tb.url, agentId: "peer-test", ...(auth ?? {}) });
        return b;
      },
    };
    const io = makeBufferIO();
    const exit = await runPeer(
      { argv: ["doctor", "--json", ...argv], env: { VOLLEY_AUTH_DIR: m.home }, io },
      deps,
    );
    return {
      exit,
      stderr: io.readStderr(),
      report: exit === 2 ? null : JSON.parse(io.readStdout()),
    };
  };

  it("a retained readiness verdict's modes are applied; the tunnel's port is the URL expected", async () => {
    const m = machine({ profile: { skills: "elsewhere", url: TUNNEL } });
    pair(m);
    await readiness("volleyd", { sharing: { ...DEFAULT_SHARING, skills: "own" } });
    const r = await verb(m);
    expect(check(r.report, "skills")?.detail).toContain("left as is");
    expect(check(r.report, "sharing")?.detail).toContain("from the supervisor");
    expect(check(r.report, "hooks")?.ok).toBe(true);
    expect(check(r.report, "mcp")?.ok).toBe(true);
  });

  it("no verdict (or one from anyone but the supervisor): the default modes", async () => {
    const m = machine({ profile: { skills: "elsewhere", url: TUNNEL } });
    pair(m);
    await readiness("box-b", { sharing: { ...DEFAULT_SHARING, skills: "own" } });
    const r = await verb(m);
    expect(check(r.report, "skills")?.ok).toBe(false);
    expect(check(r.report, "sharing")?.detail).toContain("default");
  });

  it("by hand: --sharing <json> sets the modes; a bad one is a usage error", async () => {
    const m = machine({ profile: { skills: "elsewhere", url: TUNNEL } });
    const r = await verb(m, ["--repo", m.repoPath, "--sharing", '{"skills":"own"}']);
    expect(check(r.report, "skills")?.detail).toContain("left as is");
    expect(check(r.report, "sharing")?.detail).toContain("--sharing");
    const bad = await verb(m, ["--sharing", '{"mcp":"linked"}']);
    expect(bad.exit).toBe(2);
    expect(bad.stderr).toContain("--sharing");
    const typo = await verb(m, ["--sharing", '{"skils":"own"}']);
    expect(typo.exit).toBe(2);
  });
});
