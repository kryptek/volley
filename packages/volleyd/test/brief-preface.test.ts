import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BRIEF_PREFACE_RULE,
  ROLES,
  type Role,
  briefPrefacePath,
  formatBriefPreface,
  readBriefPreface,
  withPreface,
} from "../src/brief";
import { CONFIG_DEFAULTS } from "../src/config-defaults";
import { ControlClient } from "../src/control";
import { Daemon } from "../src/daemon";
import { spawnAgent } from "../src/spawn";
import { SpawnError } from "../src/spawn-error";
import { parseWaveFile } from "../src/wave-file";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { NO_PRESSURE, NS } from "./helpers/daemon-env";
import { FIXTURES, type SpawnEnv, makeSpawnEnv } from "./helpers/fake-host";

const PREFACE = readFileSync(join(FIXTURES, "brief-preface.md"));
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const HEAD = "a".repeat(40);

/** Write `content` as `<repo>/<rel>`. */
const put = (repo: string, rel: string, content: Buffer | string) => {
  const file = join(repo, rel);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
  return file;
};

describe("brief preface: the loader", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "volleyd-preface-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("defaults to <repo>/.volley/brief-preface.md; brief_preface: overrides it (relative or absolute)", () => {
    expect(briefPrefacePath("/r/repo")).toBe("/r/repo/.volley/brief-preface.md");
    expect(briefPrefacePath("/r/repo", "docs/agent-rules.md")).toBe("/r/repo/docs/agent-rules.md");
    expect(briefPrefacePath("/r/repo", "/etc/volley/rules.md")).toBe("/etc/volley/rules.md");
  });

  it("reads the file's bytes with their size and sha256; a missing file is null", () => {
    const file = put(dir, "p.md", PREFACE);
    expect(readBriefPreface(file, CONFIG_DEFAULTS.brief_preface_max_bytes)).toEqual({
      path: file,
      bytes: PREFACE.length,
      sha256: sha256(PREFACE),
      text: PREFACE.toString("utf-8"),
    });
    expect(readBriefPreface(join(dir, "nope.md"), 1024)).toBeNull();
  });

  it("a file over brief_preface_max_bytes → BRIEF_PREFACE_TOO_LARGE", () => {
    const file = put(dir, "big.md", "x".repeat(2049));
    expect(() => readBriefPreface(file, 2048)).toThrow(/BRIEF_PREFACE_TOO_LARGE/);
    expect(readBriefPreface(put(dir, "ok.md", "x".repeat(2048)), 2048)?.bytes).toBe(2048);
  });

  it("is prepended verbatim, above the rule; an empty file prepends nothing", () => {
    const p = readBriefPreface(put(dir, "p.md", PREFACE), 16384);
    expect(withPreface(p, "# Brief\n")).toBe(
      `${PREFACE.toString("utf-8")}${BRIEF_PREFACE_RULE}# Brief\n`,
    );
    expect(withPreface(null, "# Brief\n")).toBe("# Brief\n");
    expect(withPreface(readBriefPreface(put(dir, "e.md", ""), 16384), "# Brief\n")).toBe(
      "# Brief\n",
    );
  });

  it("a blank file is no preface: null, as if missing (what the agents get is what is reported)", () => {
    expect(readBriefPreface(put(dir, "blank.md", "  \n\t\n"), 16384)).toBeNull();
    expect(readBriefPreface(put(dir, "empty.md", ""), 16384)).toBeNull();
  });

  it("a file that is not valid UTF-8 is refused (the brief carries its exact bytes or nothing)", () => {
    const file = put(dir, "bad.md", Buffer.from([0x72, 0x75, 0x6c, 0x65, 0xff, 0xfe, 0x0a]));
    expect(() => readBriefPreface(file, 16384)).toThrow(/not valid UTF-8/);
  });

  it("formats the validate / status line", () => {
    expect(formatBriefPreface(null)).toBe("brief preface: none");
    expect(
      formatBriefPreface({ path: "/r/p.md", bytes: 912, sha256: "0123456789abcdef".repeat(4) }),
    ).toBe("brief preface: /r/p.md (912 B, sha256 0123456789ab)");
  });
});

describe("brief preface: every spawned brief starts with it", () => {
  let env: SpawnEnv;
  afterEach(() => env.cleanup());

  /** The brief of each role's latest spawn (pipeline roles get a worktree per attempt). */
  const worktrees = new Map<Role, string>();
  const brief = (role: Role) =>
    readFileSync(join(worktrees.get(role) ?? "", ".volley", "brief.md"), "utf-8");
  const spawn = async (role: Role, wave = env.wave) => {
    const res = await spawnAgent(
      env.request({
        wave,
        role,
        ...(role === "implementer"
          ? {}
          : { start: { ref: HEAD, detach: role.endsWith("reviewer") } }),
      }),
      env.deps,
    );
    if (res.kind === "launched") worktrees.set(role, res.worktree);
    return res;
  };

  it.each(ROLES)(
    "%s: the preface's exact bytes, then the rule, then the role template",
    async (role) => {
      env = await makeSpawnEnv();
      put(env.repo, ".volley/brief-preface.md", PREFACE);
      expect((await spawn(role)).kind).toBe("launched");
      const b = brief(role);
      expect(b.startsWith(`${PREFACE.toString("utf-8")}${BRIEF_PREFACE_RULE}`)).toBe(true);
      // No placeholder expansion inside the preface.
      expect(b).toContain("{{agent_id}} and {{ issue }} are not expanded");
      // The role template still renders below it.
      expect(b.slice(PREFACE.length)).toContain(`w1-t1-${role}-1`);
    },
  );

  it("no preface file: the brief is the role template alone", async () => {
    env = await makeSpawnEnv();
    await spawn("implementer");
    expect(brief("implementer")).toMatch(/^# /);
    expect(brief("implementer")).not.toContain(BRIEF_PREFACE_RULE);
  });

  it("the wave file's brief_preface: names another file, relative to the repo or absolute", async () => {
    env = await makeSpawnEnv();
    put(env.repo, ".volley/brief-preface.md", "the default file\n");
    put(env.repo, "docs/rules.md", "relative rules\n");
    const withKey = (value: string) =>
      parseWaveFile(
        `wave: w1\nrepo: ${env.repo}\nrelease_branch: release/w1\nmodel: claude-opus-5-5\npipeline: [implement]\nbrief_preface: ${value}\ntasks:\n  T1: { issue: 42 }\n`,
      );
    await spawn("implementer", withKey("docs/rules.md"));
    expect(brief("implementer").startsWith(`relative rules\n${BRIEF_PREFACE_RULE}`)).toBe(true);

    const abs = put(env.dir, "elsewhere/rules.md", "absolute rules\n");
    await spawn("spec_reviewer", withKey(abs));
    expect(brief("spec_reviewer").startsWith(`absolute rules\n${BRIEF_PREFACE_RULE}`)).toBe(true);
  });

  it("a preface over the cap refuses the spawn before any launch", async () => {
    env = await makeSpawnEnv();
    put(
      env.repo,
      ".volley/brief-preface.md",
      "x".repeat(CONFIG_DEFAULTS.brief_preface_max_bytes + 1),
    );
    const err = await spawn("implementer").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpawnError);
    expect((err as SpawnError).code).toBe("BRIEF_PREFACE_TOO_LARGE");
    expect(env.host.launches).toEqual([]);
    expect(env.events.find((e) => e.type === "alarm_raised")?.data).toMatchObject({
      code: "BRIEF_PREFACE_TOO_LARGE",
    });
  });
});

describe("brief preface: submit, versions and the wave state (daemon)", () => {
  let broker: TestBroker;
  let home: string;
  let repo: string;
  let daemon: Daemon;
  let client: ControlClient;
  const wave = (extra = "", issue = 1) =>
    `wave: w1\nrepo: ${repo}\nrelease_branch: release/w1\nmodel: claude-opus-5-5\npipeline: [implement, merge_ready]\n${extra}tasks:\n  T1: { issue: ${issue} }\n`;
  const missing = () =>
    daemon
      .journalEvents("w1")
      .filter((e) => e.type === "alarm_raised" && e.data.alarm === "brief_preface_missing");

  beforeEach(async () => {
    broker = await startTestBroker();
    home = mkdtempSync(join(tmpdir(), "volleyd-preface-home-"));
    repo = mkdtempSync(join(tmpdir(), "volleyd-preface-repo-"));
    daemon = await Daemon.start({
      brokerUrl: broker.url,
      namespace: NS,
      home,
      tickMs: 0,
      protocolVersion: 4,
      pressure: NO_PRESSURE,
    });
    client = await ControlClient.connect(broker.url, NS);
  });
  afterEach(async () => {
    await client.close();
    await daemon.stop();
    await broker.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it("a preface present: the wave state carries its path, bytes and the sha256 of its bytes", async () => {
    const file = put(repo, ".volley/brief-preface.md", PREFACE);
    const res = await client.request("run", { wave_yaml: wave() });
    expect(res.ok).toBe(true);
    const expected = { path: file, bytes: PREFACE.length, sha256: sha256(PREFACE) };
    expect(daemon.snapshot("w1")?.brief_preface).toEqual(expected);
    expect(
      daemon.journalEvents("w1").find((e) => e.type === "wave_submitted")?.data.brief_preface,
    ).toEqual(expected);
    expect(missing()).toEqual([]);
  });

  it("a plan version re-reads it and journals what the new version's agents get", async () => {
    put(repo, ".volley/brief-preface.md", "v1 rules\n");
    await client.request("run", { wave_yaml: wave() });
    put(repo, "docs/rules.md", "v2 rules\n");
    const res = await client.request("run", { wave_yaml: wave("brief_preface: docs/rules.md\n") });
    expect(res.ok).toBe(true);
    const v2 = daemon.journalEvents("w1").find((e) => e.type === "wave_versioned");
    expect(v2?.data.brief_preface).toMatchObject({
      path: join(repo, "docs/rules.md"),
      sha256: sha256("v2 rules\n"),
    });
    expect(daemon.snapshot("w1")?.brief_preface?.sha256).toBe(sha256("v2 rules\n"));
  });

  it("no preface: brief_preface is null and brief_preface_missing is journaled once per wave", async () => {
    await client.request("run", { wave_yaml: wave() });
    expect(daemon.snapshot("w1")?.brief_preface).toBeNull();
    expect(missing()).toHaveLength(1);
    expect(missing()[0]?.data.path).toBe(join(repo, ".volley", "brief-preface.md"));
    // A new plan version still without one: not journaled again.
    await client.request("run", { wave_yaml: wave("", 2) });
    expect(daemon.snapshot("w1")?.version).toBe(2);
    expect(missing()).toHaveLength(1);
  });

  it("a version that loses the preface journals brief_preface_missing and nulls the state", async () => {
    const file = put(repo, ".volley/brief-preface.md", "v1 rules\n");
    await client.request("run", { wave_yaml: wave() });
    expect(daemon.snapshot("w1")?.brief_preface?.sha256).toBe(sha256("v1 rules\n"));
    expect(missing()).toEqual([]);
    rmSync(file);
    const res = await client.request("run", { wave_yaml: wave("", 2) });
    expect(res.ok).toBe(true);
    expect(daemon.snapshot("w1")?.brief_preface).toBeNull();
    expect(missing()).toHaveLength(1);
  });

  it("brief_preface_missing is journaled once per wave, even across missing → present → missing", async () => {
    await client.request("run", { wave_yaml: wave() });
    expect(missing()).toHaveLength(1);
    const file = put(repo, ".volley/brief-preface.md", "rules\n");
    await client.request("run", { wave_yaml: wave("", 2) });
    expect(daemon.snapshot("w1")?.brief_preface?.sha256).toBe(sha256("rules\n"));
    rmSync(file);
    await client.request("run", { wave_yaml: wave("", 3) });
    expect(daemon.snapshot("w1")?.version).toBe(3);
    expect(daemon.snapshot("w1")?.brief_preface).toBeNull();
    expect(missing()).toHaveLength(1);
  });

  it("a preface over the cap refuses the run with BRIEF_PREFACE_TOO_LARGE", async () => {
    put(repo, ".volley/brief-preface.md", "x".repeat(2048));
    const res = await client.request("run", {
      wave_yaml: wave("config: { brief_preface_max_bytes: 1024 }\n"),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/BRIEF_PREFACE_TOO_LARGE/);
    expect(daemon.snapshot("w1")).toBeNull();
  });
});
