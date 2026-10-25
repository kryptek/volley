import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "../helpers/tmp";

// Layers 2–4 (README.md) against the stand-ins in stubs/: multipass and tart keep their VMs in a
// state directory, ssh is the fake VM (it answers from rules), gh records the tracking issue's
// calls. Every call lands in calls.log, which these tests read.

const HERE = import.meta.dir;
const STUBS = join(HERE, "stubs");
const FIXTURES = join(HERE, "fixtures");

interface World {
  dir: string;
  state: string;
  out: string;
  tmp: string;
}

function world(): World {
  const dir = tempDir("volley-vm-");
  const w = { dir, state: join(dir, "state"), out: join(dir, "out"), tmp: join(dir, "tmp") };
  for (const d of [w.state, w.tmp, join(w.state, "images")]) mkdirSync(d, { recursive: true });
  // A clean base image for Tart to clone.
  writeFileSync(join(w.state, "images", "volley-macos-base"), "");
  return w;
}

/** An answer of the fake VM: the first rule whose regex matches the ssh command wins. */
type Rule = [re: string, code: number, output?: string];

const envelope = (e: object) => `${JSON.stringify({ topic: "t", envelope: e })}\n`;
/** What a VM that installs and sets up cleanly answers. */
const PASSING: Rule[] = [
  ["setup-metrics\\.json", 0, readFileSync(join(FIXTURES, "metrics-pass.json"), "utf8")],
  ["volley setup --check --json", 0, readFileSync(join(FIXTURES, "check-pass.json"), "utf8")],
  [
    "volley/default/volleyd/status",
    0,
    envelope({ type: "working", wall_time: "2099-01-01T00:00:00.000Z" }),
  ],
  ["autoLoginUser", 0, "admin\n"],
  [
    "machines/peer/readiness",
    0,
    envelope({ type: "readiness", payload: { name: "peer", ready: true, reasons: [] } }),
  ],
  ["volley peer list --json", 0, '{ "machines": [{ "name": "peer" }], "hosts": ["peer"] }\n'],
  [
    "volleyd status hello-peer --json",
    0,
    JSON.stringify({ status: "complete", tasks: [{ id: "T1", stage: "done" }] }),
  ],
  [
    "volleyd events hello-peer",
    0,
    `${JSON.stringify({ seq: 5, type: "task_placed", task: "T1", data: { task: "T1", host: "peer" } })}\n`,
  ],
  // After `volley peer remove` the peer's tunnel service is stopped.
  ["is-active --quiet volley-peer\\.service", 3],
];

function writeRules(w: World, rules: Rule[]) {
  const lines = rules.map(([re, code, output], i) => {
    if (output === undefined) return `${re}\t${code}\t-`;
    const file = join(w.state, `answer-${i}`);
    writeFileSync(file, output);
    return `${re}\t${code}\t${file}`;
  });
  writeFileSync(join(w.state, "ssh-rules"), `${lines.join("\n")}\n`);
}

function run(
  w: World,
  script: string,
  args: string[],
  opts: { rules?: Rule[]; env?: Record<string, string> } = {},
) {
  writeRules(w, [...(opts.rules ?? []), ...PASSING]);
  const r = Bun.spawnSync(["bash", join(HERE, script), ...args], {
    cwd: w.dir,
    env: {
      PATH: `${STUBS}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: w.dir,
      TMPDIR: w.tmp,
      STUB_STATE: w.state,
      VM_OUT: w.out,
      VM_RUN_ID: "42",
      VM_POLL_S: "0",
      VM_MAX_WAIT_S: "2",
      ...opts.env,
    },
    stdin: "ignore",
    // A script that loops on its arguments must not hang the suite.
    timeout: 20_000,
    stdout: "pipe",
    stderr: "pipe",
  });
  const log = join(w.state, "calls.log");
  return {
    code: r.exitCode,
    out: `${r.stdout.toString()}${r.stderr.toString()}`,
    calls: existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n") : [],
  };
}

/** Each pattern matches a call, in this order (other calls may come between). */
function expectInOrder(calls: string[], patterns: RegExp[]) {
  let i = 0;
  for (const p of patterns) {
    while (i < calls.length && !p.test(calls[i] ?? "")) i++;
    if (i === calls.length) {
      throw new Error(`no call matching ${p} in order; the calls:\n${calls.join("\n")}`);
    }
    i++;
  }
}

const vmsLeft = (w: World) =>
  existsSync(join(w.state, "vms")) ? readdirSync(join(w.state, "vms")) : [];
const read = (w: World, file: string) => readFileSync(join(w.out, file), "utf8");

describe("the shared parts (lib.sh)", () => {
  const lib = (body: string, env: Record<string, string> = {}) => {
    const r = Bun.spawnSync(["bash", "-c", `. ${join(HERE, "lib.sh")}; ${body}`], {
      env: { PATH: "/usr/bin:/bin", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    return r.stdout.toString();
  };
  const yes = (body: string, env: Record<string, string> = {}) =>
    lib(`if ${body}; then printf yes; else printf no; fi`, env) === "yes";

  test("a VM's name is volley-it-<run id>-<what>, a valid hostname", () => {
    expect(lib("vm_name hub", { VM_RUN_ID: "42" })).toBe("volley-it-42-hub");
    expect(lib("vm_name peer", { GITHUB_RUN_ID: "1234567" })).toBe("volley-it-1234567-peer");
    expect(lib("vm_name hub", { VM_RUN_ID: "Run_7.a" })).toBe("volley-it-run-7-a-hub");
  });

  test("a VM's name is a valid multipass instance name", () => {
    const names = [
      lib("vm_name ubuntu-24.04", { VM_RUN_ID: "42" }),
      lib("vm_name debian-13", { VM_RUN_ID: "42" }),
      lib("vm_name hub", { VM_RUN_ID: "Run_7.a" }),
      lib("vm_name '--Odd..Label--'", { VM_RUN_ID: "-x-" }),
    ];
    expect(names).toEqual([
      "volley-it-42-ubuntu-24-04",
      "volley-it-42-debian-13",
      "volley-it-run-7-a-hub",
      "volley-it-x-odd-label",
    ]);
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9-]*[a-z0-9]$/);
    // Still invalid after the sanitizing (too long): nothing printed, exit 1.
    expect(lib(`vm_name ${"a".repeat(60)} || printf refused`, { VM_RUN_ID: "42" })).toBe("refused");
  });

  test("mp_valid_name is multipass's rule", () => {
    for (const ok of ["volley-it-42-ubuntu-24-04", "a", "a".repeat(63)]) {
      expect(yes(`mp_valid_name '${ok}'`)).toBe(true);
    }
    for (const bad of ["a.b", "-a", "a-", "1a", "", "a".repeat(64), "A_b"]) {
      expect(yes(`mp_valid_name '${bad}'`)).toBe(false);
    }
  });

  test("multipass_can_read: a non-hidden path under HOME only", () => {
    const env = { HOME: "/path/to/home" };
    expect(yes("multipass_can_read /path/to/home/work/x", env)).toBe(true);
    expect(yes("multipass_can_read /path/to/home/x", env)).toBe(true);
    expect(yes("multipass_can_read /path/to/home/work/.hidden/x", env)).toBe(true);
    expect(yes("multipass_can_read /path/to/home/.cache/x", env)).toBe(false);
    expect(yes("multipass_can_read /path/to/home", env)).toBe(false);
    expect(yes("multipass_can_read /path/to/homer/x", env)).toBe(false);
    expect(yes("multipass_can_read /tmp/x", env)).toBe(false);
    expect(yes("multipass_can_read /var/tmp/x", env)).toBe(false);
  });

  test("multipass's images: Ubuntu's own, Debian's generic cloud image", () => {
    expect(lib("mp_image ubuntu-24.04")).toBe("24.04");
    expect(lib("mp_image debian-13")).toMatch(
      /^https:\/\/cloud\.debian\.org\/images\/cloud\/trixie\/latest\/debian-13-genericcloud-(amd64|arm64)\.qcow2$/,
    );
    expect(lib("mp_image debian-13", { VM_DEBIAN_IMAGE: "file:///path/to/d.qcow2" })).toBe(
      "file:///path/to/d.qcow2",
    );
    expect(lib("mp_image fedora || printf no")).toBe("no");
  });

  test("a wait is capped by VM_MAX_WAIT_S", () => {
    expect(lib("cap 600", { VM_MAX_WAIT_S: "2" })).toBe("2\n");
    expect(lib("cap 1")).toBe("1\n");
  });
});

describe("Layer 2: vm-linux.sh", () => {
  test("a fresh VM from cloud-init: install, setup, reboot, the services back, deleted", () => {
    const w = world();
    const r = run(w, "vm-linux.sh", ["ubuntu-24.04"]);
    expect(r.out).toContain("Layer 2 (ubuntu-24.04) passed.");
    expect(r.code).toBe(0);
    const vm = "volley-it-42-ubuntu-24-04";
    expectInOrder(r.calls, [
      new RegExp(`^multipass info ${vm}$`),
      new RegExp(`^multipass launch 24\\.04 --name ${vm} --cloud-init \\S+cloud-init\\.yaml`),
      new RegExp(`^multipass info ${vm} --format json$`),
      new RegExp(`^ssh ${vm}: true$`),
      // The checkout under test, then its install.sh.
      new RegExp(`^ssh ${vm}: rm -rf ~/volley .*tar -C ~/volley -xzf - \\(stdin \\d+ bytes\\)$`),
      new RegExp(`^ssh ${vm}: .*sh -s -- --source ~/volley --no-setup +<~/volley/install\\.sh$`),
      // The snap broker's files are root's: its steps under sudo first (docs/INSTALL.md).
      new RegExp(
        `^ssh ${vm}: .*\\[ ! -d /snap/mosquitto/current \\] \\|\\| sudo ~/\\.volley/bin/volley setup --step detect --step security --step accounts --yes --no-lan$`,
      ),
      new RegExp(
        `^ssh ${vm}: .*eval "\\$\\(volley sim env\\)"; volley setup --yes --no-lan --simulated$`,
      ),
      // The check sees the sign-ins and services setup made: under the simulator too.
      new RegExp(`^ssh ${vm}: .*eval "\\$\\(volley sim env\\)"; volley setup --check --json$`),
      new RegExp(`^ssh ${vm}: sudo reboot$`),
      new RegExp(`^ssh ${vm}: .*eval "\\$\\(volley sim env\\)"; volley setup --check --json$`),
      new RegExp(`^ssh ${vm}: .*systemctl --user is-active --quiet volleyd\\.service$`),
      new RegExp(`^ssh ${vm}: .*systemctl --user is-active --quiet volley-desk\\.service$`),
      new RegExp(`^ssh ${vm}: .*volley sub --pattern volley/default/volleyd/status`),
      new RegExp(`^multipass delete --purge ${vm}$`),
    ]);
    // The reboot really waited for a new boot: refused connections, then the boot id changed.
    expect(
      r.calls.filter((c) => c === `ssh ${vm}: cat /proc/sys/kernel/random/boot_id`).length,
    ).toBeGreaterThan(2);
    expect(vmsLeft(w)).toEqual([]);
    expect(readFileSync(join(w.state, "ssh-key"), "utf8")).toBe(
      `${join(w.out, "key", "id_ed25519")}\n`,
    );
    // The run's key and cloud-init live under VM_OUT (a snap multipass cannot read /tmp), and
    // nothing is left behind.
    expect(
      r.calls.some((c) => c.includes(` --cloud-init ${join(w.out, "key", "cloud-init.yaml")} `)),
    ).toBe(true);
    expect(readdirSync(w.tmp)).toEqual([]);
    expect(existsSync(join(w.out, "key"))).toBe(false);
    expect(read(w, "summary.md")).toContain("### Layer 2: ubuntu-24.04 ✅");
    expect(read(w, "summary.md")).toContain("`reboot_check_ms`");
    const m = JSON.parse(read(w, "metrics.json"));
    expect(m).toMatchObject({ label: "ubuntu-24.04", layer: 2, failures: [] });
    expect(Object.keys(m.timings)).toEqual(["launch_ms", "reboot_ms", "reboot_check_ms"]);
    expect(r.calls.some((c) => c.startsWith("gh "))).toBe(false);
  });

  test("cloud-init gets the run's key and nothing else to log in with", () => {
    const w = world();
    expect(run(w, "vm-linux.sh", ["ubuntu-24.04"]).code).toBe(0);
    const ci = readFileSync(join(w.state, "cloud-init.volley-it-42-ubuntu-24-04.yaml"), "utf8");
    expect(ci).toMatch(/^#cloud-config\n/);
    expect(ci).toMatch(/ssh_authorized_keys:\n {6}- "ssh-ed25519 \S+ volley-it-42"\n/);
    expect(ci).toContain("ssh_pwauth: false");
    expect(ci).toContain("lock_passwd: true");
    expect(ci).not.toContain("@PUBKEY@");
  });

  test("Debian 13's image; a launch that fails half way is deleted too", () => {
    const w = world();
    const r = run(w, "vm-linux.sh", ["debian-13"], {
      env: { STUB_FAIL: "launch" },
    });
    expect(r.code).toBe(1);
    expect(
      r.calls.some((c) =>
        / launch https:\/\/cloud\.debian\.org\/\S+debian-13-genericcloud/.test(c),
      ),
    ).toBe(true);
    expect(r.out).toContain("FAIL: multipass launch volley-it-42-debian-13 failed");
    expect(r.calls.at(-1)).toBe("multipass delete --purge volley-it-42-debian-13");
    expect(vmsLeft(w)).toEqual([]);
  });

  test("a snap multipass refuses a VM_OUT it cannot read, launching nothing", () => {
    const w = world();
    // Outside HOME, as /tmp is.
    const out = join(w.tmp, "results");
    const r = run(w, "vm-linux.sh", ["ubuntu-24.04"], {
      env: { VM_MULTIPASS_IS_SNAP: "1", VM_OUT: out, HOME: join(w.dir, "home") },
    });
    expect(r.code).toBe(2);
    expect(r.out).toContain(`multipass is a snap and cannot read ${out}`);
    expect(r.out).toContain("set VM_OUT to a directory under your home directory");
    expect(r.calls.some((c) => c.startsWith("multipass launch"))).toBe(false);
    expect(existsSync(out)).toBe(false);
  });

  test("a snap multipass with VM_OUT under a non-hidden home path runs", () => {
    const w = world();
    const r = run(w, "vm-linux.sh", ["ubuntu-24.04"], { env: { VM_MULTIPASS_IS_SNAP: "1" } });
    expect(r.code).toBe(0);
  });

  test("--version installs the release through curl, not the checkout", () => {
    const w = world();
    const r = run(w, "vm-linux.sh", ["ubuntu-24.04", "--version", "v0.11.0"]);
    expect(r.code).toBe(0);
    expect(r.calls.some((c) => c.includes("tar -C ~/volley"))).toBe(false);
    expect(
      r.calls.some((c) =>
        c.includes(
          "curl -fsSL https://raw.githubusercontent.com/kryptek/volley/v0.11.0/install.sh | sh -s -- --version v0.11.0 --no-setup",
        ),
      ),
    ).toBe(true);
  });

  test("refuses to start when a VM of its name exists, and leaves that VM alone", () => {
    const w = world();
    mkdirSync(join(w.state, "vms", "volley-it-42-ubuntu-24-04"), { recursive: true });
    writeFileSync(join(w.state, "vms", "volley-it-42-ubuntu-24-04", "addr"), "10.20.0.9");
    const r = run(w, "vm-linux.sh", ["ubuntu-24.04"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("a VM named volley-it-42-ubuntu-24-04 exists already");
    expect(r.calls).toEqual(["multipass info volley-it-42-ubuntu-24-04"]);
    expect(vmsLeft(w)).toEqual(["volley-it-42-ubuntu-24-04"]);
  });

  test("a service down after the reboot fails the run; the VM is still deleted", () => {
    const w = world();
    const r = run(w, "vm-linux.sh", ["ubuntu-24.04"], {
      rules: [["is-active --quiet volleyd\\.service", 3]],
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL: volleyd.service is not active after the reboot");
    expect(r.out).toContain("Layer 2 (ubuntu-24.04) failed.");
    expect(r.calls.at(-1)).toBe("multipass delete --purge volley-it-42-ubuntu-24-04");
    expect(vmsLeft(w)).toEqual([]);
  });

  test("volleyd's status from before the boot fails the run", () => {
    const w = world();
    const r = run(w, "vm-linux.sh", ["ubuntu-24.04"], {
      rules: [
        [
          "volley/default/volleyd/status",
          0,
          envelope({ type: "working", wall_time: "2001-01-01T00:00:00.000Z" }),
        ],
      ],
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("is older than the boot");
    expect(r.out).toContain(
      "FAIL: volleyd's retained status is not working and newer than the boot",
    );
  });

  test("--check not green after the reboot fails the run", () => {
    const w = world();
    const pending = readFileSync(join(FIXTURES, "check-pending.json"), "utf8");
    const r = run(w, "vm-linux.sh", ["ubuntu-24.04"], {
      rules: [["volley setup --check --json", 1, pending]],
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL: volley setup --check was not green within 2 min of the reboot");
    expect(read(w, "summary.md")).toContain("services is pending");
  });

  test("a usage error exits 2 and touches nothing", () => {
    const w = world();
    const r = run(w, "vm-linux.sh", ["fedora-41"]);
    expect(r.code).toBe(2);
    expect(r.calls).toEqual([]);
  });

  test("a reboot that cannot read the boot id first fails rather than guessing", () => {
    const w = world();
    const r = run(w, "vm-linux.sh", ["ubuntu-24.04"], {
      env: { STUB_NO_BOOT_ID: "1" },
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("could not read the boot id of");
    expect(r.calls.some((c) => / sudo reboot$/.test(c))).toBe(false);
    expect(vmsLeft(w)).toEqual([]);
  });
});

describe("the scripts' arguments", () => {
  for (const [script, pre] of [
    ["vm-linux.sh", ["ubuntu-24.04"]],
    ["vm-macos.sh", []],
    ["vm-pair.sh", []],
  ] as const) {
    test(`${script}: --version without a value, or not vX.Y.Z, is a usage error`, () => {
      for (const args of [["--version"], ["--version", "0.11"], ["--version", "v1.2.3;id"]]) {
        const w = world();
        const r = run(w, script, [...pre, ...args]);
        expect(r.code).toBe(2);
        expect(r.calls).toEqual([]);
      }
    });
  }
});

describe("a failing run and the tracking issue", () => {
  const failing: Rule[] = [["is-active --quiet volleyd\\.service", 3]];

  test("no open install-tests issue: one is opened, and the failure is a comment on it", () => {
    const w = world();
    const r = run(w, "vm-linux.sh", ["ubuntu-24.04"], {
      rules: failing,
      env: { VM_TRACK_ISSUE: "1", GITHUB_RUN_ID: "777", GITHUB_REPOSITORY: "kryptek/volley" },
    });
    expect(r.code).toBe(1);
    const gh = r.calls.filter((c) => c.startsWith("gh "));
    expect(gh).toEqual([
      expect.stringMatching(/^gh label create install-tests --color \S+ --description .+ --force$/),
      "gh issue list --label install-tests --state open --json number --jq .[0].number // empty",
      expect.stringMatching(
        /^gh issue create --label install-tests --title Nightly install tests are failing --body /,
      ),
      expect.stringMatching(/^gh issue comment 99 --body-file \S+issue-comment\.md$/),
    ]);
    const comment = read(w, "issue-comment.md");
    expect(comment).toContain("### Layer 2: ubuntu-24.04 failed");
    expect(comment).toContain("https://github.com/kryptek/volley/actions/runs/777");
    expect(comment).toContain("- volleyd.service is not active after the reboot");
    // The comment carries the metrics table too.
    expect(comment).toContain("| Setup wall time |");
  });

  test("an open one: only a comment, no second issue", () => {
    const w = world();
    writeFileSync(join(w.state, "gh-open-issue"), "41\n");
    const r = run(w, "vm-linux.sh", ["ubuntu-24.04"], {
      rules: failing,
      env: { VM_TRACK_ISSUE: "1" },
    });
    expect(r.code).toBe(1);
    const gh = r.calls.filter((c) => c.startsWith("gh "));
    expect(gh.some((c) => c.startsWith("gh issue create"))).toBe(false);
    expect(gh.at(-1)).toMatch(/^gh issue comment 41 --body-file /);
  });

  test("a passing run, or one outside the nightly, files nothing", () => {
    const w = world();
    expect(
      run(w, "vm-linux.sh", ["ubuntu-24.04"], { env: { VM_TRACK_ISSUE: "1" } }).calls.some((c) =>
        c.startsWith("gh "),
      ),
    ).toBe(false);
    const w2 = world();
    expect(
      run(w2, "vm-linux.sh", ["ubuntu-24.04"], { rules: failing }).calls.some((c) =>
        c.startsWith("gh "),
      ),
    ).toBe(false);
  });
});

describe("Layer 3: vm-macos.sh", () => {
  test("the curl path: clone, boot headless, install, setup, the Mac's checks, restart, deleted", () => {
    const w = world();
    const r = run(w, "vm-macos.sh", []);
    expect(r.out).toContain("Layer 3 (macos-curl) passed.");
    expect(r.code).toBe(0);
    const vm = "volley-it-42-macos-curl";
    expectInOrder(r.calls, [
      new RegExp(`^tart get ${vm}$`),
      new RegExp(`^tart clone volley-macos-base ${vm}$`),
      new RegExp(`^tart run --no-graphics ${vm}$`),
      new RegExp(`^tart ip ${vm} --wait \\d+$`),
      new RegExp(`^ssh ${vm}: true$`),
      new RegExp(
        `^ssh ${vm}: .*defaults read /Library/Preferences/com\\.apple\\.loginwindow autoLoginUser$`,
      ),
      new RegExp(`^ssh ${vm}: rm -rf ~/volley .*\\(stdin \\d+ bytes\\)$`),
      new RegExp(`^ssh ${vm}: .*sh -s -- --source ~/volley --no-setup +<~/volley/install\\.sh$`),
      new RegExp(`^ssh ${vm}: .*volley setup --yes --no-lan --simulated$`),
      new RegExp(`^ssh ${vm}: .*launchctl print gui/\\$\\(id -u\\)/systems\\.volley\\.volleyd`),
      new RegExp(`^ssh ${vm}: .*launchctl print gui/\\$\\(id -u\\)/systems\\.volley\\.desk`),
      new RegExp(`^ssh ${vm}: .*security find-generic-password -s volley-broker -a coordinator`),
      new RegExp(`^ssh ${vm}: .*curl -fsS http://127\\.0\\.0\\.1:5199/version\\.json$`),
      new RegExp(`^ssh ${vm}: .*grep -q /volley-hooks/src/hooks/ ~/\\.claude/settings\\.json$`),
      new RegExp(`^tart stop ${vm}$`),
      new RegExp(`^tart run --no-graphics ${vm}$`),
      new RegExp(`^ssh ${vm}: .*volley setup --check --json$`),
      new RegExp(`^ssh ${vm}: .*launchctl print gui/\\$\\(id -u\\)/systems\\.volley\\.volleyd`),
      new RegExp(`^tart delete ${vm}$`),
    ]);
    expect(vmsLeft(w)).toEqual([]);
    // No cloud-init on a Mac: the base image's key, not the run's.
    expect(readFileSync(join(w.state, "ssh-key"), "utf8").trim()).toBe(
      join(w.dir, ".ssh", "id_ed25519"),
    );
    const m = JSON.parse(read(w, "metrics.json"));
    expect(m).toMatchObject({ label: "macos-curl", layer: 3, failures: [] });
    expect(m.timings.reboot_check_ms).toBeNumber();
  });

  test("--brew: brew tap and brew install, and the release it installed", () => {
    const w = world();
    const r = run(w, "vm-macos.sh", ["--brew", "--version", "v0.11.0"], {
      rules: [["volley --version", 0, "volley 0.11.0\n"]],
    });
    expect(r.code).toBe(0);
    const vm = "volley-it-42-macos-brew";
    expectInOrder(r.calls, [
      // The base image has no Homebrew (README.md: the base image): installed first, as on a new Mac.
      new RegExp(
        `^ssh ${vm}: .*NONINTERACTIVE=1 /bin/bash -c "\\$\\(curl -fsSL https://raw\\.githubusercontent\\.com/Homebrew/install/HEAD/install\\.sh\\)"$`,
      ),
      new RegExp(`^ssh ${vm}: .*brew tap kryptek/volley && brew install kryptek/volley/volley$`),
      new RegExp(`^ssh ${vm}: .*volley --version$`),
      new RegExp(`^ssh ${vm}: .*volley setup --yes --no-lan --simulated$`),
      new RegExp(`^tart delete ${vm}$`),
    ]);
    // Volley's own install.sh (the curl path) never runs.
    expect(
      r.calls.some((c) => /kryptek\/volley\/.*install\.sh|~\/volley\/install\.sh/.test(c)),
    ).toBe(false);

    const w2 = world();
    const old = run(w2, "vm-macos.sh", ["--brew", "--version", "v0.11.0"], {
      rules: [["volley --version", 0, "volley 0.10.0\n"]],
    });
    expect(old.code).toBe(1);
    expect(old.out).toContain("FAIL: the tap installed 'volley 0.10.0', not v0.11.0");
  });

  test("--brew: a Homebrew install that fails stops the run before brew tap", () => {
    const w = world();
    const r = run(w, "vm-macos.sh", ["--brew"], {
      rules: [["Homebrew/install/HEAD/install\\.sh", 1]],
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL: Homebrew did not install");
    expect(r.calls.some((c) => c.includes("brew tap"))).toBe(false);
    expect(vmsLeft(w)).toEqual([]);
  });

  test("a VM without auto-login fails early and clearly; nothing is installed; it is deleted", () => {
    const w = world();
    const r = run(w, "vm-macos.sh", [], { rules: [["autoLoginUser", 1]] });
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "FAIL: volley-macos-base has no auto-login: the keychain needs a login session",
    );
    expect(r.calls.some((c) => c.includes("install.sh") || c.includes("volley setup"))).toBe(false);
    expect(r.calls.at(-1)).toBe("tart delete volley-it-42-macos-curl");
    expect(vmsLeft(w)).toEqual([]);
  });

  test("a missing keychain item fails the run", () => {
    const w = world();
    const r = run(w, "vm-macos.sh", [], { rules: [["find-generic-password", 44]] });
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL: no volley-broker keychain item for the coordinator");
    expect(r.out).toContain(
      "FAIL: no volley-broker keychain item for the coordinator after the restart",
    );
  });

  test("refuses to start when a VM of its name exists", () => {
    const w = world();
    mkdirSync(join(w.state, "vms", "volley-it-42-macos-curl"), { recursive: true });
    const r = run(w, "vm-macos.sh", []);
    expect(r.code).toBe(1);
    expect(r.calls).toEqual(["tart get volley-it-42-macos-curl"]);
    expect(vmsLeft(w)).toEqual(["volley-it-42-macos-curl"]);
  });
});

describe("Layer 4: vm-pair.sh", () => {
  const HUB = "volley-it-42-hub";
  const PEER = "volley-it-42-peer";

  test("hub and peer: machine add, ready, a wave placed on the peer, removal, both deleted", () => {
    const w = world();
    const r = run(w, "vm-pair.sh", []);
    expect(r.out).toContain("Layer 4 (pair) passed.");
    expect(r.code).toBe(0);
    expectInOrder(r.calls, [
      new RegExp(`^multipass info ${HUB}$`),
      new RegExp(`^multipass info ${PEER}$`),
      new RegExp(`^multipass launch 24\\.04 --name ${HUB} `),
      new RegExp(`^multipass launch 24\\.04 --name ${PEER} `),
      new RegExp(`^ssh ${HUB}: .*volley setup --yes --no-lan --simulated$`),
      new RegExp(
        `^ssh ${PEER}: .*sh -s -- --source ~/volley --no-setup --peer <~/volley/install\\.sh$`,
      ),
      new RegExp(`^ssh ${PEER}: .*gh auth login --web --git-protocol https && claude auth login$`),
      new RegExp(
        `^ssh ${HUB}: umask 077 && mkdir -p ~/\\.ssh && cat >~/\\.ssh/id_ed25519 \\(stdin \\d+ bytes\\)$`,
      ),
      // The peer's address, as the multipass stand-in handed it out (the second VM: .12).
      new RegExp(
        `^ssh ${HUB}: .*volley machine add volley@10\\.20\\.0\\.12 --name peer --hub volley@10\\.20\\.0\\.11 --no-signin$`,
      ),
      new RegExp(`^ssh ${HUB}: .*volley sub --pattern volley/_system/machines/peer/readiness`),
      new RegExp(`^ssh ${HUB}: .*volley peer list --json$`),
      new RegExp(`^ssh ${HUB}: .*bash -s hello-peer peer \\(stdin \\d+ bytes\\)$`),
      new RegExp(`^ssh ${HUB}: .*volleyd status hello-peer --json$`),
      new RegExp(`^ssh ${HUB}: .*volleyd events hello-peer --cursor vm-pair$`),
      new RegExp(`^ssh ${PEER}: .*git -C .* log --all --format=%H -- src/T1\\.ts`),
      new RegExp(`^ssh ${HUB}: .*volley peer remove peer --now$`),
      new RegExp(`^ssh ${PEER}: .*systemctl --user is-active --quiet volley-peer\\.service$`),
      new RegExp(`^multipass delete --purge ${HUB}$`),
      new RegExp(`^multipass delete --purge ${PEER}$`),
    ]);
    expect(vmsLeft(w)).toEqual([]);
    const m = JSON.parse(read(w, "metrics.json"));
    expect(m).toMatchObject({ label: "pair", layer: 4, failures: [] });
    expect(m.timings.pair_ready_ms).toBeNumber();
    expect(read(w, "summary.md")).toContain("| `pair_ready_ms` |");
  });

  test("a peer that never gets ready fails with the verdict's reasons; both VMs are deleted", () => {
    const w = world();
    const r = run(w, "vm-pair.sh", [], {
      rules: [
        [
          "machines/peer/readiness",
          0,
          envelope({
            payload: { name: "peer", ready: false, reasons: ["Claude is not signed in"] },
          }),
        ],
      ],
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("peer is not ready (Claude is not signed in)");
    expect(r.out).toContain("FAIL: the peer was not ready within 10 min");
    expect(vmsLeft(w)).toEqual([]);
  });

  // Two polls run out here (the wave's placement, the service's stop), each busy for the whole cap:
  // a 1 s cap and a longer timeout keep it inside a slow CI runner's budget.
  test("a task placed elsewhere, or a peer service still running after removal, fails", () => {
    const w = world();
    const r = run(w, "vm-pair.sh", [], {
      env: { VM_MAX_WAIT_S: "1" },
      rules: [
        [
          "volleyd events hello-peer",
          0,
          `${JSON.stringify({ type: "task_placed", task: "T1", data: { task: "T1", host: "hub" } })}\n`,
        ],
        ["is-active --quiet volley-peer\\.service", 0],
      ],
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("T1 was placed on hub, not peer");
    expect(r.out).toContain(
      "FAIL: volley-peer.service still runs on the peer after volley peer remove",
    );
    expect(vmsLeft(w)).toEqual([]);
  }, 15_000);

  test("a peer list without a machine named peer fails, whatever else says peer", () => {
    const w = world();
    const r = run(w, "vm-pair.sh", [], {
      rules: [["volley peer list --json", 0, '{ "machines": [{ "name": "hub", "peer": "x" }] }\n']],
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL: volley peer list does not list peer");
    expect(vmsLeft(w)).toEqual([]);
  });

  test("a peer that does not answer is not a stopped service", () => {
    const w = world();
    const r = run(w, "vm-pair.sh", [], {
      env: { VM_MAX_WAIT_S: "1" },
      rules: [["is-active --quiet volley-peer\\.service", 255]],
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "FAIL: volley-peer.service still runs on the peer after volley peer remove",
    );
  }, 15_000);

  test("refuses to start when either VM's name exists, launching neither", () => {
    const w = world();
    mkdirSync(join(w.state, "vms", PEER), { recursive: true });
    const r = run(w, "vm-pair.sh", []);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`a VM named ${PEER} exists already`);
    expect(r.calls.some((c) => c.startsWith("multipass launch"))).toBe(false);
    expect(vmsLeft(w)).toEqual([PEER]);
  });
});

describe("the nightly workflow (install-nightly.yml)", () => {
  const wf = Bun.YAML.parse(
    readFileSync(join(HERE, "../../.github/workflows/install-nightly.yml"), "utf8"),
  ) as {
    on: Record<string, unknown>;
    env: Record<string, string>;
    jobs: Record<
      string,
      {
        "runs-on": string[] | string;
        needs?: string[];
        if?: string;
        strategy?: { matrix: Record<string, string[]> };
        steps?: { uses?: string; with?: { path?: string } }[];
      }
    >;
  };

  test("never on pull_request or push: a schedule and dispatch only", () => {
    expect(Object.keys(wf.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
  });

  test("three jobs on the two self-hosted runner labels, with their matrices, and a report", () => {
    expect(Object.keys(wf.jobs)).toEqual(["linux-vm", "macos-tart", "pair", "report"]);
    expect(wf.jobs["linux-vm"]?.["runs-on"]).toEqual(["self-hosted", "volley-linux-vm"]);
    expect(wf.jobs["linux-vm"]?.strategy?.matrix.distro).toEqual(["ubuntu-24.04", "debian-13"]);
    expect(wf.jobs["macos-tart"]?.["runs-on"]).toEqual(["self-hosted", "volley-macos-tart"]);
    expect(wf.jobs["macos-tart"]?.strategy?.matrix.path).toEqual(["curl", "brew"]);
    expect(wf.jobs.pair?.["runs-on"]).toEqual(["self-hosted", "volley-linux-vm"]);
  });

  test("a failing job reports to the tracking issue", () => {
    expect(wf.env.VM_TRACK_ISSUE).toBe("1");
  });

  test("the report job tells the tracking issue about a job that failed or never ran", () => {
    const report = wf.jobs.report;
    expect(report?.["runs-on"]).toBe("ubuntu-latest");
    expect(report?.needs).toEqual(["linux-vm", "macos-tart", "pair"]);
    // Always, so a job that failed or never ran is reported (and only in the canonical repository).
    expect(report?.if).toBe("always() && github.repository == 'kryptek/volley'");
    const script = JSON.stringify(report?.steps ?? []);
    // lib.sh's label and title, so the two never make a second issue.
    expect(script).toContain("install-tests");
    expect(script).toContain("Nightly install tests are failing");
    expect(script).toContain("needs.linux-vm.result");
    expect(script).toContain("needs.macos-tart.result");
    expect(script).toContain("needs.pair.result");
  });

  test("no artifact uploads the run's private key", () => {
    const uploads = Object.values(wf.jobs).flatMap((j) =>
      (j.steps ?? []).filter((s) => s.uses?.startsWith("actions/upload-artifact")),
    );
    expect(uploads).toHaveLength(3);
    for (const u of uploads) expect(u.with?.path).toMatch(/^!.+\/\*\*\/key$/m);
  });
});
