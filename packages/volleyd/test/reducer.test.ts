import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nextSteer } from "../src/controls";
import { apply, emptyRecord, reduce, replay } from "../src/reducer";
import type { JournalEvent, WaveTask } from "../src/types";
import { parseWaveFile } from "../src/wave-file";
import { envelope, schemaErrors } from "./helpers/schema";

const events: JournalEvent[] = readFileSync(
  new URL("./fixtures/journal.jsonl", import.meta.url),
  "utf-8",
)
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));

describe("reduce", () => {
  it("replays the fixture journal into a schema-valid wave state", () => {
    const state = reduce(events);
    expect(
      schemaErrors("wave-state.schema.json", envelope("_waves/state", "wave_state", state)),
    ).toEqual([]);

    expect(state.wave).toBe("2026-10-20-example");
    expect(state.owner).toBe("coordinator-ab12");
    expect(state.status).toBe("running");
    expect(state.updated_at).toBe(events.at(-1)?.at);
    expect(state.open_decisions).toEqual([]);
    expect(state.gates).toEqual([]);
    expect(state.spec?.tasks.T3).toEqual({ issue: 104, after: ["T1", "T2"] });
    expect(state.spec?.pipeline).toEqual([
      "implement",
      ["spec_review", "quality_review"],
      "fixup",
      "merge_ready",
    ]);

    const byId = Object.fromEntries(state.tasks.map((t) => [t.id, t]));
    expect(byId.T0).toMatchObject({
      stage: "done",
      agents: { implementer: "2026-10-20-example-t0-implementer-1" },
      pr: { number: 7, ci: "green" },
    });
    expect(byId.T0?.waiting_on).toBeUndefined();
    expect(byId.T1).toMatchObject({ stage: "queued", agents: {} });
    expect(byId.T1?.waiting_on).toBeUndefined();
    expect(byId.T3).toMatchObject({
      stage: "queued",
      waiting_on: ["T1", "T2"],
      why_waiting: "after: T1, T2",
    });
  });

  it("tracks gates and open decisions mid-wave", () => {
    // Stop right after decision_opened (T0 merge-ready, d1 open).
    const cut = events.findIndex((e) => e.type === "decision_opened");
    const state = reduce(events.slice(0, cut + 1));
    expect(state.gates).toEqual(["T0"]);
    expect(state.open_decisions).toEqual(["d1"]);
    expect(
      schemaErrors("wave-state.schema.json", envelope("_waves/state", "wave_state", state)),
    ).toEqual([]);
  });

  it("a task parked on a decision stays parked on stage_entered done until the decision is resolved", () => {
    // Why the pipeline closes a merged task's open decisions before it journals `done`.
    const base = events.slice(0, 11); // T0 at merge_ready
    const at = "2026-10-20T09:20:00.000Z";
    const parked = [
      ...base,
      {
        seq: 12,
        at,
        type: "decision_opened",
        task: "T0",
        data: {
          decision_id: "d9",
          kind: "pr_head_moved",
          question: "moved?",
          options: ["rereview", "fixup", "cancel"],
        },
      },
      { seq: 13, at, type: "stage_entered", task: "T0", data: { stage: "done", merged: true } },
    ] as JournalEvent[];
    const rec = replay(parked);
    expect(rec.state?.tasks.find((t) => t.id === "T0")?.stage).toBe("awaiting_decision");
    expect(rec.decisions.d9?.resume_stage).toBe("done");
    const resolved = replay([
      ...parked,
      {
        seq: 14,
        at,
        type: "decision_resolved",
        task: "T0",
        data: { decision_id: "d9", answer: "superseded_by_merge", by: "volleyd" },
      } as JournalEvent,
    ]);
    expect(resolved.state?.tasks.find((t) => t.id === "T0")?.stage).toBe("done");
  });

  it("is idempotent: re-applying an already-applied seq is a no-op", () => {
    const rec = replay(events);
    for (const e of events) {
      expect(apply(rec, e)).toBe(rec);
    }
    expect(replay([...events, ...events])).toEqual(rec);
    // Interleaved duplicates don't double-count admissions or spawns.
    const doubled = events.flatMap((e) => [e, e]);
    expect(replay(doubled)).toEqual(rec);
  });

  it("does not mutate the record it is given", () => {
    const first = replay(events.slice(0, 5));
    const copy = structuredClone(first);
    apply(first, events[5] as JournalEvent);
    expect(first).toEqual(copy);
  });

  it("tracks admissions and spawns for the scheduler", () => {
    const rec = replay(events);
    expect(rec.seq).toBe(events.length);
    expect(rec.admitted).toEqual(["T0", "T1"]);
    expect(rec.spawns).toBe(1);
  });

  it("tasks[].base_sha comes from agent_spawned, survives replay, and a start-ref spawn keeps it", () => {
    const last = events.at(-1) as JournalEvent;
    const at = "2026-10-20T10:00:00.000Z";
    const base = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    const more: JournalEvent[] = [
      {
        seq: last.seq + 1,
        at,
        type: "agent_spawned",
        task: "T1",
        data: {
          role: "implementer",
          agent_id: "2026-10-20-example-t1-implementer-1",
          base_sha: base,
        },
      },
      // A reviewer cut from the PR head (a pipeline start ref) names no release base.
      {
        seq: last.seq + 2,
        at,
        type: "agent_spawned",
        task: "T1",
        data: {
          role: "spec_reviewer",
          agent_id: "2026-10-20-example-t1-spec_reviewer-1",
          start: "f".repeat(40),
        },
      },
    ];
    const state = reduce([...events, ...more]);
    const t1 = state.tasks.find((t) => t.id === "T1");
    expect(t1?.base_sha).toBe(base);
    expect(state.tasks.find((t) => t.id === "T2")?.base_sha).toBeUndefined();
    expect(
      schemaErrors("wave-state.schema.json", envelope("_waves/state", "wave_state", state)),
    ).toEqual([]);
    // Replayed (twice over, as after a restart) it is the same.
    const all = [...events, ...more];
    expect(replay([...all, ...all]).state?.tasks.find((t) => t.id === "T1")?.base_sha).toBe(base);
  });

  it("throws when the journal has no wave_submitted", () => {
    expect(() => reduce([])).toThrow(/wave_submitted/);
    expect(emptyRecord().state).toBeNull();
  });

  it("a config_changed event never touches a wave's overrides (they change only by wave_versioned)", () => {
    const base = replay(events);
    const seq = base.seq + 1;
    const next = apply(base, {
      seq,
      at: "2026-10-20T12:00:00.000Z",
      type: "config_changed",
      data: { overrides: { hard_ceiling: 99 } },
    });
    expect(next.overrides).toEqual(base.overrides);
    expect(next.state?.status).toBe(base.state?.status);
  });

  it("applies wave status events", () => {
    const last = events.at(-1) as JournalEvent;
    const at = "2026-10-20T10:00:00.000Z";
    const paused = reduce([...events, { seq: last.seq + 1, at, type: "wave_paused", data: {} }]);
    expect(paused.status).toBe("paused");
    const stopped = reduce([
      ...events,
      { seq: last.seq + 1, at, type: "wave_paused", data: {} },
      { seq: last.seq + 2, at, type: "wave_resumed", data: {} },
      { seq: last.seq + 3, at, type: "task_cancelled", task: "T3", data: {} },
      { seq: last.seq + 4, at, type: "owner_claimed", data: { owner: "coordinator-cd34" } },
    ]);
    expect(stopped.status).toBe("running");
    expect(stopped.owner).toBe("coordinator-cd34");
    expect(stopped.tasks.find((t) => t.id === "T3")?.stage).toBe("cancelled");
  });

  it("queues steers per task: steering_sent with the same id or steering_dropped empties it", () => {
    const last = events.at(-1) as JournalEvent;
    const at = "2026-10-20T10:00:00.000Z";
    let seq = last.seq;
    const ev = (type: JournalEvent["type"], data: Record<string, unknown>): JournalEvent => ({
      seq: ++seq,
      at,
      type,
      task: "T1",
      data,
    });
    const queued = (id: string, n: number, extra: Record<string, unknown> = {}) =>
      ev("steering_queued", { message_id: id, seq: n, text: `t${n}`, by: "coord", ...extra });
    let rec = replay([...events, queued("m1", 1)]);
    expect(rec.queued_steers.T1).toEqual([
      { message_id: "m1", seq: 1, text: "t1", by: "coord", at },
    ]);
    expect(rec.state?.tasks.find((t) => t.id === "T1")?.queued_steers).toBe(1);
    expect(
      schemaErrors("wave-state.schema.json", envelope("_waves/state", "wave_state", rec.state)),
    ).toEqual([]);
    // Queued and delivered steers share one numbering per task.
    expect(nextSteer(rec, "T1")).toEqual({ seq: 2, supersedes: "m1" });
    rec = apply(rec, queued("m2", 2, { supersedes: "m1", role: "fixup" }));
    expect(rec.queued_steers.T1?.map((q) => q.message_id)).toEqual(["m1", "m2"]);
    expect(rec.queued_steers.T1?.[1]).toMatchObject({ role: "fixup", supersedes: "m1" });

    // The first is delivered: off the queue, and the numbering stays at the latest (2).
    rec = apply(
      rec,
      ev("steering_sent", { type: "steering", message_id: "m1", seq: 1, queued: true }),
    );
    expect(rec.queued_steers.T1?.map((q) => q.message_id)).toEqual(["m2"]);
    expect(nextSteer(rec, "T1")).toEqual({ seq: 3, supersedes: "m2" });

    rec = apply(rec, ev("steering_dropped", { message_ids: ["m2"], reason: "task cancelled" }));
    expect(rec.queued_steers.T1).toBeUndefined();
    expect(rec.state?.tasks.find((t) => t.id === "T1")?.queued_steers).toBeUndefined();
  });

  it("steer_unacked: set by agent_woken, cleared by its steering_received or the agent's retirement", () => {
    const last = events.at(-1) as JournalEvent;
    const at = "2026-10-20T10:00:00.000Z";
    let seq = last.seq;
    const ev = (type: JournalEvent["type"], data: Record<string, unknown>): JournalEvent => ({
      seq: ++seq,
      at,
      type,
      task: "T1",
      data,
    });
    const unacked = (r: ReturnType<typeof replay>) =>
      r.state?.tasks.find((t) => t.id === "T1")?.steer_unacked;
    const woken = ev("agent_woken", { agent_id: "a1", reason: "mailbox", message_id: "m1" });
    let rec = replay([...events, woken]);
    expect(unacked(rec)).toBe("a1");
    expect(
      schemaErrors("wave-state.schema.json", envelope("_waves/state", "wave_state", rec.state)),
    ).toEqual([]);
    // Another agent's retirement leaves the mark.
    rec = apply(rec, ev("agent_retired", { agent_id: "a0", status: "done" }));
    expect(unacked(rec)).toBe("a1");
    // The woken agent is retired without acking: nothing is left to ack it.
    rec = apply(rec, ev("agent_retired", { agent_id: "a1", status: "done" }));
    expect(unacked(rec)).toBeUndefined();

    rec = apply(rec, ev("agent_woken", { agent_id: "a2", reason: "mailbox", message_id: "m2" }));
    rec = apply(rec, ev("steering_received", { agent_id: "a2", message_id: "m1" }));
    expect(unacked(rec)).toBe("a2");
    rec = apply(rec, ev("steering_received", { agent_id: "a2", message_id: "m2" }));
    expect(unacked(rec)).toBeUndefined();
  });

  it("a cancelled task drops its queue", () => {
    const last = events.at(-1) as JournalEvent;
    const at = "2026-10-20T10:00:00.000Z";
    const rec = replay([
      ...events,
      {
        seq: last.seq + 1,
        at,
        type: "steering_queued",
        task: "T1",
        data: { message_id: "m1", seq: 1, text: "x", by: "coord" },
      },
      { seq: last.seq + 2, at, type: "task_cancelled", task: "T1", data: {} },
    ]);
    expect(rec.queued_steers.T1).toBeUndefined();
  });
});

describe("task_placed (SPEC §4.6.15)", () => {
  const wave = parseWaveFile(
    "wave: w1\nrepo: /srv/repo\nrelease_branch: release/w1\nmodel: m\npipeline: [implement]\nplacement: auto\ntasks:\n  T1: { issue: 1 }\n  T2: { issue: 2 }\n",
  );
  const AT = "2026-10-19T10:00:00.000Z";
  const base: JournalEvent[] = [
    { seq: 1, at: AT, type: "wave_submitted", data: { wave } },
    { seq: 2, at: AT, type: "task_queued", task: "T1", data: { issue: 1 } },
    { seq: 3, at: AT, type: "task_queued", task: "T2", data: { issue: 2 } },
  ];
  const candidates = [
    { host: "box-a", score: 0.81, line: "load 3.2 on 16 cores · 1/4 agents · 71% mem · usage 34%" },
    {
      host: "control",
      score: 0.63,
      line: "load 6.0 on 8 cores · 2/12 agents · 40% mem · usage 34%",
    },
    { host: "box-b", score: null, line: "ineligible: draining" },
  ];
  const placedA: JournalEvent = {
    seq: 4,
    at: AT,
    type: "task_placed",
    task: "T1",
    data: { task: "T1", host: "box-a", score: 0.81, candidates, by: "auto" },
  };
  const placedLocal: JournalEvent = {
    seq: 5,
    at: AT,
    type: "task_placed",
    task: "T2",
    data: { task: "T2", host: "control", local: true, score: 0.63, candidates, by: "auto" },
  };

  it("is a wave event whose data validates against the schema", () => {
    for (const e of [placedA, placedLocal]) {
      expect(
        schemaErrors(
          "wave-event.schema.json",
          envelope("_waves/events", e.type, {
            wave: "w1",
            seq: e.seq,
            at: e.at,
            task: e.task,
            data: e.data,
          }),
        ),
      ).toEqual([]);
    }
  });

  it("fills tasks[].placement, sets the task's host, and replays idempotently by seq", () => {
    const rec = replay([...base, placedA, placedLocal]);
    const t1 = rec.state?.tasks.find((t) => t.id === "T1");
    expect(t1?.placement).toEqual({
      host: "box-a",
      by: "auto",
      score: 0.81,
      decided_at: AT,
      candidates,
    });
    // The effective plan now runs T1 on box-a and T2 on the supervisor's own machine: every
    // later role (reviewers, fixup, rebase) reads its host from there.
    expect(rec.wave?.tasks.T1?.host).toBe("box-a");
    expect(rec.wave?.tasks.T2?.host).toBe("local");
    // The submitted plan keeps `auto`.
    expect(rec.plan?.tasks.T1?.host).toBe("auto");
    expect(
      schemaErrors("wave-state.schema.json", envelope("_waves/state", "wave_state", rec.state)),
    ).toEqual([]);
    // Re-applying the same event is a no-op.
    expect(apply(rec, placedA)).toBe(rec);
  });

  it("a re-placement (by: decision) carries from; a cancelled task is placed afresh when re-queued", () => {
    let rec = replay([...base, placedA]);
    rec = apply(rec, {
      seq: 5,
      at: AT,
      type: "task_placed",
      task: "T1",
      data: { task: "T1", host: "box-b", score: 0.5, candidates, by: "decision", from: "box-a" },
    });
    expect(rec.state?.tasks.find((t) => t.id === "T1")?.placement).toMatchObject({
      host: "box-b",
      by: "decision",
    });
    expect(rec.wave?.tasks.T1?.host).toBe("box-b");
    rec = apply(rec, { seq: 6, at: AT, type: "task_cancelled", task: "T1", data: {} });
    rec = apply(rec, { seq: 7, at: AT, type: "task_queued", task: "T1", data: { issue: 1 } });
    expect(rec.state?.tasks.find((t) => t.id === "T1")?.placement).toBeUndefined();
    expect(rec.wave?.tasks.T1?.host).toBe("auto");
  });

  it("a new plan version keeps the placement of a task that is still auto", () => {
    let rec = replay([...base, placedA]);
    const v2 = { ...wave, version: 2 };
    rec = apply(rec, { seq: 5, at: AT, type: "wave_versioned", data: { wave: v2, plan: v2 } });
    expect(rec.wave?.tasks.T1?.host).toBe("box-a");
    expect(rec.wave?.tasks.T2?.host).toBe("auto");
  });

  it("a placed task spawned on its host gets no host_planned from a version that still says auto (#323)", () => {
    let rec = replay([
      ...base,
      placedA,
      {
        seq: 5,
        at: AT,
        type: "agent_spawned",
        task: "T1",
        data: { role: "implementer", agent_id: "w1-t1-implementer-1", host: "box-a" },
      },
    ]);
    const v2 = { ...wave, version: 2 };
    rec = apply(rec, { seq: 6, at: AT, type: "wave_versioned", data: { wave: v2, plan: v2 } });
    const t1 = rec.state?.tasks.find((t) => t.id === "T1");
    expect(rec.wave?.tasks.T1?.host).toBe("box-a");
    expect(t1?.host_actual).toBe("box-a");
    expect(t1?.host_planned).toBeUndefined();
  });

  it("a placed task records another written host as host_planned whether the version lands before or during its spawn (#323)", () => {
    const spawnedA = (seq: number): JournalEvent => ({
      seq,
      at: AT,
      type: "agent_spawned",
      task: "T1",
      data: { role: "implementer", agent_id: "w1-t1-implementer-1", host: "box-a" },
    });
    const v2 = {
      ...wave,
      version: 2,
      tasks: { ...wave.tasks, T1: { ...(wave.tasks.T1 as WaveTask), host: "box-b" } },
    };
    const versioned: JournalEvent = {
      seq: 0,
      at: AT,
      type: "wave_versioned",
      data: { wave: v2, plan: v2 },
    };
    // The version lands after the spawn.
    const after = replay([...base, placedA, spawnedA(5), { ...versioned, seq: 6 }]);
    // The version lands while the spawn runs.
    const during = replay([...base, placedA, { ...versioned, seq: 5 }, spawnedA(6)]);
    for (const rec of [after, during]) {
      expect(rec.wave?.tasks.T1?.host).toBe("box-a");
      expect(rec.state?.tasks.find((t) => t.id === "T1")).toMatchObject({
        host_actual: "box-a",
        host_planned: "box-b",
      });
    }
  });

  it("a task spawned before placement keeps the host it runs on across a plan version (#323)", () => {
    const v1 = parseWaveFile(
      "wave: w1\nrepo: /srv/repo\nrelease_branch: release/w1\nmodel: m\npipeline: [implement]\ntasks:\n  T1: { issue: 1 }\n  T2: { issue: 2 }\n",
    );
    let rec = replay([
      { seq: 1, at: AT, type: "wave_submitted", data: { wave: v1 } },
      ...base.slice(1),
      {
        seq: 4,
        at: AT,
        type: "agent_spawned",
        task: "T1",
        data: { role: "implementer", agent_id: "w1-t1-implementer-1", host: "local" },
      },
    ]);
    expect(rec.state?.tasks.find((t) => t.id === "T1")?.host_actual).toBe("local");
    const v2 = { ...wave, version: 2 }; // placement: auto: both tasks say `auto`
    rec = apply(rec, { seq: 5, at: AT, type: "wave_versioned", data: { wave: v2, plan: v2 } });
    const t1 = rec.state?.tasks.find((t) => t.id === "T1");
    expect(rec.wave?.tasks.T1?.host).toBe("local");
    expect(t1).toMatchObject({ host_actual: "local", host_planned: "auto" });
    // The unstarted task is left to placement.
    expect(rec.wave?.tasks.T2?.host).toBe("auto");
    expect(rec.state?.tasks.find((t) => t.id === "T2")?.host_planned).toBeUndefined();
    expect(
      schemaErrors("wave-state.schema.json", envelope("_waves/state", "wave_state", rec.state)),
    ).toEqual([]);
    // A later version that agrees with where it runs clears host_planned.
    const v3 = { ...v1, version: 3 };
    rec = apply(rec, { seq: 6, at: AT, type: "wave_versioned", data: { wave: v3, plan: v3 } });
    expect(rec.state?.tasks.find((t) => t.id === "T1")?.host_planned).toBeUndefined();
    expect(rec.wave?.tasks.T1?.host).toBe("local");
  });

  const v1Local = parseWaveFile(
    "wave: w1\nrepo: /srv/repo\nrelease_branch: release/w1\nmodel: m\npipeline: [implement]\ntasks:\n  T1: { issue: 1 }\n  T2: { issue: 2 }\n",
  );
  const spawnedLocal = (seq: number): JournalEvent => ({
    seq,
    at: AT,
    type: "agent_spawned",
    task: "T1",
    data: { role: "implementer", agent_id: "w1-t1-implementer-1", host: "local" },
  });

  it("a plan version applied while a task's first spawn runs: the spawn's host is the effective plan's (#323)", () => {
    let rec = replay([
      { seq: 1, at: AT, type: "wave_submitted", data: { wave: v1Local } },
      ...base.slice(1),
    ]);
    const v2 = { ...wave, version: 2 }; // placement: auto, while T1's spawn is in flight
    rec = apply(rec, { seq: 4, at: AT, type: "wave_versioned", data: { wave: v2, plan: v2 } });
    expect(rec.wave?.tasks.T1?.host).toBe("auto");
    rec = apply(rec, spawnedLocal(5));
    const t1 = rec.state?.tasks.find((t) => t.id === "T1");
    expect(rec.wave?.tasks.T1?.host).toBe("local");
    expect(t1).toMatchObject({ host_actual: "local", host_planned: "auto" });
  });

  it("a cancelled started task re-queued under placement: auto takes its plan's host again (#323)", () => {
    let rec = replay([
      { seq: 1, at: AT, type: "wave_submitted", data: { wave: v1Local } },
      ...base.slice(1),
      spawnedLocal(4),
    ]);
    rec = apply(rec, { seq: 5, at: AT, type: "task_cancelled", task: "T1", data: {} });
    const v2 = { ...wave, version: 2 };
    rec = apply(rec, { seq: 6, at: AT, type: "wave_versioned", data: { wave: v2, plan: v2 } });
    rec = apply(rec, { seq: 7, at: AT, type: "task_queued", task: "T1", data: { issue: 1 } });
    const t1 = rec.state?.tasks.find((t) => t.id === "T1");
    expect(rec.wave?.tasks.T1?.host).toBe("auto");
    expect(t1?.host_actual).toBeUndefined();
    expect(t1?.host_planned).toBeUndefined();
  });

  it("a cancelled task from a journal before host_actual is restarted on its plan's host (#323)", () => {
    const old: JournalEvent = {
      seq: 4,
      at: AT,
      type: "agent_spawned",
      task: "T1",
      data: { role: "implementer", agent_id: "w1-t1-implementer-1" },
    };
    let rec = replay([
      { seq: 1, at: AT, type: "wave_submitted", data: { wave: v1Local } },
      ...base.slice(1),
      old,
    ]);
    const v2 = { ...wave, version: 2 }; // kept on `local`: it has an agent
    rec = apply(rec, { seq: 5, at: AT, type: "wave_versioned", data: { wave: v2, plan: v2 } });
    expect(rec.wave?.tasks.T1?.host).toBe("local");
    rec = apply(rec, { seq: 6, at: AT, type: "task_cancelled", task: "T1", data: {} });
    rec = apply(rec, { seq: 7, at: AT, type: "task_queued", task: "T1", data: { issue: 5 } });
    expect(rec.wave?.tasks.T1?.host).toBe("auto");
  });
});

describe("repo_visibility_detected github (SPEC §4.6.1)", () => {
  const wave = parseWaveFile(
    "wave: w1\nrepo: /srv/repo\nrelease_branch: release/w1\nmodel: m\npipeline: [implement]\ntasks:\n  T1: { issue: 1 }\n",
  );
  const AT = "2026-10-19T10:00:00.000Z";
  const GITHUB = {
    slug: "example-org/example-repo",
    url: "https://github.com/example-org/example-repo",
  };
  const detected = (seq: number, github?: unknown): JournalEvent => ({
    seq,
    at: AT,
    type: "repo_visibility_detected",
    data: {
      visibility: "public",
      source: "gh",
      public_hygiene: "auto",
      ...(github !== undefined ? { github } : {}),
    },
  });
  const submitted: JournalEvent = { seq: 1, at: AT, type: "wave_submitted", data: { wave } };

  it("sets state.github, schema-valid", () => {
    const state = reduce([submitted, detected(2, GITHUB)]);
    expect(state.github).toEqual(GITHUB);
    expect(state.repo).toBe("/srv/repo");
    expect(
      schemaErrors("wave-state.schema.json", envelope("_waves/state", "wave_state", state)),
    ).toEqual([]);
  });

  it("an any-case scheme url (asGitHubRepo accepts it) is schema-valid too", () => {
    const upper = { ...GITHUB, url: "HTTPS://github.com/example-org/example-repo" };
    const state = reduce([submitted, detected(2, upper)]);
    expect(state.github).toEqual(upper);
    expect(
      schemaErrors("wave-state.schema.json", envelope("_waves/state", "wave_state", state)),
    ).toEqual([]);
  });

  it("a later read without github removes the key", () => {
    const state = reduce([submitted, detected(2, GITHUB), detected(3)]);
    expect(state).not.toHaveProperty("github");
  });

  it("a malformed slug or url leaves it unset", () => {
    expect(reduce([submitted, detected(2, { ...GITHUB, slug: "owner" })])).not.toHaveProperty(
      "github",
    );
    expect(
      reduce([submitted, detected(2, { ...GITHUB, url: "ftp://example.com/x" })]),
    ).not.toHaveProperty("github");
    expect(reduce([submitted, detected(2, "example-org/example-repo")])).not.toHaveProperty(
      "github",
    );
  });
});

describe("the release train (SPEC §4.6.19)", () => {
  const last = events.at(-1) as JournalEvent;
  let seq = last.seq;
  const ev = (type: string, data: Record<string, unknown> = {}): JournalEvent =>
    ({ seq: ++seq, at: last.at, type, data }) as JournalEvent;
  const started = ev("release_started", {
    done: ["T0"],
    cancelled: [],
    playbook: {
      path: "/r/.volley/release.yaml",
      sha256: "a".repeat(64),
      stages: [
        { name: "smoke", brief: "Run the smoke.", run: [], gate: "auto" },
        { name: "deploy", brief: "Deploy.", run: [], gate: "owner" },
      ],
    },
  });
  const valid = (s: unknown) =>
    expect(
      schemaErrors("wave-state.schema.json", envelope("_waves/state", "wave_state", s)),
    ).toEqual([]);

  it("release_started → status releasing, every stage pending; schema-valid", () => {
    const s = reduce([...events, started]);
    expect(s.status).toBe("releasing");
    expect(s.release).toEqual({
      stage: null,
      stages: [
        { name: "smoke", state: "pending" },
        { name: "deploy", state: "pending" },
      ],
    });
    valid(s);
  });

  it("stages move as they are entered and verified; release_done → complete", () => {
    const run = [
      ...events,
      started,
      ev("release_stage_entered", { stage: "smoke" }),
      ev("release_stage_verified", { stage: "smoke" }),
      ev("release_stage_entered", { stage: "deploy" }),
    ];
    const mid = reduce(run);
    expect(mid.release?.stage).toBe("deploy");
    expect(mid.release?.stages.map((x) => x.state)).toEqual(["verified", "running"]);
    valid(mid);
    const done = reduce([
      ...run,
      ev("release_stage_verified", { stage: "deploy" }),
      ev("release_done", { by: "coord-a", decision_id: "release_go-1" }),
    ]);
    expect(done.status).toBe("complete");
    expect(done.release).toEqual({
      stage: null,
      stages: [
        { name: "smoke", state: "verified" },
        { name: "deploy", state: "verified" },
      ],
    });
    valid(done);
  });

  it("a paused releasing wave resumes releasing, not running", () => {
    const s = reduce([
      ...events,
      started,
      ev("wave_paused", { by: "coord-a" }),
      ev("wave_resumed", { by: "coord-a" }),
    ]);
    expect(s.status).toBe("releasing");
  });

  it("a snapshot taken mid-release continues where it was (and replaying again is a no-op)", () => {
    const first = replay([...events, started]);
    const snap = JSON.parse(JSON.stringify(first));
    const entered = ev("release_stage_entered", { stage: "smoke" });
    const rec = replay([started, entered], snap);
    expect(rec.state?.release?.stage).toBe("smoke");
    expect(replay([entered], rec)).toEqual(rec);
  });
});

describe("a journaled raise on replay (#315)", () => {
  it("a journaled `raise N` replays as no raise: only the normalised `raise by N` counts", () => {
    // Before #315 `raise 120` was journaled and ignored; a replay must not start applying it.
    const at = "2026-10-20T09:20:00.000Z";
    const opened = (seq: number, id: string) =>
      ({
        seq,
        at,
        type: "decision_opened",
        data: {
          decision_id: id,
          kind: "spawn_budget_exhausted",
          question: "budget?",
          options: ["raise by 1", "cancel"],
        },
      }) as JournalEvent;
    const resolved = (seq: number, id: string, answer: string) =>
      ({
        seq,
        at,
        type: "decision_resolved",
        data: { decision_id: id, answer, by: "owner" },
      }) as JournalEvent;
    const base = events.slice(0, 11);
    const legacy = replay([...base, opened(12, "b1"), resolved(13, "b1", "raise 120")]);
    expect(legacy.budget_raised ?? 0).toBe(0);
    const raised = replay([...base, opened(12, "b1"), resolved(13, "b1", "raise by 120")]);
    expect(raised.budget_raised).toBe(120);
  });
});
