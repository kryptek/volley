import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
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
import { FIXTURES, type FakeHost, fakeHost } from "./helpers/fake-host";
import { type JournalWait, journalWait } from "./helpers/journal-wait";
import { runCli } from "./helpers/run-cli";

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
function fakeBox(spec: RemoteHostSpec, local: FakeHost): FakeHost & RemoteHost {
  const h = fakeHost(local.fake) as unknown as FakeHost & RemoteHost;
  Object.assign(h, {
    name: spec.name,
    spec,
    screenSource: "tmux",
    hooksDir: `${spec.volley_dir}/packages/volley-hooks`,
    mcpEntry: `${spec.volley_dir}/packages/volley-mcp/src/index.ts`,
    brokerUrl: `mqtt://127.0.0.1:${spec.tunnel.remote_port}`,
    launchEnv: (id: { agent_id: string; namespace: string }) => ({
      VOLLEY_BROKER_URL: `mqtt://127.0.0.1:${spec.tunnel.remote_port}`,
      VOLLEY_NAMESPACE: id.namespace,
      VOLLEY_AGENT_ID: id.agent_id,
    }),
    repoExists: async () => true,
    tunnelUp: async () => true,
    readTrust: async () => ({ projects: { [spec.repo]: { hasTrustDialogAccepted: true } } }),
    recordTrust: async () => {},
    readFile: async () => null,
  });
  return h;
}

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
      payload: { tasks: { id: string; stage: string; why_waiting?: string; host?: string }[] };
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
});
