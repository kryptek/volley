import { spawnSync } from "node:child_process";
import { createHash, scryptSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { type ReceiveDeps, type ReceiveExec, runReceive } from "../../src/commands/role-receive";
import { EXIT } from "../../src/exit-codes";
import { makeBufferIO } from "../../src/io";
import { tempDir } from "../helpers/tmp";

const SECRET = "ROTATED-SECRET-0123456789";
const MOVE = "mv-20261024-a1";

let root: string;
let home: string;
let vhome: string;
let authDir: string;
let claudeDir: string;
let env: Record<string, string>;

interface Call {
  argv: string[];
  env?: Record<string, string | undefined>;
}

function fakeExec(fail: (argv: string[]) => boolean = () => false) {
  const calls: Call[] = [];
  const exec: ReceiveExec = async (argv, opts = {}) => {
    calls.push({ argv, ...(opts.env !== undefined ? { env: opts.env } : {}) });
    if (argv[0] === "tar") {
      const r = spawnSync(argv[0], argv.slice(1), { encoding: "utf-8" });
      return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
    }
    if (fail(argv)) return { code: 1, stdout: "", stderr: `${argv.join(" ")}: no` };
    if (argv.includes("rotate")) {
      return {
        code: 0,
        stdout: `${JSON.stringify({ username: "volleyd", password: SECRET })}\n`,
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

function deps(exec: ReceiveExec, over: Partial<ReceiveDeps> = {}): ReceiveDeps {
  return {
    exec,
    home,
    env,
    platform: "linux",
    uid: () => 501,
    now: () => new Date("2026-10-24T12:00:00.000Z"),
    volleyArgv: ["/path/to/bun", "/path/to/volley/packages/volley-cli/src/cli.ts"],
    bun: "/path/to/bun",
    volleyDir: "/path/to/volley",
    ...over,
  };
}

/** The bundle's staged files, by manifest path. */
const STAGED: Record<string, string> = {
  "volleyd/config.yaml":
    "# owner's config\nfleet:\n  local_name: old-box\nhosts:\n  box-a:\n    target: dev@box-a\n    volley_dir: /path/to/volley\n  box-b:\n    target: dev@box-b\n    volley_dir: /path/to/volley\n",
  "volleyd/waves/w1/journal.jsonl": '{"seq":1}\n',
  "volleyd/peers.json": '{"peers":{"box-a":{"target":"dev@box-a","joined_at":"x"}}}\n',
  "volleyd/peer-codes.json": '{"codes":[]}\n',
  "volleyd/roles.json": '{"version":1}\n',
  [`volleyd/roles/${MOVE}/handover.json`]: JSON.stringify({
    move_id: MOVE,
    from: "old-box",
    to: "box-a",
  }),
  "auth/accounts.json": '{"accounts":[]}\n',
  "auth/tokens.json": '{"tokens":[]}\n',
  "auth/admin.json": '{"username":"dynsec-admin","password":"admin-pw"}\n',
  "auth/coordinator.json": '{"username":"coordinator","password":"coord-pw"}\n',
  "claude/accounts.json": '{"accounts":{}}\n',
};

function bundle(
  over: {
    manifest?: Record<string, unknown>;
    tamper?: string;
    files?: Record<string, string>;
  } = {},
): string {
  const stage = join(root, "stage");
  const files = over.files ?? STAGED;
  mkdirSync(stage, { recursive: true });
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(stage, p)), { recursive: true });
    writeFileSync(join(stage, p), text);
  }
  const manifest = {
    version: 1,
    move_id: MOVE,
    role: "supervisor",
    from: "old-box",
    to: "box-a",
    with_broker: false,
    files: Object.entries(files).map(([path, text]) => ({
      path,
      sha256: createHash("sha256").update(text).digest("hex"),
    })),
    ...over.manifest,
  };
  writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest));
  if (over.tamper !== undefined) writeFileSync(join(stage, over.tamper), "tampered");
  const out = join(root, "bundle.tgz");
  const r = spawnSync("tar", ["-czf", out, "-C", stage, "manifest.json", ...Object.keys(files)]);
  expect(r.status).toBe(0);
  return out;
}

const PEER = {
  name: "box-a",
  host: "dev@old-box",
  target: "dev@box-a",
  namespace: "default",
  broker: { host: "127.0.0.1", port: 1883 },
  remote_port: 21883,
  username: "box-a",
  password: "peer-pw",
  tunnel: "ssh",
  joined_at: "2026-10-19T09:00:00.000Z",
};

beforeEach(() => {
  root = tempDir("volley-receive-test-");
  home = join(root, "home");
  vhome = join(home, ".volley", "volleyd");
  authDir = join(home, "auth");
  claudeDir = join(home, ".volley", "claude");
  env = { HOME: home, VOLLEYD_HOME: vhome, VOLLEY_AUTH_DIR: authDir, VOLLEY_CLAUDE_DIR: claudeDir };
  mkdirSync(join(home, ".volley"), { recursive: true });
  writeFileSync(join(home, ".volley", "peer.json"), JSON.stringify(PEER), { mode: 0o600 });
  // The peer service `volley peer join` installed (systemd here, launchd on a Mac).
  for (const unit of [
    join(home, ".config", "systemd", "user", "volley-peer.service"),
    join(home, "Library", "LaunchAgents", "systems.volley.peer.plist"),
  ]) {
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, "unit\n");
  }
});

async function receive(argv: string[], d: ReceiveDeps) {
  const io = makeBufferIO();
  const code = await runReceive({ argv, env, io }, d);
  return { code, stdout: io.readStdout(), stderr: io.readStderr() };
}

/** Every file under `dir`, relative, with its content. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[p.slice(dir.length + 1)] = readFileSync(p, "utf-8");
    }
  };
  walk(dir);
  return out;
}

const mode = (p: string) => statSync(p).mode & 0o777;

describe("volley role receive supervisor", () => {
  it("restores the bundle, rewrites config.yaml, rotates volleyd, installs the unit, prints the code last", async () => {
    // A config of its own already here: kept under replaced/.
    mkdirSync(vhome, { recursive: true });
    writeFileSync(join(vhome, "config.yaml"), "mine: true\n");
    const f = fakeExec();
    const r = await receive(
      [
        "supervisor",
        bundle(),
        "--from",
        "old-box",
        "--local-terminal",
        "tmux",
        "--local-agents",
        "never",
      ],
      deps(f.exec),
    );
    expect(r.stderr).toBe("");
    expect(r.code).toBe(EXIT.OK);

    // Restored.
    expect(readFileSync(join(vhome, "waves", "w1", "journal.jsonl"), "utf-8")).toBe('{"seq":1}\n');
    expect(readFileSync(join(vhome, "peers.json"), "utf-8")).toContain("box-a");
    expect(readFileSync(join(vhome, "roles.json"), "utf-8")).toContain("version");
    expect(readFileSync(join(authDir, "accounts.json"), "utf-8")).toContain("accounts");
    expect(readFileSync(join(authDir, "admin.json"), "utf-8")).toContain("dynsec-admin");
    expect(readFileSync(join(claudeDir, "accounts.json"), "utf-8")).toContain("accounts");
    expect(mode(join(authDir, "admin.json"))).toBe(0o600);
    expect(
      readFileSync(join(vhome, "roles", MOVE, "replaced", "volleyd", "config.yaml"), "utf-8"),
    ).toBe("mine: true\n");

    // config.yaml: this machine is the supervisor's own now; the owner's comment stays.
    const text = readFileSync(join(vhome, "config.yaml"), "utf-8");
    expect(text).toContain("# owner's config");
    const cfg = parse(text);
    expect(cfg.hosts["box-a"]).toBeUndefined();
    expect(cfg.hosts["box-b"].target).toBe("dev@box-b");
    expect(cfg.fleet).toEqual({
      local_name: "box-a",
      local_terminal: "tmux",
      local_agents: "never",
    });

    // peer.json: no heartbeat of its own, the tunnel kept; the peer service restarted.
    const peer = JSON.parse(readFileSync(join(home, ".volley", "peer.json"), "utf-8"));
    expect(peer).toEqual({ ...PEER, heartbeat: false });
    expect(mode(join(home, ".volley", "peer.json"))).toBe(0o600);
    const argvs = f.calls.map((c) => c.argv.join(" "));
    expect(argvs).toContain("systemctl --user restart volley-peer.service");
    // Rotated through the tunnel before the peer restart drops it.
    expect(argvs.indexOf("systemctl --user restart volley-peer.service")).toBeGreaterThan(
      argvs.findIndex((a) => a.includes("rotate")),
    );

    // handover.json learns how this machine reaches the old one.
    const handover = JSON.parse(readFileSync(join(vhome, "roles", MOVE, "handover.json"), "utf-8"));
    expect(handover).toMatchObject({ move_id: MOVE, old_target: "dev@old-box" });

    // The rotation: with the restored admin login's dir, through the tunnel.
    const rotate = f.calls.find((c) => c.argv.includes("rotate"));
    expect(rotate?.argv).toEqual([
      "/path/to/bun",
      "/path/to/volley/packages/volley-cli/src/cli.ts",
      "auth",
      "rotate",
      "volleyd",
      "--json",
    ]);
    expect(rotate?.env?.VOLLEY_AUTH_DIR).toBe(authDir);
    expect(rotate?.env?.VOLLEY_BROKER_URL).toBe("mqtt://127.0.0.1:21883");
    expect(JSON.parse(readFileSync(join(vhome, "broker.json"), "utf-8"))).toEqual({
      username: "volleyd",
      password: SECRET,
    });
    expect(mode(join(vhome, "broker.json"))).toBe(0o600);
    expect(JSON.parse(readFileSync(join(vhome, "dynsec-admin.json"), "utf-8"))).toEqual({
      username: "dynsec-admin",
      password: "admin-pw",
    });
    expect(mode(join(vhome, "dynsec-admin.json"))).toBe(0o600);

    // The unit (Linux): written, enabled, started, after the rotation.
    const unit = readFileSync(join(home, ".config", "systemd", "user", "volleyd.service"), "utf-8");
    expect(unit).toContain(
      "ExecStart=/path/to/bun /path/to/volley/packages/volleyd/src/cli.ts daemon",
    );
    expect(unit).toContain("VOLLEY_BROKER_URL=mqtt://127.0.0.1:21883");
    const at = (s: string) => argvs.indexOf(s);
    expect(at("systemctl --user daemon-reload")).toBeGreaterThan(
      argvs.findIndex((a) => a.includes("rotate")),
    );
    expect(at("systemctl --user enable volleyd.service")).toBeGreaterThan(
      at("systemctl --user daemon-reload"),
    );
    expect(at("systemctl --user restart volleyd.service")).toBeGreaterThan(
      at("systemctl --user enable volleyd.service"),
    );

    // The pairing code for the old machine, last, and the one peer-codes.json holds.
    const lines = r.stdout.trimEnd().split("\n");
    const m = /^Pairing code for old-box: ([A-Z2-9]{4}-[A-Z2-9]{4})$/.exec(lines.at(-1) ?? "");
    expect(m).not.toBeNull();
    const code = (m?.[1] as string).replace("-", "");
    const codes = JSON.parse(readFileSync(join(vhome, "peer-codes.json"), "utf-8")).codes;
    expect(codes).toHaveLength(1);
    expect(codes[0]).toMatchObject({ for: "old-box", expires_at: "2026-10-24T12:10:00.000Z" });
    const hash = scryptSync(code, Buffer.from(codes[0].salt, "base64url"), 32).toString(
      "base64url",
    );
    expect(hash).toBe(codes[0].hash);
    expect(mode(join(vhome, "peer-codes.json"))).toBe(0o600);

    // No password anywhere it is shown.
    for (const out of [r.stdout, r.stderr]) {
      expect(out).not.toContain(SECRET);
      expect(out).not.toContain("admin-pw");
    }
  });

  it("installs volleyd with `volleyd install` on macOS and restarts the peer agent", async () => {
    const f = fakeExec();
    const r = await receive(
      ["supervisor", bundle(), "--from", "old-box", "--broker-url", "mqtt://127.0.0.1:21999"],
      deps(f.exec, { platform: "darwin" }),
    );
    expect(r.code).toBe(EXIT.OK);
    const install = f.calls.find((c) => c.argv.includes("install"));
    expect(install?.argv).toEqual([
      "/path/to/bun",
      "/path/to/volley/packages/volleyd/src/cli.ts",
      "install",
      "--broker-url",
      "mqtt://127.0.0.1:21999",
    ]);
    expect(install?.env?.VOLLEYD_HOME).toBe(vhome);
    expect(install?.env?.VOLLEY_AUTH_DIR).toBe(authDir);
    expect(f.calls.map((c) => c.argv.join(" "))).toContain(
      "launchctl kickstart -k gui/501/systems.volley.peer",
    );
    const cfg = parse(readFileSync(join(vhome, "config.yaml"), "utf-8"));
    expect(cfg.fleet).toEqual({ local_name: "box-a" });
  });

  it.each([
    ["a file whose sha256 differs", { tamper: "volleyd/roles.json" }, [], "sha256"],
    ["another old machine", {}, ["--from", "other-box"], "from old-box"],
    ["another target", { manifest: { to: "box-z" } }, [], "box-z"],
    ["a path out of the bundle's prefixes", { files: { "../evil": "x" } }, [], "../evil"],
  ])("refuses %s and changes nothing", async (_what, over, extra, says) => {
    const before = snapshot(home);
    const f = fakeExec();
    const b = bundle(over as Parameters<typeof bundle>[0]);
    const argv = ["supervisor", b, ...(extra.length > 0 ? extra : ["--from", "old-box"])];
    const r = await receive(argv, deps(f.exec));
    expect(r.code).toBe(EXIT.ERROR);
    expect(r.stderr).toContain(says);
    expect(snapshot(home)).toEqual(before);
    expect(f.calls.filter((c) => c.argv[0] !== "tar")).toEqual([]);
  });

  it("puts everything back when the rotation fails, exit 1", async () => {
    const before = snapshot(home);
    const f = fakeExec((argv) => argv.includes("rotate"));
    const r = await receive(["supervisor", bundle(), "--from", "old-box"], deps(f.exec));
    expect(r.code).toBe(EXIT.ERROR);
    expect(r.stderr).toContain("rotate");
    expect(snapshot(home)).toEqual(before);
  });

  it("exits 3 when the unit does not start after the rotation, and stops it", async () => {
    const f = fakeExec((argv) => argv.join(" ") === "systemctl --user restart volleyd.service");
    const r = await receive(["supervisor", bundle(), "--from", "old-box"], deps(f.exec));
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("rotated");
    expect(r.stderr).not.toContain(SECRET);
    expect(r.stdout).not.toContain(SECRET);
    expect(existsSync(join(vhome, "broker.json"))).toBe(false);
    expect(existsSync(join(vhome, "waves", "w1", "journal.jsonl"))).toBe(false);
    expect(f.calls.map((c) => c.argv.join(" "))).toContain("systemctl --user stop volleyd.service");
    expect(JSON.parse(readFileSync(join(home, ".volley", "peer.json"), "utf-8"))).toEqual(PEER);
  });

  it("on a Mac with nobody at the console, restarts the peer agent in user/<uid>", async () => {
    const f = fakeExec((argv) => argv.join(" ").includes("kickstart -k gui/"));
    const r = await receive(
      ["supervisor", bundle(), "--from", "old-box"],
      deps(f.exec, { platform: "darwin" }),
    );
    expect(r.stderr).toBe("");
    expect(r.code).toBe(EXIT.OK);
    expect(f.calls.map((c) => c.argv.join(" "))).toContain(
      "launchctl kickstart -k user/501/systems.volley.peer",
    );
  });

  it("a machine joined with --no-service has no peer service to restart", async () => {
    rmSync(join(home, ".config"), { recursive: true, force: true });
    const f = fakeExec();
    const r = await receive(["supervisor", bundle(), "--from", "old-box"], deps(f.exec));
    expect(r.code).toBe(EXIT.OK);
    expect(f.calls.map((c) => c.argv.join(" "))).not.toContain(
      "systemctl --user restart volley-peer.service",
    );
    expect(r.stdout).toContain("volley peer run");
  });

  it("on undo, the peer service restarts only once peer.json is back", async () => {
    const seen: string[] = [];
    const base = fakeExec((argv) => argv.join(" ") === "systemctl --user restart volleyd.service");
    const exec: ReceiveExec = async (argv, opts) => {
      if (argv.join(" ") === "systemctl --user restart volley-peer.service")
        seen.push(readFileSync(join(home, ".volley", "peer.json"), "utf-8"));
      return base.exec(argv, opts);
    };
    const r = await receive(["supervisor", bundle(), "--from", "old-box"], deps(exec));
    expect(r.code).toBe(3);
    expect(seen).toHaveLength(2);
    expect(JSON.parse(seen[0] as string)).toEqual({ ...PEER, heartbeat: false });
    expect(JSON.parse(seen[1] as string)).toEqual(PEER);
  });

  it("refuses a peer.json without remote_port when no --broker-url is given", async () => {
    const { remote_port: _p, ...rest } = PEER;
    writeFileSync(join(home, ".volley", "peer.json"), JSON.stringify(rest), { mode: 0o600 });
    const f = fakeExec();
    const r = await receive(["supervisor", bundle(), "--from", "old-box"], deps(f.exec));
    expect(r.code).toBe(EXIT.ERROR);
    expect(r.stderr).toContain("remote_port");
    expect(f.calls).toEqual([]);
  });

  it("refuses a role other than supervisor", async () => {
    const r = await receive(
      ["desk", "/path/to/bundle.tgz", "--from", "old-box"],
      deps(fakeExec().exec),
    );
    expect(r.code).toBe(EXIT.USAGE);
  });
});
