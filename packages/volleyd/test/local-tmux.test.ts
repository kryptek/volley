import { chmodSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS, DAEMON_DEFAULTS } from "../src/config-defaults";
import {
  FenceError,
  mintConsentToken,
  mintHandoffToken,
  mintModelSwitchToken,
  mintPickerToken,
  sealLaunchScript,
} from "../src/fence";
import { LocalTmuxHost, localSessionName } from "../src/hosts/local-tmux";
import { LAUNCH_COMMAND, renderLaunchScript } from "../src/launch";
import type { SpawnError } from "../src/spawn-error";
import { fakeExec } from "./helpers/fake-exec";
import { tempDir } from "./helpers/tmp";

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

const S = "volley-w1-T1-implementer";
const spec = (cwd = "/wt/x") => ({
  cwd,
  name: "w1 T1 implementer",
  command: LAUNCH_COMMAND,
  launch: sealed(cwd),
});
/** No session by that name: tmux's has-session answer. */
const noSession = { code: 1, stderr: `can't find session: ${S}` };

describe("localSessionName", () => {
  it("is volley-<wave>-<task>-<role>, with what tmux forbids replaced", () => {
    expect(localSessionName("w1 T1 implementer")).toBe(S);
    expect(localSessionName("w1 T1 implementer 2")).toBe(`${S}-2`);
    expect(localSessionName("w1 release v1.2")).toBe("volley-w1-release-v1-2");
  });
});

describe("LocalTmuxHost", () => {
  it("is the local host, reading screens as tmux", () => {
    const host = new LocalTmuxHost(fakeExec().exec);
    expect(host.name).toBe("local");
    expect(host.screenSource).toBe("tmux");
  });

  it("launch opens a detached, sized session running the sealed launch script in the worktree", async () => {
    const fake = fakeExec().on(["tmux", "has-session"], noSession);
    const r = await new LocalTmuxHost(fake.exec).launch(spec());
    expect(r).toEqual({ workspace: S });
    const size = [String(CONFIG_DEFAULTS.tmux_cols), String(CONFIG_DEFAULTS.tmux_rows)];
    expect(fake.argvs()).toEqual([
      ["tmux", "has-session", "-t", `=${S}`],
      [
        "tmux",
        "new-session",
        "-d",
        "-x",
        size[0],
        "-y",
        size[1],
        "-s",
        S,
        "-c",
        "/wt/x",
        "bash .volley/launch.sh",
      ],
    ]);
    expect(fake.calls[1]?.opts.timeoutMs).toBe(DAEMON_DEFAULTS.launch_timeout_ms);
  });

  it("launch takes the spawn's size, inside the fence's bounds", async () => {
    const fake = fakeExec().on(["tmux", "has-session"], noSession);
    await new LocalTmuxHost(fake.exec).launch({ ...spec(), size: { cols: 9999, rows: 50.4 } });
    expect(fake.argvs(["tmux", "new-session"])[0]?.slice(3, 7)).toEqual(["-x", "500", "-y", "50"]);
  });

  it("a taken session name falls back to -2, -3, …", async () => {
    const fake = fakeExec().on(["tmux", "has-session"], (argv) =>
      argv[3] === `=${S}` ? {} : noSession,
    );
    expect(await new LocalTmuxHost(fake.exec).launch(spec())).toEqual({ workspace: `${S}-2` });
  });

  it("refuses any command but the launch script, and a launch without its seal", async () => {
    const fake = fakeExec().on(["tmux", "has-session"], noSession);
    const host = new LocalTmuxHost(fake.exec);
    const other = (await host
      .launch({ ...spec(), command: "bash -c id" })
      .catch((e: unknown) => e)) as SpawnError;
    expect(other.code).toBe("LAUNCH_FAILED");
    expect(other.detail.outcome).toBe("refused");
    const unsealed = (await host
      .launch({ cwd: "/wt/x", name: "w1 T1 implementer", command: LAUNCH_COMMAND })
      .catch((e: unknown) => e)) as SpawnError;
    expect(unsealed.code).toBe("LAUNCH_FAILED");
    expect(unsealed.detail.outcome).toBe("refused");
    expect(fake.argvs(["tmux", "new-session"])).toEqual([]);
  });

  it("classifies a failed launch: refused when tmux created nothing, unknown when it may have", async () => {
    const outcome = async (reply: Parameters<ReturnType<typeof fakeExec>["on"]>[1]) => {
      const fake = fakeExec()
        .on(["tmux", "has-session"], noSession)
        .on(["tmux", "new-session"], reply);
      const err = (await new LocalTmuxHost(fake.exec)
        .launch(spec())
        .catch((e: unknown) => e)) as SpawnError;
      expect(err.code).toBe("LAUNCH_FAILED");
      expect(err.detail.candidate).toBe(S);
      return err.detail.outcome;
    };
    expect(await outcome({ code: 1, timedOut: true })).toBe("unknown");
    expect(
      await outcome(() => {
        throw new Error("spawn failed");
      }),
    ).toBe("unknown");
    expect(await outcome({ code: 1, stderr: `duplicate session: ${S}` })).toBe("refused");
    expect(await outcome({ code: 127, stderr: "tmux: command not found" })).toBe("refused");
  });

  it("a tmux the exec cannot spawn (ENOENT) says what to install", async () => {
    const enoent = () => {
      throw Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" });
    };
    const launchErr = async (fake: ReturnType<typeof fakeExec>) =>
      (await new LocalTmuxHost(fake.exec).launch(spec()).catch((e: unknown) => e)) as SpawnError;
    // The first has-session finds no tmux binary.
    let err = await launchErr(fakeExec().on(["tmux"], enoent));
    expect(err.code).toBe("LAUNCH_FAILED");
    expect(err.message).toContain("tmux is not installed");
    expect(err.message).toContain("sudo apt-get install -y tmux");
    expect(err.detail.outcome).toBe("refused");
    // tmux vanished between has-session and new-session: nothing ran.
    err = await launchErr(
      fakeExec().on(["tmux", "has-session"], noSession).on(["tmux", "new-session"], enoent),
    );
    expect(err.message).toContain("tmux is not installed");
    expect(err.detail.outcome).toBe("refused");
    await expect(
      new LocalTmuxHost(fakeExec().on(["tmux"], enoent).exec).findWorkspace("w1 T1 implementer"),
    ).rejects.toThrow("tmux is not installed");
  });

  it("serializes launches: one new-session in flight at a time", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let n = 0;
    const fake = fakeExec()
      .on(["tmux", "has-session"], noSession)
      .on(["tmux", "new-session"], async () => {
        n += 1;
        if (n === 1) await gate;
        return {};
      });
    const host = new LocalTmuxHost(fake.exec);
    const first = host.launch(spec());
    const second = host.launch(spec());
    for (let i = 0; i < 200; i++) await Promise.resolve();
    expect(fake.argvs(["tmux", "new-session"])).toHaveLength(1);
    release();
    await first;
    await second;
    expect(fake.argvs(["tmux", "new-session"])).toHaveLength(2);
    // A failed launch does not wedge the chain.
    fake.on(["tmux", "new-session"], { code: 1, stderr: "boom" });
    await expect(host.launch(spec())).rejects.toThrow("LAUNCH_FAILED");
    fake.on(["tmux", "new-session"], {});
    expect(await host.launch(spec())).toEqual({ workspace: S });
  });

  it("findWorkspace asks tmux for the exact session (the candidate a failed launch tried)", async () => {
    const fake = fakeExec().on(["tmux", "has-session"], (argv) =>
      argv[3] === `=${S}-2` ? {} : noSession,
    );
    const host = new LocalTmuxHost(fake.exec);
    expect(await host.findWorkspace("w1 T1 implementer")).toBeNull();
    expect(await host.findWorkspace("w1 T1 implementer", `${S}-2`)).toBe(`${S}-2`);
    expect(await host.findWorkspace("w1 T1 implementer 2")).toBe(`${S}-2`);
    // tmux not answering is undecidable: the caller burns the attempt.
    fake.on(["tmux", "has-session"], { code: 1, timedOut: true });
    await expect(host.findWorkspace("w1 T1 implementer")).rejects.toThrow();
    fake.on(["tmux", "has-session"], { code: 127, stderr: "tmux: command not found" });
    await expect(host.findWorkspace("w1 T1 implementer")).rejects.toThrow();
  });

  it("readScreen captures the pane's last lines, trailing blank rows dropped", async () => {
    const fake = fakeExec().on(["tmux", "capture-pane"], { stdout: "a\nb\nc\n\n\n" });
    const host = new LocalTmuxHost(fake.exec);
    expect(await host.readScreen(S, 2)).toBe("b\nc");
    expect(fake.calls[0]?.argv).toEqual(["tmux", "capture-pane", "-p", "-t", `=${S}:`, "-S-2"]);
    expect(fake.calls[0]?.opts.timeoutMs).toBe(DAEMON_DEFAULTS.screen_read_timeout_ms);
    fake.on(["tmux", "capture-pane"], { code: 1, stderr: "can't find pane" });
    expect(await host.readScreen(S, 2)).toBeNull();
    fake.on(["tmux", "capture-pane"], { stdout: "x", timedOut: true });
    expect(await host.readScreen(S, 2)).toBeNull();
  });

  it("sendKeys and sendText type into the pane, with the tokens the fence needs", async () => {
    const fake = fakeExec();
    const host = new LocalTmuxHost(fake.exec);
    await host.sendKeys(S, "Enter");
    await host.sendText(S, "/model claude-sonnet-5-5", {
      modelSwitch: mintModelSwitchToken("claude-sonnet-5-5", "d-1"),
    });
    await expect(host.sendText(S, "/model claude-opus-5-5")).rejects.toThrow(FenceError);
    await host.sendText(S, LAUNCH_COMMAND, { launch: sealed("/wt/x") });
    expect(fake.argvs()).toEqual([
      ["tmux", "send-keys", "-t", `=${S}:`, "Enter"],
      ["tmux", "send-keys", "-t", `=${S}:`, "-l", "--", "/model claude-sonnet-5-5"],
      ["tmux", "send-keys", "-t", `=${S}:`, "-l", "--", LAUNCH_COMMAND],
    ]);
  });

  it("picker keys and a handoff reply, each with its token", async () => {
    const fake = fakeExec();
    const host = new LocalTmuxHost(fake.exec);
    await expect(host.sendKeys(S, "Down")).rejects.toThrow(FenceError);
    const picker = mintPickerToken({ item_id: "p-a1-t1", version: 1, keys: ["Down", "Space"] });
    await host.sendKeys(S, "Down", { picker });
    await host.sendKeys(S, "Space", { picker });
    const handoff = mintHandoffToken({ item_id: "h-a1-3", version: 1, text: "go" });
    await host.sendText(S, "go", { handoff });
    expect(fake.argvs()).toEqual([
      ["tmux", "send-keys", "-t", `=${S}:`, "Down"],
      ["tmux", "send-keys", "-t", `=${S}:`, "Space"],
      ["tmux", "send-keys", "-t", `=${S}:`, "-l", "--", "go"],
    ]);
  });

  it("resize sizes the window, and back to the launch size", async () => {
    const fake = fakeExec().on(["tmux", "has-session"], noSession);
    const host = new LocalTmuxHost(fake.exec);
    await host.launch({ ...spec(), size: { cols: 200, rows: 60 } });
    expect(await host.resize(S, { cols: 100, rows: 30 })).toBe(true);
    expect(await host.resize(S, "launch")).toBe(true);
    expect(fake.argvs(["tmux", "resize-window"])).toEqual([
      ["tmux", "resize-window", "-t", `=${S}:`, "-x", "100", "-y", "30"],
      ["tmux", "resize-window", "-t", `=${S}:`, "-x", "200", "-y", "60"],
    ]);
    fake.on(["tmux", "resize-window"], { code: 1, stderr: "no such window" });
    await expect(host.resize(S, { cols: 100, rows: 30 })).rejects.toThrow(/no such window/);
  });

  it("close needs consent, is bounded, and is idempotent for a session already gone", async () => {
    const fake = fakeExec();
    const host = new LocalTmuxHost(fake.exec);
    await expect(
      host.close(S, { reason: "forged" } as ReturnType<typeof mintConsentToken>),
    ).rejects.toBeInstanceOf(FenceError);
    await host.close(S, mintConsentToken("volleyd cleanup --yes"));
    expect(fake.argvs()).toEqual([["tmux", "kill-session", "-t", `=${S}`]]);
    expect(fake.calls[0]?.opts.timeoutMs).toBe(DAEMON_DEFAULTS.workspace_close_timeout_ms);
    const consent = mintConsentToken("retire w1-t1-implementer-1");
    // Already gone (or no server at all): nothing left to close.
    fake.on(["tmux", "kill-session"], { code: 1, stderr: `can't find session: ${S}` });
    await host.close(S, consent);
    fake.on(["tmux", "kill-session"], {
      code: 1,
      stderr: "no server running on /tmp/tmux-1/default",
    });
    await host.close(S, consent);
    fake.on(["tmux", "kill-session"], { timedOut: true, code: 143 });
    await expect(host.close(S, consent)).rejects.toThrow(/timed out/);
    fake.on(["tmux", "kill-session"], { code: 1, stderr: "permission denied" });
    await expect(host.close(S, consent)).rejects.toThrow(/permission denied/);
    // No tmux to run: the owner reads what to install, not `spawn tmux ENOENT`.
    fake.on(["tmux", "kill-session"], () => {
      throw Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" });
    });
    await expect(host.close(S, consent)).rejects.toThrow("tmux is not installed");
  });

  it("endSession kills the session, then stops what still runs under the worktree (fenced ps)", async () => {
    const consent = mintConsentToken("retire w1-t1-implementer-1");
    const fake = fakeExec().on(["ps"], {
      stdout: "  1 /sbin/init\n 99999999 claude --mcp-config=/nowhere/w9/T1-x/.volley/mcp.json\n",
    });
    const end = await new LocalTmuxHost(fake.exec).endSession(S, "/wt/w1/T1", consent);
    expect(end).toEqual({ closed: true, pids: [], how: "kill-session" });
    expect(fake.argvs()).toEqual([
      ["tmux", "kill-session", "-t", `=${S}`],
      ["ps", "-axo", "pid=,command="],
    ]);
    // An unknown ref: nothing is killed, the processes are still looked for.
    const f2 = fakeExec();
    const end2 = await new LocalTmuxHost(f2.exec).endSession(null, "/wt/w1/T1", consent);
    expect(end2).toEqual({ closed: false, pids: [], how: "none" });
    expect(f2.argvs()).toEqual([["ps", "-axo", "pid=,command="]]);
  });

  it("prepareWorktree cuts the worktree with git, as the cmux host does", async () => {
    const fake = fakeExec();
    await new LocalTmuxHost(fake.exec)
      .prepareWorktree({
        repo: "/repo",
        path: "/wt/w1/T1-implementer",
        branch: "w1/T1-implementer-1",
        base: "main",
      })
      .catch(() => undefined);
    expect(fake.argvs()[0]?.[0]).toBe("git");
  });

  it("writeFile creates parents and applies the mode", async () => {
    const dir = tempDir("volleyd-host-");
    const host = new LocalTmuxHost(fakeExec().exec);
    const p = join(dir, "a", ".volley", "agent.json");
    await host.writeFile(p, "{}", 0o600);
    expect(readFileSync(p, "utf-8")).toBe("{}");
    expect(statSync(p).mode & 0o777).toBe(0o600);
    chmodSync(p, 0o644);
    const before = statSync(p).ino;
    await host.writeFile(p, '{"broker":{"password":"pw"}}', 0o600);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(statSync(p).ino).not.toBe(before);
    expect(readdirSync(dirname(p))).toEqual(["agent.json"]);
  });
});
