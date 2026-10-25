import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import pkg from "../../package.json";
import { runMachine } from "../../src/commands/machine";
import { sshCommand } from "../../src/deploy/peers";
import { makeBufferIO } from "../../src/io";
import type { ExecResult, MachineDeps } from "../../src/machine/add";
import { Scripts, batchArgv, machineFence } from "../../src/machine/ssh";
import { type DoctorReport, runDoctor } from "../../src/peer/doctor";
import { type FakeMachineOptions, fakePeerMachine } from "../helpers/fake-peer-machine";
import { tempDir } from "../helpers/tmp";

/**
 * `volley machine add` against a fake box: an ssh stand-in that runs each script it is sent, with
 * real bash, in the box's temp HOME on a private PATH (stubs for `volley`, `gh`, `ssh-keygen`,
 * `uname` and the tools install.sh needs, plus a few real file utilities), so the scripts' shell is
 * what is tested. The box's `volley peer doctor --json` prints reports the real doctor made of a
 * fake peer machine (test/helpers/fake-peer-machine.ts) in the box's current sign-in state.
 */

const TARGET = "dev@box";
const HUB = "dev@hub.example";
const CODE = "WXYZ-2345";
const HUB_KEY = "ssh-ed25519 AAAAC3NzaHUB hub@hub";
const BOX_KEY = "ssh-ed25519 AAAAC3NzaBOX dev@box";
const HOST_KEY = "ssh-ed25519 AAAAC3NzaHOST";
const VOLLEY_ARGV = ["bun", "/path/to/volley/packages/volley-cli/src/cli.ts"];
const UTILS = ["sh", "cat", "cp", "mkdir", "grep", "sed", "head", "touch", "chmod", "tr"];
/**
 * The probe's PATH ends in /opt/homebrew/bin:/usr/local/bin: a bun there is this machine's, and the
 * box then needs no unzip (a CI runner's bun is in ~/.bun/bin, so there it does).
 */
const HOST_BUN = ["/opt/homebrew/bin/bun", "/usr/local/bin/bun"].some((p) => existsSync(p));

/** The real doctor's report of a fake peer machine at the hub's version. */
async function report(o: FakeMachineOptions): Promise<DoctorReport> {
  const m = fakePeerMachine({ volleyVersion: pkg.version, ...o });
  return (await runDoctor(m.deps({ version: pkg.version }), {})).report;
}

const VOLLEY_STUB = `#!/bin/bash
printf 'volley %s\\n' "$*" >>"$STUB_STATE/calls.log"
case "$1" in
  --version) cat "$STUB_STATE/volley-version" ;;
  setup)
    case " $* " in *" --git-identity "*) touch "$STUB_STATE/git-id" ;; esac
    echo "volley setup --peer: this machine joins a supervisor's fleet"; echo "  ✓ already done" ;;
  peer)
    case "$2" in
      join)
        code=$3 name=
        shift 3
        while [ $# -gt 0 ]; do case "$1" in --name) name=$2; shift ;; esac; shift; done
        mkdir -p "$HOME/.volley"
        printf '{\\n  "name": "%s",\\n  "password": "pw-secret-1"\\n}\\n' "$name" >"$HOME/.volley/peer.json"
        echo "Redeemed $code on the supervisor's machine."
        echo "Paired as $name: account and hosts.$name created."
        ;;
      doctor)
        gh=out; [ -f "$STUB_STATE/gh-in" ] && gh=in
        cl=out; [ -f "$STUB_STATE/claude-in" ] && cl=in
        id=out; [ -f "$STUB_STATE/git-id" ] && id=in
        cat "$STUB_STATE/doctor-$gh-$cl-$id.json"
        ;;
    esac
    ;;
esac
`;

/** The installer the hub sends: records its arguments and installs the volley stub. */
const INSTALLER = `#!/bin/sh
set -eu
printf 'installer %s\\n' "$*" >>"$STUB_STATE/calls.log"
version=
while [ $# -gt 0 ]; do case "$1" in --version) version=\${2#v}; shift ;; esac; shift; done
mkdir -p "$HOME/.volley/bin"
printf '%s\\n' "$version" >"$STUB_STATE/volley-version"
cp "$STUB_STATE/volley-stub" "$HOME/.volley/bin/volley"
chmod 755 "$HOME/.volley/bin/volley"
main() { :; }
main "$@" </dev/null
`;

interface BoxOptions {
  /** The hub's key is in the box's authorized_keys already. */
  keyed?: boolean;
  /** Tools on the box's PATH (default: all of git, tmux, curl, gh). */
  tools?: string[];
  ghIn?: boolean;
  claudeIn?: boolean;
  /** git has a commit identity on the box (default true). */
  gitIdentity?: boolean;
  /** What else the doctor finds (a missing tool, say). */
  doctor?: FakeMachineOptions;
  hubPlatform?: NodeJS.Platform;
  remoteLogin?: boolean;
  /** The hub has a key of its own (default true). */
  hubKey?: boolean;
}

interface Call {
  argv: string[];
  input?: string;
  tty?: boolean;
}

async function fakeBox(o: BoxOptions = {}) {
  const dir = tempDir("volley-machine-");
  const boxHome = join(dir, "box");
  const hubHome = join(dir, "hub");
  const state = join(dir, "state");
  const stubs = join(dir, "stubs");
  const utils = join(dir, "utils");
  for (const d of [boxHome, hubHome, state, stubs, utils]) mkdirSync(d, { recursive: true });
  for (const u of UTILS) {
    const real = ["/usr/bin", "/bin"].map((p) => join(p, u)).find((p) => existsSync(p));
    if (real === undefined) throw new Error(`the test needs ${u}`);
    symlinkSync(real, join(utils, u));
  }
  const stub = (name: string, body: string) => {
    writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(stubs, name), 0o755);
  };
  stub("uname", "echo Linux");
  stub(
    "ssh-keygen",
    `f=; while [ $# -gt 0 ]; do case "$1" in -f) f=$2; shift ;; esac; shift; done
printf 'ssh-keygen %s\\n' "$f" >>"$STUB_STATE/calls.log"
echo private >"$f"; echo '${BOX_KEY}' >"$f.pub"`,
  );
  for (const t of o.tools ?? ["git", "tmux", "curl", "gh", "bun"]) {
    stub(
      t,
      t === "gh"
        ? `printf 'gh %s\\n' "$*" >>"$STUB_STATE/calls.log"
[ "$1 $2" = "auth login" ] && touch "$STUB_STATE/gh-in"
exit 0`
        : "exit 0",
    );
  }
  writeFileSync(join(state, "calls.log"), "");
  writeFileSync(join(state, "volley-stub"), VOLLEY_STUB);
  for (const gh of [true, false]) {
    for (const cl of [true, false]) {
      for (const id of [true, false]) {
        const r = await report({
          ...o.doctor,
          gh: { signedIn: gh },
          ...(cl ? {} : { claudeStatus: { loggedIn: false }, claudeCode: 1 }),
          ...(id ? {} : { gitIdentity: null }),
        });
        const io = (b: boolean) => (b ? "in" : "out");
        writeFileSync(join(state, `doctor-${io(gh)}-${io(cl)}-${io(id)}.json`), JSON.stringify(r));
      }
    }
  }
  if (o.ghIn !== false) writeFileSync(join(state, "gh-in"), "");
  if (o.claudeIn !== false) writeFileSync(join(state, "claude-in"), "");
  if (o.gitIdentity !== false) writeFileSync(join(state, "git-id"), "");
  mkdirSync(join(hubHome, ".ssh"), { recursive: true });
  if (o.hubKey !== false) writeFileSync(join(hubHome, ".ssh", "id_ed25519.pub"), `${HUB_KEY}\n`);
  const authorizedOnBox = join(boxHome, ".ssh", "authorized_keys");
  if (o.keyed !== false) {
    mkdirSync(join(boxHome, ".ssh"), { recursive: true });
    writeFileSync(authorizedOnBox, `${HUB_KEY}\n`);
  }

  const env = {
    HOME: boxHome,
    PATH: `${stubs}:${utils}`,
    STUB_STATE: state,
  };
  const onBox = (argv: string[], input?: string): ExecResult => {
    const r = spawnSync(argv[0] as string, argv.slice(1), {
      env,
      cwd: boxHome,
      input: input ?? "",
      encoding: "utf-8",
    });
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const hubKeyOnBox = () =>
    existsSync(authorizedOnBox) &&
    readFileSync(authorizedOnBox, "utf-8")
      .split("\n")
      .some((l) => l.startsWith("ssh-ed25519 AAAAC3NzaHUB"));
  const calls: Call[] = [];
  const minted: string[] = [];
  const box = {
    dir,
    boxHome,
    hubHome,
    state,
    stubs,
    calls,
    minted,
    /** The box's own commands (installer, volley, gh, ssh-keygen), in order. */
    boxCalls: () => readFileSync(join(state, "calls.log"), "utf-8").split("\n").filter(Boolean),
    deps: (): MachineDeps => ({
      exec: async (argv, opts) => {
        calls.push({
          argv,
          ...(opts?.input !== undefined ? { input: opts.input } : {}),
          ...(opts?.tty === true ? { tty: true } : {}),
        });
        if (argv[0] === "ssh") {
          if (JSON.stringify(argv) === JSON.stringify(batchArgv(TARGET))) {
            if (!hubKeyOnBox()) {
              return {
                code: 255,
                stdout: "",
                stderr: `${TARGET}: Permission denied (publickey).\n`,
              };
            }
            return onBox(["/bin/bash", "-s"], opts?.input);
          }
          // The interactive connect and `ssh -t`: the box's login shell runs the command.
          return onBox(["/bin/sh", "-c", argv[argv.length - 1] as string]);
        }
        if (argv[0] === "ssh-keygen") {
          const f = argv[argv.length - 1] as string;
          writeFileSync(f, "private\n");
          writeFileSync(`${f}.pub`, `${HUB_KEY}\n`);
          return { code: 0, stdout: "", stderr: "" };
        }
        if (argv[0] === "launchctl") {
          return { code: o.remoteLogin === false ? 113 : 0, stdout: "", stderr: "" };
        }
        if (argv[2] === "claude" && argv[3] === "add") {
          writeFileSync(join(state, "claude-in"), "");
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 127, stdout: "", stderr: `unknown ${argv.join(" ")}` };
      },
      home: hubHome,
      platform: o.hubPlatform ?? "linux",
      version: pkg.version,
      installer: () => INSTALLER,
      volleyArgv: VOLLEY_ARGV,
      paired: () => (existsSync(join(boxHome, ".volley", "peer.json")) ? ["box"] : []),
      hostKeys: () => [HOST_KEY],
      mintCode: async (name) => {
        minted.push(name);
        return CODE;
      },
    }),
  };
  return box;
}

type Box = Awaited<ReturnType<typeof fakeBox>>;

async function add(box: Box, extra: string[] = []) {
  const io = makeBufferIO();
  const code = await runMachine(
    { argv: ["add", TARGET, "--hub", HUB, ...extra], env: { HOME: box.hubHome }, io },
    () => box.deps(),
  );
  return { code, stdout: io.readStdout(), stderr: io.readStderr() };
}

const BATCH = [
  "ssh",
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
  TARGET,
  "bash",
  "-s",
];

describe("volley machine add (#462)", () => {
  let box: Box;
  beforeEach(async () => {
    box = await fakeBox({ keyed: false });
  });

  it("with no key yet: one interactive ssh installs the hub's key; every later step is BatchMode with its script on stdin", async () => {
    const r = await add(box);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(batchArgv(TARGET)).toEqual(BATCH);
    expect(batchArgv(TARGET)).toEqual(sshCommand(TARGET, { argv: [] }).argv);
    const ssh = box.calls.filter((c) => c.argv[0] === "ssh");
    // The probe is refused, then the one interactive connect (the terminal is ssh's).
    expect(ssh[0]).toMatchObject({ argv: BATCH });
    expect(ssh[1]?.tty).toBe(true);
    expect(ssh[1]?.argv.slice(0, 4)).toEqual(["ssh", "-o", "ConnectTimeout=10", TARGET]);
    expect(ssh[1]?.argv).toHaveLength(5);
    expect(ssh.filter((c) => c.tty === true)).toHaveLength(1);
    for (const c of ssh.slice(2)) {
      expect(c.argv).toEqual(BATCH);
      expect(c.input).toEqual(expect.any(String));
    }
    expect(readFileSync(join(box.boxHome, ".ssh", "authorized_keys"), "utf-8")).toBe(
      `${HUB_KEY}\n`,
    );
    // ssh asks; we never do.
    expect(r.stdout).not.toMatch(/password:|passphrase/i);
    expect(r.stdout).toContain("any prompt is ssh's own");
  });

  it("creates the hub's key first when it has none", async () => {
    box = await fakeBox({ keyed: false, hubKey: false });
    const r = await add(box);
    expect(r.code).toBe(0);
    expect(box.calls[1]?.argv).toEqual([
      "ssh-keygen",
      "-t",
      "ed25519",
      "-N",
      "",
      "-q",
      "-f",
      join(box.hubHome, ".ssh", "id_ed25519"),
    ]);
    expect(r.stdout).toContain("Create this machine's ssh key");
  });

  it("sends the installer on stdin with --peer --version <the hub's tag> --no-setup, then volley setup --peer --yes", async () => {
    const r = await add(box);
    expect(r.code).toBe(0);
    const calls = box.boxCalls();
    expect(calls).toContain(`installer --peer --version v${pkg.version} --no-setup`);
    expect(calls.indexOf("volley setup --peer --yes")).toBeGreaterThan(
      calls.indexOf(`installer --peer --version v${pkg.version} --no-setup`),
    );
    const installer = box.calls.find((c) => c.input?.includes("printf 'installer"));
    expect(installer?.argv).toEqual(BATCH);
    // The box's checkout is at the hub's tag: the doctor's version check passes.
    expect(readFileSync(join(box.state, "volley-version"), "utf-8").trim()).toBe(pkg.version);
    expect(r.stdout).toContain(`volley ${pkg.version}`);
    expect(r.stdout).not.toMatch(/✗ .*volley/);
  });

  it("runs the installer over ssh -t, announced, when the box lacks what only sudo installs", async () => {
    box = await fakeBox({ keyed: true, tools: ["curl", "gh"] });
    const r = await add(box);
    expect(r.code).toBe(0);
    const announced = r.stdout.indexOf(
      `box lacks git, tmux${HOST_BUN ? "" : ", unzip"}: the installer runs sudo there`,
    );
    expect(announced).toBeGreaterThan(0);
    expect(r.stdout).toContain("the password prompt is sudo's");
    const tty = box.calls.filter((c) => c.tty === true);
    expect(tty).toHaveLength(1);
    expect(tty[0]?.argv.slice(0, 5)).toEqual(["ssh", "-t", "-o", "ConnectTimeout=10", TARGET]);
    expect(tty[0]?.argv[5]).toContain(
      `sh "$HOME/.volley/install.sh" --peer --version v${pkg.version} --no-setup`,
    );
    expect(existsSync(join(box.boxHome, ".volley", "install.sh"))).toBe(true);
    expect(box.boxCalls()).toContain(`installer --peer --version v${pkg.version} --no-setup`);
  });

  it("counts ca-certificates (dpkg) and unzip (no bun) as sudo installs too, as install.sh does", async () => {
    box = await fakeBox({ keyed: true, tools: ["git", "tmux", "curl", "gh", "dpkg"] });
    // dpkg -s ca-certificates: not installed.
    writeFileSync(join(box.stubs, "dpkg"), "#!/bin/sh\nexit 1\n");
    const r = await add(box);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(
      `box lacks ca-certificates${HOST_BUN ? "" : ", unzip"}: the installer runs sudo there`,
    );
    expect(box.calls.filter((c) => c.tty === true)).toHaveLength(1);
  });

  it("authorizes the box's key here (shown as a change) and gives the box this machine's host key", async () => {
    const r = await add(box);
    expect(r.code).toBe(0);
    expect(readFileSync(join(box.hubHome, ".ssh", "authorized_keys"), "utf-8")).toBe(
      `${BOX_KEY}\n`,
    );
    expect(r.stdout).toContain("→ Authorized box's key in ~/.ssh/authorized_keys here");
    expect(r.stdout).toContain("→ Created box's ssh key");
    expect(readFileSync(join(box.boxHome, ".ssh", "known_hosts"), "utf-8")).toBe(
      `hub.example ${HOST_KEY}\n`,
    );
  });

  it("on a Mac hub, checks Remote Login is on, and blocks with how to enable it", async () => {
    box = await fakeBox({ keyed: true, hubPlatform: "darwin", remoteLogin: false });
    const r = await add(box);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("Remote Login is off on this Mac");
    expect(r.stdout).toContain("System Settings → General → Sharing → Remote Login");
    expect(box.calls).toContainEqual({ argv: ["launchctl", "print", "system/com.openssh.sshd"] });
    expect(box.minted).toEqual([]);
    expect(box.boxCalls().some((c) => c.startsWith("volley peer join"))).toBe(false);

    const on = await fakeBox({ keyed: true, hubPlatform: "darwin" });
    const ok = await add(on);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("✓ Remote Login is on");
  });

  it("pairs with a code bound to the name, redeemed with join --to <hub>, then the doctor's row", async () => {
    const r = await add(box);
    expect(r.code).toBe(0);
    expect(box.minted).toEqual(["box"]);
    const calls = box.boxCalls();
    expect(calls).toContain(`volley peer join ${CODE} --to ${HUB} --name box --target ${TARGET}`);
    expect(calls.at(-1)).toBe("volley peer doctor --json");
    expect(r.stdout).toContain("volley peer invite --for box");
    for (const label of ["tools", "gh", "claude", "trust", "repositories"]) {
      expect(r.stdout).toMatch(new RegExp(`^  ${label} +[✓✗–]`, "m"));
    }
    expect(r.stdout).toContain(`box (${TARGET}): ready ✓`);
  });

  it("exits 1 when the box is not ready, with the fix lines", async () => {
    box = await fakeBox({
      keyed: true,
      doctor: { tools: { tmux: { path: null, sshPath: null } } },
    });
    const r = await add(box);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`box (${TARGET}): not ready ✗`);
    expect(r.stdout).toMatch(/^ {2}tools +✗ .*tmux/m);
    expect(r.stdout).toMatch(/^ {2}fix: .*tmux/m);
  });

  it("signs in: gh over ssh -t, Claude through volleyd's remote sign-in", async () => {
    box = await fakeBox({ keyed: true, ghIn: false, claudeIn: false });
    const r = await add(box);
    expect(r.code).toBe(0);
    const tty = box.calls.filter((c) => c.tty === true);
    expect(tty).toHaveLength(2);
    expect(tty[0]?.argv.slice(0, 5)).toEqual(["ssh", "-t", "-o", "ConnectTimeout=10", TARGET]);
    expect(tty[0]?.argv[5]).toContain(
      "gh auth login --web --git-protocol https && gh auth setup-git",
    );
    // The box's Claude is signed in by volleyd's remote sign-in, never by setup there.
    expect(tty[0]?.argv[5]).not.toContain("volley setup");
    expect(tty[1]?.argv).toEqual([
      ...VOLLEY_ARGV,
      "claude",
      "add",
      "box",
      "--machine",
      "box",
      "--wait",
    ]);
    expect(box.boxCalls()).toContain("gh auth login --web --git-protocol https");
    expect(r.stdout).toMatch(/^ {2}gh +✓ signed in/m);
    expect(r.stdout).toMatch(/^ {2}claude +✓ signed in/m);
  });

  describe("git's commit identity on the box", () => {
    const IDENTITY = "volley setup --peer --yes --git-identity";
    const setups = () => box.boxCalls().filter((c) => c.startsWith("volley setup"));

    it("none, both signed out: GitHub over ssh -t, then the identity alone over BatchMode, before Claude's", async () => {
      box = await fakeBox({ keyed: true, ghIn: false, claudeIn: false, gitIdentity: false });
      const r = await add(box);
      expect(r.code).toBe(0);
      expect(setups()).toEqual(["volley setup --peer --yes", IDENTITY]);
      const i = box.calls.findIndex((c) => c.input?.includes(IDENTITY) === true);
      expect(box.calls[i]?.argv).toEqual(batchArgv(TARGET));
      expect(box.calls[i]?.tty).toBeUndefined();
      // No setup ran Claude's sign-in on the box.
      expect(box.calls.filter((c) => c.tty === true)).toHaveLength(2);
      expect(r.stdout).toContain(
        `→ git: a commit identity from the GitHub account (${IDENTITY} on box)`,
      );
      expect(r.stdout).not.toContain("✗ git's commit identity");
    });

    it("none, GitHub signed in already: the identity all the same", async () => {
      box = await fakeBox({ keyed: true, claudeIn: false, gitIdentity: false });
      const r = await add(box);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("✓ GitHub is signed in");
      expect(setups()).toContain(IDENTITY);
    });

    it("none, both signed in: the identity all the same", async () => {
      box = await fakeBox({ keyed: true, gitIdentity: false });
      const r = await add(box);
      expect(r.code).toBe(0);
      expect(setups()).toContain(IDENTITY);
    });

    it("none, --no-signin with GitHub signed out: names the command, runs nothing", async () => {
      box = await fakeBox({ keyed: true, ghIn: false, gitIdentity: false });
      const r = await add(box, ["--no-signin"]);
      expect(setups()).not.toContain(IDENTITY);
      expect(r.stdout).toContain(
        `– git's commit identity: once GitHub is signed in, \`${IDENTITY}\` on box`,
      );
    });

    it("present: not run", async () => {
      box = await fakeBox({ keyed: true, ghIn: false, claudeIn: false });
      const r = await add(box);
      expect(r.code).toBe(0);
      expect(setups()).not.toContain(IDENTITY);
    });

    it("a failed run is reported as git's identity, not as the GitHub sign-in", async () => {
      box = await fakeBox({ keyed: true, gitIdentity: false });
      writeFileSync(
        join(box.state, "volley-stub"),
        VOLLEY_STUB.replace(
          "  setup)\n",
          '  setup)\n    case " $* " in *" --git-identity "*) exit 3 ;; esac\n',
        ),
      );
      const r = await add(box);
      expect(r.stdout).toContain("✗ git's commit identity was not set (exit 3)");
      expect(r.stdout).not.toContain("GitHub sign-in did not finish");
    });
  });

  it("--no-signin defers both sign-ins", async () => {
    box = await fakeBox({ keyed: true, ghIn: false, claudeIn: false });
    const r = await add(box, ["--no-signin"]);
    expect(box.calls.filter((c) => c.tty === true)).toEqual([]);
    expect(r.stdout).toContain("deferred (--no-signin)");
    expect(r.stdout).toMatch(/^ {2}gh +✗/m);
  });

  it("a rerun on a paired box changes nothing and prints the row; no line carries the code or a password", async () => {
    const first = await add(box);
    expect(first.code).toBe(0);
    const authorized = readFileSync(join(box.hubHome, ".ssh", "authorized_keys"), "utf-8");
    const before = box.boxCalls().length;
    const calls = box.calls.length;
    const again = await add(box);
    expect(again.code).toBe(0);
    expect(box.minted).toEqual(["box"]);
    expect(box.boxCalls().slice(before)).toEqual(["volley --version", "volley peer doctor --json"]);
    expect(box.calls.slice(calls).every((c) => c.tty !== true)).toBe(true);
    expect(readFileSync(join(box.hubHome, ".ssh", "authorized_keys"), "utf-8")).toBe(authorized);
    expect(again.stdout).not.toMatch(/→/);
    expect(again.stdout).toContain(`box (${TARGET}): ready ✓`);
    for (const r of [first, again]) {
      const all = r.stdout + r.stderr;
      expect(all).not.toContain(CODE);
      expect(all).not.toContain("pw-secret-1");
    }
    // The join's own output is relayed, the code in it redacted.
    expect(first.stdout).toContain("Redeemed <code> on the supervisor's machine.");
  });

  it("refuses a box paired under another name", async () => {
    mkdirSync(join(box.boxHome, ".volley"), { recursive: true });
    writeFileSync(join(box.boxHome, ".volley", "peer.json"), '{"name": "other"}\n');
    const r = await add(box);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("paired as other already");
    expect(box.minted).toEqual([]);
  });

  it("refuses a malformed target or name", async () => {
    for (const argv of [
      ["add", "-oProxyCommand=x"],
      ["add", TARGET, "--name", "Bad Name"],
      ["add"],
    ]) {
      const io = makeBufferIO();
      expect(await runMachine({ argv, env: {}, io }, () => box.deps())).toBe(2);
    }
  });
});

describe("the machine fence", () => {
  const scripts = new Scripts();
  const fence = machineFence({
    target: TARGET,
    name: "box",
    home: "/path/to/home",
    volleyArgv: VOLLEY_ARGV,
    scripts,
  });

  it("allows the batch shape with a rendered script only, to the target only", () => {
    const s = scripts.script("volley peer doctor --json");
    expect(() => fence(BATCH, { input: s })).not.toThrow();
    expect(() => fence(BATCH, { input: "rm -rf ~\n" })).toThrow(/does not run/);
    expect(() => fence(BATCH)).toThrow(/does not run/);
    expect(() => fence(batchArgv("dev@other"), { input: s })).toThrow(/does not run/);
  });

  it("allows the connect and ssh -t with a rendered command only", () => {
    const c = scripts.command("gh auth login --web");
    expect(() => fence(["ssh", "-o", "ConnectTimeout=10", TARGET, c])).not.toThrow();
    expect(() => fence(["ssh", "-t", "-o", "ConnectTimeout=10", TARGET, c])).not.toThrow();
    expect(() => fence(["ssh", "-t", "-o", "ConnectTimeout=10", TARGET, "reboot"])).toThrow();
    expect(() => fence(["ssh", "-o", "ProxyCommand=x", TARGET, c])).toThrow();
  });

  it("allows the key, Remote Login and Claude sign-in commands exactly", () => {
    expect(() =>
      fence(["ssh-keygen", "-t", "ed25519", "-N", "", "-q", "-f", "/path/to/home/.ssh/id_ed25519"]),
    ).not.toThrow();
    expect(() => fence(["launchctl", "print", "system/com.openssh.sshd"])).not.toThrow();
    expect(() =>
      fence([...VOLLEY_ARGV, "claude", "add", "box", "--machine", "box", "--wait"]),
    ).not.toThrow();
    expect(() =>
      fence([...VOLLEY_ARGV, "claude", "add", "x", "--machine", "x", "--wait"]),
    ).toThrow();
    expect(() => fence(["ssh-keygen", "-R", "box"])).toThrow();
  });
});
