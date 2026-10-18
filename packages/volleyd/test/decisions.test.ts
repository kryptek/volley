import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { ControlClient } from "../src/control";
import type { Daemon } from "../src/daemon";
import { decisionTopic, renderDecisionsMd } from "../src/decisions";
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
    const got = sub.subscribeCollect(`volley/${NS}/volleyd/progress`, 1, 3000);
    await new Promise((r) => setTimeout(r, 100));
    const d = await openOnB();
    const [msg] = await got;
    await sub.disconnect();
    const env = JSON.parse(msg?.payload ?? "{}");
    // `blocked` is in `volley notify`'s default --on set, so existing watchers ring on it.
    expect(env.type).toBe("blocked");
    expect(env.payload.attention).toBe("decision_opened");
    expect(env.payload.decision_id).toBe(d.decision_id);
    expect(env.payload.msg).toContain("Use the v2 API or keep v1?");
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
