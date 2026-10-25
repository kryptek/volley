import { describe, expect, it } from "vitest";
import { ledgerOf } from "../src/commands/cleanup";
import { replay } from "../src/reducer";
import type { JournalEvent, WaveState } from "../src/types";
import { parseWaveFile } from "../src/wave-file";

/** The ledger (#612 D1): everything cleanup acts on, derived from the journals, owned or borrowed. */

const wave = parseWaveFile(
  [
    "wave: w1",
    "repo: acme/demo",
    "release_branch: release/w1",
    "model: claude-opus-5-5",
    "pipeline: [implement, merge_ready]",
    "tasks:",
    "  T1: { issue: 1 }",
    "  T2: { issue: 2 }",
    "  T3: { issue: 3, host: box }",
    "",
  ].join("\n"),
);

let seq = 0;
const ev = (type: string, data: Record<string, unknown>, task?: string): JournalEvent => ({
  seq: ++seq,
  at: `2026-10-25T10:00:${String(seq).padStart(2, "0")}.000Z`,
  type: type as JournalEvent["type"],
  ...(task !== undefined ? { task } : {}),
  data,
});

const spawned = (task: string, extra: Record<string, unknown> = {}) => {
  const agent_id = `w1-${task.toLowerCase()}-implementer-1`;
  return ev(
    "agent_spawned",
    {
      agent_id,
      role: "implementer",
      host: "local",
      terminal: "tmux",
      workspace: `volley-w1-${task}-implementer`,
      worktree: `/path/to/worktrees/w1/${task}-implementer`,
      branch: `w1/${task}-implementer-1`,
      credentials: "minted",
      lock: `/path/to/volleyd/locks/${task}.lock`,
      ...extra,
    },
    task,
  );
};

function journal(): { state: WaveState; events: JournalEvent[] } {
  seq = 0;
  const events: JournalEvent[] = [ev("wave_submitted", { wave })];
  for (const task of ["T1", "T2", "T3"]) {
    events.push(ev("task_queued", { issue: 1 }, task));
    events.push(ev("stage_entered", { stage: "implement" }, task));
    events.push(
      task === "T3"
        ? spawned(task, {
            host: "box",
            worktree: "/path/to/box/worktrees/w1/T3-implementer",
            remote: { target: "dev@box", repo: "/path/to/box/repos/acme/demo" },
          })
        : spawned(task),
    );
    events.push(ev("agent_retired", { agent_id: `w1-${task.toLowerCase()}-implementer-1` }, task));
    events.push(ev("stage_entered", { stage: "done" }, task));
  }
  // T2's login was deleted at retire; T1's and T3's were kept by a crash.
  events.push(ev("credentials_revoked", { agent_id: "w1-t2-implementer-1", ok: true }, "T2"));
  const { state } = replay(events);
  return { state: state as WaveState, events };
}

const sys = (type: string, data: Record<string, unknown>) => ev(type, data);

describe("ledgerOf", () => {
  it("lists every worktree, session, branch and minted login as owned, grouped by host", () => {
    const { state, events } = journal();
    const l = ledgerOf({ state, events, system: [] });
    const owned = (kind: string) =>
      l.owned
        .filter((r) => r.kind === kind)
        .map((r) => `${r.host}:${r.what}`)
        .sort();
    expect(owned("worktree")).toEqual([
      "box:/path/to/box/worktrees/w1/T3-implementer",
      "local:/path/to/worktrees/w1/T1-implementer",
      "local:/path/to/worktrees/w1/T2-implementer",
    ]);
    expect(owned("session")).toEqual([
      "box:volley-w1-T3-implementer",
      "local:volley-w1-T1-implementer",
      "local:volley-w1-T2-implementer",
    ]);
    expect(owned("branch")).toEqual([
      "box:w1/T3-implementer-1",
      "local:w1/T1-implementer-1",
      "local:w1/T2-implementer-1",
    ]);
    expect(owned("lock")).toEqual([
      "local:/path/to/volleyd/locks/T1.lock",
      "local:/path/to/volleyd/locks/T2.lock",
      "local:/path/to/volleyd/locks/T3.lock",
    ]);
    // T2's login is already gone
    expect(owned("login")).toEqual(["local:w1-t1-implementer-1", "local:w1-t3-implementer-1"]);
    expect(Object.keys(l.byHost).sort()).toEqual(["box", "local"]);
    expect(l.byHost.box?.map((r) => r.kind).sort()).toEqual(["branch", "session", "worktree"]);
  });

  it("a registration made --for-wave is owned; one without is borrowed and named with why", () => {
    const { state, events } = journal();
    const owned = ledgerOf({
      state,
      events,
      system: [
        sys("repo_added", {
          by: "coordinator",
          slug: "acme/demo",
          machines: ["local"],
          wave: "w1",
        }),
      ],
    });
    expect(owned.owned.filter((r) => r.kind === "repo")).toEqual([
      { kind: "repo", host: "local", what: "acme/demo" },
    ]);
    const borrowed = ledgerOf({
      state,
      events,
      system: [sys("repo_added", { by: "alfred", slug: "acme/demo", machines: ["local"] })],
    });
    expect(borrowed.owned.filter((r) => r.kind === "repo")).toEqual([]);
    expect(borrowed.borrowed.filter((r) => r.kind === "repo")).toEqual([
      {
        kind: "repo",
        host: "local",
        what: "acme/demo",
        why: "added by alfred (not for a wave) — volley repo remove acme/demo",
      },
    ]);
  });

  it("a borrowed registration another wave on file uses is not listed at all", () => {
    const { state, events } = journal();
    const l = ledgerOf({
      state,
      events,
      system: [sys("repo_added", { by: "alfred", slug: "acme/demo", machines: ["local"] })],
      otherWaves: [{ wave: "w2", repo: "acme/demo" }],
    });
    expect(l.borrowed.filter((r) => r.kind === "repo")).toEqual([]);
  });

  it("a removed registration is neither", () => {
    const { state, events } = journal();
    const l = ledgerOf({
      state,
      events,
      system: [
        sys("repo_added", { by: "c", slug: "acme/demo", machines: ["local"], wave: "w1" }),
        sys("repo_removed", { by: "c", slug: "acme/demo", machines: ["local"], clones: [] }),
      ],
    });
    expect([...l.owned, ...l.borrowed].filter((r) => r.kind === "repo")).toEqual([]);
  });

  it("an account created --for-wave is owned until revoked", () => {
    const { state, events } = journal();
    const created = sys("account_created", {
      by: "c",
      name: "demo-admin",
      role: "admin",
      wave: "w1",
    });
    expect(
      ledgerOf({ state, events, system: [created] }).owned.filter((r) => r.kind === "account"),
    ).toEqual([{ kind: "account", host: "local", what: "demo-admin" }]);
    expect(
      ledgerOf({
        state,
        events,
        system: [created, sys("account_revoked", { by: "c", name: "demo-admin" })],
      }).owned.filter((r) => r.kind === "account"),
    ).toEqual([]);
    // a human account without `wave` is never on the ledger
    expect(
      ledgerOf({
        state,
        events,
        system: [sys("account_created", { by: "c", name: "alfred", role: "admin" })],
      }).owned.filter((r) => r.kind === "account"),
    ).toEqual([]);
  });

  it("the wave's release branch is borrowed", () => {
    const { state, events } = journal();
    expect(ledgerOf({ state, events, system: [] }).borrowed).toContainEqual(
      expect.objectContaining({ kind: "release_branch", host: "local", what: "release/w1" }),
    );
  });

  it("--task narrows the ledger to one task's worktrees, sessions, processes and branch", () => {
    const { state, events } = journal();
    const l = ledgerOf({ state, events, system: [] }, { task: "T1" });
    expect(l.owned.map((r) => `${r.kind}:${r.task}`).sort()).toEqual([
      "branch:T1",
      "lock:T1",
      "session:T1",
      "worktree:T1",
    ]);
    expect(l.borrowed).toEqual([]);
  });
});
