import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { peerFence } from "../../src/deploy/fence";
import {
  RECORD_LOCK_ARGV,
  RESTART_PEER_ARGV,
  deployPeer,
  peerPlan,
  sshCommand,
} from "../../src/deploy/peers";
import { fakePeerHost } from "./fake-peer-host";

const run = async (h: ReturnType<typeof fakePeerHost>, tag = "v0.5.0") => {
  const lines: string[] = [];
  const r = await deployPeer(h.peer, tag, { remote: h.remote, report: (l) => lines.push(l) });
  return { r, lines };
};

describe("deployPeer", () => {
  it("fetches, checks the tag out, installs and records the lock, restarts the service, runs the doctor", async () => {
    const h = fakePeerHost("athena", { head: { tag: "v0.4.0" } });
    const d = h.peer.volleyDir;
    const { r, lines } = await run(h);
    expect(h.lines()).toEqual([
      `git -C ${d} status --porcelain`,
      `git -C ${d} rev-parse --abbrev-ref HEAD`,
      `git -C ${d} describe --tags --exact-match HEAD`,
      `git -C ${d} fetch --tags origin`,
      `git -C ${d} checkout --detach v0.5.0`,
      "bun install --frozen-lockfile",
      RECORD_LOCK_ARGV.join(" "),
      RESTART_PEER_ARGV.join(" "),
      `bun ${join(d, "packages", "volley-cli", "src", "cli.ts")} peer doctor --json`,
    ]);
    expect(h.ran[5]?.cwd).toBe(d);
    expect(h.ran[6]?.cwd).toBe(d);
    expect(h.version()).toBe("0.5.0");
    // The doctor's own verdict on the deploy's install.
    expect(h.synced()).toBe("synced");
    expect(r).toMatchObject({ name: "athena", ok: true, eligible: true, from: "v0.4.0" });
    expect(r.line).toBe("athena: v0.5.0 ✓ eligible");
    expect(lines).toEqual([
      "ok      athena: fetch tags",
      "ok      athena: checkout v0.5.0 (detached)",
      "ok      athena: bun install --frozen-lockfile",
      "ok      athena: restart volley peer run",
      "ok      athena: volley peer doctor",
    ]);
  });

  it("a failed install checks the previous ref out again, reinstalls and restarts", async () => {
    const h = fakePeerHost("hermes", { head: { tag: "v0.4.0" } });
    h.fail("bun install --frozen-lockfile", {
      atVersion: "0.5.0",
      stderr: "error: lockfile had changes, but lockfile is frozen",
    });
    const d = h.peer.volleyDir;
    const { r } = await run(h);
    expect(h.lines().slice(5)).toEqual([
      "bun install --frozen-lockfile",
      `git -C ${d} checkout --detach v0.4.0`,
      "bun install --frozen-lockfile",
      RECORD_LOCK_ARGV.join(" "),
      RESTART_PEER_ARGV.join(" "),
    ]);
    expect(h.version()).toBe("0.4.0");
    expect(h.synced()).toBe("synced");
    expect(r).toMatchObject({ ok: false, eligible: false, rolledBack: true });
    expect(r.line).toBe(
      "hermes: failed at install (error: lockfile had changes, but lockfile is frozen); rolled back to v0.4.0",
    );
  });

  it("a branch checkout rolls back to its branch", async () => {
    const h = fakePeerHost("hermes", { head: { branch: "main" } });
    h.fail(
      `bun ${join(h.peer.volleyDir, "packages", "volley-cli", "src", "cli.ts")} peer doctor --json`,
    );
    const { r } = await run(h);
    expect(h.lines()).toContain(`git -C ${h.peer.volleyDir} checkout main --`);
    expect(h.state.head).toEqual({ branch: "main" });
    expect(r.line).toMatch(/^hermes: failed at doctor \(.*\); rolled back to main$/);
  });

  it("a failed fetch or a dirty checkout changes nothing", async () => {
    const h = fakePeerHost("athena", { head: { tag: "v0.4.0" } });
    h.fail(`git -C ${h.peer.volleyDir} fetch --tags origin`, { stderr: "ssh: connect timed out" });
    const { r } = await run(h);
    expect(r.line).toBe("athena: failed at fetch (ssh: connect timed out); nothing changed");
    expect(h.version()).toBe("0.4.0");
    const dirty = fakePeerHost("zeta", { head: { tag: "v0.4.0" }, dirty: " M bun.lock\n" });
    const d = await run(dirty);
    expect(d.r.line).toBe(
      `zeta: failed at status (local changes in ${dirty.peer.volleyDir}: bun.lock (modified)); nothing changed`,
    );
    expect(dirty.lines()).toEqual([`git -C ${dirty.peer.volleyDir} status --porcelain`]);
  });

  it("a doctor that names another version fails the machine and rolls it back", async () => {
    // The tag's checkout runs an older volley (its `volley` resolves elsewhere, say).
    const h = fakePeerHost("athena", { head: { tag: "v0.4.0" }, doctorVersion: "0.4.0" });
    const { r } = await run(h);
    expect(r.line).toBe(
      "athena: failed at doctor (volley peer doctor reports volley 0.4.0, not 0.5.0); rolled back to v0.4.0",
    );
    expect(h.version()).toBe("0.4.0");
  });

  it("an upgraded machine with a failing check is reported, not rolled back", async () => {
    const h = fakePeerHost("athena", { head: { tag: "v0.4.0" }, claudeSignedIn: false });
    const { r } = await run(h);
    expect(h.version()).toBe("0.5.0");
    expect(r).toMatchObject({ ok: true, eligible: false });
    expect(r.line).toBe(
      "athena: v0.5.0 ✗ not eligible: claude.signin (Claude Code is not signed in)",
    );
  });
});

describe("peerFence", () => {
  const peer = { name: "athena", target: "dev@athena", volleyDir: "/path/to/volley" };
  const g = (...a: string[]) => ["git", "-C", "/path/to/volley", ...a];
  const fence = peerFence(peer, { tag: "v0.5.0", from: { kind: "branch", name: "main" } });
  const doctor = [
    "bun",
    "/path/to/volley/packages/volley-cli/src/cli.ts",
    "peer",
    "doctor",
    "--json",
  ];

  it("allows exactly the deploy's remote commands", () => {
    for (const [argv, cwd] of [
      [g("status", "--porcelain")],
      [g("rev-parse", "--abbrev-ref", "HEAD")],
      [g("describe", "--tags", "--exact-match", "HEAD")],
      [g("rev-parse", "HEAD")],
      [g("fetch", "--tags", "origin")],
      [g("checkout", "--detach", "v0.5.0")],
      [g("checkout", "main", "--")],
      [["bun", "install", "--frozen-lockfile"], "/path/to/volley"],
      [[...RECORD_LOCK_ARGV], "/path/to/volley"],
      [[...RESTART_PEER_ARGV]],
      [doctor, "/path/to/volley"],
    ] as [string[], string?][]) {
      expect(
        () => fence({ argv, ...(cwd !== undefined ? { cwd } : {}) }),
        argv.join(" "),
      ).not.toThrow();
    }
  });

  it("denies anything else", () => {
    for (const [argv, cwd] of [
      [g("checkout", "release/x", "--")],
      [g("checkout", "--detach", "v0.4.9")],
      [g("reset", "--hard", "v0.5.0")],
      [["git", "-C", "/elsewhere", "status", "--porcelain"]],
      [["rm", "-rf", "/path/to/volley"]],
      [["bun", "install", "--frozen-lockfile"], "/elsewhere"],
      [["bun", "install"], "/path/to/volley"],
      [["sh", "-c", "rm -rf ~", "sh"], "/path/to/volley"],
      [[...doctor, "--fix", "--yes"], "/path/to/volley"],
    ] as [string[], string?][]) {
      expect(() => fence({ argv, ...(cwd !== undefined ? { cwd } : {}) }), argv.join(" ")).toThrow(
        /volley deploy does not run/,
      );
    }
    // A rollback to a commit is that commit only.
    const sha = "a".repeat(40);
    const at = peerFence(peer, { tag: "v0.5.0", from: { kind: "commit", name: sha } });
    expect(() => at({ argv: g("checkout", "--detach", sha) })).not.toThrow();
    expect(() => at({ argv: g("checkout", "--detach", "b".repeat(40)) })).toThrow();
  });
});

describe("sshCommand", () => {
  it("sends one quoted command on stdin to a non-interactive bash over ssh", () => {
    const s = sshCommand("dev@athena", {
      argv: ["bun", "install", "--frozen-lockfile"],
      cwd: "/path/to/my volley",
    });
    expect(s.argv).toEqual([
      "ssh",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "dev@athena",
      "bash",
      "-s",
    ]);
    expect(s.input).toBe("cd '/path/to/my volley' && bun install --frozen-lockfile\n");
    expect(sshCommand("dev@athena", { argv: [...RECORD_LOCK_ARGV] }).input).toContain("sh -c '");
  });
});

describe("peerPlan", () => {
  it("names each step and its commands, for the dry run", () => {
    const peer = { name: "athena", target: "dev@athena", volleyDir: "/path/to/volley" };
    const steps = peerPlan(peer, { kind: "tag", name: "v0.5.0" }, { fetch: true, doctor: true });
    expect(steps.map((s) => s.id)).toEqual(["fetch", "checkout", "install", "restart", "doctor"]);
    expect(steps[2]?.commands).toEqual([
      { argv: ["bun", "install", "--frozen-lockfile"], cwd: "/path/to/volley" },
      { argv: [...RECORD_LOCK_ARGV], cwd: "/path/to/volley" },
    ]);
    const back = peerPlan(peer, { kind: "branch", name: "main" }, { fetch: false, doctor: false });
    expect(back.map((s) => s.id)).toEqual(["checkout", "install", "restart"]);
  });
});
