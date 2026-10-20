import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { ControlClient } from "../src/control";
import {
  admissionFor,
  candidates,
  killSwitchEngaged,
  nextSteer,
  steerTarget,
} from "../src/controls";
import { Daemon } from "../src/daemon";
import { admit } from "../src/scheduler";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { eventually } from "./helpers/broker-wait";
import { NO_PRESSURE, NS } from "./helpers/daemon-env";
import { type FakeClock, fakeClock } from "./helpers/fake-clock";
import { runCli } from "./helpers/run-cli";
import { schemaErrors } from "./helpers/schema";
import { tempDir } from "./helpers/tmp";

const WAVE = "w-ctl";
const yaml = (wave: string) => `wave: ${wave}
repo: example-org/example-repo
release_branch: release/${wave}
model: claude-opus-5-5
pipeline: [implement, merge_ready]
config: { hard_ceiling: 1 }
tasks:
  A: { issue: 1 }
  B: { issue: 2 }
`;
const OPEN = { allow: Number.POSITIVE_INFINITY, reasons: [] };

let broker: TestBroker;
let home: string;
let daemon: Daemon;
let client: ControlClient;
let agent: VolleyBroker;
/** The daemon's clock: a steer's ack wait closes only when the test moves it. */
let clock: FakeClock;
const interrupted: string[] = [];

const start = () =>
  Daemon.start({
    brokerUrl: broker.url,
    namespace: NS,
    home,
    clock,
    tickMs: 0,
    protocolVersion: 4,
    pressure: NO_PRESSURE,
    interrupt: async (agentId) => {
      interrupted.push(agentId);
    },
  });

beforeEach(async () => {
  interrupted.length = 0;
  clock = fakeClock();
  broker = await startTestBroker();
  home = tempDir("volleyd-controls-");
  daemon = await start();
  client = await ControlClient.connect(broker.url, NS);
  agent = new VolleyBroker();
  await agent.connect({ url: broker.url, agentId: "agent-a1" });
  expect(
    (await client.request("run", { wave_yaml: yaml(WAVE), owner: "coord-a" })).error,
  ).toBeUndefined();
  // A was admitted (hard_ceiling 1); simulate its implementer being up.
  await daemon.recordEvent(WAVE, {
    type: "agent_spawned",
    task: "A",
    data: { role: "implementer", agent_id: "agent-a1" },
  });
  await daemon.recordEvent(WAVE, {
    type: "stage_entered",
    task: "A",
    data: { stage: "implement" },
  });
});
afterEach(async () => {
  await agent.disconnect();
  await client.close();
  await daemon.stop();
  await broker.close();
});

const task = (id: string) => daemon.snapshot(WAVE)?.tasks.find((x) => x.id === id);

/** Wait for an outcome itself, never a fixed delay: answers reach the sender over MQTT. */
const waitFor = eventually;

/**
 * Everything published to the daemon before this call has been read and handled: a control
 * round-trip queued behind it on the daemon's connection (its mailbox is drained in order).
 */
async function consumed(): Promise<void> {
  expect((await client.request("status", {})).ok).toBe(true);
  await daemon.settled();
}

/**
 * Resolve once every message the broker routed to `sub` before this call has reached its
 * handlers. The broker writes a message to its subscribers before it PUBACKs the publisher (the
 * daemon awaits that before replying), and one connection delivers in order: a sentinel `sub`
 * publishes to itself now arrives after all of it. Proves an absence without sleeping.
 */
async function drained(sub: VolleyBroker): Promise<void> {
  const topic = `volley/${NS}/test-barrier/progress`;
  const token = randomUUID();
  const got = sub.subscribeUntil(topic, (p) => p === token, 5000);
  await sub.publish(topic, token, { qos: 1, retain: false });
  expect(await got).not.toBeNull();
}

describe("pause / resume", () => {
  it("pause → admission returns 0 with reason 'wave paused'; running agents continue; resume re-admits", async () => {
    expect((await client.request("pause", { wave: WAVE, by: "coord-a" })).ok).toBe(true);
    expect(daemon.snapshot(WAVE)?.status).toBe("paused");
    // A finishes; B would now fit under the ceiling, but the wave is paused.
    await daemon.recordEvent(WAVE, { type: "stage_entered", task: "A", data: { stage: "done" } });
    await daemon.tick();

    const rec = daemon.record(WAVE);
    if (rec === undefined) throw new Error("no record");
    expect(candidates(rec)).toEqual(["B"]);
    const verdict = admit(candidates(rec), admissionFor(rec, false, OPEN), {
      live: 0,
      hardCeiling: 1,
      spawnsUsed: 0,
      spawnBudget: 10,
    });
    expect(verdict).toEqual({ admit: [], reasons: ["wave paused"] });
    expect(rec.admitted).toEqual(["A"]);
    expect(task("B")?.why_waiting).toBe("wave paused");

    expect((await client.request("resume", { wave: WAVE, by: "coord-a" })).ok).toBe(true);
    await daemon.tick();
    expect(daemon.record(WAVE)?.admitted).toEqual(["A", "B"]);
  });
});

describe("stop", () => {
  it("publishes cancel to every running agent of the wave, interrupts it, journals, and stops admissions", async () => {
    // A second running agent on the wave: A's spec reviewer.
    await daemon.recordEvent(WAVE, {
      type: "agent_spawned",
      task: "A",
      data: { role: "spec_reviewer", agent_id: "agent-a2" },
    });
    // subscribeStream resolves after SUBACK, so the cancels published after it cannot be missed.
    const got: Record<string, string[]> = { "agent-a1": [], "agent-a2": [] };
    const unsubs = await Promise.all(
      Object.keys(got).map((id) =>
        agent.subscribeStream(`volley/${NS}/${id}/mailbox`, (m) => got[id]?.push(m.payload)),
      ),
    );
    const res = await client.request("stop", { wave: WAVE, by: "coord-a" });
    expect(res.error).toBeUndefined();
    expect((res.result as { cancelled: string[] }).cancelled.sort()).toEqual([
      "agent-a1",
      "agent-a2",
    ]);
    await drained(agent);
    for (const unsub of unsubs) await unsub();
    const envs = [...(got["agent-a1"] ?? []), ...(got["agent-a2"] ?? [])].map(parseEnvelope);
    expect(envs).toHaveLength(2);
    for (const env of envs) {
      expect(env?.type).toBe("cancel");
      expect(env?.agent_id).toBe("volleyd");
      expect(env?.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(schemaErrors("mailbox.schema.json", env)).toEqual([]);
    }
    expect(interrupted.sort()).toEqual(["agent-a1", "agent-a2"]);

    expect(daemon.snapshot(WAVE)?.status).toBe("stopped");
    const sent = daemon.journalEvents(WAVE).filter((e) => e.type === "steering_sent");
    expect(
      sent.map((e) => e.data).sort((x, y) => String(x.agent_id).localeCompare(String(y.agent_id))),
    ).toEqual([
      expect.objectContaining({
        agent_id: "agent-a1",
        role: "implementer",
        type: "cancel",
        message_id: envs[0]?.correlation_id,
      }),
      expect.objectContaining({
        agent_id: "agent-a2",
        role: "spec_reviewer",
        type: "cancel",
        message_id: envs[1]?.correlation_id,
      }),
    ]);
    await daemon.recordEvent(WAVE, { type: "stage_entered", task: "A", data: { stage: "done" } });
    await daemon.tick();
    expect(daemon.record(WAVE)?.admitted).toEqual(["A"]);
    expect(task("B")?.why_waiting).toBe("wave stopped");
  });

  it("stop skips agents already retired (their task.agents entry stays)", async () => {
    await daemon.recordEvent(WAVE, {
      type: "agent_spawned",
      task: "A",
      data: { role: "spec_reviewer", agent_id: "agent-a2" },
    });
    await daemon.recordEvent(WAVE, {
      type: "agent_retired",
      task: "A",
      data: { agent_id: "agent-a2", status: "done" },
    });
    const res = await client.request("stop", { wave: WAVE, by: "coord-a" });
    expect((res.result as { cancelled: string[] }).cancelled).toEqual(["agent-a1"]);
    expect(interrupted).toEqual(["agent-a1"]);
  });

  it("stop --all engages the kill switch: every wave stops and run is refused until resume --all", async () => {
    expect((await client.request("run", { wave_yaml: yaml("w-other") })).ok).toBe(true);
    const res = await client.request("stop", { all: true, by: "operator" });
    expect(res.error).toBeUndefined();
    expect(daemon.snapshot(WAVE)?.status).toBe("stopped");
    expect(daemon.snapshot("w-other")?.status).toBe("stopped");

    const refused = await client.request("run", { wave_yaml: yaml("w-third") });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("kill switch engaged");

    // The switch is journaled, so it survives a restart.
    await daemon.stop();
    daemon = await start();
    expect((await client.request("run", { wave_yaml: yaml("w-third") })).error).toContain(
      "kill switch engaged",
    );
    expect((await client.request("status", {})).result).toMatchObject({ kill_switch: true });

    expect((await client.request("resume", { all: true, by: "operator" })).ok).toBe(true);
    expect((await client.request("run", { wave_yaml: yaml("w-third") })).ok).toBe(true);
  });
});

describe("steer", () => {
  it("sends mailbox steering with seq 1 then 2, supersedes on the second, and reports the ack", async () => {
    const seen: ReturnType<typeof parseEnvelope>[] = [];
    const replies: Promise<void>[] = [];
    const unsub = await agent.subscribeStream(`volley/${NS}/agent-a1/mailbox`, ({ payload }) => {
      const env = parseEnvelope(payload);
      seen.push(env);
      if (env === null || env.correlation_id === null) return;
      // Simulated recipient, per the SPEC: a §4.4 mailbox `ack` (received) to the sender's
      // mailbox for every message, and a §4.3 `steering_acked` on its own progress channel once
      // the model acted — here only on the second message.
      replies.push(
        agent.publish(
          `volley/${NS}/volleyd/mailbox`,
          JSON.stringify(
            buildEnvelope({
              agentId: "agent-a1",
              parentId: null,
              channel: "mailbox",
              type: "ack",
              correlationId: env.correlation_id,
              payload: { text: "ACKED", acked_type: env.type },
            }),
          ),
          { qos: 1, retain: false },
        ),
      );
      if ((env.payload as { seq?: number }).seq === 2) {
        const acted = buildEnvelope({
          agentId: "agent-a1",
          parentId: null,
          channel: "progress",
          type: "steering_acked",
          correlationId: env.correlation_id,
          payload: { msg: "kept v1" },
        });
        expect(schemaErrors("progress.schema.json", acted)).toEqual([]);
        void agent.publish(`volley/${NS}/agent-a1/progress`, JSON.stringify(acted), {
          qos: 0,
          retain: false,
        });
      }
    });

    const pending = client.request("steer", {
      wave: WAVE,
      task: "A",
      text: "use the v2 client",
      by: "coord-a",
      wait_ack_ms: 200,
    });
    // The recipient's mailbox ack is in; then the ack wait runs out (no `steering_acked`).
    await waitFor(() => replies.length === 1);
    await Promise.all(replies);
    await consumed();
    await clock.armed(200);
    await clock.advance(200);
    const first = await pending;
    expect(first.error).toBeUndefined();
    expect(first.result).toMatchObject({
      agent_id: "agent-a1",
      seq: 1,
      delivery: "received",
      received: true,
      acked: false,
    });

    const second = await client.request("steer", {
      wave: WAVE,
      task: "A",
      text: "actually, keep v1",
      by: "coord-a",
      wait_ack_ms: 3000,
    });
    expect(second.error).toBeUndefined();
    expect(second.result).toMatchObject({
      seq: 2,
      delivery: "acked",
      received: true,
      acked: true,
      acked_by: "agent-a1",
    });
    await unsub();

    expect(seen.map((e) => e?.type)).toEqual(["steering", "steering"]);
    const [a, b] = seen;
    expect(a?.payload).toMatchObject({ text: "use the v2 client", seq: 1 });
    expect(a?.payload).not.toHaveProperty("supersedes");
    expect(b?.payload).toMatchObject({ seq: 2, supersedes: a?.correlation_id });
    expect((second.result as { supersedes: string }).supersedes).toBe(a?.correlation_id);
    const sent = daemon.journalEvents(WAVE).filter((e) => e.type === "steering_sent");
    expect(sent.map((e) => e.data.seq)).toEqual([1, 2]);
  });

  it("a merge nudge is additive: it never supersedes an owner steer, and the next owner steer supersedes the owner's", async () => {
    const seen: ReturnType<typeof parseEnvelope>[] = [];
    const unsub = await agent.subscribeStream(`volley/${NS}/agent-a1/mailbox`, ({ payload }) => {
      const env = parseEnvelope(payload);
      if (env?.type === "steering") seen.push(env);
    });
    const owner = (text: string) =>
      client.request("steer", { wave: WAVE, task: "A", text, by: "coord-a", wait_ack_ms: 0 });
    expect((await owner("don't touch the auth module")).ok).toBe(true);
    // A sibling's PR merges while the owner's steer is still unread: the pipeline's nudge.
    const driver = (
      daemon as unknown as {
        pipelineFor: (w: string) => { deps: import("../src/pipeline").PipelineDeps };
      }
    ).pipelineFor(WAVE);
    await driver.deps.steer(
      "A",
      "implementer",
      "agent-a1",
      "origin/release/w-ctl moved with #7; rebase when convenient, before you push again.",
      "merge_nudge",
    );
    const third = await owner("now the auth module is yours");
    expect(third.ok).toBe(true);
    await waitFor(() => seen.length === 3);
    await unsub();

    const [ownerSteer, nudge, later] = seen;
    expect(nudge?.payload).toMatchObject({ seq: 2 });
    expect(nudge?.payload).not.toHaveProperty("supersedes");
    // The owner's next steer replaces the owner's, never the nudge.
    expect(later?.payload).toMatchObject({ seq: 3, supersedes: ownerSteer?.correlation_id });
    expect((third.result as { supersedes?: string }).supersedes).toBe(ownerSteer?.correlation_id);
    const sent = daemon.journalEvents(WAVE).filter((e) => e.type === "steering_sent");
    expect(sent.map((e) => e.data.seq)).toEqual([1, 2, 3]);
    expect(sent[1]?.data).toMatchObject({ reason: "merge_nudge" });
    expect(sent[1]?.data).not.toHaveProperty("supersedes");
    // Replay keeps the same answer: the record's last supersedable steer is the owner's.
    expect(daemon.record(WAVE)?.steers.A).toEqual({ seq: 3, message_id: later?.correlation_id });
  });

  it("a redelivered steer request (same correlation_id) is sent and journaled once", async () => {
    const seen: string[] = [];
    const unsub = await agent.subscribeStream(`volley/${NS}/agent-a1/mailbox`, ({ payload }) => {
      const env = parseEnvelope(payload);
      if (env?.type === "steering") seen.push(env.correlation_id ?? "");
    });
    const sender = new VolleyBroker();
    await sender.connect({ url: broker.url, agentId: "coord-a" });
    const answers: unknown[] = [];
    const unsubAnswers = await sender.subscribeStream(`volley/${NS}/coord-a/mailbox`, (m) => {
      answers.push(parseEnvelope(m.payload)?.payload);
    });
    const query = JSON.stringify(
      buildEnvelope({
        agentId: "coord-a",
        parentId: null,
        channel: "mailbox",
        type: "query",
        correlationId: "redelivered-1",
        payload: { op: "steer", text: "x", wave: WAVE, task: "A", by: "coord-a", wait_ack_ms: 300 },
      }),
    );
    // QoS 1 redelivery: the same request twice, the second while the first waits for its ack,
    // then a third after it has been answered.
    await sender.publish(`volley/${NS}/volleyd/mailbox`, query, { qos: 1, retain: false });
    await sender.publish(`volley/${NS}/volleyd/mailbox`, query, { qos: 1, retain: false });
    await consumed();
    await clock.advance(300); // the first one's ack wait runs out: answered once
    await waitFor(() => answers.length >= 1);
    await sender.publish(`volley/${NS}/volleyd/mailbox`, query, { qos: 1, retain: false });
    await waitFor(() => answers.length >= 2);
    await drained(sender);
    await drained(agent);
    await unsub();
    await unsubAnswers();
    await sender.disconnect();
    expect(seen).toHaveLength(1);
    expect(daemon.journalEvents(WAVE).filter((e) => e.type === "steering_sent")).toHaveLength(1);
    expect(answers).toHaveLength(2);
    expect(answers[0]).toEqual(answers[1]);
    expect(answers[0]).toMatchObject({ op: "steer", ok: true, result: { seq: 1 } });
  });

  it("ignores acks from anyone but the steered agent", async () => {
    const impostor = new VolleyBroker();
    await impostor.connect({ url: broker.url, agentId: "agent-zz" });
    const fakes: Promise<void>[] = [];
    const unsub = await agent.subscribeStream(`volley/${NS}/agent-a1/mailbox`, ({ payload }) => {
      const env = parseEnvelope(payload);
      if (env?.correlation_id == null) return;
      const id = env.correlation_id;
      const as = (type: string, channel: string) =>
        JSON.stringify(
          buildEnvelope({
            agentId: "agent-zz",
            parentId: null,
            channel,
            type,
            correlationId: id,
            payload: { text: "ACKED" },
          }),
        );
      fakes.push(
        impostor.publish(`volley/${NS}/volleyd/mailbox`, as("ack", "mailbox"), {
          qos: 1,
          retain: false,
        }),
        impostor.publish(`volley/${NS}/agent-zz/progress`, as("steering_acked", "progress"), {
          qos: 1,
          retain: false,
        }),
      );
    });
    const pending = client.request("steer", {
      wave: WAVE,
      task: "A",
      text: "x",
      by: "coord-a",
      wait_ack_ms: 400,
    });
    // The impostor's acks are in before the wait runs out: they must not count.
    await waitFor(() => fakes.length === 2);
    await Promise.all(fakes);
    await consumed();
    await clock.armed(400);
    await clock.advance(400);
    const res = await pending;
    await unsub();
    await impostor.disconnect();
    expect(res.result).toMatchObject({ delivery: "delivered", received: false, acked: false });
  });

  it("steer by a non-owner is refused; steer to a task without an agent is an error", async () => {
    expect(
      (await client.request("steer", { wave: WAVE, task: "A", text: "x", by: "coord-z" })).error,
    ).toContain("owned by coord-a");
    expect(
      (await client.request("steer", { wave: WAVE, task: "B", text: "x", by: "coord-a" })).error,
    ).toContain("task 'B' has no agent");
  });

  it("refuses a role that is not a task role (no prototype keys), journaling nothing", async () => {
    const seq = daemon.record(WAVE)?.seq;
    for (const role of ["constructor", "__proto__", "toString", "reviewer"]) {
      const res = await client.request("steer", {
        wave: WAVE,
        task: "A",
        text: "x",
        role,
        by: "coord-a",
      });
      expect(res.ok).toBe(false);
      expect(res.error).toContain(`unknown role '${role}'`);
    }
    expect(daemon.record(WAVE)?.seq).toBe(seq);
    expect(daemon.record(WAVE)?.steers).toEqual({});
  });
  it("urgent: interrupts the agent BEFORE delivering the one steering message", async () => {
    const order: string[] = [];
    const unsub = await agent.subscribeStream(`volley/${NS}/agent-a1/mailbox`, ({ payload }) => {
      const env = parseEnvelope(payload);
      if (env !== null) order.push(`${env.type}:${(env.payload as { text?: string }).text}`);
    });
    const before = interrupted.length;
    const res = await client.request("steer", {
      wave: WAVE,
      task: "A",
      text: "stop the migration",
      urgent: true,
      by: "coord-a",
      wait_ack_ms: 0,
    });
    await drained(agent);
    await unsub();
    expect(res.error).toBeUndefined();
    expect(res.result).toMatchObject({ agent_id: "agent-a1", seq: 1, interrupted: true });
    expect(interrupted.slice(before)).toEqual(["agent-a1"]);
    // Exactly one message, carrying the operator's text (no machine-worded second steer).
    expect(order).toEqual(["steering:stop the migration"]);
    expect(daemon.journalEvents(WAVE).filter((e) => e.type === "steering_sent")).toHaveLength(1);
  });

  it("escape_only: interrupts and delivers nothing (the caller publishes its own message)", async () => {
    const seen: string[] = [];
    const unsub = await agent.subscribeStream(`volley/${NS}/agent-a1/mailbox`, ({ payload }) => {
      seen.push(parseEnvelope(payload)?.type ?? "?");
    });
    const seq = daemon.record(WAVE)?.seq;
    const res = await client.request("steer", {
      wave: WAVE,
      task: "A",
      urgent: true,
      escape_only: true,
      by: "coord-a",
    });
    await drained(agent);
    await unsub();
    expect(res.error).toBeUndefined();
    expect(res.result).toMatchObject({
      wave: WAVE,
      task: "A",
      agent_id: "agent-a1",
      escape_only: true,
      interrupted: true,
    });
    expect(interrupted).toEqual(["agent-a1"]);
    expect(seen).toEqual([]);
    expect(daemon.record(WAVE)?.seq).toBe(seq);
    expect(daemon.record(WAVE)?.steers).toEqual({});
  });

  it("escape_only without an interrupt hook answers ok with interrupted: false", async () => {
    await daemon.stop();
    daemon = await Daemon.start({
      brokerUrl: broker.url,
      namespace: NS,
      home,
      tickMs: 0,
      protocolVersion: 4,
    });
    const res = await client.request("steer", {
      wave: WAVE,
      task: "A",
      urgent: true,
      escape_only: true,
      by: "coord-a",
    });
    expect(res.ok).toBe(true);
    expect(res.result).toMatchObject({ agent_id: "agent-a1", interrupted: false });
    expect(interrupted).toEqual([]);
  });

  it("escape_only by a non-owner is refused and interrupts nobody", async () => {
    const res = await client.request("steer", {
      wave: WAVE,
      task: "A",
      urgent: true,
      escape_only: true,
      by: "coord-z",
    });
    expect(res.error).toContain("owned by coord-a");
    expect(interrupted).toEqual([]);
  });
});

describe("controls (pure)", () => {
  it("steerTarget follows the stage; nextSteer numbers from the journaled steers", () => {
    const rec = daemon.record(WAVE);
    if (rec === undefined) throw new Error("no record");
    expect(steerTarget(rec, "A")).toEqual({ role: "implementer", agent_id: "agent-a1" });
    expect(steerTarget(rec, "B")).toBeNull();
    expect(nextSteer(rec, "A")).toEqual({ seq: 1 });
  });

  it("killSwitchEngaged reads the last all-waves stop/resume in the system journal", () => {
    const ev = (seq: number, type: "wave_stopped" | "wave_resumed", all = true) => ({
      seq,
      at: "2026-10-18T12:00:00.000Z",
      type,
      data: all ? { all: true } : {},
    });
    expect(killSwitchEngaged([])).toBe(false);
    expect(killSwitchEngaged([ev(1, "wave_stopped")])).toBe(true);
    expect(killSwitchEngaged([ev(1, "wave_stopped"), ev(2, "wave_resumed")])).toBe(false);
    expect(killSwitchEngaged([ev(1, "wave_stopped"), ev(2, "wave_resumed", false)])).toBe(true);
  });
});

describe("CLI", () => {
  const env = () => ({ VOLLEY_BROKER_URL: broker.url, VOLLEY_NAMESPACE: NS, VOLLEYD_HOME: home });
  const as = (id: string) => ({ ...env(), VOLLEY_AGENT_ID: id });

  it("run --owner / auto owner, and refuses a different owner re-running the wave", async () => {
    const file = join(home, "other.yaml");
    writeFileSync(file, yaml("w-cli"));
    const r = await runCli(["run", file], as("coord-c"));
    // coord-c never registered: it becomes the owner, with a warning.
    expect(r.stderr).toBe(
      "warning: VOLLEY_AGENT_ID=coord-c has no registry entry; using it anyway\n",
    );
    expect(r.stdout).toContain("owner: coord-c (auto)");
    expect(daemon.snapshot("w-cli")?.owner).toBe("coord-c");
    const again = await runCli(["run", file, "--owner", "coord-d"], env());
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain("already running under owner coord-c");
  });

  it("decisions, status needs-you and resolve", async () => {
    const d = await daemon.openDecision(WAVE, {
      kind: "agent_blocked",
      task: "A",
      question: "Which schema version?",
      options: ["0.1", "0.2"],
      pointers: { pr: "https://example.invalid/pr/1" },
    });
    const list = await runCli(["decisions"], env());
    expect(list.stdout).toContain(`${d.decision_id}  ${WAVE}/A  agent_blocked`);
    expect(list.stdout).toContain("options: 0.1 | 0.2");

    const mine = await runCli(["status", WAVE], as("coord-a"));
    expect(mine.stdout).toContain("decisions: 1  needs you: 1");
    expect(mine.stdout).toContain(`? ${d.decision_id}`);
    const theirs = await runCli(["status", WAVE], as("coord-z"));
    expect(theirs.stdout).not.toContain("needs you");
    const byFlag = await runCli(["status", WAVE, "--by", "coord-a"], as("coord-z"));
    expect(byFlag.stdout).toContain("decisions: 1  needs you: 1");

    const refused = await runCli(["resolve", d.decision_id, "0.2"], as("coord-z"));
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("owned by coord-a");
    const ok = await runCli(
      ["resolve", d.decision_id, "0.2", "--rationale", "newer"],
      as("coord-a"),
    );
    expect(ok.stderr).toBe("");
    expect(ok.stdout).toContain(`resolved ${d.decision_id} (${WAVE}): 0.2`);
    expect(ok.stdout).toContain("decisions.md");
    expect((await runCli(["decisions"], env())).stdout).toBe("no open decisions\n");
  });

  // One step per test: every CLI call waits out the caller's registry scan, and a claim the
  // owner's liveness probe, so the whole sequence in one test outgrows bun's 5 s test default.
  it("pause, resume and steer", async () => {
    expect((await runCli(["pause", WAVE], as("coord-a"))).stdout).toBe(`paused wave ${WAVE}\n`);
    expect((await runCli(["resume", WAVE], as("coord-a"))).stdout).toBe(`resumed wave ${WAVE}\n`);
    const steer = await runCli(
      ["steer", WAVE, "A", "rebase", "first", "--wait-ack-ms", "0"],
      as("coord-a"),
    );
    expect(steer.stderr).toBe("");
    expect(steer.stdout).toContain("steer #1 → agent-a1 (implementer): delivered");
  });

  it("claim needs an identity and is refused while the owner may be alive", async () => {
    const anonymous = await runCli(["claim", WAVE], env());
    expect(anonymous.exitCode).toBe(1);
    expect(anonymous.stderr).toContain("claim needs an identity");
    // coord-a has never been seen by the broker: not claimable until it is gone.
    expect((await runCli(["claim", WAVE], as("coord-b"))).stderr).toContain("owned by coord-a");
  });

  it("claim takes over once the owner is reaped", async () => {
    const pub = new VolleyBroker();
    await pub.connect({ url: broker.url, agentId: "coord-a" });
    await pub.publish(
      `volley/${NS}/coord-a/status`,
      JSON.stringify(
        buildEnvelope({
          agentId: "coord-a",
          parentId: null,
          channel: "status",
          type: "reaped",
          payload: {},
        }),
      ),
      { qos: 1, retain: true },
    );
    await pub.disconnect();
    const claim = await runCli(["claim", WAVE], as("coord-b"));
    expect(claim.stdout).toContain(`claimed wave ${WAVE} for coord-b (was coord-a)`);
    // The new owner can act on the wave.
    expect((await runCli(["pause", WAVE], as("coord-b"))).stdout).toBe(`paused wave ${WAVE}\n`);
  });

  it("stop and stop --all / resume --all", async () => {
    const stop = await runCli(["stop", WAVE], as("coord-a"));
    expect(stop.stdout).toBe(`stopped wave ${WAVE}; cancel sent to 1 agent(s): agent-a1\n`);
    const all = await runCli(["stop", "--all"], env());
    expect(all.stdout).toContain("kill switch engaged");
    expect((await runCli(["status"], env())).stdout).toContain("KILL SWITCH ENGAGED");
    expect((await runCli(["resume", "--all"], env())).stdout).toContain("kill switch released");
    expect((await runCli(["pause"], env())).exitCode).toBe(2);
  });
});
