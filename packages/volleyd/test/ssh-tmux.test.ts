import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecOptions, ExecResult } from "../src/exec";
import {
  type RemoteStep,
  mintConsentToken,
  mintHandoffToken,
  mintPickerToken,
  mintScriptToken,
  sealLaunchScript,
} from "../src/fence";
import { type RemoteHostSpec, SshTmuxHost, resolveRemoteHost } from "../src/hosts/ssh-tmux";
import { LAUNCH_COMMAND, renderLaunchScript } from "../src/launch";
import type { SpawnError } from "../src/spawn-error";
import { fakeExec } from "./helpers/fake-exec";
import { FIXTURES } from "./helpers/fake-host";

const SPEC: RemoteHostSpec = {
  name: "box",
  target: "dev@box",
  repo: "/path/to/home/src/repo",
  worktree_root: "/path/to/home/wt",
  volley_dir: "/path/to/home/src/volley",
  tunnel: { remote_port: 21883, supervise: true },
};
/** A launch script volleyd would render, sealed for `cwd` (the fence starts it only so). */
const sealed = (cwd: string) =>
  sealLaunchScript(
    cwd,
    renderLaunchScript({
      hooksDir: "/opt/volley/packages/volley-hooks",
      model: "claude-opus-5-5",
      agentId: "w1-t1-implementer-1",
      worktree: cwd,
    }),
  );
const SSH = [
  "ssh",
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "dev@box",
  "bash",
  "-s",
];

type StepReply = (step: RemoteStep) => Partial<ExecResult> | undefined;

/** A fake exec for one remote host: answers each `ssh … bash -s` by its (single) remote step. */
function remote(reply: StepReply = () => undefined) {
  const fake = fakeExec().on(["ssh"], (_argv, opts: ExecOptions) => {
    const steps = opts.remote?.steps ?? [];
    for (const s of steps) {
      const r = reply(s);
      if (r !== undefined) return r;
    }
    return {};
  });
  const scripts = () => fake.calls.filter((c) => c.argv[0] === "ssh").map((c) => c.opts.remote);
  const steps = () => scripts().flatMap((s) => s?.steps ?? []);
  return { fake, host: new SshTmuxHost(SPEC, fake.exec), scripts, steps };
}

const argvIs =
  (...prefix: string[]) =>
  (s: RemoteStep) =>
    prefix.every((p, i) => s.argv[i] === p);

describe("SshTmuxHost", () => {
  it("every remote invocation is `ssh -T <target> bash -s` with the script on stdin", async () => {
    const r = remote((s) => (argvIs("tmux", "capture-pane")(s) ? { stdout: "x\n" } : undefined));
    await r.host.writeFile("/path/to/home/wt/w1/T1-implementer/ISSUE.md", "# issue\n");
    await r.host.readScreen("w1-T1-implementer", 40);
    await r.host.sendKeys("w1-T1-implementer", "Enter");
    await r.host.exec(["gh", "issue", "view", "42", "--json", "number"], { cwd: SPEC.repo });
    expect(r.fake.calls.length).toBeGreaterThan(0);
    for (const c of r.fake.calls) {
      expect(c.argv).toEqual(SSH);
      // Never a command string for the remote login shell, never a raw stdin.
      expect(c.opts.remote?.steps.length).toBeGreaterThan(0);
      expect(c.opts.input).toBeUndefined();
    }
    expect(r.steps().find(argvIs("gh"))).toEqual({
      argv: ["gh", "issue", "view", "42", "--json", "number"],
      cwd: SPEC.repo,
    });
  });

  it("writeFile creates the directory, decodes base64 into the file, and ends with chmod for a mode", async () => {
    const r = remote();
    const path = "/path/to/home/wt/w1/T1-implementer/.volley/agent.json";
    const content = `${JSON.stringify({ agent_id: "a", broker: { password: "pw" } })}\n`;
    await r.host.writeFile(path, content, 0o600);
    const steps = r.scripts()[0]?.steps ?? [];
    expect(steps.map((s) => s.argv)).toEqual([
      ["mkdir", "-p", "/path/to/home/wt/w1/T1-implementer/.volley"],
      ["base64", "-d"],
      ["chmod", "600", path],
    ]);
    expect(steps[1]?.stdout).toBe(path);
    expect(Buffer.from(steps[1]?.stdin ?? "", "base64").toString()).toBe(content);
    // The password never appears in clear in the script.
    expect(JSON.stringify(steps)).not.toContain('"pw"');

    await r.host.writeFile("/path/to/home/wt/x/ISSUE.md", "plain");
    expect(r.scripts()[1]?.steps.map((s) => s.argv[0])).toEqual(["mkdir", "base64"]);
  });

  it("a failed remote write throws", async () => {
    const r = remote((s) => (argvIs("base64")(s) ? { code: 1, stderr: "disk full" } : undefined));
    await expect(r.host.writeFile("/x/.volley/brief.md", "z")).rejects.toThrow(/disk full/);
  });

  it("launch: tmux new-session -d -s <wave>-<task>-<role> -c <worktree> 'bash .volley/launch.sh'", async () => {
    const r = remote((s) => (argvIs("tmux", "has-session")(s) ? { code: 1 } : undefined));
    const ws = await r.host.launch({
      cwd: "/path/to/home/wt/w1/T1-implementer",
      name: "w1 T1 implementer",
      command: LAUNCH_COMMAND,
      launch: sealed("/path/to/home/wt/w1/T1-implementer"),
    });
    expect(ws).toEqual({ workspace: "w1-T1-implementer" });
    expect(r.steps().map((s) => s.argv)).toEqual([
      ["tmux", "has-session", "-t", "=w1-T1-implementer"],
      ["printenv", "PATH"],
      [
        "tmux",
        "new-session",
        "-d",
        "-s",
        "w1-T1-implementer",
        "-c",
        "/path/to/home/wt/w1/T1-implementer",
        "bash .volley/launch.sh",
      ],
    ]);
  });

  /** A launch on a box whose ssh PATH is `ssh` and whose tmux server has `server` (null: none). */
  async function launchWithPaths(ssh: string, server: string | null) {
    const r = remote((s) =>
      argvIs("tmux", "has-session")(s)
        ? { code: 1 }
        : argvIs("printenv", "PATH")(s)
          ? { stdout: `${ssh}\n` }
          : argvIs("tmux", "show-environment")(s)
            ? server === null
              ? { code: 1, stderr: "no server running on /tmp/tmux-501/default" }
              : { stdout: `PATH=${server}\n` }
            : undefined,
    );
    await r.host.launch({
      cwd: "/wt",
      name: "w1 T1 implementer",
      command: LAUNCH_COMMAND,
      launch: sealed("/wt"),
    });
    return r.steps().map((s) => s.argv);
  }

  it("launch adds the ssh session's PATH to a running tmux server's first (a server keeps its old one)", async () => {
    const argvs = await launchWithPaths(
      "/path/to/home/.local/bin:/opt/homebrew/bin:/usr/bin:/bin",
      "/usr/bin:/bin",
    );
    expect(argvs).toContainEqual(["tmux", "show-environment", "-g", "PATH"]);
    const set = argvs.findIndex((a) => a[1] === "set-environment");
    expect(argvs[set]).toEqual([
      "tmux",
      "set-environment",
      "-g",
      "PATH",
      "/path/to/home/.local/bin:/opt/homebrew/bin:/usr/bin:/bin",
    ]);
    expect(set).toBeLessThan(argvs.findIndex((a) => a[1] === "new-session"));
  });

  it("launch never drops a directory a running tmux server's PATH has (the user's own server)", async () => {
    // Started from a full terminal: claude is in ~/.local/bin, which the ssh PATH lacks.
    const argvs = await launchWithPaths(
      "/opt/homebrew/bin:/usr/bin:/bin",
      "/path/to/home/.local/bin:/usr/bin:/bin",
    );
    expect(argvs.find((a) => a[1] === "set-environment")).toEqual([
      "tmux",
      "set-environment",
      "-g",
      "PATH",
      "/opt/homebrew/bin:/usr/bin:/bin:/path/to/home/.local/bin",
    ]);
  });

  it("launch leaves the tmux server alone when it has every directory already, or none runs", async () => {
    for (const server of ["/path/to/home/.local/bin:/usr/bin:/bin", null]) {
      const argvs = await launchWithPaths("/usr/bin::/path/to/home/.local/bin", server);
      expect(argvs.some((a) => a[1] === "set-environment")).toBe(false);
      expect(argvs.some((a) => a[1] === "new-session")).toBe(true);
    }
  });

  it("launch picks a free session name when one is taken (the relaunch after an update prompt)", async () => {
    const taken = new Set(["=w1-T1-implementer"]);
    const r = remote((s) =>
      argvIs("tmux", "has-session")(s) ? { code: taken.has(s.argv[3] ?? "") ? 0 : 1 } : undefined,
    );
    const ws = await r.host.launch({
      cwd: "/wt",
      name: "w1 T1 implementer",
      command: LAUNCH_COMMAND,
      launch: sealed("/wt"),
    });
    expect(ws.workspace).toBe("w1-T1-implementer-2");
  });

  it("a failed launch is LAUNCH_FAILED", async () => {
    const r = remote((s) =>
      argvIs("tmux", "has-session")(s)
        ? { code: 1 }
        : argvIs("tmux", "new-session")(s)
          ? { code: 1, stderr: "tmux: command not found" }
          : undefined,
    );
    const err = await r.host
      .launch({
        cwd: "/wt",
        name: "w1 T1 implementer",
        command: LAUNCH_COMMAND,
        launch: sealed("/wt"),
      })
      .catch((e: unknown) => e as SpawnError);
    expect(err).toMatchObject({ code: "LAUNCH_FAILED" });
    expect((err as Error).message).toContain("tmux: command not found");
  });

  it("classifies a failed launch: unknown once new-session was sent over a failing ssh, else refused", async () => {
    const launch = (reply: StepReply): Promise<SpawnError> =>
      remote(reply)
        .host.launch({
          cwd: "/wt",
          name: "w1 T1 implementer",
          command: LAUNCH_COMMAND,
          launch: sealed("/wt"),
        })
        .then(
          () => {
            throw new Error("launched");
          },
          (e: unknown) => e as SpawnError,
        );
    const noSession = (s: RemoteStep) =>
      argvIs("tmux", "has-session")(s) ? { code: 1 } : undefined;
    // tmux answered and refused: nothing was created.
    const refused = await launch(
      (s) => noSession(s) ?? (argvIs("tmux", "new-session")(s) ? { code: 1 } : undefined),
    );
    expect(refused.detail).toMatchObject({ outcome: "refused", candidate: "w1-T1-implementer" });
    // ssh failed after new-session was sent: the session may be running.
    const dropped = await launch(
      (s) => noSession(s) ?? (argvIs("tmux", "new-session")(s) ? { code: 255 } : undefined),
    );
    expect(dropped.detail).toMatchObject({ outcome: "unknown", candidate: "w1-T1-implementer" });
    const timedOut = await launch(
      (s) =>
        noSession(s) ??
        (argvIs("tmux", "new-session")(s) ? { code: 1, timedOut: true } : undefined),
    );
    expect(timedOut.detail).toMatchObject({ outcome: "unknown" });
    // ssh never got as far as new-session.
    const unreachable = await launch((s) =>
      argvIs("tmux", "has-session")(s) ? { code: 255 } : undefined,
    );
    expect(unreachable.detail).toMatchObject({ outcome: "refused" });
  });

  it("serializes launches: one new-session in flight at a time", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let sent = 0;
    const fake = fakeExec().on(["ssh"], async (_argv, opts: ExecOptions) => {
      const step = opts.remote?.steps[0];
      if (step === undefined) return {};
      if (argvIs("tmux", "has-session")(step)) return { code: 1 };
      if (argvIs("tmux", "new-session")(step)) {
        sent += 1;
        if (sent === 1) await gate;
      }
      return {};
    });
    const host = new SshTmuxHost(SPEC, fake.exec);
    const spec = (n: string) => ({
      cwd: "/wt",
      name: n,
      command: LAUNCH_COMMAND,
      launch: sealed("/wt"),
    });
    const first = host.launch(spec("w1 T1 implementer"));
    const second = host.launch(spec("w1 T2 implementer"));
    // Let every pending step run: the second launch must still be waiting on the first.
    for (let i = 0; i < 200; i++) await Promise.resolve();
    expect(sent).toBe(1);
    release();
    expect(await first).toEqual({ workspace: "w1-T1-implementer" });
    expect(await second).toEqual({ workspace: "w1-T2-implementer" });
  });

  it("findWorkspace asks tmux has-session for the exact candidate session", async () => {
    const live = new Set(["=w1-T1-implementer-2"]);
    const r = remote((s) =>
      argvIs("tmux", "has-session")(s) ? { code: live.has(s.argv[3] ?? "") ? 0 : 1 } : undefined,
    );
    expect(await r.host.findWorkspace("w1 T1 implementer", "w1-T1-implementer-2")).toBe(
      "w1-T1-implementer-2",
    );
    // Without a candidate: the session name the title maps to.
    expect(await r.host.findWorkspace("w1 T1 implementer")).toBeNull();
    expect(r.steps().map((s) => s.argv)).toEqual([
      ["tmux", "has-session", "-t", "=w1-T1-implementer-2"],
      ["tmux", "has-session", "-t", "=w1-T1-implementer"],
    ]);
    // ssh failing is undecidable.
    const down = remote((s) => (argvIs("tmux", "has-session")(s) ? { code: 255 } : undefined));
    await expect(down.host.findWorkspace("w1 T1 implementer")).rejects.toThrow();
  });

  it("launch.sh for a remote host: the box's mcp.json, the remote hooks dir, env exports for tooling", () => {
    const host = new SshTmuxHost(SPEC, fakeExec().exec);
    // The box's own volley checkout runs the agent's MCP server.
    expect(host.mcpEntry).toBe("/path/to/home/src/volley/packages/volley-mcp/src/index.ts");
    const script = renderLaunchScript({
      hooksDir: new SshTmuxHost(SPEC, fakeExec().exec).hooksDir,
      model: "claude-opus-5-5",
      agentId: "w1-t1-implementer-1",
      worktree: "/wt/x",
      env: new SshTmuxHost(SPEC, fakeExec().exec).launchEnv({
        agent_id: "w1-t1-implementer-1",
        namespace: "default",
      }),
    });
    expect(script).toContain("--strict-mcp-config --mcp-config='/wt/x/.volley/mcp.json'");
    expect(script.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(script).toContain(
      "export VOLLEY_HOOKS_DIR='/path/to/home/src/volley/packages/volley-hooks'",
    );
    expect(script).toContain("export VOLLEY_BROKER_URL='mqtt://127.0.0.1:21883'");
    expect(script).toContain("export VOLLEY_NAMESPACE='default'");
    expect(script).toContain("export VOLLEY_AGENT_ID='w1-t1-implementer-1'");
  });

  it("readScreen uses capture-pane -p and returns the last N non-trailing-blank lines", async () => {
    const capture = readFileSync(join(FIXTURES, "tmux-capture.txt"), "utf-8");
    const r = remote((s) => (argvIs("tmux", "capture-pane")(s) ? { stdout: capture } : undefined));
    const screen = await r.host.readScreen("w1-T1-implementer", 5);
    expect(r.steps()[0]?.argv).toEqual([
      "tmux",
      "capture-pane",
      "-p",
      "-t",
      "=w1-T1-implementer:",
      "-S-5",
    ]);
    const lines = (screen ?? "").split("\n");
    expect(lines).toHaveLength(5);
    expect(lines.at(-1)).toContain("bypass permissions on");
  });

  it("readScreen is null when the session is gone or ssh fails", async () => {
    const r = remote((s) =>
      argvIs("tmux", "capture-pane")(s) ? { code: 1, stderr: "can't find session" } : undefined,
    );
    expect(await r.host.readScreen("gone", 10)).toBeNull();
    const fails = new SshTmuxHost(SPEC, async () => {
      throw new Error("spawn ssh ENOENT");
    });
    expect(await fails.readScreen("x", 10)).toBeNull();
  });

  it("sendKeys / sendText map to tmux send-keys (text literal, after --)", async () => {
    const r = remote();
    await r.host.sendKeys("w1-T1-implementer", "Enter");
    await r.host.sendText("w1-T1-implementer", LAUNCH_COMMAND, { launch: sealed("/wt") });
    expect(r.steps().map((s) => s.argv)).toEqual([
      ["tmux", "send-keys", "-t", "=w1-T1-implementer:", "Enter"],
      ["tmux", "send-keys", "-t", "=w1-T1-implementer:", "-l", "--", LAUNCH_COMMAND],
    ]);
  });

  it("picker keys and a handoff reply map to tmux send-keys, with their tokens", async () => {
    const r = remote();
    const picker = mintPickerToken({ item_id: "p-a1-t1", version: 1, keys: ["Up"] });
    await r.host.sendKeys("w1-T1-implementer", "Up", { picker });
    const handoff = mintHandoffToken({ item_id: "h-a1-3", version: 1, text: "hold" });
    await r.host.sendText("w1-T1-implementer", "hold", { handoff });
    await expect(r.host.sendKeys("w1-T1-implementer", "Down", { picker })).rejects.toThrow(
      /FENCE_DENIED/,
    );
    expect(r.steps().map((s) => s.argv)).toEqual([
      ["tmux", "send-keys", "-t", "=w1-T1-implementer:", "Up"],
      ["tmux", "send-keys", "-t", "=w1-T1-implementer:", "-l", "--", "hold"],
    ]);
  });

  it("close kills the tmux session, only with consent", async () => {
    const r = remote();
    await expect(r.host.close("w1-T1-implementer", { reason: "forged" } as never)).rejects.toThrow(
      /FENCE_DENIED/,
    );
    await r.host.close("w1-T1-implementer", mintConsentToken("volleyd cleanup w1 --yes"));
    expect(r.steps().map((s) => s.argv)).toEqual([
      ["tmux", "kill-session", "-t", "=w1-T1-implementer"],
    ]);
  });

  it("endSession is kill-session (tmux ends the pane's processes); no ref, nothing run", async () => {
    const r = remote();
    const consent = mintConsentToken("retire w1-t1-implementer-1");
    expect(await r.host.endSession("w1-T1-implementer", "/wt/w1/T1-implementer", consent)).toEqual({
      closed: true,
      pids: [],
      how: "kill-session",
    });
    expect(r.steps().map((s) => s.argv)).toEqual([
      ["tmux", "kill-session", "-t", "=w1-T1-implementer"],
    ]);
    const r2 = remote();
    expect(await r2.host.endSession(null, "/wt/w1/T1-implementer", consent)).toEqual({
      closed: false,
      pids: [],
      how: "none",
    });
    expect(r2.steps()).toEqual([]);
  });

  it("prepareWorktree fetches the release branch, then cuts the worktree from it, no tracking", async () => {
    const wt = "/path/to/home/wt/w1/T1-implementer";
    const r = remote((s) =>
      argvIs("git", "-C", wt, "rev-parse")(s)
        ? { code: 128, stderr: "not a git repository" }
        : argvIs("git", "-C", SPEC.repo, "rev-parse", "--git-common-dir")(s)
          ? { stdout: ".git\n" }
          : argvIs("cat")(s)
            ? { stdout: "# existing\n.volley/\n" }
            : undefined,
    );
    const res = await r.host.prepareWorktree({
      repo: SPEC.repo,
      path: wt,
      branch: "w1/T1-implementer-1",
      base: "release/w1",
    });
    expect(res).toEqual({ path: wt, branch: "w1/T1-implementer-1", reused: false });
    const argvs = r.steps().map((s) => s.argv);
    expect(argvs.slice(0, 3)).toEqual([
      ["git", "-C", wt, "rev-parse", "--is-inside-work-tree"],
      ["git", "-C", SPEC.repo, "fetch", "--quiet", "origin", "release/w1"],
      [
        "git",
        "-C",
        SPEC.repo,
        "worktree",
        "add",
        "--no-track",
        wt,
        "-b",
        "w1/T1-implementer-1",
        "origin/release/w1",
      ],
    ]);
    // .volley/ was already excluded: only /ISSUE.md is appended to the remote info/exclude.
    const append = r.steps().find((s) => s.append === true);
    expect(append?.stdout).toBe(`${SPEC.repo}/.git/info/exclude`);
    expect(Buffer.from(append?.stdin ?? "", "base64").toString()).toBe(
      "# volleyd (agent worktrees)\n/ISSUE.md\n",
    );
  });

  it("prepareWorktree at a PR head sha: a reviewer gets it detached, a fixup a branch from it, never origin/<sha>", async () => {
    const sha = "c173b8450164fc5107b1fba7d4b5e3b218636c12";
    const wt = "/path/to/home/wt/w1/T1-quality_reviewer-1";
    const mk = () =>
      remote((s) =>
        argvIs("git", "-C", wt, "rev-parse")(s) ||
        argvIs("git", "-C", "/path/to/home/wt/w1/T1-fixup-1", "rev-parse")(s)
          ? { code: 128, stderr: "not a git repository" }
          : argvIs("git", "-C", SPEC.repo, "rev-parse", "--git-common-dir")(s)
            ? { stdout: ".git\n" }
            : argvIs("cat")(s)
              ? { stdout: "# existing\n.volley/\n/ISSUE.md\n" }
              : undefined,
      );
    const rev = mk();
    const res = await rev.host.prepareWorktree({
      repo: SPEC.repo,
      path: wt,
      branch: "unused",
      base: sha,
      detach: true,
    });
    expect(res).toEqual({ path: wt, branch: `HEAD (detached at ${sha})`, reused: false });
    expect(rev.steps().map((s) => s.argv)).toContainEqual([
      "git",
      "-C",
      SPEC.repo,
      "worktree",
      "add",
      "--detach",
      wt,
      sha,
    ]);
    expect(rev.steps().some((s) => s.argv.includes(`origin/${sha}`))).toBe(false);

    const fix = mk();
    const fwt = "/path/to/home/wt/w1/T1-fixup-1";
    await fix.host.prepareWorktree({
      repo: SPEC.repo,
      path: fwt,
      branch: "w1/T1-fixup-1",
      base: sha,
    });
    expect(fix.steps().map((s) => s.argv)).toContainEqual([
      "git",
      "-C",
      SPEC.repo,
      "worktree",
      "add",
      "--no-track",
      fwt,
      "-b",
      "w1/T1-fixup-1",
      sha,
    ]);
  });

  it("prepareWorktree at a sha the box already holds: a failed fetch is fine", async () => {
    const sha = "c173b8450164fc5107b1fba7d4b5e3b218636c12";
    const wt = "/path/to/home/wt/w1/T1-spec_reviewer-1";
    const r = remote((s) =>
      argvIs("git", "-C", wt, "rev-parse")(s)
        ? { code: 128, stderr: "not a git repository" }
        : argvIs("git", "-C", SPEC.repo, "fetch")(s)
          ? { code: 1, stderr: "fatal: couldn't find remote ref" }
          : argvIs("git", "-C", SPEC.repo, "rev-parse", "--git-common-dir")(s)
            ? { stdout: ".git\n" }
            : argvIs("cat")(s)
              ? { stdout: "# existing\n.volley/\n/ISSUE.md\n" }
              : undefined,
    );
    const res = await r.host.prepareWorktree({
      repo: SPEC.repo,
      path: wt,
      branch: "x",
      base: sha,
      detach: true,
    });
    expect(res.reused).toBe(false);
    expect(r.steps().map((s) => s.argv)).toContainEqual([
      "git",
      "-C",
      SPEC.repo,
      "rev-parse",
      "--verify",
      "--quiet",
      `${sha}^{commit}`,
    ]);
  });

  it("prepareWorktree reuses an existing remote worktree and reports its branch", async () => {
    const wt = "/path/to/home/wt/w1/T1-implementer";
    const r = remote((s) =>
      argvIs("git", "-C", wt, "rev-parse", "--is-inside-work-tree")(s)
        ? { stdout: "true\n" }
        : argvIs("git", "-C", wt, "rev-parse", "--abbrev-ref")(s)
          ? { stdout: "w1/T1-implementer-1\n" }
          : undefined,
    );
    const res = await r.host.prepareWorktree({
      repo: SPEC.repo,
      path: wt,
      branch: "w1/T1-implementer-2",
      base: "release/w1",
    });
    expect(res).toEqual({ path: wt, branch: "w1/T1-implementer-1", reused: true });
    expect(r.steps().some(argvIs("git", "-C", SPEC.repo, "worktree"))).toBe(false);
  });

  it("a failed fetch is BASE_STALE (require_fresh_base); off, the box's copy is used and reported", async () => {
    const tip = "c".repeat(40);
    const r = remote((s) =>
      argvIs("git", "-C", SPEC.repo, "fetch")(s)
        ? { code: 128, stderr: "couldn't find remote ref release/w1" }
        : argvIs("git", "-C", "/wt", "rev-parse", "--is-inside-work-tree")(s)
          ? { code: 128 }
          : argvIs("git", "-C", "/wt", "rev-parse", "HEAD")(s)
            ? { stdout: `${tip}\n` }
            : undefined,
    );
    const spec = {
      repo: SPEC.repo,
      path: "/wt",
      branch: "b",
      base: "release/w1",
      releaseBase: true,
    };
    const err = (await r.host.prepareWorktree(spec).then(
      () => null,
      (e: unknown) => e,
    )) as SpawnError;
    expect(err).toMatchObject({ code: "BASE_STALE" });
    expect(err.message).toContain("couldn't find remote ref release/w1");
    expect(err.message).toContain("volleyd config set require_fresh_base false");
    expect(r.steps().some(argvIs("git", "-C", SPEC.repo, "worktree"))).toBe(false);
    // A start ref (a reviewer's head), not the release base: the plain worktree failure.
    const plain = (await r.host.prepareWorktree({ ...spec, releaseBase: false }).then(
      () => null,
      (e: unknown) => e,
    )) as SpawnError;
    expect(plain).toMatchObject({ code: "WORKTREE_FAILED" });
    expect(plain.message).not.toContain("require_fresh_base");
    const res = await r.host.prepareWorktree({ ...spec, requireFresh: false });
    expect(res.base).toEqual({
      sha: tip,
      fresh: false,
      fetch_error: "couldn't find remote ref release/w1",
    });
  });

  it("concurrent prepares on one machine fetch one at a time, even through two host objects", async () => {
    const log: string[] = [];
    let n = 0;
    const fake = fakeExec().on(["ssh"], async (_argv, opts: ExecOptions) => {
      const s = opts.remote?.steps[0];
      if (s === undefined) return {};
      if (argvIs("git", "-C", SPEC.repo, "fetch")(s)) {
        const i = n++;
        log.push(`start ${i}`);
        // Yield long enough for an unlocked second fetch to start.
        for (let k = 0; k < 20; k++) await Promise.resolve();
        log.push(`end ${i}`);
        return {};
      }
      return argvIs("git", "-C")(s) && s.argv[3] === "rev-parse" && s.argv[2] !== SPEC.repo
        ? { code: 128 }
        : {};
    });
    // Two inline specs for one machine are two host objects with one name: one lock.
    const a = new SshTmuxHost(SPEC, fake.exec);
    const b = new SshTmuxHost({ ...SPEC }, fake.exec);
    const spec = (task: string) => ({
      repo: SPEC.repo,
      path: `/wt/${task}`,
      branch: `w1/${task}-implementer-1`,
      base: "release/w1",
    });
    await Promise.all([
      a.prepareWorktree(spec("T1")),
      a.prepareWorktree(spec("T2")),
      b.prepareWorktree(spec("T3")),
    ]);
    expect(log).toEqual(["start 0", "end 0", "start 1", "end 1", "start 2", "end 2"]);
  });

  it("a fetch that lost a ref-lock race is retried once and the spawn goes on, the retry reported", async () => {
    const race =
      "error: fetching ref refs/remotes/origin/release/w1 failed: incorrect old value provided";
    let fetches = 0;
    const r = remote((s) =>
      argvIs("git", "-C", SPEC.repo, "fetch")(s)
        ? fetches++ === 0
          ? { code: 1, stderr: race }
          : {}
        : argvIs("git", "-C", "/wt", "rev-parse", "--is-inside-work-tree")(s)
          ? { code: 128 }
          : argvIs("git", "-C", "/wt", "rev-parse", "HEAD")(s)
            ? { stdout: `${"d".repeat(40)}\n` }
            : undefined,
    );
    const res = await r.host.prepareWorktree({
      repo: SPEC.repo,
      path: "/wt",
      branch: "b",
      base: "release/w1",
      releaseBase: true,
    });
    expect(fetches).toBe(2);
    expect(res.base).toEqual({ sha: "d".repeat(40), fresh: true });
    expect(res.fetch_retried).toBe(race);
  });

  it("a fetch that never reached origin is BASE_UNREACHABLE, not BASE_STALE", async () => {
    const r = remote((s) =>
      argvIs("git", "-C", SPEC.repo, "fetch")(s)
        ? {
            code: 128,
            stderr: "fatal: unable to access 'https://example.com/r/': Could not resolve host",
          }
        : argvIs("git", "-C", "/wt", "rev-parse")(s)
          ? { code: 128 }
          : undefined,
    );
    const err = (await r.host
      .prepareWorktree({
        repo: SPEC.repo,
        path: "/wt",
        branch: "b",
        base: "release/w1",
        releaseBase: true,
      })
      .then(
        () => null,
        (e: unknown) => e,
      )) as SpawnError;
    expect(err).toMatchObject({ code: "BASE_UNREACHABLE", permanent: false });
    expect(err.message).toContain("Could not resolve host");
    expect(err.message).not.toContain("require_fresh_base false");
  });

  it("a failed worktree add is WORKTREE_FAILED", async () => {
    const r = remote((s) =>
      argvIs("git", "-C", SPEC.repo, "worktree")(s)
        ? { code: 128, stderr: "fatal: already exists" }
        : argvIs("git", "-C", "/wt", "rev-parse")(s)
          ? { code: 128 }
          : undefined,
    );
    const err = await r.host
      .prepareWorktree({ repo: SPEC.repo, path: "/wt", branch: "b", base: "release/w1" })
      .catch((e: unknown) => e as SpawnError);
    expect(err).toMatchObject({ code: "WORKTREE_FAILED" });
  });

  it("repoExists / tunnelUp / readTrust run over bash -s", async () => {
    const claudeJson = JSON.stringify({
      oauthAccount: { token: "secret" },
      projects: { "/path/to/home/src/repo": { hasTrustDialogAccepted: true, history: ["x"] } },
    });
    const r = remote((s) =>
      argvIs("git", "-C", SPEC.repo, "rev-parse", "--git-dir")(s)
        ? { stdout: ".git\n" }
        : argvIs("nc")(s)
          ? { code: 1 }
          : argvIs("cat", ".claude.json")(s)
            ? { stdout: claudeJson }
            : undefined,
    );
    expect(await r.host.repoExists()).toBe(true);
    expect(await r.host.tunnelUp()).toBe(false);
    expect(r.steps().find(argvIs("nc"))?.argv).toEqual(["nc", "-z", "127.0.0.1", "21883"]);
    // Only the trust bits are kept: nothing else from the remote ~/.claude.json.
    expect(await r.host.readTrust()).toEqual({
      projects: { "/path/to/home/src/repo": { hasTrustDialogAccepted: true } },
    });
  });

  it("repoExists tells a missing clone from a failed ssh (which must not open a decision)", async () => {
    const answer = (code: number, timedOut = false) =>
      remote((s) => (argvIs("git")(s) ? { code, timedOut, stderr: "x" } : undefined)).host;
    expect(await answer(0).repoExists()).toBe(true);
    expect(await answer(128).repoExists()).toBe(false); // git: not a git repository
    for (const host of [answer(255), answer(0, true)]) {
      const err = await host.repoExists().catch((e: unknown) => e as SpawnError);
      expect(err).toMatchObject({ code: "LAUNCH_FAILED", detail: { target: "dev@box" } });
    }
  });

  it("readFile: the file, null when there is none, a throw when ssh fails", async () => {
    const r = remote((s) =>
      argvIs("cat", "/src/r/.volley/brief-extra.md")(s)
        ? { stdout: "notes\n" }
        : argvIs("cat", "/src/q/.volley/brief-extra.md")(s)
          ? { code: 1, stderr: "No such file" }
          : argvIs("cat", "/src/d/.volley/brief-extra.md")(s)
            ? { code: 255, stderr: "ssh: connect" }
            : undefined,
    );
    expect(await r.host.readFile("/src/r/.volley/brief-extra.md")).toBe("notes\n");
    expect(await r.host.readFile("/src/q/.volley/brief-extra.md")).toBeNull();
    await expect(r.host.readFile("/src/d/.volley/brief-extra.md")).rejects.toMatchObject({
      code: "LAUNCH_FAILED",
    });
    // readTrust over a failed ssh is not "untrusted" either.
    const down = remote(() => ({ code: 255, stderr: "ssh: connect" }));
    await expect(down.host.readTrust()).rejects.toMatchObject({ code: "LAUNCH_FAILED" });
  });

  it("a fence denial on the remote path surfaces as itself, permanent, never as an ssh failure", async () => {
    const r = remote();
    const err = (await r.host.readFile("/src/r/.volley/secret.md").catch((e) => e)) as SpawnError;
    expect(err.message).toMatch(/^FENCE_DENIED: remote cat /);
    expect(err.message).toContain("/src/r/.volley/secret.md");
    expect(err.message).not.toContain("no result");
    expect(err).toMatchObject({ code: "FENCE_DENIED", permanent: true });
    // Nothing reached ssh: the fence refused the script first.
    expect(r.fake.calls.filter((c) => c.argv[0] === "ssh")).toEqual([]);
    // The same for every other path that used to map a rejection to "no answer".
    await expect(r.host.readTrust("relative/profile")).rejects.toMatchObject({
      code: "FENCE_DENIED",
    });
  });

  it("recordTrust: compare-and-swap of the box's ~/.claude.json, keeping everything else", async () => {
    const before = `${JSON.stringify({
      oauthAccount: { token: "secret" },
      projects: { "/other": { history: ["x"] } },
    })}\n`;
    const r = remote((s) => (argvIs("cat", ".claude.json")(s) ? { stdout: before } : undefined));
    await r.host.recordTrust("/path/to/home/src/repo");
    const write = r.scripts().at(-1)?.steps ?? [];
    expect(write.map((s) => s.argv)).toEqual([
      ["cmp", "-s", "-", ".claude.json"],
      ["base64", "-d"],
      ["mv", "-f", ".claude.json.volleyd.tmp", ".claude.json"],
    ]);
    // The compare is against exactly what was read; the new file changes only the trust key.
    expect(Buffer.from(write[0]?.stdin ?? "", "base64").toString()).toBe(before);
    expect(write[1]?.stdout).toBe(".claude.json.volleyd.tmp");
    expect(JSON.parse(Buffer.from(write[1]?.stdin ?? "", "base64").toString())).toEqual({
      oauthAccount: { token: "secret" },
      projects: {
        "/other": { history: ["x"] },
        "/path/to/home/src/repo": { hasTrustDialogAccepted: true },
      },
    });
  });

  it("recordTrust re-reads and retries when the file changed under it; refuses with no file", async () => {
    let compares = 0;
    const r = remote((s) =>
      argvIs("cat", ".claude.json")(s)
        ? { stdout: "{}" }
        : argvIs("cmp")(s)
          ? ++compares === 1
            ? { code: 1 }
            : {}
          : undefined,
    );
    await r.host.recordTrust("/path/to/home/src/repo");
    expect(compares).toBe(2);
    expect(r.steps().filter(argvIs("cat", ".claude.json"))).toHaveLength(2);

    const none = remote((s) =>
      argvIs("cat")(s) ? { code: 1, stderr: "No such file" } : undefined,
    );
    await expect(none.host.recordTrust("/path/to/home/src/repo")).rejects.toThrow(
      /run claude there once/,
    );
    expect(none.steps().some(argvIs("mv"))).toBe(false);
  });

  it("exec routes credentials and the brief gate to the daemon's machine, the rest remote", async () => {
    const r = remote((s) => (argvIs("cat")(s) ? { stdout: "the brief\n" } : undefined));
    r.fake.on(["volley", "auth", "list"], { stdout: '{"accounts":[]}' });
    await r.host.exec(["volley", "auth", "list", "--json"]);
    expect(r.fake.calls.at(-1)?.argv).toEqual(["volley", "auth", "list", "--json"]);

    // The brief gate is a local program: it gets a local copy of the remote brief.
    let seen = "";
    const gate = "/path/to/home/.volleyd/brief-gate";
    r.fake.on([gate], (argv) => {
      seen = readFileSync(argv[1] as string, "utf-8");
      return { stdout: "ok" };
    });
    const res = await r.host.exec([gate, "/path/to/home/wt/x/.volley/brief.md"], {
      cwd: "/path/to/home/wt/x",
      script: mintScriptToken(gate),
    });
    expect(res.code).toBe(0);
    expect(seen).toBe("the brief\n");
    expect(r.steps().find(argvIs("cat"))?.argv).toEqual([
      "cat",
      "/path/to/home/wt/x/.volley/brief.md",
    ]);
  });
});

describe("resolveRemoteHost", () => {
  const configured = {
    box: { target: "dev@box", repo: "/src/r", volley_dir: "/src/volley" },
  };

  it("layers an inline host over the config entry it names, with defaults", () => {
    expect(
      resolveRemoteHost("box", { type: "ssh", tunnel: { remote_port: 2883 } }, configured),
    ).toEqual({
      name: "box",
      target: "dev@box",
      repo: "/src/r",
      worktree_root: "/src/.volley-worktrees",
      volley_dir: "/src/volley",
      tunnel: { remote_port: 2883, supervise: true },
    });
    expect(resolveRemoteHost("box", undefined, configured).tunnel.remote_port).toBe(21883);
  });

  it("an unknown or incomplete host is refused with what is missing", () => {
    expect(() => resolveRemoteHost("nope", undefined, configured)).toThrow(
      /host 'nope' is not configured/,
    );
    expect(() => resolveRemoteHost("half", { type: "ssh", name: "half", target: "x" }, {})).toThrow(
      /repo, volley_dir/,
    );
  });
});

describe("SshTmuxHost: readiness's PATH probe and the doctor (F2)", () => {
  const REPORT = {
    checks: [{ id: "repo.clone", ok: true, severity: "block", detail: "clone" }],
    doctor_at: "2026-10-19T09:00:00.000Z",
  };

  it("probePath runs `command -v claude bun` on the box and reads what resolved", async () => {
    // `command -v` exits 1 when one name is missing; what it printed is still the answer.
    const r = remote(() => ({ code: 1, stdout: "/path/to/home/.bun/bin/bun\n" }));
    expect(await r.host.probePath()).toEqual({ claude: false, bun: true });
    expect(r.steps()).toEqual([{ argv: ["command", "-v", "claude", "bun"] }]);
  });

  it("probePath throws when ssh itself fails (no answer is not a missing tool)", async () => {
    const r = remote(() => ({ code: 255, stderr: "ssh: connect to host box: Connection refused" }));
    await expect(r.host.probePath()).rejects.toThrow(/Connection refused/);
  });

  it("runDoctor runs volley peer doctor --json in the box's volley checkout and parses it", async () => {
    const r = remote(() => ({ code: 1, stdout: JSON.stringify(REPORT) }));
    expect(await r.host.runDoctor({ fix: false })).toEqual(REPORT);
    expect(await r.host.runDoctor({ fix: true, clone: "https://github.com/o/r" })).toEqual(REPORT);
    const dir = ["--supervisor-volley-dir", SPEC.volley_dir];
    expect(r.steps()).toEqual([
      { argv: ["volley", "peer", "doctor", "--json", ...dir], cwd: SPEC.volley_dir },
      {
        argv: [
          "volley",
          "peer",
          "doctor",
          "--json",
          ...dir,
          "--fix",
          "--yes",
          "--clone",
          "--origin",
          "https://github.com/o/r",
        ],
        cwd: SPEC.volley_dir,
      },
    ]);
  });

  it("runDoctor on a volley older than --supervisor-volley-dir runs the doctor again without it", async () => {
    let n = 0;
    const r = remote(() =>
      n++ === 0
        ? { code: 2, stderr: "volley peer: Unknown option '--supervisor-volley-dir'" }
        : { code: 0, stdout: JSON.stringify(REPORT) },
    );
    expect(await r.host.runDoctor({ fix: false })).toEqual(REPORT);
    expect(r.steps().map((s) => s.argv)).toEqual([
      ["volley", "peer", "doctor", "--json", "--supervisor-volley-dir", SPEC.volley_dir],
      ["volley", "peer", "doctor", "--json"],
    ]);
  });

  it("runDoctor throws with ssh's reason, or when the doctor printed no report", async () => {
    const down = remote(() => ({ code: 255, stderr: "Permission denied (publickey)" }));
    await expect(down.host.runDoctor({ fix: false })).rejects.toThrow(
      /ssh to dev@box failed.*Permission denied/,
    );
    const none = remote(() => ({ code: 127, stderr: "bash: volley: command not found" }));
    await expect(none.host.runDoctor({ fix: false })).rejects.toThrow(
      /printed no report: bash: volley: command not found/,
    );
  });
});
