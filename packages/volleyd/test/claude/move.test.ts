import { describe, expect, it } from "vitest";
import { accountMoves, moveAgentAccount, moveRespawn, resumeNote } from "../../src/claude/move";
import type { JournalEvent, NewEvent } from "../../src/types";

const MOVE = {
  wave: "w1",
  task: "T1",
  role: "implementer" as const,
  agentId: "w1-t1-implementer-1",
  from: "primary",
  to: { id: "work", dir: "/srv/claude/work" },
  by: "owner-1",
};

function deps(opts: { stops?: boolean } = {}) {
  const log: string[] = [];
  const events: NewEvent[] = [];
  let note = "";
  let dir: string | null = null;
  return {
    log,
    events,
    get note() {
      return note;
    },
    get dir() {
      return dir;
    },
    d: {
      journal: async (ev: NewEvent) => {
        log.push(`journal:${ev.type}`);
        events.push(ev);
      },
      cancel: async (text: string) => {
        log.push("cancel");
        expect(text).toMatch(/Claude account work/);
      },
      waitStopped: async () => {
        log.push("wait");
        return opts.stops !== false;
      },
      retire: async () => {
        log.push("retire");
      },
      respawn: async (r: { account: { id: string; dir: string | null }; resumeNote: string }) => {
        log.push("respawn");
        note = r.resumeNote;
        dir = r.account.dir;
        return { agentId: "w1-t1-implementer-2" };
      },
    },
  };
}

describe("agent_move_account", () => {
  it("journals first, cancels, waits for the stop, retires, respawns under the new profile", async () => {
    const w = deps();
    const r = await moveAgentAccount(MOVE, w.d);
    expect(w.log).toEqual(["journal:agent_account_moved", "cancel", "wait", "retire", "respawn"]);
    expect(w.events[0]).toEqual({
      type: "agent_account_moved",
      task: "T1",
      data: {
        agent_id: MOVE.agentId,
        role: "implementer",
        from: "primary",
        to: "work",
        by: "owner-1",
      },
    });
    expect(w.dir).toBe("/srv/claude/work");
    expect(w.note).toContain(MOVE.agentId);
    expect(w.note).toMatch(/Claude account `work`/);
    expect(r).toEqual({ ok: true, agent_id: "w1-t1-implementer-2", from: "primary", to: "work" });
  });

  it("an agent that does not stop is not respawned beside itself: alarm, no respawn", async () => {
    const w = deps({ stops: false });
    const r = await moveAgentAccount(MOVE, w.d);
    expect(r.ok).toBe(false);
    expect(w.log).not.toContain("respawn");
    expect(w.log).not.toContain("retire");
    expect(w.events.at(-1)).toMatchObject({
      type: "alarm_raised",
      task: "T1",
      data: { code: "ACCOUNT_MOVE_STOP_TIMEOUT", agent_id: MOVE.agentId },
    });
  });

  it("refuses a move to the account it already runs under", async () => {
    const w = deps();
    const r = await moveAgentAccount({ ...MOVE, from: "work" }, w.d);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/already/) });
    expect(w.log).toEqual([]);
  });
});

describe("resumeNote", () => {
  it("tells the new session where it is and that its work is in the worktree", () => {
    const n = resumeNote({ agentId: "a-1", from: "primary", to: "work" });
    expect(n).toMatch(/^## Resume after an account move/);
    expect(n).toContain("a-1");
    expect(n).toMatch(/git status/);
  });
});

describe("accountMoves (replayed from the journal)", () => {
  it("the latest move per task and role wins", () => {
    const ev = (seq: number, task: string, role: string, to: string): JournalEvent => ({
      seq,
      at: "2026-10-18T12:00:00.000Z",
      type: "agent_account_moved",
      task,
      data: { role, to },
    });
    expect(
      accountMoves([
        ev(1, "T1", "implementer", "work"),
        ev(2, "T1", "implementer", "personal"),
        ev(3, "T2", "fixup", "work"),
      ]),
    ).toEqual({ "T1/implementer": "personal", "T2/fixup": "work" });
  });
});

describe("moveRespawn (what a moved agent's respawn carries over)", () => {
  it("a reviewer keeps its start point and its own attempt's worktree", () => {
    expect(
      moveRespawn({ role: "spec_reviewer", attempt: 2, start: "abc123", detached: true }),
    ).toEqual({ start: { ref: "abc123", detach: true }, worktreeAttempt: 2 });
  });

  it("an agent moved again stays in the first attempt's worktree", () => {
    expect(
      moveRespawn({
        role: "fixup",
        attempt: 3,
        worktree_attempt: 1,
        start: "abc123",
        detached: false,
      }),
    ).toEqual({ start: { ref: "abc123", detach: false }, worktreeAttempt: 1 });
  });

  it("an implementer (per-role worktree) needs neither", () => {
    expect(moveRespawn({ role: "implementer", attempt: 1 })).toEqual({});
    expect(moveRespawn(undefined)).toEqual({});
  });
});
