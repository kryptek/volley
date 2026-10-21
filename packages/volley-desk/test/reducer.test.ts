import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FEED_LIMIT,
  UNASSIGNED,
  agentsByWave,
  endedWaves,
  finishedAgents,
  initialState,
  pruneUnconfirmed,
  reduce,
  reduceAll,
  resync,
  routeTopic,
} from "../src/store/reducer";
import { type DeskMessage, type DeskState, type Envelope, ROLES } from "../src/store/types";
import {
  archiveMsg,
  machineMsg,
  machineRecord,
  readiness,
  readinessMsg,
} from "./helpers/desk-msgs";

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

  it("knows every pipeline role the wave-state schema has, including rebase (P2-8)", () => {
    const schema = JSON.parse(
      readFileSync(path.resolve(__dirname, "../../../spec/schemas/wave-state.schema.json"), "utf8"),
    ) as { $defs: { task: { properties: { agents: { properties: Record<string, unknown> } } } } };
    expect([...ROLES].sort()).toEqual(
      Object.keys(schema.$defs.task.properties.agents.properties).sort(),
    );
    const wave = example("wave-state-running");
    const payload = wave.payload as { tasks: { id: string; agents: Record<string, string> }[] };
    const t1 = payload.tasks.find((t) => t.id === "T1");
    if (!t1) throw new Error("fixture lost T1");
    t1.agents.rebase = "w1-t1-rebase-1";
    const s = apply(msg("volley/_waves/w1/state", wave), registryFor("w1-t1-rebase-1"));
    expect(s.agents["w1-t1-rebase-1"]).toMatchObject({ wave: "w1", task: "T1", role: "rebase" });
    expect(agentsByWave(s).w1?.map((a) => a.id)).toContain("w1-t1-rebase-1");
  });

  it("lists agents that finished (done, failed, reaped) longer ago than the grace", () => {
    const status = (id: string, type: string, at: number) =>
      msg(
        `volley/default/${id}/status`,
        {
          schema_version: "0.1",
          agent_id: id,
          channel: "status",
          type,
          wall_time: new Date(at).toISOString(),
          payload: {},
        },
        at,
      );
    const now = Date.parse("2026-10-18T14:00:00.000Z");
    const MIN = 60_000;
    const s = apply(
      status("old-done", "done", now - 11 * MIN),
      status("old-failed", "failed", now - 30 * MIN),
      status("old-reaped", "reaped", now - 60 * MIN),
      status("fresh-done", "done", now - 2 * MIN),
      status("old-blocked", "blocked", now - 60 * MIN),
      status("working", "working", now - 60 * MIN),
    );
    expect([...finishedAgents(s, now, 10 * MIN)].sort()).toEqual([
      "old-done",
      "old-failed",
      "old-reaped",
    ]);
    expect(finishedAgents(s, now, 0).has("fresh-done")).toBe(true);
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
    // A live heartbeat is timed by local receipt, not the sender's clock (SPEC §3.1).
    expect(a?.heartbeat).toBe(1_000);
    // Heartbeats are liveness only: counted, never a feed row.
    expect(a?.heartbeats).toBe(1);
    expect(a?.feed.map((f) => f.envelope.type)).toEqual(["registered", "working", "narration"]);
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

  it("a wave the Desk claimed has this Desk as its working coordinator (P2-11)", () => {
    const wave = example("wave-state-running");
    const claimed = msg("volley/_waves/w1/state", {
      ...wave,
      payload: { ...(wave.payload as object), owner: "desk" },
    });
    const s = reduceAll({ ...initialState(), self: "desk" }, [claimed]);
    expect(s.coordinators.desk).toMatchObject({ state: "working", waves: ["w1"] });
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

const retained = (m: DeskMessage): DeskMessage => ({ ...m, retained: true });

describe("reducer — retained replay", () => {
  const ID = "w1-t1-implementer-1";
  const STARTED = Date.parse("2026-05-14T01:38:00.000Z");
  const NOW = Date.parse("2026-10-18T15:00:00.000Z");

  it("a retained registry entry is not a birth; its times come from the envelope", () => {
    const s = apply(retained(registryFor(ID, NOW)));
    expect(s.agents[ID]?.bornAt).toBe(STARTED);
    expect(s.agents[ID]?.lastSeen).toBe(STARTED);
  });

  it("a live registry entry is born at receipt", () => {
    const s = apply(registryFor(ID, NOW));
    expect(s.agents[ID]?.bornAt).toBe(NOW);
    expect(s.agents[ID]?.lastSeen).toBe(NOW);
  });

  it("does not re-append or refresh on a retained delivery already in the feed", () => {
    const status = { ...example("status-working"), agent_id: ID };
    const first = apply(
      retained(registryFor(ID, NOW)),
      retained(msg(`volley/default/${ID}/status`, status, NOW)),
    );
    const again = reduceAll(first, [
      retained(registryFor(ID, NOW + 60_000)),
      retained(msg(`volley/default/${ID}/status`, status, NOW + 60_000)),
    ]);
    expect(again.agents[ID]?.feed.map((f) => f.envelope.type)).toEqual(["registered", "working"]);
    expect(again.agents[ID]?.lastSeen).toBe(first.agents[ID]?.lastSeen);
  });

  it("resync drops retained-derived state and keeps live-only parts", () => {
    const topic = "volley/_waves/w1/decisions/w1-t2-merge_conflict-1";
    const before = apply(
      WAVE,
      msg(topic, example("decision-merge-conflict")),
      msg("volley/_waves/_config", example("config-effective")),
      msg("volley/_system/leases/backend-it", example("lease-pool-backend-it")),
      registryFor(ID),
      msg(`volley/default/${ID}/status`, { ...example("status-working"), agent_id: ID }),
      progress(ID, "narration", { progress: 40, msg: "RED test written" }),
      msg(`volley/default/${ID}/progress`, example("progress-heartbeat"), 2_000),
      msg(`volley/default/${ID}/screen`, example("screen-agent-tail")),
    );
    const s = resync(before);
    expect(s.waves).toEqual({});
    expect(s.coordinators).toEqual({});
    expect(s.config).toBeNull();
    expect(s.leases).toEqual({});
    expect(s.admission).toBeNull();
    const a = s.agents[ID];
    expect(a).toMatchObject({ registered: false, registry: null, status: null, screen: null });
    expect(a).toMatchObject({ narration: "RED test written", progress: 40, heartbeat: 2_000 });
    expect(a?.feed).toEqual(before.agents[ID]?.feed);
    expect(s.unconfirmed).toEqual([ID]);

    // The replay rebuilds what is still retained; the cleared decision stays gone.
    const replayed = reduceAll(s, [
      retained(WAVE),
      retained(registryFor(ID, 9_000)),
      retained(msg(`volley/default/${ID}/status`, { ...example("status-working"), agent_id: ID })),
    ]);
    expect(replayed.waves.w1?.decisions).toEqual({});
    expect(replayed.agents[ID]).toMatchObject({ registered: true, wave: "w1", task: "T1" });
    expect(replayed.agents[ID]?.feed).toHaveLength(before.agents[ID]?.feed.length ?? -1);
    expect(replayed.unconfirmed).toEqual([]);
  });

  it("prunes agents whose registry entry did not come back after a resync", () => {
    const gone = "w1-t2-implementer-1";
    const s = reduceAll(resync(apply(registryFor(ID), registryFor(gone))), [
      retained(registryFor(ID)),
    ]);
    const pruned = pruneUnconfirmed(s);
    expect(Object.keys(pruned.agents)).toEqual([ID]);
    expect(pruned.unconfirmed).toBeUndefined();
  });
});

describe("reducer — review fixups", () => {
  const ID = "w1-t1-implementer-1";

  it("a screen envelope does not supply the agent's parent", () => {
    const tail = { ...example("screen-agent-tail"), parent_id: "volleyd-parent" };
    const s = apply(
      msg(`volley/default/${ID}/screen`, tail),
      msg(`volley/default/${ID}/progress`, example("progress-heartbeat")),
    );
    expect(s.agents[ID]?.parentId).toBe("coordinator-ab12");
  });

  it("sorts an agent whose task was dropped after the wave's current tasks", () => {
    const next = example("wave-state-running");
    const payload = next.payload as { tasks: { id: string }[] };
    const s0 = apply(
      WAVE,
      registryFor("w1-t1-spec_reviewer-1"),
      registryFor("w1-t3-implementer-1"),
    );
    payload.tasks = payload.tasks.filter((t) => t.id !== "T1");
    const s = reduce(s0, msg("volley/_waves/w1/state", next));
    expect(agentsByWave(s).w1?.map((a) => a.id)).toEqual([
      "w1-t3-implementer-1",
      "w1-t1-spec_reviewer-1",
    ]);
  });
});

describe("reducer — signs of life", () => {
  it("keeps the last progress envelope's type and time (any type), live only", () => {
    const s = apply(
      registryFor("impl-x"),
      progress("impl-x", "narration", { msg: "a" }),
      msg(
        "volley/default/impl-x/progress",
        {
          schema_version: "0.1",
          agent_id: "impl-x",
          channel: "progress",
          type: "idle",
          payload: { text: "turn ended" },
        },
        2_000,
      ),
    );
    expect(s.agents["impl-x"]?.lastProgress).toEqual({ type: "idle", at: 2_000 });
    expect(apply(registryFor("impl-y")).agents["impl-y"]?.lastProgress).toBeUndefined();
  });
});

describe("reducer — Fleet readiness (SPEC §4.6.15)", () => {
  it("routes a machine's readiness topic apart from its record", () => {
    expect(routeTopic("volley/_system/machines/box-a/readiness")).toEqual({
      kind: "readiness",
      name: "box-a",
    });
    expect(routeTopic("volley/_system/machines/box-a")).toEqual({ kind: "machine", name: "box-a" });
  });

  it("keeps volleyd's verdict by machine name and forgets a cleared one", () => {
    const s = apply(readinessMsg(readiness()), readinessMsg(readiness({ name: "box-b" })));
    expect(Object.keys(s.readiness ?? {})).toEqual(["box-a", "box-b"]);
    expect(s.readiness?.["box-a"]?.placed).toBe(2);
    const cleared = reduce(s, readinessMsg(null, "box-a"));
    expect(Object.keys(cleared.readiness ?? {})).toEqual(["box-b"]);
  });

  it("takes a verdict only from volleyd, and only for its topic's machine", () => {
    const s = apply(
      readinessMsg(readiness(), "box-a", "box-a"),
      readinessMsg(readiness({ name: "box-z" }), "box-a"),
    );
    expect(s.readiness ?? {}).toEqual({});
  });

  it("keeps the supervisor's own record (kind supervisor, tunnel local), published by volleyd", () => {
    const own = machineRecord({ name: "hub", kind: "supervisor", tunnel: "local" });
    const s = apply(machineMsg(own, "hub", "volleyd"));
    expect(s.machines?.hub).toEqual(own);
  });

  it("a resync forgets every verdict until the replay brings them back", () => {
    const s = resync(apply(readinessMsg(readiness())));
    expect(s.readiness).toEqual({});
  });
});

describe("reducer — archived waves (SPEC §4.6.20)", () => {
  const archived = () => {
    const e = example("wave-state-running");
    return msg("volley/_waves/w1/state", {
      ...e,
      payload: { ...(e.payload as object), status: "archived", open_decisions: [] },
    });
  };

  it("an archived state is an ended wave", () => {
    expect(endedWaves(apply(WAVE, archived()))).toEqual(new Set(["w1"]));
  });

  it("a cleared state drops the wave's agents whose records are gone; one with a record stays unassigned", () => {
    const kept = "w1-t1-implementer-1";
    const gone = "w1-t1-spec_reviewer-1";
    const s = apply(
      WAVE,
      registryFor(kept),
      registryFor(gone),
      msg(`volley/_system/registry/${gone}`, null),
      archived(),
      msg("volley/_waves/w1/state", null),
    );
    expect(s.waves.w1).toBeUndefined();
    expect(s.agents[gone]).toBeUndefined();
    expect(s.agents[kept]?.wave).toBe(UNASSIGNED);
  });

  it("the _archive index sets state.archive; a clear and a resync empty it", () => {
    const s = apply(archiveMsg(["a", "b"]));
    expect(s.archive?.archived.map((e) => e.wave)).toEqual(["a", "b"]);
    expect(apply(archiveMsg(["a"]), archiveMsg(null)).archive).toBeNull();
    expect(resync(s).archive).toBeNull();
    expect(routeTopic("volley/_waves/_archive")).toEqual({ kind: "archive" });
  });
});
