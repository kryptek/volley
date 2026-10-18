import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import { cleanupWave } from "../src/commands/cleanup";
import type { Daemon } from "../src/daemon";
import type { ExecFn } from "../src/exec";
import type { RemoteHost, RemoteHostSpec } from "../src/hosts/ssh-tmux";
import { type TunnelExit, TunnelSupervisor, tunnelArgv } from "../src/hosts/tunnel";
import { makeBufferIO } from "../src/io";
import { readJournalFile } from "../src/journal";
import { SpawnError } from "../src/spawn-error";
import { trustDecisionId } from "../src/trust";
import type { JournalEvent } from "../src/types";
import { type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { fakeExec } from "./helpers/fake-exec";
import { FIXTURES, type FakeHost, fakeHost } from "./helpers/fake-host";
import { runCli } from "./helpers/run-cli";

const until = async (pred: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
};

interface FakeRemote extends Omit<FakeHost, "readFile">, RemoteHost {
  tunnel: boolean;
  tunnelChecks: number;
  /** The box's own folder trust for its repo (its ~/.claude.json). */
  trusted: boolean;
  trustReads: number;
  /** Roots the owner's `trust` answer recorded on the box. */
  trustRecorded: string[];
  /** Files only the box has (readFile); a path not here does not exist there. */
  files: Record<string, string>;
  /** Something else listens on the box's remote_port (its own broker, a stale forward). */
  squatter: boolean;
}

/**
 * A remote host on fakes: files land in a temp dir. The tunnel check (`nc -z` on the box) answers
 * when a squatter holds the port, or when `tunnel` is set and the daemon started the forward.
 */
function fakeRemote(spec: RemoteHostSpec, local: FakeHost, forwarded: () => boolean): FakeRemote {
  const h = fakeHost(local.fake) as unknown as FakeRemote;
  Object.assign(h, {
    name: spec.name,
    spec,
    screenSource: "tmux",
    hooksDir: `${spec.volley_dir}/packages/volley-hooks`,
    brokerUrl: `mqtt://127.0.0.1:${spec.tunnel.remote_port}`,
    tunnel: false,
    tunnelChecks: 0,
    launchEnv: (id: { agent_id: string; namespace: string }) => ({
      VOLLEY_BROKER_URL: `mqtt://127.0.0.1:${spec.tunnel.remote_port}`,
      VOLLEY_NAMESPACE: id.namespace,
      VOLLEY_AGENT_ID: id.agent_id,
    }),
    trusted: true,
    trustReads: 0,
    trustRecorded: [],
    files: {},
    squatter: false,
    repoExists: async () => true,
    tunnelUp: async () => {
      h.tunnelChecks++;
      return h.squatter || (h.tunnel && forwarded());
    },
    readTrust: async () => {
      h.trustReads++;
      return { projects: h.trusted ? { [spec.repo]: { hasTrustDialogAccepted: true } } : {} };
    },
    recordTrust: async (root: string) => {
      h.trustRecorded.push(root);
      if (root === spec.repo) h.trusted = true;
    },
    readFile: async (path: string) => (Object.hasOwn(h.files, path) ? h.files[path] : null) ?? null,
  });
  return h;
}

describe("remote host tunnel: park, resume, never touch running agents", () => {
  let env: DaemonEnv;
  let agent: VolleyBroker;
  let local: FakeHost;
  let box: FakeRemote;
  /** One fake box per remote port (the same machine, forwarded twice). */
  let boxes: Map<number, FakeRemote>;
  let daemon: Daemon;
  /** The daemon machine's own ~/.claude.json: it trusts nothing, and must stay untouched. */
  let localClaudeJson: string;
  /** How the supervised tunnel's ssh behaves: stays up, or exits at once (forward failed). */
  let tunnelMode: "up" | "fail";
  let clock: number;
  let repo: string;
  let tunnelCalls: string[][];

  const journal = (wave: string): JournalEvent[] =>
    readJournalFile(join(env.home, "waves", wave, "journal.jsonl"));
  const task = async (wave: string, id: string) => {
    const s = (await env.retained(`volley/_waves/${wave}/state`)) as {
      payload: { tasks: { id: string; stage: string; why_waiting?: string; host?: string }[] };
    };
    return s.payload.tasks.find((t) => t.id === id);
  };
  const submit = async (wave: string, tasks: string) => {
    const file = join(env.home, `${wave}.yaml`);
    writeFileSync(
      file,
      `wave: ${wave}\nrepo: ${repo}\nrelease_branch: release/${wave}\nmodel: claude-opus-5-5\npipeline: [implement]\ntasks:\n${tasks}`,
    );
    const r = await runCli(["run", file], env.env);
    expect(r.exitCode).toBe(0);
  };
  /** Advance past the check interval and run a tick; wait for the check to land. */
  const recheck = async (b: FakeRemote = box) => {
    const before = b.tunnelChecks;
    clock += 60_000;
    await daemon.tick();
    await until(() => b.tunnelChecks > before);
    await daemon.tick();
  };
  /** Tick until `pred` holds, the clock moving on (past a fresh tunnel's settle time) each time. */
  const tickUntil = (pred: () => boolean | Promise<boolean>, ms = 5000) =>
    until(async () => {
      clock += 20_000;
      await daemon.tick();
      return pred();
    }, ms);
  const publishStatus = (id: string, type: string, payload: unknown = {}) =>
    agent.publish(
      buildTopic(NS, id, "status"),
      JSON.stringify(
        buildEnvelope({ agentId: id, parentId: "volleyd", channel: "status", type, payload }),
      ),
      { qos: 1, retain: true },
    );
  const signal = async (id: string) => {
    const pub = (topic: string, type: string, channel: string, payload: unknown, retain = true) =>
      agent.publish(
        topic,
        JSON.stringify({
          ...buildEnvelope({ agentId: id, parentId: "volleyd", channel, type, payload }),
          ...(channel === "_system/registry" ? { namespace: NS } : {}),
        }),
        { qos: 1, retain },
      );
    await pub(registryTopic(id), "registered", "_system/registry", {
      capabilities: [],
      cwd: "/wt",
      started_at: new Date().toISOString(),
      model: "claude-opus-5-5",
      model_source: "harness-hook",
    });
    await pub(buildTopic(NS, id, "status"), "working", "status", { source: "harness-hook" });
    await pub(
      buildTopic(NS, id, "progress"),
      "heartbeat",
      "progress",
      { source: "harness-hook", seq: 1, hook_event: "SessionStart" },
      false,
    );
  };

  beforeEach(async () => {
    env = await makeDaemonEnv();
    const dir = realpathSync(env.home);
    repo = join(dir, "repo");
    mkdirSync(repo);
    agent = new VolleyBroker();
    await agent.connect({ url: env.broker.url, agentId: "agent-sim" });
    const fake = fakeExec()
      .on(["git", "-C", repo, "rev-parse", "--show-toplevel"], { stdout: `${repo}\n` })
      .on(["gh", "issue", "view"], {
        stdout: readFileSync(join(FIXTURES, "gh-issue-42.json"), "utf-8"),
      })
      .on(["volley", "auth", "add-agent"], (argv) => ({
        stdout: JSON.stringify({ username: argv[3], password: "pw" }),
      }));
    local = fakeHost(fake);
    const spec: RemoteHostSpec = {
      name: "box",
      target: "dev@box",
      repo,
      worktree_root: join(dir, "remote-wt"),
      volley_dir: "/opt/volley",
      tunnel: { remote_port: 21883, supervise: true },
    };
    boxes = new Map();
    const boxFor = (s: RemoteHostSpec): FakeRemote => {
      let b = boxes.get(s.tunnel.remote_port);
      if (b === undefined) {
        const port = `${s.tunnel.remote_port}:`;
        b = fakeRemote(s, local, () => tunnelCalls.some((c) => c[3]?.startsWith(port)));
        b.onLaunch = (l) => {
          const [wave, task] = l.name.split(" ");
          setTimeout(() => void signal(`${wave}-${task?.toLowerCase()}-implementer-1`), 20);
        };
        boxes.set(s.tunnel.remote_port, b);
      }
      return b;
    };
    box = boxFor(spec);
    // The supervised tunnel: a long-lived child that runs until aborted (or, in `fail` mode,
    // one that exits at once the way ssh does when the box's port is taken).
    tunnelCalls = [];
    tunnelMode = "up";
    const tunnelExec: ExecFn = (argv, opts = {}) => {
      tunnelCalls.push([...argv]);
      if (tunnelMode === "fail") {
        return Promise.resolve({
          code: 255,
          stdout: "",
          stderr: "Error: remote port forwarding failed for listen port 21883\n",
          timedOut: false,
        });
      }
      return new Promise((resolve) => {
        opts.signal?.addEventListener("abort", () =>
          resolve({ code: 143, stdout: "", stderr: "", timedOut: false }),
        );
      });
    };
    localClaudeJson = join(dir, "local-claude.json");
    writeFileSync(localClaudeJson, `${JSON.stringify({ projects: {} })}\n`);
    clock = 1_000_000;
    writeFileSync(
      join(env.home, "config.yaml"),
      `hosts:\n  box:\n    target: dev@box\n    repo: ${repo}\n    volley_dir: /opt/volley\n    worktree_root: ${spec.worktree_root}\n    tunnel: { remote_port: 21883 }\n`,
    );
    daemon = await env.start({
      now: () => clock,
      spawner: {
        host: local,
        hooksDir: "/opt/local-hooks",
        claudeJsonPath: localClaudeJson,
        reapGraceMs: 150,
        remoteHost: (s) => boxFor(s),
        remoteExec: tunnelExec,
      },
    });
  });

  afterEach(async () => {
    await agent.disconnect();
    await env.cleanup();
  });

  it("tunnel check failing parks the host's spawns with why_waiting; recovering resumes them", async () => {
    box.tunnel = false;
    await submit("w1", "  T1: { issue: 42, host: box }\n");
    // The tunnel was only just started: not known either way until its ssh has stayed up.
    await daemon.tick();
    await until(async () => (await task("w1", "T1"))?.why_waiting === "checking tunnel to dev@box");
    expect(box.tunnelChecks).toBe(1); // only the port check before the forward was started
    expect(journal("w1").some((e) => e.data.code === "TUNNEL_DOWN")).toBe(false);
    // Past the settle time the check runs, and fails.
    await recheck();
    await until(async () => (await task("w1", "T1"))?.why_waiting === "tunnel down to dev@box");
    expect(await task("w1", "T1")).toMatchObject({ stage: "queued", host: "box" });
    expect(box.launches).toHaveLength(0);
    expect(local.launches).toHaveLength(0);
    expect(
      journal("w1").find((e) => e.type === "alarm_raised" && e.data.code === "TUNNEL_DOWN")?.data,
    ).toMatchObject({ host: "box", target: "dev@box", remote_port: 21883 });
    // volleyd keeps the reverse tunnel up itself: one per target.
    expect(tunnelCalls).toEqual([tunnelArgv("dev@box", 21883, env.broker.url)]);

    box.tunnel = true;
    await recheck();
    await tickUntil(() => journal("w1").some((e) => e.type === "agent_registered"));
    expect(box.launches).toHaveLength(1);
    expect(local.launches).toHaveLength(0);
    const t1 = await task("w1", "T1");
    expect(t1?.why_waiting).toBeUndefined();
    expect(t1).toMatchObject({ stage: "implement", host: "box" });

    // The agent reaches the broker through the tunnel; identity still comes from the file.
    const wt = join(box.spec.worktree_root, "w1", "T1-implementer");
    const identity = JSON.parse(readFileSync(join(wt, ".volley", "agent.json"), "utf-8"));
    expect(identity).toMatchObject({
      agent_id: "w1-t1-implementer-1",
      broker_url: "mqtt://127.0.0.1:21883",
      broker: { username: "w1-t1-implementer-1", password: "pw" },
    });
    const launch = readFileSync(join(wt, ".volley", "launch.sh"), "utf-8");
    expect(launch).toContain("export VOLLEY_HOOKS_DIR='/opt/volley/packages/volley-hooks'");
    expect(launch).toContain("export VOLLEY_AGENT_ID='w1-t1-implementer-1'");
    expect(launch).not.toContain("--mcp-config");
    // The lock is keyed by the target as well as the worktree path.
    const spawned = journal("w1").find((e) => e.type === "agent_spawned")?.data;
    expect(spawned).toMatchObject({ host: "box", remote: { target: "dev@box", repo } });
    expect(spawned?.lock as string).toContain(join(env.home, "hosts", "dev@box", "locks"));
    expect(existsSync(spawned?.lock as string)).toBe(true);
  });

  it("a running agent is never touched when the tunnel goes down", async () => {
    box.tunnel = true;
    await submit("w1", "  T1: { issue: 42, host: box }\n");
    await tickUntil(() => journal("w1").some((e) => e.type === "agent_registered"));
    const keysBefore = box.keys.length;

    box.tunnel = false;
    await recheck();
    await submit("w2", "  T1: { issue: 42, host: box }\n");
    await until(async () => (await task("w2", "T1"))?.why_waiting === "tunnel down to dev@box");
    // w1's agent: still supervised, not retired, no keys, no close, its stage unchanged.
    expect(journal("w1").some((e) => e.type === "agent_retired")).toBe(false);
    expect(box.keys.length).toBe(keysBefore);
    expect(box.texts).toEqual([]);
    expect(await task("w1", "T1")).toMatchObject({ stage: "implement", host: "box" });
    expect((await task("w1", "T1"))?.why_waiting).toBeUndefined();
    expect(box.launches).toHaveLength(1);
    // A terminal status still retires it normally (`failed`: a `done` is first verified, T6).
    await agent.publish(
      buildTopic(NS, "w1-t1-implementer-1", "status"),
      JSON.stringify(
        buildEnvelope({
          agentId: "w1-t1-implementer-1",
          parentId: "volleyd",
          channel: "status",
          type: "failed",
          payload: { reason: "x" },
        }),
      ),
      { qos: 1, retain: true },
    );
    await tickUntil(() => journal("w1").some((e) => e.type === "agent_retired"));

    // cleanup --yes reaches the box again: kill the tmux session, remove the remote worktree.
    const fx = fakeExec();
    const io = makeBufferIO();
    expect(await cleanupWave(env.home, "w1", { yes: true, force: false, exec: fx.exec }, io)).toBe(
      0,
    );
    const wt = join(box.spec.worktree_root, "w1", "T1-implementer");
    expect(fx.calls.map((c) => [c.argv.at(-3), c.opts.remote?.steps.map((x) => x.argv)])).toEqual([
      ["dev@box", [["tmux", "kill-session", "-t", "=workspace:1"]]],
      ["dev@box", [["git", "-C", wt, "rev-parse", "--is-inside-work-tree"]]],
      ["dev@box", [["git", "-C", repo, "worktree", "remove", wt]]],
    ]);
    expect(io.readStdout()).toContain(`removed ${wt} on dev@box`);

    // A second run is a no-op: the box says the path is no work tree any more.
    const gone = fakeExec().on(["ssh"], (_argv, opts) =>
      opts.remote?.steps.some((x) => x.argv.includes("--is-inside-work-tree"))
        ? { code: 128, stderr: "fatal: not a git repository" }
        : {},
    );
    const io2 = makeBufferIO();
    expect(
      await cleanupWave(env.home, "w1", { yes: true, force: false, exec: gone.exec }, io2),
    ).toBe(0);
    expect(io2.readStdout()).toContain(`gone ${wt} on dev@box`);
    expect(
      gone.calls.some((c) => c.opts.remote?.steps.some((x) => x.argv.includes("remove"))),
    ).toBe(false);
    // ssh failing is not "gone": the remove is attempted (and reported) instead.
    const down = fakeExec().on(["ssh"], { code: 255, stderr: "ssh: connect: refused" });
    const io3 = makeBufferIO();
    expect(
      await cleanupWave(env.home, "w1", { yes: true, force: false, exec: down.exec }, io3),
    ).toBe(1);
    expect(io3.readStderr()).toContain(`could not remove ${wt} on dev@box`);
  });

  it("a remote repo's trust is the box's: one decision, `trust` is recorded on the box, never locally", async () => {
    box.tunnel = true;
    box.trusted = false;
    const localBefore = readFileSync(localClaudeJson, "utf-8");
    await submit("w1", "  T1: { issue: 42, host: box }\n");
    await tickUntil(() => journal("w1").some((e) => e.type === "decision_opened"));
    const opens = () =>
      journal("w1").filter((e) => e.type === "decision_opened" && e.data.kind === "repo_untrusted");
    const opened = opens()[0]?.data;
    expect(opened).toMatchObject({
      kind: "repo_untrusted",
      repo,
      host: "box",
      target: "dev@box",
      decision_id: trustDecisionId(repo, "dev@box"),
    });
    // The local and the remote clone at one path never share a decision.
    expect(trustDecisionId(repo, "dev@box")).not.toBe(trustDecisionId(repo));
    // The local file (which trusts nothing) neither resolves nor re-opens it.
    for (let i = 0; i < 3; i++) {
      clock += 60_000;
      await daemon.tick();
    }
    expect(opens()).toHaveLength(1);
    expect(journal("w1").some((e) => e.type === "decision_resolved")).toBe(false);
    expect(box.launches).toHaveLength(0);

    const r = await runCli(
      ["resolve", opened?.decision_id as string, "trust", "--by", "tester"],
      env.env,
    );
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(box.trustRecorded).toEqual([repo]);
    expect(readFileSync(localClaudeJson, "utf-8")).toBe(localBefore);
    await tickUntil(() => journal("w1").some((e) => e.type === "agent_registered"));
    expect(box.launches).toHaveLength(1);
    expect(opens()).toHaveLength(1);
    expect(readFileSync(localClaudeJson, "utf-8")).toBe(localBefore);
  });

  it("a remote repo_untrusted decision resolves itself once the dialog is accepted on the box", async () => {
    box.tunnel = true;
    box.trusted = false;
    await submit("w1", "  T1: { issue: 42, host: box }\n");
    await tickUntil(() => journal("w1").some((e) => e.type === "decision_opened"));
    box.trusted = true; // the owner ran claude on the box and accepted the dialog
    await tickUntil(() => {
      clock += 60_000;
      return journal("w1").some((e) => e.type === "agent_registered");
    });
    expect(journal("w1").find((e) => e.type === "decision_resolved")?.data).toMatchObject({
      answer: "trusted",
      by: "claude-trust-dialog",
    });
    expect(box.trustRecorded).toEqual([]);
    expect(box.launches).toHaveLength(1);
  });

  it("two ports on one box are two tunnels with their own checks", async () => {
    await submit(
      "w1",
      "  T1: { issue: 42, host: box }\n  T2: { issue: 42, host: { type: ssh, name: box, tunnel: { remote_port: 2883 } } }\n",
    );
    await until(() => boxes.size === 2);
    const box2 = boxes.get(2883) as FakeRemote;
    box.tunnel = true;
    box2.tunnel = false;
    await recheck(box2);
    await tickUntil(() => journal("w1").some((e) => e.type === "agent_registered"));
    await until(async () => (await task("w1", "T2"))?.why_waiting === "tunnel down to dev@box");
    expect(tunnelCalls).toEqual([
      tunnelArgv("dev@box", 21883, env.broker.url),
      tunnelArgv("dev@box", 2883, env.broker.url),
    ]);
    expect(box.launches.map((l) => l.name)).toEqual(["w1 T1 implementer"]);
    expect(box2.launches).toHaveLength(0);
    expect((await task("w1", "T1"))?.why_waiting).toBeUndefined();
    expect(
      journal("w1").find((e) => e.type === "alarm_raised" && e.data.code === "TUNNEL_DOWN")?.data,
    ).toMatchObject({ remote_port: 2883, tasks: ["T2"] });

    box2.tunnel = true;
    await recheck(box2);
    await tickUntil(() => journal("w1").filter((e) => e.type === "agent_registered").length === 2);
    expect(box2.launches).toHaveLength(1);
    expect(box.launches).toHaveLength(1);
  });

  it("a remote agent whose tunnel is down is not reaped until the tunnel is back", async () => {
    box.tunnel = true;
    await submit("w1", "  T1: { issue: 42, host: box }\n");
    await tickUntil(() => journal("w1").some((e) => e.type === "agent_registered"));
    const id = "w1-t1-implementer-1";
    // The tunnel drops: the agent's connection dies and the broker fires its LWT.
    box.tunnel = false;
    await recheck();
    await publishStatus(id, "reaped", { reason: "lwt" });
    await tickUntil(() => journal("w1").some((e) => e.data.code === "REAP_DEFERRED"));
    await new Promise((r) => setTimeout(r, 600)); // several reap graces
    expect(journal("w1").some((e) => e.type === "agent_retired")).toBe(false);
    expect(journal("w1").filter((e) => e.data.code === "REAP_DEFERRED")).toHaveLength(1);
    expect(journal("w1").find((e) => e.data.code === "REAP_DEFERRED")?.data).toMatchObject({
      agent_id: id,
      forward: "dev@box:21883",
    });

    // The tunnel is back but the agent never returns: now the reap goes ahead.
    box.tunnel = true;
    await recheck();
    await tickUntil(() => journal("w1").some((e) => e.type === "agent_retired"));
    expect(journal("w1").find((e) => e.type === "agent_retired")?.data).toMatchObject({
      agent_id: id,
      status: "reaped",
    });
  });

  it("a forward that keeps failing is down even when something answers on the box's port", async () => {
    tunnelMode = "fail";
    box.tunnel = true; // e.g. the box's own mosquitto holds the port
    await submit("w1", "  T1: { issue: 42, host: box }\n");
    await tickUntil(() => journal("w1").some((e) => e.data.code === "TUNNEL_FORWARD_FAILED"), 8000);
    const alarm = journal("w1").find((e) => e.data.code === "TUNNEL_FORWARD_FAILED")?.data;
    expect(alarm).toMatchObject({
      target: "dev@box",
      remote_port: 21883,
      exit: 255,
      tasks: ["T1"],
    });
    expect(alarm?.stderr).toContain("remote port forwarding failed");
    expect(journal("w1").find((e) => e.data.code === "TUNNEL_EXITED")?.data).toMatchObject({
      restarts: 1,
    });
    await tickUntil(async () => (await task("w1", "T1"))?.why_waiting === "tunnel down to dev@box");
    expect(box.launches).toHaveLength(0);
  }, 15_000);

  it("a box port something else already listens on is down: no tunnel, no spawn, until it is free", async () => {
    box.tunnel = true;
    box.squatter = true; // e.g. a broker on the box bound to 127.0.0.1 only: ssh's forward still binds ::1
    await submit("w1", "  T1: { issue: 42, host: box }\n");
    await tickUntil(async () => (await task("w1", "T1"))?.why_waiting === "tunnel down to dev@box");
    expect(tunnelCalls).toEqual([]);
    expect(box.launches).toHaveLength(0);
    expect(
      journal("w1").find((e) => e.type === "alarm_raised" && e.data.code === "TUNNEL_DOWN")?.data,
    ).toMatchObject({ reason: "port 21883 on dev@box is already in use", remote_port: 21883 });

    box.squatter = false;
    await tickUntil(() => journal("w1").some((e) => e.type === "agent_registered"));
    expect(tunnelCalls).toEqual([tunnelArgv("dev@box", 21883, env.broker.url)]);
    expect(box.launches).toHaveLength(1);
  });

  it("brief notes come from the box's clone, not a local path that happens to match", async () => {
    box.tunnel = true;
    mkdirSync(join(repo, ".volley"), { recursive: true });
    writeFileSync(join(repo, ".volley", "brief-extra.md"), "LOCAL NOTES\n");
    box.files[join(repo, ".volley", "brief-extra.md")] = "Notes from the box clone.\n";
    await submit("w1", "  T1: { issue: 42, host: box }\n");
    await tickUntil(() => journal("w1").some((e) => e.type === "agent_registered"));
    const wt = join(box.spec.worktree_root, "w1", "T1-implementer");
    const brief = readFileSync(join(wt, ".volley", "brief.md"), "utf-8");
    expect(brief).toContain("Notes from the box clone.");
    expect(brief).not.toContain("LOCAL NOTES");
  });

  it("an ssh failure checking the clone is a backed-off refusal, not a remote_repo_missing decision", async () => {
    box.tunnel = true;
    box.repoExists = async () => {
      throw new SpawnError("LAUNCH_FAILED", "ssh to dev@box failed (repo check): timed out");
    };
    await submit("w1", "  T1: { issue: 42, host: box }\n");
    await tickUntil(() => journal("w1").some((e) => e.data.code === "LAUNCH_FAILED"));
    expect(journal("w1").some((e) => e.type === "decision_opened")).toBe(false);
    expect(box.launches).toHaveLength(0);
  });

  it("a missing remote clone opens a remote_repo_missing decision naming the path", async () => {
    box.tunnel = true;
    box.repoExists = async () => false;
    await submit("w1", "  T1: { issue: 42, host: box }\n");
    await tickUntil(() => journal("w1").some((e) => e.type === "decision_opened"));
    expect(journal("w1").find((e) => e.type === "decision_opened")?.data).toMatchObject({
      kind: "remote_repo_missing",
      host: "box",
      target: "dev@box",
      repo,
    });
    expect(box.launches).toHaveLength(0);
  });

  it("remote_repo_missing goes through the decision store; `cancel` cancels the task", async () => {
    box.tunnel = true;
    box.repoExists = async () => false;
    await submit("w1", "  T1: { issue: 42, host: box }\n");
    await tickUntil(() => journal("w1").some((e) => e.type === "decision_opened"));
    const id = journal("w1").find((e) => e.type === "decision_opened")?.data.decision_id as string;
    // Published retained like every decision (the Desk shows it; notify rings).
    const retained = (await env.retained(`volley/_waves/w1/decisions/${id}`)) as {
      payload: { kind: string; target: string; host: string };
    } | null;
    expect(retained?.payload).toMatchObject({
      kind: "remote_repo_missing",
      host: "box",
      target: "dev@box",
    });
    expect((await task("w1", "T1"))?.stage).toBe("awaiting_decision");

    await daemon.resolveDecision("w1", id, { answer: "cancel", by: "coord-a" });
    expect(journal("w1").find((e) => e.type === "task_cancelled")).toMatchObject({
      task: "T1",
      data: { by: "coord-a" },
    });
    expect((await task("w1", "T1"))?.stage).toBe("cancelled");
    expect(await env.retained(`volley/_waves/w1/decisions/${id}`)).toBeNull();
    expect(box.launches).toHaveLength(0);
  });
});

describe("TunnelSupervisor", () => {
  it("keeps `ssh -N -R` up per target, restarts it with backoff, stops on stop()", async () => {
    const calls: string[][] = [];
    let exits = 0;
    const waits: number[] = [];
    const exec: ExecFn = (argv, opts = {}) => {
      calls.push([...argv]);
      // The first two runs die at once (e.g. the box is unreachable); the third stays up.
      if (exits < 2) {
        exits++;
        return Promise.resolve({ code: 255, stdout: "", stderr: "unreachable", timedOut: false });
      }
      return new Promise((resolve) =>
        opts.signal?.addEventListener("abort", () =>
          resolve({ code: 143, stdout: "", stderr: "", timedOut: false }),
        ),
      );
    };
    const sup = new TunnelSupervisor({
      exec,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    sup.ensure("dev@box", 21883, "mqtt://127.0.0.1:1883");
    sup.ensure("dev@box", 21883, "mqtt://127.0.0.1:1883");
    await until(() => calls.length === 3);
    expect(calls[0]).toEqual([
      "ssh",
      "-N",
      "-R",
      "21883:127.0.0.1:1883",
      "-o",
      "BatchMode=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ConnectTimeout=10",
      "dev@box",
    ]);
    expect(waits).toEqual([1000, 2000]);
    expect(sup.targets()).toEqual(["dev@box:21883"]);
    await sup.stop();
    expect(sup.targets()).toEqual([]);
    expect(calls).toHaveLength(3);
  });

  it("keys tunnels by forward: a second port on the same box is a second tunnel", async () => {
    const calls: string[][] = [];
    const exec: ExecFn = (argv, opts = {}) => {
      calls.push([...argv]);
      return new Promise((resolve) =>
        opts.signal?.addEventListener("abort", () =>
          resolve({ code: 143, stdout: "", stderr: "", timedOut: false }),
        ),
      );
    };
    const sup = new TunnelSupervisor({ exec });
    sup.ensure("dev@box", 21883, "mqtt://127.0.0.1:1883");
    sup.ensure("dev@box", 2883, "mqtt://127.0.0.1:1883");
    sup.ensure("dev@box", 2883, "mqtt://127.0.0.1:1883");
    await until(() => calls.length === 2);
    expect(sup.targets()).toEqual(["dev@box:21883", "dev@box:2883"]);
    expect(calls.map((c) => c[3])).toEqual(["21883:127.0.0.1:1883", "2883:127.0.0.1:1883"]);
    await sup.stop();
  });

  it("health: settling while a fresh ssh comes up, failing after two quick exits, ok once it stays up", async () => {
    let clock = 0;
    let runs = 0;
    const exec: ExecFn = (_argv, opts = {}) => {
      runs++;
      if (runs <= 2) {
        return Promise.resolve({
          code: 255,
          stdout: "",
          stderr: "forward failed",
          timedOut: false,
        });
      }
      return new Promise((resolve) =>
        opts.signal?.addEventListener("abort", () =>
          resolve({ code: 143, stdout: "", stderr: "", timedOut: false }),
        ),
      );
    };
    const exits: TunnelExit[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const sup = new TunnelSupervisor({
      exec,
      now: () => clock,
      settleMs: 1000,
      onExit: (x) => exits.push(x),
      // Hold the restart after the second exit so the failing state can be observed.
      sleep: async () => {
        if (exits.length === 2) await gate;
      },
    });
    expect(sup.health("dev@box", 21883)).toBe("ok"); // not supervised: the check decides
    sup.ensure("dev@box", 21883, "mqtt://127.0.0.1:1883");
    await until(() => exits.length === 2);
    expect(exits.map((x) => x.streak)).toEqual([1, 2]);
    expect(exits[1]).toMatchObject({ target: "dev@box", remotePort: 21883, code: 255 });
    expect(sup.health("dev@box", 21883)).toBe("failing");
    release();
    await until(() => runs === 3);
    expect(sup.health("dev@box", 21883)).toBe("failing"); // up, but not for long yet
    clock += 1000;
    expect(sup.health("dev@box", 21883)).toBe("ok");
    await sup.stop();
  });

  it("refuses a broker it cannot forward (not mqtt://host:port)", () => {
    expect(() => tunnelArgv("dev@box", 21883, "ws://127.0.0.1:9001")).toThrow(/mqtt:/);
  });
});
