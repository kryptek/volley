import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exec } from "../src/exec";
import {
  FenceError,
  MODEL_ID,
  assertAllowed,
  mintConsentToken,
  mintModelSwitchToken,
  mintScriptToken,
  mintSetupToken,
  sealLaunchScript,
} from "../src/fence";
import { LAUNCH_COMMAND, renderLaunchScript } from "../src/launch";
import { withEnvSync } from "./helpers/with-env";

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
  // -B resets a branch: never main/master either
  ["git", "worktree", "add", "-B", "main", "/tmp/wt", "release/w1"],
  ["git", "worktree", "add", "-B", "Master", "/tmp/wt", "release/w1"],
  // -B only re-creates an agent branch (`<wave>/<task>-<role>-<n>`): never a release branch or
  // any other existing branch, which it would reset to the base
  ["git", "-C", "/tmp/repo", "worktree", "add", "/tmp/wt", "-B", "release/w1", "origin/release/w1"],
  ["git", "-C", "/tmp/repo", "worktree", "add", "/tmp/wt", "-Brelease/w1", "origin/release/w1"],
  ["git", "-C", "/tmp/repo", "worktree", "add", "/tmp/wt", "-B", "develop", "HEAD~5"],
  ["git", "-C", "/tmp/repo", "worktree", "add", "/tmp/wt", "-Bfeature", "HEAD"],
  ["git", "worktree", "add", "-B", "feature/someone-else", "/tmp/wt", "HEAD~5"],
  ["git", "worktree", "add", "-B", "w1/T1-reviewer-1", "/tmp/wt", "release/w1"],
  ["git", "worktree", "add", "-B", "w1/T1-implementer-0", "/tmp/wt", "release/w1"],
  ["git", "worktree", "add", "-B", "w1/T1-implementer-1/x", "/tmp/wt", "release/w1"],
  ["git", "worktree", "add", "-B", "W1/T1-implementer-1", "/tmp/wt", "release/w1"],
  // a tracking branch only as `branch --track <b> origin/<b>` (spawn's release base)
  ["git", "branch", "--track", "release/x", "origin/release/y"],
  ["git", "branch", "--track", "release/x", "release/x"],
  ["git", "branch", "--track", "release/x"],
  ["git", "branch", "--track", "main", "origin/main"],
  ["git", "branch", "--track", "-f", "origin/-f"],
  ["git", "branch", "--track", "release/x", "origin/release/x", "extra"],
  ["git", "branch", "--track", "release/x", "/tmp/repo/release/x"],
  ["git", "branch", "release/x", "--track", "origin/release/x"],
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
  // P1-4: cmux types into an agent's shell; claude runs with any flags. The review probes as
  // written (shape only: no --workspace); the approval of `/model` is tested below
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
  ["git", "worktree", "add", "-b", "Main", "/w", "origin/main"],
  ["git", "worktree", "add", "-bMASTER", "/w", "origin/main"],
  // fetch's repository is a remote name or a network URL, never a local path
  ["git", "fetch", "/tmp/evil-repo", "main"],
  ["git", "fetch", ".", "x:refs/remotes/y"],
  ["git", "fetch", "..", "main"],
  ["git", "fetch", "file:///tmp/evil-repo", "main"],
  ["git", "fetch", "--depth", "1", "/tmp/evil-repo"],
  // P3-5: GraphQL (mutations) and request headers (X-HTTP-Method-Override) through gh api
  ["gh", "api", "graphql", "-f", "query=mutation { deleteRef(input: {}) { clientMutationId } }"],
  ["gh", "api", "-X", "GET", "graphql", "-f", "query=mutation { x }"],
  ["gh", "api", "/graphql", "-f", "query=query { viewer { login } }"],
  ["gh", "api", "-H", "X-HTTP-Method-Override: DELETE", "repos/o/r/git/refs/heads/x"],
  ["gh", "api", "--header=X-HTTP-Method-Override: DELETE", "repos/o/r"],
  ["gh", "api", "--paginate", "-H", "Accept: application/json", "repos/o/r/pulls"],
  // … graphql as any path segment, and full URLs (another endpoint, or another host)
  ["gh", "api", "-X", "GET", "https://api.github.com/graphql", "-f", "query=mutation{x}"],
  ["gh", "api", "-X", "GET", "graphql/", "-f", "query=mutation { x }"],
  ["gh", "api", "GraphQL?x=1"],
  ["gh", "api", "https://evil.example/repos/o/r"],
  ["gh", "api", "http://api.github.com/repos/o/r"],
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
  // volley: only the account verbs, exact options. Agent logins go over volleyd's own
  // Dynamic Security connection (dynsec.ts): add-agent / rm-agent / grant are never run.
  ["volley", "auth", "init"],
  ["volley", "auth", "migrate"],
  ["volley", "auth", "list-agents", "--json"],
  ["volley", "pub", "volley/x/y/status", "{}"],
  ["volley", "auth", "add-agent", "w1-t1-implementer-1", "--json"],
  ["volley", "auth", "rm-agent", "w1-t1-implementer-1"],
  ["volley", "auth", "grant", "w1-t1-implementer-1", "--ack-to", "coord-b"],
  ["volley", "auth", "reload"],
  // mosquitto: only -h (its version)
  ["mosquitto", "-c", "/tmp/x.conf"],
  ["mosquitto", "-h", "-v"],
  ["pkill", "-HUP", "-x", "mosquitto"],
  ["volley", "auth", "add-agent", "--json"],
  ["volley", "auth", "add-agent", "Bad_Id"],
  ["volley", "auth", "add-agent", "a1", "--dir", "/tmp/x"],
  ["volley", "auth", "add-agent", "a1", "--ack-to", "--json"],
  ["volley", "auth", "rm-agent", "a1", "--json"],
  ["volley", "auth", "add-agent", "a1", "--force"],
  ["volley", "auth", "grant", "a1"], // grant needs at least one --ack-to
  ["volley", "auth", "grant", "a1", "--json"],
  ["volley", "auth", "grant", "a1", "--ack-to", "Bad Id"],
  // account verbs: exact shapes, never a token on argv, never an operator role by sign-in link
  ["volley", "auth", "list"],
  ["volley", "auth", "list", "--json", "--dir", "/tmp/x"],
  ["volley", "auth", "add", "phone", "--role", "steer"],
  ["volley", "auth", "add", "phone", "--role", "agent", "--json"],
  ["volley", "auth", "add", "phone", "--role", "steer", "--kind", "robot", "--json"],
  ["volley", "auth", "add", "Bad Id", "--role", "steer", "--json"],
  ["volley", "auth", "rotate", "phone"],
  ["volley", "auth", "revoke", "phone", "--force"],
  ["volley", "auth", "token"],
  ["volley", "auth", "init", "--force"],
  ["volley", "auth", "signin-link", "--role", "admin", "--label", "x", "--ttl", "60", "--json"],
  ["volley", "auth", "signin-link", "--role", "steer", "--label", "-x", "--ttl", "60", "--json"],
  ["volley", "auth", "signin-link", "--role", "steer", "--label", "a\nb", "--ttl", "60", "--json"],
  ["volley", "auth", "signin-link", "--role", "steer", "--label", "x", "--ttl", "0", "--json"],
  ["volley", "auth", "redeem", "vly_admin_0000abcd_secret", "--label", "x", "--json"],
  ["volley", "auth", "redeem", "--label", "x", "--json", "--dir", "/tmp/x"],
  // a script path without a minted token
  ["/home/u/.volley/volleyd/brief-gate", "/tmp/wt/.volley/brief.md"],
  [],
];

const ALLOWED: string[][] = [
  ["mosquitto", "-h"],
  ["volley", "auth", "list", "--json"],
  ["volley", "auth", "add", "phone", "--role", "steer", "--json"],
  ["volley", "auth", "add", "laptop", "--role", "peer", "--kind", "machine", "--json"],
  ["volley", "auth", "rotate", "phone", "--json"],
  ["volley", "auth", "revoke", "phone"],
  [
    "volley",
    "auth",
    "signin-link",
    "--role",
    "watch",
    "--label",
    "Owner's phone",
    "--ttl",
    "300",
    "--json",
  ],
  ["volley", "auth", "redeem", "--label", "Desk on mac", "--json"],
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
  ["git", "-C", "/tmp/repo", "fetch", "--quiet", "origin", "release/w1"],
  [
    "git",
    "-C",
    "/tmp/repo",
    "worktree",
    "add",
    "-B",
    "w1/T1-implementer-1",
    "/tmp/wt",
    "release/w1",
  ],
  ["git", "worktree", "add", "-Bw1/T-1_x-spec_reviewer-12", "/tmp/wt", "origin/release/w1"],
  ["git", "-C", "/tmp/repo", "branch", "--track", "release/w1", "origin/release/w1"],
  ["git", "-C", "/tmp/repo", "rev-parse", "--verify", "--quiet", "refs/remotes/origin/release/w1"],
  ["git", "-C", "/tmp/repo", "merge-base", "--is-ancestor", "a1b2c3", "d4e5f6"],
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
  ["git", "fetch", "git@github.com:o/r.git", "main"],
  ["git", "fetch", "--depth", "1", "origin", "release/w1"],
  ["git", "fetch", "--depth=1", "upstream", "main"],
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
  ["gh", "api", "repos/o/graphql-tools/pulls"],
  ["cmux", "list-workspaces"],
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

describe("SETUP: what a setup step volleyd runs for the Desk may run (a setup token)", () => {
  const repo = "/src/volley";
  const home = "/home/owner";
  const inputs = {
    restart: "brew services restart mosquitto",
    ctrl: { bin: "mosquitto_ctrl", stateFile: "/opt/homebrew/var/mosquitto/dynamic-security.json" },
    repoRoot: repo,
    bun: "/usr/local/bin/bun",
    home,
    uid: 501,
  };
  const setup = mintSetupToken(inputs);
  const desk = `${repo}/packages/volley-desk`;
  const hooks = `${repo}/packages/volley-hooks/scripts/install.sh`;
  const volleydCli = `${repo}/packages/volleyd/src/cli.ts`;
  const deskPlist = `${home}/Library/LaunchAgents/systems.volley.desk.plist`;

  // O3's own commands for a brew layout, minus what only a terminal may run.
  const SETUP_ALLOWED: [string[], string?][] = [
    [["brew", "services", "restart", "mosquitto"]],
    [["mosquitto_ctrl", "dynsec", "init", inputs.ctrl.stateFile, "dynsec-admin", "pw-1"]],
    [["mosquitto", "-h"]],
    [["launchctl", "print", "gui/501/systems.volley.volleyd"]],
    [["launchctl", "print", "gui/501/systems.volley.desk"]],
    [["launchctl", "bootout", "gui/501/systems.volley.desk"]],
    [["launchctl", "bootstrap", "gui/501", deskPlist]],
    [["systemctl", "--user", "daemon-reload"]],
    [["systemctl", "--user", "is-active", "volleyd.service"]],
    [["systemctl", "--user", "is-active", "volley-desk.service"]],
    [["systemctl", "--user", "enable", "volley-desk.service"]],
    [["systemctl", "--user", "restart", "volley-desk.service"]],
    [["bash", hooks]],
    [["bash", hooks, "--dry-run"]],
    [[inputs.bun, volleydCli, "install", "--broker-url", "mqtt://127.0.0.1:1883", "--dry-run"]],
    [[inputs.bun, "run", "build"], desk],
  ];
  const SETUP_DENIED: [string[], string?][] = [
    // No setup step runs it (the accounts step issues the token in-process; admin_token runs it
    // as an account verb, without a setup token).
    [["volley", "auth", "token", "--json"]],
    // volleyd's own service: installing or reloading it would stop the volleyd answering.
    [[inputs.bun, volleydCli, "install", "--broker-url", "mqtt://127.0.0.1:1883"]],
    [["volleyd", "install"]],
    [["launchctl", "bootout", "gui/501/systems.volley.volleyd"]],
    [["launchctl", "kickstart", "-k", "gui/501/systems.volley.volleyd"]],
    [
      [
        "launchctl",
        "bootstrap",
        "gui/501",
        `${home}/Library/LaunchAgents/systems.volley.volleyd.plist`,
      ],
    ],
    [["systemctl", "--user", "restart", "volleyd.service"]],
    [["systemctl", "--user", "enable", "volleyd.service"]],
    // Anything that needs sudo.
    [["sudo", "systemctl", "restart", "mosquitto"]],
    [["sudo", "snap", "restart", "mosquitto"]],
    [["sudo", "volley", "setup"]],
    // The keychain is a terminal's (the logged-in session's).
    [["security", "find-generic-password", "-s", "volley-broker", "-a", "coordinator", "-w"]],
    [["security", "-i"]],
    // Not O3's exact shapes.
    [["brew", "services", "stop", "mosquitto"]],
    [["mosquitto_ctrl", "dynsec", "init", "/tmp/other.json", "dynsec-admin", "pw-1"]],
    [["mosquitto_ctrl", "dynsec", "createClient", "x"]],
    [["bun", "run", "build"], desk],
    [[inputs.bun, "run", "build"], repo],
    [[inputs.bun, "run", "build"]],
    [["bash", "/tmp/install.sh"]],
    [["bash", hooks, "--force"]],
    [["launchctl", "bootstrap", "gui/501", "/tmp/evil.plist"]],
    [["launchctl", "print", "gui/501/com.example.other"]],
    [["volley", "auth", "list", "--json"]],
    [["git", "status"]],
    [["rm", "-rf", "/tmp/x"]],
  ];

  it.each(SETUP_ALLOWED.map(([a, cwd]) => [a.join(" "), a, cwd]))("allows %s", (_l, argv, cwd) => {
    const opts = { setup, ...(cwd !== undefined ? { cwd: cwd as string } : {}) };
    expect(() => assertAllowed(argv as string[], opts)).not.toThrow();
  });

  it.each(SETUP_DENIED.map(([a, cwd]) => [a.join(" "), a, cwd]))("denies %s", (_l, argv, cwd) => {
    const opts = { setup, ...(cwd !== undefined ? { cwd: cwd as string } : {}) };
    expect(() => assertAllowed(argv as string[], opts)).toThrow(FenceError);
  });

  it("needs the token: without it the setup commands are not volleyd's", () => {
    expect(() => assertAllowed(["brew", "services", "restart", "mosquitto"])).toThrow(FenceError);
    expect(() => assertAllowed(["bash", hooks])).toThrow(FenceError);
    const forged = { inputs } as unknown as ReturnType<typeof mintSetupToken>;
    expect(() =>
      assertAllowed(["brew", "services", "restart", "mosquitto"], { setup: forged }),
    ).toThrow(FenceError);
  });

  it("a layout only a terminal restarts (sudo, a container) gets no restart at all", () => {
    const etc = mintSetupToken({ ...inputs, restart: null, ctrl: null });
    expect(() =>
      assertAllowed(["brew", "services", "restart", "mosquitto"], { setup: etc }),
    ).toThrow(FenceError);
    expect(() =>
      assertAllowed(
        ["mosquitto_ctrl", "dynsec", "init", inputs.ctrl.stateFile, "dynsec-admin", "x"],
        {
          setup: etc,
        },
      ),
    ).toThrow(FenceError);
    // A sudo restart is never a setup command, whatever the inputs say.
    const sudo = mintSetupToken({ ...inputs, restart: "sudo systemctl restart mosquitto" });
    expect(() =>
      assertAllowed(["sudo", "systemctl", "restart", "mosquitto"], { setup: sudo }),
    ).toThrow(FenceError);
  });

  it("`volley auth token --json` is an account verb volleyd may run for admin_token", () => {
    expect(() => assertAllowed(["volley", "auth", "token", "--json"])).not.toThrow();
    expect(() => assertAllowed(["volley", "auth", "token", "--ttl", "60", "--json"])).toThrow(
      FenceError,
    );
  });
});

describe("model switches need an approved model_switch decision's token", () => {
  const send = (text: string, ws = "workspace:3") => ["cmux", "send", "--workspace", ws, text];

  it("denies /model in volleyd's own argv shape without a token (the review probe)", () => {
    for (const text of ["/model opus", "/model claude-sonnet-5-5", "/model claude-opus-5-5[1m]"]) {
      expect(() => assertAllowed(send(text)), text).toThrow(FenceError);
    }
    expect(() => assertAllowed(send("/model opus"))).toThrow(/model_switch/);
  });

  it("allows exactly the approved model, checked by identity", () => {
    const ok = mintModelSwitchToken("claude-sonnet-5-5", "d-1");
    expect(() =>
      assertAllowed(send("/model claude-sonnet-5-5"), { modelSwitch: ok }),
    ).not.toThrow();
    expect(() =>
      assertAllowed(send("/model claude-sonnet-5-5", "3f2c9a1e-0000-4000-8000-000000000000"), {
        modelSwitch: ok,
      }),
    ).not.toThrow();
    // A token for one model never types another one.
    expect(() => assertAllowed(send("/model opus"), { modelSwitch: ok })).toThrow(FenceError);
    const forged = { model: "opus", decision_id: "d-1" } as ReturnType<typeof mintModelSwitchToken>;
    expect(() => assertAllowed(send("/model opus"), { modelSwitch: forged })).toThrow(FenceError);
    // Nor is it consent for anything else.
    const kill = ["cmux", "close-workspace", "--workspace", "workspace:3"];
    expect(() => assertAllowed(kill, { modelSwitch: ok })).toThrow(FenceError);
  });

  it("allows the model ids a wave file may name (provider-qualified ones included)", () => {
    for (const model of [
      "claude-opus-5-5[1m]",
      "opus",
      "us.anthropic.claude-opus-4-1-20250805-v1:0",
      "claude-opus-4-1@20250805",
      "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-x-v1:0",
    ]) {
      const t = mintModelSwitchToken(model, "d-1");
      expect(() => assertAllowed(send(`/model ${model}`), { modelSwitch: t }), model).not.toThrow();
    }
  });

  it("refuses to mint a token for a model id that is not one", () => {
    for (const bad of ["x\n!rm -rf ~", "opus; git push", "", "-x", "a b"]) {
      expect(() => mintModelSwitchToken(bad, "d-1"), bad).toThrow(FenceError);
    }
  });

  it("the wave-file schema's model pattern is the fence's MODEL_ID (one grammar)", () => {
    const schema = JSON.parse(
      readFileSync(
        new URL("../../../spec/schemas/wave-file.schema.json", import.meta.url),
        "utf-8",
      ),
    ) as {
      properties: { model: { pattern: string } };
      $defs: { task: { properties: { model: { pattern: string } } } };
    };
    expect(schema.properties.model.pattern).toBe(MODEL_ID.source);
    expect(schema.$defs.task.properties.model.pattern).toBe(MODEL_ID.source);
  });
});

describe("the launch command needs the token of a launch script volleyd sealed", () => {
  const vars = {
    hooksDir: "/opt/volley/packages/volley-hooks",
    model: "claude-opus-5-5",
    agentId: "w1-t1-implementer-1",
    worktree: "/tmp/wt",
  };
  const script = renderLaunchScript(vars);
  const workspace = (cwd: string) => [
    "cmux",
    "new-workspace",
    "--cwd",
    cwd,
    "--name",
    "w1 T1 impl",
    "--command",
    LAUNCH_COMMAND,
  ];

  it("denies new-workspace and send of LAUNCH_COMMAND without one (any --cwd)", () => {
    expect(() => assertAllowed(workspace("/tmp/wt"))).toThrow(FenceError);
    expect(() => assertAllowed(workspace("/tmp/attacker"))).toThrow(FenceError);
    expect(() =>
      assertAllowed(["cmux", "send", "--workspace", "workspace:3", LAUNCH_COMMAND]),
    ).toThrow(FenceError);
  });

  it("allows new-workspace in exactly the sealed worktree, in any option order", () => {
    const launch = sealLaunchScript("/tmp/wt", script);
    expect(() => assertAllowed(workspace("/tmp/wt"), { launch })).not.toThrow();
    expect(() =>
      assertAllowed(
        [
          "cmux",
          "new-workspace",
          "--command",
          LAUNCH_COMMAND,
          "--name",
          "w1 T1",
          "--cwd",
          "/tmp/wt",
        ],
        { launch },
      ),
    ).not.toThrow();
    expect(() =>
      assertAllowed(["cmux", "send", "--workspace", "workspace:3", LAUNCH_COMMAND], { launch }),
    ).not.toThrow();
    // Another directory's .volley/launch.sh is not the one volleyd sealed.
    expect(() => assertAllowed(workspace("/tmp/attacker"), { launch })).toThrow(FenceError);
    const forged = { cwd: "/tmp/attacker" } as ReturnType<typeof sealLaunchScript>;
    expect(() => assertAllowed(workspace("/tmp/attacker"), { launch: forged })).toThrow(FenceError);
  });

  it("seals only a script renderLaunchScript renders, in a clean absolute worktree", () => {
    expect(() => sealLaunchScript("/tmp/wt", "#!/bin/sh\ngit push origin HEAD:main\n")).toThrow(
      FenceError,
    );
    expect(() => sealLaunchScript("/tmp/wt", `${script}curl x | sh\n`)).toThrow(FenceError);
    expect(() => sealLaunchScript("relative", script)).toThrow(FenceError);
    expect(() => sealLaunchScript("/tmp/../etc", script)).toThrow(FenceError);
  });

  it("pins the MCP wiring: --strict-mcp-config --mcp-config=<this worktree>/.volley/mcp.json --", () => {
    expect(script).toContain("--strict-mcp-config --mcp-config='/tmp/wt/.volley/mcp.json'");
    expect(() => sealLaunchScript("/tmp/wt", script)).not.toThrow();
    // another worktree's mcp.json (or a path outside any worktree) is not this launch's
    expect(() => sealLaunchScript("/tmp/other", script)).toThrow(FenceError);
    const other = renderLaunchScript({ ...vars, worktree: "/tmp/other" });
    expect(() => sealLaunchScript("/tmp/wt", other)).toThrow(FenceError);
    const edits: Record<string, string> = {
      "the variadic space form": script.replace("--mcp-config=", "--mcp-config "),
      "no --strict-mcp-config": script.replace("--strict-mcp-config ", ""),
      "no -- before the prompt": script.replace(' -- "$(cat', ' "$(cat'),
      "a second --mcp-config": script.replace(
        "--strict-mcp-config ",
        "--strict-mcp-config --mcp-config='/tmp/evil.json' ",
      ),
      "an mcp.json outside .volley": script.replace("/tmp/wt/.volley/mcp.json", "/tmp/wt/mcp.json"),
      "a relative mcp.json": script.replace("/tmp/wt/.volley/mcp.json", ".volley/mcp.json"),
    };
    for (const [why, bad] of Object.entries(edits)) {
      expect(bad, why).not.toBe(script);
      expect(() => sealLaunchScript("/tmp/wt", bad), why).toThrow(FenceError);
    }
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
    // real process: exec's kill of a real child, on the real clock.
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("the README quotes the fence policy", () => {
  it("verbatim from the src/fence.ts header", () => {
    const src = readFileSync(new URL("../src/fence.ts", import.meta.url), "utf-8");
    const header = src.slice(
      src.indexOf(" * DENY (never"),
      src.indexOf(" */", src.indexOf(" * DENY")),
    );
    const policy = header
      .trimEnd()
      .split("\n")
      .map((l) => l.replace(/^ \* ?/, ""))
      .join("\n");
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf-8");
    const start = readme.indexOf("```\nDENY (never") + 4;
    expect(readme.slice(start, readme.indexOf("\n```\n", start))).toBe(policy);
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

describe("sealLaunchScript: a Claude account profile's CLAUDE_CONFIG_DIR", () => {
  const WT = "/wt/w1/T1-implementer";
  const seal = (claudeConfigDir: string, env: Record<string, string | undefined> = {}) => {
    withEnvSync({ HOME: env.HOME ?? "/home/u", VOLLEY_CLAUDE_DIR: env.VOLLEY_CLAUDE_DIR }, () =>
      sealLaunchScript(
        WT,
        renderLaunchScript({
          hooksDir: "/opt/volley/packages/volley-hooks",
          model: "claude-opus-5-5",
          agentId: "w1-t1-implementer-1",
          worktree: WT,
          claudeConfigDir,
        }),
      ),
    );
  };

  it("allows a profile in the default root, ~/.volley/claude/<acct>", () => {
    expect(() => seal("/home/u/.volley/claude/work")).not.toThrow();
  });

  it("allows a profile in a configured root ($VOLLEY_CLAUDE_DIR), even inside a .volley/", () => {
    expect(() => seal("/srv/claude/work", { VOLLEY_CLAUDE_DIR: "/srv/claude" })).not.toThrow();
    expect(() =>
      seal("/data/.volley/profiles/work", { VOLLEY_CLAUDE_DIR: "/data/.volley/profiles" }),
    ).not.toThrow();
  });

  it("allows a profile outside any .volley/, wherever its root is", () => {
    expect(() => seal("/srv/claude/work")).not.toThrow();
  });

  it("refuses a profile inside the agent's worktree, its .volley/ included", () => {
    for (const dir of [
      WT,
      `${WT}/profile`,
      `${WT}/.volley/claude/work`,
      `${WT}/.volley/launch.sh`,
    ]) {
      expect(() => seal(dir), dir).toThrow(FenceError);
      // … even when the profiles root is configured to be there
      expect(() => seal(dir, { VOLLEY_CLAUDE_DIR: `${WT}/.volley/claude` }), dir).toThrow(
        FenceError,
      );
    }
  });

  it("refuses any other .volley/ path: not a direct child of the root, or not an account id", () => {
    for (const dir of [
      "/home/u/.volley/claude",
      "/home/u/.volley/claude/work/nested",
      "/home/u/.volley/claude/Work",
      "/home/u/.volley/volleyd/work",
      "/home/u/.volley/claude/../volleyd",
      "/srv/x/.volley/claude/work",
      "/srv/x/.VOLLEY/work",
    ]) {
      expect(() => seal(dir), dir).toThrow(FenceError);
    }
  });
});
