import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exec } from "../src/exec";
import {
  FenceError,
  type RemoteStep,
  assertAllowed,
  mintConsentToken,
  renderRemoteScript,
} from "../src/fence";

/** The one local argv a remote command runs as. */
const SSH = ["ssh", "-T", "-o", "BatchMode=yes", "dev@box", "bash", "-s"];
const remote = (...steps: RemoteStep[]) => ({ remote: { steps } });
const step = (...argv: string[]): RemoteStep => ({ argv });

describe("remote allow-list (ssh … bash -s)", () => {
  const DENIED: string[][] = [
    ["git", "push", "origin", "HEAD"],
    ["git", "-C", "/src/r", "push", "--force"],
    ["git", "reset", "--hard"],
    ["git", "worktree", "remove", "/wt/x"],
    ["git", "-c", "core.sshCommand=sh", "fetch"],
    ["rm", "-rf", "/home/dev/src"],
    ["rm", "-fr", "/"],
    ["rm", "/tmp/x"],
    ["gh", "pr", "merge", "1"],
    ["gh", "api", "repos/o/r"],
    ["bash", "-c", "rm -rf /"],
    ["sh", "-c", "true"],
    ["/usr/bin/git", "status"],
    ["tmux", "kill-server"],
    ["tmux", "kill-session", "-t", "=w1-T1-implementer"],
    ["tmux", "-f", "/tmp/evil.conf", "new-session", "-d"],
    ["tmux", "new-session", "-d", "-s", "x", "rm -rf ~"],
    ["tmux", "run-shell", "touch /tmp/pwned"],
    ["tmux", "capture-pane", "-p", "-t", "x", "-S", "-60"],
    ["mkdir", "-m", "777", "/tmp/x"],
    ["cat", "-v", "/etc/passwd"],
    ["base64", "-w0"],
    ["chmod", "-R", "777", "/"],
    ["chmod", "u+s", "/bin/x"],
    ["nc", "-e", "/bin/sh", "127.0.0.1", "1883"],
    ["nc", "-z", "evil.example", "1883"],
    ["terraform", "apply"],
    ["curl", "https://example.com"],
  ];

  it.each(DENIED)("refuses a remote script containing %s … before ssh runs", (...argv) => {
    expect(() => assertAllowed(SSH, remote(step("mkdir", "-p", "/wt"), { argv }))).toThrow(
      FenceError,
    );
  });

  const ALLOWED: string[][] = [
    ["git", "-C", "/src/r", "fetch", "--quiet", "origin", "release/w1"],
    [
      "git",
      "-C",
      "/src/r",
      "worktree",
      "add",
      "--no-track",
      "/wt/x",
      "-b",
      "w1/T1-implementer-1",
      "origin/release/w1",
    ],
    ["git", "-C", "/wt/x", "rev-parse", "--is-inside-work-tree"],
    ["gh", "issue", "view", "42", "--json", "number,title,body,url"],
    [
      "tmux",
      "new-session",
      "-d",
      "-s",
      "w1-T1-implementer",
      "-c",
      "/wt/x",
      "bash .volley/launch.sh",
    ],
    ["tmux", "capture-pane", "-p", "-t", "=w1-T1-implementer:", "-S-60"],
    ["tmux", "send-keys", "-t", "=w1-T1-implementer:", "Enter"],
    ["tmux", "send-keys", "-t", "=w1-T1-implementer:", "-l", "some text"],
    ["tmux", "has-session", "-t", "=w1-T1-implementer"],
    ["claude", "--version"],
    ["mkdir", "-p", "/wt/x/.volley"],
    ["cat", "/src/r/.git/info/exclude"],
    ["chmod", "600", "/wt/x/.volley/agent.json"],
    ["nc", "-z", "127.0.0.1", "1883"],
  ];

  it.each(ALLOWED)("allows %s … in a remote script", (...argv) => {
    expect(() => assertAllowed(SSH, remote({ argv }))).not.toThrow();
  });

  it("names the refused remote verb", () => {
    try {
      assertAllowed(SSH, remote(step("git", "push")));
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(FenceError);
      expect((e as FenceError).verb).toBe("remote git push");
    }
  });

  it("needs consent for destructive remote verbs, like the local ones", () => {
    const consent = mintConsentToken("volleyd cleanup w1 --yes");
    const kill = step("tmux", "kill-session", "-t", "=w1-T1-implementer");
    const rmwt = step("git", "-C", "/src/r", "worktree", "remove", "/wt/x");
    expect(() => assertAllowed(SSH, { ...remote(kill), consent })).not.toThrow();
    expect(() => assertAllowed(SSH, { ...remote(rmwt), consent })).not.toThrow();
    expect(() => assertAllowed(SSH, { ...remote(kill), consent: { reason: "forged" } })).toThrow(
      FenceError,
    );
  });

  it("only base64 -d takes stdin, only base64 text, and only it writes a file", () => {
    const write = (over: Partial<RemoteStep>): RemoteStep => ({
      argv: ["base64", "-d"],
      stdin: Buffer.from("hello").toString("base64"),
      stdout: "/wt/x/ISSUE.md",
      ...over,
    });
    expect(() => assertAllowed(SSH, remote(write({})))).not.toThrow();
    expect(() => assertAllowed(SSH, remote(write({ stdin: "EOF\nrm -rf /\n" })))).toThrow(
      FenceError,
    );
    expect(() => assertAllowed(SSH, remote(write({ argv: ["cat"] })))).toThrow(FenceError);
    expect(() => assertAllowed(SSH, remote(write({ stdout: "relative/path" })))).toThrow(
      FenceError,
    );
    expect(() =>
      assertAllowed(SSH, remote({ argv: ["git", "status"], stdout: "/home/dev/.bashrc" })),
    ).toThrow(FenceError);
    expect(() => assertAllowed(SSH, remote({ ...step("git", "status"), cwd: "rel" }))).toThrow(
      FenceError,
    );
  });

  it("refuses every other ssh form: no script, a raw script, a remote command string", () => {
    expect(() => assertAllowed(SSH)).toThrow(FenceError);
    expect(() => assertAllowed(SSH, { remote: { steps: [] } })).toThrow(FenceError);
    expect(() => assertAllowed(["ssh", "dev@box", "rm -rf /"])).toThrow(FenceError);
    expect(() => assertAllowed(["ssh", "-T", "dev@box", "bash", "-c", "true"])).toThrow(FenceError);
    expect(() =>
      assertAllowed(["ssh", "-T", "dev@box", "zsh", "-s"], remote(step("cat", "/x"))),
    ).toThrow(FenceError);
    expect(() =>
      assertAllowed(
        ["ssh", "-T", "-o", "ProxyCommand=sh -c x", "dev@box", "bash", "-s"],
        remote(step("cat", "/x")),
      ),
    ).toThrow(FenceError);
    expect(() =>
      assertAllowed(["ssh", "-T", "-oProxyCommand=x", "bash", "-s"], remote(step("cat", "/x"))),
    ).toThrow(FenceError);
    expect(() =>
      assertAllowed(["/usr/bin/ssh", ...SSH.slice(1)], remote(step("cat", "/x"))),
    ).toThrow(FenceError);
  });

  it("allows the reverse tunnel form, and only it", () => {
    const tunnel = [
      "ssh",
      "-N",
      "-R",
      "21883:127.0.0.1:1883",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=15",
      "dev@box",
    ];
    expect(() => assertAllowed(tunnel)).not.toThrow();
    expect(() => assertAllowed([...tunnel, "touch /tmp/x"])).toThrow(FenceError);
    expect(() => assertAllowed(tunnel, remote(step("cat", "/x")))).toThrow(FenceError);
    expect(() => assertAllowed(["ssh", "-N", "-L", "1883:127.0.0.1:1883", "dev@box"])).toThrow(
      FenceError,
    );
    expect(() =>
      assertAllowed(["ssh", "-N", "-R", "0.0.0.0:21883:127.0.0.1:1883", "dev@box"]),
    ).toThrow(FenceError);
  });
});

describe("renderRemoteScript", () => {
  it("single-quotes every word, so nothing in a path or value is shell syntax", () => {
    const script = renderRemoteScript({
      steps: [{ argv: ["cat", "/wt/it's; rm -rf / #"], cwd: "/wt/$(reboot)" }],
    });
    expect(script).toContain(`( cd '/wt/$(reboot)' && 'cat' '/wt/it'\\''s; rm -rf / #' )`);
    expect(script.startsWith("set -euo pipefail\n")).toBe(true);
  });

  it("writes a file from base64 under umask 077 (never world-readable, even briefly)", () => {
    const b64 = Buffer.from("secret\n").toString("base64");
    const script = renderRemoteScript({
      steps: [{ argv: ["base64", "-d"], stdin: b64, stdout: "/wt/x/.volley/agent.json" }],
    });
    expect(script).toContain(
      `( umask 077 && 'base64' '-d' > '/wt/x/.volley/agent.json' <<'VOLLEY_EOF'\n${b64}\nVOLLEY_EOF\n)`,
    );
  });
});

describe("exec + the remote fence", () => {
  let dir: string;
  let marker: string;
  let env: Record<string, string>;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "volleyd-remote-fence-"));
    marker = join(dir, "ssh-ran");
    // A stand-in `ssh` on PATH: records that it ran and the script it was given on stdin.
    const fake = join(dir, "ssh");
    writeFileSync(fake, `#!/bin/sh\ncat > ${JSON.stringify(marker)}\n`);
    chmodSync(fake, 0o755);
    env = { PATH: `${dir}:/usr/bin:/bin` };
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("a remote script containing git push or rm -rf is refused before ssh runs", async () => {
    for (const argv of [
      ["git", "push"],
      ["rm", "-rf", "/"],
    ]) {
      await expect(
        exec(SSH, { env, ...remote(step("mkdir", "-p", "/wt"), { argv }) }),
      ).rejects.toThrow(FenceError);
      expect(existsSync(marker)).toBe(false);
    }
  });

  it("an allowed script is what ssh receives on stdin, exactly as rendered", async () => {
    const script = { steps: [step("mkdir", "-p", "/wt/x"), step("nc", "-z", "127.0.0.1", "1883")] };
    const r = await exec(SSH, { env, remote: script });
    expect(r.code).toBe(0);
    expect(readFileSync(marker, "utf-8")).toBe(renderRemoteScript(script));
  });

  it("refuses a raw input next to a fenced script (the checked script is the one that runs)", async () => {
    await expect(
      exec(SSH, { env, input: "rm -rf /\n", ...remote(step("cat", "/x")) }),
    ).rejects.toThrow(FenceError);
  });
});
