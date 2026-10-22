import { describe, expect, it } from "vitest";
import { decisionItemId, foldInbox, itemForDecision } from "../src/autopilot/inbox";
import { CONFIG_DEFAULTS } from "../src/config-defaults";
import {
  decisionPayload,
  ghHoldReleased,
  heldLabel,
  holdEvent,
  parseHeldOn,
  releaseEvent,
  taskHoldReleased,
} from "../src/decisions";
import { type WaveRecord, apply as applyEvent, replay } from "../src/reducer";
import type { JournalEvent, NewEvent } from "../src/types";
import { parseWaveFile } from "../src/wave-file";
import { envelope, schemaErrors } from "./helpers/schema";

/** Held decisions (#335): "waiting on <task|PR|issue>", never escalated, released by the blocker. */

const wave = parseWaveFile(`wave: w1
repo: r
release_branch: release/w1
model: m
pipeline: [implement]
tasks:
  T1: { issue: 41 }
  T4: { issue: 44 }
`);

const AT = "2026-10-21T09:00:00.000Z";
const NOW = new Date("2026-10-21T10:00:00.000Z");

const opened: NewEvent = {
  type: "decision_opened",
  task: "T1",
  data: {
    decision_id: "d-x",
    kind: "ci_failed",
    question: "CI failed on T1's head. What now?",
    options: ["retry", "fix flake"],
    pointers: {},
    opened_at: AT,
  },
};

const events = (extra: NewEvent[] = []): JournalEvent[] =>
  [
    { type: "wave_submitted", data: { wave, owner: null } } as NewEvent,
    ...wave.task_order.map((id): NewEvent => ({ type: "task_queued", task: id, data: {} })),
    { type: "stage_entered", task: "T1", data: { stage: "implement" } } as NewEvent,
    opened,
    ...extra,
  ].map((e, i): JournalEvent => ({ ...e, seq: i + 1, at: AT }));

const record = (extra: NewEvent[] = []): WaveRecord => replay(events(extra));

/** Apply a built event to a record, as the journal would. */
const apply = (rec: WaveRecord, ev: NewEvent, seq = 100): WaveRecord =>
  applyEvent(rec, { ...ev, seq, at: NOW.toISOString() });

describe("parseHeldOn: what a hold waits on", () => {
  it("a task id, #<pr> or pr#<n>, issue#<n>", () => {
    expect(parseHeldOn("T4")).toEqual({ task: "T4" });
    expect(parseHeldOn("#194")).toEqual({ pr: 194 });
    expect(parseHeldOn("pr#12")).toEqual({ pr: 12 });
    expect(parseHeldOn("issue#7")).toEqual({ issue: 7 });
    expect(parseHeldOn("")).toBeNull();
    expect(parseHeldOn("#0")).toBeNull();
    expect(parseHeldOn("issue#x")).toBeNull();
    expect(parseHeldOn("bad id!")).toBeNull();
  });
});

describe("holdEvent / releaseEvent: held on the decision record", () => {
  it("a hold on an open decision journals decision_held; the record carries `held`", () => {
    const rec = record();
    const r = holdEvent(rec, "d-x", { on: { task: "T4" }, note: "flake fix", by: "owner" });
    if (!("event" in r)) throw new Error(JSON.stringify(r));
    expect(r.event).toEqual({
      type: "decision_held",
      task: "T1",
      data: {
        decision_id: "d-x",
        kind: "ci_failed",
        on: { task: "T4" },
        note: "flake fix",
        by: "owner",
      },
    });
    const next = apply(rec, r.event);
    expect(next.decisions["d-x"]?.held).toEqual({
      on: { task: "T4" },
      note: "flake fix",
      by: "owner",
      at: NOW.toISOString(),
    });
    // Held is still open: the task stays parked.
    expect(next.state?.open_decisions).toContain("d-x");
    expect(decisionPayload(next.decisions["d-x"] as never).held?.on).toEqual({ task: "T4" });
  });

  it("a second hold replaces the first", () => {
    const first = holdEvent(record(), "d-x", { on: { task: "T4" }, by: "owner" });
    if (!("event" in first)) throw new Error("expected an event");
    const rec = apply(record(), first.event);
    const second = holdEvent(rec, "d-x", { on: { pr: 194 }, by: "owner" });
    if (!("event" in second)) throw new Error("expected an event");
    expect(apply(rec, second.event, 101).decisions["d-x"]?.held?.on).toEqual({ pr: 194 });
  });

  it("releaseEvent clears it and records why", () => {
    const h = holdEvent(record(), "d-x", { on: { task: "T4" }, by: "owner" });
    if (!("event" in h)) throw new Error("expected an event");
    const rec = apply(record(), h.event);
    const r = releaseEvent(rec, "d-x", { why: "T4 done", by: "volleyd" });
    if (!("event" in r)) throw new Error(JSON.stringify(r));
    expect(r.event).toEqual({
      type: "decision_released",
      task: "T1",
      data: { decision_id: "d-x", kind: "ci_failed", why: "T4 done", by: "volleyd" },
    });
    const next = apply(rec, r.event, 101);
    expect(next.decisions["d-x"]?.held).toBeUndefined();
    expect(next.decisions["d-x"]?.released).toEqual({ why: "T4 done", at: NOW.toISOString() });
    expect(decisionPayload(next.decisions["d-x"] as never)).not.toHaveProperty("held");
    // Releasing what is not held says so.
    expect(releaseEvent(next, "d-x", { why: "x", by: "owner" })).toEqual({ not_held: true });
  });

  it("refuses an unknown or resolved decision, a missing blocker, the decision's own task, a settled task", () => {
    const rec = record();
    expect(holdEvent(rec, "d-nope", { on: { task: "T4" }, by: "o" })).toHaveProperty("error");
    expect(holdEvent(rec, "d-x", { on: {}, by: "o" })).toHaveProperty("error");
    expect(holdEvent(rec, "d-x", { on: { task: "T9" }, by: "o" })).toHaveProperty("error");
    expect(holdEvent(rec, "d-x", { on: { task: "T1" }, by: "o" })).toHaveProperty("error");
    const done = record([{ type: "task_cancelled", task: "T4", data: {} }]);
    expect(holdEvent(done, "d-x", { on: { task: "T4" }, by: "o" })).toHaveProperty("error");
    const resolved = record([
      {
        type: "decision_resolved",
        task: "T1",
        data: { decision_id: "d-x", answer: "retry", by: "o" },
      },
    ]);
    expect(holdEvent(resolved, "d-x", { on: { task: "T4" }, by: "o" })).toHaveProperty("error");
  });

  it("the journaled events validate against wave-event.schema.json", () => {
    const h = holdEvent(record(), "d-x", { on: { task: "T4" }, by: "owner" });
    if (!("event" in h)) throw new Error("expected an event");
    const mirror = (ev: NewEvent) =>
      envelope("_waves/events", ev.type, {
        wave: "w1",
        seq: 9,
        at: AT,
        task: ev.task,
        data: ev.data,
      });
    expect(schemaErrors("wave-event.schema.json", mirror(h.event))).toEqual([]);
    const r = releaseEvent(apply(record(), h.event), "d-x", { why: "T4 done", by: "volleyd" });
    if (!("event" in r)) throw new Error("expected an event");
    expect(schemaErrors("wave-event.schema.json", mirror(r.event))).toEqual([]);
  });
});

describe("auto-release: the blocker landed", () => {
  it("a task hold releases when the task is done or cancelled", () => {
    expect(taskHoldReleased(record(), { task: "T4" })).toBeNull();
    expect(
      taskHoldReleased(record([{ type: "task_cancelled", task: "T4", data: {} }]), { task: "T4" }),
    ).toBe("T4 cancelled");
    expect(
      taskHoldReleased(record([{ type: "stage_entered", task: "T4", data: { stage: "done" } }]), {
        task: "T4",
      }),
    ).toBe("T4 done");
    expect(taskHoldReleased(record(), { pr: 3 })).toBeNull();
  });

  it("a PR hold releases when it is merged or closed; an issue hold when the issue is closed", () => {
    expect(ghHoldReleased({ pr: 12 }, { pr: "OPEN" })).toBeNull();
    expect(ghHoldReleased({ pr: 12 }, { pr: "MERGED" })).toBe("PR #12 merged");
    expect(ghHoldReleased({ pr: 12 }, { pr: "CLOSED" })).toBe("PR #12 closed");
    expect(ghHoldReleased({ issue: 7 }, { issue: "OPEN" })).toBeNull();
    expect(ghHoldReleased({ issue: 7 }, { issue: "CLOSED" })).toBe("issue #7 closed");
    expect(ghHoldReleased({ issue: 7 }, {})).toBeNull();
  });
});

describe("heldLabel", () => {
  it("names the task with its PR, a PR, or an issue", () => {
    const rec = record([
      {
        type: "artifact_verified",
        task: "T4",
        data: { pr: { number: 194, url: "https://example.com/pull/194" } },
      },
    ]);
    expect(heldLabel({ task: "T4" }, rec.state?.tasks)).toBe("T4 (#194)");
    expect(heldLabel({ task: "T4" })).toBe("T4");
    expect(heldLabel({ pr: 12 })).toBe("PR #12");
    expect(heldLabel({ issue: 7 })).toBe("issue #7");
  });
});

describe("the inbox item mirrors `held`", () => {
  it("itemForDecision carries an open decision's hold; foldInbox follows held and released", () => {
    const h = holdEvent(record(), "d-x", { on: { task: "T4" }, by: "owner" });
    if (!("event" in h)) throw new Error("expected an event");
    const held = apply(record(), h.event);
    const item = itemForDecision(
      decisionPayload(held.decisions["d-x"] as never),
      CONFIG_DEFAULTS.autopilot,
    );
    expect(item.held?.on).toEqual({ task: "T4" });
    expect(schemaErrors("inbox-item.schema.json", envelope("_inbox", "inbox_item", item))).toEqual(
      [],
    );

    const fresh = itemForDecision(
      decisionPayload(record().decisions["d-x"] as never),
      CONFIG_DEFAULTS.autopilot,
    );
    const map = new Map([[fresh.id, fresh]]);
    const at = (e: NewEvent, seq: number): JournalEvent => ({ ...e, seq, at: NOW.toISOString() });
    foldInbox(map, [at(h.event, 1)], "w1");
    const id = decisionItemId("w1", "d-x");
    expect(map.get(id)?.held).toEqual({ on: { task: "T4" }, by: "owner", at: NOW.toISOString() });
    // The version is unchanged: a hold is not an answer, and an answer at it still wins.
    expect(map.get(id)?.version).toBe(1);
    foldInbox(
      map,
      [
        at(
          {
            type: "decision_released",
            data: { decision_id: "d-x", why: "T4 done", by: "volleyd" },
          },
          2,
        ),
      ],
      "w1",
    );
    expect(map.get(id)?.held).toBeUndefined();
  });
});
