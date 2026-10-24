import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { type BundleSources, makeBundle, tarArgv, travelSet } from "../src/roles/bundle";
import { fakeExec } from "./helpers/fake-exec";
import { tempDir } from "./helpers/tmp";

describe("the supervisor move's bundle (#469)", () => {
  let root: string;
  let src: BundleSources;
  const put = (path: string, text = "{}\n") => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };

  beforeEach(() => {
    root = tempDir("volleyd-bundle-");
    src = {
      volleydHome: join(root, "volleyd"),
      authDir: join(root, "auth"),
      claudeRoot: join(root, "claude"),
      stateFile: join(root, "mosquitto", "dynamic-security.json"),
    };
    const v = (p: string) => join(src.volleydHome, p);
    for (const p of [
      "config.yaml",
      "peers.json",
      "peer-codes.json",
      "claude-usage.json",
      "roles.json",
      "waves/w1/journal.jsonl",
      "waves/w1/snapshot.json",
      "waves/_system/journal.jsonl",
      "roles/m-1/handover.json",
      // Never travel:
      "cmux.json",
      "setup.json",
      "volleyd.log",
      "waves/w1/agent.log",
      "worktrees/w1/t1/README.md",
      "broker.json",
      "dynsec-admin.json",
      "roles/m-0/log.jsonl",
    ])
      put(v(p));
    for (const f of ["accounts.json", "tokens.json", "admin.json", "coordinator.json", "acl.conf"])
      put(join(src.authDir as string, f));
    put(join(src.claudeRoot, "accounts.json"));
    put(join(src.claudeRoot, "work", ".claude.json"));
    put(src.stateFile as string);
  });

  it("travels the waves, the registries and the auth dir's logins; nothing else", () => {
    const paths = travelSet(src, "m-1", false).map((f) => f.path);
    expect(paths.sort()).toEqual(
      [
        "auth/accounts.json",
        "auth/admin.json",
        "auth/coordinator.json",
        "auth/tokens.json",
        "claude/accounts.json",
        "volleyd/claude-usage.json",
        "volleyd/config.yaml",
        "volleyd/peer-codes.json",
        "volleyd/peers.json",
        "volleyd/roles.json",
        "volleyd/roles/m-1/handover.json",
        "volleyd/waves/_system/journal.jsonl",
        "volleyd/waves/w1/journal.jsonl",
        "volleyd/waves/w1/snapshot.json",
      ].sort(),
    );
    expect(paths.some((p) => /worktrees|cmux|setup\.json|\.log$|work\//.test(p))).toBe(false);
  });

  it("carries the broker's state file only with with_broker", () => {
    expect(travelSet(src, "m-1", true).map((f) => f.path)).toContain(
      "broker/dynamic-security.json",
    );
    expect(travelSet(src, "m-1", false).some((f) => f.path.startsWith("broker/"))).toBe(false);
  });

  it("stages the files with a manifest, tars them with the exact argv, and leaves the bundle 0600", async () => {
    const fake = fakeExec().on(["tar"], (argv) => {
      const r = spawnSync("tar", argv.slice(1));
      return { code: r.status ?? 1, stderr: r.stderr.toString() };
    });
    const out = join(src.volleydHome, "roles", "m-1");
    const b = await makeBundle(fake.exec, src, {
      move_id: "m-1",
      from: "studio",
      to: "box-a",
      with_broker: false,
      dir: out,
    });
    expect(fake.argvs(["tar"])).toEqual([
      tarArgv(join(out, "bundle.tgz"), join(out, "stage"), join(out, "files.txt")),
    ]);
    expect(tarArgv("/o.tgz", "/s", "/l")).toEqual([
      "tar",
      "-czf",
      "/o.tgz",
      "-C",
      "/s",
      "--files-from",
      "/l",
    ]);
    expect(statSync(b.path).mode & 0o777).toBe(0o600);
    const manifest = b.manifest;
    expect(manifest).toMatchObject({
      version: 1,
      move_id: "m-1",
      role: "supervisor",
      from: "studio",
      to: "box-a",
      with_broker: false,
    });
    const listed = readFileSync(join(out, "files.txt"), "utf-8").trim().split("\n");
    expect(listed[0]).toBe("manifest.json");
    // Each file's digest is the bundled copy's.
    const unpacked = tempDir("volleyd-bundle-x-");
    spawnSync("tar", ["-xzf", b.path, "-C", unpacked]);
    for (const f of manifest.files) {
      const staged = readFileSync(join(unpacked, f.path));
      expect(createHash("sha256").update(staged).digest("hex"), f.path).toBe(f.sha256);
    }
    // The tarball holds exactly the manifest and the travel set.
    const list = spawnSync("tar", ["-tzf", b.path]).stdout.toString().trim().split("\n");
    expect(list.sort()).toEqual(["manifest.json", ...manifest.files.map((f) => f.path)].sort());
    expect(existsSync(join(out, "stage"))).toBe(false);
  });
});
