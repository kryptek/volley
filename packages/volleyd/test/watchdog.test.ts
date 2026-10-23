import { describe, expect, it } from "vitest";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import {
  BLOCKED_ALARM,
  TERMINAL_ALARM,
  type TerminalSeen,
  decidedAgent,
  namedAgent,
  recoverableTerminals,
  terminalKey,
  unjournaledTerminals,
} from "../src/watchdog";

const T0 = Date.parse("2026-10-18T12:00:00.000Z");
const MS = DAEMON_DEFAULTS.terminal_unjournaled_alarm_ms;
const A = "w1-t1-implementer-1";

const seen = (status: string, o: Partial<TerminalSeen> = {}): TerminalSeen => ({
  agent_id: A,
  role: "implementer",
  task: "T1",
  status,
  wall_time: "2026-10-18T12:00:00.000Z",
  seen_at: T0,
  after_seq: 10,
  ...o,
});

describe("unjournaledTerminals", () => {
  it("a blocked status nothing named the agent after, 61 s on → listed", () => {
    expect(unjournaledTerminals([seen("blocked")], new Map(), T0 + 61_000, MS)).toEqual([
      {
        agent_id: A,
        role: "implementer",
        task: "T1",
        status: "blocked",
        since: "2026-10-18T12:00:00.000Z",
      },
    ]);
  });

  it("a decision naming the agent after a blocked → not listed", () => {
    const decided = new Map([[A, 11]]);
    expect(unjournaledTerminals([seen("blocked")], new Map(), T0 + 61_000, MS, decided)).toEqual(
      [],
    );
  });

  it("a blocked is handled only by a decision or a retire: any other event naming it is not", () => {
    const named = new Map([[A, 11]]);
    expect(unjournaledTerminals([seen("blocked")], named, T0 + 61_000, MS)).toHaveLength(1);
    // A done's claim is checked by events of its own (verification): those still count.
    expect(unjournaledTerminals([seen("done")], named, T0 + 61_000, MS)).toEqual([]);
  });

  it("an event naming the agent before the status arrived does not count", () => {
    const named = new Map([[A, 10]]);
    expect(unjournaledTerminals([seen("done")], named, T0 + 61_000, MS)).toHaveLength(1);
  });

  it("done and failed are watched too; working never is", () => {
    const now = T0 + 61_000;
    expect(unjournaledTerminals([seen("done")], new Map(), now, MS)).toHaveLength(1);
    expect(unjournaledTerminals([seen("failed")], new Map(), now, MS)).toHaveLength(1);
    expect(unjournaledTerminals([seen("working")], new Map(), now, MS)).toEqual([]);
  });

  it("within the threshold (59 s) → not listed", () => {
    expect(unjournaledTerminals([seen("blocked")], new Map(), T0 + 59_000, MS)).toEqual([]);
  });
});

describe("recoverableTerminals", () => {
  const RECOVER = DAEMON_DEFAULTS.terminal_recover_ms;
  const alarmedAt = T0 + 61_000;
  const alarmed = (t: TerminalSeen) => new Map([[terminalKey(t), alarmedAt]]);

  it("an alarmed done is listed once terminal_recover_ms has passed since its alarm, not before", () => {
    const t = seen("done");
    expect(
      recoverableTerminals([t], alarmed(t), new Map(), alarmedAt + RECOVER - 1, RECOVER),
    ).toEqual([]);
    expect(recoverableTerminals([t], alarmed(t), new Map(), alarmedAt + RECOVER, RECOVER)).toEqual([
      t,
    ]);
  });

  it("a status journaled about since is never listed", () => {
    const t = seen("done");
    const named = new Map([[A, 11]]);
    expect(recoverableTerminals([t], alarmed(t), named, alarmedAt + RECOVER, RECOVER)).toEqual([]);
  });

  it("a status never alarmed, or alarmed for another wall_time, is not listed", () => {
    const t = seen("failed");
    const now = alarmedAt + RECOVER;
    expect(recoverableTerminals([t], new Map(), new Map(), now, RECOVER)).toEqual([]);
    const other = alarmed(seen("failed", { wall_time: "2026-10-18T11:00:00.000Z" }));
    expect(recoverableTerminals([t], other, new Map(), now, RECOVER)).toEqual([]);
  });

  it("a blocked is not: the blocked invariant asks about it", () => {
    const t = seen("blocked");
    expect(recoverableTerminals([t], alarmed(t), new Map(), alarmedAt + RECOVER, RECOVER)).toEqual(
      [],
    );
  });
});

describe("namedAgent", () => {
  it("agent_id, else a relaunch's from_agent", () => {
    expect(namedAgent({ type: "artifact_verified", data: { agent_id: A } })).toBe(A);
    expect(namedAgent({ type: "relaunched", data: { from_agent: A, to_agent: "x" } })).toBe(A);
    expect(namedAgent({ type: "task_admitted", data: {} })).toBeUndefined();
  });

  it("the watchdog's own alarm never counts as handling the status", () => {
    expect(
      namedAgent({ type: "alarm_raised", data: { alarm: TERMINAL_ALARM, agent_id: A } }),
    ).toBeUndefined();
    expect(
      namedAgent({ type: "alarm_cleared", data: { alarm: TERMINAL_ALARM, agent_id: A } }),
    ).toBeUndefined();
    expect(namedAgent({ type: "alarm_raised", data: { alarm: "other", agent_id: A } })).toBe(A);
  });

  it("the status handoff's own pipeline_error is not handling the status", () => {
    expect(
      namedAgent({
        type: "alarm_raised",
        data: { alarm: "pipeline_error", check: "status", agent_id: A, message: "x" },
      }),
    ).toBeUndefined();
  });

  it("a registration, a reconcile or a blocked_unhandled alarm is not handling the status", () => {
    expect(namedAgent({ type: "agent_registered", data: { agent_id: A } })).toBeUndefined();
    expect(namedAgent({ type: "reconciled", data: { agent_id: A } })).toBeUndefined();
    expect(
      namedAgent({ type: "alarm_raised", data: { alarm: BLOCKED_ALARM, agent_id: A } }),
    ).toBeUndefined();
  });
});

describe("decidedAgent", () => {
  it("a decision, a retire or a relaunch names the agent; nothing else does", () => {
    expect(decidedAgent({ type: "decision_opened", data: { agent_id: A } })).toBe(A);
    expect(decidedAgent({ type: "agent_retired", data: { agent_id: A } })).toBe(A);
    expect(decidedAgent({ type: "agent_force_retired", data: { agent_id: A } })).toBe(A);
    expect(decidedAgent({ type: "relaunched", data: { from_agent: A, to_agent: "x" } })).toBe(A);
    expect(decidedAgent({ type: "agent_registered", data: { agent_id: A } })).toBeUndefined();
    expect(decidedAgent({ type: "steering_sent", data: { agent_id: A } })).toBeUndefined();
    expect(decidedAgent({ type: "artifact_verified", data: { agent_id: A } })).toBeUndefined();
  });
});
