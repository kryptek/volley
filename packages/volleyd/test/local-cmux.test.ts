import { chmodSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeCmuxPassword } from "volley-cli/setup/cmux";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import {
  FenceError,
  mintConsentToken,
  mintHandoffToken,
  mintModelSwitchToken,
  mintPickerToken,
  sealLaunchScript,
} from "../src/fence";
import { LocalCmuxHost, parseWorkspaceList, parseWorkspaceRef } from "../src/hosts/local-cmux";
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

describe("LocalCmuxHost", () => {
  it("readScreen maps to cmux read-screen --workspace <ref> --lines N", async () => {
    const fake = fakeExec().on(["cmux", "read-screen"], { stdout: "screen text\n" });
    const host = new LocalCmuxHost(fake.exec);
    expect(await host.readScreen("workspace:3", 40)).toBe("screen text\n");
    expect(fake.calls[0]?.argv).toEqual([
      "cmux",
      "read-screen",
      "--workspace",
      "workspace:3",
      "--lines",
      "40",
    ]);
  });

  it("readScreen is bounded by screen_read_timeout_ms; a timed-out read is null", async () => {
    const fake = fakeExec().on(["cmux", "read-screen"], { stdout: "partial", timedOut: true });
    expect(await new LocalCmuxHost(fake.exec).readScreen("workspace:3", 40)).toBeNull();
    expect(fake.calls[0]?.opts.timeoutMs).toBe(DAEMON_DEFAULTS.screen_read_timeout_ms);
  });

  it("readScreen returns null when cmux fails", async () => {
    const fake = fakeExec().on(["cmux", "read-screen"], { code: 1, stderr: "no such workspace" });
    expect(await new LocalCmuxHost(fake.exec).readScreen("workspace:9", 10)).toBeNull();
  });

  it("sendKeys('Enter') maps to cmux send-key; sendText to cmux send", async () => {
    const fake = fakeExec();
    const host = new LocalCmuxHost(fake.exec);
    await host.sendKeys("workspace:3", "Enter");
    await host.sendText("workspace:3", "/model claude-sonnet-5-5", {
      modelSwitch: mintModelSwitchToken("claude-sonnet-5-5", "d-1"),
    });
    // Without the approved switch's token the fence refuses to type it.
    await expect(host.sendText("workspace:3", "/model claude-opus-5-5")).rejects.toThrow(
      FenceError,
    );
    expect(fake.argvs()).toEqual([
      ["cmux", "send-key", "--workspace", "workspace:3", "Enter"],
      ["cmux", "send", "--workspace", "workspace:3", "/model claude-sonnet-5-5"],
    ]);
  });

  it("picker keys and a handoff reply: cmux send-key Up|Down|Space and send, each with its token", async () => {
    const fake = fakeExec();
    const host = new LocalCmuxHost(fake.exec);
    await expect(host.sendKeys("workspace:3", "Down")).rejects.toThrow(FenceError);
    const picker = mintPickerToken({ item_id: "p-a1-t1", version: 1, keys: ["Down", "Space"] });
    await host.sendKeys("workspace:3", "Down", { picker });
    await host.sendKeys("workspace:3", "Space", { picker });
    const handoff = mintHandoffToken({ item_id: "h-a1-3", version: 1, text: "go" });
    await host.sendText("workspace:3", "go", { handoff });
    expect(fake.argvs()).toEqual([
      ["cmux", "send-key", "--workspace", "workspace:3", "Down"],
      ["cmux", "send-key", "--workspace", "workspace:3", "Space"],
      ["cmux", "send", "--workspace", "workspace:3", "go"],
    ]);
  });

  it("launch maps to cmux new-workspace and returns the workspace ref", async () => {
    const fake = fakeExec().on(["cmux", "new-workspace"], { stdout: "OK workspace:12\n" });
    const host = new LocalCmuxHost(fake.exec);
    const r = await host.launch({
      cwd: "/wt/x",
      name: "w1 T1 implementer",
      command: LAUNCH_COMMAND,
      launch: sealed("/wt/x"),
    });
    expect(r).toEqual({ workspace: "workspace:12" });
    expect(fake.calls[0]?.argv).toEqual([
      "cmux",
      "new-workspace",
      "--cwd",
      "/wt/x",
      "--name",
      "w1 T1 implementer",
      "--command",
      LAUNCH_COMMAND,
    ]);
  });

  it("a failed launch is LAUNCH_FAILED", async () => {
    const fake = fakeExec().on(["cmux", "new-workspace"], { code: 1, stderr: "socket timeout" });
    const err = await new LocalCmuxHost(fake.exec)
      .launch({ cwd: "/wt/x", name: "n", command: LAUNCH_COMMAND, launch: sealed("/wt/x") })
      .catch((e: unknown) => e);
    expect((err as SpawnError).code).toBe("LAUNCH_FAILED");
  });

  it("bounds the launch by launch_timeout_ms", async () => {
    const fake = fakeExec().on(["cmux", "new-workspace"], { stdout: "OK workspace:12\n" });
    await new LocalCmuxHost(fake.exec).launch({
      cwd: "/wt/x",
      name: "n",
      command: LAUNCH_COMMAND,
      launch: sealed("/wt/x"),
    });
    expect(fake.calls[0]?.opts.timeoutMs).toBe(DAEMON_DEFAULTS.launch_timeout_ms);
  });

  it("classifies a failed launch: refused when cmux created nothing, unknown when it may have", async () => {
    const outcome = async (reply: Parameters<ReturnType<typeof fakeExec>["on"]>[1]) => {
      const fake = fakeExec().on(["cmux", "new-workspace"], reply);
      const err = (await new LocalCmuxHost(fake.exec, tempDir("volleyd-cmux-"), {})
        .launch({ cwd: "/wt/x", name: "n", command: LAUNCH_COMMAND, launch: sealed("/wt/x") })
        .catch((e: unknown) => e)) as SpawnError;
      expect(err.code).toBe("LAUNCH_FAILED");
      return err.detail.outcome;
    };
    // The cmux CLI gave up on its own: the workspace may exist and its agent be starting.
    expect(await outcome({ code: 1, stderr: "Error: Command timed out" })).toBe("unknown");
    // volleyd's own bound fired.
    expect(await outcome({ code: 1, timedOut: true })).toBe("unknown");
    // A non-zero exit cmux did not explain, or an exit 0 with no ref in it.
    expect(await outcome({ code: 1, stderr: "something odd" })).toBe("unknown");
    expect(await outcome({ code: 0, stdout: "" })).toBe("unknown");
    // cmux answered and refused, is not running, or is not installed: nothing was created.
    expect(
      await outcome({ code: 1, stderr: "Access denied - only processes started inside cmux" }),
    ).toBe("refused");
    expect(await outcome({ code: 1, stderr: "connection refused" })).toBe("refused");
    expect(await outcome({ code: 127, stderr: "command not found" })).toBe("refused");
  });

  it("serializes launches: one new-workspace in flight at a time", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let n = 0;
    const fake = fakeExec().on(["cmux", "new-workspace"], async () => {
      n += 1;
      if (n === 1) await gate;
      return { stdout: `OK workspace:${n}\n` };
    });
    const host = new LocalCmuxHost(fake.exec);
    const spec = { cwd: "/wt/x", name: "n", command: LAUNCH_COMMAND, launch: sealed("/wt/x") };
    const first = host.launch(spec);
    const second = host.launch(spec);
    // Let every pending step run: the second launch must still be waiting on the first.
    for (let i = 0; i < 200; i++) await Promise.resolve();
    expect(fake.argvs(["cmux", "new-workspace"])).toHaveLength(1);
    release();
    expect(await first).toEqual({ workspace: "workspace:1" });
    expect(await second).toEqual({ workspace: "workspace:2" });
    expect(fake.argvs(["cmux", "new-workspace"])).toHaveLength(2);
    // A failed launch does not wedge the chain.
    fake.on(["cmux", "new-workspace"], { code: 1, stderr: "connection refused" });
    await expect(host.launch(spec)).rejects.toThrow("LAUNCH_FAILED");
    fake.on(["cmux", "new-workspace"], { stdout: "OK workspace:9\n" });
    expect(await host.launch(spec)).toEqual({ workspace: "workspace:9" });
  });

  it("findWorkspace looks a workspace up by the exact name volleyd gave it", async () => {
    // Shapes from live `cmux list-workspaces`: a `--name` title stays listed while the agent
    // sets its terminal title; only a workspace with no custom title lists `✳ <process title>`.
    const lines = [
      "  workspace:1621  w0 T9 rebase",
      "* workspace:880  ✳ something else  [selected]",
      "  workspace:1635  w1 T1 fixup",
      "  workspace:1636  w1 T1 fixup reviewer",
    ].join("\n");
    const fake = fakeExec().on(["cmux", "list-workspaces"], { stdout: `${lines}\n` });
    const host = new LocalCmuxHost(fake.exec);
    expect(await host.findWorkspace("w1 T1 fixup")).toBe("workspace:1635");
    expect(await host.findWorkspace("w1 T2 fixup")).toBeNull();
    expect(fake.argvs()).toEqual([
      ["cmux", "list-workspaces"],
      ["cmux", "list-workspaces"],
    ]);
    // cmux failing to answer is undecidable: the caller burns the attempt.
    fake.on(["cmux", "list-workspaces"], { code: 1, stderr: "connection refused" });
    await expect(host.findWorkspace("w1 T1 fixup")).rejects.toThrow();
    fake.on(["cmux", "list-workspaces"], { timedOut: true, code: 1 });
    await expect(host.findWorkspace("w1 T1 fixup")).rejects.toThrow();
  });

  it("a launch cmux refuses (volleyd runs outside cmux) says what to do, not the raw error", async () => {
    const home = tempDir("volleyd-cmux-");
    const fake = fakeExec().on(["cmux", "new-workspace"], {
      code: 1,
      stderr: "Access denied - only processes started inside cmux can connect",
    });
    const err = (await new LocalCmuxHost(fake.exec, home, {})
      .launch({ cwd: "/wt/x", name: "n", command: LAUNCH_COMMAND, launch: sealed("/wt/x") })
      .catch((e: unknown) => e)) as SpawnError;
    expect(err.code).toBe("LAUNCH_FAILED");
    expect(err.message).toContain("Socket control mode");
    expect(err.message).toContain("Password mode");
    expect(err.message).toContain("volley setup --repair");
    expect(err.message).toContain(
      "(cmux said: Access denied - only processes started inside cmux can connect)",
    );
    // The raw cmux text stays in the journaled detail.
    expect(err.detail.cmux).toContain("Access denied");
    // With a stored password, it says that one was refused.
    writeCmuxPassword(home, "stale");
    const stale = (await new LocalCmuxHost(fake.exec, home, {})
      .launch({ cwd: "/wt/x", name: "n", command: LAUNCH_COMMAND, launch: sealed("/wt/x") })
      .catch((e: unknown) => e)) as SpawnError;
    expect(stale.message).toContain("refused the socket password volleyd has");
  });

  it("gives every cmux call the stored socket password in its environment, read each time", async () => {
    const home = tempDir("volleyd-cmux-");
    const fake = fakeExec()
      .on(["cmux", "new-workspace"], { stdout: "OK workspace:3\n" })
      .on(["cmux", "read-screen"], { stdout: "x" });
    const host = new LocalCmuxHost(fake.exec, home, { PATH: "/usr/bin" });
    await host.readScreen("workspace:3", 5);
    expect(fake.calls[0]?.opts.env).toBeUndefined();
    writeCmuxPassword(home, "s3cret");
    await host.launch({
      cwd: "/wt/x",
      name: "n",
      command: LAUNCH_COMMAND,
      launch: sealed("/wt/x"),
    });
    await host.readScreen("workspace:3", 5);
    await host.sendKeys("workspace:3", "Enter");
    for (const c of fake.calls.slice(1)) {
      expect(c.opts.env?.CMUX_SOCKET_PASSWORD).toBe("s3cret");
      expect(c.opts.env?.PATH).toBe("/usr/bin");
      expect(c.argv.join(" ")).not.toContain("s3cret");
    }
  });

  it("close needs the cleanup consent token", async () => {
    const fake = fakeExec();
    const host = new LocalCmuxHost(fake.exec);
    await expect(
      host.close("workspace:3", { reason: "forged" } as ReturnType<typeof mintConsentToken>),
    ).rejects.toBeInstanceOf(FenceError);
    await host.close("workspace:3", mintConsentToken("volleyd cleanup --yes"));
    expect(fake.argvs()).toEqual([["cmux", "close-workspace", "--workspace", "workspace:3"]]);
  });

  it("a retire's own consent token closes the retiring agent's workspace through the real fence", async () => {
    const fake = fakeExec();
    const host = new LocalCmuxHost(fake.exec);
    await host.close("workspace:4", mintConsentToken("retire w1-t1-implementer-1"));
    expect(fake.argvs()).toEqual([["cmux", "close-workspace", "--workspace", "workspace:4"]]);
  });

  it("close is bounded by workspace_close_timeout_ms; a timed-out or failed close rejects", async () => {
    const consent = mintConsentToken("retire w1-t1-implementer-1");
    const fake = fakeExec();
    await new LocalCmuxHost(fake.exec).close("workspace:4", consent);
    expect(fake.calls[0]?.opts.timeoutMs).toBe(DAEMON_DEFAULTS.workspace_close_timeout_ms);
    const slow = fakeExec().on(["cmux", "close-workspace"], { timedOut: true, code: 143 });
    await expect(new LocalCmuxHost(slow.exec).close("workspace:4", consent)).rejects.toThrow(
      /timed out/,
    );
    const gone = fakeExec().on(["cmux", "close-workspace"], { code: 1, stderr: "not found" });
    await expect(new LocalCmuxHost(gone.exec).close("workspace:4", consent)).rejects.toThrow(
      /not found/,
    );
  });

  it("endSession closes the workspace, then lists processes under the worktree (fenced ps)", async () => {
    const consent = mintConsentToken("retire w1-t1-implementer-1");
    const fake = fakeExec().on(["ps"], {
      stdout:
        "  1 /sbin/launchd\n 99999999 claude --mcp-config=/nowhere/w9/T1-x/.volley/mcp.json\n",
    });
    const end = await new LocalCmuxHost(fake.exec).endSession("workspace:4", "/wt/w1/T1", consent);
    expect(end).toEqual({ closed: true, pids: [], how: "close-workspace" });
    expect(fake.argvs()).toEqual([
      ["cmux", "close-workspace", "--workspace", "workspace:4"],
      ["ps", "-axo", "pid=,command="],
    ]);
    // An unknown ref: nothing is closed, the processes are still looked for.
    const f2 = fakeExec().on(["cmux", "close-workspace"], { timedOut: true });
    const end2 = await new LocalCmuxHost(f2.exec).endSession(null, "/wt/w1/T1", consent);
    expect(end2).toEqual({ closed: false, pids: [], how: "none" });
    expect(f2.argvs()).toEqual([["ps", "-axo", "pid=,command="]]);
  });

  it("findWorkspace answers the one workspace with exactly that title", async () => {
    const list = [
      "  workspace:12  w1 T1 implementer",
      "* workspace:3  ✳ the owner's session  [selected]",
      "  workspace:13  w1 T1 implementer-x",
      "  workspace:14  w1 T2 fixup",
      "  workspace:15  w1 T2 fixup",
    ].join("\n");
    const fake = fakeExec().on(["cmux", "list-workspaces"], { stdout: list });
    const host = new LocalCmuxHost(fake.exec);
    expect(await host.findWorkspace("w1 T1 implementer")).toBe("workspace:12");
    // Two with one title: neither is trusted.
    await expect(host.findWorkspace("w1 T2 fixup")).rejects.toThrow(/2 workspaces/);
    expect(await host.findWorkspace("w1 T3 implementer")).toBeNull();
    expect(parseWorkspaceList(list, "✳ the owner's session")).toBe("workspace:3");
    const down = fakeExec().on(["cmux", "list-workspaces"], { code: 1 });
    await expect(new LocalCmuxHost(down.exec).findWorkspace("w1 T1 implementer")).rejects.toThrow();
  });

  it("writeFile creates parents and applies the mode", async () => {
    const dir = tempDir("volleyd-host-");
    const host = new LocalCmuxHost(fakeExec().exec);
    const p = join(dir, "a", ".volley", "agent.json");
    await host.writeFile(p, "{}", 0o600);
    expect(readFileSync(p, "utf-8")).toBe("{}");
    expect(statSync(p).mode & 0o777).toBe(0o600);
    // An existing, more open file is replaced, never rewritten in place at its old mode.
    chmodSync(p, 0o644);
    const before = statSync(p).ino;
    await host.writeFile(p, '{"broker":{"password":"pw"}}', 0o600);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(statSync(p).ino).not.toBe(before);
    expect(readdirSync(dirname(p))).toEqual(["agent.json"]);
  });
});

describe("parseWorkspaceRef", () => {
  it("reads the common output shapes", () => {
    expect(parseWorkspaceRef("OK workspace:3\n")).toBe("workspace:3");
    expect(parseWorkspaceRef('{"workspace_ref":"workspace:4"}')).toBe("workspace:4");
    expect(parseWorkspaceRef("0f8fad5b-d9cb-469f-a165-70867728950e")).toBe(
      "0f8fad5b-d9cb-469f-a165-70867728950e",
    );
    expect(parseWorkspaceRef("")).toBeNull();
  });
});

describe("parseWorkspaceList", () => {
  it("finds the exact name in cmux's line form", () => {
    const out =
      "* workspace:7  w1 T1 implementer  [selected]\n  workspace:8  w1 T1 implementer 2\n";
    expect(parseWorkspaceList(out, "w1 T1 implementer")).toBe("workspace:7");
    expect(parseWorkspaceList(out, "w1 T1 implementer 2")).toBe("workspace:8");
    expect(parseWorkspaceList(out, "w1 T1")).toBeNull();
    expect(parseWorkspaceList("", "w1 T1")).toBeNull();
  });

  it("throws when more than one workspace carries the name: which one is this launch's is unknown", () => {
    const lines = "  workspace:7  w1 T1 fixup\n* workspace:9  w1 T1 fixup  [selected]\n";
    expect(() => parseWorkspaceList(lines, "w1 T1 fixup")).toThrow(/2 workspaces/);
    const json = JSON.stringify([
      { ref: "workspace:3", name: "w1 T1 fixup" },
      { ref: "workspace:4", title: "w1 T1 fixup" },
    ]);
    expect(() => parseWorkspaceList(json, "w1 T1 fixup")).toThrow(/2 workspaces/);
  });

  it("reads a JSON array or a { workspaces } object", () => {
    expect(
      parseWorkspaceList(
        JSON.stringify([
          { ref: "workspace:3", name: "other" },
          { workspace_ref: "workspace:4", title: "w1 T1 fixup" },
        ]),
        "w1 T1 fixup",
      ),
    ).toBe("workspace:4");
    expect(
      parseWorkspaceList(
        JSON.stringify({ workspaces: [{ ref: "workspace:5", custom_title: "w1 T1 fixup" }] }),
        "w1 T1 fixup",
      ),
    ).toBe("workspace:5");
    expect(parseWorkspaceList("[]", "w1 T1 fixup")).toBeNull();
  });
});
