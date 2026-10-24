import { spawnSync } from "node:child_process";
import { constants, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { ControlClient } from "../src/control";
import type { ExecOptions } from "../src/exec";
import type { RolesRecord } from "../src/roles/record";
import { eventually } from "./helpers/broker-wait";
import { type Fleet, LOCAL, PEER, VERSION, makeFleet } from "./helpers/fleet-env";
import { tempDir } from "./helpers/tmp";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const REPLY_KEY = publicKey.export({ format: "jwk" });
const unseal = (sealed: unknown) =>
  JSON.parse(
    privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(sealed as string, "base64url"),
    ).toString(),
  ) as Record<string, string>;

interface Plan {
  plan_id: string;
  steps: { id: string; where: string; title: string }[];
  blocked: { why: string; fix?: string }[];
  warnings: string[];
  after: string[];
}

const BOX_B = "box-b";
/** A second paired machine the target must reach over ssh. */
const EXTRA = `  ${BOX_B}:\n    target: dev@${BOX_B}\n    volley_dir: /opt/volley\n    tunnel: { remote_port: 21884, supervise: false }\n`;
const WITH_TMUX = { peer: VERSION, volley: VERSION, bun: "1.3.1", git: "2.43.0", tmux: "3.4" };

let fleet: Fleet | undefined;
afterEach(async () => {
  await fleet?.close();
  fleet = undefined;
});

/** The box's answers to each remote script (by its steps, joined); null: exit 0. */
type OnBox = (
  lines: string[],
  opts: ExecOptions,
) => Promise<{ code?: number; stdout?: string; stderr?: string } | null>;

async function setup(onBox: OnBox = async () => null) {
  const f = await makeFleet({ extraConfig: EXTRA });
  fleet = f;
  f.exec.on(["ssh", "-T"], async (_argv, opts: ExecOptions) => {
    const lines = (opts.remote?.steps ?? []).map((s) => s.argv.join(" "));
    return (await onBox(lines, opts)) ?? {};
  });
  return f;
}

const plan = async (f: Fleet, extra: Record<string, unknown> = {}) => {
  const a = await f.adminOp({ op: "role_plan", role: "supervisor", to: PEER, ...extra });
  expect(a?.error).toBeUndefined();
  return a?.result as Plan;
};

describe("the supervisor move's plan (#469)", () => {
  it("lists the old supervisor's steps, then the new one's, each with where it runs", async () => {
    const f = await setup();
    await f.beat({ versions: WITH_TMUX });
    const p = await plan(f);
    expect(p.blocked).toEqual([]);
    expect(p.warnings).toEqual([]);
    expect(p.steps.map((s) => `${s.id}@${s.where}`)).toEqual([
      `bundle@${LOCAL}`,
      `copy@${PEER}`,
      `receive@${PEER}`,
      `handover@${LOCAL}`,
      `working@${PEER}`,
      `repair@${LOCAL}`,
      `record@${PEER}`,
    ]);
    expect(p.after.join(" ")).toMatch(/volleyd resume <wave>/);
    // The ssh-back probe ran on the box, to the other paired machine.
    const probes = f.exec.calls
      .filter((c) => c.argv[0] === "ssh")
      .flatMap((c) => (c.opts.remote?.steps ?? []).map((s) => s.argv.join(" ")))
      .filter((l) => l.startsWith("ssh -n"));
    expect(probes).toEqual([`ssh -n -o BatchMode=yes -o ConnectTimeout=10 dev@${BOX_B} true`]);
  });

  it("a target with neither cmux nor tmux: a warning, and --local-agents never on the receive", async () => {
    const f = await setup();
    const p = await plan(f);
    expect(p.warnings).toEqual([
      `agents will not run on ${PEER}: it has neither cmux nor tmux (fleet.local_agents: never there)`,
    ]);
    expect(p.blocked).toEqual([]);
  });

  it("blocks on gh without write access, and names a machine the target cannot ssh to", async () => {
    const f = await setup(async (lines) =>
      lines.some((l) => l.includes(`dev@${BOX_B} true`))
        ? { code: 255, stderr: `ssh: connect to host ${BOX_B} port 22: Connection refused` }
        : null,
    );
    await f.beat({
      versions: WITH_TMUX,
      auth: { gh: "no_write", claude: "signed_in", trust: "ok" },
    });
    const p = await plan(f);
    expect(p.blocked.map((b) => b.why)).toEqual([
      `${PEER}'s gh login has no write access to the repositories`,
      `${PEER} cannot ssh to ${BOX_B} (dev@${BOX_B}): ssh: connect to host ${BOX_B} port 22: Connection refused`,
    ]);
    const a = await f.adminOp({
      op: "role_move",
      role: "supervisor",
      to: PEER,
      plan_id: p.plan_id,
      reply_key: REPLY_KEY,
    });
    expect(a?.error).toMatch(/^the move is blocked/);
  });

  it("a running wave blocks, naming `volleyd stop <wave>` and the drain offer; drain waits instead", async () => {
    const f = await setup();
    await f.beat({ versions: WITH_TMUX });
    await f.submit("w1", "", "  T1: { issue: 42, host: box }\n");
    await f.tick();
    const p = await plan(f);
    const wave = p.blocked.find((b) => b.why === "wave w1 is running");
    expect(wave?.fix).toMatch(/volleyd stop w1/);
    expect(wave?.fix).toMatch(/drain: true/);
    const id = f.agentOf("w1", "T1");
    await f.supervised(id);
    expect((await plan(f)).blocked.some((b) => b.why === `agent ${id} is live on ${PEER}`)).toBe(
      true,
    );
    const move = (extra: Record<string, unknown>) =>
      f.adminOp({
        op: "role_move",
        role: "supervisor",
        to: PEER,
        plan_id: p.plan_id,
        reply_key: REPLY_KEY,
        ...extra,
      });
    // The quiet blockers are not part of the plan_id: the same id moves once the fleet is quiet.
    expect((await move({}))?.error).toMatch(/^the fleet is not quiet: wave w1 is running/);
    const waiting = await move({ drain: true });
    expect(waiting?.result).toMatchObject({ status: "planning" });
    const moveId = (waiting?.result as { move_id: string }).move_id;
    const topic = (await f.env.retained(`volley/_system/roles/moves/${moveId}`)) as {
      payload: { status: string };
    };
    expect(topic.payload.status).toBe("planning");
    expect((await move({ drain: true }))?.error).toMatch(/waiting for a quiet fleet/);
  });
});

/**
 * The target's side of the move, on fakes: `printenv HOME`, the copy (base64 on stdin, written
 * there), `volley role receive` (the bundle restored into the new supervisor's home, its config
 * rewritten as the receive does), and the old machine's `volley peer join` (redeemed on the new
 * supervisor, as `peer redeem` would).
 */
function target(newHome: string, userHome: string, join_: (code: string) => Promise<number>) {
  const answer: OnBox = async (lines, opts) => {
    if (lines[0] === "printenv HOME") return { stdout: `${userHome}\n` };
    const write = opts.remote?.steps.find((s) => s.stdout?.endsWith("/bundle.tgz"));
    if (write !== undefined) {
      mkdirSync(dirname(write.stdout as string), { recursive: true });
      writeFileSync(write.stdout as string, Buffer.from(write.stdin ?? "", "base64"));
      return null;
    }
    const receive = lines.find((l) => l.startsWith("volley role receive supervisor"));
    if (receive !== undefined) {
      const [, , , , bundle = "", , from = ""] = receive.split(" ");
      const stage = tempDir("volleyd-receive-");
      spawnSync("tar", ["-xzf", bundle, "-C", stage]);
      cpSync(join(stage, "volleyd"), newHome, { recursive: true });
      const doc = parseDocument(readFileSync(join(newHome, "config.yaml"), "utf-8"));
      doc.deleteIn(["hosts", PEER]);
      doc.setIn(["fleet", "local_name"], PEER);
      writeFileSync(join(newHome, "config.yaml"), doc.toString());
      const ho = (await import("node:fs")).readdirSync(join(newHome, "roles"))[0] as string;
      const file = join(newHome, "roles", ho, "handover.json");
      writeFileSync(
        file,
        JSON.stringify({ ...JSON.parse(readFileSync(file, "utf-8")), old_target: `dev@${from}` }),
      );
      return null;
    }
    const repair = lines.find((l) => l.startsWith("volley peer join"));
    if (repair !== undefined) return { code: await join_(repair.split(" ")[3] as string) };
    return null;
  };
  return answer;
}

describe("the supervisor move's hand-over (#469): two daemons on one broker", () => {
  it("the old supervisor bundles, copies, receives and unloads itself; the new one re-pairs it and records itself", async () => {
    const newHome = tempDir("volleyd-new-home-");
    const userHome = tempDir("volleyd-new-user-");
    let joinWith: (code: string) => Promise<number> = async () => 1;
    const f = await setup(async (lines, opts) =>
      target(newHome, userHome, (c) => joinWith(c))(lines, opts),
    );
    f.auth.on(["tar"], (argv) => {
      const r = spawnSync("tar", argv.slice(1));
      return { code: r.status ?? 1, stderr: r.stderr.toString() };
    });
    await f.beat({ versions: WITH_TMUX });
    const p = await plan(f);
    const a = await f.adminOp({
      op: "role_move",
      role: "supervisor",
      to: PEER,
      plan_id: p.plan_id,
      reply_key: REPLY_KEY,
    });
    expect(a?.error).toBeUndefined();
    expect(a?.result).toMatchObject({ status: "running", handing_over: true });
    const moveId = (a?.result as { move_id: string }).move_id;
    // The old supervisor's steps, then it unloads its own service.
    await eventually(
      async () => f.auth.argvs(["systemctl", "--user", "stop", "volleyd.service"]).length === 1,
    );
    expect(f.auth.argvs(["tar"])).toHaveLength(1);
    const receive = f.exec.calls
      .flatMap((c) => (c.opts.remote?.steps ?? []).map((s) => s.argv.join(" ")))
      .find((l) => l.startsWith("volley role receive"));
    expect(receive).toBe(
      `volley role receive supervisor ${userHome}/.volley/roles/${moveId}/bundle.tgz --from ${LOCAL} --local-terminal tmux --broker-url mqtt://127.0.0.1:21883`,
    );
    expect(existsSync(join(newHome, "roles", moveId, "handover.json"))).toBe(true);

    // The old process ends; the new one starts on the same broker with the restored home.
    await f.daemon.stop();
    const second = await f.env.start({ ...f.options, home: newHome });
    const client = await ControlClient.connect(f.env.broker.url, "volleyd-test");
    joinWith = async (code) => {
      const r = await client.request("peer_join", {
        code,
        name: LOCAL,
        target: `dev@${LOCAL}`,
        volley_dir: "/opt/volley",
        tunnel: "none",
        reply_key: REPLY_KEY,
      });
      if (r.ok) unseal(r.sealed);
      return r.ok ? 0 : 1;
    };
    await eventually(async () => {
      const t = (await f.env.retained(`volley/_system/roles/moves/${moveId}`)) as {
        payload: { status: string };
      } | null;
      return t?.payload.status === "done";
    });
    const t = (await f.env.retained(`volley/_system/roles/moves/${moveId}`)) as {
      payload: { status: string; steps: { id: string; status: string; line?: string }[] };
    };
    expect(t.payload.steps.map((s) => `${s.id}:${s.status}`)).toEqual([
      "bundle:ok",
      "copy:ok",
      "receive:ok",
      "handover:ok",
      "working:ok",
      "repair:ok",
      "record:ok",
    ]);
    const roles = (await f.env.retained("volley/_system/roles")) as { payload: RolesRecord };
    expect(roles.payload.supervisor.machine).toBe(PEER);
    const hosts = (await client.request("config_get", { path: "hosts" })).result as Record<
      string,
      { tunnel?: unknown }
    >;
    // Re-paired with no tunnel: the broker stays on the old machine, at its own port there.
    expect(hosts[LOCAL]?.tunnel).toEqual({
      remote_port: roles.payload.broker.address.mqtt_port,
      supervise: false,
    });
    await client.close();
    await second.stop();
  });

  /** Start a move to the box whose target answers with `onBox`; its id. */
  async function startMove(onBox: OnBox): Promise<{ f: Fleet; moveId: string }> {
    const f = await setup(onBox);
    f.auth.on(["tar"], (argv) => {
      const r = spawnSync("tar", argv.slice(1));
      return { code: r.status ?? 1, stderr: r.stderr.toString() };
    });
    await f.beat({ versions: WITH_TMUX });
    const p = await plan(f);
    const a = await f.adminOp({
      op: "role_move",
      role: "supervisor",
      to: PEER,
      plan_id: p.plan_id,
      reply_key: REPLY_KEY,
    });
    return { f, moveId: (a?.result as { move_id: string }).move_id };
  }
  const moveTopic = async (f: Fleet, id: string) =>
    (
      (await f.env.retained(`volley/_system/roles/moves/${id}`)) as {
        payload: {
          status: string;
          error?: string;
          steps: { id: string; status: string; line?: string }[];
        };
      } | null
    )?.payload;

  it("a failing receive changes nothing here: failed published, the old supervisor never unloaded", async () => {
    const { f, moveId } = await startMove(async (lines) =>
      lines[0] === "printenv HOME"
        ? { stdout: "/path/to/home\n" }
        : lines.some((l) => l.startsWith("volley role receive"))
          ? { code: 1, stderr: "volley role receive: the manifest's to is studio, not box" }
          : null,
    );
    await eventually(async () => (await moveTopic(f, moveId))?.status === "failed");
    const m = await moveTopic(f, moveId);
    expect(m?.error).toMatch(/^receive: volley role receive on box: .*the manifest's to is studio/);
    expect(f.auth.argvs(["systemctl", "--user", "stop", "volleyd.service"])).toEqual([]);
    expect(f.auth.argvs(["volley", "auth", "rotate", "volleyd"])).toEqual([]);
    expect(f.system().find((e) => e.type === "role_move_failed")?.data).toMatchObject({
      step: "receive",
    });
  });

  it("a receive that failed after rotating volleyd's login: this supervisor rotates it again", async () => {
    const { f, moveId } = await startMove(async (lines) =>
      lines[0] === "printenv HOME"
        ? { stdout: "/path/to/home\n" }
        : lines.some((l) => l.startsWith("volley role receive"))
          ? {
              code: 3,
              stderr: "volley role receive: systemctl --user restart volleyd.service failed",
            }
          : null,
    );
    await eventually(async () => (await moveTopic(f, moveId))?.status === "failed");
    expect(f.auth.argvs(["volley", "auth", "rotate", "volleyd", "--json"])).toHaveLength(1);
    const broker = join(f.env.home, "broker.json");
    expect(JSON.parse(readFileSync(broker, "utf-8"))).toEqual({
      username: "volleyd",
      password: "pw2-volleyd",
    });
    expect((await import("node:fs")).statSync(broker).mode & 0o777).toBe(0o600);
  });

  it("a failing re-pair ends done, with a warning saying how to re-pair by hand", async () => {
    const newHome = tempDir("volleyd-new-home-");
    const userHome = tempDir("volleyd-new-user-");
    const f = await setup(async (lines, opts) =>
      target(newHome, userHome, async () => 1)(lines, opts),
    );
    f.auth.on(["tar"], (argv) => {
      const r = spawnSync("tar", argv.slice(1));
      return { code: r.status ?? 1, stderr: r.stderr.toString() };
    });
    await f.beat({ versions: WITH_TMUX });
    const p = await plan(f);
    const a = await f.adminOp({
      op: "role_move",
      role: "supervisor",
      to: PEER,
      plan_id: p.plan_id,
      reply_key: REPLY_KEY,
    });
    const moveId = (a?.result as { move_id: string }).move_id;
    await eventually(
      async () => f.auth.argvs(["systemctl", "--user", "stop", "volleyd.service"]).length === 1,
    );
    await f.daemon.stop();
    const second = await f.env.start({ ...f.options, home: newHome });
    await eventually(async () => (await moveTopic(f, moveId))?.status === "done");
    const repair = (await moveTopic(f, moveId))?.steps.find((s) => s.id === "repair");
    expect(repair?.status).toBe("ok");
    expect(repair?.line).toMatch(/^warning: re-pairing control failed .*re-pair it by hand/);
    await second.stop();
  });
});
