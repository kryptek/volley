import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { parseDocument } from "yaml";
import { authOpsTopic, authReplyTopic } from "../src/accounts";
import { ROLES_TOPIC } from "../src/control";
import { type Daemon, daemonClientId } from "../src/daemon";
import type { ExecOptions } from "../src/exec";
import { MACHINE_CHANNEL, type MachineRecord, machineTopic } from "../src/machines";
import type { MoveRecord } from "../src/roles/engine";
import type { ProbeLink } from "../src/roles/plan-broker";
import { type RolesRecord, defaultRoles, rolesFile } from "../src/roles/record";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { eventually } from "./helpers/broker-wait";
import { NS } from "./helpers/daemon-env";
import { GREEN_DOCTOR } from "./helpers/fake-host";
import { type Fleet, LOCAL, PEER, VERSION, makeFleet } from "./helpers/fleet-env";
import { tempDir } from "./helpers/tmp";

/**
 * Machine roles end to end (SPEC §4.6.24; #473): the three moves through real daemons on fake
 * machines, each followed by its `role_rollback`, in the order the owner's smoke runs them.
 *
 *   control  the supervisor's machine: the broker, the supervisor and the Desk start here
 *   box      a paired machine (tmux): the Desk, then the supervisor move there and back
 *   box-b    a second paired machine: the broker moves there and back, the Desk staying
 *
 * Two Aedes brokers: the fleet's (`old`, the broker on control at 127.0.0.1:1883) and `new` (the
 * broker on box-b once received). Every machine's scripts are answered here as its `ssh -T`
 * (fake-host.ts / fake-exec.ts): the supervisor's receive restores its bundle into that machine's
 * home and a second daemon starts there; a paired machine's re-pairing redeems its code on the
 * supervisor; a retarget publishes the machine's record through the broker its tunnel now leads
 * to. control's own 127.0.0.1:1883 leads to the old broker until its tunnel is up, then to the new
 * one; the broker's stop and the tunnel taken down end volleyd's own connection, and a daemon
 * starts again on the broker its unit names (what the service manager does).
 */

const BOX_B = "box-b";
const OWN_URL = "mqtt://127.0.0.1:1883";
const REPLY_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({
  format: "jwk",
});
const WITH_TMUX = { peer: VERSION, volley: VERSION, bun: "1.3.1", git: "2.43.0", tmux: "3.4" };
const BOX_B_HOST = `  ${BOX_B}:\n    target: dev@${BOX_B}\n    volley_dir: /opt/volley\n    tunnel: { remote_port: 21883, supervise: false }\n`;

interface Plan {
  plan_id: string;
  steps: { id: string; where: string }[];
  blocked: { why: string }[];
}
type Answer = Record<string, unknown> | null;

let f: Fleet;
let oldBroker: TestBroker;
let newBroker: TestBroker;
/** One client per broker: the machines' records, and what the test reads there. */
let atOld: VolleyBroker;
let atNew: VolleyBroker;
/** The machines' homes (`printenv HOME`), and each $VOLLEYD_HOME a supervisor runs from. */
const userHome: Record<string, string> = {};
const volleydHome: Record<string, string> = {};
/** Where control's 127.0.0.1:1883 leads: the old broker (running or stopped), or the tunnel. */
let oldUp = true;
let tunnel: string | null = null;
const links: string[] = [];
const unitUrls: string[] = [];
const retargets: string[] = [];
let daemon: Daemon;
const moves: Record<string, string> = {};

const brokerOf = (address: string) => (address === `dev@${BOX_B}` ? newBroker : oldBroker);
const clientOf = (b: TestBroker) => (b === newBroker ? atNew : atOld);

/** Machine `name`'s record through broker `b`, as its peer service publishes it. */
async function heartbeat(b: TestBroker, name: string): Promise<void> {
  const record: MachineRecord = {
    name,
    os: "linux",
    cores: 8,
    tunnel: "up",
    load: [0.5, 0.5, 0.5],
    agents: 0,
    memory: { total_mb: 32768, available_pct: 70 },
    checks: GREEN_DOCTOR.checks.map(({ id, ok, severity, detail }) => ({
      id,
      ok,
      severity,
      detail,
    })),
    versions: WITH_TMUX,
    auth: { gh: "ok", claude: "signed_in", trust: "ok" },
    doctor_at: GREEN_DOCTOR.doctor_at,
    last_seen: new Date(f.clock.now()).toISOString(),
  };
  await clientOf(b).publish(
    machineTopic(name),
    JSON.stringify(
      buildEnvelope({
        agentId: name,
        parentId: null,
        channel: MACHINE_CHANNEL,
        type: "machine",
        payload: record,
      }),
    ),
    { qos: 1, retain: true },
  );
}

/**
 * Wait for `pred`, the fake clock moving on meanwhile (a move's health retries and a broker
 * move's answer-first pause sleep on it).
 */
async function until(pred: () => boolean | Promise<boolean>, what: string): Promise<void> {
  let first = true;
  await eventually(
    async () => {
      if (!first) await f.clock.advance(100);
      first = false;
      return pred();
    },
    { deadlineMs: 10_000, what },
  );
}

/** A retained topic's payload at broker `b`, or null. */
async function retained<T>(b: TestBroker, topic: string): Promise<T | null> {
  const raw = await clientOf(b).queryRetained(topic, 300);
  return raw === null || raw === "" ? null : ((parseEnvelope(raw)?.payload ?? null) as T | null);
}
const moveAt = (b: TestBroker, id: string) =>
  retained<{ status: string; steps: { id: string; status: string; line?: string }[] }>(
    b,
    `volley/_system/roles/moves/${id}`,
  );
const rolesAt = (b: TestBroker) => retained<RolesRecord>(b, ROLES_TOPIC);
/** A move's record in a supervisor's home (a broker move's topic waits for the reconnect). */
const recordIn = (home: string, id: string): MoveRecord | null => {
  const file = join(home, "roles", id, "move.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as MoveRecord) : null;
};

/** An admin op as `admin-1` at broker `b`: its answer. */
async function adminOp(b: TestBroker, payload: Record<string, unknown>): Promise<Answer> {
  if (b === oldBroker) return f.adminOp(payload);
  const c = new VolleyBroker();
  await c.connect({ url: b.url, agentId: `cli-${randomUUID().slice(0, 6)}` });
  const cid = randomUUID();
  let resolve!: (p: Answer) => void;
  const reply = new Promise<Answer>((r) => {
    resolve = r;
  });
  await c.subscribeStream(authReplyTopic(cid), ({ payload: raw }) => {
    const e = parseEnvelope(raw);
    if (e?.type === "ack" && e.agent_id === "volleyd" && e.correlation_id === cid)
      resolve(e.payload as Record<string, unknown>);
  });
  await c.publish(
    authOpsTopic("admin-1"),
    JSON.stringify(
      buildEnvelope({
        agentId: "admin-1",
        parentId: null,
        channel: "_system/auth",
        type: "query",
        correlationId: cid,
        payload,
      }),
    ),
    { qos: 1, retain: false },
  );
  // broker round-trip: bound the wait for the answer.
  const timer = setTimeout(() => resolve(null), 5000);
  const r = await reply;
  clearTimeout(timer);
  await c.disconnect();
  return r;
}

async function plan(b: TestBroker, role: string, to: string): Promise<Plan> {
  const a = await adminOp(b, { op: "role_plan", role, to });
  expect(a, `no answer to role_plan ${role} → ${to}`).not.toBeNull();
  expect(a?.error).toBeUndefined();
  return a?.result as Plan;
}

/** Plan and move `role` to `to` at broker `b`; the move's answer. */
async function move(b: TestBroker, role: string, to: string): Promise<Answer> {
  const p = await plan(b, role, to);
  expect(p.blocked).toEqual([]);
  const answer = adminOp(b, {
    op: "role_move",
    role,
    to,
    plan_id: p.plan_id,
    reply_key: REPLY_KEY,
  });
  let a: Answer | undefined;
  void answer.then((x) => {
    a = x;
  });
  await until(() => a !== undefined, `the ${role} move's answer`);
  expect(a?.error).toBeUndefined();
  return a as Answer;
}

async function rollback(b: TestBroker, moveId: string): Promise<Answer> {
  const answer = adminOp(b, { op: "role_rollback", move_id: moveId });
  let a: Answer | undefined;
  void answer.then((x) => {
    a = x;
  });
  await until(() => a !== undefined, `the rollback of ${moveId}`);
  expect(a?.error).toBeUndefined();
  return a as Answer;
}

/** A supervisor that ended itself (a lost broker during a broker move): resolved once closed. */
async function ended(d: Daemon): Promise<void> {
  let closed = false;
  void d.closed.then(() => {
    closed = true;
  });
  await until(() => closed, "the supervisor to end on its lost broker connection");
}

/** Start the supervisor in `home` on broker `b` (its unit's VOLLEY_BROKER_URL). */
async function startSupervisor(home: string, b: TestBroker): Promise<Daemon> {
  daemon = await f.env.start({
    ...f.options,
    home,
    brokerUrl: b.url,
    roleBroker: {
      // Through whatever control's 127.0.0.1:1883 leads to now.
      connect: async (url): Promise<ProbeLink> => {
        links.push(url);
        const to = tunnel !== null ? brokerOf(tunnel) : oldUp ? oldBroker : null;
        if (to === null) throw new Error("connect ECONNREFUSED 127.0.0.1:1883");
        const c = new VolleyBroker();
        await c.connect({ url: to.url, agentId: "volleyd-probe" });
        return {
          sysVersion: async () => "mosquitto version 2.1.2",
          machine: async (name) => {
            const raw = await c.queryRetained(machineTopic(name), 300);
            const p = raw === null ? null : (parseEnvelope(raw)?.payload as MachineRecord);
            return p === null ? null : { tunnel: p.tunnel, last_seen: p.last_seen };
          },
          close: () => c.disconnect(),
        };
      },
      probeAnonymous: async () => "refused",
      unitUrl: async (url) => {
        unitUrls.push(url);
        return { line: `VOLLEY_BROKER_URL=${url}`, undo: async () => {} };
      },
    },
  });
  return daemon;
}

/**
 * `volley role receive supervisor <bundle> --from <old>` on `machine`: the bundle restored into
 * its $VOLLEYD_HOME (existing files replaced), its config made this machine's own, and the
 * hand-over told how this machine reaches the old one.
 */
function receiveSupervisor(machine: string, line: string): void {
  const [, , , , bundle = "", , from = ""] = line.split(" ");
  const stage = tempDir("volleyd-e2e-receive-");
  const x = spawnSync("tar", ["-xzf", bundle, "-C", stage]);
  expect(x.status, x.stderr.toString()).toBe(0);
  const home = volleydHome[machine] as string;
  cpSync(join(stage, "volleyd"), home, { recursive: true });
  const doc = parseDocument(readFileSync(join(home, "config.yaml"), "utf-8"));
  doc.deleteIn(["hosts", machine]);
  doc.setIn(["fleet", "local_name"], machine);
  writeFileSync(join(home, "config.yaml"), doc.toString());
  const peers = JSON.parse(readFileSync(join(home, "peers.json"), "utf-8")) as {
    peers: Record<string, unknown>;
  };
  delete peers.peers[machine];
  writeFileSync(join(home, "peers.json"), JSON.stringify(peers));
  const { move_id } = JSON.parse(readFileSync(join(stage, "manifest.json"), "utf-8")) as {
    move_id: string;
  };
  const file = join(home, "roles", move_id, "handover.json");
  writeFileSync(
    file,
    JSON.stringify({ ...JSON.parse(readFileSync(file, "utf-8")), old_target: `dev@${from}` }),
  );
}

/** What `machine` answers to one remote script (its steps, joined). */
async function onMachine(
  machine: string,
  lines: string[],
  opts: ExecOptions,
): Promise<{ code?: number; stdout?: string; stderr?: string }> {
  const first = lines[0] ?? "";
  if (first === "printenv HOME") return { stdout: `${userHome[machine]}\n` };
  const write = opts.remote?.steps.find((s) => s.stdout?.endsWith("/bundle.tgz"));
  if (write !== undefined) {
    mkdirSync(dirname(write.stdout as string), { recursive: true });
    writeFileSync(write.stdout as string, Buffer.from(write.stdin ?? "", "base64"));
    return {};
  }
  // Nothing listens on the Desk's port there.
  if (first.startsWith("nc -z")) return { code: 1 };
  if (first.startsWith("volley role receive supervisor")) {
    receiveSupervisor(machine, first);
    return {};
  }
  if (first.startsWith("volley peer join")) {
    const argv = first.split(" ");
    const at = (flag: string) => argv[argv.indexOf(flag) + 1] as string;
    const r = await f.client.request("peer_join", {
      code: argv[3],
      name: at("--name"),
      target: at("--target"),
      volley_dir: "/opt/volley",
      tunnel: "none",
      reply_key: REPLY_KEY,
    });
    return { code: r.ok ? 0 : 1, stderr: r.error ?? "" };
  }
  if (first === "volley broker probe")
    return {
      stdout: `${JSON.stringify({ layout: "etc", needs_root: false, mosquitto: "2.1.2" })}\n`,
    };
  if (first.startsWith("volley broker receive")) return { stdout: "mosquitto 2.1.2: 3 logins\n" };
  if (first === "volley broker tunnel --show")
    return {
      stdout: `${JSON.stringify({ host: `dev@${LOCAL}`, remote_port: 21883, tunnel: "ssh" })}\n`,
    };
  if (first.startsWith("volley peer retarget")) {
    // The machine's tunnel restarts; its record comes up through the broker it leads to.
    const address = first.split(" ")[4] as string;
    retargets.push(`${machine} ${first.slice("volley peer retarget ".length)}`);
    await heartbeat(brokerOf(address), machine);
    return {};
  }
  return {};
}

/** The fleet, both brokers and every machine's answers. */
async function setup(): Promise<void> {
  oldUp = true;
  tunnel = null;
  links.length = 0;
  unitUrls.length = 0;
  retargets.length = 0;
  for (const r of [userHome, volleydHome, moves]) for (const k of Object.keys(r)) delete r[k];
  f = await makeFleet({ extraConfig: BOX_B_HOST, perMachine: true });
  oldBroker = f.env.broker;
  newBroker = await startTestBroker();
  atOld = new VolleyBroker();
  await atOld.connect({ url: oldBroker.url, agentId: "machines-old" });
  atNew = new VolleyBroker();
  await atNew.connect({ url: newBroker.url, agentId: "machines-new" });
  // A supervisor that stopped cleanly once: its first start there never waits out the probe.
  await atNew.publish(
    `volley/${NS}/volleyd/status`,
    JSON.stringify(
      buildEnvelope({
        agentId: "volleyd",
        parentId: null,
        channel: "status",
        type: "done",
        payload: { reason: "shutdown" },
      }),
    ),
    { qos: 1, retain: true },
  );
  for (const m of [LOCAL, PEER, BOX_B]) userHome[m] = tempDir(`volleyd-e2e-${m}-`);
  volleydHome[LOCAL] = f.env.home;
  volleydHome[PEER] = tempDir("volleyd-e2e-box-home-");

  // control's broker as `volley setup` recorded it (Homebrew, port 1883), box-b paired too.
  const etc = tempDir("volleyd-e2e-etc-");
  writeFileSync(
    join(etc, "dynamic-security.json"),
    JSON.stringify({ clients: [{ username: "dynsec-admin" }, { username: "volleyd" }] }),
  );
  writeFileSync(join(etc, "admin.json"), JSON.stringify({ username: "dynsec-admin" }));
  writeFileSync(
    join(f.env.home, "setup.json"),
    JSON.stringify({
      layout: "brew-arm64",
      config: join(etc, "mosquitto.conf"),
      state_file: join(etc, "dynamic-security.json"),
      auth_dir: etc,
      desk_host: "control.lan",
      desk_port: 5199,
      lan: false,
    }),
  );
  writeFileSync(
    rolesFile(f.env.home),
    JSON.stringify(
      defaultRoles({
        machine: LOCAL,
        mqttPort: 1883,
        wsPort: 9001,
        lan: false,
        deskUrl: "http://control.lan:5199",
        now: new Date(f.clock.now()).toISOString(),
      }),
    ),
  );
  const peers = JSON.parse(readFileSync(join(f.env.home, "peers.json"), "utf-8"));
  peers.peers[BOX_B] = { target: `dev@${BOX_B}`, joined_at: "2026-10-19T09:00:00.000Z" };
  writeFileSync(join(f.env.home, "peers.json"), JSON.stringify(peers));

  f.exec.on(["ssh", "-T"], (argv, opts) => {
    const target = argv.find((a) => a.startsWith("dev@")) as string;
    const lines = (opts.remote?.steps ?? []).map((s) => s.argv.join(" "));
    return onMachine(target.slice("dev@".length), lines, opts);
  });
  f.auth
    .on(["tar"], (argv) => {
      const r = spawnSync("tar", argv.slice(1));
      return { code: r.status ?? 1, stderr: r.stderr.toString() };
    })
    // The old broker stops: every connection to it ends, volleyd's own first.
    .on(["brew", "services", "stop", "mosquitto"], () => {
      oldUp = false;
      oldBroker.dropClient(daemonClientId(NS));
      return {};
    })
    .on(["brew", "services", "start", "mosquitto"], () => {
      oldUp = true;
      return {};
    })
    .on(["volley", "broker", "tunnel"], (argv) => {
      if (argv[3] === "--to") tunnel = argv[4] as string;
      else if (argv[3] === "--off" && tunnel !== null) {
        newBroker.dropClient(daemonClientId(NS));
        tunnel = null;
      }
      return {};
    });
  daemon = await f.restart();
  await heartbeat(oldBroker, BOX_B);
  await f.beat({ versions: WITH_TMUX });
}

afterEach(async () => {
  await atNew?.disconnect();
  await atOld?.disconnect();
  await f?.close();
  await newBroker?.close();
});

const roles = () => JSON.parse(readFileSync(rolesFile(f.env.home), "utf-8")) as RolesRecord;

/** The Desk moves to box and back. */
async function desk(): Promise<void> {
  const a = await move(oldBroker, "desk", PEER);
  expect(a?.result).toMatchObject({ status: "done" });
  moves.desk = (a?.result as { move_id: string }).move_id;
  expect(roles().desk).toEqual({ machine: PEER, url: `http://${PEER}:5199` });
  expect((await rolesAt(oldBroker))?.desk.machine).toBe(PEER);

  const b = await rollback(oldBroker, moves.desk);
  expect(b?.result).toMatchObject({ rolls_back: moves.desk });
  expect(roles().desk).toEqual({ machine: LOCAL, url: "http://control.lan:5199" });
  expect((await moveAt(oldBroker, moves.desk))?.status).toBe("rolled_back");
  expect((await rolesAt(oldBroker))?.desk.machine).toBe(LOCAL);
}

/** The supervisor hands itself over to box, which re-pairs control; then back. */
async function supervisor(): Promise<void> {
  const a = await move(oldBroker, "supervisor", PEER);
  expect(a?.result).toMatchObject({ status: "running", handing_over: true });
  const there = (a?.result as { move_id: string }).move_id;
  moves.supervisor = there;
  // control's supervisor bundles, copies, receives there and unloads itself.
  await until(
    () => f.auth.argvs(["systemctl", "--user", "stop", "volleyd.service"]).length === 1,
    "control's supervisor to unload itself",
  );
  await daemon.stop();
  const onBox = await startSupervisor(volleydHome[PEER] as string, oldBroker);
  await until(
    async () => (await moveAt(oldBroker, there))?.status === "done",
    "box to finish the hand-over",
  );
  expect((await moveAt(oldBroker, there))?.steps.map((s) => `${s.id}:${s.status}`)).toEqual([
    "bundle:ok",
    "copy:ok",
    "receive:ok",
    "handover:ok",
    "working:ok",
    "repair:ok",
    "record:ok",
  ]);
  expect((await rolesAt(oldBroker))?.supervisor.machine).toBe(PEER);
  // control is box's paired machine now; its peer service reports there.
  await heartbeat(oldBroker, LOCAL);
  await until(async () => {
    const r = await f.client.request("peers", {});
    return (r.result as { machines: MachineRecord[] }).machines.some((m) => m.name === LOCAL);
  }, "control's record on box's supervisor");

  // The rollback is a supervisor move the other way: box hands itself back to control.
  const b = await rollback(oldBroker, there);
  expect(b?.result).toMatchObject({ rolls_back: there, handing_over: true });
  const back = (b?.result as { move_id: string }).move_id;
  await until(
    () => f.auth.argvs(["systemctl", "--user", "stop", "volleyd.service"]).length === 2,
    "box's supervisor to unload itself",
  );
  await onBox.stop();
  await startSupervisor(f.env.home, oldBroker);
  await until(
    async () => (await moveAt(oldBroker, back))?.status === "done",
    "control to finish the hand-back",
  );
  expect((await moveAt(oldBroker, there))?.status).toBe("rolled_back");
  expect((await rolesAt(oldBroker))?.supervisor.machine).toBe(LOCAL);
  expect(
    f.system().find((e) => e.type === "role_rolled_back" && e.data.move_id === there),
  ).toBeDefined();
}

/** The broker moves to box-b with the Desk staying, every machine re-pointed; then back. */
async function broker(): Promise<void> {
  await heartbeat(oldBroker, PEER);
  await heartbeat(oldBroker, BOX_B);
  const onControl = daemon;
  const a = await move(oldBroker, "broker", BOX_B);
  expect(a?.result).toMatchObject({ status: "running", handing_over: true });
  const there = (a?.result as { move_id: string }).move_id;
  moves.broker = there;
  await until(() => recordIn(f.env.home, there)?.status === "done", "the broker move");
  // The old broker stopped under volleyd: it ends, and its service starts it on the tunnel.
  await ended(onControl);
  expect(tunnel).toBe(`dev@${BOX_B}`);
  expect(unitUrls).toEqual([OWN_URL]);
  expect(retargets).toEqual([
    `${PEER} --to dev@${BOX_B} --tunnel ssh`,
    `${BOX_B} --to dev@${BOX_B} --port 1883 --tunnel none`,
  ]);
  const onNew = await startSupervisor(f.env.home, newBroker);
  await until(
    async () => (await rolesAt(newBroker))?.broker.machine === BOX_B,
    "the roles record on the new broker",
  );
  const r = (await rolesAt(newBroker)) as RolesRecord;
  expect(r.broker).toEqual({
    machine: BOX_B,
    address: { ssh: `dev@${BOX_B}`, mqtt_port: 1883, ws_port: 9001 },
    lan: false,
  });
  expect(r.desk.machine).toBe(LOCAL);
  expect(r.supervisor.machine).toBe(LOCAL);
  expect((await moveAt(newBroker, there))?.steps.every((s) => s.status === "ok")).toBe(true);
  expect(
    f.auth
      .argvs(["volley", "desk", "install"])
      .map((x) => x.join(" "))
      .at(-1),
  ).toBe(`volley desk install --port 5199 --broker-host ${BOX_B}`);

  retargets.length = 0;
  const b = await rollback(newBroker, there);
  expect(b?.result).toMatchObject({ rolls_back: there, handing_over: true });
  const back = (b?.result as { move_id: string }).move_id;
  await until(() => recordIn(f.env.home, back)?.status === "done", "the broker rollback");
  await ended(onNew);
  expect(tunnel).toBeNull();
  expect(oldUp).toBe(true);
  expect(retargets).toEqual([
    `${PEER} --to dev@${LOCAL} --port 21883 --tunnel ssh`,
    `${BOX_B} --to dev@${LOCAL} --port 21883 --tunnel ssh`,
  ]);
  await startSupervisor(f.env.home, oldBroker);
  await until(
    async () => (await moveAt(oldBroker, there))?.status === "rolled_back",
    "the broker move marked rolled back on the old broker",
  );
  const after = (await rolesAt(oldBroker)) as RolesRecord;
  expect(after.broker).toEqual({
    machine: LOCAL,
    address: { ssh: null, mqtt_port: 1883, ws_port: 9001 },
    lan: false,
  });
  expect((await moveAt(oldBroker, back))?.status).toBe("done");
  expect(
    f.auth
      .argvs(["volley", "desk", "install"])
      .map((x) => x.join(" "))
      .at(-1),
  ).toBe("volley desk install --port 5199 --broker-host control.lan");
}

describe("machine roles end to end (#473)", () => {
  it("the Desk, the supervisor and the broker each move and roll back; the record follows each", async () => {
    await setup();
    await desk();
    await supervisor();
    await broker();
    // The roles record's whole history: every move and every rollback, in order, once each.
    const history = f
      .system()
      .filter((e) => e.type === "roles_changed")
      .map((e) => {
        const r = e.data.roles as RolesRecord;
        return `${r.broker.machine}/${r.supervisor.machine}/${r.desk.machine}`;
      });
    expect(history).toEqual([
      // The first start's defaults, then the record setup() writes.
      `${LOCAL}/${LOCAL}/${LOCAL}`,
      `${LOCAL}/${LOCAL}/${LOCAL}`,
      `${LOCAL}/${LOCAL}/${PEER}`,
      `${LOCAL}/${LOCAL}/${LOCAL}`,
      `${LOCAL}/${PEER}/${LOCAL}`,
      `${LOCAL}/${LOCAL}/${LOCAL}`,
      `${BOX_B}/${LOCAL}/${LOCAL}`,
      `${LOCAL}/${LOCAL}/${LOCAL}`,
    ]);
    expect(
      f
        .system()
        .filter((e) => e.type === "role_rolled_back")
        .map((e) => e.data.move_id),
    ).toEqual([moves.desk, moves.supervisor, moves.broker]);
    // Every probe link went through control's own 127.0.0.1:1883, whatever it led to.
    expect(links.length).toBeGreaterThan(0);
    expect(new Set(links)).toEqual(new Set([OWN_URL]));
  }, 60_000);
});
