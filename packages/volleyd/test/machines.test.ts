import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { authOpsTopic } from "../src/accounts";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import { ControlClient } from "../src/control";
import type { Daemon } from "../src/daemon";
import type { RemoteHost, RemoteHostSpec } from "../src/hosts/ssh-tmux";
import { readJournalFile } from "../src/journal";
import {
  MACHINE_CHANNEL,
  MachineHealth,
  type MachineRecord,
  type MachineStatus,
  machineTopic,
  parseMachine,
} from "../src/machines";
import { eventually } from "./helpers/broker-wait";
import { type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { type FakeClock, fakeClock } from "./helpers/fake-clock";
import { memoryCredentials } from "./helpers/fake-dynsec";
import { fakeExec } from "./helpers/fake-exec";
import {
  FIXTURES,
  type FakeHost,
  type FakeRemoteHost,
  GREEN_DOCTOR,
  fakeHost,
  fakeRemoteHost,
} from "./helpers/fake-host";
import { type JournalWait, journalWait } from "./helpers/journal-wait";
import { runCli } from "./helpers/run-cli";
import { schemaErrors } from "./helpers/schema";

const record = (over: Partial<MachineRecord> = {}): MachineRecord => ({
  name: "box",
  os: "linux",
  cores: 8,
  tunnel: "up",
  load: [0.5, 0.4, 0.3],
  agents: 0,
  last_seen: "2026-10-19T09:00:00.000Z",
  ...over,
});
const envelope = (r: MachineRecord, agentId = r.name) =>
  JSON.stringify(
    buildEnvelope({
      agentId,
      parentId: null,
      channel: MACHINE_CHANNEL,
      type: "machine",
      payload: r,
    }),
  );

describe("parseMachine", () => {
  it("accepts the machine's own record or volleyd's, for the topic's name only", () => {
    expect(parseMachine(machineTopic("box"), envelope(record()))).toEqual(record());
    expect(parseMachine(machineTopic("box"), envelope(record(), "volleyd"))).toEqual(record());
    expect(parseMachine(machineTopic("other"), envelope(record()))).toBeNull();
    expect(parseMachine(machineTopic("box"), envelope(record(), "someone-else"))).toBeNull();
    expect(parseMachine(machineTopic("box"), "")).toBeNull();
    expect(parseMachine(machineTopic("box"), "{")).toBeNull();
    expect(
      parseMachine(machineTopic("box"), envelope({ ...record(), tunnel: "maybe" as "up" })),
    ).toBeNull();
  });
});

describe("MachineHealth", () => {
  let now: number;
  let changes: [string, MachineStatus, MachineRecord][];
  let health: MachineHealth;
  beforeEach(() => {
    now = 1_000_000;
    changes = [];
    health = new MachineHealth({ now: () => now, onChange: (...c) => changes.push(c) });
  });

  it("a heartbeat marks the machine up; 90 s of silence marks it down (heartbeat_timeout)", () => {
    health.observe(record());
    expect(health.status("box")).toBe("up");
    expect(changes.map(([n, s]) => [n, s])).toEqual([["box", "up"]]);
    now += DAEMON_DEFAULTS.machine_down_after_ms - 1;
    expect(health.sweep()).toEqual([]);
    // Another heartbeat restarts the wait.
    health.observe(record({ last_seen: "2026-10-19T09:00:30.000Z" }));
    now += DAEMON_DEFAULTS.machine_down_after_ms - 1;
    expect(health.sweep()).toEqual([]);
    now += 1;
    const down = health.sweep();
    expect(down).toEqual([
      record({
        last_seen: "2026-10-19T09:00:30.000Z",
        tunnel: "down",
        reason: "heartbeat_timeout",
      }),
    ]);
    expect(health.status("box")).toBe("down");
    expect(changes.map(([n, s]) => [n, s])).toEqual([
      ["box", "up"],
      ["box", "down"],
    ]);
    // Down once: no second change, nothing more to republish.
    now += DAEMON_DEFAULTS.machine_down_after_ms;
    expect(health.sweep()).toEqual([]);
    expect(changes).toHaveLength(2);
  });

  it("the LWT record (tunnel down, disconnect) marks it down at once; a heartbeat brings it back", () => {
    health.observe(record());
    health.observe(record({ tunnel: "down", reason: "disconnect" }));
    expect(health.status("box")).toBe("down");
    health.observe(record({ last_seen: "2026-10-19T09:01:00.000Z" }));
    expect(health.status("box")).toBe("up");
    expect(changes.map(([, s]) => s)).toEqual(["up", "down", "up"]);
  });

  it("an LWT after a heartbeat keeps the heartbeat's values (the LWT was built at connect time)", () => {
    health.observe(record({ load: [2, 1, 0.5], agents: 3, last_seen: "2026-10-19T12:00:00.000Z" }));
    // The LWT: what the machine looked like when it connected, hours earlier.
    health.observe(record({ tunnel: "down", reason: "disconnect" }));
    expect(health.record("box")).toEqual(
      record({
        tunnel: "down",
        reason: "disconnect",
        load: [2, 1, 0.5],
        agents: 3,
        last_seen: "2026-10-19T12:00:00.000Z",
      }),
    );
  });

  it("says why with its own heartbeat timeout", () => {
    health = new MachineHealth({ now: () => now, onChange: () => {}, downAfterMs: 30_000 });
    health.observe(record());
    now += 30_000;
    const [down] = health.sweep();
    expect(down !== undefined && health.whyDown(down)).toBe("no heartbeat for 30 s");
    expect(health.whyDown(record({ tunnel: "down", reason: "disconnect" }))).toBe("disconnected");
  });

  it("uses its own clock, not the machine's last_seen (a skewed clock never marks it down)", () => {
    health.observe(record({ last_seen: "2001-01-01T00:00:00.000Z" }));
    expect(health.sweep()).toEqual([]);
    expect(health.status("box")).toBe("up");
  });

  it("a host that never published has no status; forget drops a removed peer", () => {
    expect(health.status("box")).toBeUndefined();
    health.observe(record());
    health.forget("box");
    expect(health.status("box")).toBeUndefined();
    expect(health.all()).toEqual([]);
  });
});

/** A paired machine on fakes: its own tunnel (supervise: false) always answers the port check. */
const fakeBox = (spec: RemoteHostSpec, local: FakeHost) => fakeRemoteHost(spec, local);

describe("machine health in the daemon: down parks the host's spawns, back resumes them", () => {
  let env: DaemonEnv;
  let peer: VolleyBroker;
  let client: ControlClient;
  let local: FakeHost;
  let box: (FakeHost & RemoteHost) | undefined;
  let daemon: Daemon;
  let clock: FakeClock;
  let waits: JournalWait;
  let repo: string;
  let beats: number;

  const task = async (wave: string, id: string) => {
    await waits.settled();
    const s = (await env.retained(`volley/_waves/${wave}/state`)) as {
      payload: {
        tasks: {
          id: string;
          stage: string;
          why_waiting?: string;
          host?: string;
          host_down?: string;
        }[];
      };
    };
    return s.payload.tasks.find((t) => t.id === id);
  };
  /** The machine's heartbeat, and the daemon having folded it in (a broker round-trip). */
  const heartbeat = async (over: Partial<MachineRecord> = {}) => {
    beats++;
    const r = record({ last_seen: new Date(1_000_000 + beats * 1000).toISOString(), ...over });
    await peer.publish(machineTopic("box"), envelope(r), { qos: 1, retain: true });
    await eventually(async () => {
      const a = await client.request("peers", {});
      const m = (a.result as { machines: MachineRecord[] }).machines.find((x) => x.name === "box");
      return m?.last_seen === r.last_seen && m.tunnel === r.tunnel;
    });
    await waits.settled();
  };
  const submit = async (wave: string) => {
    const file = join(env.home, `${wave}.yaml`);
    writeFileSync(
      file,
      `wave: ${wave}\nrepo: ${repo}\nrelease_branch: release/${wave}\nmodel: claude-opus-5-5\npipeline: [implement]\ntasks:\n  T1: { issue: 42, host: box }\n`,
    );
    expect((await runCli(["run", file], env.env)).exitCode).toBe(0);
  };
  const tick = async (ms = 1000) => {
    await clock.advance(ms);
    await daemon.tick();
    await waits.settled();
  };

  beforeEach(async () => {
    env = await makeDaemonEnv();
    const dir = realpathSync(env.home);
    repo = join(dir, "repo");
    mkdirSync(repo);
    beats = 0;
    box = undefined;
    const fake = fakeExec()
      .on(["git", "-C", repo, "rev-parse", "--show-toplevel"], { stdout: `${repo}\n` })
      .on(["gh", "issue", "view"], {
        stdout: readFileSync(join(FIXTURES, "gh-issue-42.json"), "utf-8"),
      });
    local = fakeHost(fake);
    const claudeJson = join(dir, "local-claude.json");
    writeFileSync(claudeJson, `${JSON.stringify({ projects: {} })}\n`);
    writeFileSync(
      join(env.home, "config.yaml"),
      `hosts:\n  box:\n    target: dev@box\n    repo: ${repo}\n    volley_dir: /opt/volley\n    worktree_root: ${join(dir, "remote-wt")}\n    tunnel: { remote_port: 21883, supervise: false }\n`,
    );
    // Paired with `volley peer join` (peers.ts): `peers` lists it.
    writeFileSync(
      join(env.home, "peers.json"),
      `${JSON.stringify({ peers: { box: { target: "dev@box", joined_at: "2026-10-19T09:00:00.000Z" } } })}\n`,
    );
    clock = fakeClock(1_000_000);
    daemon = await env.start({
      clock,
      spawner: {
        host: local,
        hooksDir: "/opt/local-hooks",
        claudeJsonPath: claudeJson,
        remoteHost: (s) => {
          box ??= fakeBox(s, local);
          return box;
        },
        credentials: memoryCredentials(),
      },
    });
    waits = journalWait(env.home, () => daemon);
    peer = new VolleyBroker();
    await peer.connect({ url: env.broker.url, agentId: "box" });
    client = await ControlClient.connect(env.broker.url, NS);
  });

  afterEach(async () => {
    await client.close();
    await peer.disconnect();
    await env.cleanup();
  });

  it("90 s without a heartbeat: tunnel down (record republished), spawns park with why_waiting; a heartbeat resumes", async () => {
    await heartbeat();
    await tick();
    // Silence: nothing for the down limit.
    await tick(DAEMON_DEFAULTS.machine_down_after_ms);
    await eventually(async () => {
      const r = (await env.retained(machineTopic("box"))) as {
        agent_id: string;
        payload: MachineRecord;
      } | null;
      return r?.agent_id === "volleyd" && r.payload.tunnel === "down";
    });
    const retained = (await env.retained(machineTopic("box"))) as { payload: MachineRecord };
    expect(retained.payload).toMatchObject({
      name: "box",
      tunnel: "down",
      reason: "heartbeat_timeout",
    });

    await submit("w1");
    await tick();
    expect(await task("w1", "T1")).toMatchObject({
      stage: "queued",
      host: "box",
      why_waiting: "tunnel down to box: no heartbeat for 90 s",
    });
    expect(box?.launches ?? []).toHaveLength(0);

    await heartbeat();
    await tick();
    await tick();
    expect((await task("w1", "T1"))?.why_waiting).toBeUndefined();
    expect(box?.launches).toHaveLength(1);
  });

  it("the machine's LWT record parks at once; going down under a running agent journals MACHINE_DOWN and leaves it alone", async () => {
    await heartbeat({ tunnel: "down", reason: "disconnect" });
    await submit("w1");
    await tick();
    expect((await task("w1", "T1"))?.why_waiting).toBe("tunnel down to box: disconnected");
    expect(box?.launches ?? []).toHaveLength(0);

    await heartbeat();
    await tick();
    expect(box?.launches).toHaveLength(1);
    await heartbeat({ tunnel: "down", reason: "disconnect" });
    await tick();
    const alarm = readJournalFile(join(env.home, "waves", "w1", "journal.jsonl")).find(
      (e) => e.type === "alarm_raised" && e.data.code === "MACHINE_DOWN",
    );
    expect(alarm?.data).toMatchObject({ host: "box", reason: "disconnect", tasks: ["T1"] });
    expect(box?.closed).toEqual([]);
    expect(box?.launches).toHaveLength(1);
  });

  it("a down machine labels its running tasks in the wave state (host_down) until it is back", async () => {
    await heartbeat();
    await submit("w1");
    await tick();
    expect(box?.launches).toHaveLength(1);
    const running = await task("w1", "T1");
    expect(running?.stage).not.toBe("queued");
    expect(running?.host_down).toBeUndefined();

    await tick(DAEMON_DEFAULTS.machine_down_after_ms);
    expect(await task("w1", "T1")).toMatchObject({
      host: "box",
      host_down: "no heartbeat for 90 s",
    });
    expect(box?.closed).toEqual([]);

    await heartbeat();
    await tick();
    expect((await task("w1", "T1"))?.host_down).toBeUndefined();
  });

  it("a cleared record (peer_remove) forgets the machine", async () => {
    await heartbeat();
    await peer.publish(machineTopic("box"), "", { qos: 1, retain: true });
    await eventually(async () => {
      const a = await client.request("peers", {});
      return (a.result as { machines: MachineRecord[] }).machines.length === 0;
    });
  });
});

describe("the supervisor's own record and readiness verdicts (SPEC §4.6.15)", () => {
  const VERSION = "0.4.0";
  const LOCAL = "control";
  let env: DaemonEnv;
  let peer: VolleyBroker;
  let daemon: Daemon;
  let clock: FakeClock;
  let box: FakeRemoteHost | undefined;
  let accounts: Map<string, string>;

  type Verdict = {
    agent_id: string;
    payload: Record<string, unknown> & { ready: boolean; path_ok: { claude: boolean | null } };
  };
  const verdict = async (name: string) =>
    (await env.retained(`${machineTopic(name)}/readiness`)) as Verdict | null;
  const systemEvents = () =>
    readJournalFile(join(env.home, "waves", "_system", "journal.jsonl")).filter(
      (e) => e.type === "machine_readiness_changed",
    );
  /** A full peer record: everything an agent needs, at the supervisor's version. */
  const boxRecord = (over: Partial<MachineRecord> = {}): MachineRecord =>
    record({
      checks: GREEN_DOCTOR.checks.map(({ id, ok, severity, detail }) => ({
        id,
        ok,
        severity,
        detail,
      })),
      versions: { peer: VERSION, volley: VERSION, bun: "1.3.1", git: "2.43.0" },
      auth: { gh: "ok", claude: "signed_in", trust: "ok" },
      doctor_at: GREEN_DOCTOR.doctor_at,
      ...over,
    });
  const tick = async () => {
    await clock.advance(1000);
    await daemon.tick();
  };

  beforeEach(async () => {
    env = await makeDaemonEnv();
    box = undefined;
    writeFileSync(
      join(env.home, "config.yaml"),
      `fleet:\n  local_name: ${LOCAL}\nhosts:\n  box:\n    target: dev@box\n    repo: /srv/repo\n    volley_dir: /opt/volley\n    tunnel: { remote_port: 21883, supervise: false }\n`,
    );
    writeFileSync(
      join(env.home, "peers.json"),
      `${JSON.stringify({ peers: { box: { target: "dev@box", joined_at: "2026-10-19T09:00:00.000Z" } } })}\n`,
    );
    accounts = new Map([
      ["admin-1", "admin"],
      ["box", "peer"],
    ]);
    const auth = fakeExec().on(["volley", "auth"], (argv) => {
      if (argv[2] === "list") {
        return {
          stdout: JSON.stringify({
            accounts: [...accounts].map(([name, role]) => ({
              name,
              role,
              kind: "machine",
              created: "2026-10-19T09:00:00.000Z",
            })),
          }),
        };
      }
      if (argv[2] === "revoke") {
        accounts.delete(argv[3] as string);
        return {};
      }
      return { code: 2, stderr: "unexpected" };
    });
    clock = fakeClock(1_000_000);
    daemon = await env.start({
      clock,
      authExec: auth.exec,
      spawner: {
        host: fakeHost(),
        remoteHost: (s) => {
          box ??= fakeRemoteHost(s, fakeHost());
          return box;
        },
        credentials: memoryCredentials(),
      },
      fleet: {
        version: VERSION,
        localDoctor: async () => ({
          ...GREEN_DOCTOR,
          versions: { peer: VERSION, volley: VERSION, bun: "1.3.1", git: "2.43.0" },
        }),
        localPath: () => ({ claude: true, bun: true }),
      },
    });
    peer = new VolleyBroker();
    await peer.connect({ url: env.broker.url, agentId: "box" });
  });
  afterEach(async () => {
    await peer.disconnect();
    await env.cleanup();
  });

  it("publishes its own record as volleyd: kind supervisor, tunnel local, valid, filled by its doctor", async () => {
    await eventually(async () => {
      const r = (await env.retained(machineTopic(LOCAL))) as { payload: MachineRecord } | null;
      return r?.payload.doctor_at !== undefined;
    });
    const own = (await env.retained(machineTopic(LOCAL))) as {
      agent_id: string;
      payload: MachineRecord;
    };
    expect(own.agent_id).toBe("volleyd");
    expect(own.payload).toMatchObject({
      name: LOCAL,
      kind: "supervisor",
      tunnel: "local",
      agents: 0,
      versions: { volley: VERSION },
    });
    expect(own.payload.memory?.total_mb).toBeGreaterThan(0);
    expect(own.payload.checks?.some((c) => "fix" in c)).toBe(false);
    expect(schemaErrors("machine.schema.json", own)).toEqual([]);
    // Ready from its own doctor run and its own agents' PATH (no ssh hop), capped by hard_ceiling.
    await eventually(async () => (await verdict(LOCAL))?.payload.ready === true);
    const v = (await verdict(LOCAL)) as Verdict;
    expect(v.agent_id).toBe("volleyd");
    expect(v.payload).toMatchObject({ max_agents: 12, drain: false, eligible: true });
    expect(schemaErrors("readiness.schema.json", v)).toEqual([]);
  });

  it("a peer's record change re-publishes its verdict; ready flipping journals once", async () => {
    await peer.publish(machineTopic("box"), envelope(boxRecord()), { qos: 1, retain: true });
    // The record folds in, the PATH probe runs over ssh, then the verdict is ready.
    await eventually(async () => {
      await tick();
      return (await verdict("box"))?.payload.ready === true;
    });
    expect(box?.probes).toBe(1);
    const ready = (await verdict("box")) as Verdict;
    expect(ready.payload).toMatchObject({
      name: "box",
      max_agents: 4,
      path_ok: { claude: true, bun: true },
      requirements: { volley: VERSION },
    });
    expect(schemaErrors("readiness.schema.json", ready)).toEqual([]);
    const flips = () => systemEvents().filter((e) => e.data.name === "box" && e.data.ready);
    expect(flips()).toHaveLength(1);

    // The same record again (a heartbeat): no new event.
    await peer.publish(
      machineTopic("box"),
      envelope(boxRecord({ last_seen: "2026-10-19T09:01:00.000Z" })),
      {
        qos: 1,
        retain: true,
      },
    );
    await tick();
    expect(flips()).toHaveLength(1);

    // Signed out: re-published at once, with the reason.
    await peer.publish(
      machineTopic("box"),
      envelope(boxRecord({ auth: { gh: "ok", claude: "not_signed_in", trust: "ok" } })),
      { qos: 1, retain: true },
    );
    await eventually(async () => (await verdict("box"))?.payload.ready === false);
    expect((await verdict("box"))?.payload.reasons).toEqual(["claude: not signed in"]);
    expect(systemEvents().at(-1)?.data).toEqual({
      name: "box",
      ready: false,
      reasons: ["claude: not signed in"],
    });
  });

  it("a probe without claude says so; drain and max_agents apply hot", async () => {
    await peer.publish(machineTopic("box"), envelope(boxRecord()), { qos: 1, retain: true });
    await eventually(async () => {
      await tick();
      return box !== undefined && (await verdict("box"))?.payload.ready === true;
    });
    const client = await ControlClient.connect(env.broker.url, NS);
    try {
      const r = await client.request("config_set", {
        patch: { hosts: { box: { drain: true } } },
        by: "tester",
      });
      expect(r).toMatchObject({ ok: true });
    } finally {
      await client.close();
    }
    await eventually(async () => (await verdict("box"))?.payload.drain === true);
    expect((await verdict("box"))?.payload).toMatchObject({
      ready: true,
      eligible: false,
      ineligible_reason: "draining",
    });

    // The next probe (at most every path_probe_interval_ms) finds no claude on the ssh PATH.
    if (box !== undefined) box.answers.path = { claude: false, bun: true };
    await clock.advance(DAEMON_DEFAULTS.path_probe_interval_ms);
    // Its heartbeat keeps it up across the wait.
    await peer.publish(machineTopic("box"), envelope(boxRecord()), { qos: 1, retain: true });
    await eventually(async () => {
      await tick();
      return (await verdict("box"))?.payload.path_ok.claude === false;
    });
    const v = (await verdict("box")) as Verdict;
    expect(v.payload.path_ok).toEqual({ claude: false, bun: true });
    expect(v.payload.reasons).toEqual([
      expect.stringMatching(/^claude not on the non-interactive ssh PATH/),
    ]);
    expect(box?.probes).toBe(2);
  });

  it("peer_remove clears the verdict", async () => {
    await peer.publish(machineTopic("box"), envelope(boxRecord()), { qos: 1, retain: true });
    await eventually(async () => {
      await tick();
      return (await verdict("box")) !== null;
    });
    const admin = new VolleyBroker();
    await admin.connect({ url: env.broker.url, agentId: "admin-cli" });
    try {
      await admin.publish(
        authOpsTopic("admin-1"),
        JSON.stringify(
          buildEnvelope({
            agentId: "admin-1",
            parentId: null,
            channel: "_system/auth",
            type: "query",
            correlationId: "c0ffee00-0000-4000-8000-000000000001",
            payload: { op: "peer_remove", name: "box" },
          }),
        ),
        { qos: 1, retain: false },
      );
      await eventually(async () => (await verdict("box")) === null);
    } finally {
      await admin.disconnect();
    }
    expect(await env.retained(machineTopic("box"))).toBeNull();
  });
});
