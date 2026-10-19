import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import type { Daemon, DaemonOptions } from "../../src/daemon";
import { readJournalFile } from "../../src/journal";
import { SYSTEM_WAVE } from "../../src/types";
import type { JournalEvent } from "../../src/types";
import { type DaemonEnv, NS, makeDaemonEnv } from "./daemon-env";
import { type MemoryCredentials, memoryCredentials } from "./fake-dynsec";
import { type FakeExec, fakeExec } from "./fake-exec";
import { FIXTURES, type FakeHost, fakeHost } from "./fake-host";
import { runCli } from "./run-cli";

export const AGENT = "w1-t1-implementer-1";

/**
 * A daemon with the spawner on fakes and wave w1 (one task, T1) submitted, its implementer
 * spawned and verified through simulated hook signals — the starting point of every recovery test.
 */
export interface SupervisedEnv {
  env: DaemonEnv;
  daemon: Daemon;
  host: FakeHost;
  /** The agent logins the daemon minted and revoked. */
  creds: MemoryCredentials;
  repo: string;
  /** The simulated agent's own broker connection. */
  agent: VolleyBroker;
  /** Publish an envelope as the agent. */
  pub: (
    topic: string,
    type: string,
    channel: string,
    payload: unknown,
    retain?: boolean,
  ) => Promise<void>;
  /** Publish a test/fixtures/hooks progress fixture as the agent (payload overrides merged). */
  hook: (name: string, payload?: Record<string, unknown>) => Promise<void>;
  status: (type: string, payload?: Record<string, unknown>) => Promise<void>;
  journal: (wave?: string) => JournalEvent[];
  until: (pred: () => boolean, ms?: number) => Promise<void>;
  /** Start a second daemon on the same home (after `daemon.stop()`). */
  restart: (extra?: Partial<DaemonOptions>) => Promise<Daemon>;
  daemonOptions: Partial<DaemonOptions>;
  cleanup: () => Promise<void>;
}

export interface SupervisedEnvOptions {
  /** Extra `config:` entries for the wave file (YAML flow-map body, e.g. `wake_grace_s: 1`). */
  config?: string;
  daemon?: Partial<DaemonOptions>;
  reapGraceMs?: number;
  /** The wave's own `namespace:` (default: none, so its agents live in the daemon's, NS). */
  namespace?: string;
  /** Extra fake-exec replies (prefix, reply). */
  exec?: [string[], Parameters<FakeExec["on"]>[1]][];
  /** The agent-login store the daemon uses (default: a fresh in-memory one). */
  creds?: MemoryCredentials;
  /** Runs when the implementer is launched (credentials minted, not yet supervised). */
  onLaunch?: (daemon: Daemon) => void;
  /**
   * More tasks for the wave (YAML under `tasks:`, e.g. `T2: { issue: 42 }`). Their agents are
   * launched but never register: they stay in verification (running in the wave, not supervised).
   */
  tasks?: string[];
}

export async function makeSupervisedEnv(o: SupervisedEnvOptions = {}): Promise<SupervisedEnv> {
  const env = await makeDaemonEnv();
  const repo = join(realpathSync(env.home), "repo");
  mkdirSync(repo);
  const claudeJson = join(env.home, "claude.json");
  writeFileSync(
    claudeJson,
    JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }),
  );
  const agent = new VolleyBroker();
  await agent.connect({ url: env.broker.url, agentId: "agent-sim" });
  const fake = fakeExec()
    .on(["git", "-C", repo, "rev-parse", "--show-toplevel"], { stdout: `${repo}\n` })
    // the wave's release branch exists locally (spawn's base, run's RELEASE_BRANCH_MISSING check)
    .on(["git", "-C", repo, "rev-parse", "--verify", "--quiet", "refs/heads/release/w1"], {
      stdout: `${"1".repeat(40)}\n`,
    })
    .on(["gh", "issue", "view"], {
      stdout: readFileSync(join(FIXTURES, "gh-issue-42.json"), "utf-8"),
    });
  for (const [prefix, reply] of o.exec ?? []) fake.on(prefix, reply);
  const host = fakeHost(fake);
  const creds = o.creds ?? memoryCredentials();
  const ns = o.namespace ?? NS;

  const pub = (topic: string, type: string, channel: string, payload: unknown, retain = true) =>
    agent.publish(
      topic,
      JSON.stringify({
        ...buildEnvelope({ agentId: AGENT, parentId: "volleyd", channel, type, payload }),
        ...(channel === "_system/registry" ? { namespace: ns } : {}),
      }),
      { qos: 1, retain },
    );
  const hook = async (name: string, payload: Record<string, unknown> = {}) => {
    const e = JSON.parse(readFileSync(join(FIXTURES, "hooks", name), "utf-8"));
    e.agent_id = AGENT;
    e.wall_time = new Date().toISOString();
    e.payload = { ...e.payload, ...payload };
    const topic =
      e.channel === "_system/registry" ? registryTopic(AGENT) : buildTopic(ns, AGENT, e.channel);
    await agent.publish(topic, JSON.stringify(e), {
      qos: 1,
      retain: e.channel === "_system/registry",
    });
  };
  const status = (type: string, payload: Record<string, unknown> = {}) =>
    pub(buildTopic(ns, AGENT, "status"), type, "status", payload);

  // The launched session: MCP registers, the SessionStart hook re-publishes + heartbeats.
  host.onLaunch = (spec) => {
    if (!spec.cwd.endsWith("/T1-implementer")) return; // an extra task's agent: silent
    o.onLaunch?.(daemon);
    setTimeout(async () => {
      await status("spawning"); // the MCP server's lifecycle, before its registration
      await pub(registryTopic(AGENT), "registered", "_system/registry", {
        capabilities: [],
        cwd: "/wt",
        started_at: new Date().toISOString(),
        model: "claude-opus-5-5",
        model_source: "harness-hook",
      });
      await status("working", { source: "harness-hook" });
      await pub(
        buildTopic(ns, AGENT, "progress"),
        "heartbeat",
        "progress",
        { source: "harness-hook", seq: 1, hook_event: "SessionStart" },
        false,
      );
    }, 20);
  };
  const daemonOptions: Partial<DaemonOptions> = {
    spawner: {
      host,
      claudeJsonPath: claudeJson,
      hooksDir: "/opt/volley-hooks",
      reapGraceMs: o.reapGraceMs ?? 300,
      credentials: creds,
    },
    ...o.daemon,
  };
  const daemon = await env.start(daemonOptions);
  const waveFile = join(env.home, "w1.yaml");
  writeFileSync(
    waveFile,
    `wave: w1\n${o.namespace !== undefined ? `namespace: ${o.namespace}\n` : ""}repo: ${repo}\nrelease_branch: release/w1\nmodel: claude-opus-5-5\npipeline: [implement]\ntasks:\n  T1: { issue: 42 }\n${(o.tasks ?? []).map((t) => `  ${t}\n`).join("")}config: { worktree_root: ${join(env.home, "wt")}${o.config !== undefined ? `, ${o.config}` : ""} }\n`,
  );
  const r = await runCli(["run", waveFile], env.env);
  if (r.exitCode !== 0) throw new Error(`run failed: ${r.stderr}${r.stdout}`);

  const journal = (wave = "w1"): JournalEvent[] =>
    readJournalFile(join(env.home, "waves", wave, "journal.jsonl"));
  const until = async (pred: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error("timed out waiting");
      await new Promise((res) => setTimeout(res, 25));
    }
  };
  await until(() => journal().some((e) => e.type === "agent_registered"));
  await until(
    () => journal().filter((e) => e.type === "agent_spawned").length >= 1 + (o.tasks ?? []).length,
  );
  // Supervision starts once the daemon has consumed the verification outcome.
  await new Promise((res) => setTimeout(res, 100));
  return {
    env,
    daemon,
    host,
    creds,
    repo,
    agent,
    pub,
    hook,
    status,
    journal,
    until,
    restart: (extra = {}) => env.start({ ...daemonOptions, ...extra }),
    daemonOptions,
    cleanup: async () => {
      await agent.disconnect();
      await env.cleanup();
    },
  };
}

export const PR_HEAD = "abc123";

/**
 * Fake-exec replies under which the implementer's `done` verifies (T6): its worktree HEAD is on
 * origin, one open PR for its branch targets release/w1, CI is green on that head, and the
 * release branch has not moved.
 */
export const ARTIFACTS_OK: NonNullable<SupervisedEnvOptions["exec"]> = [
  [
    ["git"],
    (argv) => ({
      stdout: argv.includes("--show-toplevel") ? `${argv[2]}\n` : `${PR_HEAD}\n`,
    }),
  ],
  [
    ["gh", "pr", "list"],
    {
      stdout: JSON.stringify([
        {
          number: 7,
          url: "https://example.test/pr/7",
          headRefName: "w1/T1-implementer-1",
          baseRefName: "release/w1",
          headRefOid: PR_HEAD,
        },
      ]),
    },
  ],
  [
    ["gh", "run", "list"],
    {
      stdout: JSON.stringify([
        {
          databaseId: 1,
          name: "CI",
          status: "completed",
          conclusion: "success",
          headSha: PR_HEAD,
          url: "https://example.test/runs/1",
        },
      ]),
    },
  ],
  [["gh", "pr", "view"], { stdout: JSON.stringify({ state: "OPEN", headRefOid: PR_HEAD }) }],
];

/** The `_system` journal of an env. */
export const systemJournal = (env: DaemonEnv): JournalEvent[] =>
  readJournalFile(join(env.home, "waves", SYSTEM_WAVE, "journal.jsonl"));
