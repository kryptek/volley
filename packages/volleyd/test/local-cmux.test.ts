import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import { FenceError, mintConsentToken, mintModelSwitchToken, sealLaunchScript } from "../src/fence";
import { LocalCmuxHost, parseWorkspaceRef } from "../src/hosts/local-cmux";
import { LAUNCH_COMMAND, renderLaunchScript } from "../src/launch";
import type { SpawnError } from "../src/spawn-error";
import { fakeExec } from "./helpers/fake-exec";

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

  it("writeFile creates parents and applies the mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "volleyd-host-"));
    try {
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
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
