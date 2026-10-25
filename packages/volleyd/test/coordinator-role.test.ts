import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COORDINATOR_COMMAND,
  type CoordinatorScriptVars,
  REMOTE_CONTROL_ARGV,
  REMOTE_CONTROL_CONTINUE,
  coordinatorSession,
  desiredState,
  expandDir,
  extractRemoteControlLink,
  nextBackoff,
  renderCoordinatorScript,
  screenPrompt,
} from "../src/coordinator/role";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8");

const VARS: CoordinatorScriptVars = {
  dir: "/path/to/home/.volley/coordinator",
  name: "coord-test",
  namespace: "default",
  brokerPort: 21883,
  hooksDir: "/opt/volley/packages/volley-hooks",
  binDir: "/path/to/home/.volley/bin",
  capacity: 4,
  permissionMode: "acceptEdits",
  continueGraceS: 10,
};

describe("coordinator.sh", () => {
  it("cds into the dir, exports the env block, tries --continue, then execs the pinned argv", () => {
    expect(renderCoordinatorScript(VARS)).toBe(
      [
        "#!/usr/bin/env bash",
        "# Written by volleyd for the coordinator role. Do not edit.",
        "set -uo pipefail",
        "cd '/path/to/home/.volley/coordinator'",
        "export VOLLEY_AGENT_ID='coordinator'",
        "export VOLLEY_COORDINATOR='coord-test'",
        "export VOLLEY_NAMESPACE='default'",
        "export VOLLEY_BROKER_URL='mqtt://127.0.0.1:21883'",
        "export VOLLEY_AUTH_DIR='/path/to/home/.volley/coordinator/.volley/auth'",
        "export VOLLEY_HOOKS_COORDINATOR='1'",
        "export VOLLEY_HOOKS_DIR='/opt/volley/packages/volley-hooks'",
        `export PATH='/path/to/home/.volley/bin':"$PATH"`,
        "started=$SECONDS",
        "'claude' 'remote-control' '--continue' && exit 0",
        "[ $((SECONDS - started)) -lt 10 ] || exit 1",
        "exec 'claude' 'remote-control' '--name' 'coord-test' '--remote-control-session-name-prefix' 'coord-test' '--spawn' 'same-dir' '--capacity' '4' '--permission-mode' 'acceptEdits'",
        "",
      ].join("\n"),
    );
  });

  it("holds no secret: the login is the file VOLLEY_AUTH_DIR names", () => {
    const s = renderCoordinatorScript(VARS);
    expect(s).not.toMatch(/PASSWORD|password|TOKEN/);
  });

  it("the argv is exactly the help's flags, nothing else", () => {
    expect(REMOTE_CONTROL_ARGV(VARS)).toEqual([
      "claude",
      "remote-control",
      "--name",
      "coord-test",
      "--remote-control-session-name-prefix",
      "coord-test",
      "--spawn",
      "same-dir",
      "--capacity",
      "4",
      "--permission-mode",
      "acceptEdits",
    ]);
    // --continue cannot carry the spawn flags (claude 2.1.310 refuses the combination).
    expect(REMOTE_CONTROL_CONTINUE).toEqual(["claude", "remote-control", "--continue"]);
  });

  it("the tmux command and session name", () => {
    expect(COORDINATOR_COMMAND).toBe("bash .volley/coordinator.sh");
    expect(coordinatorSession("coord-test")).toBe("volley-coordinator-coord-test");
  });
});

describe("extractRemoteControlLink", () => {
  it("returns the first https://claude.ai/code/… URL of the banner", () => {
    expect(extractRemoteControlLink(fixture("remote-control-banner.txt"))).toBe(
      "https://claude.ai/code/session_01FAKEFAKEFAKEFAKEFAKE0000",
    );
  });

  it("null for a banner without one (the bare claude.ai/code mention is no link)", () => {
    expect(extractRemoteControlLink(fixture("remote-control-consent.txt"))).toBeNull();
    expect(extractRemoteControlLink("")).toBeNull();
  });

  it("keeps a query string", () => {
    expect(extractRemoteControlLink("at https://claude.ai/code/session_x?env=1 now")).toBe(
      "https://claude.ai/code/session_x?env=1",
    );
  });
});

describe("screenPrompt", () => {
  it("names the folder-trust question and the first-run consent", () => {
    expect(screenPrompt(fixture("remote-control-trust.txt"))).toBe("trust");
    expect(screenPrompt(fixture("remote-control-consent.txt"))).toBe("consent");
    expect(screenPrompt(fixture("remote-control-banner.txt"))).toBeNull();
  });
});

describe("nextBackoff", () => {
  const b = [5, 30, 120];
  it("walks the ladder and stays on its last rung", () => {
    expect([1, 2, 3, 4].map((d) => nextBackoff(b, d, 0))).toEqual([5, 30, 120, 120]);
  });
  it("resets after 600 s up", () => {
    expect(nextBackoff(b, 3, 599)).toBe(120);
    expect(nextBackoff(b, 3, 600)).toBe(5);
  });
});

describe("desiredState", () => {
  it("off without a machine, waiting while it is down, run otherwise", () => {
    expect(desiredState({ machine: null })).toBe("off");
    expect(desiredState({ machine: "box-a", up: false })).toBe("waiting");
    expect(desiredState({ machine: "box-a", up: true })).toBe("run");
    expect(desiredState({ machine: "local", up: true })).toBe("run");
  });
});

describe("expandDir", () => {
  it("expands ~ against the host's home; an absolute dir is kept", () => {
    expect(expandDir("~/.volley/coordinator", "/path/to/home")).toBe(
      "/path/to/home/.volley/coordinator",
    );
    expect(expandDir("/srv/coord", "/path/to/home")).toBe("/srv/coord");
  });
});
