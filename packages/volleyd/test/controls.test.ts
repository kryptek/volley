import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { NS } from "./helpers/daemon-env";
import { runCli } from "./helpers/run-cli";
import { schemaErrors } from "./helpers/schema";

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
const interrupted: string[] = [];

const start = () =>
  Daemon.start({
    brokerUrl: broker.url,
    namespace: NS,
    home,
    tickMs: 0,
    interrupt: async (agentId) => {
      interrupted.push(agentId);
    },
  });

beforeEach(async () => {
  interrupted.length = 0;
  broker = await startTestBroker();
  home = mkdtempSync(join(tmpdir(), "volleyd-controls-"));
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
  rmSync(home, { recursive: true, force: true });
});

const task = (id: string) => daemon.snapshot(WAVE)?.tasks.find((x) => x.id === id);

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
    const got = agent.subscribeCollect("volley/volleyd-test/agent-a1/mailbox", 1, 3000);
    await new Promise((r) => setTimeout(r, 100));
    const res = await client.request("stop", { wave: WAVE, by: "coord-a" });
    expect(res.error).toBeUndefined();
    const [msg] = await got;
    const env = parseEnvelope(msg?.payload ?? "");
    expect(env?.type).toBe("cancel");
    expect(env?.agent_id).toBe("volleyd");
    expect(env?.correlation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(schemaErrors("mailbox.schema.json", env)).toEqual([]);
    expect(interrupted).toEqual(["agent-a1"]);

    expect(daemon.snapshot(WAVE)?.status).toBe("stopped");
    const sent = daemon.journalEvents(WAVE).filter((e) => e.type === "steering_sent");
    expect(sent.map((e) => e.data)).toEqual([
      expect.objectContaining({
        agent_id: "agent-a1",
        type: "cancel",
        message_id: env?.correlation_id,
      }),
    ]);
    await daemon.recordEvent(WAVE, { type: "stage_entered", task: "A", data: { stage: "done" } });
    await daemon.tick();
    expect(daemon.record(WAVE)?.admitted).toEqual(["A"]);
    expect(task("B")?.why_waiting).toBe("wave stopped");
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
    const unsub = await agent.subscribeStream(`volley/${NS}/agent-a1/mailbox`, ({ payload }) => {
      const env = parseEnvelope(payload);
      seen.push(env);
      // Simulated recipient: ack only the second message, to the sender's mailbox.
      if (env !== null && (env.payload as { seq?: number }).seq === 2) {
        const ack = buildEnvelope({
          agentId: "agent-a1",
          parentId: null,
          channel: "mailbox",
          type: "ack",
          correlationId: env.correlation_id ?? "",
          payload: { text: "ACKED" },
        });
        void agent.publish(`volley/${NS}/volleyd/mailbox`, JSON.stringify(ack), {
          qos: 1,
          retain: false,
        });
      }
    });

    const first = await client.request("steer", {
      wave: WAVE,
      task: "A",
      text: "use the v2 client",
      by: "coord-a",
      wait_ack_ms: 200,
    });
    expect(first.error).toBeUndefined();
    expect(first.result).toMatchObject({
      agent_id: "agent-a1",
      seq: 1,
      delivery: "delivered",
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

  it("steer by a non-owner is refused; steer to a task without an agent is an error", async () => {
    expect(
      (await client.request("steer", { wave: WAVE, task: "A", text: "x", by: "coord-z" })).error,
    ).toContain("owned by coord-a");
    expect(
      (await client.request("steer", { wave: WAVE, task: "B", text: "x", by: "coord-a" })).error,
    ).toContain("task 'B' has no agent");
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
    expect(r.stderr).toBe("");
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

  it("pause, resume, steer, claim, stop and stop --all / resume --all", async () => {
    expect((await runCli(["pause", WAVE], as("coord-a"))).stdout).toBe(`paused wave ${WAVE}\n`);
    expect((await runCli(["resume", WAVE], as("coord-a"))).stdout).toBe(`resumed wave ${WAVE}\n`);
    const steer = await runCli(
      ["steer", WAVE, "A", "rebase", "first", "--wait-ack-ms", "0"],
      as("coord-a"),
    );
    expect(steer.stderr).toBe("");
    expect(steer.stdout).toContain("steer #1 → agent-a1 (implementer): delivered");
    const claim = await runCli(["claim", WAVE], as("coord-b"));
    expect(claim.stdout).toContain(`claimed wave ${WAVE} for coord-b (was coord-a)`);
    const stop = await runCli(["stop", WAVE], as("coord-b"));
    expect(stop.stdout).toBe(`stopped wave ${WAVE}; cancel sent to 1 agent(s): agent-a1\n`);
    const all = await runCli(["stop", "--all"], env());
    expect(all.stdout).toContain("kill switch engaged");
    expect((await runCli(["status"], env())).stdout).toContain("KILL SWITCH ENGAGED");
    expect((await runCli(["resume", "--all"], env())).stdout).toContain("kill switch released");
    expect((await runCli(["pause"], env())).exitCode).toBe(2);
  });
});
