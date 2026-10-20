import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { CONFIG_DEFAULTS } from "../src/config-defaults";
import { CONFIG_TOPIC } from "../src/control";
import { MACHINE_CHANNEL, machineTopic } from "../src/machines";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { runCli } from "./helpers/run-cli";
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
      "release playbook: .volley/release.yaml (2 stages, 1 owner-gated)\n",
    );
  });

  it("playbook: <path> overrides it; playbook: none and no file both print none", async () => {
    writeFileSync(join(repo, "release.yaml"), PLAYBOOK);
    const r = await runCli(["validate", waveFile(`playbook: ${join(repo, "release.yaml")}\n`)]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      `release playbook: ${join(repo, "release.yaml")} (2 stages, 1 owner-gated)\n`,
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
