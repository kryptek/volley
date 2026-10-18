import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FEED_LIMIT,
  UNASSIGNED,
  agentsByWave,
  initialState,
  reduce,
  reduceAll,
} from "../src/store/reducer";
import type { DeskMessage, DeskState, Envelope } from "../src/store/types";

const EXAMPLES = path.resolve(__dirname, "../../../spec/examples/valid");

function example(name: string): Envelope {
  return JSON.parse(readFileSync(path.join(EXAMPLES, `${name}.json`), "utf8")) as Envelope;
}

function msg(topic: string, envelope: Envelope | null, receivedAt = 1_000): DeskMessage {
  return { topic, envelope, receivedAt };
}

const WAVE = msg("volley/_waves/w1/state", example("wave-state-running"));

function registryFor(agentId: string, receivedAt = 1_000): DeskMessage {
  const base = example("registry-coordinator");
  return msg(
    `volley/_system/registry/${agentId}`,
    { ...base, agent_id: agentId, namespace: "default" },
    receivedAt,
  );
}

function progress(agentId: string, type: string, payload: Record<string, unknown>): DeskMessage {
  return msg(`volley/default/${agentId}/progress`, {
    schema_version: "0.1",
    agent_id: agentId,
    wall_time: "2026-10-18T14:00:00.000Z",
    channel: "progress",
    type,
    payload,
  });
}

function apply(...msgs: DeskMessage[]): DeskState {
  return reduceAll(initialState(), msgs);
}

describe("reducer — wave state", () => {
  it("stores the wave snapshot including spec and coordinator", () => {
    const s = apply(WAVE);
    expect(Object.keys(s.waves)).toEqual(["w1"]);
    const w = s.waves.w1;
    expect(w?.state?.spec?.tasks.T1?.title).toBe("SPEC + schemas");
    expect(w?.state?.spec?.pipeline).toEqual([
      "implement",
      ["spec_review", "quality_review"],
      "fixup",
      "merge_ready",
    ]);
    expect(w?.state?.coordinator?.agent_id).toBe("coordinator-ab12");
    expect(w?.state?.tasks.map((t) => t.stage)).toEqual(["spec_review", "queued", "merge_ready"]);
    expect(w?.state?.gates).toEqual(["T3"]);
  });

  it("derives the owner coordinator from the wave", () => {
    const s = apply(WAVE);
    expect(s.coordinators["coordinator-ab12"]).toMatchObject({
      id: "coordinator-ab12",
      waves: ["w1"],
      state: "working",
    });
  });

  it("assigns registered agents to their wave, task and role", () => {
    const s = apply(WAVE, registryFor("w1-t1-spec_reviewer-1", 5_000));
    expect(s.agents["w1-t1-spec_reviewer-1"]).toMatchObject({
      wave: "w1",
      task: "T1",
      role: "spec_reviewer",
      model: "claude-opus-4-7",
      bornAt: 5_000,
    });
  });

  it("assigns an agent that registered before its wave state arrived", () => {
    const s = apply(registryFor("w1-t3-implementer-1"), WAVE);
    expect(s.agents["w1-t3-implementer-1"]).toMatchObject({ wave: "w1", task: "T3" });
  });

  it("keeps a retired agent in its wave when the task moves on to a new agent", () => {
    const next = example("wave-state-running");
    const payload = next.payload as { tasks: { agents: Record<string, string> }[] };
    payload.tasks[0] = { ...payload.tasks[0], agents: { implementer: "w1-t1-implementer-2" } };
    const s = apply(
      WAVE,
      registryFor("w1-t1-spec_reviewer-1"),
      msg("volley/_waves/w1/state", next),
    );
    expect(s.agents["w1-t1-spec_reviewer-1"]?.wave).toBe("w1");
  });

  it("removes a wave whose retained state is cleared and un-assigns its agents", () => {
    const s = apply(WAVE, registryFor("w1-t1-implementer-1"), msg("volley/_waves/w1/state", null));
    expect(s.waves.w1).toBeUndefined();
    expect(s.agents["w1-t1-implementer-1"]?.wave).toBe(UNASSIGNED);
    expect(s.coordinators["coordinator-ab12"]).toBeUndefined();
  });

  it("tracks open decisions per wave and drops them when cleared", () => {
    const topic = "volley/_waves/w1/decisions/w1-t2-merge_conflict-1";
    const opened = apply(WAVE, msg(topic, example("decision-merge-conflict")));
    expect(opened.waves.w1?.decisions["w1-t2-merge_conflict-1"]?.kind).toBe("merge_conflict");
    const cleared = reduce(opened, msg(topic, null));
    expect(cleared.waves.w1?.decisions).toEqual({});
  });
});

describe("reducer — agent channels", () => {
  const ID = "w1-t1-implementer-1";

  it("records registry, status, narration, progress and heartbeat", () => {
    const status = example("status-working");
    const s = apply(
      WAVE,
      registryFor(ID),
      msg(`volley/default/${ID}/status`, { ...status, agent_id: ID }),
      progress(ID, "narration", { progress: 40, msg: "RED test written" }),
      msg(`volley/default/${ID}/progress`, example("progress-heartbeat")),
    );
    const a = s.agents[ID];
    expect(a?.registered).toBe(true);
    expect(a?.status?.type).toBe("working");
    expect(a?.narration).toBe("RED test written");
    expect(a?.progress).toBe(40);
    expect(a?.heartbeat).toBe(Date.parse("2026-10-18T14:05:00.000Z"));
    expect(a?.feed.map((f) => f.envelope.type)).toEqual([
      "registered",
      "working",
      "narration",
      "heartbeat",
    ]);
  });

  it("keeps the narration when a progress message carries no msg", () => {
    const s = apply(
      progress(ID, "narration", { progress: 10, msg: "first" }),
      progress(ID, "tests-green", { detail: "61/61" }),
    );
    expect(s.agents[ID]?.narration).toBe("first");
    expect(s.agents[ID]?.progress).toBe(10);
  });

  it("stores the screen tail keyed by the topic's agent, outside the feed", () => {
    const s = apply(
      registryFor(ID),
      msg(`volley/default/${ID}/screen`, example("screen-agent-tail")),
    );
    expect(s.agents[ID]?.screen?.lines).toEqual([
      "> bun run test",
      " ✓ test/config.test.ts (19 tests)",
      " Test Files  1 passed (1)",
    ]);
    expect(s.agents[ID]?.feed.map((f) => f.envelope.channel)).toEqual(["_system/registry"]);
  });

  it("files mailbox messages under the recipient named by the topic", () => {
    const s = apply(msg(`volley/default/${ID}/mailbox`, example("mailbox-steering")));
    expect(s.agents[ID]?.feed[0]?.envelope.type).toBe("steering");
    expect(s.agents["coordinator-abcd"]).toBeUndefined();
  });

  it("keeps the last 200 envelopes per agent", () => {
    const msgs = Array.from({ length: FEED_LIMIT + 50 }, (_, i) =>
      progress(ID, "narration", { progress: i % 100, msg: `step ${i}` }),
    );
    const s = apply(...msgs);
    expect(FEED_LIMIT).toBe(200);
    expect(s.agents[ID]?.feed).toHaveLength(200);
    expect(s.agents[ID]?.feed[0]?.envelope.payload).toMatchObject({ msg: "step 50" });
    expect(s.agents[ID]?.narration).toBe(`step ${FEED_LIMIT + 49}`);
  });

  it("removes an agent whose registry entry is cleared", () => {
    const s = apply(registryFor(ID), msg(`volley/_system/registry/${ID}`, null));
    expect(s.agents[ID]).toBeUndefined();
  });

  it("puts an agent no wave references in the unassigned pseudo-wave", () => {
    const s = apply(
      WAVE,
      msg("volley/example-dispatch/issue-42-fix-7a3f/status", example("status-working")),
    );
    expect(s.agents["issue-42-fix-7a3f"]?.wave).toBe(UNASSIGNED);
    const groups = agentsByWave(s);
    expect(groups[UNASSIGNED]?.map((a) => a.id)).toEqual(["issue-42-fix-7a3f"]);
    expect(groups.w1).toEqual([]);
  });

  it("does not list a wave's coordinator as an unassigned agent", () => {
    const s = apply(WAVE, registryFor("coordinator-ab12"));
    expect(agentsByWave(s)[UNASSIGNED]).toEqual([]);
  });
});

describe("reducer — coordinator attention", () => {
  it("awaiting_input raises the question and resumed clears it", () => {
    const waiting = apply(
      WAVE,
      msg("volley/default/coordinator-ab12/progress", example("progress-awaiting-input")),
    );
    expect(waiting.coordinators["coordinator-ab12"]).toMatchObject({
      state: "awaiting_input",
      question: "Merge T3 into the release branch now?",
      sessionUrl: "https://claude.ai/code/session-example",
      workspace: "coordinator",
    });
    const resumed = reduce(waiting, progress("coordinator-ab12", "resumed", { seq: 109 }));
    expect(resumed.coordinators["coordinator-ab12"]?.state).toBe("working");
    expect(resumed.coordinators["coordinator-ab12"]?.question).toBeUndefined();
  });

  it("falls back to the supervisor's view when the owner has not been observed", () => {
    const next = example("wave-state-running");
    const payload = next.payload as Record<string, unknown>;
    payload.coordinator = {
      agent_id: "coordinator-ab12",
      state: "awaiting_input",
      question: "Hold T2?",
      last_seen: "2026-10-18T14:02:00.000Z",
    };
    const s = apply(msg("volley/_waves/w1/state", next));
    expect(s.coordinators["coordinator-ab12"]).toMatchObject({
      state: "awaiting_input",
      question: "Hold T2?",
    });
  });

  it("marks the coordinator gone after a terminal status", () => {
    const done = example("status-done");
    const s = apply(
      WAVE,
      msg("volley/default/coordinator-ab12/status", { ...done, agent_id: "coordinator-ab12" }),
    );
    expect(s.coordinators["coordinator-ab12"]?.state).toBe("gone");
  });
});

describe("reducer — machine-global topics", () => {
  it("stores config, lease pools and the admission summary", () => {
    const s = apply(
      msg("volley/_waves/_config", example("config-effective")),
      msg("volley/_system/leases/backend-it", example("lease-pool-backend-it")),
      msg("volley/_system/admission", {
        schema_version: "0.1",
        agent_id: "volleyd",
        channel: "_system/admission",
        type: "admission",
        payload: { open: false, reasons: ["memory pressure 3 > 2"] },
      }),
    );
    expect(s.config?.hard_ceiling).toBe(12);
    expect(s.config?.lease_pools?.build?.capacity).toBe(2);
    expect(s.leases["backend-it"]?.held).toHaveLength(3);
    expect(s.leases["backend-it"]?.reasons).toEqual(["queued: 3/3 backend-it leases held"]);
    expect(s.admission).toEqual({ open: false, reasons: ["memory pressure 3 > 2"] });
  });

  it("ignores topics outside the Desk's grammar", () => {
    const before = apply(WAVE);
    const after = reduce(before, msg("volley/_meta/tap/x", example("status-working")));
    expect(after).toBe(before);
  });
});
