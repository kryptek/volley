import { describe, expect, it } from "vitest";
import {
  brokerStepsNeedRoot,
  isRootStepCommand,
  noTerminalMessage,
  rootStepArgv,
  sudoReasons,
} from "../../src/setup/escalate";

describe("brokerStepsNeedRoot", () => {
  const base = {
    platform: "linux" as NodeJS.Platform,
    uid: 1000,
    layout: "snap" as const,
    steps: ["detect", "security", "accounts", "network"],
  };

  it("is true as the user on a Linux install whose broker files are root's (snap, etc)", () => {
    expect(brokerStepsNeedRoot(base)).toBe(true);
    expect(brokerStepsNeedRoot({ ...base, layout: "etc" })).toBe(true);
    expect(brokerStepsNeedRoot({ ...base, steps: ["security"] })).toBe(true);
  });

  it.each([
    ["root", { uid: 0 }],
    ["macOS", { platform: "darwin" as NodeJS.Platform }],
    ["brew-arm64", { layout: "brew-arm64" as const }],
    ["brew-intel", { layout: "brew-intel" as const }],
    ["container", { layout: "container" as const }],
    ["--peer", { peer: true }],
    ["--check", { check: true }],
    ["no security step", { steps: ["detect", "accounts", "services"] }],
  ])("is false for %s", (_, over) => {
    expect(brokerStepsNeedRoot({ ...base, ...over })).toBe(false);
  });
});

describe("rootStepArgv", () => {
  const bun = "/path/to/bun";
  const cli = "/path/to/volley/packages/volley-cli/src/cli.ts";
  const flags = {
    bun,
    repoRoot: "/path/to/volley",
    lan: false,
    brokerUrl: "mqtt://localhost:1883",
    dir: "/var/snap/mosquitto/common/volley",
  };

  it("names the three broker steps with everything resolved, `sudo -n` first", () => {
    expect(rootStepArgv(flags)).toEqual([
      "sudo",
      "-n",
      bun,
      cli,
      "setup",
      "--step",
      "detect",
      "--step",
      "security",
      "--step",
      "accounts",
      "--yes",
      "--no-lan",
      "--broker-url",
      "mqtt://localhost:1883",
      "--dir",
      "/var/snap/mosquitto/common/volley",
    ]);
  });

  it("passes --lan, and --layout/--config/--state-file/--repair only when given", () => {
    const argv = rootStepArgv({
      ...flags,
      lan: true,
      layout: "etc",
      config: "/etc/mosquitto/mosquitto.conf",
      stateFile: "/var/lib/mosquitto/dynamic-security.json",
      repair: true,
    });
    expect(argv).toContain("--lan");
    expect(argv).not.toContain("--no-lan");
    expect(argv.slice(-7)).toEqual([
      "--layout",
      "etc",
      "--config",
      "/etc/mosquitto/mosquitto.conf",
      "--state-file",
      "/var/lib/mosquitto/dynamic-security.json",
      "--repair",
    ]);
    expect(rootStepArgv(flags)).not.toContain("--layout");
    expect(rootStepArgv(flags)).not.toContain("--repair");
  });

  it("drops -n when sudo may prompt", () => {
    const argv = rootStepArgv({ ...flags, prompt: true });
    expect(argv.slice(0, 3)).toEqual(["sudo", bun, cli]);
  });

  it("is what the fence lets through, with and without -n", () => {
    for (const prompt of [false, true]) {
      const argv = rootStepArgv({ ...flags, prompt, lan: true, layout: "snap", repair: true });
      expect(isRootStepCommand(argv, { bun, repoRoot: "/path/to/volley" })).toBe(true);
    }
    expect(isRootStepCommand(rootStepArgv(flags), { bun, repoRoot: null })).toBe(false);
  });
});

describe("the messages", () => {
  it("names each reason, in install.sh's style", () => {
    expect(
      sudoReasons({
        layout: "snap",
        config: "/var/snap/mosquitto/common/mosquitto.conf",
        stateFile: "/var/snap/mosquitto/common/dynamic-security.json",
        restart: "sudo snap restart mosquitto",
        dir: "/var/snap/mosquitto/common/volley",
      }),
    ).toEqual([
      "sudo is needed to:",
      "  - write /var/snap/mosquitto/common/mosquitto.conf and create /var/snap/mosquitto/common/dynamic-security.json (the snap install keeps them as root's)",
      "  - restart the broker (sudo snap restart mosquitto)",
      "  - create the Volley auth dir /var/snap/mosquitto/common/volley",
    ]);
  });

  it("without a terminal: the one command to run, and the rerun after it", () => {
    expect(
      noTerminalMessage({
        layout: "snap",
        volley: "~/.volley/bin/volley",
        lan: false,
        argv: ["--yes", "--no-lan", "--simulated"],
      }),
    ).toEqual([
      "volley setup: Security: the broker's config and state file are root's on this install (snap), and sudo needs your password, which this run cannot ask for. In a terminal, run:",
      "  sudo ~/.volley/bin/volley setup --step detect --step security --step accounts --yes --no-lan",
      "then run `volley setup --yes --no-lan --simulated` again.",
    ]);
  });
});
