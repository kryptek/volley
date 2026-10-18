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
import { TunnelSupervisor, tunnelArgv } from "../src/hosts/tunnel";
import { makeBufferIO } from "../src/io";
import { readJournalFile } from "../src/journal";
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

interface FakeRemote extends FakeHost, RemoteHost {
  tunnel: boolean;
  tunnelChecks: number;
}

/** A remote host on fakes: files land in a temp dir, the tunnel check answers `tunnel`. */
function fakeRemote(spec: RemoteHostSpec, local: FakeHost): FakeRemote {
  const h = fakeHost(local.fake) as FakeRemote;
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
    repoExists: async () => true,
    tunnelUp: async () => {
      h.tunnelChecks++;
      return h.tunnel;
    },
    readTrust: async () => ({ projects: { [spec.repo]: { hasTrustDialogAccepted: true } } }),
  });
  return h;
}

describe("remote host tunnel: park, resume, never touch running agents", () => {
  let env: DaemonEnv;
  let agent: VolleyBroker;
  let local: FakeHost;
  let box: FakeRemote;
  let daemon: Daemon;
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
  const recheck = async () => {
    const before = box.tunnelChecks;
    clock += 60_000;
    await daemon.tick();
    await until(() => box.tunnelChecks > before);
    await daemon.tick();
  };
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
    box = fakeRemote(spec, local);
    box.onLaunch = (s) => {
      const id = `${s.name.split(" ")[0]}-t1-implementer-1`;
      setTimeout(() => void signal(id), 20);
    };
    // The supervised tunnel: a long-lived child that runs until aborted.
    tunnelCalls = [];
    const tunnelExec: ExecFn = (argv, opts = {}) => {
      tunnelCalls.push([...argv]);
      return new Promise((resolve) => {
        opts.signal?.addEventListener("abort", () =>
          resolve({ code: 143, stdout: "", stderr: "", timedOut: false }),
        );
      });
    };
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
        remoteHost: () => box,
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
    await until(() => box.tunnelChecks > 0);
    await daemon.tick();
    await until(async () => (await task("w1", "T1"))?.why_waiting === "tunnel down to dev@box");
    expect(await task("w1", "T1")).toMatchObject({ stage: "queued", host: "box" });
    expect(box.launches).toHaveLength(0);
    expect(local.launches).toHaveLength(0);
    expect(
      journal("w1").find((e) => e.type === "alarm_raised" && e.data.code === "TUNNEL_DOWN")?.data,
    ).toMatchObject({ host: "box", target: "dev@box" });
    // volleyd keeps the reverse tunnel up itself: one per target.
    expect(tunnelCalls).toEqual([tunnelArgv("dev@box", 21883, env.broker.url)]);

    box.tunnel = true;
    await recheck();
    await until(() => journal("w1").some((e) => e.type === "agent_registered"));
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
    await until(() => journal("w1").some((e) => e.type === "agent_registered"));
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
    // A terminal status still retires it normally.
    await agent.publish(
      buildTopic(NS, "w1-t1-implementer-1", "status"),
      JSON.stringify(
        buildEnvelope({
          agentId: "w1-t1-implementer-1",
          parentId: "volleyd",
          channel: "status",
          type: "done",
          payload: { summary: "ok" },
        }),
      ),
      { qos: 1, retain: true },
    );
    await until(() => journal("w1").some((e) => e.type === "agent_retired"));

    // cleanup --yes reaches the box again: kill the tmux session, remove the remote worktree.
    const fx = fakeExec();
    const io = makeBufferIO();
    expect(await cleanupWave(env.home, "w1", { yes: true, force: false, exec: fx.exec }, io)).toBe(
      0,
    );
    const wt = join(box.spec.worktree_root, "w1", "T1-implementer");
    expect(fx.calls.map((c) => [c.argv.at(-3), c.opts.remote?.steps.map((x) => x.argv)])).toEqual([
      ["dev@box", [["tmux", "kill-session", "-t", "=workspace:1"]]],
      ["dev@box", [["git", "-C", repo, "worktree", "remove", wt]]],
    ]);
    expect(io.readStdout()).toContain(`removed ${wt}`);
  });

  it("a missing remote clone opens a remote_repo_missing decision naming the path", async () => {
    box.tunnel = true;
    box.repoExists = async () => false;
    await submit("w1", "  T1: { issue: 42, host: box }\n");
    await until(() => journal("w1").some((e) => e.type === "decision_opened"));
    expect(journal("w1").find((e) => e.type === "decision_opened")?.data).toMatchObject({
      kind: "remote_repo_missing",
      host: "box",
      target: "dev@box",
      repo,
    });
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
    expect(sup.targets()).toEqual(["dev@box"]);
    await sup.stop();
    expect(sup.targets()).toEqual([]);
    expect(calls).toHaveLength(3);
  });

  it("refuses a broker it cannot forward (not mqtt://host:port)", () => {
    expect(() => tunnelArgv("dev@box", 21883, "ws://127.0.0.1:9001")).toThrow(/mqtt:/);
  });
});
