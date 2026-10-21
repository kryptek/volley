import { describe, expect, it } from "vitest";
import {
  type Ref,
  compareVersions,
  deployPlan,
  normaliseTag,
  parseDirty,
  platformServices,
  resolveTag,
  servicesCheckout,
  stashName,
} from "../../src/deploy/plan";
import { renderSystemd } from "../../src/setup/services";

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Rendered by \`volleyd install\`. Edit the template in packages/volleyd/launchd/, not this file. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>systems.volley.volleyd</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/op/.bun/bin/bun</string>
    <string>/Users/op/src/volley &amp; co/packages/volleyd/src/cli.ts</string>
    <string>daemon</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/op/.volley/volleyd</string>
</dict>
</plist>
`;

describe("resolveTag", () => {
  const tags = ["v0.3.2", "v0.4.0", "v0.4.0-rc.1", "v0.10.0", "not-a-release"];

  it("--latest is the newest by version order (a prerelease below its release)", () => {
    expect(resolveTag(tags, "latest")).toBe("v0.10.0");
    expect(resolveTag(["v0.4.0-rc.1", "v0.4.0", "v0.3.9"], "latest")).toBe("v0.4.0");
    expect(resolveTag(["v0.4.0-rc.2", "v0.4.0-rc.10"], "latest")).toBe("v0.4.0-rc.10");
  });

  it("takes a tag with or without its v", () => {
    expect(resolveTag(tags, "0.4.0")).toBe("v0.4.0");
    expect(resolveTag(tags, "v0.4.0-rc.1")).toBe("v0.4.0-rc.1");
  });

  it("names the three newest when the tag is unknown", () => {
    expect(() => resolveTag(tags, "v9.9.9")).toThrow(
      "no tag v9.9.9 (the newest are v0.10.0, v0.4.0, v0.4.0-rc.1)",
    );
    expect(() => resolveTag([], "latest")).toThrow("no v* release tag");
  });

  it("refuses a malformed tag before any lookup", () => {
    for (const bad of ["v-1", "--x", "-v0.4.0", "v0.4", "v0.4.0;rm", "v0.4.0 x", ""]) {
      expect(() => resolveTag(tags, bad), bad).toThrow(/not a release tag/);
    }
  });

  it("normaliseTag and compareVersions", () => {
    expect(normaliseTag("1.2.3")).toBe("v1.2.3");
    expect(compareVersions("v1.10.0", "v1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("v1.0.0-rc.1", "v1.0.0")).toBeLessThan(0);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
  });
});

describe("servicesCheckout", () => {
  it("reads the checkout and bun from volleyd's launchd plist", () => {
    expect(servicesCheckout(PLIST)).toEqual({
      repo: "/Users/op/src/volley & co",
      bun: "/Users/op/.bun/bin/bun",
    });
  });

  it("reads them from volleyd's systemd unit", () => {
    const unit = renderSystemd({
      name: "volleyd",
      label: "systems.volley.volleyd",
      description: "Volley wave supervisor (volleyd)",
      args: ["/home/op/.bun/bin/bun", "/home/op/my repo/packages/volleyd/src/cli.ts", "daemon"],
      env: { PATH: "/usr/bin" },
      log: "/home/op/.volley/volleyd/volleyd.log",
      workdir: "/home/op/.volley/volleyd",
    });
    expect(servicesCheckout(unit)).toEqual({
      repo: "/home/op/my repo",
      bun: "/home/op/.bun/bin/bun",
    });
  });

  it("is null for a unit that does not run volleyd from a checkout", () => {
    expect(servicesCheckout("[Service]\nExecStart=/usr/bin/true\n")).toBeNull();
    expect(servicesCheckout("")).toBeNull();
  });
});

describe("parseDirty", () => {
  it("names each path with what changed", () => {
    expect(parseDirty(" M a.ts\n?? b\n")).toEqual(["a.ts (modified)", "b (untracked)"]);
    expect(parseDirty("A  n.ts\n D gone.ts\nR  old -> new\n")).toEqual([
      "n.ts (added)",
      "gone.ts (deleted)",
      "old -> new (renamed)",
    ]);
    expect(parseDirty("")).toEqual([]);
  });
});

describe("platformServices", () => {
  it("launchd labels on macOS, systemd user units on Linux, nothing elsewhere", () => {
    expect(platformServices("darwin", 501)).toEqual([
      {
        name: "systems.volley.volleyd",
        restart: ["launchctl", "kickstart", "-k", "gui/501/systems.volley.volleyd"],
      },
      {
        name: "systems.volley.desk",
        restart: ["launchctl", "kickstart", "-k", "gui/501/systems.volley.desk"],
      },
    ]);
    expect(platformServices("linux", 1000)).toEqual([
      { name: "volleyd.service", restart: ["systemctl", "--user", "restart", "volleyd.service"] },
      {
        name: "volley-desk.service",
        restart: ["systemctl", "--user", "restart", "volley-desk.service"],
      },
    ]);
    expect(platformServices("win32", 0)).toBeNull();
  });
});

describe("deployPlan", () => {
  const ctx = {
    repo: "/r",
    bun: "/b/bun",
    services: platformServices("darwin", 501) ?? [],
    deskPort: 5199,
  };
  const tag: Ref = { kind: "tag", name: "v0.5.0" };

  it("orders the steps, each with its commands", () => {
    const steps = deployPlan({ ...ctx, target: tag, fetch: true });
    expect(steps.map((s) => s.title)).toEqual([
      "fetch tags",
      "checkout v0.5.0 (detached)",
      "bun install --frozen-lockfile",
      "build the Desk",
      "self-check",
      "restart systems.volley.volleyd",
      "restart systems.volley.desk",
      "health-check",
    ]);
    const argv = (i: number) => steps[i]?.commands.map((c) => c.argv);
    expect(argv(0)).toEqual([["git", "-C", "/r", "fetch", "--tags", "origin"]]);
    expect(argv(1)).toEqual([["git", "-C", "/r", "checkout", "--detach", "v0.5.0"]]);
    expect(steps[2]?.commands).toEqual([
      { argv: ["/b/bun", "install", "--frozen-lockfile"], cwd: "/r" },
    ]);
    expect(steps[3]?.commands).toEqual([
      { argv: ["/b/bun", "run", "build"], cwd: "/r/packages/volley-desk" },
    ]);
    expect(argv(4)).toEqual([
      ["/b/bun", "/r/packages/volley-cli/src/cli.ts", "--version"],
      [
        "/b/bun",
        "/r/packages/volleyd/src/cli.ts",
        "validate",
        "/r/packages/volleyd/test/fixtures/example.yaml",
      ],
    ]);
    expect(argv(5)).toEqual([["launchctl", "kickstart", "-k", "gui/501/systems.volley.volleyd"]]);
    expect(argv(7)).toEqual([]);
  });

  it("stashes first when asked; a rollback neither stashes nor fetches", () => {
    const steps = deployPlan({ ...ctx, target: tag, fetch: true, stash: "volley-deploy-x" });
    expect(steps[0]?.title).toBe("stash local changes as volley-deploy-x");
    expect(steps[0]?.commands[0]?.argv).toEqual([
      "git",
      "-C",
      "/r",
      "stash",
      "push",
      "-u",
      "-m",
      "volley-deploy-x",
    ]);
    const back = deployPlan({ ...ctx, target: { kind: "branch", name: "main" }, fetch: false });
    expect(back[0]?.title).toBe("checkout main");
    expect(back[0]?.commands[0]?.argv).toEqual(["git", "-C", "/r", "checkout", "main", "--"]);
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const commit = deployPlan({ ...ctx, target: { kind: "commit", name: sha }, fetch: false });
    expect(commit[0]?.title).toBe("checkout 0123456 (detached)");
    expect(commit[0]?.commands[0]?.argv).toEqual(["git", "-C", "/r", "checkout", "--detach", sha]);
  });

  it("names the stash after the time, without characters a ref would refuse", () => {
    expect(stashName(new Date("2026-10-20T14:05:09.123Z"))).toBe(
      "volley-deploy-2026-10-20T14-05-09Z",
    );
  });
});
