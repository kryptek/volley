import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./helpers/run-cli";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

describe("volleyd validate: the release branch", () => {
  let dir: string;
  let repo: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "volleyd-validate-")));
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
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

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

  it("only origin/release/x (pushed from another clone) is enough", async () => {
    git(repo, "update-ref", "refs/remotes/origin/release/x", "HEAD");
    const r = await runCli(["validate", waveFile(repo)]);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
  });

  it("the local branch is enough", async () => {
    git(repo, "branch", "release/x");
    expect((await runCli(["validate", waveFile(repo)])).exitCode).toBe(0);
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
    dir = realpathSync(mkdtempSync(join(tmpdir(), "volleyd-validate-preface-")));
    repo = join(dir, "repo");
    mkdirSync(join(repo, ".volley"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

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
