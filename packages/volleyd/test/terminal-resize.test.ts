// The Desk's Terminal popout sizes the agent's terminal (#403): the `terminal_resize` control op
// reaches the agent's host, a burst is one resize to its last size, and a reset returns it to
// its launch size.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import { ControlClient } from "../src/control";
import type { Daemon } from "../src/daemon";
import { eventually } from "./helpers/broker-wait";
import { type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { type FakeClock, fakeClock } from "./helpers/fake-clock";
import { fakeExec } from "./helpers/fake-exec";
import { FIXTURES, type FakeHost, fakeHost } from "./helpers/fake-host";
import { type JournalWait, journalWait } from "./helpers/journal-wait";
import { runCli } from "./helpers/run-cli";

const ID = "w1-t1-implementer-1";

describe("terminal_resize", () => {
  let env: DaemonEnv;
  let agent: VolleyBroker;
  let host: FakeHost;
  let daemon: Daemon;
  let clock: FakeClock;
  let waits: JournalWait;
  let client: ControlClient;
  const sessions = new Set<Promise<void>>();

  const pub = (topic: string, type: string, channel: string, payload: unknown, retain = true) =>
    agent.publish(
      topic,
      JSON.stringify({
        ...buildEnvelope({ agentId: ID, parentId: "volleyd", channel, type, payload }),
        ...(channel === "_system/registry" ? { namespace: NS } : {}),
      }),
      { qos: 1, retain },
    );

  /** Every request sent before this call has been handled (the mailbox drains in order). */
  const consumed = async () => {
    expect((await client.request("status", {})).ok).toBe(true);
    await daemon.settled();
  };

  /** Send `fields` as terminal_resize; the answer comes once the coalescing window closes. */
  const resize = (fields: Record<string, unknown>) =>
    client.request("terminal_resize", { agent_id: ID, by: "desk", ...fields });

  beforeEach(async () => {
    env = await makeDaemonEnv();
    const repo = join(realpathSync(env.home), "repo");
    mkdirSync(repo);
    const claudeJson = join(env.home, "claude.json");
    writeFileSync(
      claudeJson,
      JSON.stringify({ projects: { [repo]: { hasTrustDialogAccepted: true } } }),
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
    host = fakeHost(fake);
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
        await pub(buildTopic(NS, ID, "status"), "working", "status", {});
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
    clock = fakeClock(5_000_000);
    daemon = await env.start({
      clock,
      spawner: {
        host,
        claudeJsonPath: claudeJson,
        hooksDir: "/opt/volley-hooks",
        mintCredentials: false,
      },
    });
    const wave = join(env.home, "w1.yaml");
    writeFileSync(
      wave,
      `wave: w1\nrepo: ${repo}\nrelease_branch: release/w1\nmodel: claude-opus-5-5\npipeline: [implement]\ntasks:\n  T1: { issue: 42 }\nconfig: { worktree_root: ${join(env.home, "wt")}, tmux_cols: 160, tmux_rows: 40 }\n`,
    );
    waits = journalWait(env.home, () => daemon);
    expect((await runCli(["run", wave], env.env)).exitCode).toBe(0);
    await waits.event("w1", "agent_registered");
    await waits.settled();
    client = await ControlClient.connect(env.broker.url, NS);
  });

  afterEach(async () => {
    await client.close();
    await Promise.all([...sessions]);
    await agent.disconnect();
    await env.cleanup();
  });

  it("launches at the wave's tmux_cols × tmux_rows", () => {
    expect(host.launches[0]?.size).toEqual({ cols: 160, rows: 40 });
  });

  it("resizes the agent's workspace on its host; reset: true is its launch size", async () => {
    const sized = resize({ cols: 180, rows: 48 });
    await consumed();
    await clock.advance(DAEMON_DEFAULTS.terminal_resize_coalesce_ms);
    const r = await sized;
    expect(r.error).toBeUndefined();
    expect(r.result).toEqual({ agent_id: ID, resized: true, cols: 180, rows: 48 });

    const reset = resize({ reset: true });
    await consumed();
    await clock.advance(DAEMON_DEFAULTS.terminal_resize_coalesce_ms);
    expect((await reset).result).toEqual({ agent_id: ID, resized: true, reset: true });
    expect(host.resizes).toEqual([
      { workspace: "workspace:1", size: { cols: 180, rows: 48 } },
      { workspace: "workspace:1", size: "launch" },
    ]);
  });

  it("a burst is one resize to the last size, and every request gets the answer", async () => {
    // One connection, each publish acknowledged before the next: they reach volleyd in order.
    const desk = new VolleyBroker();
    await desk.connect({ url: env.broker.url, agentId: "desk-test" });
    const acks: unknown[] = [];
    await desk.subscribeStream(buildTopic(NS, "desk-test", "mailbox"), ({ payload }) => {
      const e = parseEnvelope(payload);
      if (e?.type === "ack") acks.push(e.payload);
    });
    for (const [cols, rows] of [
      [100, 30],
      [140, 36],
      [181, 49],
    ]) {
      const req = buildEnvelope({
        agentId: "desk-test",
        parentId: null,
        channel: "mailbox",
        type: "query",
        correlationId: `r-${cols}`,
        payload: { op: "terminal_resize", text: "resize", agent_id: ID, cols, rows, by: "desk" },
      });
      await desk.publish(buildTopic(NS, "volleyd", "mailbox"), JSON.stringify(req), {
        qos: 1,
        retain: false,
      });
    }
    await consumed();
    expect(host.resizes).toEqual([]);
    await clock.advance(DAEMON_DEFAULTS.terminal_resize_coalesce_ms);
    await eventually(() => acks.length === 3);
    await desk.disconnect();
    expect(host.resizes).toEqual([{ workspace: "workspace:1", size: { cols: 181, rows: 49 } }]);
    for (const a of acks)
      expect(a).toMatchObject({ ok: true, result: { resized: true, cols: 181 } });
  });

  it("a resize flushed while the one before it is still running waits for it", async () => {
    const order: string[] = [];
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    host.resize = async (workspace, size) => {
      const shown = size === "launch" ? "launch" : `${size.cols}`;
      order.push(`start ${shown}`);
      if (size !== "launch" && size.cols === 100) await held;
      host.resizes.push({ workspace, size });
      order.push(`end ${shown}`);
      return true;
    };
    const first = resize({ cols: 100, rows: 30 });
    await consumed();
    await clock.advance(DAEMON_DEFAULTS.terminal_resize_coalesce_ms);
    await eventually(() => order.length === 1);
    const second = resize({ reset: true });
    await consumed();
    await clock.advance(DAEMON_DEFAULTS.terminal_resize_coalesce_ms);
    expect(order).toEqual(["start 100"]);
    release();
    expect((await first).result).toMatchObject({ cols: 100 });
    expect((await second).result).toMatchObject({ reset: true });
    expect(order).toEqual(["start 100", "end 100", "start launch", "end launch"]);
  });

  it("stopping drops a resize still in its coalescing window", async () => {
    // A stopped volleyd publishes no answer; the request itself times out.
    void resize({ cols: 120, rows: 30 }).catch(() => {});
    await consumed();
    await daemon.stop();
    await clock.advance(DAEMON_DEFAULTS.terminal_resize_coalesce_ms * 2);
    expect(host.resizes).toEqual([]);
  });

  it("refuses an unknown agent and a size out of bounds, resizing nothing", async () => {
    const unknown = await client.request("terminal_resize", {
      agent_id: "nobody-1",
      cols: 100,
      rows: 30,
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toMatch(/not live/);
    for (const bad of [
      { cols: 10, rows: 30 },
      { cols: 100, rows: 9999 },
      { cols: 100.5, rows: 30 },
      {},
    ]) {
      const r = await resize(bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect(r.error).toMatch(/cols and rows/);
    }
    expect(host.resizes).toEqual([]);
  });

  it("in a wave owned by someone else it is refused, as steer is", async () => {
    expect((await client.request("claim", { wave: "w1", by: "coord-a" })).ok).toBe(true);
    const r = await resize({ cols: 120, rows: 30, by: "someone-else" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("is owned by coord-a");
    const ok = resize({ cols: 120, rows: 30, by: "coord-a" });
    await consumed();
    await clock.advance(DAEMON_DEFAULTS.terminal_resize_coalesce_ms);
    expect((await ok).result).toMatchObject({ resized: true, cols: 120 });
    expect(host.resizes).toEqual([{ workspace: "workspace:1", size: { cols: 120, rows: 30 } }]);
  });

  it("a host that cannot resize (cmux) answers resized: false", async () => {
    host.resize = async (workspace, size) => {
      host.resizes.push({ workspace, size });
      return false;
    };
    const r = resize({ cols: 120, rows: 30 });
    await consumed();
    await clock.advance(DAEMON_DEFAULTS.terminal_resize_coalesce_ms);
    expect((await r).result).toMatchObject({ resized: false });
  });
});
