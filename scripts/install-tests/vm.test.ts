import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempDir } from "../helpers/tmp";

// Layers 2 and 4 (README.md), verify.sh and install-vm.yml against the stand-ins in stubs/:
// multipass keeps its VMs in a state directory, ssh is the fake VM (it answers from rules), gh
// records the tracking issue's calls and answers verify.sh's. Every call lands in calls.log, which
// these tests read.

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
  for (const d of [w.state, w.tmp]) mkdirSync(d, { recursive: true });
  return w;
}

/** An answer of the fake VM: the first rule whose regex matches the ssh command wins. */
type Rule = [re: string, code: number, output?: string];

const envelope = (e: object) => `${JSON.stringify({ topic: "t", envelope: e })}\n`;
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const placed = (wave: string, host = "peer") =>
  [
    [
      `volleyd status ${wave} --json`,
      0,
      JSON.stringify({ status: "complete", tasks: [{ id: "T1", stage: "done" }] }),
    ],
    [
      `volleyd events ${wave}`,
      0,
      `${JSON.stringify({ seq: 5, type: "task_placed", task: "T1", data: { task: "T1", host } })}\n`,
    ],
  ] as Rule[];
/** The peer's clone of the slug repository, as `volley repo add --wait` reports it. */
const SLUG_CLONE = "/path/to/home/volley-repos/volley-sim/volley-slug-42";
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
  ["volley peer list$", 0, "peer  ready  volley@10.20.0.12\n"],
  ...placed("hello-peer"),
  ...placed("hello-slug"),
  // Layer 2's second wave, on a repository with no CI.
  ["volleyd status hello-noci --json", 0, fixture("wave-status-noci.json")],
  ["volleyd events hello-noci", 0, fixture("wave-events-noci.jsonl")],
  // The first wave's name, read from its file.
  ["s/\\^wave: //p", 0, "hello-ab12\n"],
  [
    "volleyd status hello-ab12$",
    0,
    "wave hello-ab12 (complete)\ncoordinator: coordinator on hub\n",
  ],
  // The hub's world: its origins directory.
  ["VOLLEY_SIM_HOME", 0, "/path/to/home/.volley/sim/origins"],
  [
    "volley repo add",
    0,
    `Adding volley-sim/volley-slug-42 on peer\n  peer: cloning\n  peer: ready (${SLUG_CLONE})\n`,
  ],
  // After `volley peer remove` the peer's tunnel service is stopped.
  ["is-active --quiet volley-peer\\.service", 3],
  // git's identity: none before the install (nothing printed), the simulated account's after.
  ["git config --global --get user\\.name", 0, ""],
  [
    "git var GIT_COMMITTER_IDENT",
    0,
    "Volley Sim <1+volley-sim@users.noreply.github.com> 1760000000 +0000\n",
  ],
  ["first-wave/volley-hello-", 0, "Volley Sim,1+volley-sim@users.noreply.github.com\n"],
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
      // A fresh user: no git identity before the install.
      new RegExp(`^ssh ${vm}: .*git config --global --get user\\.email;`),
      // The checkout under test, then its install.sh.
      new RegExp(`^ssh ${vm}: rm -rf ~/volley .*tar -C ~/volley -xzf - \\(stdin \\d+ bytes\\)$`),
      new RegExp(`^ssh ${vm}: .*sh -s -- --source ~/volley --no-setup +<~/volley/install\\.sh$`),
      // One `volley setup`, as a person runs it: it takes the snap's broker steps through sudo.
      new RegExp(
        `^ssh ${vm}: .*eval "\\$\\(volley sim env\\)"; volley setup --yes --no-lan --simulated$`,
      ),
      // The check sees the sign-ins and services setup made: under the simulator too.
      new RegExp(`^ssh ${vm}: .*eval "\\$\\(volley sim env\\)"; volley setup --check --json$`),
      // git commits as the identity setup gave it, and so did the scratch clone.
      new RegExp(`^ssh ${vm}: .*git var GIT_COMMITTER_IDENT$`),
      new RegExp(
        `^ssh ${vm}: .*~/\\.volley/volleyd/first-wave/volley-hello-\\*.*git -C "\\$c" log -1`,
      ),
      // What a person reads: the first wave's status, plain and as JSON, and --check.
      new RegExp(`^ssh ${vm}: .*volley sim env\\)"; volleyd status hello-ab12$`),
      new RegExp(`^ssh ${vm}: .*volley sim env\\)"; volleyd status hello-ab12 --json$`),
      new RegExp(`^ssh ${vm}: .*volley sim env\\)"; volley setup --check$`),
      // A wave on a repository with no CI: volleyd restarted with the drop-in, the wave submitted
      // with VOLLEY_SIM_WORKFLOWS=0, polled, the drop-in gone before the reboot.
      new RegExp(
        `^ssh ${vm}: .*volleyd\\.service\\.d/sim\\.conf.*systemctl --user daemon-reload && systemctl --user restart volleyd\\.service$`,
      ),
      new RegExp(`^ssh ${vm}: .*volley sub --pattern volley/default/volleyd/status`),
      new RegExp(
        `^ssh ${vm}: .*export VOLLEY_SIM_WORKFLOWS=0; bash -s 'first-wave' 'hello-noci' 'Add NOCI\\.md' '' \\(stdin \\d+ bytes\\)$`,
      ),
      new RegExp(`^ssh ${vm}: .*volleyd status hello-noci --json$`),
      new RegExp(`^ssh ${vm}: .*volleyd events hello-noci --cursor vm-linux$`),
      new RegExp(
        `^ssh ${vm}: .*rm -f ~/\\.config/systemd/user/volleyd\\.service\\.d/sim\\.conf && systemctl --user daemon-reload$`,
      ),
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
    expect(r.calls.some((c) => /volley setup --step detect/.test(c))).toBe(false);
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
    expect(Object.keys(m.timings)).toEqual([
      "launch_ms",
      "noci_wave_ms",
      "reboot_ms",
      "reboot_check_ms",
    ]);
    expect(read(w, "status-first-wave.txt")).toContain("coordinator: coordinator on hub");
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

  test("cloud-init's user has a stock cloud image's sudoers: group sudo plus the NOPASSWD drop-in", () => {
    // `%sudo ALL=(ALL:ALL) ALL` as well makes `sudo -v` ask while `sudo <command>` does not (#590).
    const ci = readFileSync(join(HERE, "cloud-init.yaml"), "utf8");
    expect(ci).toMatch(/- name: volley\n(?: {4}\S.*\n)*? {4}groups: \[sudo\]\n/);
    expect(ci).toContain("    sudo: ALL=(ALL) NOPASSWD:ALL\n");
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

  test("a VM with a git identity before the install fails the run (nothing may hide the bug)", () => {
    const w = world();
    const r = run(w, "vm-linux.sh", ["ubuntu-24.04"], {
      rules: [["git config --global --get user\\.name", 0, "someone@example.com\n"]],
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "FAIL: the VM has a git identity before the install (the image or the harness pre-seeded one): someone@example.com",
    );
    expect(r.out).toContain("Layer 2 (ubuntu-24.04) failed.");
  });

  test("a scratch commit by another author fails the run", () => {
    const w = world();
    const r = run(w, "vm-linux.sh", ["ubuntu-24.04"], {
      rules: [["first-wave/volley-hello-", 0, "Volley Sim,sim@volley.invalid\n"]],
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "FAIL: a scratch clone's last commit is by 'Volley Sim,sim@volley.invalid'",
    );
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

  // Two whole runs (Layer 2, then Layer 4's two VMs): a longer timeout keeps it inside a slow CI
  // runner's budget.
  test("--no-lan on a VM with a LAN address: a skipped phone row passes, Layers 2 and 4", () => {
    const skipped = readFileSync(join(FIXTURES, "check-phone-skipped.json"), "utf8");
    for (const [script, args] of [
      ["vm-linux.sh", ["ubuntu-24.04"]],
      ["vm-pair.sh", []],
    ] as const) {
      const w = world();
      const r = run(w, script, [...args], { rules: [["volley setup --check --json", 0, skipped]] });
      expect(read(w, "summary.md")).toContain("skipped (allowed: phone)");
      expect(r.out).not.toContain("a target was missed");
    }
  }, 15_000);

  // The no-CI poll runs out here, busy for the whole cap: a 1 s cap keeps it short.
  test("hello-noci: a ci_pending, or no ci_mode_detected none, fails with the verdict's reason", () => {
    const events = fixture("wave-events-noci.jsonl");
    const pending = `${events}${JSON.stringify({ seq: 9, type: "ci_pending", data: {} })}\n`;
    const w = world();
    const r = run(w, "vm-linux.sh", ["ubuntu-24.04"], {
      env: { VM_MAX_WAIT_S: "1" },
      rules: [["volleyd events hello-noci", 0, pending]],
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("the journal has ci_pending");
    expect(r.out).toContain(
      "FAIL: the wave hello-noci on a repository with no CI did not pass (the line above)",
    );
    // The drop-in is still removed, and the VM deleted.
    expect(r.calls.some((c) => /rm -f .*volleyd\.service\.d\/sim\.conf/.test(c))).toBe(true);
    expect(vmsLeft(w)).toEqual([]);

    const w2 = world();
    const noMode = events
      .split("\n")
      .filter((l) => !l.includes("ci_mode_detected"))
      .join("\n");
    const r2 = run(w2, "vm-linux.sh", ["ubuntu-24.04"], {
      env: { VM_MAX_WAIT_S: "1" },
      rules: [["volleyd events hello-noci", 0, noMode]],
    });
    expect(r2.code).toBe(1);
    expect(r2.out).toContain('no ci_mode_detected { mode: "none" } in the journal');
  }, 15_000);

  test("volleyd status saying 'undefined on undefined' fails the run (#597)", () => {
    const w = world();
    const r = run(w, "vm-linux.sh", ["ubuntu-24.04"], {
      rules: [["volleyd status hello-ab12$", 0, fixture("text-undefined.txt")]],
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL: volleyd status prints 'undefined'");
    expect(read(w, "status-first-wave.txt")).toContain("undefined on undefined");
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
      new RegExp(`^ssh ${HUB}: .*volley peer list$`),
      new RegExp(
        `^ssh ${HUB}: .*bash -s 'first-wave' 'hello-peer' 'Add PEER\\.md' 'peer' \\(stdin \\d+ bytes\\)$`,
      ),
      new RegExp(`^ssh ${HUB}: .*volleyd status hello-peer --json$`),
      new RegExp(`^ssh ${HUB}: .*volleyd events hello-peer --cursor vm-pair$`),
      new RegExp(`^ssh ${HUB}: .*volleyd status hello-peer$`),
      new RegExp(`^ssh ${PEER}: .*git -C .* log --all --format=%H -- src/T1\\.ts`),
      // The slug repository: both machines share the hub's origins over ssh, the peer's git
      // reaches it, the hub creates it and holds no clone, volleyd clones it on the peer.
      new RegExp(`^ssh ${HUB}: .*printf "%s/origins" "\\$VOLLEY_SIM_HOME"$`),
      new RegExp(
        `^ssh ${PEER}: umask 077 && mkdir -p ~/\\.ssh && cat >~/\\.ssh/id_ed25519 \\(stdin \\d+ bytes\\)$`,
      ),
      new RegExp(
        `^ssh ${HUB}: mkdir -p /path/to/home/\\.volley/sim/origins .*cat - ~/\\.bashrc .*\\(stdin \\d+ bytes\\)$`,
      ),
      new RegExp(
        `^ssh ${PEER}: mkdir -p /path/to/home/\\.volley/sim/origins .*cat - ~/\\.bashrc .*\\(stdin \\d+ bytes\\)$`,
      ),
      new RegExp(
        `^ssh ${PEER}: .*git config --global url\\.volley@10\\.20\\.0\\.11:/path/to/home/\\.volley/sim/origins/volley-sim/volley-slug-42\\.git\\.insteadOf https://github\\.com/volley-sim/volley-slug-42\\.git$`,
      ),
      new RegExp(
        `^ssh ${HUB}: .*gh repo create volley-sim/volley-slug-42 --private && .*gh repo clone volley-sim/volley-slug-42 .*HEAD:release/hello-slug`,
      ),
      new RegExp(`^ssh ${HUB}: .*volley repo add volley-sim/volley-slug-42 --machine peer --wait$`),
      new RegExp(`^ssh ${PEER}: .*git -C '${SLUG_CLONE}' rev-parse --git-dir$`),
      new RegExp(
        `^ssh ${HUB}: .*bash -s 'volley-sim/volley-slug-42' 'hello-slug' 'Add SLUG\\.md' 'peer' \\(stdin \\d+ bytes\\)$`,
      ),
      new RegExp(`^ssh ${HUB}: .*volleyd status hello-slug --json$`),
      new RegExp(`^ssh ${HUB}: .*volleyd events hello-slug --cursor vm-pair$`),
      new RegExp(`^ssh ${PEER}: .*git -C '${SLUG_CLONE}' log --all --format=%H -- src/T1\\.ts`),
      new RegExp(`^ssh ${HUB}: .*volley peer remove peer --now$`),
      new RegExp(`^ssh ${PEER}: .*systemctl --user is-active --quiet volley-peer\\.service$`),
      new RegExp(`^multipass delete --purge ${HUB}$`),
      new RegExp(`^multipass delete --purge ${PEER}$`),
    ]);
    expect(vmsLeft(w)).toEqual([]);
    const m = JSON.parse(read(w, "metrics.json"));
    expect(m).toMatchObject({ label: "pair", layer: 4, failures: [] });
    expect(m.timings.pair_ready_ms).toBeNumber();
    expect(m.timings.slug_wave_ms).toBeNumber();
    expect(read(w, "summary.md")).toContain("| `pair_ready_ms` |");
    // Both machines read the same VOLLEY_SIM_ORIGINS line first, the hub's origins over ssh.
    const line = `export VOLLEY_SIM_ORIGINS=volley@10.20.0.11:/path/to/home/.volley/sim/origins; eval "$($HOME/.volley/bin/volley sim env)"`;
    expect(r.calls.filter((c) => c.includes("cat - ~/.bashrc >~/.bashrc.it")).length).toBe(3);
    expect(line.length + 1).toBe(
      Number(
        /\(stdin (\d+) bytes\)$/.exec(
          r.calls.find((c) => c.startsWith(`ssh ${HUB}: mkdir -p`)) ?? "",
        )?.[1],
      ),
    );
  });

  test("hello-slug: a REMOTE_REPO_MISSING fails naming it (#596)", () => {
    const w = world();
    const r = run(w, "vm-pair.sh", [], {
      env: { VM_MAX_WAIT_S: "1" },
      rules: [
        [
          "volleyd events hello-slug",
          0,
          `${JSON.stringify({ seq: 4, type: "spawn_failed", task: "T1", data: { task: "T1", code: "REMOTE_REPO_MISSING" } })}\n`,
        ],
      ],
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("the wave hello-slug hit REMOTE_REPO_MISSING");
    expect(r.out).toContain(
      "FAIL: the wave hello-slug hit REMOTE_REPO_MISSING: volleyd found no clone of volley-sim/volley-slug-42 on peer",
    );
    expect(vmsLeft(w)).toEqual([]);
  }, 15_000);

  test("hello-slug: a peer clone reported at a path that is no clone on the peer fails", () => {
    const w = world();
    const r = run(w, "vm-pair.sh", [], {
      rules: [[`git -C '${SLUG_CLONE}' rev-parse --git-dir`, 128]],
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain(
      `FAIL: the peer's clone is reported at a hub path (${SLUG_CLONE} is no clone on the peer)`,
    );
    const none = world();
    const r2 = run(none, "vm-pair.sh", [], {
      rules: [["volley repo add", 0, "  peer: blocked (no clone)\n"]],
    });
    expect(r2.code).toBe(1);
    expect(r2.out).toContain("FAIL: volley repo add did not report peer ready (repo-add.txt)");
  }, 15_000);

  test("volley repo add or volley peer list saying 'undefined' fails the run", () => {
    const w = world();
    const r = run(w, "vm-pair.sh", [], {
      rules: [["volley peer list$", 0, "peer  undefined  volley@10.20.0.12\n"]],
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL: volley peer list prints 'undefined'");
  });

  // The readiness poll runs out here, busy for the whole cap: a 1 s cap and a longer timeout keep
  // it inside a slow CI runner's budget.
  test("a peer that never gets ready fails with the verdict's reasons; both VMs are deleted", () => {
    const w = world();
    const r = run(w, "vm-pair.sh", [], {
      env: { VM_MAX_WAIT_S: "1" },
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
  }, 15_000);

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

describe("the VM workflow (install-vm.yml)", () => {
  type Step = { name?: string; uses?: string; if?: string; run?: string; with?: { path?: string } };
  const wf = Bun.YAML.parse(
    readFileSync(join(HERE, "../../.github/workflows/install-vm.yml"), "utf8"),
  ) as {
    on: Record<string, { inputs?: Record<string, unknown> } | null>;
    env: Record<string, string>;
    concurrency: { group: string; "cancel-in-progress": boolean };
    jobs: Record<
      string,
      {
        "runs-on": string[] | string;
        needs?: string[];
        if?: string;
        "timeout-minutes"?: number;
        strategy?: { "max-parallel"?: number; matrix: Record<string, string[]> };
        steps?: Step[];
      }
    >;
  };

  test("never on pull_request or push: the schedule and a dispatch (input version only)", () => {
    expect(Object.keys(wf.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(Object.keys(wf.on.workflow_dispatch?.inputs ?? {})).toEqual(["version"]);
    expect(wf.concurrency).toEqual({ group: "install-vm", "cancel-in-progress": false });
  });

  test("linux-vm and pair on the one runner label, and a report; no macOS job", () => {
    expect(Object.keys(wf.jobs)).toEqual(["linux-vm", "pair", "report"]);
    const linux = wf.jobs["linux-vm"];
    expect(linux?.["runs-on"]).toEqual(["self-hosted", "volley-linux-vm"]);
    expect(linux?.strategy?.matrix.distro).toEqual(["ubuntu-24.04", "debian-13"]);
    expect(linux?.strategy?.["max-parallel"]).toBe(1);
    expect(linux?.["timeout-minutes"]).toBe(40);
    expect(wf.jobs.pair?.["runs-on"]).toEqual(["self-hosted", "volley-linux-vm"]);
    expect(wf.jobs.pair?.["timeout-minutes"]).toBe(60);
  });

  test("only the schedule reports to the tracking issue", () => {
    expect(wf.env.VM_TRACK_ISSUE).toBe("${{ github.event_name == 'schedule' && '1' || '' }}");
  });

  test("the report job fails a run that did not pass; only the schedule comments on the issue", () => {
    const report = wf.jobs.report;
    expect(report?.["runs-on"]).toBe("ubuntu-latest");
    expect(report?.needs).toEqual(["linux-vm", "pair"]);
    // Always, so a job that failed or never ran is reported (and only in the canonical repository).
    expect(report?.if).toBe("always() && github.repository == 'kryptek/volley'");
    const script = JSON.stringify(report?.steps ?? []);
    // lib.sh's label and title, so the two never make a second issue.
    expect(script).toContain("install-tests");
    expect(script).toContain("Nightly install tests are failing");
    expect(script).toContain("needs.linux-vm.result");
    expect(script).toContain("needs.pair.result");
    expect(script).not.toMatch(/macos/i);
    expect(script).toContain("github.event_name == 'schedule'");
    const run = report?.steps?.[0]?.run ?? "";
    // The issue's calls sit inside the schedule's branch; the failure is for every event.
    const guarded = run.slice(run.indexOf('if [ "$SCHEDULED" = 1 ]'), run.lastIndexOf("fi"));
    expect(guarded).toContain("gh issue comment");
    expect(run.replace(guarded, "")).not.toContain("gh issue");
    expect(run.trimEnd().endsWith("exit 1")).toBe(true);
  });

  test("no artifact uploads the run's private key or raw transcript", () => {
    const uploads = Object.values(wf.jobs).flatMap((j) =>
      (j.steps ?? []).filter((s) => s.uses?.startsWith("actions/upload-artifact")),
    );
    expect(uploads).toHaveLength(2);
    for (const u of uploads) {
      expect(u.with?.path).toMatch(/^!.+\/\*\*\/key$/m);
      expect(u.with?.path).toMatch(/^!.+\/transcript\.raw$/m);
    }
  });

  const cleanups = () =>
    (["linux-vm", "pair"] as const).map((j) => {
      const steps = wf.jobs[j]?.steps ?? [];
      const i = steps.findIndex((s) => s.name === "Delete this run's VMs");
      return { job: j, steps, i, step: steps[i] };
    });

  test("each VM job deletes this run's VMs in an always() step after the run", () => {
    for (const { steps, i, step } of cleanups()) {
      expect(step?.if).toBe("always()");
      expect(steps.findIndex((s) => s.run?.includes("run-layer"))).toBeLessThan(i);
    }
  });

  test("the cleanup step purges only volley-it-<run id>- VMs and prints the others", () => {
    for (const { step } of cleanups()) {
      const w = world();
      for (const [name, addr] of [
        ["volley-it-42-hub", "10.20.0.11"],
        ["volley-it-other-7-hub", "10.20.0.12"],
        ["unrelated", "10.20.0.13"],
      ] as const) {
        mkdirSync(join(w.state, "vms", name), { recursive: true });
        writeFileSync(join(w.state, "vms", name, "addr"), addr);
      }
      const r = Bun.spawnSync(["bash", "-c", step?.run ?? "exit 9"], {
        env: { PATH: `${STUBS}:/usr/bin:/bin`, STUB_STATE: w.state, GITHUB_RUN_ID: "42" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(r.exitCode).toBe(0);
      expect(vmsLeft(w).sort()).toEqual(["unrelated", "volley-it-other-7-hub"]);
      const out = r.stdout.toString();
      expect(out).toContain("Purging volley-it-42-hub");
      expect(out).toContain("Not this run's, left alone: volley-it-other-7-hub");
      expect(out).not.toContain("unrelated");
    }
  });
});

describe("verify.sh", () => {
  const job = (name: string, conclusion: string | null, status = "completed") => ({
    name,
    status,
    conclusion,
  });
  const JOBS = ["Layer 2 (ubuntu-24.04)", "Layer 2 (debian-13)", "Layer 4 (pair)"];
  const URL = "https://github.com/kryptek/volley/actions/runs/1001";
  const view = (status: string, conclusion: string | null, jobs: object[]) =>
    JSON.stringify({ status, conclusion, url: URL, jobs });
  const passed = view(
    "completed",
    "success",
    JOBS.map((n) => job(n, "success")),
  );
  const queued = view(
    "queued",
    null,
    JOBS.map((n) => job(n, null, "queued")),
  );

  /** The stand-in gh's answers: run list before and after the dispatch, then run view in turn. */
  function verify(
    w: World,
    args: string[],
    opts: {
      views?: string[];
      env?: Record<string, string>;
      artifacts?: Record<string, string>;
    } = {},
  ) {
    writeFileSync(join(w.state, "gh-run-list.1"), '[{"databaseId": 1000}]\n');
    writeFileSync(join(w.state, "gh-run-list.2"), '[{"databaseId": 1001}]\n');
    (opts.views ?? [passed]).forEach((v, i) =>
      writeFileSync(join(w.state, `gh-run-view.${i + 1}`), `${v}\n`),
    );
    for (const [path, content] of Object.entries(opts.artifacts ?? {})) {
      mkdirSync(dirname(join(w.state, "artifacts", path)), { recursive: true });
      writeFileSync(join(w.state, "artifacts", path), content);
    }
    const r = Bun.spawnSync(["bash", join(HERE, "verify.sh"), ...args], {
      cwd: w.dir,
      env: {
        PATH: `${STUBS}:${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: w.dir,
        TMPDIR: w.tmp,
        STUB_STATE: w.state,
        VM_OUT: w.out,
        VERIFY_POLL_S: "0",
        VERIFY_FIND_S: "5",
        ...opts.env,
      },
      stdin: "ignore",
      timeout: 20_000,
      stdout: "pipe",
      stderr: "pipe",
    });
    const log = join(w.state, "calls.log");
    return {
      code: r.exitCode,
      stdout: r.stdout.toString(),
      out: `${r.stdout.toString()}${r.stderr.toString()}`,
      calls: existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n") : [],
    };
  }
  const branch = () =>
    Bun.spawnSync(["git", "-C", HERE, "rev-parse", "--abbrev-ref", "HEAD"])
      .stdout.toString()
      .trim();

  test("no argument dispatches the current branch; the run is the new one gh run list shows", () => {
    const w = world();
    const r = verify(w, []);
    expect(r.code).toBe(0);
    const b = branch();
    expectInOrder(r.calls, [
      /^gh auth status$/,
      new RegExp(
        `^gh run list --workflow install-vm\\.yml --branch ${b} --limit 1 --json databaseId$`,
      ),
      new RegExp(`^gh workflow run install-vm\\.yml --ref ${b}$`),
      new RegExp(
        `^gh run list --workflow install-vm\\.yml --branch ${b} --limit 1 --json databaseId$`,
      ),
      /^gh run view 1001 --json status,conclusion,url,jobs$/,
      /^gh run watch 1001 --exit-status$/,
      /^gh run download 1001 --dir \S+run-1001 --pattern layer\*$/,
    ]);
  });

  test("<branch> dispatches that ref; --version adds the input, and must be vX.Y.Z", () => {
    const w = world();
    const r = verify(w, ["release/2026-10-25-gaps", "--version", "v0.13.2"]);
    expect(r.code).toBe(0);
    expect(r.calls).toContain(
      "gh workflow run install-vm.yml --ref release/2026-10-25-gaps -f version=v0.13.2",
    );
    for (const bad of [["--version", "0.13.2"], ["--version"], ["a", "b"], ["--frob"]]) {
      const w2 = world();
      const u = verify(w2, bad);
      expect(u.code).toBe(2);
      expect(u.out).toContain("usage: verify.sh [<branch>] [--version vX.Y.Z]");
      expect(u.calls).toEqual([]);
    }
  });

  test("a passing run prints three pass rows and the run URL, and exits 0", () => {
    const w = world();
    const metrics = (timings: Record<string, number>) =>
      JSON.stringify({ total_ms: 400_000, timings, setup: { wall_ms: 185_000 } });
    const r = verify(w, ["main"], {
      artifacts: {
        "layer2-ubuntu-24.04/metrics.json": metrics({ noci_wave_ms: 121_000 }),
        "layer2-ubuntu-24.04/failures.md": "",
        "layer4-pair/metrics.json": metrics({ slug_wave_ms: 300_000 }),
      },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("| layer | result | metrics | first failure |");
    expect(r.stdout).toContain(
      "| ubuntu-24.04 | pass | setup 3 m 5 s · install 6 m 40 s · noci_wave_ms 2 m 1 s |  |",
    );
    expect(r.stdout).toMatch(/\| debian-13 \| pass \| — \|/);
    expect(r.stdout).toContain(
      "| pair | pass | setup 3 m 5 s · install 6 m 40 s · slug_wave_ms 5 m 0 s |",
    );
    expect(r.stdout).toContain(`run: ${URL} (success)`);
    expect(r.stdout).not.toContain("Leftover");
    expect(existsSync(join(w.out, "run-1001", "layer2-ubuntu-24.04", "metrics.json"))).toBe(true);
  });

  test("a failing run prints the failing layer's first FAIL line, the URL and the leftover check; exit 1", () => {
    const w = world();
    const failed = view("completed", "failure", [
      job(JOBS[0] as string, "failure"),
      job(JOBS[1] as string, "success"),
      job(JOBS[2] as string, "cancelled"),
    ]);
    const r = verify(w, ["main"], {
      views: [failed],
      artifacts: {
        "layer2-ubuntu-24.04/metrics.json": JSON.stringify({ timings: {} }),
        "layer2-ubuntu-24.04/failures.md":
          "- the wave hello-noci on a repository with no CI did not pass (the line above)\n- volleyd.service is not active after the reboot\n",
      },
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(
      "| ubuntu-24.04 | failure | — | FAIL: the wave hello-noci on a repository with no CI did not pass (the line above) |",
    );
    expect(r.stdout).toContain(
      "| pair | cancelled | — | no artifact: the job did not run its script |",
    );
    expect(r.stdout).toContain(`run: ${URL} (failure)`);
    expect(r.stdout).toContain(
      "Leftover VMs? On the paired Linux machine: multipass list | grep volley-it- (scripts/install-tests/README.md, Cleaning up)",
    );
  });

  test("jobs still queued after VERIFY_QUEUED_S: the no-runner line once, and the wait goes on", () => {
    const w = world();
    const r = verify(w, ["main"], {
      views: [queued, queued, queued, queued, passed],
      env: { VERIFY_QUEUED_S: "0" },
    });
    expect(r.code).toBe(0);
    const line =
      "no runner is online for volley-linux-vm: start the runner service on the paired Linux machine (scripts/install-tests/README.md, The Linux box)";
    expect(r.stdout.split("\n").filter((l) => l === line)).toHaveLength(1);
    expect(r.calls.filter((c) => c.startsWith("gh run view 1001")).length).toBeGreaterThan(4);
    expect(r.calls.filter((c) => c.startsWith("gh workflow run"))).toHaveLength(1);
    // Under the threshold, nothing is said.
    const w2 = world();
    const r2 = verify(w2, ["main"], { views: [queued, passed] });
    expect(r2.stdout).not.toContain("no runner is online");
  });

  test("gh not signed in: exit 2 with one line, nothing dispatched", () => {
    const w = world();
    writeFileSync(join(w.state, "gh-signed-out"), "");
    const r = verify(w, ["main"]);
    expect(r.code).toBe(2);
    expect(r.out.trim()).toBe("verify.sh: gh is not signed in: run gh auth login, then try again");
    expect(r.calls).toEqual(["gh auth status"]);
  });
});
