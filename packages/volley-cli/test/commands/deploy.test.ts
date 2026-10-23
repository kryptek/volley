import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type DeployDeps, deploy } from "../../src/commands/deploy";
import { makeBufferIO } from "../../src/io";
import { fakePeerHost } from "../deploy/fake-peer-host";
import { fakeRepo } from "../deploy/fake-repo";
import { tempDir } from "../helpers/tmp";

const plist = (bun: string, repo: string) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>systems.volley.volleyd</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bun}</string>
    <string>${repo}/packages/volleyd/src/cli.ts</string>
    <string>daemon</string>
  </array>
</dict>
</plist>
`;

type FakePeer = ReturnType<typeof fakePeerHost>;

/** Pair `peers` with the supervisor whose volleyd home is `vd` (peers.json + config.yaml). */
function pair(vd: string, peers: FakePeer[]) {
  mkdirSync(vd, { recursive: true });
  writeFileSync(
    join(vd, "peers.json"),
    JSON.stringify({
      peers: Object.fromEntries(
        peers.map((p) => [
          p.peer.name,
          { target: p.peer.target, joined_at: "2026-10-01T00:00:00Z" },
        ]),
      ),
    }),
  );
  writeFileSync(
    join(vd, "config.yaml"),
    `hosts:\n${peers
      .map(
        (p) =>
          `  ${p.peer.name}:\n    target: ${p.peer.target}\n    volley_dir: ${p.peer.volleyDir}\n`,
      )
      .join("")}`,
  );
}

function machine(
  o: Parameters<typeof fakeRepo>[0] & {
    installed?: boolean;
    platform?: NodeJS.Platform;
    peers?: FakePeer[];
  },
) {
  const f = fakeRepo({ tags: ["v0.3.2", "v0.4.0", "v0.5.0"], ...o });
  const home = tempDir("volley-deploy-home-");
  if (o.installed !== false) {
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(
      join(home, "Library", "LaunchAgents", "systems.volley.volleyd.plist"),
      plist(f.bun, f.repo),
    );
  }
  const health = { desk: [] as (string | null)[], volleyd: [] as (string | null)[], deskBase: "" };
  const deps: DeployDeps = {
    exec: f.exec,
    platform: o.platform ?? "darwin",
    uid: 501,
    home,
    runningRepo: null,
    bun: "/running/bun",
    now: () => new Date("2026-10-20T14:05:09.123Z"),
    deskHealthy: async (base) => {
      health.deskBase = base;
      return health.desk.shift() ?? null;
    },
    volleydHealthy: async () => health.volleyd.shift() ?? null,
    remote: async (peer, c) => {
      const p = o.peers?.find((x) => x.peer.name === peer.name);
      if (p === undefined || p.peer.target !== peer.target) throw new Error(`no peer ${peer.name}`);
      return p.remote(c);
    },
  };
  if (o.peers !== undefined) pair(join(home, "vd"), o.peers);
  const io = makeBufferIO();
  const run = (argv: string[], env: Record<string, string | undefined> = {}) =>
    deploy({ argv, env: { VOLLEYD_HOME: join(home, "vd"), ...env }, io, deps });
  return { f, home, deps, io, run, health };
}

describe("volley deploy --dry-run", () => {
  it("prints the ordered steps and runs only the read-only commands", async () => {
    const m = machine({ head: { tag: "v0.4.0" } });
    expect(await m.run(["v0.5.0", "--dry-run"])).toBe(0);
    const out = m.io.readStdout();
    const titles = [
      "fetch tags",
      "checkout v0.5.0 (detached)",
      "bun install --frozen-lockfile",
      "build the Desk",
      "self-check",
      "restart systems.volley.volleyd",
      "restart systems.volley.desk",
      "health-check",
    ];
    let at = -1;
    for (const t of titles) {
      const i = out.indexOf(t, at + 1);
      expect(i, t).toBeGreaterThan(at);
      at = i;
    }
    expect(out).toContain(`services checkout: ${m.f.repo}`);
    expect(out).toContain("current: v0.4.0");
    expect(out).toContain("target: v0.5.0");
    expect(out).toContain(`git -C ${m.f.repo} fetch --tags origin`);
    expect(out).toContain("launchctl kickstart -k gui/501/systems.volley.volleyd");
    expect(out).toContain("dry run: nothing changed");
    // A dry run never fetches.
    expect(m.f.lines()).toEqual([
      `git -C ${m.f.repo} status --porcelain`,
      `git -C ${m.f.repo} rev-parse --abbrev-ref HEAD`,
      `git -C ${m.f.repo} describe --tags --exact-match HEAD`,
      `git -C ${m.f.repo} tag --list v*`,
    ]);
  });

  it("--latest picks the newest tag; a bare version gets its v", async () => {
    const m = machine({ head: { tag: "v0.4.0" } });
    expect(await m.run(["--latest", "--dry-run"])).toBe(0);
    expect(m.io.readStdout()).toContain("target: v0.5.0");
    const n = machine({ head: { tag: "v0.4.0" } });
    expect(await n.run(["0.3.2", "--dry-run"])).toBe(0);
    expect(n.io.readStdout()).toContain("target: v0.3.2");
  });

  it("says a tag not fetched yet may come with the fetch", async () => {
    const m = machine({ head: { tag: "v0.4.0" } });
    expect(await m.run(["v0.6.0", "--dry-run"])).toBe(0);
    expect(m.io.readStdout()).toContain(
      "target: v0.6.0 (not in the checkout yet: the fetch must bring it)",
    );
  });

  it("refuses a dirty checkout with exit 3, listing the paths", async () => {
    const m = machine({
      head: { tag: "v0.4.0" },
      dirty: " M packages/volleyd/src/daemon.ts\n?? notes.txt\n",
    });
    expect(await m.run(["v0.5.0", "--dry-run"])).toBe(3);
    const err = m.io.readStderr();
    expect(err).toContain("packages/volleyd/src/daemon.ts (modified)");
    expect(err).toContain("notes.txt (untracked)");
    expect(err).toContain("--force-clean");
  });

  it("--force-clean --dry-run says it would stash, and does not", async () => {
    const m = machine({ head: { tag: "v0.4.0" }, dirty: " M a.ts\n" });
    expect(await m.run(["v0.5.0", "--dry-run", "--force-clean"])).toBe(0);
    expect(m.io.readStdout()).toContain(
      "stash local changes as volley-deploy-2026-10-20T14-05-09Z",
    );
    expect(m.f.state.stashes).toEqual([]);
    expect(m.f.lines().some((l) => l.includes(" stash "))).toBe(false);
  });

  it("names a branch checkout as current", async () => {
    const m = machine({ head: { branch: "main" } });
    expect(await m.run(["v0.5.0", "--dry-run"])).toBe(0);
    expect(m.io.readStdout()).toContain("current: main (branch)");
  });

  it("usage errors exit 2", async () => {
    const m = machine({ head: { tag: "v0.4.0" } });
    expect(await m.run([])).toBe(2);
    expect(await m.run(["v0.5.0", "--latest"])).toBe(2);
    expect(await m.run(["v0.5.0", "v0.4.0"])).toBe(2);
    expect(await m.run(["--x"])).toBe(2);
    expect(await m.run(["-x"])).toBe(2);
    expect(await m.run(["v-1"])).toBe(2);
    expect(await m.run(["v0.5.0", "--desk-port", "http"])).toBe(2);
    expect(await m.run(["v0.5.0", "--desk-port", "0"])).toBe(2);
    expect(m.f.ran).toEqual([]);
    const noLock = tempDir("volley-deploy-nolock-");
    expect(await m.run(["v0.5.0", "--repo", noLock])).toBe(2);
    expect(m.io.readStderr()).toContain("bun.lock");
    expect(await m.run(["--help"])).toBe(0);
    expect(m.io.readStdout()).toContain("Usage: volley deploy");
  });

  it("exits 2 where no service manager is known", async () => {
    const m = machine({ head: { tag: "v0.4.0" }, platform: "win32" });
    expect(await m.run(["v0.5.0"])).toBe(2);
    expect(m.io.readStderr()).toContain("no service manager known here");
  });

  it("falls back to the running checkout when no service is installed, and says so", async () => {
    const m = machine({ head: { tag: "v0.4.0" }, installed: false });
    m.deps.runningRepo = m.f.repo;
    expect(await m.run(["v0.5.0", "--dry-run"])).toBe(0);
    expect(m.io.readStdout()).toContain("no volleyd service is installed");
    const n = machine({ head: { tag: "v0.4.0" }, installed: false });
    expect(await n.run(["v0.5.0", "--dry-run"])).toBe(2);
  });

  it("deploys into another checkout only when --repo names it", async () => {
    const m = machine({ head: { tag: "v0.4.0" } });
    const other = fakeRepo({ head: { tag: "v0.4.0" }, tags: ["v0.5.0"] });
    m.deps.exec = other.exec;
    expect(await m.run(["v0.5.0", "--dry-run", "--repo", other.repo])).toBe(0);
    expect(m.io.readStdout()).toContain(`services checkout: ${other.repo} (--repo`);
    expect(m.io.readStdout()).toContain(`the services run from ${m.f.repo}`);
  });
});

describe("volley deploy", () => {
  it("deploys: one line per step, then the summary", async () => {
    const m = machine({ head: { tag: "v0.4.0" } });
    expect(await m.run(["v0.5.0"])).toBe(0);
    const lines = m.io.readStdout().trim().split("\n");
    expect(lines).toContain("ok      checkout v0.5.0 (detached)");
    expect(lines).toContain("ok      health-check");
    expect(lines.at(-1)).toBe(
      "deployed v0.5.0 (was v0.4.0); waves continue (volleyd reconciles on start)",
    );
    expect(m.health.deskBase).toBe("http://127.0.0.1:5199");
    expect(m.f.versionAt()).toBe("0.5.0");
  });

  it("uses the Desk port setup recorded, or --desk-port", async () => {
    const m = machine({ head: { tag: "v0.4.0" } });
    mkdirSync(join(m.home, "vd"), { recursive: true });
    writeFileSync(
      join(m.home, "vd", "setup.json"),
      JSON.stringify({
        layout: "brew-arm64",
        config: "/c",
        state_file: "/s",
        auth_dir: "/a",
        desk_port: 5300,
      }),
    );
    expect(await m.run(["v0.5.0"])).toBe(0);
    expect(m.health.deskBase).toBe("http://127.0.0.1:5300");
    const n = machine({ head: { tag: "v0.4.0" } });
    expect(await n.run(["v0.5.0", "--desk-port", "6000"])).toBe(0);
    expect(n.health.deskBase).toBe("http://127.0.0.1:6000");
  });

  it("exits 1 on a failed health check, saying what failed and that it rolled back", async () => {
    const m = machine({ head: { tag: "v0.4.0" } });
    m.health.volleyd.push("volleyd has not re-registered since the restart");
    expect(await m.run(["v0.5.0"])).toBe(1);
    expect(m.io.readStdout()).toContain("FAILED  health-check: volleyd has not re-registered");
    expect(m.io.readStderr().trim().split("\n").at(-1)).toBe(
      "volley deploy: v0.5.0 failed at health-check (volleyd has not re-registered since the restart); rolled back to v0.4.0",
    );
    expect(m.f.versionAt()).toBe("0.4.0");
  });

  it("prints the by-hand commands when the rollback fails too", async () => {
    const m = machine({ head: { tag: "v0.4.0" } });
    m.f.fail("launchctl kickstart -k gui/501/systems.volley.desk");
    expect(await m.run(["v0.5.0"])).toBe(1);
    const err = m.io.readStderr();
    expect(err).toContain("the rollback to v0.4.0 failed too at restart systems.volley.desk");
    expect(err).toContain(`  git -C ${m.f.repo} checkout --detach v0.4.0`);
    expect(err).toContain("  launchctl kickstart -k gui/501/systems.volley.desk");
  });

  it("takes a non-release tag on HEAD as no tag, so the rollback goes back to the branch", async () => {
    const m = machine({ head: { tag: "smoke-ok", branch: "main" } });
    m.health.volleyd.push("volleyd's status is failed");
    expect(await m.run(["v0.5.0"])).toBe(1);
    expect(m.io.readStderr().trim().split("\n").at(-1)).toMatch(/rolled back to main$/);
    expect(m.f.lines()).toContain(`git -C ${m.f.repo} checkout main --`);
  });

  it("prefers the branch over a release tag on HEAD, so the rollback keeps the branch", async () => {
    const m = machine({ head: { tag: "v0.4.0", branch: "main" } });
    m.health.volleyd.push("volleyd's status is failed");
    expect(await m.run(["v0.5.0"])).toBe(1);
    expect(m.io.readStdout()).toContain("current: main (branch)");
    expect(m.io.readStderr().trim().split("\n").at(-1)).toMatch(/rolled back to main$/);
    expect(m.f.lines()).toContain(`git -C ${m.f.repo} checkout main --`);
    expect(m.f.state.head).toEqual({ branch: "main" });
  });

  it("passes over a branch the fence would refuse to check out again, so the rollback uses the tag", async () => {
    const m = machine({ head: { tag: "v0.4.0", branch: "fix+x" } });
    m.health.volleyd.push("volleyd's status is failed");
    expect(await m.run(["v0.5.0"])).toBe(1);
    expect(m.io.readStderr().trim().split("\n").at(-1)).toMatch(/rolled back to v0.4.0$/);
    expect(m.f.lines()).toContain(`git -C ${m.f.repo} checkout --detach v0.4.0`);
  });

  it("--force-clean stashes first and names the stash", async () => {
    const m = machine({ head: { tag: "v0.4.0" }, dirty: " M a.ts\n" });
    expect(await m.run(["--latest", "--force-clean"])).toBe(0);
    expect(m.f.state.stashes).toEqual(["volley-deploy-2026-10-20T14-05-09Z"]);
    expect(m.io.readStdout()).toContain(
      "stashed the local changes as volley-deploy-2026-10-20T14-05-09Z (git stash list shows it)",
    );
  });

  it("restarts the systemd user units on Linux", async () => {
    const m = machine({ head: { tag: "v0.4.0" } });
    const seen: string[] = [];
    const exec = m.deps.exec;
    m.deps.exec = (argv, o) => {
      seen.push(argv.join(" "));
      return exec(argv, o);
    };
    m.deps.platform = "linux";
    // Linux reads the systemd unit, which this machine lacks: the running checkout is used.
    m.deps.runningRepo = m.f.repo;
    m.deps.bun = m.f.bun;
    expect(await m.run(["v0.5.0"])).toBe(0);
    expect(seen).toContain("systemctl --user restart volleyd.service");
  });
});

describe("volley deploy: paired machines", () => {
  const twoPeers = () => [
    fakePeerHost("box-a", { head: { tag: "v0.4.0" } }),
    fakePeerHost("box-b", { head: { tag: "v0.4.0" } }),
  ];

  it("after the supervisor, takes every paired machine to the tag with one health line each", async () => {
    const peers = twoPeers();
    const m = machine({ head: { tag: "v0.4.0" }, peers });
    expect(await m.run(["v0.5.0"])).toBe(0);
    const out = m.io.readStdout();
    // The supervisor first: its restarts precede any peer command.
    expect(out.indexOf("ok      health-check")).toBeLessThan(out.indexOf("box-a: fetch tags"));
    for (const p of peers) {
      expect(p.version()).toBe("0.5.0");
      expect(p.synced()).toBe("synced");
      expect(p.state.restarts).toBe(1);
      expect(p.lines().at(-1)).toContain("peer doctor --json");
    }
    expect(out).toContain("box-a: v0.5.0 ✓ eligible\n");
    expect(out).toContain("box-b: v0.5.0 ✓ eligible\n");
    expect(m.io.readStderr()).toBe("");
  });

  it("a machine that fails rolls back alone: the others and the supervisor stay on the tag, exit 1", async () => {
    const peers = twoPeers();
    const [boxA, boxB] = peers as [FakePeer, FakePeer];
    boxB.fail("bun install --frozen-lockfile", { atVersion: "0.5.0", stderr: "error: no space" });
    const m = machine({ head: { tag: "v0.4.0" }, peers });
    expect(await m.run(["v0.5.0"])).toBe(1);
    expect(m.f.versionAt()).toBe("0.5.0");
    expect(boxA.version()).toBe("0.5.0");
    expect(boxB.version()).toBe("0.4.0");
    expect(boxB.state.restarts).toBe(1);
    const out = m.io.readStdout();
    expect(out).toContain("box-a: v0.5.0 ✓ eligible\n");
    expect(out).toContain("box-b: failed at install (error: no space); rolled back to v0.4.0\n");
    expect(m.io.readStderr()).toContain("box-b");
  });

  it("a failed supervisor deploy touches no paired machine", async () => {
    const peers = twoPeers();
    const m = machine({ head: { tag: "v0.4.0" }, peers });
    m.health.volleyd.push("volleyd has not re-registered since the restart");
    expect(await m.run(["v0.5.0"])).toBe(1);
    for (const p of peers) expect(p.ran).toEqual([]);
  });

  it("--dry-run prints each machine's plan and runs nothing there", async () => {
    const peers = twoPeers();
    const m = machine({ head: { tag: "v0.4.0" }, peers });
    expect(await m.run(["v0.5.0", "--dry-run"])).toBe(0);
    const out = m.io.readStdout();
    for (const p of peers) {
      expect(out).toContain(`${p.peer.name} (${p.peer.target}, ${p.peer.volleyDir}):`);
      expect(out).toContain(`git -C ${p.peer.volleyDir} checkout --detach v0.5.0`);
      expect(p.ran).toEqual([]);
    }
    expect(out).toContain("volley peer doctor");
    expect(out.trim().split("\n").at(-1)).toBe("dry run: nothing changed");
  });

  it("--skip-peers deploys the supervisor only", async () => {
    const peers = twoPeers();
    const m = machine({ head: { tag: "v0.4.0" }, peers });
    expect(await m.run(["v0.5.0", "--skip-peers"])).toBe(0);
    expect(m.f.versionAt()).toBe("0.5.0");
    for (const p of peers) expect(p.ran).toEqual([]);
  });

  it("--only <machine> deploys that machine alone, once the supervisor runs the tag", async () => {
    const peers = twoPeers();
    const [boxA, boxB] = peers as [FakePeer, FakePeer];
    const m = machine({ head: { tag: "v0.5.0" }, peers });
    expect(await m.run(["v0.5.0", "--only", "box-b"])).toBe(0);
    expect(m.f.lines().some((l) => l.includes("kickstart"))).toBe(false);
    expect(boxA.ran).toEqual([]);
    expect(boxB.version()).toBe("0.5.0");
    expect(m.io.readStdout()).toContain("box-b: v0.5.0 ✓ eligible\n");
    // Not a paired machine, or the supervisor elsewhere: usage errors, nothing runs.
    const n = machine({ head: { tag: "v0.5.0" }, peers: twoPeers() });
    expect(await n.run(["v0.5.0", "--only", "zeus"])).toBe(2);
    expect(n.io.readStderr()).toContain("zeus");
    const o = machine({ head: { tag: "v0.4.0" }, peers: twoPeers() });
    expect(await o.run(["v0.5.0", "--only", "box-b"])).toBe(2);
    expect(o.io.readStderr()).toContain("the supervisor runs v0.4.0");
    expect(await o.run(["v0.5.0", "--only", "box-b", "--skip-peers"])).toBe(2);
  });

  it("a paired machine the deploy cannot reach from the records is named and fails the deploy", async () => {
    const peers = twoPeers();
    const m = machine({ head: { tag: "v0.4.0" }, peers });
    const vd = join(m.home, "vd");
    writeFileSync(
      join(vd, "peers.json"),
      JSON.stringify({
        peers: {
          "box-a": { target: "dev@box-a", joined_at: "x" },
          "box-b": { target: "dev@box-b", joined_at: "x" },
          zeus: { target: "dev@zeus", joined_at: "x" },
        },
      }),
    );
    expect(await m.run(["v0.5.0"])).toBe(1);
    expect(m.io.readStdout()).toContain("zeus: skipped (no hosts.zeus in config.yaml)\n");
    expect((peers[0] as FakePeer).version()).toBe("0.5.0");
  });
});
