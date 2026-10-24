import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DoctorReport } from "volley-cli/machine/add";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { authOpsTopic, authReplyTopic } from "../src/accounts";
import { Daemon } from "../src/daemon";
import type { ExecFn, ExecOptions, ExecResult } from "../src/exec";
import { assertAllowed } from "../src/fence";
import {
  type MachineAddEnv,
  type MachineRow,
  parseMachineAdd,
  runMachineAdd,
} from "../src/machine-add";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { eventually } from "./helpers/broker-wait";
import { NO_PRESSURE, NS } from "./helpers/daemon-env";
import { fakeExec } from "./helpers/fake-exec";
import { GREEN_DOCTOR as GREEN } from "./helpers/fake-host";
import { tempDir } from "./helpers/tmp";

/**
 * `machine_add` (SPEC §4.6.14): volley-cli's `volley machine add` step list, run by volleyd for
 * the Desk without a terminal, against a fake box: each ssh step's script is answered by what it
 * asks (the probe, the key install, install.sh, setup, the ssh-back keys, the join, the doctor).
 * Every argv also passes the real fence, so a step volleyd could not run fails the test.
 */

const ADDRESS = "dev@box-a";
const PASSWORD = "hunter2-correct-horse";
const SUDO = "s3cret-sudo-pass";
const CODE = "WXYZ-2345";
const BOX_KEY = "ssh-ed25519 AAAAC3NzaBOX dev@box";
const HUB_KEY = "ssh-ed25519 AAAAC3NzaHUB hub@hub";
/** The fleet's green report, as the doctor on a box prints it. */
const GREEN_DOCTOR = GREEN as unknown as DoctorReport;

interface Box {
  /** Whether this machine's key is in the box's authorized_keys (BatchMode works). */
  keyed: boolean;
  /** What the probe reports missing (only sudo installs it). */
  missing: string[];
  /** Calls, in order: argv, the script, the env's askpass. */
  calls: { argv: readonly string[]; input?: string; askpass?: string }[];
  /** What the askpass helper printed, and the mode of the file it read. */
  asked: { said: string; mode: number }[];
  /** The install.sh run's script. */
  install?: string;
  /** Fail this step (a script containing the marker) with this stderr. */
  fail?: { marker: string; stderr: string };
  /** The doctor's report. */
  report: DoctorReport;
}

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });

function fakeBox(box: Box): ExecFn {
  return async (argv: readonly string[], opts: ExecOptions = {}) => {
    // The real fence first: what volleyd could not run, the box never sees.
    assertAllowed(argv, opts);
    const input = opts.input ?? "";
    const askpass = opts.env?.SSH_ASKPASS;
    box.calls.push({ argv, input, ...(askpass ? { askpass } : {}) });
    if (askpass !== undefined) {
      const said = spawnSync(askpass, [], { encoding: "utf-8" }).stdout;
      const dir = askpass.slice(0, askpass.lastIndexOf("/"));
      const file = readdirSync(dir).find((f) => f !== "askpass") ?? "";
      box.asked.push({ said, mode: statSync(join(dir, file)).mode & 0o777 });
      if (said !== PASSWORD)
        return { code: 255, stdout: "", stderr: "Permission denied", timedOut: false };
    }
    if (box.fail !== undefined && input.includes(box.fail.marker)) {
      return { code: 1, stdout: "", stderr: box.fail.stderr, timedOut: false };
    }
    if (input.includes('printf "missing=%s')) {
      if (!box.keyed && askpass === undefined && !argv.includes("-i")) {
        return { code: 255, stdout: "", stderr: "Permission denied (publickey).", timedOut: false };
      }
      return ok(`os=Linux\nvolley=\npeer=\nmissing=${box.missing.join(" ")}\n`);
    }
    if (input.includes('"$HOME/.ssh/authorized_keys" || printf')) {
      box.keyed = true;
      return ok();
    }
    if (input.includes("set -- --peer --version")) {
      box.install = input;
      return ok("installed volley in peer mode\n");
    }
    if (input.includes("volley setup --peer --yes")) return ok("✓ set up\n");
    if (input.includes("volley-pubkey="))
      return ok(`volley-key-created\nvolley-pubkey=${BOX_KEY}\n`);
    if (input.includes("volley peer join")) {
      // The box echoes the code it was given: the run must hide it.
      return ok(`joined with ${/volley peer join '([^']+)'/.exec(input)?.[1] ?? "?"}\n`);
    }
    if (input.includes("volley peer doctor --json")) return ok(JSON.stringify(box.report));
    return { code: 127, stdout: "", stderr: `unexpected step: ${argv.join(" ")}`, timedOut: false };
  };
}

function env(box: Box, home: string, tmp: string): MachineAddEnv {
  return {
    exec: fakeBox(box),
    home,
    platform: "linux",
    version: "0.5.0",
    installer: () => "#!/bin/sh\necho install.sh\n",
    hostKeys: () => [],
    hub: "hub@10.0.0.2",
    tmp,
  };
}

function setup(o: Partial<Box> = {}) {
  const home = tempDir("volleyd-machine-add-home-");
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh", "id_ed25519.pub"), `${HUB_KEY}\n`);
  const tmp = tempDir("volleyd-machine-add-tmp-");
  const box: Box = { keyed: false, missing: [], calls: [], asked: [], report: GREEN_DOCTOR, ...o };
  const rows: MachineRow[] = [];
  const minted: string[] = [];
  const hub = {
    paired: () => [] as string[],
    hosts: () => [] as string[],
    mint: (name: string) => {
      minted.push(name);
      return CODE;
    },
  };
  return { home, tmp, box, rows, minted, hub, e: env(box, home, tmp) };
}

describe("parseMachineAdd", () => {
  it("takes an address, a key or a password, a sudo password and a name", () => {
    expect(
      parseMachineAdd({ address: ADDRESS, auth: { password_ref: PASSWORD }, sudo_ref: SUDO }),
    ).toEqual({ address: ADDRESS, name: "box-a", password: PASSWORD, sudo: SUDO });
    expect(
      parseMachineAdd({ address: ADDRESS, auth: { key: "/path/to/key" }, name: "lab-1" }),
    ).toEqual({ address: ADDRESS, name: "lab-1", key: "/path/to/key" });
  });

  it("refuses a bad address, both or neither auth, a relative key and a bad name", () => {
    const bad = [
      {},
      { address: "-oProxyCommand=x", auth: { key: "/k" } },
      { address: "dev@box a", auth: { key: "/k" } },
      { address: "box-a", auth: { key: "/k" } },
      { address: ADDRESS },
      { address: ADDRESS, auth: {} },
      { address: ADDRESS, auth: { key: "/k", password_ref: "x" } },
      { address: ADDRESS, auth: { key: "id_ed25519" } },
      { address: ADDRESS, auth: { password_ref: "" } },
      { address: ADDRESS, auth: { key: "/k" }, name: "Bad Name" },
      { address: ADDRESS, auth: { key: "/k" }, name: "volleyd" },
      { address: ADDRESS, auth: { key: "/k" }, sudo_ref: 7 },
    ];
    for (const p of bad) expect(typeof parseMachineAdd(p), JSON.stringify(p)).toBe("string");
  });
});

describe("runMachineAdd (the step list without a terminal)", () => {
  it("with a password: askpass reads a 0600 file, removed after the step; then BatchMode; rows stream", async () => {
    const s = setup();
    const req = { address: ADDRESS, name: "box-a", password: PASSWORD };
    const r = await runMachineAdd(req, s.e, s.hub, (row) => s.rows.push(row));
    expect(r).toMatchObject({ ok: true, result: { name: "box-a", target: ADDRESS, ready: true } });
    // ssh asked the helper once, which read the password from a 0600 file…
    expect(s.box.asked).toEqual([{ said: PASSWORD, mode: 0o600 }]);
    // …that is gone after the step (the whole helper directory is).
    expect(readdirSync(s.tmp)).toEqual([]);
    const pw = s.box.calls.filter((c) => c.askpass !== undefined);
    expect(pw).toHaveLength(1);
    expect(pw[0]?.argv).toContain("PreferredAuthentications=password,keyboard-interactive");
    // Every other step is BatchMode with this machine's key.
    for (const c of s.box.calls.filter((c) => c.askpass === undefined))
      expect(c.argv).toContain("BatchMode=yes");
    // The code was minted for the name, and the box redeemed it.
    expect(s.minted).toEqual(["box-a"]);
    // The box's key is authorized here (join reaches this machine over ssh).
    expect(readFileSync(join(s.home, ".ssh", "authorized_keys"), "utf-8")).toContain(BOX_KEY);
    // Rows arrive per step, 1..7, in order.
    const steps = [...new Set(s.rows.map((x) => x.step))];
    expect(steps).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(s.rows[0]).toMatchObject({ step: 1, total: 7, title: "ssh", state: "running" });
  });

  it("no row and no answer carries the password, the sudo password or the pairing code", async () => {
    const s = setup({ missing: ["git", "tmux"] });
    const req = { address: ADDRESS, name: "box-a", password: PASSWORD, sudo: SUDO };
    const r = await runMachineAdd(req, s.e, s.hub, (row) => s.rows.push(row));
    expect(r.ok).toBe(true);
    const text = JSON.stringify([r, s.rows]);
    for (const secret of [PASSWORD, SUDO, CODE]) expect(text).not.toContain(secret);
    // Nor any argv: secrets travel on stdin only.
    for (const c of s.box.calls) expect(c.argv.join(" ")).not.toMatch(/hunter2|s3cret|WXYZ/);
  });

  it("sudo only when the box lacks what only sudo installs: announced first, through SUDO_ASKPASS", async () => {
    const s = setup({ missing: ["git", "tmux"] });
    const req = { address: ADDRESS, name: "box-a", password: PASSWORD, sudo: SUDO };
    await runMachineAdd(req, s.e, s.hub, (row) => s.rows.push(row));
    const install = s.box.install ?? "";
    // The password reaches the box base64 on stdin, into a 0600 file a trap removes.
    expect(install).toContain(Buffer.from(SUDO).toString("base64"));
    expect(install).not.toContain(SUDO);
    expect(install).toMatch(/trap 'rm -rf "\$volley_sudo"' EXIT/);
    expect(install).toMatch(/SUDO_ASKPASS=.*-A/);
    const lines = s.rows.filter((x) => x.step === 2).map((x) => x.line ?? "");
    const announce = lines.findIndex((l) => /lacks git, tmux: the installer runs sudo/.test(l));
    const run = lines.findIndex((l) => /install\.sh --peer/.test(l));
    expect(announce).toBeGreaterThanOrEqual(0);
    expect(announce).toBeLessThan(run);

    // A box with everything in place gets no sudo prelude, given a sudo password or not.
    const t = setup();
    await runMachineAdd({ ...req }, t.e, t.hub, () => {});
    expect(t.box.install).not.toContain("volley_sudo");
  });

  it("a box that needs sudo, without a sudo password: fails at step 2 naming the fix", async () => {
    const s = setup({ missing: ["tmux"] });
    const r = await runMachineAdd(
      { address: ADDRESS, name: "box-a", password: PASSWORD },
      s.e,
      s.hub,
      (row) => s.rows.push(row),
    );
    expect(r).toMatchObject({ ok: false, step: 2 });
    expect(r.ok ? "" : r.error).toMatch(/^step 2 \(Volley\): .*lacks tmux.*give its sudo password/);
    expect(s.rows.at(-1)).toMatchObject({ step: 2, state: "failed" });
    expect(s.box.install).toBeUndefined();
  });

  it("a wrong password fails step 1, naming the fix; the helper directory is still removed", async () => {
    const s = setup();
    const r = await runMachineAdd(
      { address: ADDRESS, name: "box-a", password: "wrong" },
      s.e,
      s.hub,
      (row) => s.rows.push(row),
    );
    expect(r).toMatchObject({ ok: false, step: 1 });
    expect(r.ok ? "" : r.error).toMatch(
      /^step 1 \(ssh\): .*check the address and the key or password/,
    );
    expect(readdirSync(s.tmp)).toEqual([]);
    expect(JSON.stringify([r, s.rows])).not.toContain("wrong\n");
  });

  it("with the person's key: ssh -i <key>, never an askpass", async () => {
    const s = setup();
    const key = join(s.home, ".ssh", "lab_key");
    writeFileSync(key, "PRIVATE");
    const r = await runMachineAdd({ address: ADDRESS, name: "box-a", key }, s.e, s.hub, () => {});
    expect(r.ok).toBe(true);
    expect(s.box.calls.some((c) => c.argv.includes("-i") && c.argv.includes(key))).toBe(true);
    expect(s.box.calls.every((c) => c.askpass === undefined)).toBe(true);
  });

  it("a key that does not exist is refused before anything runs", async () => {
    const s = setup();
    const r = await runMachineAdd(
      { address: ADDRESS, name: "box-a", key: "/path/to/missing" },
      s.e,
      s.hub,
      () => {},
    );
    expect(r).toMatchObject({ ok: false });
    expect(s.box.calls).toEqual([]);
  });

  it("a host configured by hand is refused before anything runs", async () => {
    const s = setup();
    const r = await runMachineAdd(
      { address: ADDRESS, name: "box-a", password: PASSWORD },
      s.e,
      { ...s.hub, hosts: () => ["box-a"] },
      () => {},
    );
    expect(r.ok ? "" : r.error).toMatch(/configured by hand/);
    expect(s.box.calls).toEqual([]);
  });

  it("ends with the readiness: not ready, the sign-ins missing, each failing check", async () => {
    const report: DoctorReport = {
      ...GREEN_DOCTOR,
      auth: { gh: "unauthenticated", claude: "not_signed_in", trust: "ok" },
      checks: [
        {
          id: "gh.auth",
          ok: false,
          severity: "block",
          detail: "gh signed out",
          fix: "gh auth login",
        },
      ],
    } as unknown as DoctorReport;
    const s = setup({ keyed: true, report });
    const r = await runMachineAdd(
      { address: ADDRESS, name: "box-a", password: PASSWORD },
      s.e,
      s.hub,
      (row) => s.rows.push(row),
    );
    expect(r).toMatchObject({
      ok: true,
      result: { ready: false, signin: { gh: false, claude: false }, checks: report.checks },
    });
    // Already keyed: no password step at all.
    expect(s.box.asked).toEqual([]);
    expect(s.rows.some((x) => x.step === 6 && /sign-in buttons/.test(x.line ?? ""))).toBe(true);
  });
});

describe("machine_add (the admin op, its rows on the reply topic)", () => {
  const USERS = ["volleyd", "admin-1", "steer-1"];
  const pw = (u: string) => `${u}-pw`;
  const canPublish = (user: string | undefined, topic: string) =>
    user === "volleyd" ||
    (topic.startsWith("volley/_system/auth/ops/")
      ? topic === authOpsTopic(user ?? "")
      : !topic.startsWith("volley/_system/auth/"));
  let broker: TestBroker;
  let vhome: string;
  let daemon: Daemon;
  let s: ReturnType<typeof setup>;
  let release: (() => void) | undefined;
  const logs: string[] = [];
  const clients: VolleyBroker[] = [];

  beforeEach(async () => {
    broker = await startTestBroker({
      users: Object.fromEntries(USERS.map((u) => [u, pw(u)])),
      canPublish,
    });
    vhome = tempDir("volleyd-machine-add-daemon-");
    s = setup({ missing: ["git"] });
    release = undefined;
    logs.length = 0;
    const box = s.e.exec;
    const gated: ExecFn = async (argv, opts) => {
      // The doctor step waits for the test when it holds the run open.
      if (release !== undefined && opts?.input?.includes("volley peer doctor --json")) {
        await new Promise<void>((r) => {
          const prev = release;
          release = () => {
            prev?.();
            r();
          };
        });
      }
      return box(argv, opts);
    };
    const auth = fakeExec().on(["volley", "auth", "list"], {
      stdout: JSON.stringify({
        accounts: [
          { name: "admin-1", role: "admin", kind: "human", created: "2026-10-19T09:00:00.000Z" },
          { name: "steer-1", role: "steer", kind: "human", created: "2026-10-19T09:00:00.000Z" },
        ],
      }),
    });
    daemon = await Daemon.start({
      brokerUrl: broker.url,
      namespace: NS,
      home: vhome,
      tickMs: 0,
      protocolVersion: 4,
      pressure: NO_PRESSURE,
      auth: { username: "volleyd", password: pw("volleyd") },
      authExec: auth.exec,
      log: (l) => logs.push(l),
      machineAdd: { ...s.e, exec: gated },
    });
  });
  afterEach(async () => {
    release?.();
    for (const c of clients.splice(0)) {
      // broker round-trip: a client the ACL refused may never complete its DISCONNECT.
      await Promise.race([c.disconnect().catch(() => {}), new Promise((r) => setTimeout(r, 300))]);
      c.simulateCrash();
    }
    await daemon.stop();
    await broker.close();
  });

  /** One account op as `user`: every envelope on its reply topic, until the ack. */
  async function op(user: string, payload: Record<string, unknown>) {
    const c = new VolleyBroker();
    await c.connect({
      url: broker.url,
      agentId: `cli-${randomUUID().slice(0, 6)}`,
      username: user,
      password: pw(user),
    });
    clients.push(c);
    const cid = randomUUID();
    const seen: { type: string; payload: Record<string, unknown> }[] = [];
    let resolve!: (p: Record<string, unknown>) => void;
    const reply = new Promise<Record<string, unknown>>((r) => {
      resolve = r;
    });
    await c.subscribeStream(authReplyTopic(cid), ({ payload: raw }) => {
      const env = parseEnvelope(raw);
      if (env === null || env.correlation_id !== cid) return;
      seen.push({ type: env.type, payload: env.payload as Record<string, unknown> });
      if (env.type === "ack") resolve(env.payload as Record<string, unknown>);
    });
    const env = buildEnvelope({
      agentId: user,
      parentId: null,
      channel: "_system/auth",
      type: "query",
      correlationId: cid,
      payload,
    });
    await c.publish(authOpsTopic(user), JSON.stringify(env), { qos: 1, retain: false });
    return { reply, seen };
  }

  const REQ = {
    op: "machine_add",
    address: ADDRESS,
    auth: { password_ref: PASSWORD },
    sudo_ref: SUDO,
  };

  it("from an admin: progress rows on the reply topic as they happen, then the answer", async () => {
    const { reply, seen } = await op("admin-1", REQ);
    const r = await reply;
    expect(r).toMatchObject({
      ok: true,
      op: "machine_add",
      result: { name: "box-a", ready: true },
    });
    const rows = seen.filter((m) => m.type === "progress").map((m) => m.payload);
    expect(rows.length).toBeGreaterThan(7);
    expect(rows[0]).toMatchObject({ op: "machine_add", step: 1, total: 7, title: "ssh" });
    // Every row came before the answer.
    expect(seen.at(-1)?.type).toBe("ack");
  });

  it("no journal line, log line or reply carries a password", async () => {
    const { reply, seen } = await op("admin-1", REQ);
    await reply;
    // A failing run too: its error and its log line.
    s.box.fail = { marker: "volley setup --peer --yes", stderr: `setup failed ${PASSWORD}` };
    const failed = await op("admin-1", { ...REQ, name: "box-b" });
    expect(await failed.reply).toMatchObject({ ok: false });
    const journal = readdirSync(vhome, { recursive: true })
      .map((f) => join(vhome, String(f)))
      .filter((f) => existsSync(f) && statSync(f).isFile())
      .map((f) => readFileSync(f, "utf-8"))
      .join("\n");
    const text = [journal, logs.join("\n"), JSON.stringify(seen), JSON.stringify(failed.seen)].join(
      "\n",
    );
    expect(journal).toContain("machine_added");
    for (const secret of [PASSWORD, SUDO, Buffer.from(SUDO).toString("base64")])
      expect(text).not.toContain(secret);
    // The pairing code volleyd minted reached the box, and no row shows it.
    expect(text).toContain("joined with <code>");
    expect(text).not.toMatch(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
  });

  it("from a non-admin: refused up front, nothing runs", async () => {
    const { reply } = await op("steer-1", REQ);
    const r = await reply;
    expect(r).toMatchObject({ ok: false, op: "machine_add" });
    expect(r.error).toMatch(/admin/);
    expect(s.box.calls).toEqual([]);
  });

  it("a second machine_add for the same name while one runs is refused", async () => {
    release = () => {};
    const first = await op("admin-1", REQ);
    // Wait until the first run is at its doctor (it holds the name).
    await eventually(() => s.box.calls.some((c) => c.input?.includes("volley-pubkey=")), {
      what: "the first machine_add at its doctor",
    });
    const second = await op("admin-1", REQ);
    const r = await second.reply;
    expect(r).toMatchObject({ ok: false, op: "machine_add" });
    expect(r.error).toMatch(/already being added/);
    release();
    expect(await first.reply).toMatchObject({ ok: true });
  });
});
