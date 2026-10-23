import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { buildTopic } from "volley-mcp/topics";
import { authOpsTopic, authReplyTopic } from "../src/accounts";
import { CONFIG_DEFAULTS, DAEMON_DEFAULTS } from "../src/config-defaults";
import { ControlClient } from "../src/control";
import { type Daemon, type DaemonOptions, realLocalDoctor } from "../src/daemon";
import { assertAllowed } from "../src/fence";
import type { RemoteHostSpec } from "../src/hosts/ssh-tmux";
import { readJournalFile } from "../src/journal";
import {
  MACHINE_CHANNEL,
  type MachineCheck,
  MachineHealth,
  type MachineRecord,
  type MachineStatus,
  doctorFields,
  machineTopic,
  parseMachine,
  withDoctor,
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
  adoptSpec,
  fakeHost,
  fakeRemoteHost,
} from "./helpers/fake-host";
import { type Fleet, makeFleet } from "./helpers/fleet-env";
import { type JournalWait, journalWait } from "./helpers/journal-wait";
import { runCli } from "./helpers/run-cli";
import { schemaErrors } from "./helpers/schema";
import { tempDir } from "./helpers/tmp";

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

describe("a record's repositories (#435)", () => {
  const REPOS: MachineRecord["repos"] = [
    {
      slug: "a/a",
      path: "/path/to/home/.volley/repos/a/a",
      exists: true,
      origin: "github.com/a/a",
      managed: true,
      fetched_at: "2026-10-19T08:59:00.000Z",
      toolchain: { ok: false, missing: ["java"], outdated: [] },
    },
    {
      slug: "b/b",
      path: "/path/to/work/b",
      exists: false,
      managed: false,
      fetched_at: null,
      release_branch: "release/2026-10-23-repos",
      toolchain: { ok: true, missing: [], outdated: ["bun"] },
    },
  ];
  const CHECKS: MachineCheck[] = [
    { id: "repo.clone", ok: true, severity: "block", detail: "clone", repo: "a/a" },
    { id: "tool.java", ok: false, severity: "block", detail: "java is not installed", repo: "a/a" },
    { id: "tool.git", ok: true, severity: "block", detail: "git 2.43.0" },
  ];

  it("round-trips through machine.schema.json: repos[] and each check's repo", () => {
    const r = record({ repos: REPOS, checks: CHECKS, doctor_at: "2026-10-19T09:00:00.000Z" });
    expect(schemaErrors("machine.schema.json", JSON.parse(envelope(r)))).toEqual([]);
    expect(parseMachine(machineTopic("box"), envelope(r))).toEqual(r);
    for (const bad of [
      [{ ...REPOS[0], slug: "../x" }],
      [{ ...REPOS[0], toolchain: { ok: true, missing: ["rm -rf /"], outdated: [] } }],
      [{ ...REPOS[0], extra: 1 }],
    ]) {
      expect(
        parseMachine(machineTopic("box"), envelope(record({ repos: bad as never }))),
      ).toBeNull();
    }
    const badCheck = [{ ...CHECKS[0], repo: "not a slug" }] as MachineCheck[];
    expect(parseMachine(machineTopic("box"), envelope(record({ checks: badCheck })))).toBeNull();
  });

  it("a doctor report's repos and per-repository checks become record fields", () => {
    const fields = doctorFields({
      checks: CHECKS.map((c) => ({ ...c, fix: "x" })),
      repos: REPOS,
      fixes: [{ id: "repo.canonical", repo: "a/a", ok: true, command: "git remote set-url" }],
      doctor_at: "2026-10-19T09:00:00.000Z",
    });
    expect(fields.checks).toEqual(CHECKS);
    expect(fields.repos).toEqual(REPOS);
    // The fixes journal is the report's, never the record's.
    expect("fixes" in fields).toBe(false);
  });

  it("a doctor run without repos clears the record's (its last repository removed)", () => {
    const prior = record({ repos: REPOS, repo: { path: "/path/to/work/b", exists: false } });
    const after = withDoctor(prior, { checks: [], doctor_at: "2026-10-19T09:01:00.000Z" });
    expect(after.repos).toBeUndefined();
    expect(after.repo).toBeUndefined();
    expect(after.name).toBe("box");
    expect(withDoctor(prior, { checks: [], repos: REPOS, doctor_at: "x" }).repos).toEqual(REPOS);
  });

  it("over the checks cap, every machine-level check and the failing per-repository ones stay", () => {
    const perRepo = Array.from({ length: 150 }, (_, i) => ({
      id: "repo.clone",
      ok: i !== 140,
      severity: "block" as const,
      detail: `clone ${i}`,
      repo: `o/r${i}`,
    }));
    const machine = { id: "gh.auth", ok: false, severity: "block" as const, detail: "signed out" };
    const fields = doctorFields({ checks: [...perRepo, machine], doctor_at: "x" });
    expect(fields.checks).toHaveLength(128);
    expect(fields.checks?.at(-1)).toEqual(machine);
    expect(fields.checks?.find((c) => c.repo === "o/r140")).toMatchObject({ ok: false });
    // The report's order holds.
    expect(fields.checks?.[0]?.repo).toBe("o/r0");
  });

  it("a heartbeat carrying an older doctor run keeps the newer run's repos", () => {
    const health = new MachineHealth({ now: () => 0, onChange: () => {} });
    health.observe(record({ repos: REPOS, doctor_at: "2026-10-19T09:00:05.000Z" }));
    health.observe(record({ repos: [], doctor_at: "2026-10-19T08:00:00.000Z" }));
    expect(health.record("box")?.repos).toEqual(REPOS);
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

  it("a heartbeat carrying an older doctor run than the record's keeps the newer doctor fields (a Repair's fold)", () => {
    const stale: Partial<MachineRecord> = {
      versions: { peer: "0.4.0", volley: "0.4.0", bun: "1.3.0", git: "2.47.0" },
      auth: { gh: "ok", claude: "signed_in", trust: "ok" },
      checks: [{ id: "volley.installed", ok: false, severity: "block", detail: "stale" }],
      doctor_at: "2026-10-19T08:00:00.000Z",
    };
    const fresh: Partial<MachineRecord> = {
      versions: { peer: "0.5.0", volley: "0.5.0", bun: "1.3.0", git: "2.47.0" },
      auth: { gh: "ok", claude: "signed_in", trust: "ok" },
      checks: [{ id: "volley.installed", ok: true, severity: "block", detail: "ok" }],
      doctor_at: "2026-10-19T09:00:05.000Z",
    };
    // The supervisor folded a Repair's report; the box's next beat still carries its old run.
    health.observe(record(fresh));
    health.observe(record({ ...stale, load: [2, 1, 0.5], last_seen: "2026-10-19T09:00:30.000Z" }));
    expect(health.record("box")).toEqual(
      record({ ...fresh, load: [2, 1, 0.5], last_seen: "2026-10-19T09:00:30.000Z" }),
    );
    // The service's own newer run replaces it.
    const later = { ...stale, doctor_at: "2026-10-19T09:01:00.000Z" };
    health.observe(record(later));
    expect(health.record("box")).toEqual(record(later));
  });

  it("says when it kept the newer run's doctor fields over an incoming record's older ones", () => {
    const newer = { checks: [], doctor_at: "2026-10-19T09:00:05.000Z" };
    expect(health.observe(record(newer))).toBe(false);
    expect(health.observe(record({ checks: [], doctor_at: "2026-10-19T08:00:00.000Z" }))).toBe(
      true,
    );
    expect(health.observe(record({ checks: [], doctor_at: "2026-10-19T09:01:00.000Z" }))).toBe(
      false,
    );
  });

  it("a record the supervisor republished itself is not a heartbeat: the box still goes down", () => {
    health.observe(record({ doctor_at: "2026-10-19T08:00:00.000Z" }));
    now += DAEMON_DEFAULTS.machine_down_after_ms - 1;
    // A Repair's fold (or its echo through the broker) a moment before the timeout.
    health.observe(record({ doctor_at: "2026-10-19T09:00:05.000Z" }), { heard: false });
    expect(health.record("box")?.doctor_at).toBe("2026-10-19T09:00:05.000Z");
    now += 1;
    expect(health.sweep().map((r) => r.reason)).toEqual(["heartbeat_timeout"]);
  });

  it("a record the supervisor republished itself never brings a down box back up", () => {
    health.observe(record());
    now += DAEMON_DEFAULTS.machine_down_after_ms;
    health.sweep();
    const since = now;
    // The echo of a fold published just before the sweep marked the box down.
    now += 10;
    expect(
      health.observe(record({ doctor_at: "2026-10-19T09:00:05.000Z" }), { heard: false }),
    ).toBe(false);
    expect(health.status("box")).toBe("down");
    expect(health.downSince("box")).toBe(since);
    expect(health.record("box")?.reason).toBe("heartbeat_timeout");
    expect(changes.map(([, s]) => s)).toEqual(["up", "down"]);
  });

  it("compares doctor runs by instant, not by how the timestamp is written", () => {
    const checks = (detail: string) => [
      { id: "volley.installed", ok: true, severity: "block" as const, detail },
    ];
    // 09:30Z, written with an offset: newer than 09:00Z, though it sorts lower as a string.
    health.observe(record({ checks: checks("old"), doctor_at: "2026-10-19T09:00:00.000Z" }));
    health.observe(record({ checks: checks("new"), doctor_at: "2026-10-19T08:30:00-01:00" }));
    expect(health.record("box")?.checks?.[0]?.detail).toBe("new");
    // 09:20Z: older than 09:30Z, though it sorts higher as a string.
    health.observe(record({ checks: checks("older"), doctor_at: "2026-10-19T09:20:00Z" }));
    expect(health.record("box")?.checks?.[0]?.detail).toBe("new");
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

  it("remembers since when a machine is down, on its own clock, until it is back", () => {
    health.observe(record());
    expect(health.downSince("box")).toBeUndefined();
    now += DAEMON_DEFAULTS.machine_down_after_ms;
    health.sweep();
    const since = now;
    expect(health.downSince("box")).toBe(since);
    // Its LWT arriving later does not restart the clock.
    now += 60_000;
    health.observe(record({ tunnel: "down", reason: "disconnect" }));
    expect(health.downSince("box")).toBe(since);
    health.observe(record({ last_seen: "2026-10-19T09:10:00.000Z" }));
    expect(health.downSince("box")).toBeUndefined();
    // An LWT on an up machine starts it at once.
    now += 1000;
    health.observe(record({ tunnel: "down", reason: "disconnect" }));
    expect(health.downSince("box")).toBe(now);
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

const FLEET_VERSION = "0.4.0";
const ORIGIN = "github.com/example-org/widgets";
/**
 * What the real `volley peer doctor --json` prints (exit 1) with no `--repo` and no `peer.json`,
 * the supervisor's case: a failing `repo.clone` block check and no `repo`.
 */
const noRepoReport = () => ({
  checks: [
    { id: "tool.bun", ok: true, severity: "block", detail: "bun 1.3.1 at /usr/local/bin/bun" },
    { id: "tool.claude", ok: true, severity: "block", detail: "claude at /usr/local/bin/claude" },
    {
      id: "volley.version",
      ok: true,
      severity: "block",
      detail: `volley ${FLEET_VERSION} (the supervisor's requirement is not known here)`,
    },
    {
      id: "repo.clone",
      ok: false,
      severity: "block",
      detail: "no wave repo: pass --repo <path> (this machine's clone of the wave repository)",
    },
    {
      id: "claude.trust",
      ok: false,
      severity: "warn",
      detail: "no wave repo to check Claude Code's folder trust for",
    },
  ],
  versions: { peer: FLEET_VERSION, volley: FLEET_VERSION, bun: "1.3.1", git: "2.43.0" },
  auth: { gh: "ok", claude: "signed_in", trust: "unknown" },
  memory: { total_mb: 16384, available_pct: 60 },
  doctor_at: "2026-10-19T09:00:00.000Z",
});
/** The same doctor given `--repo <path>`: the clone checks pass and `repo` names its origin. */
const repoReport = (path: string) => {
  const r = noRepoReport();
  return {
    ...r,
    checks: r.checks.map((c) =>
      c.id === "repo.clone"
        ? { ...c, ok: true, detail: `clone at ${path}` }
        : c.id === "claude.trust"
          ? { ...c, ok: true, detail: "trusted" }
          : c,
    ),
    auth: { ...r.auth, trust: "ok" },
    repo: { path, exists: true, origin: ORIGIN },
  };
};

describe("machine health in the daemon: down parks the host's spawns, back resumes them", () => {
  let env: DaemonEnv;
  let peer: VolleyBroker;
  let client: ControlClient;
  let local: FakeHost;
  let box: FakeRemoteHost | undefined;
  let daemon: Daemon;
  let clock: FakeClock;
  let waits: JournalWait;
  let repo: string;
  let beats: number;
  /** Every argv the supervisor's own doctor ran (each passed the fence first). */
  let doctorArgv: string[][];
  /** When set, the supervisor's own doctor fails (the last report stays). */
  let doctorFails: boolean;

  const verdict = async (name: string) =>
    (await env.retained(`${machineTopic(name)}/readiness`)) as {
      payload: Record<string, unknown> & { ready: boolean; reasons: string[] };
    } | null;
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
      // The own machine a candidate like any peer (fleet.local_agents: always): these tests are
      // about health and decisions, not the fallback.
      `fleet:\n  local_name: control\n  local_agents: always\nhosts:\n  box:\n    target: dev@box\n    repo: ${repo}\n    volley_dir: /opt/volley\n    worktree_root: ${join(dir, "remote-wt")}\n    tunnel: { remote_port: 21883, supervise: false }\n`,
    );
    // Paired with `volley peer join` (peers.ts): `peers` lists it.
    writeFileSync(
      join(env.home, "peers.json"),
      `${JSON.stringify({ peers: { box: { target: "dev@box", joined_at: "2026-10-19T09:00:00.000Z" } } })}\n`,
    );
    clock = fakeClock(1_000_000);
    doctorArgv = [];
    doctorFails = false;
    // The production doctor (realLocalDoctor) over an exec that answers like the real CLI.
    const doctorExec = async (argv: readonly string[]) => {
      assertAllowed(argv);
      doctorArgv.push([...argv]);
      if (doctorFails) throw new Error("doctor unavailable");
      const at = argv.indexOf("--repo");
      const report = at === -1 ? noRepoReport() : repoReport(argv[at + 1] as string);
      return {
        code: at === -1 ? 1 : 0,
        stdout: JSON.stringify(report),
        stderr: "",
        timedOut: false,
      };
    };
    // Repair's peer_doctor is an admin op: `volley auth list` says who is one.
    const auth = fakeExec().on(["volley", "auth", "list"], {
      stdout: JSON.stringify({
        accounts: [
          { name: "admin-1", role: "admin", kind: "human", created: "2026-10-19T09:00:00.000Z" },
        ],
      }),
    });
    daemon = await env.start({
      clock,
      authExec: auth.exec,
      fleet: {
        version: FLEET_VERSION,
        localDoctor: realLocalDoctor(doctorExec),
        localPath: () => ({ claude: true, bun: true }),
      },
      spawner: {
        host: local,
        hooksDir: "/opt/local-hooks",
        claudeJsonPath: claudeJson,
        remoteHost: (s) => {
          box ??= fakeBox(s, local);
          return adoptSpec(box, s);
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

  it("the own doctor runs through the fence without --repo while no wave runs (its repo checks do not count), then with the running wave's repo, whose origin a peer's is compared with", async () => {
    await eventually(async () => {
      await tick();
      return (await verdict("control"))?.payload.ready === true;
    });
    expect(doctorArgv[0]).toEqual(["volley", "peer", "doctor", "--json"]);
    expect((await verdict("control"))?.payload.reasons).toEqual([]);

    // A wave runs: the doctor runs again at once, on that wave's repo.
    await submit("w1");
    await eventually(async () => {
      await tick();
      return doctorArgv.some((a) => a.includes("--repo"));
    });
    expect(doctorArgv.find((a) => a.includes("--repo"))).toEqual([
      "volley",
      "peer",
      "doctor",
      "--json",
      "--repo",
      repo,
    ]);
    await eventually(async () => {
      const own = (await env.retained(machineTopic("control"))) as {
        payload: MachineRecord;
      } | null;
      return own?.payload.repo?.origin === ORIGIN;
    });
    expect((await verdict("control"))?.payload.ready).toBe(true);

    // A peer whose clone has another origin is not ready, and says so.
    await heartbeat({
      checks: [{ id: "repo.clone", ok: true, severity: "block", detail: "clone" }],
      versions: { peer: FLEET_VERSION, volley: FLEET_VERSION, bun: "1.3.1", git: "2.43.0" },
      auth: { gh: "ok", claude: "signed_in", trust: "ok" },
      repo: { path: "/srv/repo", exists: true, origin: "github.com/example-org/fork" },
      doctor_at: "2026-10-19T09:00:00.000Z",
    });
    await eventually(async () => {
      await tick();
      return (
        (await verdict("box"))?.payload.reasons.some((r) => r.startsWith("repo origin")) === true
      );
    });
    expect((await verdict("box"))?.payload.reasons).toEqual([
      `repo origin differs from the host's (github.com/example-org/fork, host: ${ORIGIN})`,
    ]);
  });

  it("Repair's clone runs the box's doctor with --origin: the running wave's origin, as the supervisor's own doctor read it", async () => {
    /** `peer_doctor` as admin-1 on the account-op topic, answered on its reply topic. */
    const repair = async (payload: Record<string, unknown>) => {
      const admin = new VolleyBroker();
      await admin.connect({ url: env.broker.url, agentId: `admin-${randomUUID().slice(0, 6)}` });
      try {
        const cid = randomUUID();
        let resolve!: (p: Record<string, unknown>) => void;
        const reply = new Promise<Record<string, unknown>>((r) => {
          resolve = r;
        });
        await admin.subscribeStream(authReplyTopic(cid), ({ payload: raw }) => {
          const e = parseEnvelope(raw);
          if (e?.type === "ack" && e.correlation_id === cid) {
            resolve(e.payload as Record<string, unknown>);
          }
        });
        const env0 = buildEnvelope({
          agentId: "admin-1",
          parentId: null,
          channel: "_system/auth",
          type: "query",
          correlationId: cid,
          payload: { op: "peer_doctor", name: "box", ...payload },
        });
        await admin.publish(authOpsTopic("admin-1"), JSON.stringify(env0), {
          qos: 1,
          retain: false,
        });
        return await reply;
      } finally {
        await admin.disconnect();
      }
    };
    await heartbeat();
    // No wave runs: the wave repo's origin is not known, so nothing can be cloned.
    expect(await repair({ fix: true, clone: true })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/origin.*not known/),
    });
    expect(box?.doctorRuns ?? []).toEqual([]);

    await submit("w1");
    await eventually(async () => {
      await tick();
      const own = (await env.retained(machineTopic("control"))) as {
        payload: MachineRecord;
      } | null;
      return own?.payload.repo?.origin === ORIGIN;
    });
    expect(await repair({ fix: true, clone: true })).toMatchObject({ ok: true });
    expect(box?.doctorRuns.at(-1)).toEqual({ fix: true, clone: `https://${ORIGIN}` });
    // Without clone, no --origin: the fence admits it only beside --clone.
    expect(await repair({ fix: true })).toMatchObject({ ok: true });
    expect(box?.doctorRuns.at(-1)).toEqual({ fix: true });

    // The wave ends and the own doctor's next run fails: its last report is of the ended wave's
    // clone, so its origin is no longer the wave repo's and nothing is cloned from it.
    doctorFails = true;
    expect((await runCli(["stop", "w1", "--by", "tester"], env.env)).exitCode).toBe(0);
    const runs = doctorArgv.length;
    await eventually(async () => {
      await tick();
      return doctorArgv.slice(runs).some((a) => !a.includes("--repo"));
    });
    const cloned = box?.doctorRuns.length;
    expect(await repair({ fix: true, clone: true })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/origin.*not known/),
    });
    expect(box?.doctorRuns).toHaveLength(cloned ?? 0);
  });

  it("the own machine's verdict counts every live supervised agent, on any machine, against hard_ceiling", async () => {
    await heartbeat();
    await submit("w1");
    await tick();
    expect(box?.launches).toHaveLength(1);
    // The box's session never registers: its spawn settles, supervised, once spawn_timeout_s
    // passes. Advanced at once, not a second a tick inside the broker wait.
    await tick(CONFIG_DEFAULTS.spawn_timeout_s * 1000);
    await eventually(async () => {
      await tick();
      const v = await verdict("control");
      return v?.payload.ready === true && v.payload.placed === 1;
    });
    expect((await verdict("control"))?.payload).toMatchObject({
      max_agents: CONFIG_DEFAULTS.hard_ceiling,
      placed: 1,
      eligible: true,
    });
    // Its own record counts only the agents on it.
    const own = (await env.retained(machineTopic("control"))) as { payload: MachineRecord };
    expect(own.payload.agents).toBe(0);

    const r = await client.request("config_set", { patch: { hard_ceiling: 1 }, by: "tester" });
    expect(r).toMatchObject({ ok: true });
    await eventually(async () => {
      await tick();
      return (await verdict("control"))?.payload.max_agents === 1;
    });
    expect((await verdict("control"))?.payload).toMatchObject({
      ready: true,
      placed: 1,
      eligible: false,
      ineligible_reason: "1/1 agents (max_agents)",
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
  let claudeRoot: string;
  let startOpts: Partial<DaemonOptions>;
  let doctorRuns: number;

  type Verdict = {
    agent_id: string;
    payload: Record<string, unknown> & {
      ready: boolean;
      reasons: string[];
      path_ok: { claude: boolean | null };
    };
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
      `fleet:\n  local_name: ${LOCAL}\n  local_agents: always\nhosts:\n  box:\n    target: dev@box\n    repo: /srv/repo\n    volley_dir: /opt/volley\n    tunnel: { remote_port: 21883, supervise: false }\n`,
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
    doctorRuns = 0;
    claudeRoot = tempDir("volleyd-claude-root-");
    writeFileSync(join(claudeRoot, "sharing.yaml"), "skills: own\nmcp: own\n");
    startOpts = {
      clock,
      authExec: auth.exec,
      claude: { root: claudeRoot },
      spawner: {
        host: fakeHost(),
        remoteHost: (s) => {
          box ??= fakeRemoteHost(s, fakeHost());
          return adoptSpec(box, s);
        },
        credentials: memoryCredentials(),
      },
      fleet: {
        version: VERSION,
        localDoctor: async () => {
          doctorRuns++;
          return {
            ...GREEN_DOCTOR,
            versions: { peer: VERSION, volley: VERSION, bun: "1.3.1", git: "2.43.0" },
          };
        },
        localPath: () => ({ claude: true, bun: true }),
      },
    };
    daemon = await env.start(startOpts);
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
    // requirements.sharing: the supervisor's own sharing.yaml modes, over the defaults.
    expect(v.payload.requirements).toMatchObject({
      volley: VERSION,
      sharing: { skills: "own", mcp: "own", "CLAUDE.md": "linked", "settings.json": "copy" },
    });
    expect(schemaErrors("readiness.schema.json", v)).toEqual([]);
  });

  it("its usage is its best login's 5-hour window: work at 12% beats primary at 95%", async () => {
    mkdirSync(join(claudeRoot, "work"), { recursive: true });
    writeFileSync(
      join(claudeRoot, "accounts.json"),
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: "work",
            label: "work",
            machine: "local",
            created: "2026-10-18T12:00:00.000Z",
            signed_in_at: "2026-10-18T12:00:00.000Z",
          },
        ],
      }),
    );
    const resets = "2099-01-01T00:00:00.000Z";
    const sample = (agent: string, account: string, pct: number) =>
      peer.publish(
        buildTopic(NS, agent, "usage"),
        JSON.stringify(
          buildEnvelope({
            agentId: agent,
            parentId: null,
            channel: "usage",
            type: "usage",
            payload: {
              account,
              model: "claude-opus-5-5",
              context_window: { used_percentage: 20, used: 200_000, size: 1_000_000 },
              rate_limits: {
                five_hour: { pct, resets_at: resets },
                weekly: { pct: 30, resets_at: resets },
              },
              captured_at: new Date(clock.now()).toISOString(),
            },
          }),
        ),
        { qos: 1, retain: true },
      );
    await sample("a-hot", "primary", 95);
    await sample("a-cool", "work", 12);
    await eventually(async () => {
      await tick();
      const u = (await verdict(LOCAL))?.payload.usage as { five_hour_pct?: number } | undefined;
      return u?.five_hour_pct === 12;
    });
    const v = (await verdict(LOCAL)) as Verdict;
    expect(v.payload.usage).toEqual({ account: "work", five_hour_pct: 12 });
    expect(v.payload.eligible).toBe(true);
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
    // Its first verdict with its inputs (record folded, probe done) is the baseline: no event,
    // and no "not probed yet" verdict was journaled or published before it.
    expect(systemEvents()).toEqual([]);

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
    expect(systemEvents()).toEqual([]);

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

  it("a restart journals no flip and publishes no transient 'not ready' for machines that did not change", async () => {
    const ready = async () =>
      (await verdict("box"))?.payload.ready === true &&
      (await verdict(LOCAL))?.payload.ready === true;
    await peer.publish(machineTopic("box"), envelope(boxRecord()), { qos: 1, retain: true });
    await eventually(async () => {
      await tick();
      return ready();
    });
    // One real change and back, so the journal holds a last verdict for box (LOCAL has none).
    await peer.publish(
      machineTopic("box"),
      envelope(boxRecord({ auth: { gh: "ok", claude: "not_signed_in", trust: "ok" } })),
      { qos: 1, retain: true },
    );
    await eventually(async () => (await verdict("box"))?.payload.ready === false);
    await peer.publish(machineTopic("box"), envelope(boxRecord()), { qos: 1, retain: true });
    await eventually(async () => (await verdict("box"))?.payload.ready === true);
    await daemon.settled();
    const before = systemEvents();
    expect(before.map((e) => e.data.ready)).toEqual([false, true]);

    // Everything any verdict says from here on.
    const seen: { name: string; ready: boolean; reasons: string[] }[] = [];
    const watcher = new VolleyBroker();
    await watcher.connect({ url: env.broker.url, agentId: "readiness-watcher" });
    await watcher.subscribeStream(`${machineTopic("+")}/readiness`, ({ payload: raw }) => {
      const e = raw === "" ? null : parseEnvelope(raw);
      if (e !== null) seen.push(e.payload as (typeof seen)[number]);
    });
    try {
      await daemon.stop();
      const probes = box?.probes ?? 0;
      const runs = doctorRuns;
      daemon = await env.start(startOpts);
      // Its inputs gathered again: the box probed over ssh, its own doctor run.
      await eventually(async () => {
        await tick();
        return (box?.probes ?? 0) > probes && doctorRuns > runs;
      });
      await tick();
      await daemon.settled();
      expect(await ready()).toBe(true);
    } finally {
      await watcher.disconnect();
    }
    expect(systemEvents()).toEqual(before);
    expect(seen.filter((v) => !v.ready)).toEqual([]);
  });

  it("a PATH probe ssh cannot run says so in the verdict", async () => {
    await peer.publish(machineTopic("box"), envelope(boxRecord()), { qos: 1, retain: true });
    await eventually(async () => {
      await tick();
      return box !== undefined;
    });
    if (box !== undefined)
      box.answers.path = new Error("ssh to dev@box failed: Connection refused");
    await clock.advance(DAEMON_DEFAULTS.path_probe_interval_ms);
    await peer.publish(machineTopic("box"), envelope(boxRecord()), { qos: 1, retain: true });
    await eventually(async () => {
      await tick();
      const v = await verdict("box");
      return v?.payload.reasons.some((r) => r.startsWith("PATH probe")) === true;
    });
    expect((await verdict("box"))?.payload).toMatchObject({
      ready: false,
      path_ok: { claude: null, bun: null },
      reasons: ["PATH probe over ssh failed: ssh to dev@box failed: Connection refused"],
    });
  });
});

describe("a machine that stays down: the machine_down decision (SPEC §4.6.15)", () => {
  let f: Fleet;
  const DOWN_AFTER = CONFIG_DEFAULTS.placement.down_decision_after_s * 1000;
  const machineDown = (wave: string) =>
    f.journal(wave).filter((e) => e.type === "decision_opened" && e.data.kind === "machine_down");
  const placedBy = (wave: string, task: string) =>
    f.journal(wave).filter((e) => e.type === "task_placed" && e.task === task);

  /** w1: T1 runs on box; T3 and T4 (after T1) are queued for box. */
  const runOnBox = async () => {
    await f.submit(
      "w1",
      "placement: auto\n",
      "  T1: { issue: 42, host: box }\n  T3: { issue: 42, host: box, after: [T1] }\n  T4: { issue: 42, host: box, after: [T1] }\n",
    );
    await f.tick();
    await f.supervised(f.agentOf("w1", "T1"));
  };

  beforeEach(async () => {
    f = await makeFleet();
  });
  afterEach(async () => {
    await f.close();
  });

  it("opens one decision per affected wave after down_decision_after_s (none at 4 min 59 s), naming the tasks", async () => {
    await runOnBox();
    await f.submit("w2", "", "  T5: { issue: 42, host: box }\n");
    await f.tick();
    await f.supervised(f.agentOf("w2", "T5"));
    await f.submit("w3", "", "  T9: { issue: 42 }\n");
    await f.tick();
    await f.lwt();
    await f.tick(DOWN_AFTER - 1000);
    expect(machineDown("w1")).toEqual([]);
    expect(machineDown("w2")).toEqual([]);
    await f.tick(1000);
    expect(machineDown("w1")).toHaveLength(1);
    expect(machineDown("w2")).toHaveLength(1);
    expect(machineDown("w3")).toEqual([]);
    const id = machineDown("w1")[0]?.data.decision_id as string;
    const d = await f.decision("w1", id);
    expect(d).toMatchObject({
      kind: "machine_down",
      task: null,
      host: "box",
      tasks: ["T1", "T3", "T4"],
      options: ["wait", "re-place queued tasks", "cancel"],
    });
    expect(d?.question).toContain("box has been down 5 min (disconnected).");
    expect(d?.question).toContain(
      "2 tasks placed there have no agent running (queued, or waiting for their next role): T3 and T4.",
    );
    expect(d?.question).toContain("T1 is running there and is left alone");
    expect(d?.question).toContain("(best now for T3: control)");
    expect(d?.question).toContain(
      "cancel: cancel T1, T3 and T4 (T1's running agent is told to stop).",
    );
    expect(
      schemaErrors(
        "decision.schema.json",
        await f.env.retained(`volley/_waves/w1/decisions/${id}`),
      ),
    ).toEqual([]);
    // Still down: never a second one.
    await f.tick(DOWN_AFTER);
    expect(machineDown("w1")).toHaveLength(1);
  });

  it("re-place queued tasks: only the unspawned tasks move (by decision, from box), never onto box; the running agent is untouched", async () => {
    await runOnBox();
    const t1 = f.agentOf("w1", "T1");
    await f.lwt();
    await f.tick(DOWN_AFTER);
    const id = machineDown("w1")[0]?.data.decision_id as string;
    await f.resolve("w1", id, "re-place queued tasks");
    for (const t of ["T3", "T4"]) {
      expect(placedBy("w1", t).at(-1)?.data).toMatchObject({
        task: t,
        host: "control",
        by: "decision",
        from: "box",
        local: true,
      });
    }
    expect(placedBy("w1", "T1").every((e) => e.data.by !== "decision")).toBe(true);
    expect(f.box()?.closed).toEqual([]);
    expect(f.journal("w1").some((e) => e.type === "task_cancelled")).toBe(false);
    const state = await f.state("w1");
    expect(state.tasks.find((t) => t.id === "T1")).toMatchObject({ host: "box" });
    expect(state.tasks.find((t) => t.id === "T3")?.placement).toMatchObject({
      host: "control",
      by: "decision",
    });
    expect(
      schemaErrors("wave-state.schema.json", await f.env.retained("volley/_waves/w1/state")),
    ).toEqual([]);
    expect(f.daemon.snapshot("w1")?.tasks.find((t) => t.id === "T1")?.agents.implementer).toBe(t1);
  });

  it("wait: nothing is asked again until another task would park there; the machine coming back resolves an open one with wait", async () => {
    await runOnBox();
    await f.lwt();
    await f.tick(DOWN_AFTER);
    const first = machineDown("w1")[0]?.data.decision_id as string;
    await f.resolve("w1", first, "wait");
    await f.tick(DOWN_AFTER * 3);
    expect(machineDown("w1")).toHaveLength(1);
    expect(f.journal("w1").some((e) => e.type === "task_placed" && e.data.by === "decision")).toBe(
      false,
    );
    // A new task queued for box: the question comes back, naming it.
    await f.submit(
      "w1",
      "placement: auto\n",
      "  T1: { issue: 42, host: box }\n  T3: { issue: 42, host: box, after: [T1] }\n  T4: { issue: 42, host: box, after: [T1] }\n  T6: { issue: 42, host: box, after: [T1] }\n",
    );
    await f.tick();
    expect(machineDown("w1")).toHaveLength(2);
    const second = machineDown("w1")[1]?.data.decision_id as string;
    expect((await f.decision("w1", second))?.tasks).toEqual(["T1", "T3", "T4", "T6"]);
    // The machine is back: the open question closes itself with wait.
    await f.beat();
    await f.tick();
    const resolved = f
      .journal("w1")
      .find((e) => e.type === "decision_resolved" && e.data.decision_id === second);
    expect(resolved?.data).toMatchObject({ answer: "wait", by: "volleyd" });
    expect((await f.state("w1")).open_decisions).not.toContain(second);
  });

  it("a task whose agent ended is not running: it is named as waiting and re-place moves it", async () => {
    await f.submit("w1", "placement: auto\n", "  T1: { issue: 42, host: box }\n");
    await f.tick();
    const t1 = f.agentOf("w1", "T1");
    await f.supervised(t1);
    await f.finish(t1, "failed");
    let blocked: string | undefined;
    for (let i = 0; i < 20 && blocked === undefined; i++) {
      await f.tick();
      blocked = f
        .journal("w1")
        .find((e) => e.type === "decision_opened" && e.data.kind === "agent_blocked")?.data
        .decision_id as string | undefined;
    }
    // Its agent is retired, though the task still lists it.
    expect(f.daemon.snapshot("w1")?.tasks.find((t) => t.id === "T1")?.agents.implementer).toBe(t1);
    await f.lwt();
    await f.tick(DOWN_AFTER);
    const id = machineDown("w1")[0]?.data.decision_id as string;
    const d = await f.decision("w1", id);
    expect(d?.question).toContain(
      "1 task placed there has no agent running (queued, or waiting for its next role): T1.",
    );
    expect(d?.question).not.toContain("running there and is left alone");
    expect(d?.question).toContain("re-place queued tasks: place T1 again without box");
    await f.resolve("w1", id, "re-place queued tasks");
    expect(placedBy("w1", "T1").at(-1)?.data).toMatchObject({
      host: "control",
      by: "decision",
      from: "box",
    });
    // Its respawn starts where it now is.
    await f.resolve("w1", blocked as string, "respawn");
    await f.tick();
    expect(f.local.launches.map((l) => l.name)).toEqual(["w1 T1 implementer 2"]);
  });

  it("re-place with no machine eligible: the task waits, then moves as soon as one is", async () => {
    await runOnBox();
    await f.lwt();
    f.setLocalLoad([9999, 9999, 9999]);
    await eventually(async () => {
      await f.tick(30_000);
      return (await f.verdict("control"))?.eligible === false;
    });
    await f.tick(DOWN_AFTER);
    const id = machineDown("w1")[0]?.data.decision_id as string;
    expect((await f.decision("w1", id))?.question).toContain(
      "no other machine is eligible now: they wait for one and are placed as soon as one is",
    );
    await f.resolve("w1", id, "re-place queued tasks");
    const notReplaced = f
      .journal("w1")
      .filter((e) => e.type === "alarm_raised" && e.data.code === "NOT_REPLACED")
      .map((e) => e.task)
      .sort();
    expect(notReplaced).toEqual(["T3", "T4"]);
    expect(placedBy("w1", "T3").some((e) => e.data.by === "decision")).toBe(false);
    // control is fine again (three clean records): the answer still applies.
    f.setLocalLoad([0.5, 0.5, 0.5]);
    await eventually(async () => {
      await f.tick(30_000);
      return placedBy("w1", "T3").some((e) => e.data.by === "decision");
    });
    for (const t of ["T3", "T4"]) {
      expect(placedBy("w1", t).at(-1)?.data).toMatchObject({
        host: "control",
        by: "decision",
        from: "box",
      });
    }
    // Never asked again for them.
    expect(machineDown("w1")).toHaveLength(1);
  });

  it("a down machine that is removed: its open question closes and one without wait follows", async () => {
    await f.submit(
      "w1",
      "placement: auto\n",
      "  T1: { issue: 42 }\n  T3: { issue: 42, host: box, after: [T1] }\n",
    );
    await f.tick();
    await f.lwt();
    await f.tick(DOWN_AFTER);
    const first = machineDown("w1")[0]?.data.decision_id as string;
    expect((await f.decision("w1", first))?.options).toEqual([
      "wait",
      "re-place queued tasks",
      "cancel",
    ]);
    expect(await f.adminOp({ op: "peer_remove", name: "box" })).toMatchObject({ ok: true });
    await f.tick();
    const closed = f
      .journal("w1")
      .find((e) => e.type === "decision_resolved" && e.data.decision_id === first);
    expect(closed?.data).toMatchObject({
      answer: "superseded",
      by: "volleyd",
      rationale: "box was removed",
    });
    expect(machineDown("w1")).toHaveLength(2);
    const second = machineDown("w1")[1]?.data.decision_id as string;
    expect(await f.decision("w1", second)).toMatchObject({
      host: "box",
      machine: "removed",
      tasks: ["T3"],
      options: ["re-place queued tasks", "cancel"],
    });
    expect((await f.state("w1")).open_decisions).toEqual([second]);
  });

  it("cancel cancels the named tasks that have not finished", async () => {
    await runOnBox();
    const t1 = f.agentOf("w1", "T1");
    await f.lwt();
    await f.tick(DOWN_AFTER);
    const id = machineDown("w1")[0]?.data.decision_id as string;
    await f.resolve("w1", id, "cancel");
    const cancelled = f
      .journal("w1")
      .filter((e) => e.type === "task_cancelled")
      .map((e) => e.task)
      .sort();
    expect(cancelled).toEqual(["T1", "T3", "T4"]);
    // The running one is told to stop (it is on box: the cancel waits in its mailbox).
    expect(
      f
        .journal("w1")
        .some(
          (e) => e.type === "steering_sent" && e.data.agent_id === t1 && e.data.type === "cancel",
        ),
    ).toBe(true);
  });
});

describe("a local → auto resubmit of an admitted, unspawned task (#434)", () => {
  let f: Fleet;
  beforeEach(async () => {
    f = await makeFleet();
  });
  afterEach(async () => {
    await f.close();
  });

  it("gives the admission back; the next tick places it on box and spawns it there, never resolving auto", async () => {
    // Admitted on the supervisor's machine, but its launch is refused: no agent, no spawn under way.
    f.local.launchOutcome = "refused";
    await f.submit("w1", "placement: local\n", "  T1: { issue: 42 }\n");
    await f.tick();
    await eventually(async () => {
      await f.tick(0);
      return f.journal("w1").some((e) => e.type === "spawn_failed" && e.task === "T1");
    });
    f.local.launchOutcome = "ok";

    await f.submit("w1", "placement: auto\nplacement_prefer: [box]\n", "  T1: { issue: 42 }\n");
    expect(f.journal("w1").filter((e) => e.type === "task_admission_returned")).toMatchObject([
      { task: "T1", data: { task: "T1", from_host: "local", to_host: "auto" } },
    ]);
    // Past the refused launch's 30 s backoff, within box's heartbeat timeout.
    await f.tick(40_000);
    await eventually(async () => {
      await f.tick(0);
      return f.journal("w1").some((e) => e.type === "agent_spawned" && e.task === "T1");
    });
    const j = f.journal("w1");
    expect(j.filter((e) => e.type === "task_placed")).toMatchObject([
      { task: "T1", data: { host: "box", by: "auto" } },
    ]);
    expect(j.find((e) => e.type === "agent_spawned" && e.task === "T1")?.data.host).toBe("box");
    expect(
      j.some((e) => e.type === "alarm_raised" && e.data.alarm === "host_auto_unresolved"),
    ).toBe(false);
    expect(
      j.some((e) => typeof e.data.message === "string" && e.data.message.includes("host 'auto'")),
    ).toBe(false);
  });
});
