import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { type RemoteStep, assertAllowed } from "../src/fence";
import type { RemoteHost } from "../src/hosts/ssh-tmux";
import { MACHINE_CHANNEL, type MachineRecord, machineTopic } from "../src/machines";
import type { RoleDeps } from "../src/roles/deps";
import { type MoveRecord, type MoveResult, RoleMoves } from "../src/roles/engine";
import { RoleOps } from "../src/roles/ops";
import type { BrokerDeps, ProbeLink } from "../src/roles/plan-broker";
import { type RolesRecord, defaultRoles } from "../src/roles/record";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { type FakeExec, fakeExec } from "./helpers/fake-exec";
import { PEER, makeFleet } from "./helpers/fleet-env";
import { tempDir } from "./helpers/tmp";

/**
 * The broker move (#470, SPEC §4.6.24) on fakes: the supervisor's machine `control` (the old
 * broker, a Homebrew install), the target `box` and a second paired machine `box2`. A second
 * Aedes plays the new broker: the health check logs in there, and each re-pointed machine
 * "comes up" by publishing its record there, unless it never does.
 */

const VERSION = "0.11.0";
const LOCAL = "control";
const TARGET = "box";
const OTHER = "box2";
const REPLY_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({
  format: "jwk",
});
const STATE = {
  clients: [{ username: "dynsec-admin" }, { username: "volleyd" }, { username: "coordinator" }],
  groups: [],
  roles: [],
};

interface Plan {
  plan_id: string;
  steps: { id: string; title: string; where: string }[];
  blocked: { why: string; fix?: string }[];
  warnings: string[];
  terminal: { where: string; reason: string; command: string }[];
  after: string[];
}

let home: string;
let userHome: string;
let stateFile: string;
let authDir: string;
let newBroker: TestBroker;
let pub: VolleyBroker;
let local: FakeExec;
let now: number;
let roles: RolesRecord;
let written: RolesRecord[];
/** Per machine: the remote steps it ran, joined. */
let remote: Record<string, string[]>;
let probe: Record<string, unknown>;
let sshFails: Set<string>;
let neverUp: Set<string>;
let wsReach: "refused" | "accepted" | "unreachable";
let probed: string[];
let live: { agent_id: string; machine: string }[];
let retargets: { name: string; address: string; port?: number; tunnel?: string }[];
let moving: (string | null)[];
let unitUrls: string[];
let unitFails: boolean;
let finished: Promise<{ id: string; r: MoveResult }>;
let finish: (x: { id: string; r: MoveResult }) => void;

const machine = (name: string, over: Partial<MachineRecord> = {}): MachineRecord => ({
  name,
  os: "linux",
  cores: 8,
  tunnel: "up",
  load: [0, 0, 0],
  agents: 0,
  versions: { peer: VERSION, volley: VERSION, bun: "1.3.1", git: "2.43.0" },
  last_seen: new Date(now).toISOString(),
  ...over,
});

/** A paired machine as a remote host: answers each fenced script the way the machine would. */
function host(name: string): RemoteHost {
  return {
    spec: { name, target: `dev@${name}`, volley_dir: "/opt/volley" },
    run: async (steps: RemoteStep[]) => {
      assertAllowed(["ssh", "-T", `dev@${name}`, "bash", "-s"], { remote: { steps } });
      const lines = steps.map((s) => s.argv.join(" "));
      remote[name] = [...(remote[name] ?? []), lines.join(" && ")];
      const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", timedOut: false });
      const first = lines[0] ?? "";
      if (first === "volley broker probe") return ok(`${JSON.stringify(probe)}\n`);
      if (first.startsWith("ssh -n"))
        return sshFails.has(name)
          ? { code: 255, stdout: "", stderr: "Permission denied (publickey).", timedOut: false }
          : ok();
      if (first === "printenv HOME") return ok(`${userHome}\n`);
      const write = steps.find((s) => s.stdout !== undefined);
      if (write !== undefined) {
        mkdirSync(dirname(write.stdout as string), { recursive: true });
        writeFileSync(write.stdout as string, Buffer.from(write.stdin ?? "", "base64"));
        return ok();
      }
      if (first.startsWith("volley broker receive")) {
        const bundle = steps[0]?.argv[3] as string;
        const stage = tempDir("volleyd-broker-stage-");
        spawnSync("tar", ["-xzf", bundle, "-C", stage]);
        const m = JSON.parse(readFileSync(join(stage, "manifest.json"), "utf-8")) as {
          role: string;
          files: { path: string }[];
        };
        if (m.role !== "broker")
          return { code: 1, stdout: "", stderr: "not a broker bundle", timedOut: false };
        const s = JSON.parse(readFileSync(join(stage, "broker", "dynamic-security.json"), "utf-8"));
        return ok(`mosquitto 2.1.2: ${(s as typeof STATE).clients.length} logins\n`);
      }
      if (first === "volley broker tunnel --show")
        return ok(
          `${JSON.stringify({ host: `me@${LOCAL}`, remote_port: 21883, tunnel: "ssh" })}\n`,
        );
      return ok();
    },
  } as unknown as RemoteHost;
}

function roleDeps(): RoleDeps {
  const hosts = {
    [TARGET]: {
      target: `dev@${TARGET}`,
      volley_dir: "/opt/volley",
      tunnel: { remote_port: 21883, supervise: false },
    },
    [OTHER]: {
      target: `dev@${OTHER}`,
      volley_dir: "/opt/volley",
      tunnel: { remote_port: 21883, supervise: false },
    },
  };
  return {
    localName: LOCAL,
    hosts,
    paired: (n) => n === TARGET || n === OTHER,
    record: (n) => (n === LOCAL ? undefined : machine(n)),
    version: VERSION,
    get roles() {
      return roles;
    },
    remote: (n) => host(n),
    exec: local.exec,
    platform: "linux",
    uid: 501,
    home: "/path/to/home",
    volleydHome: home,
    brokerHost: "studio.lan",
    localHost: "studio.lan",
    localPortBusy: async () => false,
    writeRoles: async (r) => {
      roles = r;
      written.push(r);
    },
    now: () => new Date(now),
    sleep: async (ms) => {
      now += ms;
    },
  } as RoleDeps;
}

/** A login at the new broker (whatever URL the move names: its tunnel leads there). */
async function link(): Promise<ProbeLink> {
  const b = new VolleyBroker();
  await b.connect({ url: newBroker.url, agentId: "volleyd-probe" });
  return {
    sysVersion: async () => "mosquitto version 2.1.2",
    machine: async (name) => {
      const raw = await b.queryRetained(machineTopic(name), 100);
      const p = raw === null ? null : (parseEnvelope(raw)?.payload as MachineRecord);
      return p === null ? null : { tunnel: p.tunnel, last_seen: p.last_seen };
    },
    close: () => b.disconnect(),
  };
}

function brokerDeps(): BrokerDeps {
  return {
    busyWaves: () => [],
    liveAgents: () => live,
    install: () => ({ layout: "brew-arm64", stateFile, authDir }),
    brokerUrl: "mqtt://127.0.0.1:1883",
    unitUrl: async (url) => {
      if (unitFails) throw new Error("systemctl --user daemon-reload: exit 1");
      unitUrls.push(url);
      return { line: `VOLLEY_BROKER_URL is ${url} already.`, undo: async () => {} };
    },
    connect: () => link(),
    probeAnonymous: async (url) => {
      probed.push(url);
      return url.startsWith("ws:") ? wsReach : "refused";
    },
    retarget: async (r, _by, up) => {
      retargets.push(r);
      const since = now;
      // The machine restarts its tunnel; through the new broker its record comes up (or not).
      if (!neverUp.has(r.name))
        await pub.publish(
          machineTopic(r.name),
          JSON.stringify(
            buildEnvelope({
              agentId: r.name,
              parentId: null,
              channel: MACHINE_CHANNEL,
              type: "machine",
              payload: machine(r.name, { last_seen: new Date(now).toISOString() }),
            }),
          ),
          { qos: 1, retain: true },
        );
      return (await up(r.name, since))
        ? null
        : `"${r.name}" retargeted its tunnel to ${r.address}, but its record did not come up through it within 120 s`;
    },
    moving: (id) => {
      moving.push(id);
    },
  };
}

function ops(): RoleOps {
  const moves = new RoleMoves({
    home,
    now: () => new Date(now),
    publish: async () => {},
    clear: async () => {},
    journal: () => {},
    log: () => {},
  });
  return new RoleOps({
    deps: () => roleDeps(),
    supervisor: () => {
      throw new Error("not a supervisor move");
    },
    broker: () => brokerDeps(),
    moves,
    finished: async (id, r) => finish({ id, r }),
    log: () => {},
    sleep: async () => {},
  });
}

beforeEach(async () => {
  home = tempDir("volleyd-broker-home-");
  userHome = tempDir("volleyd-broker-user-");
  const etc = tempDir("volleyd-broker-etc-");
  stateFile = join(etc, "dynamic-security.json");
  authDir = join(etc, "volley");
  mkdirSync(authDir);
  writeFileSync(stateFile, JSON.stringify(STATE));
  writeFileSync(
    join(authDir, "admin.json"),
    JSON.stringify({ username: "dynsec-admin", password: "x" }),
  );
  newBroker = await startTestBroker();
  pub = new VolleyBroker();
  await pub.connect({ url: newBroker.url, agentId: "machines" });
  now = Date.parse("2026-10-24T10:00:00.000Z");
  roles = defaultRoles({
    machine: LOCAL,
    mqttPort: 1883,
    wsPort: 9001,
    lan: false,
    deskUrl: "http://studio.lan:5199",
    now: new Date(now).toISOString(),
  });
  written = [];
  remote = {};
  probe = { layout: "brew-arm64", needs_root: false, mosquitto: "2.1.2" };
  sshFails = new Set();
  neverUp = new Set();
  wsReach = "refused";
  probed = [];
  live = [];
  retargets = [];
  moving = [];
  unitUrls = [];
  unitFails = false;
  local = fakeExec().on(["tar"], (argv) => {
    const r = spawnSync("tar", argv.slice(1));
    return { code: r.status ?? 1, stderr: r.stderr.toString() };
  });
  finished = new Promise((r) => {
    finish = r;
  });
});
afterEach(async () => {
  await pub.disconnect();
  await newBroker.close();
});

const plan = async (o: RoleOps, extra: Record<string, unknown> = {}) => {
  const a = await o.handle("role_plan", { role: "broker", to: TARGET, ...extra }, "admin-1");
  expect(a.error).toBeUndefined();
  return a.result as Plan;
};

const localLines = () => local.calls.map((c) => c.argv.join(" "));

describe("the broker move's plan (#470)", () => {
  it("lists every step with where it runs, the split warning and the owner's one-line fix", async () => {
    const p = await plan(ops());
    expect(p.blocked).toEqual([]);
    expect(p.steps.map((s) => `${s.id}@${s.where}`)).toEqual([
      `stop@${LOCAL}`,
      `bundle@${LOCAL}`,
      `copy@${TARGET}`,
      `receive@${TARGET}`,
      `tunnel@${LOCAL}`,
      `health@${LOCAL}`,
      `retarget-1@${TARGET}`,
      `retarget-2@${OTHER}`,
      `desk@${LOCAL}`,
      `record@${LOCAL}`,
    ]);
    expect(p.warnings.join("\n")).toMatch(/the broker leaves the supervisor's machine \(control\)/);
    expect(p.after.join("\n")).toContain(
      "volley setup --step claude-code --broker-url mqtt://127.0.0.1:1883",
    );
    expect(p.terminal).toEqual([]);
    // One probe on the target; ssh to the address from here and from the other paired machine.
    expect(remote[TARGET]).toContain("volley broker probe");
    expect(remote[OTHER]).toEqual([
      `ssh -n -o BatchMode=yes -o ConnectTimeout=10 dev@${TARGET} true`,
    ]);
    expect(localLines()).toContain(
      `ssh -n -o BatchMode=yes -o ConnectTimeout=10 dev@${TARGET} true`,
    );
    // Planning changed nothing.
    expect(localLines().some((l) => l.startsWith("brew"))).toBe(false);
  });

  it("no mosquitto on the target: a blocker with the install hint", async () => {
    probe = {
      layout: "etc",
      needs_root: true,
      mosquitto: null,
      error: "no mosquitto (mosquitto -h printed no version)",
    };
    const p = await plan(ops());
    const b = p.blocked.find((x) => x.why.startsWith(`${TARGET}: no mosquitto`));
    expect(b?.fix).toMatch(/snap install mosquitto/);
  });

  it("a snap layout on the target: the receive is a terminal command there", async () => {
    probe = { layout: "snap", needs_root: true, mosquitto: "2.1.2" };
    const p = await plan(ops());
    expect(p.blocked).toEqual([]);
    expect(p.terminal).toEqual([
      expect.objectContaining({
        where: TARGET,
        command: "sudo volley broker receive ~/.volley/roles/broker/bundle.tgz --no-lan",
      }),
    ]);
    expect(p.steps.find((s) => s.id === "receive")?.title).toMatch(
      /Wait for `sudo volley broker receive`/,
    );
  });

  it("a paired machine that cannot ssh to the address blocks, naming it", async () => {
    sshFails.add(OTHER);
    const p = await plan(ops(), { address: "owner@box.lan" });
    expect(p.blocked.map((b) => b.why)).toEqual([
      `${OTHER} cannot ssh to owner@box.lan: Permission denied (publickey).`,
    ]);
  });

  it("lan on and 9001 unreachable from the Desk's host: blocked", async () => {
    wsReach = "unreachable";
    const p = await plan(ops(), { lan: true });
    expect(p.blocked.map((b) => b.why)).toEqual([
      `ws://${TARGET}:9001 is not reachable from ${LOCAL}, where the Desk's page loads (lan: true)`,
    ]);
    wsReach = "accepted";
    expect((await plan(ops(), { lan: true })).blocked).toEqual([]);
  });

  it("a live agent blocks (a move with drain: true waits for it instead)", async () => {
    live = [{ agent_id: "w1-t1-implementer-1", machine: OTHER }];
    const o = ops();
    const p = await plan(o);
    expect(p.blocked.map((b) => b.why)).toEqual([`agent w1-t1-implementer-1 is live on ${OTHER}`]);
    const a = await o.handle(
      "role_move",
      { role: "broker", to: TARGET, plan_id: p.plan_id, reply_key: REPLY_KEY },
      "admin-1",
    );
    expect(a.error).toMatch(/^the fleet is not quiet: agent w1-t1-implementer-1/);
  });

  it("refuses an address that is not an ssh destination, and a broker already there", async () => {
    const o = ops();
    expect(
      (
        await o.handle(
          "role_plan",
          { role: "broker", to: TARGET, address: "-oProxyCommand=x" },
          "a",
        )
      ).error,
    ).toMatch(/address must be an ssh destination/);
    expect((await o.handle("role_plan", { role: "broker", to: LOCAL }, "a")).error).toBe(
      `broker already runs on ${LOCAL}`,
    );
  });
});

/** Run a move to its end: its answer (as it starts), then the engine's result. */
async function move(o: RoleOps, extra: Record<string, unknown> = {}) {
  const p = await plan(o, extra);
  const a = await o.handle(
    "role_move",
    { role: "broker", to: TARGET, plan_id: p.plan_id, reply_key: REPLY_KEY, ...extra },
    "admin-1",
  );
  expect(a.error).toBeUndefined();
  expect(a.result).toMatchObject({ status: "running", handing_over: true });
  const done = await finished;
  return { id: (a.result as { move_id: string }).move_id, r: done.r };
}

const record = (id: string) =>
  JSON.parse(readFileSync(join(home, "roles", id, "move.json"), "utf-8")) as MoveRecord;

describe("the broker move (#470)", () => {
  it("stops, bundles, copies, receives, tunnels, checks, re-points every machine, tells the Desk, records", async () => {
    const o = ops();
    const { id, r } = await move(o);
    expect(r).toMatchObject({ ok: true, status: "done" });
    const rec = record(id);
    expect(rec.steps.map((s) => `${s.id}:${s.status}`)).toEqual([
      "stop:ok",
      "bundle:ok",
      "copy:ok",
      "receive:ok",
      "tunnel:ok",
      "health:ok",
      "retarget-1:ok",
      "retarget-2:ok",
      "desk:ok",
      "record:ok",
    ]);
    expect(rec.steps.find((s) => s.id === "receive")?.line).toBe("mosquitto 2.1.2: 3 logins");
    // Here: the old broker stopped first, the bundle, the own tunnel, the Desk re-told.
    const here = localLines().filter((l) => !l.startsWith("ssh -n"));
    expect(here).toEqual([
      "brew services stop mosquitto",
      expect.stringMatching(/^tar -czf .*\/bundle\.tgz -C .*\/stage --files-from .*\/files\.txt$/),
      `volley broker tunnel --to dev@${TARGET} --port 1883 --name ${LOCAL} --broker-port 1883`,
      `volley desk install --port 5199 --broker-host ${TARGET}`,
    ]);
    expect(unitUrls).toEqual(["mqtt://127.0.0.1:1883"]);
    expect(moving).toEqual([id]);
    // The target: the bundle at the fixed path, received without root.
    expect(existsSync(join(userHome, ".volley", "roles", "broker", "bundle.tgz"))).toBe(true);
    expect(remote[TARGET]).toContain(
      `volley broker receive ${userHome}/.volley/roles/broker/bundle.tgz --no-lan`,
    );
    // The target loses its tunnel (the broker is there now); the other one points at the address.
    expect(retargets).toEqual([
      { name: TARGET, address: `dev@${TARGET}`, port: 1883, tunnel: "none" },
      { name: OTHER, address: `dev@${TARGET}`, tunnel: "ssh" },
    ]);
    // The record carries the address; what each machine had is kept for a rollback.
    expect(roles.broker).toEqual({
      machine: TARGET,
      address: { ssh: `dev@${TARGET}`, mqtt_port: 1883, ws_port: 9001 },
      lan: false,
    });
    expect(roles.version).toBe(2);
    expect((rec.kept as { peers: Record<string, unknown> }).peers).toEqual({
      [TARGET]: { host: `me@${LOCAL}`, remote_port: 21883, tunnel: "ssh" },
      [OTHER]: { host: `me@${LOCAL}`, remote_port: 21883, tunnel: "ssh" },
    });
  });

  it("a machine that never comes back up: every retarget undone, the old broker restarted, failed + rolled_back", async () => {
    neverUp.add(OTHER);
    const o = ops();
    const { id, r } = await move(o);
    expect(r).toMatchObject({ ok: false, status: "failed", step: "retarget-2", rolled_back: true });
    const rec = record(id);
    expect(rec.status).toBe("failed");
    expect(rec.error).toMatch(/box2.*did not come up/);
    // Both put back on their tunnel to the old machine, the one that timed out first.
    const back = { address: `me@${LOCAL}`, port: 21883, tunnel: "ssh" };
    expect(retargets).toEqual([
      { name: TARGET, address: `dev@${TARGET}`, port: 1883, tunnel: "none" },
      { name: OTHER, address: `dev@${TARGET}`, tunnel: "ssh" },
      { name: OTHER, ...back },
      { name: TARGET, ...back },
    ]);
    const here = localLines();
    expect(here.indexOf("volley broker tunnel --off")).toBeGreaterThan(-1);
    // The own tunnel off before the old broker starts again (its port is the tunnel's until then).
    expect(here.indexOf("brew services start mosquitto")).toBeGreaterThan(
      here.indexOf("volley broker tunnel --off"),
    );
    expect(written).toEqual([]);
    expect(roles.broker.machine).toBe(LOCAL);
  });

  it("the own tunnel up but its unit not re-pointed: the tunnel taken down before the old broker starts", async () => {
    unitFails = true;
    const o = ops();
    const { r } = await move(o);
    expect(r).toMatchObject({ ok: false, status: "failed", step: "tunnel", rolled_back: true });
    const here = localLines();
    const off = here.indexOf("volley broker tunnel --off");
    expect(off).toBeGreaterThan(-1);
    expect(here.indexOf("brew services start mosquitto")).toBeGreaterThan(off);
    expect(retargets).toEqual([]);
    expect(roles.broker.machine).toBe(LOCAL);
  });

  it("role_rollback after a done move undoes it from the move's record", async () => {
    const first = ops();
    const { id } = await move(first);
    finished = new Promise((r) => {
      finish = r;
    });
    retargets = [];
    local.calls.length = 0;
    const o = ops();
    const a = await o.handle("role_rollback", { move_id: id }, "admin-1");
    expect(a.error).toBeUndefined();
    expect(a.result).toMatchObject({ rolls_back: id, handing_over: true });
    const back = await finished;
    expect(back.r).toMatchObject({ ok: true, status: "done" });
    expect(record(back.id).steps.map((s) => s.id)).toEqual([
      "tunnel",
      "start",
      "health",
      "retarget-1",
      "retarget-2",
      "desk",
      "record",
    ]);
    expect(localLines()).toEqual([
      "volley broker tunnel --off",
      "brew services start mosquitto",
      "volley desk install --port 5199 --broker-host studio.lan",
    ]);
    expect(retargets).toEqual([
      { name: TARGET, address: `me@${LOCAL}`, port: 21883, tunnel: "ssh" },
      { name: OTHER, address: `me@${LOCAL}`, port: 21883, tunnel: "ssh" },
    ]);
    expect(roles.broker.machine).toBe(LOCAL);
    expect(roles.broker.address.ssh).toBeNull();
    expect(record(id).status).toBe("rolled_back");
  });
});

describe("the broker move's rollback health check (#470)", () => {
  it("probes the old broker's own WebSocket port when it was on the LAN", async () => {
    roles = {
      ...roles,
      broker: { ...roles.broker, address: { ...roles.broker.address, ws_port: 9443 }, lan: true },
    };
    // The move itself keeps the target off the LAN: what the rollback probes is the old broker's.
    const { id } = await move(ops(), { lan: false });
    finished = new Promise((r) => {
      finish = r;
    });
    probed = [];
    const a = await ops().handle("role_rollback", { move_id: id }, "admin-1");
    expect(a.error).toBeUndefined();
    expect((await finished).r).toMatchObject({ ok: true, status: "done" });
    expect(probed.filter((u) => u.startsWith("ws:"))).toEqual(["ws://studio.lan:9443"]);
  });
});

describe("the daemon answers a broker plan (#470)", () => {
  it("role_plan { role: broker } is routed to the broker planner, with the daemon's deps", async () => {
    const f = await makeFleet();
    try {
      f.exec.on(["ssh", "-T"], async () => ({ stdout: `${JSON.stringify(probe)}\n` }));
      const a = await f.adminOp({ op: "role_plan", role: "broker", to: PEER, lan: false });
      expect(a?.error).toBeUndefined();
      const p = a?.result as Plan;
      expect(p.steps.map((s) => s.id)).toContain("retarget-1");
      // This supervisor's machine has no setup.json: nothing to bundle the broker from.
      expect(p.blocked.map((b) => b.why)).toContain(
        "no broker install is recorded on control (setup.json)",
      );
      const bad = await f.adminOp({ op: "role_plan", role: "broker", to: PEER, lan: "yes" });
      expect(bad?.error).toBe("lan must be true or false");
    } finally {
      await f.close();
    }
  });
});
