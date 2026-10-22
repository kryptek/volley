import { basename } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeBufferIO } from "../../src/io";
import {
  type DoctorDeps,
  type DoctorOptions,
  type DoctorReport,
  doctor,
  normalizeOrigin,
  runDoctor,
} from "../../src/peer/doctor";
import { VM_STAT_MAC_16GB } from "../fixtures/vm-stat";
import {
  type FakeMachineOptions,
  type FakePeerMachine,
  fakePeerMachine,
} from "../helpers/fake-peer-machine";

let box: FakePeerMachine | null = null;
afterEach(() => {
  box?.cleanup();
  box = null;
});
const machine = (o: FakeMachineOptions = {}) => {
  box = fakePeerMachine(o);
  return box;
};

/** The verb: `volley peer doctor [opts]` on the fake box. */
async function run(
  m: FakePeerMachine,
  opts: Partial<DoctorOptions> = {},
  over: Partial<DoctorDeps> = {},
) {
  const io = makeBufferIO();
  const exit = await doctor(io, m.deps(over), { repo: m.repoPath, ...opts });
  return { exit, stdout: io.readStdout(), stderr: io.readStderr() };
}

const report = async (m: FakePeerMachine, opts: Partial<DoctorOptions> = {}) => {
  const r = await run(m, { ...opts, json: true });
  return JSON.parse(r.stdout) as DoctorReport;
};
const check = (r: DoctorReport, id: string) => r.checks.find((c) => c.id === id);

/** Everything that changes the box: what a fix runs. */
const MUTATING = (m: FakePeerMachine) =>
  m.calls
    .map((c) => c.argv)
    .filter(
      (a) =>
        (basename(a[0] ?? "") === "bun" && a[1] === "install" && !a.includes("--dry-run")) ||
        a.includes("clone") ||
        a.includes("checkout") ||
        a.includes("fetch") ||
        a.includes("set-url") ||
        a[0] === "ln" ||
        a[0] === "sudo",
    );

describe("volley peer doctor: tools and PATH", () => {
  it("a healthy box passes every check and reports versions", async () => {
    const m = machine({ trusted: true });
    const r = await report(m);
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.versions).toEqual({
      peer: "0.4.0",
      volley: "0.4.0",
      bun: "1.3.2",
      git: "2.43.0",
      gh: "2.62.0",
      tmux: "3.4",
      claude: "2.0.14",
    });
    expect(r.doctor_at).toBe("2026-10-19T09:00:00.000Z");
    for (const id of ["tool.bun", "tool.tmux", "tool.claude"]) {
      expect(check(r, id)).toMatchObject({ ok: true, severity: "block" });
    }
    for (const id of ["bun_on_path", "claude_on_path"]) {
      expect(check(r, id)).toMatchObject({ ok: true, severity: "warn" });
    }
  });

  it("claude missing from the estimated non-interactive PATH warns, labelled an estimate; its fix is the symlink, never run", async () => {
    const m = machine({
      tools: { claude: { path: "/path/to/home/.local/bin/claude", sshPath: null } },
    });
    const r = await report(m);
    // An estimate (the supervisor's own path_ok probe decides): it warns, it never blocks.
    expect(check(r, "claude_on_path")).toMatchObject({
      ok: false,
      severity: "warn",
      fix: "sudo ln -s /path/to/home/.local/bin/claude /usr/local/bin/claude",
    });
    expect(check(r, "claude_on_path")?.detail).toMatch(/^estimated: /);
    expect(check(r, "claude_on_path")?.detail).toContain("path_ok");
    // Installed, so tool.claude passes and its version is reported.
    expect(check(r, "tool.claude")?.ok).toBe(true);
    expect(r.versions.claude).toBe("2.0.14");

    const fixed = await run(m, { fix: true, yes: true });
    expect(fixed.stdout).toContain(
      "sudo ln -s /path/to/home/.local/bin/claude /usr/local/bin/claude",
    );
    expect(MUTATING(m)).toEqual([]);
    expect(fixed.exit).toBe(0);
  });

  it("a passing PATH check is labelled an estimate too, naming the shell it probed", async () => {
    const r = await report(machine({ shell: "/bin/zsh" }));
    for (const id of ["bun_on_path", "claude_on_path"]) {
      expect(check(r, id)?.detail).toMatch(/^estimated: .*\/bin\/zsh/);
      expect(check(r, id)?.severity).toBe("warn");
    }
  });

  it("the PATH fix follows the login shell: zsh's ~/.zshenv, fish's fish_add_path, bash on macOS has none", async () => {
    const off = { claude: { path: "/path/to/home/.local/bin/claude", sshPath: null } };
    const zsh = await report(machine({ platform: "darwin", shell: "/bin/zsh", tools: off }));
    expect(check(zsh, "claude_on_path")?.fix).toBe(
      `echo 'export PATH="/path/to/home/.local/bin:$PATH"' >> ~/.zshenv`,
    );
    box?.cleanup();
    const fish = await report(
      machine({ platform: "darwin", shell: "/opt/homebrew/bin/fish", tools: off }),
    );
    expect(check(fish, "claude_on_path")?.fix).toBe(
      "fish -c 'fish_add_path -U /path/to/home/.local/bin'",
    );
    box?.cleanup();
    // bash -c reads no startup file and macOS's sshd PATH cannot be extended by the user.
    const bash = await report(machine({ platform: "darwin", shell: "/bin/bash", tools: off }));
    const fix = check(bash, "claude_on_path")?.fix ?? "";
    // Not the ~/.zshenv line a bash login shell never reads.
    expect(fix).not.toMatch(/^echo /);
    expect(fix).toContain("chsh -s /bin/zsh");
    expect(fix).toContain("SetEnv");
    expect(fix).toContain("path_ok");
    box?.cleanup();
    // Linux: /usr/local/bin is on sshd's PATH whatever the shell.
    const linux = await report(machine({ shell: "/bin/zsh", tools: off }));
    expect(check(linux, "claude_on_path")?.fix).toBe(
      "sudo ln -s /path/to/home/.local/bin/claude /usr/local/bin/claude",
    );
  });

  it("probes run by absolute path: a service whose PATH lacks bun and claude (launchd) still reads healthy", async () => {
    const m = machine({
      platform: "darwin",
      shell: "/bin/zsh",
      trusted: true,
      tools: {
        bun: { path: null, sshPath: "/path/to/home/.bun/bin/bun" },
        claude: { path: null, sshPath: "/path/to/home/.local/bin/claude" },
      },
    });
    const r = await report(m);
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.versions.bun).toBe("1.3.2");
    expect(r.versions.claude).toBe("2.0.14");
    expect(r.auth.claude).toBe("signed_in");
    const argv = m.calls.map((c) => c.argv);
    expect(argv).toContainEqual(["/path/to/home/.bun/bin/bun", "--version"]);
    expect(argv).toContainEqual([
      "/path/to/home/.bun/bin/bun",
      "install",
      "--cwd",
      m.volleyDir,
      "--frozen-lockfile",
      "--dry-run",
    ]);
    expect(argv).toContainEqual(["/path/to/home/.local/bin/claude", "auth", "status"]);
    // Nothing runs by a bare name the service's PATH may not reach.
    for (const a of argv) {
      if (["bun", "claude", "gh", "git", "tmux"].includes(a[0] as string)) {
        throw new Error(`ran ${a.join(" ")} by its bare name`);
      }
    }
  });

  it("a missing tool explains how to install it and never installs", async () => {
    const m = machine({ tools: { tmux: { path: null, sshPath: null } } });
    const r = await report(m);
    expect(check(r, "tool.tmux")).toMatchObject({ ok: false, severity: "block" });
    expect(check(r, "tool.tmux")?.fix).toBe("sudo apt-get install -y tmux");
    expect(r.versions.tmux).toBeNull();
    await run(m, { fix: true, yes: true });
    expect(MUTATING(m)).toEqual([]);
  });

  it("the human output has one line per check with its mark, and the fix under a failing one", async () => {
    const m = machine({
      tools: { claude: { path: "/path/to/home/.local/bin/claude", sshPath: null } },
    });
    const r = await run(m);
    expect(r.exit).toBe(0);
    expect(r.stdout).toMatch(/^✓ tool\.bun: /m);
    expect(r.stdout).toMatch(/^! claude_on_path: estimated: /m);
    expect(r.stdout).toMatch(
      /^! claude_on_path: .*\n {4}fix: sudo ln -s \/path\/to\/home\/\.local\/bin\/claude \/usr\/local\/bin\/claude$/m,
    );
  });

  it("install fixes are exact for the platform and its package manager", async () => {
    const fixOf = async (o: FakeMachineOptions, tool: string) => {
      const f = check(await report(machine(o)), `tool.${tool}`)?.fix;
      box?.cleanup();
      return f;
    };
    const gone = (t: string) => ({ tools: { [t]: { path: null, sshPath: null } } });
    expect(await fixOf({ platform: "darwin", ...gone("tmux") }, "tmux")).toBe("brew install tmux");
    expect(await fixOf({ platform: "darwin", ...gone("gh") }, "gh")).toBe("brew install gh");
    expect(await fixOf({ platform: "darwin", ...gone("git") }, "git")).toBe(
      "xcode-select --install",
    );
    expect(await fixOf({ platform: "darwin", ...gone("nc") }, "nc")).toContain("ships with macOS");
    expect(await fixOf({ platform: "darwin", ...gone("cmp") }, "cmp")).toContain("/usr/bin");
    expect(await fixOf(gone("tmux"), "tmux")).toBe("sudo apt-get install -y tmux");
    expect(await fixOf(gone("nc"), "nc")).toBe("sudo apt-get install -y netcat-openbsd");
    expect(await fixOf(gone("base64"), "base64")).toBe("sudo apt-get install -y coreutils");
    expect(await fixOf(gone("cmp"), "cmp")).toBe("sudo apt-get install -y diffutils");
    expect(await fixOf(gone("gh"), "gh")).toContain("cli.github.com");
    expect(await fixOf({ pkg: "dnf", ...gone("tmux") }, "tmux")).toBe("sudo dnf install -y tmux");
    expect(await fixOf({ pkg: "dnf", ...gone("nc") }, "nc")).toBe("sudo dnf install -y nmap-ncat");
    expect(await fixOf({ pkg: null, ...gone("tmux") }, "tmux")).toContain("package manager");
    for (const platform of ["darwin", "linux"] as const) {
      expect(await fixOf({ platform, ...gone("bun") }, "bun")).toBe(
        "curl -fsSL https://bun.sh/install | bash",
      );
    }
  });
});

describe("volley peer doctor: the volley checkout", () => {
  it("--fix runs bun install --frozen-lockfile in the volley checkout and nothing else", async () => {
    const m = machine({ volleyInstalled: false });
    expect(check(await report(m), "volley.installed")).toMatchObject({
      ok: false,
      severity: "block",
    });
    m.calls.length = 0;
    const r = await run(m, { fix: true, yes: true });
    expect(MUTATING(m)).toEqual([
      ["/usr/bin/bun", "install", "--cwd", m.volleyDir, "--frozen-lockfile"],
    ]);
    expect(r.exit).toBe(0);
    expect(r.stdout).toContain("bun install --cwd");
  });

  it("--fix asks first unless --yes; a no changes nothing", async () => {
    const m = machine({ volleyInstalled: false });
    const asked: string[] = [];
    const r = await run(
      m,
      { fix: true },
      {
        confirm: async (q) => {
          asked.push(q);
          return false;
        },
      },
    );
    expect(asked).toHaveLength(1);
    expect(MUTATING(m)).toEqual([]);
    expect(r.stdout).toContain("Nothing changed");
  });

  it("a supervisor's version requirement checks out its tag and reinstalls", async () => {
    const m = machine({ volleyVersion: "0.3.0" });
    const r1 = await report(m, { requiredVolley: "0.4.0" });
    expect(check(r1, "volley.version")).toMatchObject({ ok: false, severity: "block" });
    expect(check(r1, "volley.version")?.detail).toContain("0.4.0");
    m.calls.length = 0;
    await run(m, { requiredVolley: "0.4.0", fix: true, yes: true });
    expect(MUTATING(m)).toEqual([
      ["/usr/bin/git", "-C", m.volleyDir, "fetch", "origin", "--tags"],
      ["/usr/bin/git", "-C", m.volleyDir, "checkout", "--detach", "v0.4.0"],
      ["/usr/bin/bun", "install", "--cwd", m.volleyDir, "--frozen-lockfile"],
    ]);
  });

  it("a requirement that reads like an option is never passed to git", async () => {
    const m = machine({ volleyVersion: "0.3.0" });
    m.calls.length = 0;
    await run(m, { requiredVolley: "-f", fix: true, yes: true });
    expect(MUTATING(m)).toEqual([]);
  });

  it("a fresh checkout behind the supervisor: --fix checks out, then reinstalls, then reads healthy", async () => {
    const m = machine({ volleyInstalled: false, volleyVersion: "0.3.0" });
    const r = await run(m, { requiredVolley: "0.4.0", fix: true, yes: true });
    // The install the version fix ends with runs after the checkout, not before it only.
    expect(MUTATING(m)).toEqual([
      ["/usr/bin/git", "-C", m.volleyDir, "fetch", "origin", "--tags"],
      ["/usr/bin/git", "-C", m.volleyDir, "checkout", "--detach", "v0.4.0"],
      ["/usr/bin/bun", "install", "--cwd", m.volleyDir, "--frozen-lockfile"],
    ]);
    expect(r.stdout).toMatch(/^✓ volley\.installed: /m);
    expect(r.stdout).toMatch(/^✓ volley\.version: /m);
    expect(r.exit).toBe(0);
  });

  it("a checkout that moved bun.lock without a reinstall is not installed (stale dependencies)", async () => {
    const m = machine({ volleyVersion: "0.3.0" });
    expect(check(await report(m), "volley.installed")?.ok).toBe(true);
    // A `git pull` / checkout by hand: bun.lock changes, node_modules does not.
    await m.exec(["git", "-C", m.volleyDir, "checkout", "--detach", "v0.4.0"]);
    const r = await report(m);
    expect(check(r, "volley.installed")).toMatchObject({ ok: false, severity: "block" });
    expect(check(r, "volley.installed")?.detail).toContain("bun.lock");
    m.calls.length = 0;
    const fixed = await run(m, { fix: true, yes: true });
    expect(MUTATING(m)).toEqual([
      ["/usr/bin/bun", "install", "--cwd", m.volleyDir, "--frozen-lockfile"],
    ]);
    expect(fixed.stdout).toMatch(/^✓ volley\.installed: /m);
  });

  it("an install from an older bun.lock is stale; --fix reinstalls and clears it", async () => {
    const m = machine({ staleInstall: true });
    expect(check(await report(m), "volley.installed")?.ok).toBe(false);
    const r = await run(m, { fix: true, yes: true });
    expect(r.exit).toBe(0);
    expect(check(await report(m), "volley.installed")?.ok).toBe(true);
  });

  it("package.json and bun.lock disagreeing is explained, with no fix the doctor would run", async () => {
    const m = machine({ lockDrift: true });
    const r = await report(m);
    const c = check(r, "volley.installed");
    expect(c).toMatchObject({ ok: false, severity: "block" });
    expect(c?.detail).toContain("package.json and bun.lock disagree");
    expect(c?.fix).toContain(`git -C ${m.volleyDir} status`);
    m.calls.length = 0;
    await run(m, { fix: true, yes: true });
    expect(MUTATING(m)).toEqual([]);
  });

  it("without bun the checkout's dependencies cannot be verified (and no fix runs bun)", async () => {
    const m = machine({ tools: { bun: { path: null, sshPath: null } } });
    const c = check(await report(m), "volley.installed");
    expect(c?.ok).toBe(false);
    expect(c?.detail).toContain("without bun");
    m.calls.length = 0;
    await run(m, { fix: true, yes: true });
    expect(MUTATING(m)).toEqual([]);
  });
});

describe("volley peer doctor: the wave repo", () => {
  it("--clone with an empty path and a known origin runs exactly one git clone", async () => {
    const m = machine({ repo: "empty" });
    const origin = "https://github.com/example-org/example-repo.git";
    const r1 = await report(m, { origin });
    expect(check(r1, "repo.clone")).toMatchObject({ ok: false, severity: "block" });
    m.calls.length = 0;
    const r = await run(m, { origin, fix: true, yes: true, clone: true });
    expect(MUTATING(m)).toEqual([
      [
        "env",
        "GIT_TERMINAL_PROMPT=0",
        "GIT_ASKPASS=",
        "SSH_ASKPASS=",
        "GIT_SSH_COMMAND=ssh -o BatchMode=yes",
        "/usr/bin/git",
        "clone",
        "--",
        origin,
        m.repoPath,
      ],
    ]);
    expect(r.exit).toBe(0);
  });

  it("without an origin the clone's fix names the doctor flags that do it", async () => {
    const m = machine({ repo: "empty" });
    expect(check(await report(m), "repo.clone")?.fix).toContain("--fix --clone --origin <url>");
  });

  it("without --clone the clone is printed, not run", async () => {
    const m = machine({ repo: "absent" });
    const origin = "https://github.com/example-org/example-repo.git";
    const r = await run(m, { origin, fix: true, yes: true });
    expect(MUTATING(m)).toEqual([]);
    expect(r.stdout).toContain(`git clone ${origin} ${m.repoPath}`);
    expect(r.stdout).toContain("--clone");
  });

  it("no --repo at all is a block check", async () => {
    const m = machine();
    const io = makeBufferIO();
    await doctor(io, m.deps(), { json: true });
    const r = JSON.parse(io.readStdout()) as DoctorReport;
    expect(check(r, "repo.clone")).toMatchObject({ ok: false, severity: "block" });
    expect(check(r, "repo.clone")?.detail).toContain("--repo");
    expect(r.repo).toBeUndefined();
  });

  it("a wrong origin is explained, never changed", async () => {
    const m = machine({ origin: "git@github.com:someone-else/fork.git" });
    const r = await report(m, { origin: "https://github.com/example-org/example-repo" });
    const c = check(r, "repo.origin");
    expect(c).toMatchObject({ ok: false, severity: "block" });
    expect(c?.detail).toContain("github.com/someone-else/fork");
    expect(c?.detail).toContain("github.com/example-org/example-repo");
    expect(r.repo?.origin).toBe("github.com/someone-else/fork");
    m.calls.length = 0;
    await run(m, { origin: "https://github.com/example-org/example-repo", fix: true, yes: true });
    expect(MUTATING(m)).toEqual([]);
  });

  it("reports the clone in the record shape: normalised origin, release branch, fetchable", async () => {
    const m = machine({ origin: "https://user:secret@github.com/example-org/example-repo.git" });
    const r = await report(m, { release: "release/2026-10-19-fleet" });
    expect(r.repo).toEqual({
      path: m.repoPath,
      exists: true,
      origin: "github.com/example-org/example-repo",
      release_branch: "release/2026-10-19-fleet",
      fetched_at: null,
    });
    expect(check(r, "repo.fetch")?.ok).toBe(true);
    // No prompt of any kind: git's own, an askpass helper, or ssh's (passphrase, host key).
    expect(m.calls.map((c) => c.argv).filter((a) => a.includes("ls-remote"))).toEqual([
      [
        "env",
        "GIT_TERMINAL_PROMPT=0",
        "GIT_ASKPASS=",
        "SSH_ASKPASS=",
        "GIT_SSH_COMMAND=ssh -o BatchMode=yes",
        "/usr/bin/git",
        "-C",
        m.repoPath,
        "ls-remote",
        "--exit-code",
        "origin",
        "refs/heads/release/2026-10-19-fleet",
      ],
    ]);
  });

  it("normalises origins: ssh and https forms fold, credentials and .git are stripped", () => {
    for (const url of [
      "git@github.com:example-org/example-repo.git",
      "https://github.com/example-org/example-repo",
      "https://x-access-token:ghp_abc@github.com/example-org/example-repo.git",
      "ssh://git@github.com/example-org/example-repo.git/",
      "git+ssh://git@github.com/example-org/example-repo",
    ]) {
      expect(normalizeOrigin(url)).toBe("github.com/example-org/example-repo");
    }
    expect(normalizeOrigin("ssh://git@git.example.com:2222/team/repo.git")).toBe(
      "git.example.com:2222/team/repo",
    );
    expect(normalizeOrigin("/srv/git/repo.git")).toBeNull();
    // GitHub's owner and repo names are case-insensitive; other hosts keep their case.
    expect(normalizeOrigin("https://github.com/Example-Org/Example-Repo.git")).toBe(
      "github.com/example-org/example-repo",
    );
    expect(normalizeOrigin("ssh://git@git.example.com/Team/Repo")).toBe(
      "git.example.com/Team/Repo",
    );
  });
});

describe("volley peer doctor: GitHub and Claude", () => {
  it("gh signed in without write permission is no_write, naming the repo and the GitHub user", async () => {
    const m = machine({ gh: { permission: "READ", user: "octocat" } });
    const r = await report(m);
    expect(r.auth.gh).toBe("no_write");
    const c = check(r, "gh.auth");
    expect(c?.ok).toBe(false);
    expect(c?.detail).toContain("example-org/example-repo");
    expect(c?.detail).toContain("octocat");
    expect(m.ran("gh", "repo", "view")).toEqual([
      [
        "/usr/bin/gh",
        "repo",
        "view",
        "example-org/example-repo",
        "--json",
        "viewerPermission",
        "--jq",
        ".viewerPermission",
      ],
    ]);
  });

  it("gh states: ok with write, unauthenticated signed out, missing without gh", async () => {
    expect((await report(machine({ gh: { permission: "ADMIN" } }))).auth.gh).toBe("ok");
    box?.cleanup();
    const out = await report(machine({ gh: { signedIn: false } }));
    expect(out.auth.gh).toBe("unauthenticated");
    expect(check(out, "gh.auth")?.fix).toContain("gh auth login");
    expect(check(out, "gh.auth")?.fix).toContain("gh auth setup-git");
    box?.cleanup();
    expect((await report(machine({ tools: { gh: { path: null, sshPath: null } } }))).auth.gh).toBe(
      "missing",
    );
  });

  it("claude auth status loggedIn with subscriptionType: signed_in and the plan", async () => {
    const m = machine({
      claudeStatus: { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" },
    });
    const r = await report(m);
    expect(r.auth.claude).toBe("signed_in");
    expect(r.auth.claude_plan).toBe("max");
    expect(check(r, "claude.signin")?.ok).toBe(true);
  });

  it("claude states: not_signed_in, missing, unknown", async () => {
    const out = await report(machine({ claudeStatus: { loggedIn: false }, claudeCode: 1 }));
    expect(out.auth.claude).toBe("not_signed_in");
    expect(out.auth.claude_plan).toBeUndefined();
    expect(check(out, "claude.signin")).toMatchObject({ ok: false, severity: "warn" });
    // The Desk's sign-in is not there yet: the fix names only what exists.
    expect(check(out, "claude.signin")?.fix).not.toContain("Desk");
    box?.cleanup();
    const missing = await report(machine({ tools: { claude: { path: null, sshPath: null } } }));
    expect(missing.auth.claude).toBe("missing");
    box?.cleanup();
    expect((await report(machine({ claudeStatus: "something else" }))).auth.claude).toBe("unknown");
  });

  it("folder trust comes from the box's ~/.claude.json; a parent folder counts", async () => {
    const untrusted = await report(machine());
    expect(untrusted.auth.trust).toBe("missing");
    expect(check(untrusted, "claude.trust")).toMatchObject({ ok: false, severity: "warn" });
    box?.cleanup();
    const m = fakePeerMachine();
    box = m;
    const { writeFileSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    writeFileSync(
      join(m.home, ".claude.json"),
      JSON.stringify({ projects: { [dirname(m.repoPath)]: { hasTrustDialogAccepted: true } } }),
    );
    expect((await report(m)).auth.trust).toBe("ok");
  });
});

describe("volley peer doctor: machine and secrets", () => {
  it("reports memory and disk at the worktree root", async () => {
    const m = machine();
    const seen: string[] = [];
    const io = makeBufferIO();
    await doctor(
      io,
      m.deps({
        statfs: (p) => {
          seen.push(p);
          return { bsize: 4096, blocks: 262_144_000, bavail: 2_621_440 };
        },
      }),
      { repo: m.repoPath, json: true },
    );
    const r = JSON.parse(io.readStdout()) as DoctorReport;
    expect(r.memory).toEqual({ total_mb: 16384, available_pct: 50 });
    expect(r.disk?.free_gb).toBe(10);
    expect(r.disk?.free_pct).toBe(1);
    // The worktrees' default home beside the repo; statfs on the nearest folder that exists.
    expect(r.disk?.path.endsWith(".volley-worktrees")).toBe(true);
    expect(seen).toEqual([`${m.root}/src`]);
    expect(check(r, "machine.disk")).toMatchObject({ ok: true, severity: "warn" });
  });

  it("on macOS the memory comes from vm_stat: free + inactive + speculative + purgeable pages", async () => {
    const m = machine({ platform: "darwin", vmStat: VM_STAT_MAC_16GB });
    const r = await report(m);
    expect(r.memory).toEqual({ total_mb: 16384, available_pct: 45 });
  });

  for (const token of [
    "sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    "0123456789abcdef0123456789abcdef01234567",
  ]) {
    it(`a token planted in every output never reaches the result (${token.slice(0, 7)}…)`, async () => {
      const m = machine({
        plant: token,
        origin: `https://x-access-token:${token}@github.com/example-org/example-repo.git`,
        claudeStatus: { loggedIn: true, subscriptionType: token },
        gh: { user: token },
        volleyInstalled: false,
      });
      const json = await run(m, { json: true, release: "main" });
      expect(json.stdout).not.toContain(token);
      expect(json.stderr).not.toContain(token);
      const human = await run(m, { fix: true, yes: true });
      expect(human.stdout).not.toContain(token);
      expect(human.stderr).not.toContain(token);
      const r = JSON.parse(json.stdout) as DoctorReport;
      expect(r.repo?.origin).toBe("github.com/example-org/example-repo");
      expect(r.auth.claude).toBe("signed_in");
      expect(r.auth.claude_plan).toBeUndefined();
    });
  }

  it("a second --fix run reports every item as already done and runs nothing", async () => {
    const m = machine({ volleyInstalled: false, repo: "empty" });
    const origin = "https://github.com/example-org/example-repo.git";
    const first = await run(m, { origin, fix: true, yes: true, clone: true });
    expect(first.exit).toBe(0);
    expect(MUTATING(m)).toHaveLength(2);
    m.calls.length = 0;
    const second = await run(m, { origin, fix: true, yes: true, clone: true });
    expect(MUTATING(m)).toEqual([]);
    for (const id of ["volley.installed", "repo.clone"]) {
      expect(second.stdout).toMatch(new RegExp(`^✓ ${id.replace(".", "\\.")}: already done`, "m"));
    }
    // Nothing was checked against an unknown requirement: never "already done".
    expect(second.stdout).not.toMatch(/^✓ volley\.version: already done/m);
    expect(second.stdout).toMatch(/^· volley\.version: not checked/m);
    expect(second.exit).toBe(0);
  });

  it("warnings the supervisor's readiness still needs are called out in the human output", async () => {
    const m = machine({ trusted: true, gh: { permission: "READ" } });
    const r = await run(m);
    expect(r.exit).toBe(0);
    expect(r.stdout).toMatch(/keep this machine from being ready.*gh\.auth/);
    box?.cleanup();
    const ok = await run(machine({ trusted: true }));
    expect(ok.stdout).not.toContain("from being ready");
  });

  it("the Claude profile's four checks come after Claude's own, in the documented order", async () => {
    const r = await report(machine({ trusted: true }));
    const ids = r.checks.map((c) => c.id);
    const at = ids.indexOf("claude.trust");
    expect(ids.slice(at + 1, at + 5)).toEqual(["skills", "hooks", "mcp", "sharing"]);
    for (const id of ["skills", "hooks", "mcp", "sharing"]) {
      expect(check(r, id)).toMatchObject({ ok: true, severity: "warn" });
    }
  });

  it("runDoctor stamps the report with the time the run started, not when it ended", async () => {
    const m = machine();
    // A run's facts are as old as its start: one that began before a `doctor --fix` and ended
    // after it must not read as a run from after the fix.
    let t = Date.parse("2026-10-19T09:00:00.000Z");
    const now = () => {
      t += 60_000;
      return new Date(t);
    };
    const deps = { ...m.deps(), now };
    const { report: r } = await runDoctor(deps, { repo: m.repoPath });
    expect(r.doctor_at).toBe("2026-10-19T09:01:00.000Z");
  });

  it("runDoctor returns the report and the facts it was built from", async () => {
    const m = machine();
    const { report: r } = await runDoctor(m.deps(), { repo: m.repoPath });
    expect(r.checks.length).toBeLessThanOrEqual(32);
    for (const c of r.checks) {
      expect(c.id).toMatch(/^[a-z0-9][a-z0-9_.-]{0,62}$/);
      expect(c.detail.length).toBeLessThanOrEqual(200);
    }
  });
});
