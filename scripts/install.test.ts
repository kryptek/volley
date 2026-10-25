import { describe, expect, test } from "bun:test";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { commandScript } from "volley-cli/setup/services";
import { tempDir } from "./helpers/tmp";

/**
 * install.sh, run with `sh` on a private PATH: the stubs in install-fixtures/ (every call recorded)
 * and a handful of real file utilities, under a temp HOME. Nothing on the real machine is found or
 * changed: a tool the test does not put on the PATH is missing.
 */

const ROOT = join(import.meta.dir, "..");
const SCRIPT = join(ROOT, "install.sh");
const FIXTURES = join(import.meta.dir, "install-fixtures");

/** The real utilities install.sh (and the stubs) may use; nothing that is a prerequisite. */
const UTILS = [
  "basename",
  "cat",
  "chmod",
  "cmp",
  "cp",
  "cut",
  "date",
  "dirname",
  "grep",
  "head",
  "ln",
  "ls",
  "mkdir",
  "mktemp",
  "mv",
  "rm",
  "rmdir",
  "sed",
  "sort",
  "tail",
  "touch",
  "tr",
];

type Platform = "macos-arm64" | "macos-x86_64" | "ubuntu" | "debian" | "fedora" | "freebsd";

interface World {
  dir: string;
  home: string;
  bin: string;
  log: string;
  env: Record<string, string>;
}

interface Run {
  code: number;
  out: string;
  calls: string[];
}

function world(platform: Platform, installed: string[] = [], env: Record<string, string> = {}) {
  const dir = tempDir("volley-install-");
  const home = join(dir, "home");
  const bin = join(dir, "stubs");
  const utils = join(dir, "utils");
  const state = join(dir, "state");
  for (const d of [home, utils, state]) mkdirSync(d, { recursive: true });
  cpSync(join(FIXTURES, "base"), bin, { recursive: true });
  for (const name of installed) {
    const src = join(FIXTURES, "tools", name);
    cpSync(existsSync(src) ? src : join(FIXTURES, "tools", "tool"), join(bin, name));
  }
  for (const u of UTILS) {
    const real = Bun.which(u, { PATH: "/usr/bin:/bin" });
    if (real === null) throw new Error(`the test needs ${u} on /usr/bin:/bin`);
    symlinkSync(real, join(utils, u));
  }
  const [s, m, release] =
    platform === "macos-arm64"
      ? ["Darwin", "arm64", ""]
      : platform === "macos-x86_64"
        ? ["Darwin", "x86_64", ""]
        : platform === "freebsd"
          ? ["FreeBSD", "amd64", ""]
          : [
              "Linux",
              "x86_64",
              { ubuntu: "ubuntu-24.04", debian: "debian-13", fedora: "fedora-41" }[platform],
            ];
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const w: World = {
    dir,
    home,
    bin,
    log,
    env: {
      HOME: home,
      PATH: `${bin}:${utils}`,
      SHELL: "/bin/zsh",
      STUB_LOG: log,
      STUB_BIN: bin,
      STUB_STATE: state,
      STUB_FIXTURES: FIXTURES,
      STUB_UNAME_S: s as string,
      STUB_UNAME_M: m as string,
      VOLLEY_INSTALL_OS_RELEASE: release
        ? join(FIXTURES, `os-release.${release}`)
        : join(dir, "none"),
      VOLLEY_INSTALL_TTY: join(dir, "no-tty"),
      VOLLEY_INSTALL_SYSTEM_DIRS: "",
      ...env,
    },
  };
  // ca-certificates "installed" means dpkg knows it.
  if (installed.includes("ca-certificates")) {
    mkdirSync(join(state, "dpkg"), { recursive: true });
    writeFileSync(join(state, "dpkg", "ca-certificates"), "");
  }
  return w;
}

/** Runs install.sh; `out` is stdout and stderr interleaved, `calls` only this run's. */
function run(w: World, args: string[] = [], env: Record<string, string> = {}): Run {
  const before = readFileSync(w.log, "utf-8").split("\n").filter(Boolean).length;
  const outFile = join(w.dir, "out.txt");
  const fd = openSync(outFile, "w");
  const r = Bun.spawnSync(["/bin/sh", SCRIPT, ...args], {
    env: { ...w.env, ...env },
    cwd: w.home,
    stdin: "ignore",
    stdout: fd,
    stderr: fd,
  });
  closeSync(fd);
  const calls = readFileSync(w.log, "utf-8").split("\n").filter(Boolean).slice(before);
  return { code: r.exitCode ?? -1, out: readFileSync(outFile, "utf-8"), calls };
}

const has = (r: Run, prefix: string) => r.calls.filter((c) => c.startsWith(prefix));
/** Removes a base stub (a machine without that system tool). */
const without = (w: World, tool: string) => rmSync(join(w.bin, tool));
const installers = (r: Run) => has(r, "installer ");
const src = (w: World) => join(w.home, ".volley", "src");
const cli = (root: string, pkg: string) => join(root, "packages", pkg, "src", "cli.ts");

/** Every prerequisite, so a test about something else installs nothing. */
const MAC_ALL = ["brew", "bun", "mosquitto", "gh", "git", "tmux", "claude", "curl"];
const LINUX_ALL = ["git", "tmux", "curl", "ca-certificates", "bun", "gh", "mosquitto", "claude"];

describe("platform detection", () => {
  for (const p of ["macos-arm64", "macos-x86_64", "ubuntu", "debian"] as const) {
    test(`${p} is supported`, () => {
      const w = world(p, p.startsWith("macos") ? MAC_ALL : LINUX_ALL);
      const r = run(w, ["--check"]);
      expect(r.out).not.toContain("not supported yet");
      expect(r.code).toBe(0);
    });
  }

  for (const p of ["fedora", "freebsd"] as const) {
    test(`${p} exits 2 and changes nothing`, () => {
      const w = world(p, []);
      const r = run(w);
      expect(r.code).toBe(2);
      expect(r.out).toContain("not supported yet: macOS and Ubuntu/Debian");
      expect(readdirSync(w.home)).toEqual([]);
      expect(r.calls.filter((c) => !c.startsWith("uname"))).toEqual([]);
    });
  }

  test("an unknown option exits 2 with the usage", () => {
    const w = world("ubuntu", LINUX_ALL);
    const r = run(w, ["--bogus"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("Usage:");
    expect(readdirSync(w.home)).toEqual([]);
  });
});

describe("macOS prerequisites", () => {
  test("a fresh Mac: Homebrew's installer once, brew install the missing, Claude Code", () => {
    const w = world("macos-arm64", ["curl", "git"]);
    const r = run(w, ["--no-setup"]);
    expect(r.code).toBe(0);
    expect(installers(r)).toEqual(["installer brew", "installer claude"]);
    expect(has(r, "brew install")).toEqual(["brew install oven-sh/bun/bun mosquitto gh tmux"]);
    expect(has(r, "sudo")).toEqual([]);

    const again = run(w, ["--no-setup"]);
    expect(again.code).toBe(0);
    expect(installers(again)).toEqual([]);
    expect(has(again, "brew install")).toEqual([]);
  });

  test("with Homebrew and everything else present, nothing is installed", () => {
    const w = world("macos-x86_64", MAC_ALL);
    const r = run(w, ["--no-setup"]);
    expect(r.code).toBe(0);
    expect(installers(r)).toEqual([]);
    expect(has(r, "brew install")).toEqual([]);
  });
});

describe("macOS: the Homebrew tap", () => {
  const TAP = "kryptek/volley/volley";
  const prefix = (w: World) => join(w.dir, "state", "brew");

  test("a brew that knows the tap: brew install it, no clone, no shims; setup runs brew's volley", () => {
    const w = world("macos-arm64", ["brew", "curl", "claude"], {
      STUB_BREW_TAP: "1",
      VOLLEY_INSTALL_TTY: "/dev/null",
    });
    const r = run(w);
    expect(r.code).toBe(0);
    expect(r.calls).toContain(`brew info ${TAP}`);
    expect(has(r, "brew install")).toEqual([`brew install ${TAP}`]);
    expect(has(r, "git")).toEqual([]);
    expect(has(r, "bun install")).toEqual([]);
    expect(has(r, "curl")).toEqual([]);
    expect(existsSync(src(w))).toBe(false);
    expect(existsSync(join(w.home, ".volley", "bin"))).toBe(false);
    expect(existsSync(join(w.home, ".zshrc"))).toBe(false);
    expect(r.calls.at(-1)).toBe("volley setup");
    expect(r.out).toContain(`Running ${join(prefix(w), "bin", "volley")} setup`);
  });

  test("a rerun leaves brew's install alone", () => {
    const w = world("macos-arm64", MAC_ALL, { STUB_BREW_TAP: "1" });
    expect(has(run(w, ["--no-setup"]), "brew install")).toEqual([`brew install ${TAP}`]);
    const again = run(w, ["--no-setup"]);
    expect(again.code).toBe(0);
    expect(has(again, "brew install")).toEqual([]);
    expect(again.out).toContain(`Next: ${join(prefix(w), "bin", "volley")} setup`);
  });

  test("a failed brew install of the tap stops the install: no setup, nothing reported done", () => {
    const w = world("macos-arm64", MAC_ALL, { STUB_BREW_TAP: "1", STUB_BREW_TAP_FAIL: "1" });
    for (const args of [[], ["--no-setup"]]) {
      const r = run(w, args);
      expect(r.code).toBe(1);
      expect(r.out).toContain(`brew install ${TAP} failed`);
      expect(r.out).not.toContain("Volley is installed");
      expect(r.calls).not.toContain("volley setup");
      expect(existsSync(join(prefix(w), "bin", "volley"))).toBe(false);
    }
  });

  test("a Mac with a curl-path install keeps it: no brew install, no second Volley", () => {
    const w = world("macos-arm64", MAC_ALL);
    run(w, ["--no-setup"]);
    expect(existsSync(join(w.home, ".volley", "bin", "volley"))).toBe(true);
    const r = run(w, ["--no-setup"], { STUB_BREW_TAP: "1" });
    expect(r.code).toBe(0);
    expect(has(r, "brew info")).toEqual([]);
    expect(has(r, "brew install")).toEqual([]);
    expect(existsSync(join(prefix(w), "bin", "volley"))).toBe(false);
    expect(r.out).toContain("Next: ~/.volley/bin/volley setup");
  });

  test("a brew that does not know the tap: the curl path (clone, shims)", () => {
    const w = world("macos-arm64", MAC_ALL);
    const r = run(w, ["--no-setup"]);
    expect(r.code).toBe(0);
    expect(r.calls).toContain(`brew info ${TAP}`);
    expect(has(r, "brew install")).toEqual([]);
    expect(has(r, "git clone")).toHaveLength(1);
    expect(existsSync(join(w.home, ".volley", "bin", "volley"))).toBe(true);
  });

  test("--version and --source take the curl path without asking brew", () => {
    for (const args of [
      ["--version", "v0.9.0"],
      ["--source", "."],
    ]) {
      const w = world("macos-arm64", MAC_ALL, { STUB_BREW_TAP: "1" });
      const r = run(w, ["--no-setup", ...args]);
      expect(r.code).toBe(0);
      expect(has(r, "brew info")).toEqual([]);
      expect(has(r, "brew install")).toEqual([]);
      expect(existsSync(join(w.home, ".volley", "bin", "volley"))).toBe(true);
    }
  });

  test("--check reports a brew install", () => {
    const w = world("macos-arm64", MAC_ALL, { STUB_BREW_TAP: "1" });
    run(w, ["--no-setup"]);
    const r = run(w, ["--check"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Volley: ${join(prefix(w), "bin", "volley")} (brew ${TAP})`);
  });

  test("--uninstall removes the services with brew's volley, then brew uninstall", () => {
    const w = world("macos-arm64", MAC_ALL, { STUB_BREW_TAP: "1", STUB_SETUP_UNINSTALL: "1" });
    run(w, ["--no-setup"]);
    const r = run(w, ["--uninstall"]);
    expect(r.code).toBe(0);
    expect(r.calls).toContain("volley setup --uninstall");
    expect(r.calls).toContain(`brew uninstall ${TAP}`);
    expect(r.calls.indexOf("volley setup --uninstall")).toBeLessThan(
      r.calls.indexOf(`brew uninstall ${TAP}`),
    );
  });
});

describe("Linux prerequisites", () => {
  test("a fresh Ubuntu: one sudo -v after the reason, apt, bun, gh, snap mosquitto, Claude Code", () => {
    const w = world("ubuntu", ["curl"], { STUB_SNAPD: "active" });
    const r = run(w, ["--no-setup"]);
    expect(r.code).toBe(0);
    expect(has(r, "sudo -v")).toEqual(["sudo -v"]);
    const reason = r.out.indexOf("sudo is needed");
    expect(reason).toBeGreaterThanOrEqual(0);
    expect(reason).toBeLessThan(r.out.indexOf("[stub] sudo -v"));
    expect(has(r, "apt-get install")).toEqual([
      "apt-get install -y git tmux ca-certificates unzip",
      "apt-get install -y gh",
    ]);
    expect(
      has(r, "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o "),
    ).toHaveLength(1);
    expect(installers(r)).toEqual(["installer bun", "installer claude"]);
    expect(existsSync(join(w.home, ".bun", "bin", "bun"))).toBe(true);
    expect(has(r, "sudo snap install")).toEqual(["sudo snap install mosquitto"]);

    const again = run(w, ["--no-setup"]);
    expect(again.code).toBe(0);
    expect(has(again, "sudo")).toEqual([]);
    expect(has(again, "apt-get")).toEqual([]);
    expect(installers(again)).toEqual([]);
  });

  test("Debian without curl installs it with apt first", () => {
    const w = world("debian", [
      "git",
      "tmux",
      "ca-certificates",
      "bun",
      "gh",
      "mosquitto",
      "claude",
    ]);
    const r = run(w, ["--no-setup"]);
    expect(r.code).toBe(0);
    expect(has(r, "apt-get install")).toEqual(["apt-get install -y curl"]);
  });

  test("an old mosquitto without snapd: the install stops before Volley; remove it first", () => {
    const w = world("ubuntu", LINUX_ALL, { STUB_MOSQUITTO_VERSION: "2.0.18" });
    const r = run(w, ["--no-setup"]);
    expect(r.code).toBe(1);
    expect(has(r, "snap")).toEqual([]);
    expect(has(r, "sudo")).toEqual([]);
    expect(r.out).toContain("mosquitto 2.0.18");
    expect(r.out).toContain("remove it first");
    expect(r.out).toContain("sudo apt-get remove mosquitto");
    expect(r.out).toContain("docker run eclipse-mosquitto:2.1-alpine");
    expect(r.out).not.toContain("Volley is installed");
    expect(has(r, "git clone")).toEqual([]);
    expect(existsSync(join(w.home, ".volley", "bin", "volley"))).toBe(false);
  });

  test("a fresh Ubuntu with socket-activated snapd installs the mosquitto snap", () => {
    const w = world("ubuntu", ["curl"], { STUB_SNAPD: "socket" });
    const r = run(w, ["--no-setup"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("- snap install mosquitto");
    expect(has(r, "sudo snap install")).toEqual(["sudo snap install mosquitto"]);
    expect(r.out).not.toContain("mosquitto is not installed");
  });

  test("a fresh Debian without snapd installs snapd with apt, with consent, then the snap", () => {
    const w = world("debian", ["curl"]);
    without(w, "snap");
    const r = run(w, ["--no-setup"]);
    expect(r.code).toBe(0);
    const reasons = r.out.slice(r.out.indexOf("sudo is needed"), r.out.indexOf("[stub] sudo -v"));
    expect(reasons).toContain("- apt-get install snapd (for the mosquitto snap)");
    expect(reasons).toContain("- snap install mosquitto");
    expect(has(r, "apt-get install")).toEqual([
      "apt-get install -y git tmux ca-certificates unzip snapd",
      "apt-get install -y gh",
    ]);
    const wait = r.calls.indexOf("sudo snap wait system seed.loaded");
    const install = r.calls.indexOf("sudo snap install mosquitto");
    expect(wait).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(wait);
    expect(existsSync(join(w.home, ".volley", "bin", "volley"))).toBe(true);
  });

  test("no snapd and apt cannot install it: the install stops before Volley, with the fix", () => {
    const w = world("debian", ["curl"], { STUB_APT_FAIL: "snapd" });
    without(w, "snap");
    const r = run(w, ["--no-setup"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("mosquitto 2.1");
    expect(r.out).toContain("rerun");
    expect(r.out).not.toContain("Volley is installed");
    expect(has(r, "git clone")).toEqual([]);
    expect(existsSync(join(w.home, ".volley", "bin", "volley"))).toBe(false);
  });

  test("snapd installed but the snap install fails: the install stops before Volley", () => {
    const w = world("ubuntu", ["curl"], { STUB_SNAPD: "socket", STUB_SNAP_FAIL: "1" });
    const r = run(w, ["--no-setup"]);
    expect(r.code).toBe(1);
    expect(has(r, "sudo snap install")).toEqual(["sudo snap install mosquitto"]);
    expect(r.out).toContain("rerun");
    expect(r.out).not.toContain("Volley is installed");
    expect(has(r, "git clone")).toEqual([]);
  });

  test("a mosquitto 2.1 on PATH and no snap command: nothing about snap", () => {
    const w = world("debian", LINUX_ALL);
    without(w, "snap");
    const r = run(w, ["--no-setup"]);
    expect(r.code).toBe(0);
    expect(r.calls.filter((c) => c.includes("snap"))).toEqual([]);
    expect(r.out).not.toContain("snap");
  });

  test("a failed gh keyring download stops before the apt list is written", () => {
    const w = world(
      "ubuntu",
      LINUX_ALL.filter((t) => t !== "gh"),
      { STUB_CURL_FAIL: "githubcli-archive-keyring" },
    );
    const r = run(w, ["--no-setup"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("could not download https://cli.github.com/packages/");
    expect(r.calls.filter((c) => c.includes("github-cli.list"))).toEqual([]);
    expect(
      r.calls.filter((c) => c.includes("githubcli-archive-keyring.gpg") && c.startsWith("sudo")),
    ).toEqual([]);
    expect(has(r, "apt-get")).toEqual([]);
  });

  test("an old mosquitto with snapd: no second broker from snap; remove it first", () => {
    const w = world("ubuntu", LINUX_ALL, {
      STUB_MOSQUITTO_VERSION: "2.0.22",
      STUB_SNAPD: "active",
    });
    const r = run(w, ["--no-setup"]);
    expect(r.code).toBe(1);
    expect(has(r, "snap")).toEqual([]);
    expect(has(r, "sudo")).toEqual([]);
    expect(r.out).toContain("mosquitto 2.0.22");
    expect(r.out).toContain("remove it first");
    expect(r.out).toContain("sudo apt-get remove mosquitto");
    expect(r.out).not.toContain("Volley is installed");
    expect(has(r, "git clone")).toEqual([]);
  });

  test("a snap mosquitto that is still too old (or shadowed) is reported", () => {
    const w = world(
      "ubuntu",
      LINUX_ALL.filter((t) => t !== "mosquitto"),
      { STUB_SNAPD: "active", STUB_MOSQUITTO_VERSION: "2.0.9" },
    );
    const r = run(w, ["--no-setup"]);
    expect(r.code).toBe(1);
    expect(has(r, "sudo snap install")).toEqual(["sudo snap install mosquitto"]);
    expect(r.out).toContain("mosquitto 2.0.9 is on PATH");
    expect(r.out).not.toContain("Volley is installed");
    expect(has(r, "git clone")).toEqual([]);
  });

  test("a mosquitto 2.1 on PATH is accepted", () => {
    const w = world("ubuntu", LINUX_ALL, { STUB_SNAPD: "active" });
    const r = run(w, ["--no-setup"]);
    expect(has(r, "sudo")).toEqual([]);
    expect(has(r, "snap")).toEqual([]);
  });

  test("root needs no sudo", () => {
    const w = world("debian", ["curl", "gh"], { STUB_UID: "0", STUB_SNAPD: "active" });
    const r = run(w, ["--no-setup"]);
    expect(r.code).toBe(0);
    expect(has(r, "sudo")).toEqual([]);
    expect(has(r, "apt-get install")).toContain(
      "apt-get install -y git tmux ca-certificates unzip",
    );
    expect(r.calls).toContain("snap install mosquitto");
  });

  test("root needs no sudo, with socket-activated snapd too", () => {
    const w = world("debian", ["curl", "gh"], { STUB_UID: "0", STUB_SNAPD: "socket" });
    const r = run(w, ["--no-setup"]);
    expect(r.code).toBe(0);
    expect(has(r, "sudo")).toEqual([]);
    expect(r.calls).toContain("snap install mosquitto");
  });
});

describe("the source", () => {
  test("the latest tag is cloned shallow into ~/.volley/src and bun-installed", () => {
    const w = world("ubuntu", LINUX_ALL);
    const r = run(w, ["--no-setup"]);
    expect(r.code).toBe(0);
    expect(has(r, "git")).toEqual([
      `git clone --depth 1 --branch v0.10.0 https://github.com/kryptek/volley.git ${src(w)}`,
    ]);
    expect(has(r, "bun install")).toEqual(["bun install --frozen-lockfile"]);
    expect(existsSync(join(src(w), "node_modules"))).toBe(true);

    const again = run(w, ["--no-setup"]);
    expect(has(again, "git")).toEqual([
      `git -C ${src(w)} describe --tags --exact-match`,
      `git -C ${src(w)} fetch --tags`,
    ]);
    expect(has(again, "bun install")).toEqual([]);
  });

  test("a rerun on the same tag survives a failed fetch (offline)", () => {
    const w = world("ubuntu", LINUX_ALL);
    run(w, ["--no-setup"]);
    const again = run(w, ["--no-setup"], { STUB_GIT_FAIL: "fetch" });
    expect(again.code).toBe(0);
    expect(again.out).toContain("could not fetch");
    expect(existsSync(join(w.home, ".volley", "bin", "volley"))).toBe(true);
  });

  test("--version picks the tag; a rerun on another version checks it out", () => {
    const w = world("ubuntu", LINUX_ALL);
    const r = run(w, ["--no-setup", "--version", "v0.9.0"]);
    expect(has(r, "curl")).toEqual([]);
    expect(has(r, "git clone")[0]).toContain("--branch v0.9.0 ");

    const up = run(w, ["--no-setup", "--version", "v0.10.0"]);
    expect(up.calls).toContain(`git -C ${src(w)} checkout --quiet v0.10.0`);
    expect(has(up, "bun install")).toEqual(["bun install --frozen-lockfile"]);
  });

  test("--source uses that checkout, and the shims point into it", () => {
    const w = world("ubuntu", LINUX_ALL);
    const checkout = join(w.dir, "checkout");
    mkdirSync(checkout);
    const r = run(w, ["--no-setup", "--source", checkout]);
    expect(r.code).toBe(0);
    expect(has(r, "git")).toEqual([]);
    expect(has(r, "curl")).toEqual([]);
    expect(existsSync(src(w))).toBe(false);
    expect(existsSync(join(checkout, "node_modules"))).toBe(true);
    const shim = readFileSync(join(w.home, ".volley", "bin", "volley"), "utf-8");
    expect(shim).toBe(commandScript(join(w.bin, "bun"), cli(checkout, "volley-cli")));
  });
});

describe("the shims and PATH", () => {
  test("~/.volley/bin holds volley and volleyd, byte-identical to setup's", () => {
    const w = world(
      "ubuntu",
      LINUX_ALL.filter((t) => t !== "bun"),
    );
    run(w, ["--no-setup"]);
    const bin = join(w.home, ".volley", "bin");
    const bun = join(w.home, ".bun", "bin", "bun");
    expect(readdirSync(bin).sort()).toEqual(["volley", "volleyd"]);
    expect(readFileSync(join(bin, "volley"), "utf-8")).toBe(
      commandScript(bun, cli(src(w), "volley-cli")),
    );
    expect(readFileSync(join(bin, "volleyd"), "utf-8")).toBe(
      commandScript(bun, cli(src(w), "volleyd")),
    );
    expect(statSync(join(bin, "volley")).mode & 0o111).toBe(0o111);
  });

  test("a path with a quote is quoted as setup quotes it", () => {
    const w = world("ubuntu", LINUX_ALL);
    const checkout = join(w.dir, "it's here");
    mkdirSync(checkout);
    run(w, ["--no-setup", "--source", checkout]);
    expect(readFileSync(join(w.home, ".volley", "bin", "volleyd"), "utf-8")).toBe(
      commandScript(join(w.bin, "bun"), cli(checkout, "volleyd")),
    );
  });

  test("a foreign file at a shim's path is backed up", () => {
    const w = world("ubuntu", LINUX_ALL);
    mkdirSync(join(w.home, ".volley", "bin"), { recursive: true });
    writeFileSync(join(w.home, ".volley", "bin", "volley"), "#!/bin/sh\necho mine\n");
    run(w, ["--no-setup"]);
    const backups = readdirSync(join(w.home, ".volley", "bin")).filter((f) =>
      f.startsWith("volley.volley-backup-"),
    );
    expect(backups.length).toBe(1);
  });

  test("zsh: the PATH line is appended to ~/.zshrc once", () => {
    const w = world("macos-arm64", MAC_ALL);
    run(w, ["--no-setup"]);
    run(w, ["--no-setup"]);
    const rc = readFileSync(join(w.home, ".zshrc"), "utf-8");
    expect(rc.match(/# volley$/gm)?.length).toBe(1);
    expect(rc).toContain('export PATH="$HOME/.volley/bin:$PATH" # volley');
  });

  test("bash on Linux: ~/.bashrc", () => {
    const w = world("ubuntu", LINUX_ALL, { SHELL: "/bin/bash" });
    writeFileSync(join(w.home, ".bashrc"), "# mine\n");
    run(w, ["--no-setup"]);
    run(w, ["--no-setup"]);
    const rc = readFileSync(join(w.home, ".bashrc"), "utf-8");
    expect(rc.startsWith("# mine\n")).toBe(true);
    expect(rc.match(/# volley$/gm)?.length).toBe(1);
  });

  test("a user's own line ending in '# volley' is not taken for the PATH line", () => {
    const w = world("ubuntu", LINUX_ALL);
    const mine = "alias v=vim # volley";
    writeFileSync(join(w.home, ".zshrc"), `${mine}\n`);
    run(w, ["--no-setup"]);
    const rc = readFileSync(join(w.home, ".zshrc"), "utf-8");
    expect(rc).toBe(`${mine}\nexport PATH="$HOME/.volley/bin:$PATH" # volley\n`);
    run(w, ["--uninstall"]);
    expect(readFileSync(join(w.home, ".zshrc"), "utf-8")).toBe(`${mine}\n`);
  });

  test("an unset SHELL: the line to add is printed", () => {
    const w = world("ubuntu", LINUX_ALL);
    const { SHELL: _shell, ...rest } = w.env;
    w.env = rest;
    const r = run(w, ["--no-setup"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Add this line to your shell's startup file");
    expect(readdirSync(w.home).filter((f) => f !== ".volley")).toEqual([]);
  });

  test("fish: the line is printed, no rc file is written", () => {
    const w = world("ubuntu", LINUX_ALL, { SHELL: "/usr/bin/fish" });
    const r = run(w, ["--no-setup"]);
    expect(r.out).toContain("fish_add_path $HOME/.volley/bin");
    expect(readdirSync(w.home).filter((f) => f !== ".volley")).toEqual([]);
  });
});

describe("chaining into volley setup", () => {
  test("with a terminal: exec volley setup", () => {
    const w = world("ubuntu", LINUX_ALL, { VOLLEY_INSTALL_TTY: "/dev/null" });
    const r = run(w);
    expect(r.code).toBe(0);
    expect(r.calls.at(-1)).toBe(`bun ${cli(src(w), "volley-cli")} setup`);
  });

  test("--peer is passed through", () => {
    const w = world("ubuntu", LINUX_ALL, { VOLLEY_INSTALL_TTY: "/dev/null" });
    const r = run(w, ["--peer"]);
    expect(r.calls.at(-1)).toBe(`bun ${cli(src(w), "volley-cli")} setup --peer`);
  });

  test("without a terminal: the command to run is printed", () => {
    const w = world("ubuntu", LINUX_ALL);
    const r = run(w);
    expect(r.code).toBe(0);
    expect(has(r, `bun ${cli(src(w), "volley-cli")}`)).toEqual([]);
    expect(r.out).toContain("~/.volley/bin/volley setup");
  });

  test("--no-setup skips it", () => {
    const w = world("ubuntu", LINUX_ALL, { VOLLEY_INSTALL_TTY: "/dev/null" });
    const r = run(w, ["--no-setup"]);
    expect(has(r, `bun ${cli(src(w), "volley-cli")}`)).toEqual([]);
  });
});

describe("--peer: a machine that joins a supervisor's fleet (no broker, no Desk)", () => {
  const LINUX_PEER = LINUX_ALL.filter((t) => t !== "mosquitto");
  const MAC_PEER = MAC_ALL.filter((t) => t !== "mosquitto");

  test("a fresh Ubuntu: no mosquitto from snap, and no mosquitto advice", () => {
    const w = world("ubuntu", ["curl"], { STUB_SNAPD: "socket" });
    const r = run(w, ["--peer", "--no-setup"]);
    expect(r.code).toBe(0);
    expect(has(r, "sudo snap")).toEqual([]);
    expect(r.out).not.toContain("snap install mosquitto");
    expect(r.out).not.toContain("apt-get install snapd");
    expect(r.out).not.toContain("mosquitto is not installed");
    expect(has(r, "apt-get install")).toEqual([
      "apt-get install -y git tmux ca-certificates unzip",
      "apt-get install -y gh",
    ]);
    expect(installers(r)).toEqual(["installer bun", "installer claude"]);
    expect(r.out).toContain("Next: ~/.volley/bin/volley setup --peer");
  });

  test("a fresh Mac: brew installs no mosquitto, and the tap (which brings one) is not used", () => {
    const w = world("macos-arm64", ["curl", "git"], { STUB_BREW_TAP: "1" });
    const r = run(w, ["--peer", "--no-setup"]);
    expect(r.code).toBe(0);
    expect(has(r, "brew info")).toEqual([]);
    expect(has(r, "brew install")).toEqual(["brew install oven-sh/bun/bun gh tmux"]);
    expect(has(r, "git clone")).toHaveLength(1);
  });

  test("--check does not count mosquitto", () => {
    for (const [p, tools] of [
      ["ubuntu", LINUX_PEER],
      ["macos-arm64", MAC_PEER],
    ] as const) {
      const w = world(p, [...tools]);
      const r = run(w, ["--peer", "--check"]);
      expect(r.code).toBe(0);
      expect(r.out).not.toContain("mosquitto");
    }
  });

  test("setup runs with --peer and VOLLEY_BROKER=skip", () => {
    const w = world("ubuntu", LINUX_PEER, { VOLLEY_INSTALL_TTY: "/dev/null" });
    const r = run(w, ["--peer", "--version", "v0.9.0"]);
    expect(r.code).toBe(0);
    expect(has(r, "git clone")).toEqual([
      expect.stringContaining("--branch v0.9.0") as unknown as string,
    ]);
    expect(r.calls.slice(-2)).toEqual([
      "env VOLLEY_BROKER=skip",
      `bun ${cli(src(w), "volley-cli")} setup --peer`,
    ]);
  });

  test("a plain install does not set VOLLEY_BROKER", () => {
    const w = world("ubuntu", LINUX_ALL, { VOLLEY_INSTALL_TTY: "/dev/null" });
    const r = run(w);
    expect(has(r, "env VOLLEY_BROKER")).toEqual([]);
  });

  test("--uninstall removes the peer service too", () => {
    const w = world("ubuntu", LINUX_PEER);
    run(w, ["--peer", "--no-setup"]);
    const unit = join(w.home, ".config", "systemd", "user", "volley-peer.service");
    mkdirSync(join(unit, ".."), { recursive: true });
    writeFileSync(unit, "[Unit]\n");
    const r = run(w, ["--uninstall"]);
    expect(r.code).toBe(0);
    expect(existsSync(unit)).toBe(false);
    expect(r.out).toContain("Removed volley-peer.service");
  });
});

describe("--check", () => {
  test("lists found and missing, exits 1, changes nothing", () => {
    const w = world("ubuntu", ["git", "curl", "bun"]);
    const r = run(w, ["--check"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/found\s+git/);
    expect(r.out).toMatch(/missing\s+tmux/);
    expect(r.out).toMatch(/missing\s+ca-certificates/);
    expect(r.out).toMatch(/missing\s+claude/);
    expect(readdirSync(w.home)).toEqual([]);
    expect(has(r, "sudo")).toEqual([]);
    expect(has(r, "apt-get")).toEqual([]);
    expect(has(r, "curl")).toEqual([]);
  });

  test("an old mosquitto counts as missing", () => {
    const w = world("macos-arm64", MAC_ALL, { STUB_MOSQUITTO_VERSION: "2.0.22" });
    const r = run(w, ["--check"]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/missing\s+mosquitto.*2\.0\.22/);
    expect(has(r, "brew install")).toEqual([]);
  });
});

describe("--network: how the machine is reached from outside its network", () => {
  test("Linux --network tailscale: Tailscale's apt repository under the one sudo, then apt install", () => {
    const w = world(
      "ubuntu",
      LINUX_ALL.filter((t) => t !== "git"),
    );
    const r = run(w, ["--no-setup", "--network", "tailscale"]);
    expect(r.code).toBe(0);
    expect(has(r, "sudo -v")).toEqual(["sudo -v"]);
    expect(r.out).toContain(
      "add Tailscale's apt repository (pkgs.tailscale.com) and install tailscale",
    );
    expect(has(r, "curl -fsSL https://pkgs.tailscale.com/")).toEqual([
      expect.stringContaining("https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg -o "),
      expect.stringContaining(
        "https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list -o ",
      ),
    ]);
    expect(has(r, "sudo tee")).toContain("sudo tee /etc/apt/sources.list.d/tailscale.list");
    expect(has(r, "apt-get install")).toEqual([
      "apt-get install -y git",
      "apt-get install -y tailscale",
    ]);
    // Installed now: a rerun asks for nothing.
    const again = run(w, ["--no-setup", "--network", "tailscale"]);
    expect(has(again, "sudo")).toEqual([]);
    expect(has(again, "curl -fsSL https://pkgs.tailscale.com/")).toEqual([]);
  });

  test("Debian reads Tailscale's repository by its codename", () => {
    const w = world("debian", LINUX_ALL);
    const r = run(w, ["--no-setup", "--network=tailscale"]);
    expect(r.code).toBe(0);
    expect(
      has(r, "curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.noarmor.gpg"),
    ).toHaveLength(1);
  });

  test("without --network (or with manual or none) nothing of Tailscale's is installed or checked", () => {
    for (const args of [[], ["--network", "none"], ["--network", "manual"]]) {
      const w = world("ubuntu", LINUX_ALL);
      const r = run(w, ["--no-setup", ...args]);
      expect(r.code).toBe(0);
      expect(has(r, "curl -fsSL https://pkgs.tailscale.com/")).toEqual([]);
      expect(has(r, "sudo")).toEqual([]);
      expect(run(w, ["--check", ...args]).out).not.toContain("tailscale");
    }
  });

  test("macOS --network tailscale: brew install --cask tailscale", () => {
    const w = world("macos-arm64", MAC_ALL);
    const r = run(w, ["--no-setup", "--network", "tailscale"]);
    expect(r.code).toBe(0);
    expect(has(r, "brew install --cask")).toEqual(["brew install --cask tailscale"]);
  });

  test("--check lists tailscale only with --network tailscale, found or missing", () => {
    const w = world("ubuntu", LINUX_ALL);
    const missing = run(w, ["--check", "--network", "tailscale"]);
    expect(missing.code).toBe(1);
    expect(missing.out).toMatch(/missing\s+tailscale/);
    const ok = world("ubuntu", [...LINUX_ALL, "tailscale"]);
    const found = run(ok, ["--check", "--network", "tailscale"]);
    expect(found.out).toMatch(/found\s+tailscale/);
  });

  test("the flags are passed to volley setup; a bad kind or a stray address is a usage error", () => {
    const w = world("ubuntu", LINUX_ALL, { VOLLEY_INSTALL_TTY: "/dev/null" });
    const r = run(w, ["--network", "manual", "--network-address", "192.0.2.10"]);
    expect(r.calls.at(-1)).toBe(
      `bun ${cli(src(w), "volley-cli")} setup --network manual --network-address 192.0.2.10`,
    );
    const peer = run(w, ["--peer", "--network", "none"]);
    expect(peer.calls.at(-1)).toBe(`bun ${cli(src(w), "volley-cli")} setup --peer --network none`);
    expect(run(w, ["--network", "funnel"]).code).toBe(2);
    expect(run(w, ["--network-address", "192.0.2.10"]).code).toBe(2);
  });
});

describe("--uninstall", () => {
  function installed(platform: Platform, env: Record<string, string> = {}) {
    const w = world(platform, platform.startsWith("macos") ? MAC_ALL : LINUX_ALL, env);
    run(w, ["--no-setup"]);
    const vol = join(w.home, ".volley");
    mkdirSync(join(vol, "volleyd"), { recursive: true });
    mkdirSync(join(vol, "claude"), { recursive: true });
    writeFileSync(join(vol, "peer.json"), "{}");
    return w;
  }

  test("Linux: services, shims, rc line and source go; volleyd's home stays", () => {
    const w = installed("ubuntu");
    const units = join(w.home, ".config", "systemd", "user");
    mkdirSync(units, { recursive: true });
    writeFileSync(join(units, "volleyd.service"), "[Unit]\n");
    writeFileSync(join(units, "volley-desk.service"), "[Unit]\n");
    writeFileSync(join(units, "other.service"), "[Unit]\n");
    const r = run(w, ["--uninstall"]);
    expect(r.code).toBe(0);
    expect(r.calls).toContain("systemctl --user disable --now volleyd.service");
    expect(r.calls).toContain("systemctl --user disable --now volley-desk.service");
    expect(readdirSync(units)).toEqual(["other.service"]);
    const vol = join(w.home, ".volley");
    expect(existsSync(join(vol, "bin"))).toBe(false);
    expect(existsSync(join(vol, "src"))).toBe(false);
    expect(existsSync(join(vol, "volleyd"))).toBe(true);
    expect(existsSync(join(vol, "claude"))).toBe(true);
    expect(existsSync(join(vol, "peer.json"))).toBe(true);
    expect(readFileSync(join(w.home, ".zshrc"), "utf-8")).not.toContain("# volley");
    expect(has(r, "sudo")).toEqual([]);
    expect(has(r, "apt-get")).toEqual([]);
  });

  test("macOS: the launchd agents are booted out and removed", () => {
    const w = installed("macos-arm64");
    const agents = join(w.home, "Library", "LaunchAgents");
    mkdirSync(agents, { recursive: true });
    writeFileSync(join(agents, "systems.volley.volleyd.plist"), "<plist/>");
    writeFileSync(join(agents, "systems.volley.desk.plist"), "<plist/>");
    const r = run(w, ["--uninstall"]);
    expect(r.code).toBe(0);
    expect(r.calls).toContain("launchctl bootout gui/1000/systems.volley.volleyd");
    expect(r.calls).toContain("launchctl bootout gui/1000/systems.volley.desk");
    expect(readdirSync(agents)).toEqual([]);
  });

  test("volley setup --uninstall is used when setup has it", () => {
    const w = installed("ubuntu", { STUB_SETUP_UNINSTALL: "1" });
    const r = run(w, ["--uninstall"]);
    expect(r.calls).toContain(`bun ${cli(src(w), "volley-cli")} setup --uninstall`);
    expect(has(r, "systemctl --user disable")).toEqual([]);
  });

  test("--purge also removes volleyd's home, and nothing else of ~/.volley", () => {
    const w = installed("ubuntu");
    run(w, ["--uninstall", "--purge"]);
    const vol = join(w.home, ".volley");
    expect(existsSync(join(vol, "volleyd"))).toBe(false);
    expect(existsSync(join(vol, "claude"))).toBe(true);
    expect(existsSync(join(vol, "peer.json"))).toBe(true);
  });
});

describe("hygiene", () => {
  const text = readFileSync(SCRIPT, "utf-8");

  test("no set -x, no bash-isms in the shebang", () => {
    expect(text.startsWith("#!/bin/sh\n")).toBe(true);
    expect(text).not.toMatch(/set\s+-[a-z]*x/);
  });

  test("no output line carries a credential file's value or a token-shaped string", () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const w = world("ubuntu", ["curl"], {
      GH_TOKEN: secret,
      ANTHROPIC_API_KEY: "sk-ant-api03-secretsecretsecret",
    });
    mkdirSync(join(w.home, ".volley", "auth"), { recursive: true });
    writeFileSync(join(w.home, ".volley", "auth", "admin.secret"), "hunter2-admin-password\n");
    writeFileSync(join(w.home, ".zshrc"), `export GH_TOKEN=${secret}\n`);
    const out = [run(w, ["--check"]), run(w), run(w, ["--uninstall"])].map((r) => r.out).join("\n");
    expect(out).not.toContain(secret);
    expect(out).not.toContain("hunter2");
    expect(out).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}|sk-ant-|\b[A-Fa-f0-9]{40,}\b/);
  });
});
