import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { memoryOf, vmStatAvailablePct } from "volley-cli/peer/machine";
import { MAC_16GB_BYTES, VM_STAT_MAC_16GB } from "volley-cli/test/vm-stat";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import { cleanupWave } from "../src/commands/cleanup";
import { CONFIG_DEFAULTS, DAEMON_DEFAULTS } from "../src/config-defaults";
import { ControlClient } from "../src/control";
import type { Daemon } from "../src/daemon";
import { decisionTopic } from "../src/decisions";
import { makeBufferIO } from "../src/io";
import { readJournalFile } from "../src/journal";
import { MACHINE_CHANNEL, type MachineRecord, machineTopic } from "../src/machines";
import type { ReadinessPayload } from "../src/readiness";
import { trustDecisionId } from "../src/trust";
import type { JournalEvent, TaskState } from "../src/types";
import { addWorktree } from "../src/worktree";
import { eventually } from "./helpers/broker-wait";
import { CALM_OS, type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { type FakeClock, fakeClock } from "./helpers/fake-clock";
import { type MemoryCredentials, memoryCredentials } from "./helpers/fake-dynsec";
import { asApiRuns, fakeExec } from "./helpers/fake-exec";
import {
  FIXTURES,
  type FakeHost,
  type FakeRemoteHost,
  GREEN_DOCTOR,
  fakeHost,
  fakeRemoteHost,
} from "./helpers/fake-host";
import { type EventMatch, type JournalWait, journalWait } from "./helpers/journal-wait";
import { runCli, withoutOwnerWarning } from "./helpers/run-cli";
import { schemaErrors } from "./helpers/schema";

const ID = "w1-t1-implementer-1";

describe("daemon spawn loop", () => {
  let env: DaemonEnv;
  let agent: VolleyBroker;
  let host: FakeHost;
  let creds: MemoryCredentials;
  let repo: string;
  let claudeJson: string;
  let daemon: Daemon;
  /** The daemon's clock: reap graces and verification windows move only when the test says. */
  let clock: FakeClock;
  let waits: JournalWait;
  /** The simulated session's publishes (teardown waits for them). */
  const sessions = new Set<Promise<void>>();
  /** With `freshBase`: while true, `git fetch origin release/w1` fails (offline). */
  let fetchFails = false;

  const journal = (): JournalEvent[] =>
    readJournalFile(join(env.home, "waves", "w1", "journal.jsonl"));
  /** The n-th journal event matching `match`, awaited as the daemon appends it. */
  const event = (match: EventMatch, n = 1) => waits.event("w1", match, n);
  const pub = (topic: string, type: string, channel: string, payload: unknown, retain = true) =>
    agent.publish(
      topic,
      JSON.stringify({
        ...buildEnvelope({ agentId: ID, parentId: "volleyd", channel, type, payload }),
        ...(channel === "_system/registry" ? { namespace: NS } : {}),
      }),
      { qos: 1, retain },
    );

  /** A daemon with the spawner on fakes, and wave w1 (one task, T1) submitted to it. */
  async function setup(
    o: {
      trusted?: boolean;
      /** Cut worktrees through the real release-base resolution (worktree.ts) on the fake exec. */
      freshBase?: boolean;
      /** Extra per-wave `config:` entries. */
      config?: string;
    } = {},
  ) {
    env = await makeDaemonEnv();
    repo = realpathSync(env.home);
    repo = join(repo, "repo");
    mkdirSync(repo);
    claudeJson = join(env.home, "claude.json");
    writeFileSync(
      claudeJson,
      JSON.stringify({
        projects: o.trusted === false ? {} : { [repo]: { hasTrustDialogAccepted: true } },
      }),
    );
    agent = new VolleyBroker();
    await agent.connect({ url: env.broker.url, agentId: "agent-sim" });
    const fake = fakeExec()
      .on(["git", "-C", repo, "rev-parse", "--show-toplevel"], { stdout: `${repo}\n` })
      .on(["git", "-C", repo, "rev-parse", "--verify", "--quiet", "refs/heads/release/w1"], {
        stdout: `${"1".repeat(40)}\n`,
      })
      .on(["gh", "issue", "view"], {
        stdout: readFileSync(join(FIXTURES, "gh-issue-42.json"), "utf-8"),
      });
    // The implementer's claimed artifacts (T6 verifies them before retiring it): pushed, one PR
    // for its branch against the release branch, CI green on the head, release branch current.
    const wt = join(env.home, "wt", "w1", "T1-implementer");
    const head = "1111111111111111111111111111111111111111";
    fake
      .on(["git", "-C", wt, "rev-parse"], { stdout: `${head}\n` })
      .on(["git", "-C", wt, "merge-base"], { stdout: `${head}\n` })
      .on(["gh", "pr", "list"], {
        stdout: JSON.stringify([
          {
            number: 7,
            url: "https://github.com/example/repo/pull/7",
            headRefName: "w1/T1-implementer-1",
            baseRefName: "release/w1",
            headRefOid: head,
          },
        ]),
      })
      .on(["gh", "api"], {
        stdout: asApiRuns(
          JSON.stringify([
            {
              databaseId: 1,
              name: "CI",
              status: "completed",
              conclusion: "success",
              headSha: head,
              url: "https://github.com/example/repo/actions/runs/1",
            },
          ]),
        ),
      })
      .on(["gh", "pr", "view"], {
        stdout: JSON.stringify({ state: "OPEN", baseRefName: "release/w1" }),
      });
    fake.on(["git", "-C", repo, "fetch"], () =>
      fetchFails ? { code: 128, stderr: "fatal: unable to access origin" } : {},
    );
    creds = memoryCredentials();
    host = fakeHost(fake);
    if (o.freshBase === true) {
      const prepare = host.prepareWorktree.bind(host);
      host.prepareWorktree = async (spec) => {
        const r = await addWorktree(fake.exec, spec);
        await prepare(spec);
        return r;
      };
    }
    // The launched session: MCP registers, the SessionStart hook re-publishes + heartbeats.
    host.onLaunch = () => {
      const session = (async () => {
        await pub(buildTopic(NS, ID, "status"), "spawning", "status", {});
        await pub(registryTopic(ID), "registered", "_system/registry", {
          capabilities: [],
          cwd: "/wt",
          started_at: new Date().toISOString(),
          model: "claude-opus-5-5",
          model_source: "harness-hook",
        });
        await pub(buildTopic(NS, ID, "status"), "working", "status", { source: "harness-hook" });
        await pub(
          buildTopic(NS, ID, "progress"),
          "heartbeat",
          "progress",
          { source: "harness-hook", seq: 1, hook_event: "SessionStart" },
          false,
        );
      })();
      sessions.add(session);
      void session.finally(() => sessions.delete(session));
    };
    clock = fakeClock(Date.now());
    daemon = await env.start({
      clock,
      spawner: {
        host,
        claudeJsonPath: claudeJson,
        hooksDir: "/opt/volley-hooks",
        reapGraceMs: 300,
        credentials: creds,
      },
    });
    waits = journalWait(env.home, () => daemon);
    const wave = join(env.home, "w1.yaml");
    writeFileSync(
      wave,
      `wave: w1\nrepo: ${repo}\nrelease_branch: release/w1\nmodel: claude-opus-5-5\npipeline: [implement]\ntasks:\n  T1: { issue: 42 }\nconfig: { worktree_root: ${join(env.home, "wt")}${o.config !== undefined ? `, ${o.config}` : ""} }\n`,
    );
    const r = await runCli(["run", wave], env.env);
    expect(r.exitCode).toBe(0);
  }

  afterEach(async () => {
    fetchFails = false;
    await Promise.all([...sessions]);
    await agent.disconnect();
    await env.cleanup();
  });

  it("spawns the admitted implementer, verifies it through the hooks, refuses a second spawn, retires on done", async () => {
    await setup();
    await event("agent_registered");
    await waits.settled();
    const types = journal().map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "task_admitted",
        "agent_spawned",
        "stage_entered",
        "agent_registered",
      ]),
    );
    expect(host.launches).toHaveLength(1);
    const state = (await env.retained("volley/_waves/w1/state")) as {
      payload: { tasks: { id: string; stage: string; agents: Record<string, string> }[] };
    };
    expect(state.payload.tasks[0]).toMatchObject({
      stage: "implement",
      agents: { implementer: ID },
    });

    // A second `volleyd spawn` for the same worktree while the agent is working is refused.
    const second = await runCli(["spawn", "w1", "T1", "--json"], env.env);
    expect(second.exitCode).toBe(1);
    expect(JSON.parse(second.stdout).result.code).toBe("SPAWN_LOCKED");
    expect(host.launches).toHaveLength(1);
    expect(
      journal()
        .filter((e) => e.type === "alarm_raised")
        .at(-1)?.data,
    ).toMatchObject({
      code: "SPAWN_LOCKED",
    });
    // A refused extra spawn says nothing about the running task: no spawn failure, no alarm.
    expect(journal().some((e) => e.type === "spawn_failed")).toBe(false);
    expect(daemon.snapshot("w1")?.tasks[0]?.last_error).toBeUndefined();
    expect(daemon.snapshot("w1")?.open_decisions).toEqual([]);

    // done → retire: credentials revoked, retained records cleared, lock released.
    await pub(buildTopic(NS, ID, "result"), "result", "result", { summary: "ok" });
    await pub(buildTopic(NS, ID, "status"), "done", "status", { summary: "ok" });
    await event("agent_retired");
    // The cleared status/result payloads are kept in the journal.
    expect(journal().find((e) => e.type === "agent_retired")?.data).toMatchObject({
      agent_id: ID,
      status: "done",
      terminal: { summary: "ok" },
      result: { summary: "ok" },
    });
    // Retired only after its artifacts were verified; `[implement]` then ends at the gate.
    const order = journal().map((e) => e.type);
    expect(order.indexOf("artifact_verified")).toBeLessThan(order.indexOf("agent_retired"));
    await event((e) => e.data.stage === "merge_ready");
    // The state that stage change published is on the broker once the daemon is idle.
    await waits.settled();
    const gated = (await env.retained("volley/_waves/w1/state")) as {
      payload: { gates: string[]; tasks: { evidence_path?: string }[] };
    };
    expect(gated.payload.gates).toEqual(["T1"]);
    expect(existsSync(gated.payload.tasks[0]?.evidence_path as string)).toBe(true);
    expect(creds.revoked).toEqual([ID]);
    expect(await env.retained(registryTopic(ID))).toBeNull();
    expect(await env.retained(buildTopic(NS, ID, "status"))).toBeNull();
    expect(await env.retained(buildTopic(NS, ID, "result"))).toBeNull();
    const lock = journal().find((e) => e.type === "agent_spawned")?.data.lock as string;
    expect(existsSync(lock)).toBe(false);

    // The retire closed its workspace; cleanup: dry run lists the worktree, --yes removes it.
    expect(host.closed).toEqual(["workspace:1"]);
    const io = makeBufferIO();
    const worktree = join(env.home, "wt", "w1", "T1-implementer");
    expect(await cleanupWave(env.home, "w1", { yes: false, force: false }, io)).toBe(0);
    expect(io.readStdout()).toContain(`would remove ${worktree}\n`);
    const fx = fakeExec();
    expect(await cleanupWave(env.home, "w1", { yes: true, force: false, exec: fx.exec }, io)).toBe(
      0,
    );
    expect(fx.argvs()).toEqual([
      ["git", "-C", repo, "worktree", "remove", worktree],
      // The wave's leftover claude processes are looked for (none here).
      ["ps", "-axo", "pid=,command="],
    ]);
  });

  it("a failed release-branch fetch refuses with BASE_STALE, backs off like any spawn failure, and the retry records base_sha", async () => {
    fetchFails = true;
    await setup({ freshBase: true });
    const failed = await event("spawn_failed");
    expect(failed?.data).toMatchObject({ code: "BASE_STALE", role: "implementer", attempt: 1 });
    expect(failed?.data.message).toContain("fatal: unable to access origin");
    expect(typeof failed?.data.next_retry_at).toBe("string");
    await waits.settled();
    expect(host.launches).toHaveLength(0);
    expect(daemon.snapshot("w1")?.tasks[0]).toMatchObject({
      stage: "queued",
      last_error: { code: "BASE_STALE" },
    });

    // The network is back: the backoff's retry fetches, cuts the worktree and records its base.
    fetchFails = false;
    await clock.advance(DAEMON_DEFAULTS.spawn_retry_base_ms);
    await daemon.tick();
    const spawned = await event("agent_spawned");
    expect(spawned?.data.base_sha).toBe("1".repeat(40));
    await event("agent_registered");
    await waits.settled();
    expect(daemon.snapshot("w1")?.tasks[0]?.base_sha).toBe("1".repeat(40));
    const state = (await env.retained("volley/_waves/w1/state")) as {
      payload: { tasks: { base_sha?: string }[] };
    };
    expect(state.payload.tasks[0]?.base_sha).toBe("1".repeat(40));
  });

  it("require_fresh_base off: a failed fetch spawns from the local copy and journals a BASE_STALE warning", async () => {
    fetchFails = true;
    await setup({ freshBase: true, config: "require_fresh_base: false" });
    const spawned = await event("agent_spawned");
    expect(spawned?.data.base_sha).toBe("1".repeat(40));
    await event("agent_registered");
    await waits.settled();
    expect(journal().some((e) => e.type === "spawn_failed")).toBe(false);
    const warning = journal().find(
      (e) => e.type === "alarm_raised" && e.data.code === "BASE_STALE",
    );
    expect(warning?.data).toMatchObject({
      code: "BASE_STALE",
      severity: "warning",
      role: "implementer",
      base_sha: "1".repeat(40),
      fetch_error: "fatal: unable to access origin",
    });
  });

  it("cleanup skips worktrees whose agent is not retired", async () => {
    await setup();
    await event("agent_registered");
    await waits.settled();
    const io = makeBufferIO();
    const fx = fakeExec();
    await cleanupWave(env.home, "w1", { yes: true, force: false, exec: fx.exec }, io);
    expect(fx.calls).toEqual([]);
    expect(io.readStdout()).toContain(`agent(s) not retired: ${ID}`);
  });

  it("reaped is not retired while the session comes back; reaped and quiet past the grace is", async () => {
    await setup();
    await event("agent_registered");
    await waits.settled();
    const lock = journal().find((e) => e.type === "agent_spawned")?.data.lock as string;
    // An LWT from a network blip: the reap is held for its grace (300 ms on the daemon's clock).
    await pub(buildTopic(NS, ID, "status"), "reaped", "status", { reason: "lwt" });
    await clock.armed(300);
    const held = clock.pending();
    // Then the MCP server reconnects with a fresh spawning: the held reap is dropped.
    await pub(buildTopic(NS, ID, "status"), "spawning", "status", {});
    await eventually(() => clock.pending() < held);
    await clock.advance(600); // two graces
    await waits.settled();
    expect(journal().some((e) => e.type === "agent_retired")).toBe(false);
    expect(creds.revoked).toEqual([]);
    expect(existsSync(lock)).toBe(true);
    // Reaped for good: retired after the grace.
    await pub(buildTopic(NS, ID, "status"), "reaped", "status", { reason: "lwt" });
    await clock.armed(300);
    await clock.advance(300);
    await event("agent_retired");
    expect(journal().find((e) => e.type === "agent_retired")?.data).toMatchObject({
      agent_id: ID,
      status: "reaped",
      lock_released: true,
    });
  });

  it("an untrusted repo opens a published repo_untrusted decision; answering trust records it and spawns", async () => {
    await setup({ trusted: false });
    const opened = await event("decision_opened");
    await waits.settled();
    const id = opened?.data.decision_id as string;
    expect(opened?.data).toMatchObject({ kind: "repo_untrusted", repo });
    expect(host.launches).toHaveLength(0);
    const retained = (await env.retained(decisionTopic("w1", id))) as { payload: unknown };
    expect(retained.payload).toMatchObject({ kind: "repo_untrusted", task: "T1" });

    const r = await runCli(["resolve", id, "trust", "--by", "tester"], env.env);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(claudeJson, "utf-8")).projects[repo]).toEqual({
      hasTrustDialogAccepted: true,
    });
    await daemon.tick();
    await event("agent_registered");
    expect(host.launches).toHaveLength(1);
  });

  it("a repo_untrusted decision raised from a pane resolves on the next tick once the repo is trusted", async () => {
    await setup();
    await event("agent_registered");
    await waits.settled();
    // As verify does on a trust-dialog screen: the task is past `queued`, so no spawn re-checks.
    const d = await daemon.openDecision("w1", {
      kind: "repo_untrusted",
      task: "T1",
      question: `Needs you: trust ${repo} for dispatch?`,
      id: trustDecisionId("w1", repo),
    });
    expect(daemon.record("w1")?.state?.open_decisions).toEqual([d.decision_id]);
    await daemon.tick();
    const resolved = journal().find((e) => e.type === "decision_resolved");
    expect(resolved?.data).toMatchObject({
      decision_id: d.decision_id,
      answer: "trusted",
      by: "claude-trust-dialog",
    });
    expect(daemon.record("w1")?.state?.tasks[0]?.stage).toBe("implement");
  });

  it("stop interrupts the agent in its workspace; the kill switch refuses spawns", async () => {
    await setup();
    await event("agent_registered");
    await waits.settled();
    expect((await runCli(["stop", "w1", "--by", "tester"], env.env)).exitCode).toBe(0);
    expect(host.keys).toContainEqual({ workspace: "workspace:1", key: "Escape" });
    expect((await runCli(["stop", "--all", "--by", "tester"], env.env)).exitCode).toBe(0);
    const r = await runCli(["spawn", "w1", "T1", "--json"], env.env);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).error).toContain("kill switch");
  });
});

describe("placement at admission (SPEC §4.6.15)", () => {
  const VERSION = "0.4.0";
  let env: DaemonEnv;
  let peer: VolleyBroker;
  let client: ControlClient;
  let local: FakeHost;
  let box: FakeRemoteHost | undefined;
  let daemon: Daemon;
  let clock: FakeClock;
  let waits: JournalWait;
  let repo: string;
  /** Whether the supervisor's own agents' PATH has claude and bun (false: it is not ready). */
  let localClaude: boolean;
  /** The daemon's log lines. */
  let logs: string[];

  const journal = (wave: string): JournalEvent[] =>
    readJournalFile(join(env.home, "waves", wave, "journal.jsonl"));
  const boxRecord = (over: Partial<MachineRecord> = {}): MachineRecord => ({
    name: "box",
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
  const heartbeat = async (over: Partial<MachineRecord> = {}) => {
    await peer.publish(
      machineTopic("box"),
      JSON.stringify(
        buildEnvelope({
          agentId: "box",
          parentId: null,
          channel: MACHINE_CHANNEL,
          type: "machine",
          payload: boxRecord(over),
        }),
      ),
      { qos: 1, retain: true },
    );
  };
  type Verdict = { payload: ReadinessPayload };
  const verdict = async (name: string) =>
    (await env.retained(`${machineTopic(name)}/readiness`)) as Verdict | null;
  /** A new heartbeat from the box (a later `last_seen`), folded in and its verdict re-computed. */
  const beat = async (over: Partial<MachineRecord> = {}) => {
    await clock.advance(1000);
    await heartbeat(over);
    await eventually(async () => {
      await tick(0);
      return (await verdict("box"))?.payload.checked_at === new Date(clock.now()).toISOString();
    });
  };
  const tick = async (ms = 1000) => {
    await clock.advance(ms);
    await daemon.tick();
    await waits.settled();
  };
  const state = async (wave: string) =>
    (
      (await env.retained(`volley/_waves/${wave}/state`)) as {
        payload: { tasks: TaskState[] };
      }
    ).payload;
  const submit = async (wave: string, head: string, tasks: string) => {
    const file = join(env.home, `${wave}.yaml`);
    writeFileSync(
      file,
      `wave: ${wave}\nrepo: ${repo}\nrelease_branch: release/${wave}\nmodel: claude-opus-5-5\npipeline: [implement, spec_review]\n${head}tasks:\n${tasks}`,
    );
    const r = await runCli(["run", file], env.env);
    expect(withoutOwnerWarning(r.stderr)).toBe("");
    expect(r.exitCode).toBe(0);
  };

  async function setup(
    o: {
      drain?: boolean;
      extraConfig?: string;
      /** `fleet.local_agents` (unset: derived, so `fallback` with box configured). */
      localAgents?: "always" | "fallback" | "never";
      os?: typeof CALM_OS;
      doctor?: Partial<typeof GREEN_DOCTOR>;
    } = {},
  ) {
    env = await makeDaemonEnv();
    const dir = realpathSync(env.home);
    repo = join(dir, "repo");
    mkdirSync(repo);
    box = undefined;
    const fake = fakeExec()
      .on(["git", "-C", repo, "rev-parse", "--show-toplevel"], { stdout: `${repo}\n` })
      .on(["git", "-C", repo, "rev-parse", "--verify"], { stdout: `${"1".repeat(40)}\n` })
      .on(["git", "-C", repo, "fetch"], {})
      .on(["gh", "issue", "view"], {
        stdout: readFileSync(join(FIXTURES, "gh-issue-42.json"), "utf-8"),
      });
    local = fakeHost(fake);
    const claudeJson = join(dir, "local-claude.json");
    writeFileSync(
      claudeJson,
      `${JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } })}\n`,
    );
    writeFileSync(
      join(env.home, "config.yaml"),
      `fleet:\n  local_name: control\n${o.localAgents !== undefined ? `  local_agents: ${o.localAgents}\n` : ""}hosts:\n  box:\n    target: dev@box\n    repo: ${repo}\n    volley_dir: /opt/volley\n    worktree_root: ${join(dir, "remote-wt")}\n    tunnel: { remote_port: 21883, supervise: false }\n${o.drain === true ? "    drain: true\n" : ""}${o.extraConfig ?? ""}`,
    );
    clock = fakeClock(1_000_000);
    logs = [];
    daemon = await env.start({
      clock,
      log: (line) => logs.push(line),
      fleet: {
        os: o.os ?? CALM_OS,
        version: VERSION,
        localDoctor: async () => ({
          ...GREEN_DOCTOR,
          versions: { peer: VERSION, volley: VERSION, bun: "1.3.1", git: "2.43.0" },
          ...o.doctor,
        }),
        localPath: () => ({ claude: localClaude, bun: localClaude }),
      },
      spawner: {
        host: local,
        hooksDir: "/opt/local-hooks",
        claudeJsonPath: claudeJson,
        remoteHost: (s) => {
          box ??= fakeRemoteHost(s, local);
          return box;
        },
        credentials: memoryCredentials(),
      },
    });
    waits = journalWait(env.home, () => daemon);
    peer = new VolleyBroker();
    await peer.connect({ url: env.broker.url, agentId: "box" });
    client = await ControlClient.connect(env.broker.url, NS);
    // The box's record folds in and its first PATH probe runs: its verdict has its inputs.
    await heartbeat();
    await eventually(async () => {
      await tick();
      const v = (await env.retained(`${machineTopic("box")}/readiness`)) as {
        payload: { ready: boolean };
      } | null;
      return v?.payload.ready === true;
    });
  }

  afterEach(async () => {
    await client.close();
    await peer.disconnect();
    await env.cleanup();
  });

  it("an auto task's agent_spawned carries the placed host, and a later role spawned for it inherits it", async () => {
    localClaude = true;
    await setup();
    await submit("w1", "placement: auto\nplacement_prefer: [box]\n", "  T1: { issue: 42 }\n");
    await tick();
    await eventually(async () => (box?.launches.length ?? 0) === 1);
    const placed = journal("w1").find((e) => e.type === "task_placed");
    expect(placed?.data).toMatchObject({ task: "T1", host: "box", by: "auto" });
    expect(placed?.data.local).toBeUndefined();
    const lines = (placed?.data.candidates as { host: string; line: string }[]).map((c) => c.host);
    expect(lines).toEqual(["box", "control"]);
    // Placed before admitted, admitted before spawned.
    const types = journal("w1").map((e) => e.type);
    expect(types.indexOf("task_placed")).toBeLessThan(types.indexOf("task_admitted"));
    await eventually(async () => journal("w1").some((e) => e.type === "agent_spawned"));
    expect(journal("w1").find((e) => e.type === "agent_spawned")?.data).toMatchObject({
      role: "implementer",
      host: "box",
    });
    expect(local.launches).toHaveLength(0);
    const t1 = (await state("w1")).tasks.find((t) => t.id === "T1");
    expect(t1).toMatchObject({ host: "box", placement: { host: "box", by: "auto" } });
    expect(
      schemaErrors("wave-state.schema.json", await env.retained("volley/_waves/w1/state")),
    ).toEqual([]);

    // A later role spawned for the task (here by the operator's spawn op) runs where it was placed.
    const r = await client.request("spawn", { wave: "w1", task: "T1", role: "spec_reviewer" });
    expect(r).toMatchObject({ ok: true });
    await eventually(
      async () => journal("w1").filter((e) => e.type === "agent_spawned").length === 2,
    );
    expect(journal("w1").filter((e) => e.type === "agent_spawned")[1]?.data).toMatchObject({
      role: "spec_reviewer",
      host: "box",
    });
    expect(box?.launches).toHaveLength(2);
    expect(local.launches).toHaveLength(0);
  });

  /** T1 placed on the box and its implementer spawned there; the box's writeFile replaced by `write`. */
  const spawnOnBox = async (write: (path: string, content: string) => Promise<void>) => {
    localClaude = false;
    await setup();
    await submit("w7", "", "  T1: { issue: 42, host: box }\n");
    await tick();
    await eventually(async () => journal("w7").some((e) => e.type === "agent_spawned"));
    const spawned = journal("w7").find((e) => e.type === "agent_spawned");
    expect(spawned?.data).toMatchObject({ host: "box" });
    if (box !== undefined) box.writeFile = write;
    return spawned?.data.worktree as string;
  };
  const askOnT1 = () =>
    daemon.openDecision("w7", {
      kind: "agent_question",
      task: "T1",
      question: "Keep the v1 endpoint?",
      options: ["yes", "no"],
      pointers: {},
    });

  it("resolving a remote task's decision writes its decisions.md through the box, not the local disk", async () => {
    const writes: { path: string; content: string }[] = [];
    const worktree = await spawnOnBox(async (path, content) => {
      writes.push({ path, content });
    });
    const d = await askOnT1();
    const res = await client.request("resolve", {
      decision_id: d.decision_id,
      answer: "no",
      by: "tester",
    });
    expect(res.error).toBeUndefined();
    const brief = join(worktree, ".volley", "decisions.md");
    expect(res.result).toMatchObject({ already_resolved: false, brief });
    expect(writes.map((w) => w.path)).toEqual([brief]);
    expect(writes[0]?.content).toContain("Keep the v1 endpoint?");
    expect(existsSync(brief)).toBe(false);
    expect(logs.filter((l) => l.includes("but writing"))).toEqual([]);
    expect(
      journal("w7").some(
        (e) => e.type === "alarm_raised" && e.data.alarm === "decisions_file_unwritten",
      ),
    ).toBe(false);
  });

  it("a failed write on the box journals decisions_file_unwritten once, and the decision is still resolved", async () => {
    const worktree = await spawnOnBox(async () => {
      throw new Error("ssh: connect to host box port 22: Connection refused");
    });
    const d = await askOnT1();
    const res = await client.request("resolve", {
      decision_id: d.decision_id,
      answer: "no",
      by: "tester",
    });
    expect(res.error).toBeUndefined();
    expect(res.result).toMatchObject({ already_resolved: false });
    expect(res.result).not.toHaveProperty("brief");
    expect(daemon.record("w7")?.state?.open_decisions).toEqual([]);
    // A second resolve of the same decision returns already_resolved before the write: no second alarm.
    await client.request("resolve", { decision_id: d.decision_id, answer: "no", by: "tester" });
    const alarms = journal("w7").filter(
      (e) => e.type === "alarm_raised" && e.data.alarm === "decisions_file_unwritten",
    );
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toMatchObject({
      task: "T1",
      data: {
        alarm: "decisions_file_unwritten",
        decision_id: d.decision_id,
        path: join(worktree, ".volley", "decisions.md"),
        error: "ssh: connect to host box port 22: Connection refused",
      },
    });
  });

  it("no eligible machine: the task stays queued with the closest machine's reason, and is placed once one is", async () => {
    localClaude = false;
    await setup({ drain: true });
    await submit("w2", "", "  T1: { issue: 42, host: auto }\n");
    await tick();
    const t1 = (await state("w2")).tasks.find((t) => t.id === "T1");
    expect(t1?.stage).toBe("queued");
    expect(t1?.why_waiting).toBe("no eligible machine: box: draining");
    expect(t1?.host).toBeUndefined();
    expect(journal("w2").some((e) => e.type === "task_placed")).toBe(false);
    expect(box?.launches ?? []).toHaveLength(0);

    // The box stops draining: placed there on the next tick.
    const set = await client.request("config_set", {
      patch: { hosts: { box: { drain: false } } },
      by: "tester",
    });
    expect(set).toMatchObject({ ok: true });
    await tick();
    await eventually(async () => (box?.launches.length ?? 0) === 1);
    expect(journal("w2").find((e) => e.type === "task_placed")?.data).toMatchObject({
      host: "box",
      by: "auto",
    });
  });

  it("a peer over its load: the verdict says ineligible with placement's own line, and placement skips it", async () => {
    localClaude = false;
    await setup();
    await beat({ load: [32, 30, 28] });
    expect((await verdict("box"))?.payload).toMatchObject({
      ready: true,
      eligible: false,
      ineligible_reason: "overloaded: load 32.0 on 16 cores · no new agents",
    });
    await submit("w4", "", "  T1: { issue: 42, host: auto }\n");
    await tick();
    expect((await state("w4")).tasks.find((t) => t.id === "T1")?.why_waiting).toBe(
      "no eligible machine: box: overloaded: load 32.0 on 16 cores · no new agents",
    );
    // Back under the maximum: held by the same hysteresis as admission until it has been clear.
    await beat();
    expect((await verdict("box"))?.payload.ineligible_reason).toBe(
      "recovering: load per core clear for 1/3 samples",
    );
  });

  it("a placement shows in the machine's verdict at once, not a heartbeat later", async () => {
    localClaude = true;
    await setup();
    expect((await verdict("box"))?.payload.placed).toBe(0);
    await submit("w5", "placement: auto\nplacement_prefer: [box]\n", "  T1: { issue: 42 }\n");
    // Stop at the tick that admits it: no later tick has re-computed the verdict.
    await eventually(async () => {
      await tick();
      return journal("w5").some((e) => e.type === "task_admitted");
    });
    expect((await verdict("box"))?.payload.placed).toBe(1);
    expect((await verdict("control"))?.payload.placed).toBe(1);
  });

  it("pausing a wave whose task waits on a machine shows the pause, not the stale machine reason", async () => {
    localClaude = false;
    await setup({ drain: true });
    await submit("w6", "", "  T1: { issue: 42, host: auto }\n");
    await tick();
    const why = async () => (await state("w6")).tasks.find((t) => t.id === "T1")?.why_waiting;
    expect(await why()).toBe("no eligible machine: box: draining");
    expect(await client.request("pause", { wave: "w6" })).toMatchObject({ ok: true });
    await tick();
    expect(await why()).toBe("wave paused");
  });

  it("a re-delivered heartbeat is the same sample: only a newer one counts toward recovery", async () => {
    localClaude = false;
    await setup();
    await beat({ memory: { total_mb: 65536, available_pct: 9 } });
    expect((await verdict("box"))?.payload.ineligible_reason).toBe(
      "overloaded: memory available 9% (min 10%) · no new agents",
    );
    await beat();
    // The same record again (a reconnect's retained copy, a QoS 1 duplicate): not a clean sample.
    await heartbeat();
    await heartbeat();
    await tick(0);
    expect((await verdict("box"))?.payload.ineligible_reason).toBe(
      "recovering: memory available clear for 1/3 samples",
    );
    await beat();
    expect((await verdict("box"))?.payload.ineligible_reason).toBe(
      "recovering: memory available clear for 2/3 samples",
    );
    await beat();
    expect((await verdict("box"))?.payload.eligible).toBe(true);
  });

  it("a wave's own placement minimum is the one its per-host admission holds to", async () => {
    localClaude = false;
    await setup();
    await beat({ memory: { total_mb: 65536, available_pct: 8 } });
    // The supervisor's minimum (10%) holds box for the verdict...
    expect((await verdict("box"))?.payload.ineligible_reason).toBe(
      "overloaded: memory available 8% (min 10%) · no new agents",
    );
    // ...and a wave whose own minimum is 5% places there.
    await submit(
      "w7",
      "placement: auto\nconfig:\n  placement:\n    mem_available_min_pct: 5\n",
      "  T1: { issue: 42 }\n",
    );
    await tick();
    await eventually(async () => (box?.launches.length ?? 0) === 1);
    expect(journal("w7").find((e) => e.type === "task_placed")?.data).toMatchObject({
      host: "box",
    });
  });

  it("two heavy tasks admitted in one tick do not stack on one machine's heavy slot", async () => {
    localClaude = false;
    await setup({ extraConfig: "lease_pools:\n  backend-it: { capacity: 4, per_machine: 1 }\n" });
    await submit(
      "w8",
      "placement: auto\nheavy_pools: [backend-it]\n",
      "  T1: { issue: 42, heavy: true }\n  T2: { issue: 42, heavy: true }\n",
    );
    await eventually(async () => {
      await tick();
      return journal("w8").some((e) => e.type === "task_admitted");
    });
    const tasks = (await state("w8")).tasks;
    expect(tasks.find((t) => t.id === "T1")?.placement?.host).toBe("box");
    expect(tasks.find((t) => t.id === "T2")?.why_waiting).toBe(
      "no eligible machine: box: heavy slots 0/1 free (backend-it)",
    );
  });

  it("fallback (the default with a peer): the box takes the work while eligible; down past the grace, the own machine does; back, the box again", async () => {
    localClaude = true;
    await setup();
    const placedIn = (wave: string) => journal(wave).find((e) => e.type === "task_placed")?.data;
    // The box is eligible: the idle own machine is not a candidate.
    await submit("w1", "placement: auto\n", "  T1: { issue: 42 }\n");
    await tick();
    expect(placedIn("w1")).toMatchObject({ host: "box", by: "auto" });
    const ownLine = (placedIn("w1")?.candidates as { host: string; line: string }[]).find(
      (c) => c.host === "control",
    )?.line;
    expect(ownLine).toBe("ineligible: fallback: box is eligible");
    expect((await verdict("control"))?.payload.local_agents).toEqual({
      mode: "fallback",
      active: false,
      why: "box eligible",
    });
    // `volleyd status` says so in its header.
    expect((await runCli(["status"], env.env)).stdout).toContain(
      "local agents: fallback (idle: box eligible)\n",
    );

    // The box goes silent: down after machine_down_after_ms, but within the grace it may be back.
    await tick(DAEMON_DEFAULTS.machine_down_after_ms);
    await submit("w2", "placement: auto\n", "  T1: { issue: 42 }\n");
    await tick();
    expect(journal("w2").some((e) => e.type === "task_placed")).toBe(false);
    expect((await state("w2")).tasks.find((t) => t.id === "T1")?.why_waiting).toMatch(
      /^no eligible machine: control: fallback: box may be back \(down \d+ s, grace 300 s\)$/,
    );

    // Past placement.down_decision_after_s: the own machine is the fallback.
    await tick(CONFIG_DEFAULTS.placement.down_decision_after_s * 1000);
    await eventually(async () => {
      await tick();
      return placedIn("w2") !== undefined;
    });
    expect(placedIn("w2")).toMatchObject({ host: "control", local: true, by: "auto" });
    const chosen = (placedIn("w2")?.candidates as { host: string; line: string }[])[0];
    expect(chosen?.host).toBe("control");
    expect(chosen?.line).toMatch(/^local \(fallback: no peer eligible: box: tunnel down to box/);
    await eventually(async () => {
      await tick(0);
      return (await verdict("control"))?.payload.local_agents?.active === true;
    });

    // The box is back: the next task goes to it; the own machine's task stays where it is.
    await beat();
    await submit("w3", "placement: auto\n", "  T1: { issue: 42 }\n");
    await eventually(async () => {
      await tick();
      return placedIn("w3") !== undefined;
    });
    expect(placedIn("w3")).toMatchObject({ host: "box", by: "auto" });
    expect(journal("w2").filter((e) => e.type === "task_placed")).toHaveLength(1);
    expect((await state("w2")).tasks.find((t) => t.id === "T1")?.placement?.host).toBe("control");
  });

  it("macOS: the own machine's memory is the doctor's vm_stat figure, so a Mac in normal use is eligible", async () => {
    localClaude = true;
    const available = vmStatAvailablePct(VM_STAT_MAC_16GB, MAC_16GB_BYTES);
    expect(available).toBe(45);
    await setup({
      // A candidate like the box: the eligibility under test is the memory figure's.
      localAgents: "always",
      // Free pages alone: 3% (what os.freemem() reports on a Mac in normal use).
      os: {
        ...CALM_OS,
        platform: () => "darwin",
        freemem: () => 31457 * 16384,
        totalmem: () => MAC_16GB_BYTES,
      },
      doctor: { memory: memoryOf(MAC_16GB_BYTES, 31457 * 16384, available) },
    });
    const own = (await env.retained(machineTopic("control"))) as { payload: MachineRecord };
    expect(own.payload).toMatchObject({
      os: "darwin",
      memory: { total_mb: 16384, available_pct: 45 },
    });
    await eventually(async () => {
      await tick();
      return (await verdict("control"))?.payload.ready === true;
    });
    expect((await verdict("control"))?.payload.eligible).toBe(true);
  });

  it("macOS without a doctor figure: the own memory is unknown, never the free pages", async () => {
    localClaude = true;
    await setup({
      os: {
        ...CALM_OS,
        platform: () => "darwin",
        freemem: () => 31457 * 16384,
        totalmem: () => MAC_16GB_BYTES,
      },
    });
    const own = (await env.retained(machineTopic("control"))) as { payload: MachineRecord };
    expect(own.payload.memory).toBeUndefined();
  });

  it("a wave that does not opt in journals no placement and runs locally as before", async () => {
    localClaude = true;
    await setup();
    await submit("w3", "", "  T1: { issue: 42 }\n");
    await tick();
    await eventually(async () => local.launches.length === 1);
    expect(journal("w3").some((e) => e.type === "task_placed")).toBe(false);
    expect(box?.launches ?? []).toHaveLength(0);
  });
});
