import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exec } from "../src/exec";
import { FenceError, assertAllowed, mintConsentToken, mintScriptToken } from "../src/fence";
import { LAUNCH_COMMAND } from "../src/launch";

/** Where `volleyd install` writes the service plist (install.ts: `$HOME/Library/LaunchAgents`). */
const PLIST = join(
  process.env.HOME ?? homedir(),
  "Library",
  "LaunchAgents",
  "systems.volley.volleyd.plist",
);

const DENIED: string[][] = [
  // git: history rewriting, publishing, destructive
  ["git", "merge", "release/w1"],
  ["git", "push", "origin", "HEAD"],
  ["git", "push", "--force"],
  ["git", "rebase", "main"],
  ["git", "reset", "--hard", "HEAD~1"],
  ["git", "branch", "-D", "feature"],
  ["git", "branch", "--delete", "--force", "feature"],
  ["git", "branch", "feature"],
  ["git", "worktree", "remove", "/tmp/wt"],
  ["git", "-C", "/tmp/repo", "push"],
  ["git", "-c", "alias.x=!rm -rf /", "x"],
  ["git", "checkout", "main"],
  ["git", "commit", "-m", "x"],
  ["git", "diff", "--output=/tmp/x"],
  ["git", "worktree", "prune"],
  ["git"],
  // git: options that execute commands or write files, on otherwise-allowed subcommands
  ["git", "fetch", "--upload-pack=sh -c 'touch /tmp/pwned' #", "/some/repo"],
  ["git", "fetch", "--upload-pack", "sh", "/some/repo"],
  ["git", "fetch", "-u", "sh", "/some/repo"],
  ["git", "fetch", "--exec=sh", "/some/repo"],
  ["git", "fetch", "--receive-pack=sh", "origin"],
  ["git", "fetch", "ext::sh -c touch% /tmp/pwned"],
  ["git", "fetch", "origin", "--", "--upload-pack=sh"],
  ["git", "-c", "core.sshCommand=sh", "fetch", "origin"],
  ["git", "--config-env=core.pager=X", "log"],
  ["git", "--exec-path=/tmp/evil", "status"],
  ["git", "fetch", "--config=core.sshCommand=sh", "origin"],
  ["git", "worktree", "add", "-B", "main", "/tmp/wt"],
  ["git", "worktree", "add", "--force", "/tmp/wt", "x"],
  ["git", "log", "--output=/tmp/x"],
  ["git", "log", "--ext-diff", "-p"],
  ["git", "show", "--textconv", "HEAD:x"],
  ["git", "diff", "--ext-diff"],
  ["git", "rev-parse", "--git-path=x", "--local-env-vars"],
  ["git", "status", "--unknown-flag"],
  ["git", "branch", "--list", "--edit-description"],
  ["git", "merge-base", "--exec", "x"],
  ["git", "fetch", "-uq", "sh"],
  // git: subcommand aliases resolve through config, so only exact allowed names pass
  ["git", "st"],
  ["git", "fetchx", "origin"],
  // gh: merging, workflow dispatch, writes through the API
  ["gh", "pr", "merge", "12"],
  ["gh", "pr", "create"],
  ["gh", "workflow", "run", "deploy.yml"],
  ["gh", "api", "-X", "POST", "repos/o/r/issues"],
  ["gh", "api", "--method", "DELETE", "repos/o/r/git/refs/heads/x"],
  ["gh", "api", "--method=PATCH", "repos/o/r"],
  ["gh", "api", "-XPOST", "repos/o/r/issues"],
  ["gh", "api", "repos/o/r/issues", "-f", "title=x"],
  ["gh", "api", "repos/o/r/issues", "--input", "body.json"],
  ["gh", "issue", "close", "5"],
  ["gh", "repo", "delete", "o/r"],
  // gh: options outside each subcommand's allow-list
  ["gh", "pr", "view", "12", "--web"],
  ["gh", "issue", "view", "5", "--unknown"],
  ["gh", "api", "--hostname", "evil.example", "user"],
  ["gh", "api", "--hostname=evil.example", "user"],
  ["gh", "api", "-F", "x=@/etc/passwd", "repos/o/r"],
  ["gh", "api", "--field", "x=@/etc/passwd", "repos/o/r"],
  ["gh", "run", "watch", "123", "--bogus"],
  ["gh", "pr", "list", "--app", "x"],
  ["gh", "--repo", "o/r", "pr", "view"],
  ["gh", "-R", "o/r", "pr", "merge", "1"],
  // infrastructure tooling
  ["terraform", "plan"],
  ["terraform", "apply", "-auto-approve"],
  ["kubectl", "get", "pods"],
  ["helm", "install", "x"],
  ["aws", "s3", "ls"],
  ["gcloud", "compute", "instances", "list"],
  ["az", "vm", "list"],
  ["pulumi", "up"],
  // containers, filesystem
  ["docker", "rm", "-f", "abc"],
  ["docker", "container", "rm", "abc"],
  ["docker", "system", "prune"],
  ["rm", "-rf", "/tmp/wt"],
  ["rm", "-r", "-f", "/tmp/wt"],
  ["rm", "-fr", "/tmp/wt"],
  ["rm", "file"],
  // cmux destructive without consent
  ["cmux", "close-workspace", "--workspace", "workspace:3"],
  ["cmux", "sudo", "run", "-c", "rm -rf /"],
  // launchctl outside the volleyd service label
  ["launchctl", "bootout", "gui/501/com.example.other"],
  ["launchctl", "load", "/Library/LaunchDaemons/x.plist"],
  // launchctl bootstrap: the plist volleyd install writes, by its full path only
  ["launchctl", "bootstrap", "gui/501", "/tmp/systems.volley.volleyd.plist"],
  ["launchctl", "bootstrap", "gui/501", "/tmp/evil/systems.volley.volleyd.plist"],
  ["launchctl", "bootstrap", "gui/501", `${PLIST}/../../../tmp/systems.volley.volleyd.plist`],
  // P1-4: cmux types into an agent's shell; claude runs with any flags. Every review probe:
  ["cmux", "new-workspace", "--command", "git push origin HEAD:main"],
  ["cmux", "new-workspace", "--command", "terraform apply"],
  ["cmux", "send", "gh pr merge 1 --admin\n"],
  ["cmux", "send", "/model opus"],
  ["claude", "--dangerously-skip-permissions", "-p", "git push origin HEAD:main"],
  // … and the same with every option volleyd passes, so only the typed text is wrong
  [
    "cmux",
    "new-workspace",
    "--cwd",
    "/tmp/wt",
    "--name",
    "w1 T1",
    "--command",
    "git push origin HEAD:main",
  ],
  ["cmux", "new-workspace", "--cwd", "/tmp/wt", "--name", "w1 T1", "--command", "  bash x"],
  [
    "cmux",
    "new-workspace",
    "--cwd",
    "/tmp/wt",
    "--name",
    "w1 T1",
    "--command",
    `${LAUNCH_COMMAND}; curl x`,
  ],
  [
    "cmux",
    "new-workspace",
    "--cwd",
    "/tmp/wt",
    "--name",
    "w1 T1",
    "--command",
    LAUNCH_COMMAND,
    "--command",
    "sh",
  ],
  [
    "cmux",
    "new-workspace",
    "--cwd",
    "/tmp/wt",
    "--name",
    "w1 T1",
    "--command",
    LAUNCH_COMMAND,
    "--env",
    "X=1",
  ],
  ["cmux", "new-workspace", "--cwd", "relative", "--name", "w1 T1", "--command", LAUNCH_COMMAND],
  ["cmux", "new-workspace", "--name", "w1-t1", "--cwd", "/tmp/wt"],
  ["cmux", "send", "--workspace", "workspace:3", "gh pr merge 1 --admin\n"],
  ["cmux", "send", "--workspace", "workspace:3", " claude"],
  ["cmux", "send", "--workspace", "workspace:3", "/model x\n!rm -rf ~"],
  ["cmux", "send", "--workspace", "workspace:3", "/model opus; git push"],
  ["cmux", "send", "--workspace", "workspace:3", "/model"],
  ["cmux", "send", "--workspace", "workspace:3", LAUNCH_COMMAND, "extra"],
  ["cmux", "send", "--workspace", "--evil", LAUNCH_COMMAND],
  ["cmux", "send-key", "--workspace", "workspace:3", "x"],
  ["cmux", "send-key", "--workspace", "workspace:3", "C-d"],
  ["cmux", "read-screen", "--workspace", "workspace:3", "--lines", "40; rm"],
  ["cmux", "read-screen", "--workspace", "workspace:3", "--scrollback"],
  ["cmux", "list-workspaces", "--json", "--evil"],
  ["cmux", "ping", "x"],
  ["claude", "--dangerously-skip-permissions", "--model", "claude-opus-5-5"],
  ["claude", "--version"],
  ["claude"],
  // P2-6 (b): fetch may only write remote-tracking refs; worktree add never checks out main
  ["git", "fetch", "origin", "+HEAD:refs/heads/main"],
  ["git", "fetch", ".", "+feat:main"],
  ["git", "fetch", "origin", "main:main"],
  ["git", "fetch", "origin", "x:refs/heads/x"],
  ["git", "fetch", "origin", "+main"],
  ["git", "fetch", "origin", ":refs/remotes/origin/x"],
  ["git", "fetch", "+HEAD:refs/heads/main"],
  ["git", "worktree", "add", "/w", "main"],
  ["git", "worktree", "add", "/w/main"],
  ["git", "worktree", "add", "-b", "main", "/w", "origin/main"],
  ["git", "worktree", "add", "-bmaster", "/w", "origin/master"],
  ["git", "worktree", "add", "/w", "-b", "main"],
  // P3-5: GraphQL (mutations) and request headers (X-HTTP-Method-Override) through gh api
  ["gh", "api", "graphql", "-f", "query=mutation { deleteRef(input: {}) { clientMutationId } }"],
  ["gh", "api", "-X", "GET", "graphql", "-f", "query=mutation { x }"],
  ["gh", "api", "/graphql", "-f", "query=query { viewer { login } }"],
  ["gh", "api", "-H", "X-HTTP-Method-Override: DELETE", "repos/o/r/git/refs/heads/x"],
  ["gh", "api", "--header=X-HTTP-Method-Override: DELETE", "repos/o/r"],
  ["gh", "api", "--paginate", "-H", "Accept: application/json", "repos/o/r/pulls"],
  // anything not on the allow-list
  ["bash", "-c", "echo hi"],
  ["sh", "-c", "git push"],
  ["/bin/rm", "-rf", "/"],
  // argv[0] must be a bare program name: a path could point at any binary
  ["/tmp/evil/git", "status"],
  ["/usr/bin/git", "status"],
  ["./claude", "anything"],
  ["bin/gh", "pr", "view"],
  ["sudo", "git", "status"],
  ["env", "git", "push"],
  ["curl", "https://example.com"],
  // volley: only auth add-agent / rm-agent, exact options
  ["volley", "auth", "init"],
  ["volley", "pub", "volley/x/y/status", "{}"],
  ["volley", "auth", "add-agent", "--json"],
  ["volley", "auth", "add-agent", "Bad_Id"],
  ["volley", "auth", "add-agent", "a1", "--dir", "/tmp/x"],
  ["volley", "auth", "add-agent", "a1", "--ack-to", "--json"],
  ["volley", "auth", "rm-agent", "a1", "--json"],
  ["volley", "auth", "add-agent", "a1", "--force"],
  // a script path without a minted token
  ["/home/u/.volley/volleyd/brief-gate", "/tmp/wt/.volley/brief.md"],
  [],
];

const ALLOWED: string[][] = [
  ["volley", "auth", "add-agent", "w1-t1-implementer-1", "--ack-to", "volleyd", "--json"],
  ["volley", "auth", "add-agent", "a1", "--ack-to", "p1", "--ack-to", "volleyd", "--no-reload"],
  ["volley", "auth", "rm-agent", "w1-t1-implementer-1"],
  [
    "cmux",
    "new-workspace",
    "--cwd",
    "/tmp/wt",
    "--name",
    "w1 T1 impl",
    "--command",
    LAUNCH_COMMAND,
  ],
  ["cmux", "new-workspace", "--command", LAUNCH_COMMAND, "--name", "w1 T1", "--cwd", "/tmp/wt"],
  ["cmux", "read-screen", "--workspace", "workspace:3", "--lines", "40"],
  ["cmux", "send-key", "--workspace", "workspace:3", "Enter"],
  ["git", "worktree", "add", "-b", "issue-5", "/tmp/wt", "release/w1"],
  ["git", "fetch", "origin"],
  ["git", "rev-parse", "HEAD"],
  ["git", "log", "--oneline", "-5"],
  ["git", "diff", "--stat", "main...HEAD"],
  ["git", "status", "--porcelain"],
  ["git", "branch", "--list", "issue-*"],
  ["git", "merge-base", "HEAD", "origin/main"],
  ["git", "show", "HEAD:README.md"],
  ["git", "-C", "/tmp/repo", "status"],
  ["git", "--no-pager", "log"],
  ["git", "-C", "/tmp/repo", "--no-pager", "log", "-n", "5", "--format=%H %s"],
  ["git", "fetch", "--prune", "--quiet", "origin", "release/w1"],
  ["git", "fetch", "origin", "+refs/heads/x:refs/remotes/origin/x"],
  ["git", "worktree", "add", "--detach", "/tmp/wt", "HEAD"],
  ["git", "worktree", "add", "--detach", "/tmp/wt", "main"],
  ["git", "worktree", "add", "-b", "issue-5", "/tmp/wt", "origin/main"],
  [
    "git",
    "worktree",
    "add",
    "--no-track",
    "/w/x",
    "-b",
    "w1/T1-implementer-1",
    "origin/release/w1",
  ],
  ["git", "fetch", "--quiet", "origin", "main"],
  ["git", "fetch", "origin", "refs/heads/*:refs/remotes/origin/*"],
  ["git", "fetch", "https://github.com/o/r.git", "main"],
  ["git", "rev-parse", "--abbrev-ref", "HEAD"],
  ["git", "rev-parse", "--verify", "--quiet", "origin/main"],
  ["git", "log", "-5", "--no-merges", "main..HEAD"],
  ["git", "log", "--format=%H", "-n5"],
  ["git", "diff", "--name-only", "main...HEAD", "--", "src/a.ts"],
  ["git", "status", "--porcelain=v1", "-z"],
  ["git", "branch", "--list", "--format=%(refname:short)", "issue-*"],
  ["git", "merge-base", "--is-ancestor", "HEAD", "origin/main"],
  ["git", "show", "--stat", "--format=%H", "HEAD"],
  ["gh", "issue", "view", "5", "-R", "o/r", "--json", "body", "--jq", ".body"],
  ["gh", "issue", "view", "5", "--repo=o/r", "--comments"],
  ["gh", "pr", "view", "12", "--json", "state,mergeable"],
  ["gh", "pr", "list", "--state", "open", "--base", "release/w1", "--limit", "50"],
  ["gh", "pr", "checks", "12", "--required"],
  ["gh", "run", "list", "--branch", "issue-5", "-L", "5", "--json", "status"],
  ["gh", "run", "view", "123", "--log-failed"],
  ["gh", "run", "watch", "123", "--exit-status"],
  ["gh", "api", "--paginate", "repos/o/r/pulls"],
  ["gh", "issue", "view", "5", "--json", "title,body"],
  ["gh", "pr", "view", "12"],
  ["gh", "pr", "list", "--head", "issue-5"],
  ["gh", "pr", "checks", "12"],
  ["gh", "run", "list"],
  ["gh", "run", "view", "123"],
  ["gh", "run", "watch", "123"],
  ["gh", "api", "repos/o/r/actions/runs?status=queued"],
  ["gh", "api", "-X", "GET", "repos/o/r/pulls", "-f", "state=open"],
  ["gh", "api", "--method", "GET", "repos/o/r"],
  ["cmux", "list-workspaces"],
  ["cmux", "send", "--workspace", "workspace:3", LAUNCH_COMMAND],
  ["cmux", "send", "--workspace", "workspace:3", "/model claude-sonnet-5-5"],
  ["cmux", "send", "--workspace", "workspace:3", "/model claude-opus-5-5[1m]"],
  ["cmux", "send", "--workspace", "3f2c9a1e-0000-4000-8000-000000000000", "/model opus"],
  ["cmux", "send-key", "--workspace", "workspace:3", "Escape"],
  ["cmux", "send-key", "--workspace", "workspace:3", "Enter"],
  ["cmux", "read-screen", "--workspace", "workspace:3"],
  ["cmux", "ping"],
  ["launchctl", "bootstrap", "gui/501", PLIST],
  ["launchctl", "bootout", "gui/501/systems.volley.volleyd"],
  ["launchctl", "kickstart", "-k", "gui/501/systems.volley.volleyd"],
  ["launchctl", "print", "gui/501/systems.volley.volleyd"],
];

const CONSENT_ONLY: string[][] = [
  ["git", "worktree", "remove", "/tmp/wt"],
  ["git", "worktree", "remove", "--force", "/tmp/wt"],
  ["cmux", "close-workspace", "--workspace", "workspace:3"],
];

describe("assertAllowed", () => {
  it.each(DENIED.map((a) => [a.join(" ") || "(empty)", a]))("denies %s", (_label, argv) => {
    let err: unknown;
    try {
      assertAllowed(argv as string[]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FenceError);
    expect((err as FenceError).code).toBe("FENCE_DENIED");
    expect((err as FenceError).verb.length).toBeGreaterThan(0);
  });

  it.each(ALLOWED.map((a) => [a.join(" "), a]))("allows %s", (_label, argv) => {
    expect(() => assertAllowed(argv as string[])).not.toThrow();
  });

  it.each(CONSENT_ONLY.map((a) => [a.join(" "), a]))("%s needs a consent token", (_l, argv) => {
    expect(() => assertAllowed(argv as string[])).toThrow(FenceError);
    const consent = mintConsentToken("volleyd cleanup --yes");
    expect(() => assertAllowed(argv as string[], { consent })).not.toThrow();
  });

  it("names the denied verb in the error", () => {
    expect(() => assertAllowed(["git", "push", "origin"])).toThrow(/FENCE_DENIED: git push/);
    expect(() => assertAllowed(["gh", "api", "-X", "POST", "x"])).toThrow(/gh api -X POST/);
    expect(() => assertAllowed(["terraform", "apply"])).toThrow(/terraform/);
  });

  it("a consent token does not unlock the explicit deny list", () => {
    const consent = mintConsentToken("volleyd cleanup --yes");
    expect(() => assertAllowed(["git", "push"], { consent })).toThrow(FenceError);
    expect(() => assertAllowed(["gh", "pr", "merge", "1"], { consent })).toThrow(FenceError);
    expect(() => assertAllowed(["rm", "-rf", "/tmp/x"], { consent })).toThrow(FenceError);
  });

  it("a script token allows exactly its own path, and is checked by identity", () => {
    const gate = mintScriptToken("/h/.volley/volleyd/brief-gate");
    expect(() =>
      assertAllowed(["/h/.volley/volleyd/brief-gate", "/wt/.volley/brief.md"], { script: gate }),
    ).not.toThrow();
    expect(() => assertAllowed(["/h/other", "x"], { script: gate })).toThrow(FenceError);
    expect(() => assertAllowed(["git", "push"], { script: gate })).toThrow(FenceError);
    const forged = { path: "/tmp/evil" } as ReturnType<typeof mintScriptToken>;
    expect(() => assertAllowed(["/tmp/evil"], { script: forged })).toThrow(FenceError);
  });

  it("rejects forged consent tokens", () => {
    const forged = { reason: "forged" } as unknown as ReturnType<typeof mintConsentToken>;
    expect(() =>
      assertAllowed(["git", "worktree", "remove", "/tmp/wt"], { consent: forged }),
    ).toThrow(FenceError);
  });
});

describe("exec", () => {
  // A throwaway repo, so these tests do not depend on running inside a git checkout.
  let repo: string;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "volleyd-exec-"));
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
    git("init", "-q");
    for (let i = 0; i < 20; i++) {
      git(
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        `c${i}`,
      );
    }
  });
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("refuses a denied command before spawning anything", async () => {
    await expect(exec(["git", "push", "origin", "HEAD"])).rejects.toBeInstanceOf(FenceError);
  });

  it("runs an allowed command and captures its output", async () => {
    const r = await exec(["git", "rev-parse", "--is-inside-work-tree"], { cwd: repo });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("true");
  });

  it("survives a child that exits without reading its stdin (no EPIPE crash)", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await exec(["git", "rev-parse", "--is-inside-work-tree"], {
        cwd: repo,
        input: "x".repeat(4 * 1024 * 1024),
      });
      expect(r.code).toBe(0);
    }
  });

  it("reports a non-zero exit without throwing", async () => {
    const r = await exec(["git", "rev-parse", "--verify", "no-such-ref-xyz"], { cwd: repo });
    expect(r.code).not.toBe(0);
  });

  it("caps captured output and flags it as truncated", async () => {
    const r = await exec(["git", "log", "--oneline"], { cwd: repo, maxOutputBytes: 10 });
    expect(r.code).toBe(0);
    expect(r.stdout).toHaveLength(10);
    expect(r.truncated).toBe(true);
    const full = await exec(["git", "log", "--oneline"], { cwd: repo });
    expect(full.truncated).toBeUndefined();
  });

  it("settles a timed-out command after the kill grace, even if a grandchild holds the pipes", async () => {
    // git hands the transport to GIT_SSH_COMMAND, which outlives SIGTERM/SIGKILL sent to git.
    const started = Date.now();
    const r = await exec(["git", "fetch", "ssh://example.invalid/x"], {
      cwd: repo,
      env: { ...process.env, GIT_SSH_COMMAND: "sh -c 'sleep 5' --" },
      timeoutMs: 200,
      killGraceMs: 200,
    });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("single spawn point", () => {
  it("no module other than exec.ts can spawn a child process", () => {
    const srcDir = new URL("../src/", import.meta.url).pathname;
    const files = (function walk(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
        d.isDirectory()
          ? walk(join(dir, d.name))
          : d.name.endsWith(".ts")
            ? [join(dir, d.name)]
            : [],
      );
    })(srcDir);
    const offenders = files.filter((f) => {
      if (f.endsWith("/exec.ts")) return false;
      const text = readFileSync(f, "utf-8");
      return /child_process|Bun\.spawn|Bun\.\$|execa|\bspawnSync\b/.test(text);
    });
    expect(offenders).toEqual([]);
  });
});
