import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import { authOpsTopic, authReplyTopic } from "../../src/accounts";
import { ControlClient } from "../../src/control";
import type { Daemon } from "../../src/daemon";
import type { DecisionPayload } from "../../src/decisions";
import type { LaunchSpec } from "../../src/hosts/host";
import { agentIdFor } from "../../src/identity";
import { readJournalFile } from "../../src/journal";
import { MACHINE_CHANNEL, type MachineRecord, machineTopic } from "../../src/machines";
import type { ReadinessPayload } from "../../src/readiness";
import type { JournalEvent, TaskState } from "../../src/types";
import { eventually } from "./broker-wait";
import { type DaemonEnv, NS, makeDaemonEnv } from "./daemon-env";
import { type FakeClock, fakeClock } from "./fake-clock";
import { memoryCredentials } from "./fake-dynsec";
import { type FakeExec, fakeExec } from "./fake-exec";
import {
  FIXTURES,
  type FakeHost,
  type FakeRemoteHost,
  GREEN_DOCTOR,
  adoptSpec,
  fakeHost,
  fakeRemoteHost,
} from "./fake-host";
import { type JournalWait, journalWait } from "./journal-wait";
import { runCli } from "./run-cli";

/**
 * A supervisor (`control`) with one paired peer (`box`), both ready, on fakes and a fake clock
 * (SPEC §4.6.14 / §4.6.15): what the Fleet's down, drain and re-placement tests drive. Every
 * launched agent (on either machine) runs a simulated session: it registers, its hooks report,
 * and it heartbeats, so the daemon supervises it. `admin-1` is an admin account and `box` a
 * peer account (`volley auth` is faked), so admin ops go over the account-op topic.
 */

export const VERSION = "0.4.0";
export const LOCAL = "control";
export const PEER = "box";

export interface Fleet {
  env: DaemonEnv;
  daemon: Daemon;
  clock: FakeClock;
  waits: JournalWait;
  client: ControlClient;
  local: FakeHost;
  /** The supervisor's fake exec (git, gh): add replies with `on`. */
  exec: FakeExec;
  /**
   * Hold launched sessions (true): an agent launches but does not register until released
   * (false), so it stays launched and unverified.
   */
  holdSessions: (hold: boolean) => void;
  /** The supervisor's own load averages, read into its next machine record. */
  setLocalLoad: (load: [number, number, number]) => void;
  /** The peer's host (created on its first use). */
  box: () => FakeRemoteHost | undefined;
  /** The fake `volley auth` accounts: name → role. */
  accounts: Map<string, string>;
  journal: (wave: string) => JournalEvent[];
  system: () => JournalEvent[];
  state: (wave: string) => Promise<{ tasks: TaskState[]; open_decisions: string[] }>;
  task: (wave: string, id: string) => Promise<TaskState | undefined>;
  verdict: (name: string) => Promise<ReadinessPayload | null>;
  decision: (wave: string, id: string) => Promise<DecisionPayload | null>;
  /** The box's heartbeat (a newer `last_seen`), folded in and its verdict re-computed. */
  beat: (over?: Partial<MachineRecord>) => Promise<void>;
  /** The box's LWT: down at once (`disconnect`). */
  lwt: () => Promise<void>;
  tick: (ms?: number) => Promise<void>;
  submit: (wave: string, head: string, tasks: string, pipeline?: string) => Promise<void>;
  /** The live agent's id for `wave/task/role` (its latest attempt). */
  agentOf: (wave: string, task: string, role?: string) => string;
  /** The simulated session publishes its terminal status. */
  finish: (agentId: string, type: "done" | "failed" | "reaped" | "blocked") => Promise<void>;
  /** Wait until `agentId` is supervised (the readiness `placed` of its machine counts it). */
  supervised: (agentId: string) => Promise<void>;
  /** An admin op as `admin-1` on the account-op topic; its answer. */
  adminOp: (payload: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  /** Stop the daemon and start a second one on the same home and fakes (a volleyd restart). */
  restart: () => Promise<Daemon>;
  /** The owner answers (no ownership check: `Daemon.resolveDecision`). */
  resolve: (wave: string, id: string, answer: string) => Promise<unknown>;
  close: () => Promise<void>;
}

export async function makeFleet(
  o: { extraConfig?: string; localAgents?: "always" | "fallback" | "never" } = {},
): Promise<Fleet> {
  const env = await makeDaemonEnv();
  const dir = realpathSync(env.home);
  const repo = join(dir, "repo");
  mkdirSync(repo);
  let box: FakeRemoteHost | undefined;
  const accounts = new Map<string, string>([
    ["admin-1", "admin"],
    [PEER, "peer"],
  ]);
  const fake = fakeExec()
    .on(["git", "-C", repo, "rev-parse", "--show-toplevel"], { stdout: `${repo}\n` })
    .on(["git", "-C", repo, "rev-parse", "--verify"], { stdout: `${"1".repeat(40)}\n` })
    .on(["git", "-C", repo, "fetch"], {})
    .on(["gh", "issue", "view"], {
      stdout: readFileSync(join(FIXTURES, "gh-issue-42.json"), "utf-8"),
    });
  const auth: FakeExec = fakeExec()
    .on(["volley", "auth", "list"], () => ({
      stdout: JSON.stringify({
        accounts: [...accounts].map(([name, role]) => ({
          name,
          role,
          kind: "machine",
          created: "2026-10-19T09:00:00.000Z",
        })),
      }),
    }))
    .on(["volley", "auth", "revoke"], (argv) => {
      accounts.delete(argv[3] as string);
      return {};
    });
  const local = fakeHost(fake);
  let localLoad: [number, number, number] = [0.5, 0.5, 0.5];
  const claudeJson = join(dir, "local-claude.json");
  writeFileSync(
    claudeJson,
    `${JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } })}\n`,
  );
  writeFileSync(
    join(env.home, "config.yaml"),
    // The own machine a candidate like the peer (local_agents: always, unless `localAgents`): the
    // fallback has its own tests.
    `fleet:\n  local_name: ${LOCAL}\n  local_agents: ${o.localAgents ?? "always"}\nhosts:\n  ${PEER}:\n    target: dev@${PEER}\n    repo: ${repo}\n    volley_dir: /opt/volley\n    worktree_root: ${join(dir, "remote-wt")}\n    tunnel: { remote_port: 21883, supervise: false }\n${o.extraConfig ?? ""}`,
  );
  writeFileSync(
    join(env.home, "peers.json"),
    `${JSON.stringify({ peers: { [PEER]: { target: `dev@${PEER}`, joined_at: "2026-10-19T09:00:00.000Z" } } })}\n`,
  );
  const clock = fakeClock(Date.parse("2026-10-19T10:00:00.000Z"));
  const journal = (wave: string): JournalEvent[] =>
    readJournalFile(join(env.home, "waves", wave, "journal.jsonl"));

  // The simulated sessions: an agent connects as itself, registers and heartbeats.
  const sim = new VolleyBroker();
  await sim.connect({ url: env.broker.url, agentId: "session-sim" });
  const sessions = new Set<Promise<void>>();
  const pub = (agentId: string, topic: string, type: string, channel: string, payload: unknown) =>
    sim.publish(
      topic,
      JSON.stringify({
        ...buildEnvelope({ agentId, parentId: "volleyd", channel, type, payload }),
        ...(channel === "_system/registry" ? { namespace: NS } : {}),
      }),
      { qos: 1, retain: channel !== "progress" },
    );
  const launched = new Map<string, string>();
  let held: (() => void)[] | null = null;
  const onLaunch = (spec: LaunchSpec) => {
    const [wave = "", task = "", role = ""] = spec.name.split(" ");
    const attempt =
      journal(wave).filter(
        (e) => e.type === "agent_spawned" && e.task === task && e.data.role === role,
      ).length + 1;
    const id = agentIdFor(wave, task, role, attempt);
    launched.set(`${wave}/${task}/${role}`, id);
    if (held !== null) {
      held.push(() => run(id, spec));
      return;
    }
    run(id, spec);
  };
  const run = (id: string, spec: LaunchSpec) => {
    const session = (async () => {
      await pub(id, buildTopic(NS, id, "status"), "spawning", "status", {});
      await pub(id, registryTopic(id), "registered", "_system/registry", {
        capabilities: [],
        cwd: spec.cwd,
        started_at: new Date(clock.now()).toISOString(),
        model: "claude-opus-5-5",
        model_source: "harness-hook",
      });
      await pub(id, buildTopic(NS, id, "status"), "working", "status", {
        source: "harness-hook",
      });
      await pub(id, buildTopic(NS, id, "progress"), "heartbeat", "progress", {
        source: "harness-hook",
        seq: 1,
        hook_event: "SessionStart",
      });
    })();
    sessions.add(session);
    void session.finally(() => sessions.delete(session));
  };
  local.onLaunch = onLaunch;

  const options: Parameters<DaemonEnv["start"]>[0] = {
    clock,
    authExec: auth.exec,
    fleet: {
      version: VERSION,
      localDoctor: async () => ({
        ...GREEN_DOCTOR,
        versions: { peer: VERSION, volley: VERSION, bun: "1.3.1", git: "2.43.0" },
      }),
      localPath: () => ({ claude: true, bun: true }),
      os: { loadavg: () => localLoad },
    },
    spawner: {
      host: local,
      hooksDir: "/opt/local-hooks",
      claudeJsonPath: claudeJson,
      remoteHost: (s) => {
        if (box === undefined) {
          box = fakeRemoteHost(s, local);
          box.onLaunch = onLaunch;
        }
        return adoptSpec(box, s);
      },
      credentials: memoryCredentials(),
    },
  };
  let daemon = await env.start(options);
  const waits = journalWait(env.home, () => daemon);
  const peer = new VolleyBroker();
  await peer.connect({ url: env.broker.url, agentId: PEER });
  const client = await ControlClient.connect(env.broker.url, NS);

  const boxRecord = (over: Partial<MachineRecord> = {}): MachineRecord => ({
    name: PEER,
    os: "linux",
    cores: 16,
    tunnel: "up",
    load: [3.2, 3, 2],
    agents: 0,
    memory: { total_mb: 65536, available_pct: 71 },
    checks: GREEN_DOCTOR.checks.map(({ id, ok, severity, detail }) => ({
      id,
      ok,
      severity,
      detail,
    })),
    versions: { peer: VERSION, volley: VERSION, bun: "1.3.1", git: "2.43.0" },
    auth: { gh: "ok", claude: "signed_in", trust: "ok" },
    doctor_at: GREEN_DOCTOR.doctor_at,
    last_seen: new Date(clock.now()).toISOString(),
    ...over,
  });
  const publishRecord = (r: MachineRecord) =>
    peer.publish(
      machineTopic(PEER),
      JSON.stringify(
        buildEnvelope({
          agentId: PEER,
          parentId: null,
          channel: MACHINE_CHANNEL,
          type: "machine",
          payload: r,
        }),
      ),
      { qos: 1, retain: true },
    );
  const verdict = async (name: string) =>
    (
      (await env.retained(`${machineTopic(name)}/readiness`)) as {
        payload: ReadinessPayload;
      } | null
    )?.payload ?? null;
  const tick = async (ms = 1000) => {
    await clock.advance(ms);
    await daemon.tick();
    await waits.settled();
  };
  const beat = async (over: Partial<MachineRecord> = {}) => {
    await clock.advance(1000);
    await publishRecord(boxRecord(over));
    await eventually(async () => {
      await tick(0);
      return (await verdict(PEER))?.checked_at === new Date(clock.now()).toISOString();
    });
  };
  const state = async (wave: string) => {
    await waits.settled();
    return (
      (await env.retained(`volley/_waves/${wave}/state`)) as {
        payload: { tasks: TaskState[]; open_decisions: string[] };
      }
    ).payload;
  };

  const fleet: Fleet = {
    env,
    get daemon() {
      return daemon;
    },
    clock,
    waits,
    client,
    local,
    exec: fake,
    holdSessions: (hold) => {
      const pending = held ?? [];
      held = hold ? pending : null;
      if (!hold) for (const start of pending) start();
    },
    setLocalLoad: (load) => {
      localLoad = load;
    },
    box: () => box,
    accounts,
    journal,
    system: () => journal("_system"),
    state,
    task: async (wave, id) => (await state(wave)).tasks.find((t) => t.id === id),
    verdict,
    decision: async (wave, id) =>
      (
        (await env.retained(`volley/_waves/${wave}/decisions/${id}`)) as {
          payload: DecisionPayload;
        } | null
      )?.payload ?? null,
    beat,
    lwt: async () => {
      await publishRecord(boxRecord({ tunnel: "down", reason: "disconnect" }));
      await eventually(async () => {
        await tick(0);
        const a = await client.request("peers", {});
        const m = (a.result as { machines: MachineRecord[] }).machines.find((x) => x.name === PEER);
        return m?.tunnel === "down";
      });
    },
    tick,
    submit: async (wave, head, tasks, pipeline = "[implement]") => {
      const file = join(env.home, `${wave}.yaml`);
      writeFileSync(
        file,
        `wave: ${wave}\nrepo: ${repo}\nrelease_branch: release/${wave}\nmodel: claude-opus-5-5\npipeline: ${pipeline}\n${head}tasks:\n${tasks}`,
      );
      const r = await runCli(["run", file], env.env);
      if (r.exitCode !== 0) throw new Error(`run ${wave}: ${r.stderr}`);
    },
    agentOf: (wave, task, role = "implementer") => {
      const id = launched.get(`${wave}/${task}/${role}`);
      if (id === undefined) throw new Error(`no agent launched for ${wave}/${task}/${role}`);
      return id;
    },
    finish: async (agentId, type) => {
      await pub(agentId, buildTopic(NS, agentId, "status"), type, "status", {
        ...(type === "done"
          ? { summary: "ok" }
          : { reason: type === "reaped" ? "lwt" : "gave up" }),
      });
    },
    supervised: async (agentId) => {
      await eventually(async () => {
        await tick(0);
        return journal(agentId.split("-")[0] ?? "").some(
          (e) => e.type === "agent_registered" && e.data.agent_id === agentId,
        );
      });
    },
    adminOp: async (payload) => {
      const c = new VolleyBroker();
      await c.connect({ url: env.broker.url, agentId: `cli-${randomUUID().slice(0, 6)}` });
      const cid = randomUUID();
      let resolve!: (p: Record<string, unknown> | null) => void;
      const reply = new Promise<Record<string, unknown> | null>((r) => {
        resolve = r;
      });
      await c.subscribeStream(authReplyTopic(cid), ({ payload: raw }) => {
        const e = parseEnvelope(raw);
        if (e?.type === "ack" && e.agent_id === "volleyd" && e.correlation_id === cid) {
          resolve(e.payload as Record<string, unknown>);
        }
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
    },
    restart: async () => {
      await daemon.stop();
      daemon = await env.start(options);
      await daemon.reconciled();
      await waits.settled();
      return daemon;
    },
    resolve: async (wave, id, answer) => {
      const r = await daemon.resolveDecision(wave, id, { answer, by: "owner" });
      await waits.settled();
      return r;
    },
    close: async () => {
      await Promise.all([...sessions]);
      await client.close();
      await peer.disconnect();
      await sim.disconnect();
      await env.cleanup();
    },
  };
  // The box's record folds in and its first PATH probe runs: both machines are ready.
  await publishRecord(boxRecord());
  await eventually(async () => {
    await tick();
    return (await verdict(PEER))?.ready === true && (await verdict(LOCAL))?.ready === true;
  });
  return fleet;
}
