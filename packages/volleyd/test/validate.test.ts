import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { localPinWarnings } from "../src/commands/validate";
import { CONFIG_DEFAULTS } from "../src/config-defaults";
import { CONFIG_TOPIC } from "../src/control";
import { localMachineName } from "../src/fleet-name";
import { MACHINE_CHANNEL, machineTopic } from "../src/machines";
import { parseWaveFile } from "../src/wave-file";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { SAFE_ENV, runCli } from "./helpers/run-cli";
import { tempDir } from "./helpers/tmp";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

describe("volleyd validate: the release branch", () => {
  let dir: string;
  let repo: string;
  beforeEach(() => {
    dir = realpathSync(tempDir("volleyd-validate-"));
    repo = join(dir, "repo");
    mkdirSync(repo);
    git(repo, "init", "--quiet", "-b", "main");
    git(
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "init",
    );
  });

  const waveFile = (repoPath: string, task = "{ issue: 1 }") => {
    const file = join(dir, "w.yaml");
    writeFileSync(
      file,
      `wave: w1\nrepo: ${repoPath}\nrelease_branch: release/x\nmodel: claude-opus-5-5\npipeline: [implement]\ntasks:\n  T1: ${task}\n`,
    );
    return file;
  };

  it("neither release/x nor origin/release/x → RELEASE_BRANCH_MISSING, exit 1", async () => {
    const r = await runCli(["validate", waveFile(repo)]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(
      `RELEASE_BRANCH_MISSING: ${repo} has neither release/x nor origin/release/x — push it first`,
    );
    // validate stays offline: a branch pushed from another clone may just need a fetch
    expect(r.stderr).toContain(`git -C ${repo} fetch origin`);
  });

  it("a repo directory that is not a git repository says so", async () => {
    const plain = join(dir, "plain");
    mkdirSync(plain);
    const r = await runCli(["validate", waveFile(plain)]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(`RELEASE_BRANCH_MISSING: ${plain} is not a git repository`);
  });

  it("a wave whose every task runs on a remote host is not checked here (as run does)", async () => {
    const r = await runCli(["validate", waveFile(repo, "{ issue: 1, host: build-box.lan }")]);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
  });

  it("notes that volleyd run needs an owner", async () => {
    const r = await runCli(["validate", waveFile(repo, "{ issue: 1, host: build-box.lan }")]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("note: `volleyd run` needs an owner");
  });

  it("skips the owner note when VOLLEY_AGENT_ID names the caller", async () => {
    const r = await runCli(["validate", waveFile(repo, "{ issue: 1, host: build-box.lan }")], {
      ...SAFE_ENV,
      VOLLEY_AGENT_ID: "coord-1",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("needs an owner");
  });

  /** An origin remote (never contacted: validate stays offline). */
  const addOrigin = () => git(repo, "remote", "add", "origin", "https://example.com/repo.git");

  it("only origin/release/x (pushed from another clone) is enough", async () => {
    addOrigin();
    git(repo, "update-ref", "refs/remotes/origin/release/x", "HEAD");
    const r = await runCli(["validate", waveFile(repo)]);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
  });

  it("the local branch is enough", async () => {
    addOrigin();
    git(repo, "branch", "release/x");
    expect((await runCli(["validate", waveFile(repo)])).exitCode).toBe(0);
  });

  it("a local-only repo (no origin) with require_fresh_base on → BASE_STALE in one line, with the fix", async () => {
    git(repo, "branch", "release/x");
    const r = await runCli(["validate", waveFile(repo)]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe(
      `volleyd validate: BASE_STALE: ${repo} has no origin remote, so volleyd cannot fetch release/x before it cuts each agent's worktree (require_fresh_base is on). Fix: add the remote and push the branch (\`git -C ${repo} remote add origin <url>\`, then \`git -C ${repo} push -u origin release/x\`), or work from the local copy: \`volleyd config set require_fresh_base false\` (or \`config: { require_fresh_base: false }\` in the wave file).\n`,
    );
  });

  it("a local-only repo is fine with require_fresh_base off: the wave's config:, or $VOLLEYD_HOME/config.yaml", async () => {
    git(repo, "branch", "release/x");
    const waved = await runCli([
      "validate",
      waveFile(repo, "{ issue: 1 }\nconfig: { require_fresh_base: false }"),
    ]);
    expect(waved.stderr).toBe("");
    expect(waved.exitCode).toBe(0);
    const home = join(dir, "home");
    mkdirSync(home);
    writeFileSync(join(home, "config.yaml"), "require_fresh_base: false\n");
    const env = { VOLLEY_BROKER_URL: "mqtt://127.0.0.1:1", VOLLEYD_HOME: home };
    const global = await runCli(["validate", waveFile(repo)], env);
    expect(global.stderr).toBe("");
    expect(global.exitCode).toBe(0);
  });

  it("placement weights that reach all four at 0 across config.yaml and the wave's config: are refused", async () => {
    git(repo, "branch", "release/x");
    const home = join(dir, "home-weights");
    mkdirSync(home);
    writeFileSync(
      join(home, "config.yaml"),
      "require_fresh_base: false\nplacement:\n  weights: { usage: 0 }\n",
    );
    const env = { VOLLEY_BROKER_URL: "mqtt://127.0.0.1:1", VOLLEYD_HOME: home };
    const zero = await runCli(
      [
        "validate",
        waveFile(
          repo,
          "{ issue: 1 }\nconfig: { placement: { weights: { cpu: 0, slots: 0, mem: 0 } } }",
        ),
      ],
      env,
    );
    expect(zero.exitCode).toBe(1);
    expect(zero.stderr).toBe(
      "volleyd validate: config.placement.weights: not all four weights may be 0 (cpu, slots, mem, usage) with the global config\n",
    );
    const ok = await runCli(
      ["validate", waveFile(repo, "{ issue: 1 }\nconfig: { placement: { weights: { cpu: 0 } } }")],
      env,
    );
    expect(ok.stderr).toBe("");
    expect(ok.exitCode).toBe(0);
  });

  it("a wave without placement: prints what placement.default and the paired machines decide (#324)", async () => {
    git(repo, "branch", "release/x");
    const home = join(dir, "home-placement");
    mkdirSync(home);
    const env = { VOLLEY_BROKER_URL: "mqtt://127.0.0.1:1", VOLLEYD_HOME: home };
    writeFileSync(join(home, "config.yaml"), "require_fresh_base: false\n");
    const alone = await runCli(["validate", waveFile(repo)], env);
    expect(alone.exitCode).toBe(0);
    expect(alone.stdout).toContain("placement: local (no paired machine)\n");
    writeFileSync(
      join(home, "config.yaml"),
      "require_fresh_base: false\nhosts:\n  box-a: { target: dev@box-a, repo: /srv/r, volley_dir: /opt/v }\n",
    );
    const paired = await runCli(["validate", waveFile(repo)], env);
    expect(paired.exitCode).toBe(0);
    expect(paired.stdout).toContain("placement: auto (placement.default; 1 paired machine)\n");
    // It places, so the preview is attempted (no supervisor here: it says so).
    expect(paired.stdout).toContain("placement preview unavailable");
    writeFileSync(
      join(home, "config.yaml"),
      "require_fresh_base: false\nplacement: { default: local }\nhosts:\n  box-a: { target: dev@box-a, repo: /srv/r, volley_dir: /opt/v }\n",
    );
    const pinned = await runCli(["validate", waveFile(repo)], env);
    expect(pinned.stdout).toContain("placement: local (placement.default)\n");
  });

  it("a repo that is not on this machine is noted, not refused (the daemon checks it at run)", async () => {
    const r = await runCli(["validate", waveFile(join(dir, "elsewhere"))]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("release branch not checked");
  });
});

describe("volleyd validate: the brief preface", () => {
  let dir: string;
  let repo: string;
  beforeEach(() => {
    dir = realpathSync(tempDir("volleyd-validate-preface-"));
    repo = join(dir, "repo");
    mkdirSync(join(repo, ".volley"), { recursive: true });
  });

  // A repo dir that is not a git repository is fine here: the release branch check is not under test.
  const waveFile = (extra = "") => {
    const file = join(dir, "w.yaml");
    writeFileSync(
      file,
      `wave: w1\nrepo: ${join(dir, "elsewhere")}\nrelease_branch: release/x\nmodel: claude-opus-5-5\npipeline: [implement]\n${extra}tasks:\n  T1: { issue: 1 }\n`,
    );
    return file;
  };

  it("prints the preface's path, size and sha256 prefix", async () => {
    const preface = "No names, no local paths.\n";
    const file = join(dir, "rules.md");
    writeFileSync(file, preface);
    const r = await runCli(["validate", waveFile(`brief_preface: ${file}\n`)]);
    expect(r.exitCode).toBe(0);
    const sha = createHash("sha256").update(preface).digest("hex");
    expect(r.stdout).toContain(
      `brief preface: ${file} (${Buffer.byteLength(preface)} B, sha256 ${sha.slice(0, 12)})\n`,
    );
  });

  it("no preface file: `brief preface: none`, with where it was looked for", async () => {
    const r = await runCli(["validate", waveFile()]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      `brief preface: none (no ${join(dir, "elsewhere", ".volley", "brief-preface.md")})\n`,
    );
  });

  it("a preface over brief_preface_max_bytes → BRIEF_PREFACE_TOO_LARGE, exit 1", async () => {
    const file = join(dir, "big.md");
    writeFileSync(file, "x".repeat(1025));
    const r = await runCli([
      "validate",
      waveFile(`brief_preface: ${file}\nconfig: { brief_preface_max_bytes: 1024 }\n`),
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(`BRIEF_PREFACE_TOO_LARGE: ${file} is 1025 B`);
  });
  it("the cap is the operator's: $VOLLEYD_HOME/config.yaml, then the wave's config:", async () => {
    const home = join(dir, "home");
    mkdirSync(home);
    writeFileSync(join(home, "config.yaml"), "brief_preface_max_bytes: 1024\n");
    const file = join(dir, "mid.md");
    writeFileSync(file, "x".repeat(2000));
    const env = { VOLLEY_BROKER_URL: "mqtt://127.0.0.1:1", VOLLEYD_HOME: home };
    const lowered = await runCli(["validate", waveFile(`brief_preface: ${file}\n`)], env);
    expect(lowered.exitCode).toBe(1);
    expect(lowered.stderr).toContain("brief_preface_max_bytes is 1024 B");
    // The wave's own config: wins over the file.
    const waved = await runCli(
      ["validate", waveFile(`brief_preface: ${file}\nconfig: { brief_preface_max_bytes: 4096 }\n`)],
      env,
    );
    expect(waved.exitCode).toBe(0);
  });

  it("prints agent_mcp under inherit, with its allowlist; strict prints nothing", async () => {
    const strict = await runCli(["validate", waveFile()]);
    expect(strict.stdout).not.toContain("agent_mcp");
    const all = await runCli(["validate", waveFile("config: { agent_mcp: inherit }\n")]);
    expect(all.stdout).toContain("agent_mcp: inherit (every user server)\n");
    const allow = await runCli([
      "validate",
      waveFile("config: { agent_mcp: inherit, agent_mcp_allow: [migrations, playwright] }\n"),
    ]);
    expect(allow.exitCode).toBe(0);
    expect(allow.stdout).toContain("agent_mcp: inherit (allow: migrations, playwright)\n");
    // config.yaml's, under the wave's config:.
    const home = join(dir, "home");
    mkdirSync(home);
    writeFileSync(join(home, "config.yaml"), "agent_mcp: inherit\nagent_mcp_allow: [m]\n");
    const env = { VOLLEY_BROKER_URL: "mqtt://127.0.0.1:1", VOLLEYD_HOME: home };
    expect((await runCli(["validate", waveFile()], env)).stdout).toContain(
      "agent_mcp: inherit (allow: m)\n",
    );
    expect(
      (await runCli(["validate", waveFile("config: { agent_mcp: strict }\n")], env)).stdout,
    ).not.toContain("agent_mcp");
  });

  it("a preface that is not valid UTF-8 fails validate", async () => {
    const file = join(dir, "bad.md");
    writeFileSync(file, Buffer.from([0x61, 0xff, 0x0a]));
    const r = await runCli(["validate", waveFile(`brief_preface: ${file}\n`)]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("not valid UTF-8");
  });
});

describe("volleyd validate: the release playbook (SPEC §4.6.19)", () => {
  let dir: string;
  let repo: string;
  beforeEach(() => {
    dir = realpathSync(tempDir("volleyd-validate-playbook-"));
    repo = join(dir, "repo");
    mkdirSync(join(repo, ".volley"), { recursive: true });
    git(repo, "init", "--quiet", "-b", "main");
    git(
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "init",
    );
    git(repo, "remote", "add", "origin", "https://example.com/repo.git");
    git(repo, "update-ref", "refs/remotes/origin/release/x", "HEAD");
  });

  const waveFile = (extra = "") => {
    const file = join(dir, "w.yaml");
    writeFileSync(
      file,
      `wave: w1\nrepo: ${repo}\nrelease_branch: release/x\nmodel: claude-opus-5-5\npipeline: [implement]\n${extra}tasks:\n  T1: { issue: 1 }\n`,
    );
    return file;
  };
  const PLAYBOOK =
    "version: 1\nstages:\n  - { name: smoke, brief: Run the smoke. }\n  - { name: deploy, brief: Deploy., gate: owner }\n";

  it("the default .volley/release.yaml: its path, stage count and owner-gated count", async () => {
    writeFileSync(join(repo, ".volley", "release.yaml"), PLAYBOOK);
    const r = await runCli(["validate", waveFile()]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      "release playbook: .volley/release.yaml (2 stages: 2 prepare, 0 ship, 1 owner-gated)\n",
    );
  });

  it("the Volley repository's own playbook: two prepare stages, two ship stages", async () => {
    copyFileSync(
      new URL("../../../.volley/release.yaml", import.meta.url),
      join(repo, ".volley", "release.yaml"),
    );
    const r = await runCli(["validate", waveFile()]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      "release playbook: .volley/release.yaml (4 stages: 2 prepare, 2 ship, 0 owner-gated)\n",
    );
  });

  it("release_version: 0.14.0 is the wave's; release_version: 14 is refused at its path", async () => {
    const ok = await runCli(["validate", waveFile("release_version: 0.14.0\n")]);
    expect(ok.exitCode).toBe(0);
    const bad = await runCli(["validate", waveFile("release_version: 14\n")]);
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr + bad.stdout).toMatch(/release_version: /);
  });

  it("playbook: <path> overrides it; playbook: none and no file both print none", async () => {
    writeFileSync(join(repo, "release.yaml"), PLAYBOOK);
    const r = await runCli(["validate", waveFile(`playbook: ${join(repo, "release.yaml")}\n`)]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      `release playbook: ${join(repo, "release.yaml")} (2 stages: 2 prepare, 0 ship, 1 owner-gated)\n`,
    );
    for (const extra of ["playbook: none\n", ""]) {
      const n = await runCli(["validate", waveFile(extra)]);
      expect(n.exitCode).toBe(0);
      expect(n.stdout).toContain("release playbook: none\n");
    }
  });

  it("an invalid playbook fails validate with its path-qualified error", async () => {
    const file = join(repo, "release.yaml");
    writeFileSync(file, "version: 1\nstages:\n  - { name: smoke, brief: a, gate: later }\n");
    const r = await runCli(["validate", waveFile(`playbook: ${file}\n`)]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(`RELEASE_PLAYBOOK_INVALID: ${file}: invalid release playbook:`);
    expect(r.stderr).toContain("  stages[0].gate: ");
  });

  it("a configured playbook that does not exist is refused (only the default may be absent)", async () => {
    const r = await runCli(["validate", waveFile(`playbook: ${join(repo, "nope.yaml")}\n`)]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(
      `RELEASE_PLAYBOOK_INVALID: ${join(repo, "nope.yaml")}: no such file`,
    );
  });
});

describe("volleyd validate: placement preview (SPEC §4.6.15)", () => {
  let dir: string;
  let broker: TestBroker;
  let pub: VolleyBroker;
  beforeEach(async () => {
    dir = realpathSync(tempDir("volleyd-validate-place-"));
    broker = await startTestBroker();
    pub = new VolleyBroker();
    await pub.connect({ url: broker.url, agentId: "volleyd" });
  });
  afterEach(async () => {
    await pub.disconnect();
    await broker.close();
  });

  const retain = (
    topic: string,
    channel: string,
    type: string,
    payload: unknown,
    agentId = "volleyd",
  ) =>
    pub.publish(
      topic,
      JSON.stringify(buildEnvelope({ agentId, parentId: null, channel, type, payload })),
      { qos: 1, retain: true },
    );
  const machine = (name: string, over: Record<string, unknown> = {}) => ({
    name,
    os: "linux",
    cores: 16,
    tunnel: "up",
    load: [3.2, 3, 2],
    agents: 0,
    memory: { total_mb: 65536, available_pct: 71 },
    last_seen: "2026-10-19T09:00:00.000Z",
    ...over,
  });
  const verdict = (name: string, over: Record<string, unknown> = {}) => ({
    name,
    ready: true,
    reasons: [],
    drain: false,
    max_agents: 4,
    placed: 0,
    path_ok: { claude: true, bun: true },
    requirements: { volley: "0.4.0" },
    heavy: {},
    usage: { account: null, five_hour_pct: 34 },
    eligible: true,
    checked_at: "2026-10-19T09:00:00.000Z",
    ...over,
  });
  const waveFile = (head: string) => {
    const file = join(dir, "w.yaml");
    // The repo is not on this machine and every task is placed: no release-branch check here.
    writeFileSync(
      file,
      `wave: w1\nrepo: ${join(dir, "elsewhere")}\nrelease_branch: release/x\nmodel: claude-opus-5-5\npipeline: [implement]\n${head}tasks:\n  T1: { issue: 1 }\n  T3: { issue: 3 }\n`,
    );
    return file;
  };
  const env = () => ({ VOLLEY_BROKER_URL: broker.url, VOLLEYD_HOME: join(dir, "home") });

  it("prints where each auto task would go if admitted now, and that admission decides", async () => {
    await retain(CONFIG_TOPIC, "_waves/_config", "config", {
      ...CONFIG_DEFAULTS,
      fleet: { local_name: "control" },
    });
    await retain(machineTopic("box-a"), MACHINE_CHANNEL, "machine", machine("box-a"), "box-a");
    await retain(
      machineTopic("control"),
      MACHINE_CHANNEL,
      "machine",
      machine("control", {
        kind: "supervisor",
        tunnel: "local",
        cores: 8,
        load: [6, 6, 6],
        memory: { total_mb: 8192, available_pct: 40 },
      }),
    );
    await retain(
      `${machineTopic("box-a")}/readiness`,
      "_system/machines/readiness",
      "readiness",
      verdict("box-a", { max_agents: 1 }),
    );
    await retain(
      `${machineTopic("control")}/readiness`,
      "_system/machines/readiness",
      "readiness",
      verdict("control", { max_agents: 12, placed: 2 }),
    );
    const r = await runCli(["validate", waveFile("placement: auto\n")], env());
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      "if admitted now: T1 → box-a (0.85), T3 → local (0.58)\n  (from the machines' records now; the real decision is made at admission)\n",
    );
  });

  it("a wave that does not place prints no preview; no supervisor config says so", async () => {
    const plain = await runCli(["validate", waveFile("")], env());
    expect(plain.exitCode).toBe(0);
    expect(plain.stdout).not.toContain("admitted now");
    const r = await runCli(["validate", waveFile("placement: auto\n")], env());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      "placement preview unavailable (no supervisor config on the broker): tasks are placed at admission\n",
    );
  });
});

describe("volleyd validate: a task pinned to local under fleet.local_agents: never (SPEC §4.6.15)", () => {
  const wave = (head: string, tasks: string) =>
    parseWaveFile(
      `wave: w1\nrepo: /srv/repo\nrelease_branch: release/w1\nmodel: m\npipeline: [implement]\n${head}tasks:\n${tasks}`,
    );
  const homeWith = (yaml: string | null) => {
    const home = tempDir("volleyd-validate-home-");
    if (yaml !== null) writeFileSync(join(home, "config.yaml"), yaml);
    return { VOLLEYD_HOME: home };
  };
  const PINNED = "  T1: { issue: 1, host: local }\n  T2: { issue: 2 }\n";

  it("warns once per pinned task of a placement: auto wave; the task still runs there", () => {
    expect(
      localPinWarnings(
        wave("placement: auto\n", PINNED),
        homeWith("fleet:\n  local_agents: never\n"),
      ),
    ).toBe(
      "warning: T1 pins host: local while fleet.local_agents is never; it still runs there (the wave file is explicit)\n",
    );
  });

  it("says nothing under another mode, without config.yaml, or for a wave that does not place", () => {
    const w = wave("placement: auto\n", PINNED);
    expect(localPinWarnings(w, homeWith("fleet:\n  local_agents: fallback\n"))).toBe("");
    expect(localPinWarnings(w, homeWith(null))).toBe("");
    expect(localPinWarnings(wave("", PINNED), homeWith("fleet:\n  local_agents: never\n"))).toBe(
      "",
    );
  });

  it("reads the wave's own config: block over config.yaml", () => {
    const never = wave("placement: auto\nconfig:\n  fleet:\n    local_agents: never\n", PINNED);
    expect(localPinWarnings(never, homeWith(null))).toContain("warning: T1 pins host: local");
    const fallback = wave(
      "placement: auto\nconfig:\n  fleet:\n    local_agents: fallback\n",
      PINNED,
    );
    expect(localPinWarnings(fallback, homeWith("fleet:\n  local_agents: never\n"))).toBe("");
  });
});

describe("volleyd validate: footprints and the overlap plan (SPEC §4.6.22)", () => {
  const fixture = new URL("./fixtures/bundle.yaml", import.meta.url).pathname;

  it("prints the file's own plan after the placement line, then the footprint line", async () => {
    const r = await runCli(["validate", fixture]);
    expect(r.exitCode).toBe(0);
    const out = r.stdout.split("\n");
    const at = out.findIndex((l) => l.startsWith("placement: "));
    expect(at).toBeGreaterThan(0);
    expect(out.slice(at + 1, at + 5)).toEqual([
      "cluster A: 3 tasks share packages/app/src/pipeline.ts (2 tasks) → 1 bundle (i1), 1 chain (i1 → i3)",
      "independent: i4",
      "expected branch updates: ≤ 2 (was ≤ 3 one at a time)",
      "footprints: 3 listed, 1 resolved; 1 entry unresolved (i3: helpers.ts)",
    ]);
  });

  it("a wave with no files: on any task says where footprints come from", async () => {
    const dir = tempDir("volleyd-validate-fp-");
    const file = join(dir, "w.yaml");
    writeFileSync(
      file,
      "wave: w1\nrepo: /path/to/example-repo\nrelease_branch: release/x\nmodel: claude-opus-5-5\npipeline: [implement]\ntasks:\n  T1: { issue: 1 }\n",
    );
    const r = await runCli(["validate", file]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      "footprints: none (write them with wave-from-issues, or the daemon reads each issue's Files list at run)\n",
    );
    expect(r.stdout).not.toContain("expected branch updates");
  });

  it("with the repository's tree, notes where the file differs from the planner (kept as written)", async () => {
    const dir = realpathSync(tempDir("volleyd-validate-plan-"));
    const repo = join(dir, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src/big.ts"), "x".repeat(40_000));
    writeFileSync(join(repo, "src/a.ts"), "a");
    writeFileSync(join(repo, "src/b.ts"), "b");
    git(repo, "init", "--quiet", "-b", "release/x");
    git(repo, "add", ".");
    git(
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "--quiet",
      "-m",
      "i",
    );
    const file = join(dir, "w.yaml");
    writeFileSync(
      file,
      `wave: w1\nrepo: ${repo}\nrelease_branch: release/x\nmodel: claude-opus-5-5\npipeline: [implement]\nconfig: { require_fresh_base: false }\ntasks:
  i1: { issue: 1, files: [src/big.ts, src/a.ts], footprint: { confidence: listed } }
  i2: { issue: 2, files: [src/big.ts, src/b.ts], footprint: { confidence: listed } }
`,
    );
    const r = await runCli(["validate", file]);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      "note: i1 and i2 run as separate tasks; the planner would bundle them as i1 — kept as written\n",
    );
    expect(r.stdout).toContain("footprints: 2 listed\n");
  });
});

describe("volleyd validate: an owner/name repo: resolved offline as run resolves it (#448)", () => {
  let dir: string;
  let home: string;
  beforeEach(() => {
    dir = realpathSync(tempDir("volleyd-validate-slug-"));
    home = join(dir, "home");
    mkdirSync(home);
  });
  const env = () => ({ VOLLEY_BROKER_URL: "mqtt://127.0.0.1:1", VOLLEYD_HOME: home });
  const waveFile = (head = "", task = "{ issue: 1 }") => {
    const file = join(dir, "w.yaml");
    writeFileSync(
      file,
      `wave: w1\nrepo: b/b\nrelease_branch: release/x\nmodel: claude-opus-5-5\npipeline: [implement]\n${head}tasks:\n  T1: ${task}\nconfig: { require_fresh_base: false }\n`,
    );
    return file;
  };
  const BOX = "hosts:\n  box:\n    target: dev@box\n    volley_dir: /opt/volley\n";

  it("this machine's clone: the line names it, and its release branch is checked", async () => {
    const clone = join(dir, "managed", "b", "b");
    mkdirSync(clone, { recursive: true });
    git(clone, "init", "--quiet", "-b", "main");
    git(
      clone,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "init",
    );
    writeFileSync(
      join(home, "config.yaml"),
      `fleet:\n  local_name: control\n  repo_root: ${join(dir, "managed")}\n${BOX}repos:\n  b/b: { machines: [control, box] }\n`,
    );
    const missing = await runCli(["validate", waveFile("placement: local\n")], env());
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain(`RELEASE_BRANCH_MISSING: ${clone} has neither release/x`);
    git(clone, "branch", "release/x");
    const r = await runCli(["validate", waveFile("placement: local\n")], env());
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`repo: b/b → ${clone} (this machine's clone)\n`);
  });

  it("held by paired machines only: accepted, saying where its tasks run", async () => {
    writeFileSync(
      join(home, "config.yaml"),
      `fleet:\n  local_name: control\n${BOX}repos:\n  b/b: { machines: [box] }\n`,
    );
    const r = await runCli(["validate", waveFile("placement: auto\n")], env());
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      "repo: b/b (no clone on this machine; held by box: its tasks run there)\n",
    );
    expect(r.stdout).not.toContain("is not on this machine");
    const pinned = await runCli(
      ["validate", waveFile("placement: auto\n", "{ issue: 1, host: local }")],
      env(),
    );
    expect(pinned.exitCode).toBe(1);
    expect(pinned.stderr).toContain(
      "tasks.T1.host: no clone of b/b on control: drop its host: local (or set host: auto) so it runs on box, or add the clone (volley repo add b/b --machine control)",
    );
  });

  it("held by no machine: refused at repo, naming the paired machine, or this one with none", async () => {
    writeFileSync(join(home, "config.yaml"), `fleet:\n  local_name: control\n${BOX}`);
    const r = await runCli(["validate", waveFile("placement: auto\n")], env());
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(
      "repo: no clone of b/b on any machine: add it to one (Settings → Repositories, or volley repo add b/b --machine box)",
    );
    const bare = join(dir, "bare-home");
    mkdirSync(bare);
    const none = await runCli(["validate", waveFile()], { ...env(), VOLLEYD_HOME: bare });
    expect(none.exitCode).toBe(1);
    expect(none.stderr).toContain(
      `repo: no clone of b/b on any machine: add it to one (Settings → Repositories, or volley repo add b/b --machine ${localMachineName()})`,
    );
  });

  it("a config.yaml that does not parse: the refusal says so, not only that no machine holds it", async () => {
    writeFileSync(join(home, "config.yaml"), "repos: [unclosed\n");
    const r = await runCli(["validate", waveFile()], env());
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("repo: no clone of b/b on any machine");
    expect(r.stderr).toContain(
      `(${join(home, "config.yaml")} does not parse: read as nothing configured)`,
    );
  });
});
