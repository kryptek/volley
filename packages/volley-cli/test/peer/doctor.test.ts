import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import addFormats from "ajv-formats";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, it } from "vitest";
import { buildEnvelope } from "volley-mcp/envelope";
import { makeBufferIO } from "../../src/io";
import {
  type DoctorDeps,
  type DoctorOptions,
  type DoctorReport,
  doctor,
  normalizeOrigin,
  runDoctor,
  scrub,
} from "../../src/peer/doctor";
import { VM_STAT_MAC_16GB } from "../fixtures/vm-stat";
import { FAKE_TOKEN, storeLogins, usageEndpoint } from "../helpers/fake-logins";
import {
  type FakeClone,
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

  it("a signed-in profile's identity comes from ~/.claude.json: claude_email and claude_org only", async () => {
    const claudeJson = {
      userID: "c0ffee",
      oauthAccount: {
        accountUuid: "11111111-2222-3333-4444-555555555555",
        emailAddress: "Owner@Example.com",
        organizationName: "Example Org",
      },
    };
    const m = machine({ claudeStatus: { loggedIn: true, subscriptionType: "max" }, claudeJson });
    const r = await report(m);
    // scrub leaves an e-mail alone; nothing else of the file travels.
    expect(r.auth).toMatchObject({
      claude: "signed_in",
      claude_email: "owner@example.com",
      claude_org: "Example Org",
    });
    const text = JSON.stringify(r);
    for (const key of ["c0ffee", "11111111-2222"]) expect(text).not.toContain(key);
    box?.cleanup();
    const out = await report(
      machine({ claudeStatus: { loggedIn: false }, claudeCode: 1, claudeJson }),
    );
    expect(out.auth.claude_email).toBeUndefined();
    expect(out.auth.claude_org).toBeUndefined();
    box?.cleanup();
    const bad = await report(
      machine({
        claudeStatus: { loggedIn: true },
        claudeJson: { oauthAccount: { emailAddress: 42, organizationName: "" } },
      }),
    );
    expect(bad.auth).not.toHaveProperty("claude_email");
    expect(bad.auth).not.toHaveProperty("claude_org");
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

  it("the machine row names the max_agents volleyd derives from its size at join (#324)", async () => {
    const m = machine();
    const sized = async (over: Partial<DoctorDeps>) =>
      JSON.parse((await run(m, { json: true }, over)).stdout) as DoctorReport;
    const big = await sized({ cpus: () => 32, totalmem: () => 61_440 * 1024 ** 2 });
    expect(check(big, "machine.size")).toMatchObject({
      ok: true,
      severity: "warn",
      detail: "max_agents 10 (derived from 32 cores, 60 GB)",
    });
    const small = await sized({ cpus: () => 10, totalmem: () => 32 * 1024 ** 3 });
    expect(check(small, "machine.size")?.detail).toBe(
      "max_agents 3 (derived from 10 cores, 32 GB)",
    );
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

describe("volley peer doctor: Claude usage", () => {
  const NOW = Date.parse("2026-10-19T09:00:00.000Z");
  const SCHEMAS = fileURLToPath(new URL("../../../../spec/schemas/", import.meta.url));

  function validMachine(payload: Record<string, unknown>) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    for (const f of readdirSync(SCHEMAS).filter((f) => f.endsWith(".schema.json"))) {
      ajv.addSchema(JSON.parse(readFileSync(join(SCHEMAS, f), "utf-8")));
    }
    const validate = ajv.getSchema("https://volley.systems/schemas/0.1/machine.schema.json");
    const env = buildEnvelope({
      agentId: "peer-a",
      parentId: null,
      channel: "_system/machines",
      type: "machine",
      payload,
    });
    validate?.(env);
    return validate?.errors ?? [];
  }

  it("--json carries claude_logins for the default login and a profile; the record validates", async () => {
    const m = machine({ trusted: true });
    storeLogins(m.home, { default: NOW + 3_600_000, work: NOW + 3_600_000 });
    const api = usageEndpoint();
    const r = await report(m, {});
    expect(r).not.toHaveProperty("claude_logins");
    const io = makeBufferIO();
    await doctor(io, m.deps({ fetch: api.fetch, env: { USER: "dev" } }), {
      repo: m.repoPath,
      json: true,
    });
    const out = JSON.parse(io.readStdout()) as DoctorReport;
    const reading = {
      read_at: "2026-10-19T09:00:00.000Z",
      five_hour: { pct: 37, resets_at: "2026-10-19T12:00:00.000Z" },
      weekly: { pct: 56, resets_at: "2026-10-24T00:00:00.000Z" },
      model_weekly: { fable: { pct: 12, resets_at: "2026-10-24T00:00:00.000Z" } },
    };
    expect(out.claude_logins).toEqual([
      { profile: "default", state: "ok", attempted_at: "2026-10-19T09:00:00.000Z", reading },
      { profile: "work", state: "ok", attempted_at: "2026-10-19T09:00:00.000Z", reading },
    ]);
    // The claude version the doctor found is the User-Agent.
    expect(api.requests[0]?.["User-Agent"]).toBe("claude-code/2.0.14");
    const text = JSON.stringify(out);
    expect(text).not.toContain(FAKE_TOKEN);
    expect(text).not.toContain(join(m.home, ".volley", "claude"));
    expect(
      validMachine({
        name: "peer-a",
        os: "linux",
        cores: 8,
        tunnel: "up",
        load: [0, 0, 0],
        agents: 0,
        claude_logins: out.claude_logins,
        last_seen: "2026-10-19T09:00:00.000Z",
      }),
    ).toEqual([]);
  });

  it("the human output has one usage line per login: ok with its age, expired with why", async () => {
    const m = machine({ trusted: true });
    storeLogins(m.home, { default: NOW + 3_600_000, work: NOW - 1 });
    const api = usageEndpoint();
    await run(m, {}, { fetch: api.fetch });
    // Two minutes later the memo answers (no call) and the reading is two minutes old.
    const later = await run(m, {}, { fetch: api.fetch, now: () => new Date(NOW + 2 * 60_000) });
    expect(api.requests).toHaveLength(1);
    expect(later.stdout).toContain(
      "Claude usage: default 5h 37% · 7d 56% · Fable 12% (read 2 min ago)\n",
    );
    expect(later.stdout).toContain(
      "Claude usage: work — (login expired; Claude Code renews it on its next request)\n",
    );
  });

  it("a probe that fails with the token in its error leaks it nowhere", async () => {
    const m = machine({ trusted: true });
    storeLogins(m.home, { default: NOW + 86_400_000 });
    const api = usageEndpoint({ fail: (h) => new Error(`boom ${h.Authorization}`) });
    for (const json of [true, false]) {
      const out = await run(
        m,
        { json },
        { fetch: api.fetch, now: () => new Date(NOW + (json ? 0 : 3_600_000)) },
      );
      expect(`${out.stdout}${out.stderr}`).not.toContain(FAKE_TOKEN);
    }
    expect(api.requests).toHaveLength(2);
    const memo = readFileSync(join(m.home, ".volley", "claude-usage", "default.json"), "utf-8");
    expect(memo).not.toContain(FAKE_TOKEN);
    expect(JSON.parse(memo)).toMatchObject({ state: "error" });
  });

  it("scrub still redacts an sk-ant token anywhere in a report with logins", () => {
    const token = "sk-ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    const r = scrub({
      claude_logins: [{ profile: "default", state: "error", note: `x ${token}` }],
    });
    expect(JSON.stringify(r)).not.toContain(token);
    expect(r.claude_logins[0]?.note).toBe("x [redacted]");
  });
});

describe("volley peer doctor: account profiles ready to run agents (#400)", () => {
  /** A profile under `~/.volley/claude/<id>`, signed in, with what `json` and `settings` hold. */
  const profile = (
    m: FakePeerMachine,
    id: string,
    json: Record<string, unknown>,
    settings?: Record<string, unknown>,
  ) => {
    const dir = join(m.home, ".volley", "claude", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: `${id}@example.com` }, ...json }),
    );
    if (settings !== undefined) writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
    return dir;
  };
  const READY = { hasCompletedOnboarding: true, lastOnboardingVersion: "2.0.0", theme: "dark" };
  const read = (path: string) => JSON.parse(readFileSync(path, "utf-8"));

  it("reports the unready profile's missing keys; --fix --yes writes them and the check passes", async () => {
    const m = machine();
    profile(m, "home", READY, { skipDangerousModePermissionPrompt: true });
    const work = profile(m, "work", { theme: "light" }, { model: "opus" });
    // a profile that was never signed in is not one agents run in
    mkdirSync(join(m.home, ".volley", "claude", "spare"), { recursive: true });
    const before = check(await report(m), "claude.profiles");
    expect(before?.ok).toBe(false);
    expect(before?.severity).toBe("warn");
    expect(before?.detail).toBe(
      "work: not ready to run agents unattended (.claude.json: hasCompletedOnboarding, lastOnboardingVersion; settings.json: skipDangerousModePermissionPrompt)",
    );
    expect(before?.fix).toBe("volley peer doctor --fix");

    const fixed = await run(m, { fix: true, yes: true });
    expect(fixed.stdout).toContain("→ claude.profiles: volley peer doctor --fix");
    expect(read(join(work, ".claude.json"))).toEqual({
      oauthAccount: { emailAddress: "work@example.com" },
      theme: "light",
      hasCompletedOnboarding: true,
      lastOnboardingVersion: "2.0.14",
    });
    expect(read(join(work, "settings.json"))).toEqual({
      model: "opus",
      skipDangerousModePermissionPrompt: true,
    });
    const after = check(await report(m), "claude.profiles");
    expect(after?.ok).toBe(true);
    expect(after?.detail).toBe("2 account profiles ready to run agents unattended");
  });

  it("a profile with a running session is skipped: rerun when they exit", async () => {
    const m = machine();
    const work = profile(m, "work", {});
    const wt = join(m.root, "wt", "w1", "T1-implementer");
    mkdirSync(join(wt, ".volley"), { recursive: true });
    writeFileSync(
      join(wt, ".volley", "launch.sh"),
      `#!/bin/bash\nexport CLAUDE_CONFIG_DIR='${work}'\nexec claude\n`,
    );
    const ps = (argv: readonly string[]) =>
      argv[0] === "ps"
        ? Promise.resolve({
            code: 0,
            stdout: ` 4242 claude --model x --mcp-config=${wt}/.volley/mcp.json -- go\n`,
            stderr: "",
            timedOut: false,
          })
        : null;
    const exec: DoctorDeps["exec"] = (argv, o) => ps(argv) ?? m.exec(argv, o);
    const c = check(await report2(m, { exec }), "claude.profiles");
    expect(c?.ok).toBe(false);
    expect(c?.detail).toContain("work: skipped: 1 session(s) running — rerun when they exit");
    const fixed = await run(m, { fix: true, yes: true }, { exec });
    expect(fixed.stdout).not.toContain("→ claude.profiles");
    expect(read(join(work, ".claude.json")).hasCompletedOnboarding).toBeUndefined();
  });

  it("--fix takes over a .claude.json lock a crashed session left behind", async () => {
    const m = machine();
    const work = profile(m, "work", {});
    const lock = join(work, ".claude.json.lock");
    mkdirSync(lock);
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(lock, old, old);
    await run(m, { fix: true, yes: true });
    expect(read(join(work, ".claude.json")).hasCompletedOnboarding).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  it("without a claude on PATH, --fix records the default login's lastOnboardingVersion", async () => {
    const m = machine({
      tools: { claude: { path: null, sshPath: null } },
      claudeJson: { lastOnboardingVersion: "2.0.9" },
    });
    const work = profile(m, "work", {});
    await run(m, { fix: true, yes: true });
    expect(read(join(work, ".claude.json")).lastOnboardingVersion).toBe("2.0.9");
  });

  it("no account profiles: nothing to check", async () => {
    const c = check(await report(machine()), "claude.profiles");
    expect(c).toMatchObject({ ok: true, detail: "no Claude account profiles on this machine" });
  });
});

const report2 = async (m: FakePeerMachine, over: Partial<DoctorDeps>) => {
  const r = await run(m, { json: true }, over);
  return JSON.parse(r.stdout) as DoctorReport;
};

describe("volley peer doctor: many repositories (#435)", () => {
  const managed = (m: FakePeerMachine, slug: string) => join(m.home, ".volley", "repos", slug);
  /** `volley peer doctor` with peer.json's `repos` map (no legacy --repo). */
  async function runRepos(
    m: FakePeerMachine,
    repos: Record<string, string>,
    opts: Partial<DoctorOptions> = {},
  ) {
    const io = makeBufferIO();
    const exit = await doctor(io, m.deps(), { repos, ...opts });
    return { exit, stdout: io.readStdout(), stderr: io.readStderr() };
  }
  const reportRepos = async (
    m: FakePeerMachine,
    repos: Record<string, string>,
    opts: Partial<DoctorOptions> = {},
  ) => JSON.parse((await runRepos(m, repos, { ...opts, json: true })).stdout) as DoctorReport;
  /** A git clone at `path` on the box, with `files` at its root. */
  const addClone = (m: FakePeerMachine, path: string, c: FakeClone) => {
    mkdirSync(join(path, ".git"), { recursive: true });
    for (const [f, text] of Object.entries(c.files ?? {})) {
      mkdirSync(dirname(join(path, f)), { recursive: true });
      writeFileSync(join(path, f), text);
    }
    m.clones.set(path, {
      isGit: true,
      origin: c.origin,
      branch: c.branch === undefined ? "main" : c.branch,
      default: c.default === undefined ? "main" : c.default,
      dirty: c.dirty ?? false,
    });
  };
  const checksOf = (r: DoctorReport, id: string) => r.checks.filter((c) => c.id === id);
  const forRepo = (r: DoctorReport, id: string, repo: string) =>
    r.checks.find((c) => c.id === id && c.repo === repo);

  it("runs the repo checks per repository: a missing clone fails for that repository only", async () => {
    const m = machine();
    const repos = { "a/a": managed(m, "a/a"), "b/b": managed(m, "b/b") };
    addClone(m, repos["a/a"], { origin: "git@github.com:a/a.git" });
    const r = await reportRepos(m, repos);
    expect(forRepo(r, "repo.clone", "a/a")).toMatchObject({ ok: true, severity: "block" });
    expect(forRepo(r, "repo.origin", "a/a")).toMatchObject({ ok: true });
    expect(forRepo(r, "repo.clone", "b/b")).toMatchObject({ ok: false, severity: "block" });
    expect(forRepo(r, "repo.clone", "b/b")?.detail).toContain(repos["b/b"]);
    // Ids are unchanged: one of each per repository, each naming it.
    expect(checksOf(r, "repo.clone").map((c) => c.repo)).toEqual(["a/a", "b/b"]);
    expect(r.repos).toEqual([
      {
        slug: "a/a",
        path: repos["a/a"],
        exists: true,
        origin: "github.com/a/a",
        managed: true,
        fetched_at: null,
        toolchain: { ok: true, missing: [], outdated: [] },
      },
      {
        slug: "b/b",
        path: repos["b/b"],
        exists: false,
        managed: true,
        fetched_at: null,
        toolchain: { ok: true, missing: [], outdated: [] },
      },
    ]);
    // Two repositories: no legacy single `repo`.
    expect(r.repo).toBeUndefined();
  });

  it("exactly one repository also fills the legacy `repo` (kept for one release)", async () => {
    const m = machine();
    const adopted = join(m.root, "work", "a");
    addClone(m, adopted, { origin: "https://github.com/a/a" });
    const r = await reportRepos(m, { "a/a": adopted });
    expect(r.repos?.[0]).toMatchObject({ slug: "a/a", path: adopted, managed: false });
    expect(r.repo).toEqual({
      path: adopted,
      exists: true,
      origin: "github.com/a/a",
      fetched_at: null,
    });
  });

  it("--fix --clone clones every repository without a clone, from its GitHub URL (no --origin)", async () => {
    const m = machine();
    const repos = { "a/a": managed(m, "a/a"), "b/b": managed(m, "b/b") };
    const r = await runRepos(m, repos, { fix: true, yes: true, clone: true });
    const clones = MUTATING(m).filter((a) => a.includes("clone"));
    expect(clones).toEqual(
      ["a/a", "b/b"].map((s) => [
        "env",
        "GIT_TERMINAL_PROMPT=0",
        "GIT_ASKPASS=",
        "SSH_ASKPASS=",
        "GIT_SSH_COMMAND=ssh -o BatchMode=yes",
        "/usr/bin/git",
        "clone",
        "--",
        `https://github.com/${s}.git`,
        repos[s as "a/a"],
      ]),
    );
    expect(r.stdout).not.toContain("✗ repo.clone");
  });

  it("a fix that fails for one repository does not stop the same fix for another", async () => {
    const m = machine();
    const repos = { "a/a": managed(m, "a/a"), "b/b": managed(m, "b/b") };
    const exec = m.exec;
    const r = await (async () => {
      const io = makeBufferIO();
      await doctor(
        io,
        m.deps({
          exec: async (argv, o) =>
            argv.includes("clone") && argv.includes(repos["a/a"])
              ? { code: 128, stdout: "", stderr: "fatal: could not read\n" }
              : exec(argv, o),
        }),
        { repos, fix: true, yes: true, clone: true },
      );
      return io.readStdout();
    })();
    expect(r).toContain("✗ repo.clone (a/a): fix failed (exit 128)");
    expect(m.clones.has(repos["b/b"])).toBe(true);
  });

  describe("canonical origin (D6)", () => {
    const setup = (origin: string, canonical: Record<string, string | null>) => {
      const m = machine({ canonical });
      const p = managed(m, "new-owner/name");
      addClone(m, p, { origin });
      return { m, repos: { "new-owner/name": p }, p };
    };

    it("a remote naming the transferred repository's old owner: ok, with a warn; --fix repoints it, journaled", async () => {
      const { m, repos, p } = setup("git@github.com:old-owner/name.git", {
        "old-owner/name": "new-owner/name",
        "new-owner/name": "new-owner/name",
      });
      const r = await reportRepos(m, repos);
      expect(forRepo(r, "repo.origin", "new-owner/name")).toMatchObject({ ok: true });
      const warn = forRepo(r, "repo.canonical", "new-owner/name");
      expect(warn).toMatchObject({ ok: false, severity: "warn" });
      expect(warn?.detail).toContain("remote names the old owner");
      expect(MUTATING(m).filter((a) => a.includes("set-url"))).toEqual([]);
      // One gh repo view per slug per run.
      const views = m.ran("gh", "repo", "view").filter((a) => a.includes("nameWithOwner"));
      expect(views.map((a) => a[3]).sort()).toEqual(["new-owner/name", "old-owner/name"]);

      m.calls.length = 0;
      const fixed = await reportRepos(m, repos, { fix: true, yes: true });
      expect(MUTATING(m).filter((a) => a.includes("set-url"))).toEqual([
        [
          "/usr/bin/git",
          "-C",
          p,
          "remote",
          "set-url",
          "origin",
          "https://github.com/new-owner/name.git",
        ],
      ]);
      expect(fixed.fixes).toEqual([
        expect.objectContaining({
          id: "repo.canonical",
          repo: "new-owner/name",
          ok: true,
          command: expect.stringContaining(
            "remote set-url origin https://github.com/new-owner/name.git",
          ),
        }),
      ]);
      expect(forRepo(fixed, "repo.canonical", "new-owner/name")).toBeUndefined();
      expect(forRepo(fixed, "repo.origin", "new-owner/name")?.ok).toBe(true);
    });

    it("peer.json naming the old owner, the remote the new one: a warn to update peer.json, never a repoint", async () => {
      const m = machine({
        canonical: { "old-owner/name": "new-owner/name", "new-owner/name": "new-owner/name" },
      });
      const p = managed(m, "old-owner/name");
      addClone(m, p, { origin: "git@github.com:new-owner/name.git" });
      const repos = { "old-owner/name": p };
      const r = await reportRepos(m, repos);
      expect(forRepo(r, "repo.origin", "old-owner/name")).toMatchObject({ ok: true });
      const warn = forRepo(r, "repo.canonical", "old-owner/name");
      expect(warn).toMatchObject({ ok: false, severity: "warn" });
      expect(warn?.detail).toContain("peer.json names the old owner or name");
      expect(warn?.fix).toContain("--repo-add new-owner/name=");
      m.calls.length = 0;
      const fixed = await reportRepos(m, repos, { fix: true, yes: true });
      expect(MUTATING(m).filter((a) => a.includes("set-url"))).toEqual([]);
      expect(fixed.fixes ?? []).toEqual([]);
    });

    it("a genuinely different repository blocks and is never touched", async () => {
      const { m, repos } = setup("git@github.com:someone/fork.git", {});
      const r = await reportRepos(m, repos);
      const c = forRepo(r, "repo.origin", "new-owner/name");
      expect(c).toMatchObject({ ok: false, severity: "block" });
      expect(c?.detail).toContain("github.com/someone/fork");
      m.calls.length = 0;
      await runRepos(m, repos, { fix: true, yes: true });
      expect(MUTATING(m).filter((a) => a.includes("set-url"))).toEqual([]);
    });

    it("without gh, origins are compared normalised: the old owner's remote blocks", async () => {
      const { m, repos } = setup("git@github.com:old-owner/name.git", {
        "old-owner/name": "new-owner/name",
      });
      m.tools.gh.path = null;
      m.tools.gh.sshPath = null;
      const r = await reportRepos(m, repos);
      expect(forRepo(r, "repo.origin", "new-owner/name")).toMatchObject({ ok: false });
      expect(m.ran("gh")).toEqual([]);
    });
  });

  describe("fast-forward only (D7)", () => {
    const one = (clone: Partial<FakeClone>, where: "managed" | "adopted" = "managed") => {
      const m = machine();
      const p = where === "managed" ? managed(m, "a/a") : join(m.root, "work", "a");
      addClone(m, p, { origin: "https://github.com/a/a", ...clone });
      return { m, p };
    };
    const gitRuns = (m: FakePeerMachine, p: string) =>
      MUTATING(m)
        .concat(m.ran("git").filter((a) => a.includes("merge")))
        .filter((a) => a.includes(p) && (a.includes("fetch") || a.includes("merge")))
        .map((a) => a.slice(a.indexOf("-C") + 2));

    it("a clean managed clone on its default branch is fetched, then fast-forwarded", async () => {
      const { m, p } = one({});
      await runRepos(m, { "a/a": p }, { fix: true, yes: true });
      expect(gitRuns(m, p)).toEqual([
        ["fetch", "--quiet", "origin"],
        ["merge", "--ff-only", "--quiet", "origin/main"],
      ]);
    });

    it("dirty, detached, off its default branch, or adopted: fetched only", async () => {
      for (const [clone, where] of [
        [{ dirty: true }, "managed"],
        [{ branch: null }, "managed"],
        [{ branch: "feature" }, "managed"],
        [{ default: null }, "managed"],
        [{}, "adopted"],
      ] as const) {
        const { m, p } = one(clone, where);
        await runRepos(m, { "a/a": p }, { fix: true, yes: true });
        expect(gitRuns(m, p), JSON.stringify([clone, where])).toEqual([
          ["fetch", "--quiet", "origin"],
        ]);
        box?.cleanup();
        box = null;
      }
    });

    it("without --fix nothing is fetched", async () => {
      const { m, p } = one({});
      await runRepos(m, { "a/a": p });
      expect(gitRuns(m, p)).toEqual([]);
    });
  });

  describe("toolchain (ex-T5)", () => {
    it("a tool one repository needs fails for that repository only; repos[].toolchain is filled", async () => {
      const m = machine({ extraTools: { mvn: { version: "Apache Maven 3.9.6" } } });
      const pa = managed(m, "a/a");
      const pb = managed(m, "b/b");
      addClone(m, pa, { origin: "https://github.com/a/a", files: { "pom.xml": "<project/>" } });
      addClone(m, pb, {
        origin: "https://github.com/b/b",
        files: { "package.json": JSON.stringify({ packageManager: "bun@1.3.0" }) },
      });
      const r = await reportRepos(m, { "a/a": pa, "b/b": pb });
      expect(forRepo(r, "tool.java", "a/a")).toMatchObject({ ok: false, severity: "block" });
      expect(forRepo(r, "tool.java", "a/a")?.detail).toContain("a/a");
      expect(r.checks.filter((c) => c.repo === "b/b" && !c.ok)).toEqual([]);
      expect(r.repos?.map((x) => [x.slug, x.toolchain])).toEqual([
        ["a/a", { ok: false, missing: ["java"], outdated: [] }],
        ["b/b", { ok: true, missing: [], outdated: [] }],
      ]);
      // The machine-level tool checks stay as they were.
      expect(check(r, "tool.git")).toMatchObject({ ok: true });
      // A tool no repository needs is never probed.
      expect(m.calls.some((c) => c.argv.join(" ").includes("cargo"))).toBe(false);
    });

    it("an older tool than a repository's minimum is outdated", async () => {
      const m = machine({
        extraTools: { java: { version: 'openjdk version "11.0.22" 2024-01-16' } },
      });
      const p = managed(m, "a/a");
      addClone(m, p, {
        origin: "https://github.com/a/a",
        files: { "build.gradle.kts": "", ".volley/requirements.yaml": 'min:\n  java: "17"\n' },
      });
      const r = await reportRepos(m, { "a/a": p });
      expect(forRepo(r, "tool.java", "a/a")?.detail).toContain("17");
      expect(r.repos?.[0]?.toolchain).toEqual({ ok: false, missing: [], outdated: ["java"] });
    });

    it('a GA JDK\'s bare major (`openjdk version "17"`) is still held to the minimum', async () => {
      const m = machine({
        extraTools: { java: { version: 'openjdk version "17" 2021-09-14' } },
      });
      const p = managed(m, "a/a");
      addClone(m, p, {
        origin: "https://github.com/a/a",
        files: { "build.gradle.kts": "", ".volley/requirements.yaml": 'min:\n  java: "21"\n' },
      });
      const r = await reportRepos(m, { "a/a": p });
      expect(r.repos?.[0]?.toolchain).toEqual({ ok: false, missing: [], outdated: ["java"] });
    });

    it("an invalid .volley/requirements.yaml blocks that repository with a clear error", async () => {
      const m = machine();
      const p = managed(m, "a/a");
      addClone(m, p, {
        origin: "https://github.com/a/a",
        files: { ".volley/requirements.yaml": "toolz: [java]\n" },
      });
      const r = await reportRepos(m, { "a/a": p });
      const c = forRepo(r, "repo.requirements", "a/a");
      expect(c).toMatchObject({ ok: false, severity: "block" });
      expect(c?.detail).toContain("toolz");
    });
  });
});
