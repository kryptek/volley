import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { ControlClient } from "../src/control";
import type { Daemon } from "../src/daemon";
import {
  type DecisionRecord,
  MACHINE_DOWN_OPTIONS,
  decisionPayload,
  decisionTopic,
  describeDecision,
  machineDownInput,
  renderDecisionsMd,
  waveDecisionId,
} from "../src/decisions";
import { ready } from "../src/scheduler";
import { type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { schemaErrors } from "./helpers/schema";

const WAVE = "w-decide";
// B → C is the critical path, so with hard_ceiling 1 only B is admitted and A stays ready.
const WAVE_YAML = `wave: ${WAVE}
repo: example-org/example-repo
release_branch: release/${WAVE}
model: claude-opus-5-5
pipeline: [implement, merge_ready]
config: { hard_ceiling: 1 }
tasks:
  A: { issue: 1 }
  B: { issue: 2 }
  C: { issue: 3, after: [B] }
`;

let t: DaemonEnv;
let daemon: Daemon;
let client: ControlClient;

beforeEach(async () => {
  t = await makeDaemonEnv();
  daemon = await t.start();
  client = await ControlClient.connect(t.broker.url, NS);
  const res = await client.request("run", { wave_yaml: WAVE_YAML, owner: "coord-a" });
  expect(res.error).toBeUndefined();
  await daemon.recordEvent(WAVE, {
    type: "stage_entered",
    task: "B",
    data: { stage: "implement" },
  });
});
afterEach(async () => {
  await client.close();
  await t.cleanup();
});

const task = (id: string) => daemon.snapshot(WAVE)?.tasks.find((x) => x.id === id);

async function openOnB() {
  return daemon.openDecision(WAVE, {
    kind: "agent_blocked",
    task: "B",
    question: "Use the v2 API or keep v1?",
    options: ["v2", "v1"],
    pointers: { transcript: "/tmp/transcript.jsonl" },
  });
}

describe("decision lifecycle", () => {
  it("open: retained decision, task awaiting_decision, dependents parked, independents still ready", async () => {
    const d = await openOnB();
    expect(d.decision_id).toMatch(/^d-[a-z0-9]+$/);

    const retained = await t.retained(decisionTopic(WAVE, d.decision_id));
    expect(schemaErrors("decision.schema.json", retained)).toEqual([]);
    expect((retained as { type: string }).type).toBe("decision_opened");
    expect((retained as { payload: { question: string } }).payload.question).toBe(
      "Use the v2 API or keep v1?",
    );

    expect(task("B")?.stage).toBe("awaiting_decision");
    expect(task("B")?.why_waiting).toBe(`awaiting decision ${d.decision_id}`);
    expect(task("C")?.waiting_on).toEqual(["B"]);
    expect(task("C")?.why_waiting).toBe(`awaiting decision ${d.decision_id} (B)`);
    expect(task("A")?.stage).toBe("queued");
    expect(task("A")?.why_waiting ?? "").not.toContain("decision");

    const rec = daemon.record(WAVE);
    expect(rec?.state?.open_decisions).toEqual([d.decision_id]);
    expect(rec !== undefined && ready(rec)).toEqual(["A"]);
  });

  it("open fires a volley-notify-compatible attention event on the daemon's progress topic", async () => {
    const sub = new VolleyBroker();
    await sub.connect({ url: t.broker.url, agentId: "test-notify" });
    let first!: (m: { payload: string }) => void;
    const got = new Promise<{ payload: string }>((r) => {
      first = r;
    });
    // Subscribed (SUBACKed) before the decision is opened, so its event cannot be missed.
    const unsub = await sub.subscribeStream(`volley/${NS}/volleyd/progress`, (m) => first(m));
    const d = await openOnB();
    const msg = await got;
    await unsub();
    await sub.disconnect();
    const env = JSON.parse(msg?.payload ?? "{}");
    // `blocked` is in `volley notify`'s default --on set, so existing watchers ring on it.
    expect(env.type).toBe("blocked");
    expect(env.payload.attention).toBe("decision_opened");
    expect(env.payload.decision_id).toBe(d.decision_id);
    expect(env.payload.msg).toContain("Use the v2 API or keep v1?");
    expect(schemaErrors("progress.schema.json", env)).toEqual([]);
  });

  it("refuses a task-level decision on a settled task", async () => {
    await daemon.recordEvent(WAVE, { type: "stage_entered", task: "B", data: { stage: "done" } });
    await expect(openOnB()).rejects.toThrow(
      "task 'B' is done; open a wave-level decision (task: null) instead",
    );
    expect(task("B")?.stage).toBe("done");
    expect(task("C")?.why_waiting ?? "").not.toContain("decision");
    // A wave-level decision is still fine.
    const d = await daemon.openDecision(WAVE, {
      kind: "plan_change",
      task: null,
      question: "Add a task D?",
      pointers: {},
    });
    expect(daemon.snapshot(WAVE)?.open_decisions).toEqual([d.decision_id]);
  });

  it("a blocked agent on a settled task: an agent_blocked that does not park it is allowed", async () => {
    await daemon.recordEvent(WAVE, {
      type: "stage_entered",
      task: "B",
      data: { stage: "merge_ready" },
    });
    const d = await daemon.openDecision(WAVE, {
      kind: "agent_blocked",
      task: "B",
      question: "B's agent is blocked after merge_ready: manual or cancel?",
      options: ["manual", "cancel"],
      park: false,
    });
    expect(d.task).toBe("B");
    expect(task("B")?.stage).toBe("merge_ready");
    expect(task("C")?.why_waiting ?? "").not.toContain("decision");
    // Any other kind, or one that would park, is still refused.
    await expect(
      daemon.openDecision(WAVE, { kind: "plan_change", task: "B", question: "x?", park: false }),
    ).rejects.toThrow("task 'B' is merge_ready");
    await expect(openOnB()).rejects.toThrow("task 'B' is merge_ready");
  });

  it("a stage event while parked keeps the task parked and moves where it resumes", async () => {
    const d = await openOnB();
    await daemon.recordEvent(WAVE, {
      type: "stage_entered",
      task: "B",
      data: { stage: "spec_review" },
    });
    expect(task("B")?.stage).toBe("awaiting_decision");
    expect(task("C")?.why_waiting).toBe(`awaiting decision ${d.decision_id} (B)`);
    await client.request("resolve", { decision_id: d.decision_id, answer: "v2", by: "coord-a" });
    expect(task("B")?.stage).toBe("spec_review");
  });

  it("two open decisions on one task: only the last resolve restores the stage", async () => {
    const d1 = await openOnB();
    const d2 = await daemon.openDecision(WAVE, {
      kind: "plan_change",
      task: "B",
      question: "Split B?",
      pointers: {},
    });
    expect(task("B")?.why_waiting).toBe(`awaiting decision ${d1.decision_id}, ${d2.decision_id}`);
    await client.request("resolve", { decision_id: d1.decision_id, answer: "v2", by: "coord-a" });
    expect(task("B")?.stage).toBe("awaiting_decision");
    expect(task("B")?.why_waiting).toBe(`awaiting decision ${d2.decision_id}`);
    await client.request("resolve", { decision_id: d2.decision_id, answer: "no", by: "coord-a" });
    expect(task("B")?.stage).toBe("implement");
  });

  it("a failed brief write does not fail a resolve that is already journaled", async () => {
    await daemon.stop();
    const blocker = join(t.home, "not-a-dir");
    writeFileSync(blocker, "");
    daemon = await t.start({ taskDir: () => join(blocker, "task") });
    const d = await openOnB();
    const res = await client.request("resolve", {
      decision_id: d.decision_id,
      answer: "v2",
      by: "coord-a",
    });
    expect(res.error).toBeUndefined();
    expect(res.result).toMatchObject({ already_resolved: false });
    expect(res.result).not.toHaveProperty("brief");
    expect(task("B")?.stage).toBe("implement");
  });

  it("a restart clears the retained topic of a decision resolved just before a crash", async () => {
    const d = await openOnB();
    const topic = decisionTopic(WAVE, d.decision_id);
    const stale = JSON.stringify(await t.retained(topic));
    await client.request("resolve", { decision_id: d.decision_id, answer: "v2", by: "coord-a" });
    // The crash came between journaling the resolution and clearing the retained topic.
    const pub = new VolleyBroker();
    await pub.connect({ url: t.broker.url, agentId: "test-pub" });
    await pub.publish(topic, stale, { qos: 1, retain: true });
    await pub.disconnect();
    expect(await t.retained(topic)).not.toBeNull();
    await daemon.stop();
    daemon = await t.start();
    expect(await t.retained(topic)).toBeNull();
  });

  it("resolve: retained cleared, decision_resolved journaled with by + answer, task resumes, brief written", async () => {
    const d = await openOnB();
    const res = await client.request("resolve", {
      wave: WAVE,
      decision_id: d.decision_id,
      answer: "v2",
      rationale: "v1 is deprecated",
      by: "coord-a",
    });
    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);

    expect(await t.retained(decisionTopic(WAVE, d.decision_id))).toBeNull();
    const ev = daemon.record(WAVE)?.state?.open_decisions.includes(d.decision_id);
    expect(ev).toBe(false);
    const journal = readFileSync(join(t.home, "waves", WAVE, "journal.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const resolved = journal.find((e) => e.type === "decision_resolved");
    expect(resolved).toMatchObject({
      task: "B",
      data: {
        decision_id: d.decision_id,
        answer: "v2",
        by: "coord-a",
        rationale: "v1 is deprecated",
      },
    });

    expect(task("B")?.stage).toBe("implement");
    expect(task("C")?.why_waiting).toBe("after: B");

    const brief = join(t.home, "waves", WAVE, "tasks", "B", ".volley", "decisions.md");
    expect(existsSync(brief)).toBe(true);
    const md = readFileSync(brief, "utf-8");
    expect(md).toContain("Use the v2 API or keep v1?");
    expect(md).toContain("v2");
    expect(md).toContain("v1 is deprecated");
  });

  it("resolve of an unknown id is an error", async () => {
    const res = await client.request("resolve", {
      wave: WAVE,
      decision_id: "d-nope",
      answer: "x",
      by: "coord-a",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("unknown decision 'd-nope'");
  });

  it("resolve twice is an idempotent no-op", async () => {
    const d = await openOnB();
    const body = { decision_id: d.decision_id, answer: "v2", by: "coord-a" };
    expect((await client.request("resolve", body)).ok).toBe(true);
    const seq = daemon.record(WAVE)?.seq;
    const again = await client.request("resolve", { ...body, answer: "v1" });
    expect(again.ok).toBe(true);
    expect((again.result as { already_resolved: boolean }).already_resolved).toBe(true);
    expect(daemon.record(WAVE)?.seq).toBe(seq);
    expect(daemon.record(WAVE)?.decisions[d.decision_id]?.resolved?.answer).toBe("v2");
  });

  it("decisions op lists open decisions; a restart keeps them open", async () => {
    const d = await openOnB();
    const list = await client.request("decisions", { wave: WAVE });
    expect(
      (list.result as { decisions: { decision_id: string }[] }).decisions.map((x) => x.decision_id),
    ).toEqual([d.decision_id]);
    await daemon.stop();
    const again = await t.start();
    expect(again.snapshot(WAVE)?.open_decisions).toEqual([d.decision_id]);
    expect(again.snapshot(WAVE)?.tasks.find((x) => x.id === "B")?.stage).toBe("awaiting_decision");
  });

  it("starts when a wave's journal tail is a snapshot written before decisions existed", async () => {
    await daemon.stop();
    const fixtures = new URL("./fixtures/", import.meta.url);
    const dir = join(t.home, "waves", "2026-10-20-example");
    mkdirSync(dir, { recursive: true });
    const lines = readFileSync(new URL("journal.jsonl", fixtures), "utf-8").trim().split("\n");
    writeFileSync(join(dir, "journal.jsonl"), `${lines.slice(0, 11).join("\n")}\n`);
    copyFileSync(new URL("snapshot-pre-t7.json", fixtures), join(dir, "snapshot.json"));

    const again = await t.start();
    expect(again.record("2026-10-20-example")?.decisions).toEqual({});
    const list = await client.request("decisions", { wave: "2026-10-20-example", all: true });
    expect(list.error).toBeUndefined();
    expect((list.result as { decisions: unknown[] }).decisions).toEqual([]);
  });
});

describe("waveDecisionId", () => {
  it("is deterministic, and unique per wave and per key", () => {
    // Deterministic: a restart finds the same id. Per wave: `volleyd resolve <id>` without --wave
    // answers the first wave that has the id, so no two waves may share one.
    const a = waveDecisionId("wave_complete", "w1");
    expect(a).toMatch(/^wave_complete-[0-9a-f]{12}$/);
    expect(waveDecisionId("wave_complete", "w1")).toBe(a);
    expect(waveDecisionId("wave_complete", "w2")).not.toBe(a);
    const k = waveDecisionId("remote_repo_missing", "w1", "dev@box:/repo");
    expect(waveDecisionId("remote_repo_missing", "w2", "dev@box:/repo")).not.toBe(k);
    expect(waveDecisionId("remote_repo_missing", "w1", "dev@box:/other")).not.toBe(k);
    // the parts are joined unambiguously: (w1, "a/b") is not (w1/a, "b")
    expect(waveDecisionId("spawn_failed", "w1", "a/b")).not.toBe(
      waveDecisionId("spawn_failed", "w1/a", "b"),
    );
  });
});

describe("decisionPayload", () => {
  it("publishes the decision.schema.json fields only, never the daemon's bookkeeping", () => {
    const rec = {
      decision_id: "remote_repo_missing-abc",
      wave: "w1",
      task: "T1",
      kind: "remote_repo_missing" as const,
      question: "Clone it?",
      options: ["retry", "cancel"],
      pointers: {},
      opened_at: "2026-10-18T10:00:00.000Z",
      host: "box",
      target: "dev@box",
      repo: "/srv/repo",
      // internal facts kept on the record
      agent_id: "w1-t1-implementer-1",
      class: "agent_stalled",
      role: "implementer",
      pipeline: { stage: "fixup" },
      resume_stage: "queued" as const,
      parks: true,
      rationale: "x",
    };
    const p = decisionPayload(rec);
    expect(Object.keys(p).sort()).toEqual(
      [
        "decision_id",
        "host",
        "kind",
        "opened_at",
        "options",
        "pointers",
        "question",
        "repo",
        "target",
        "task",
        "wave",
      ].sort(),
    );
    expect(
      schemaErrors("decision.schema.json", {
        schema_version: "0.1",
        agent_id: "volleyd",
        parent_id: null,
        wall_time: "2026-10-18T10:00:00.000Z",
        channel: "_waves/decisions",
        type: "decision_opened",
        payload: p,
        correlation_id: null,
      }),
    ).toEqual([]);
  });
});

describe("machine_down (SPEC §4.6.15: a machine that stays down)", () => {
  const DOWN = Date.parse("2026-10-19T10:00:00.000Z");
  const facts = {
    host: "box-a",
    downSince: DOWN,
    now: DOWN + 5 * 60_000,
    why: "no heartbeat for 90 s",
    queued: ["T3", "T4"],
    running: ["T1"],
    best: "studio",
  };
  const asRecord = (f = facts): DecisionRecord => {
    const { input, data } = machineDownInput(f);
    return {
      ...data,
      decision_id: input.id ?? "machine_down-box-a",
      wave: "w1",
      task: input.task,
      kind: input.kind,
      question: input.question,
      ...(input.options !== undefined ? { options: input.options } : {}),
      pointers: {},
      opened_at: new Date(f.now).toISOString(),
    } as DecisionRecord;
  };
  const env = (payload: unknown) => ({
    schema_version: "0.1",
    agent_id: "volleyd",
    parent_id: null,
    wall_time: "2026-10-19T10:05:00.000Z",
    channel: "_waves/decisions",
    type: "decision_opened",
    payload,
    correlation_id: null,
  });

  it("is wave-level, carries host, down_since and every unfinished task, and validates", () => {
    const { input, data } = machineDownInput(facts);
    expect(input).toMatchObject({ kind: "machine_down", task: null });
    expect(input.options).toEqual(["wait", "re-place queued tasks", "cancel"]);
    expect(MACHINE_DOWN_OPTIONS).toEqual(input.options);
    expect(data).toEqual({
      host: "box-a",
      down_since: "2026-10-19T10:00:00.000Z",
      tasks: ["T1", "T3", "T4"],
      machine: "down",
    });
    const p = decisionPayload(asRecord());
    expect(p).toMatchObject({ host: "box-a", down_since: data.down_since, tasks: data.tasks });
    expect(schemaErrors("decision.schema.json", env(p))).toEqual([]);
    // Without its facts the schema refuses it.
    const { tasks: _t, ...bare } = p as unknown as Record<string, unknown>;
    expect(schemaErrors("decision.schema.json", env(bare))).not.toEqual([]);
  });

  it("says what happened, what each option does and what happens if nobody answers", () => {
    const q = machineDownInput(facts).input.question;
    expect(q).toBe(
      "box-a has been down 5 min (no heartbeat for 90 s). 2 tasks placed there have no agent running (queued, or waiting for their next role): T3 and T4. T1 is running there and is left alone: a running agent is never moved. " +
        "wait: keep them parked until box-a is back; this is what happens if nobody answers, and this question closes itself when box-a returns. " +
        "re-place queued tasks: place T3 and T4 again without box-a (best now for T3: studio). " +
        "cancel: cancel T1, T3 and T4 (T1's running agent is told to stop).",
    );
    expect(describeDecision(decisionPayload(asRecord()))).toBe(
      `decision machine_down-box-a (machine_down) on w1: ${q}`,
    );
  });

  it("one queued task, none running, and nowhere to re-place it yet", () => {
    const q = machineDownInput({ ...facts, queued: ["T3"], running: [], best: null }).input
      .question;
    expect(q).toContain(
      "1 task placed there has no agent running (queued, or waiting for its next role): T3.",
    );
    expect(q).not.toContain("running there");
    expect(q).toContain(
      "re-place queued tasks: place T3 again without box-a (no other machine is eligible now: it waits for one and is placed as soon as one is).",
    );
    expect(q).toContain("cancel: cancel T3.");
  });

  it("only running tasks: nothing to re-place, said plainly", () => {
    const q = machineDownInput({ ...facts, queued: [], running: ["T1", "T2"] }).input.question;
    expect(q).toContain(
      "No task placed there is waiting for an agent. T1 and T2 are running there",
    );
    expect(q).toContain("re-place queued tasks: nothing is waiting there now.");
    expect(q).toContain(
      "cancel: cancel T1 and T2 (the running agents of T1 and T2 are told to stop).",
    );
  });

  it("a draining machine: nothing new starts there; wait holds until its drain is lifted", () => {
    const { input, data } = machineDownInput({
      ...facts,
      machine: "draining",
      why: "",
      queued: ["T3"],
      running: ["T1"],
    });
    expect(input.options).toEqual(["wait", "re-place queued tasks", "cancel"]);
    expect(data.machine).toBe("draining");
    expect(input.question).toBe(
      "box-a is draining: nothing new starts there. 1 task placed there has no agent running (queued, or waiting for its next role): T3. T1 is running there and is left alone: a running agent is never moved. " +
        "wait: keep them parked until box-a takes new agents again (hosts.box-a.drain set back to false); this is what happens if nobody answers. " +
        "re-place queued tasks: place T3 again without box-a (best now for T3: studio). " +
        "cancel: cancel T1 and T3 (T1's running agent is told to stop).",
    );
  });

  it("a machine being removed, or removed, offers no wait: nothing starts there again", () => {
    for (const machine of ["removing", "removed"] as const) {
      const { input, data } = machineDownInput({
        ...facts,
        machine,
        why: "",
        queued: ["T3"],
        running: [],
      });
      expect(input.options).toEqual(["re-place queued tasks", "cancel"]);
      expect(input.question).toContain(
        "If nobody answers they stay parked: nothing starts on box-a again.",
      );
      expect(input.question).not.toContain("wait:");
      const p = decisionPayload({ ...asRecord(), ...data, options: input.options ?? [] });
      expect(p.machine).toBe(machine);
      expect(schemaErrors("decision.schema.json", env(p))).toEqual([]);
    }
    expect(machineDownInput({ ...facts, machine: "removed", why: "" }).input.question).toMatch(
      /^box-a was removed\. /,
    );
    expect(machineDownInput({ ...facts, machine: "removing", why: "" }).input.question).toMatch(
      /^box-a is being removed: nothing new starts there, and the removal finishes once no agent runs there\. /,
    );
  });
});

describe("renderDecisionsMd", () => {
  it("renders every resolved decision for the task, newest last", () => {
    const md = renderDecisionsMd("w", "T1", [
      {
        decision_id: "d-1",
        wave: "w",
        task: "T1",
        kind: "plan_change",
        question: "Split the PR?",
        pointers: {},
        opened_at: "2026-10-18T10:00:00.000Z",
        resolved: { answer: "yes", by: "coord", at: "2026-10-18T10:05:00.000Z" },
      },
    ]);
    expect(md).toContain("# Decisions for w / T1");
    expect(md).toContain("## d-1 — plan_change");
    expect(md).toContain("**Q:** Split the PR?");
    expect(md).toContain("**A:** yes");
  });
});
