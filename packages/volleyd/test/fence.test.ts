import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exec } from "../src/exec";
import { FenceError, assertAllowed, mintConsentToken } from "../src/fence";

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
  // anything not on the allow-list
  ["bash", "-c", "echo hi"],
  ["sh", "-c", "git push"],
  ["/bin/rm", "-rf", "/"],
  ["sudo", "git", "status"],
  ["env", "git", "push"],
  ["curl", "https://example.com"],
  [],
];

const ALLOWED: string[][] = [
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
  ["/usr/bin/git", "status"],
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
  ["cmux", "new-workspace", "--name", "w1-t1", "--cwd", "/tmp/wt"],
  ["cmux", "list-workspaces"],
  ["cmux", "send", "--workspace", "workspace:3", " claude"],
  ["cmux", "send-key", "--workspace", "workspace:3", "Enter"],
  ["cmux", "read-screen", "--workspace", "workspace:3"],
  ["cmux", "ping"],
  ["claude", "--dangerously-skip-permissions", "--model", "claude-opus-5-5"],
  ["launchctl", "bootstrap", "gui/501", "/tmp/systems.volley.volleyd.plist"],
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

  it("rejects forged consent tokens", () => {
    const forged = { reason: "forged" } as unknown as ReturnType<typeof mintConsentToken>;
    expect(() =>
      assertAllowed(["git", "worktree", "remove", "/tmp/wt"], { consent: forged }),
    ).toThrow(FenceError);
  });
});

describe("exec", () => {
  it("refuses a denied command before spawning anything", async () => {
    await expect(exec(["git", "push", "origin", "HEAD"])).rejects.toBeInstanceOf(FenceError);
  });

  it("runs an allowed command and captures its output", async () => {
    const r = await exec(["git", "rev-parse", "--is-inside-work-tree"], {
      cwd: new URL(".", import.meta.url).pathname,
    });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("true");
  });

  it("survives a child that exits without reading its stdin (no EPIPE crash)", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await exec(["git", "rev-parse", "--is-inside-work-tree"], {
        cwd: new URL(".", import.meta.url).pathname,
        input: "x".repeat(4 * 1024 * 1024),
      });
      expect(r.code).toBe(0);
    }
  });

  it("reports a non-zero exit without throwing", async () => {
    const r = await exec(["git", "rev-parse", "--verify", "no-such-ref-xyz"], {
      cwd: new URL(".", import.meta.url).pathname,
    });
    expect(r.code).not.toBe(0);
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
