import { describe, expect, it } from "vitest";
import {
  type AgentOnAccount,
  type ProbeLogin,
  type ProbeState,
  type UsageBook,
  type UsagePayload,
  accountRecords,
  agentLimitDecisions,
  bookState,
  emptyBook,
  foldProbe,
  foldUsage,
  forgetAgent,
  limitDecisions,
  mostHeadroom,
  parseAgentMoveAnswer,
  parseMoveAnswer,
  parseUsage,
  pruneBook,
  rankAccounts,
  restoreBook,
  sampleAccount,
  waveAccount,
  waveAccountMoves,
} from "../../src/claude/usage";
import type { JournalEvent } from "../../src/types";
import { envelope, schemaErrors } from "../helpers/schema";

const RESETS = "2026-10-18T18:10:00.000Z";
const NOW = Date.parse("2026-10-18T14:00:00.000Z");
const NOW_ISO = new Date(NOW).toISOString();

function sample(
  account: string,
  fiveHour: number | null,
  at: string,
  weekly: number | null = 40,
): UsagePayload {
  return {
    account,
    model: "claude-opus-5-5",
    context_window: { used_percentage: 10, used: 1000, size: 1_000_000 },
    rate_limits: {
      ...(fiveHour !== null ? { five_hour: { pct: fiveHour, resets_at: RESETS } } : {}),
      ...(weekly !== null
        ? { weekly: { pct: weekly, resets_at: "2026-10-21T09:00:00.000Z" } }
        : {}),
    },
    captured_at: at,
  };
}

const fold = (book: UsageBook, agent: string, wave: string | null, p: UsagePayload) =>
  foldUsage(book, { agent, wave, account: p.account as string, payload: p });

describe("parseUsage", () => {
  it("accepts a usage payload and rejects anything else", () => {
    const p = sample("work", 11, "2026-10-18T14:00:00.000Z");
    expect(parseUsage(p)).toEqual(p);
    expect(parseUsage({ ...p, captured_at: "yesterday" })).toBeNull();
    expect(parseUsage({ ...p, rate_limits: { five_hour: { pct: "high" } } })).toBeNull();
    expect(parseUsage("nope")).toBeNull();
  });

  it("rejects an account outside the id grammar (it becomes a topic level)", () => {
    const p = sample("work", 11, "2026-10-18T14:00:00.000Z");
    for (const account of ["a/b", "x#", "+", "Work", "-x", ""])
      expect(parseUsage({ ...p, account })).toBeNull();
    expect(parseUsage({ ...p, account: null })).toEqual({ ...p, account: null });
  });
});

describe("account aggregation", () => {
  it("two agents on one account fold into one record carrying the newest sample", () => {
    let book = emptyBook();
    book = fold(book, "w1-t1-implementer-1", "w1", sample("work", 40, "2026-10-18T14:00:05.000Z"));
    book = fold(book, "w1-t2-implementer-1", "w1", sample("work", 55, "2026-10-18T14:00:09.000Z"));
    // an older sample arriving late does not win
    book = fold(book, "w1-t1-implementer-1", "w1", sample("work", 41, "2026-10-18T14:00:07.000Z"));
    const recs = accountRecords(book);
    expect(Object.keys(recs)).toEqual(["work"]);
    expect(recs.work).toEqual({
      account: "work",
      five_hour: { pct: 55, resets_at: RESETS },
      weekly: { pct: 40, resets_at: "2026-10-21T09:00:00.000Z" },
      agents: ["w1-t1-implementer-1", "w1-t2-implementer-1"],
      waves: ["w1"],
      sampled_at: "2026-10-18T14:00:09.000Z",
      sampled_by: "w1-t2-implementer-1",
    });
  });

  it("a sample without a window keeps the account's last known one", () => {
    let book = fold(emptyBook(), "a1", "w1", sample("work", 40, "2026-10-18T14:00:05.000Z"));
    book = fold(book, "a2", "w2", sample("work", null, "2026-10-18T14:00:09.000Z", null));
    expect(accountRecords(book).work).toMatchObject({
      five_hour: { pct: 40 },
      weekly: { pct: 40 },
      waves: ["w1", "w2"],
      sampled_at: "2026-10-18T14:00:09.000Z",
    });
  });

  it("an agent that moves to another account or is forgotten leaves the old record", () => {
    let book = fold(emptyBook(), "a1", "w1", sample("work", 40, "2026-10-18T14:00:05.000Z"));
    book = fold(book, "a1", "w1", sample("spare", 5, "2026-10-18T14:00:06.000Z"));
    expect(accountRecords(book).work?.agents).toEqual([]);
    expect(accountRecords(book).spare?.agents).toEqual(["a1"]);
    book = forgetAgent(book, "a1");
    expect(accountRecords(book).spare).toMatchObject({
      agents: [],
      waves: [],
      five_hour: { pct: 5 },
    });
  });
});

describe("rankAccounts", () => {
  const at = "2026-10-18T14:00:00.000Z";
  const three = () => {
    let b = fold(emptyBook(), "a1", "w1", sample("work", 12, at, 40));
    b = fold(b, "a2", null, sample("primary", 60, at, 20));
    return accountRecords(b);
  };

  it("ranks by the smallest headroom of the 5-hour and 7-day windows; no data last", () => {
    const ranked = rankAccounts(three(), ["primary", "work", "fresh"], { now: NOW });
    expect(ranked.map((r) => r.account)).toEqual(["work", "primary", "fresh"]);
    expect(ranked[0]).toEqual({
      account: "work",
      headroom: 60,
      five_hour_pct: 12,
      weekly_pct: 40,
      agents: 1,
    });
    expect(ranked[2]).toEqual({
      account: "fresh",
      headroom: null,
      five_hour_pct: null,
      weekly_pct: null,
      agents: 0,
    });
    expect(mostHeadroom(three(), ["primary", "work", "fresh"], NOW)).toBe("work");
    expect(mostHeadroom(three(), [], NOW)).toBeNull();
  });

  it("counts the model family's weekly window for that model only", () => {
    const recs = three();
    const work = recs.work as (typeof recs)[string];
    work.model_weekly = { fable: { pct: 95, resets_at: "2026-10-21T09:00:00.000Z" } };
    const fable = rankAccounts(recs, ["primary", "work"], { model: "claude-fable-1", now: NOW });
    expect(fable.map((r) => r.account)).toEqual(["primary", "work"]);
    expect(fable[1]).toMatchObject({ headroom: 5, model_weekly_pct: 95 });
    const opus = rankAccounts(recs, ["primary", "work"], { model: "claude-opus-5-5", now: NOW });
    expect(opus.map((r) => r.account)).toEqual(["work", "primary"]);
    expect(opus[0]?.model_weekly_pct).toBeUndefined();
  });

  it("counts a window whose reset has passed as empty", () => {
    let b = fold(emptyBook(), "a1", null, sample("work", 99, at, null));
    b = fold(b, "a2", null, sample("spare", 10, at, null));
    const after = Date.parse(RESETS) + 1;
    expect(rankAccounts(accountRecords(b), ["spare", "work"], { now: after })[0]).toMatchObject({
      account: "spare",
      headroom: 100,
    });
    expect(rankAccounts(accountRecords(b), ["spare", "work"], { now: NOW })[0]?.account).toBe(
      "spare",
    );
  });

  it("breaks a tie on fewer agents, then candidate order; fresh before primary", () => {
    let b = fold(emptyBook(), "a1", null, sample("work", 20, at, 10));
    b = fold(b, "a2", null, sample("work", 20, at, 10));
    b = fold(b, "a3", null, sample("spare", 20, at, 10));
    b = fold(b, "a4", null, sample("other", 20, at, 10));
    const recs = accountRecords(b);
    expect(
      rankAccounts(recs, ["work", "spare", "other"], { now: NOW }).map((r) => r.account),
    ).toEqual(["spare", "other", "work"]);
    expect(rankAccounts(recs, ["primary", "fresh"], { now: NOW }).map((r) => r.account)).toEqual([
      "fresh",
      "primary",
    ]);
  });
});

describe("limitDecisions", () => {
  const book = () => {
    let b = fold(
      emptyBook(),
      "w1-t1-implementer-1",
      "w1",
      sample("work", 91, "2026-10-18T14:00:00.000Z"),
    );
    b = fold(b, "x", null, sample("spare", 12, "2026-10-18T14:00:00.000Z"));
    return b;
  };

  it("opens one account_limit decision per wave on an account at or over the threshold", () => {
    const out = limitDecisions({
      accounts: accountRecords(book()),
      warnAtPct: 90,
      candidates: ["primary", "work", "spare"],
      existing: [],
      now: NOW,
    });
    expect(out).toEqual([
      {
        wave: "w1",
        input: {
          kind: "account_limit",
          task: null,
          question: expect.stringContaining("work is at 91%"),
          options: ["move wave w1 to spare", "not now"],
        },
        extra: { acct: "work", pct: 91, resets_at: RESETS, suggested: "spare" },
      },
    ]);
  });

  it("does not repeat while one is open, nor after an answer for the same window", () => {
    const base = {
      accounts: accountRecords(book()),
      warnAtPct: 90,
      candidates: ["primary", "work", "spare"],
      now: NOW,
    };
    expect(
      limitDecisions({
        ...base,
        existing: [{ wave: "w1", acct: "work", resets_at: null, open: true }],
      }),
    ).toEqual([]);
    expect(
      limitDecisions({
        ...base,
        existing: [{ wave: "w1", acct: "work", resets_at: RESETS, open: false }],
      }),
    ).toEqual([]);
    // answered for an earlier window: this one asks again
    expect(
      limitDecisions({
        ...base,
        existing: [
          { wave: "w1", acct: "work", resets_at: "2026-10-18T09:00:00.000Z", open: false },
        ],
      }),
    ).toHaveLength(1);
  });

  it("stays quiet under the threshold, after the reset, and offers only 'not now' with no other account", () => {
    const base = { candidates: ["work"], existing: [], now: NOW, accounts: accountRecords(book()) };
    expect(limitDecisions({ ...base, warnAtPct: 95 })).toEqual([]);
    expect(limitDecisions({ ...base, warnAtPct: 90, now: Date.parse(RESETS) + 1 })).toEqual([]);
    const [only] = limitDecisions({ ...base, warnAtPct: 90 });
    expect(only?.input.options).toEqual(["not now"]);
    expect(only?.extra.suggested).toBeNull();
  });

  it("does not suggest an account that is itself at or over the threshold", () => {
    const at = "2026-10-18T14:00:00.000Z";
    const base = { candidates: ["work", "spare"], existing: [], now: NOW, warnAtPct: 90 };
    let hot = fold(emptyBook(), "a1", "w1", sample("work", 93, at));
    hot = fold(hot, "x", null, sample("spare", 91, at));
    let weeklyHot = fold(emptyBook(), "a1", "w1", sample("work", 93, at));
    weeklyHot = fold(weeklyHot, "x", null, sample("spare", 10, at, 97));
    for (const b of [hot, weeklyHot]) {
      const out = limitDecisions({ ...base, accounts: accountRecords(b) });
      const mine = out.find((d) => d.extra.acct === "work");
      expect(mine?.input.options).toEqual(["not now"]);
      expect(mine?.extra.suggested).toBeNull();
    }
  });
  it("suggests a signed-in account with no usage yet, labelled so, when none has known headroom", () => {
    const at = "2026-10-18T14:00:00.000Z";
    const b = fold(emptyBook(), "a1", "w1", sample("work", 93, at));
    const [d] = limitDecisions({
      accounts: accountRecords(b),
      warnAtPct: 90,
      candidates: ["primary", "work", "fresh"],
      existing: [],
      now: NOW,
    }).filter((x) => x.extra.acct === "work" && x.wave === "w1");
    // a signed-in profile without a sample, before primary: never moved automatically, only offered
    expect(d?.extra.suggested).toBe("fresh");
    expect(d?.input.options).toEqual(["move wave w1 to fresh", "not now"]);
    expect(d?.input.question).toContain("Move wave w1 to fresh (no usage yet)?");
    expect(d?.input.question).not.toContain("No other account");
  });

  it("offers primary with no usage yet only when no signed-in profile has none either", () => {
    const at = "2026-10-18T14:00:00.000Z";
    const b = fold(emptyBook(), "a1", "w1", sample("work", 93, at));
    const [d] = limitDecisions({
      accounts: accountRecords(b),
      warnAtPct: 90,
      candidates: ["primary", "work"],
      existing: [],
      now: NOW,
    });
    expect(d?.extra.suggested).toBe("primary");
    expect(d?.input.question).toContain("Move wave w1 to primary (no usage yet)?");
  });

  it("never suggests a no-5-hour account whose weekly window is at the threshold", () => {
    const at = "2026-10-18T14:00:00.000Z";
    let b = fold(emptyBook(), "a1", "w1", sample("work", 93, at));
    b = fold(b, "x", null, sample("spent", null, at, 90));
    const [d] = limitDecisions({
      accounts: accountRecords(b),
      warnAtPct: 90,
      candidates: ["work", "spent"],
      existing: [],
      now: NOW,
    });
    expect(d?.extra.suggested).toBeNull();
    expect(d?.input.options).toEqual(["not now"]);
  });

  it("prefers an account with known headroom over one with no usage yet", () => {
    const at = "2026-10-18T14:00:00.000Z";
    let b = fold(emptyBook(), "a1", "w1", sample("work", 93, at));
    b = fold(b, "x", null, sample("spare", 30, at));
    const [d] = limitDecisions({
      accounts: accountRecords(b),
      warnAtPct: 90,
      candidates: ["primary", "work", "spare"],
      existing: [],
      now: NOW,
    });
    expect(d?.extra.suggested).toBe("spare");
    expect(d?.input.question).toContain("Move wave w1 to spare (30%)?");
  });

  it("an account whose sample carried no 5-hour window is offered as no 5-hour usage yet", () => {
    const at = "2026-10-18T14:00:00.000Z";
    let b = fold(emptyBook(), "a1", "w1", sample("work", 93, at));
    b = fold(b, "x", null, sample("spare", null, at, 20));
    const [d] = limitDecisions({
      accounts: accountRecords(b),
      warnAtPct: 90,
      candidates: ["work", "spare"],
      existing: [],
      now: NOW,
    });
    expect(d?.extra.suggested).toBe("spare");
    // it has reported weekly usage, so "no usage yet" would be untrue
    expect(d?.input.question).toContain("Move wave w1 to spare (no 5-hour usage yet)?");
  });
});

describe("limitDecisions under balancing", () => {
  const at = "2026-10-18T14:00:00.000Z";

  it("opens nothing for a balanced wave with one hot account and one roomy one", () => {
    let b = fold(emptyBook(), "a1", "w1", sample("work", 93, at));
    b = fold(b, "a2", "w1", sample("primary", 12, at));
    const out = limitDecisions({
      accounts: accountRecords(b),
      warnAtPct: 90,
      candidates: ["primary", "work"],
      existing: [],
      now: NOW,
      balanced: (w) => w === "w1",
    });
    expect(out).toEqual([]);
  });

  it("opens one decision with no suggestion when every candidate on the machine is hot", () => {
    let b = fold(emptyBook(), "a1", "w1", sample("work", 93, at));
    b = fold(b, "a2", "w1", sample("primary", 95, at));
    const base = {
      accounts: accountRecords(b),
      warnAtPct: 90,
      candidates: ["primary", "work"],
      now: NOW,
      balanced: () => true,
    };
    const out = limitDecisions({ ...base, existing: [] });
    expect(out).toHaveLength(1);
    expect(out[0]?.extra).toEqual({ acct: "work", pct: 93, resets_at: RESETS, suggested: null });
    expect(out[0]?.input.options).toEqual(["not now"]);
    expect(out[0]?.input.question).toContain(
      "every signed-in account on local is at or over 90% of its 5-hour window",
    );
    expect(out[0]?.input.question).toContain("new agents start on the one with the most room");
    // answered for this window: quiet
    expect(
      limitDecisions({
        ...base,
        existing: [{ wave: "w1", acct: "work", resets_at: RESETS, open: false }],
      }),
    ).toEqual([]);
  });

  it("keeps today's move-wave decision for a pinned (unbalanced) wave", () => {
    let b = fold(emptyBook(), "a1", "w1", sample("work", 93, at));
    b = fold(b, "a2", "w2", sample("primary", 12, at));
    const out = limitDecisions({
      accounts: accountRecords(b),
      warnAtPct: 90,
      candidates: ["primary", "work"],
      existing: [],
      now: NOW,
      balanced: (w) => w === "w2",
    });
    expect(out.map((d) => d.input.options)).toEqual([["move wave w1 to primary", "not now"]]);
  });
});

describe("agentLimitDecisions", () => {
  const at = "2026-10-18T14:00:00.000Z";
  const agent = (over: Partial<AgentOnAccount> = {}): AgentOnAccount => ({
    agent_id: "a-1",
    wave: "w1",
    task: "T1",
    role: "implementer",
    acct: "primary",
    model: "claude-opus-5-5",
    machine: "local",
    pinned: false,
    moving: false,
    ...over,
  });
  const records = (primary: [number, number], work: [number, number] = [12, 40]) => {
    let b = fold(emptyBook(), "a-1", "w1", sample("primary", primary[0], at, primary[1]));
    b = fold(b, "x", null, sample("work", work[0], at, work[1]));
    return accountRecords(b);
  };
  const run = (o: Partial<Parameters<typeof agentLimitDecisions>[0]> = {}) =>
    agentLimitDecisions({
      accounts: records([91, 20]),
      agents: [agent()],
      candidates: () => ["primary", "work"],
      warnAtPct: () => 90,
      existing: [],
      now: NOW,
      ...o,
    });

  it("opens one task-level decision suggesting the other login with room", () => {
    const [d, ...rest] = run();
    expect(rest).toEqual([]);
    expect(d?.wave).toBe("w1");
    expect(d?.input).toEqual({
      kind: "agent_account_limit",
      task: "T1",
      question: `Needs you: a-1 (T1/implementer) runs on Claude account primary, at 91% of its 5-hour window (resets ${RESETS}). Move it to work (5h 12%, 7d 40%)? The session restarts with a resume note; the account's window resets at ${RESETS}.`,
      options: ["move a-1 to work", "not now"],
      park: false,
    });
    expect(d?.extra).toEqual({
      agent_id: "a-1",
      role: "implementer",
      acct: "primary",
      window: "five_hour",
      pct: 91,
      resets_at: RESETS,
      suggested: "work",
    });
    const { park: _park, ...input } = d?.input ?? {};
    const errors = schemaErrors(
      "decision.schema.json",
      envelope("_waves/decisions", "decision_opened", {
        decision_id: "agent_account_limit-0123456789ab",
        wave: "w1",
        opened_at: at,
        pointers: {},
        ...input,
        ...d?.extra,
      }),
    );
    expect(errors).toEqual([]);
  });

  it("reads the model family's weekly window for that family only", () => {
    const accounts = records([10, 20]);
    const primary = accounts.primary as (typeof accounts)[string];
    primary.model_weekly = { fable: { pct: 92, resets_at: "2026-10-21T09:00:00.000Z" } };
    const [d] = run({ accounts, agents: [agent({ model: "claude-fable-1" })] });
    expect(d?.extra.window).toBe("model_weekly:fable");
    expect(d?.input.question).toContain("at 92% of its Fable weekly window");
    expect(run({ accounts, agents: [agent({ model: "claude-sonnet-5" })] })).toEqual([]);
  });

  it("suggests nothing when the other login is hot in a window that counts", () => {
    const [d] = run({ accounts: records([91, 20], [12, 95]) });
    expect(d?.extra.suggested).toBeNull();
    expect(d?.input.options).toEqual(["not now"]);
    expect(d?.input.question).toContain("No other signed-in account on local has room");
  });

  it("skips a pinned agent, a moving one, and one already asked about this window", () => {
    expect(run({ agents: [agent({ pinned: true })] })).toEqual([]);
    expect(run({ agents: [agent({ moving: true })] })).toEqual([]);
    const seen = {
      wave: "w1",
      task: "T1",
      role: "implementer",
      acct: "primary",
      window: "five_hour",
      resets_at: RESETS,
    };
    expect(run({ existing: [seen] })).toEqual([]);
    // a new window: asked again
    expect(run({ existing: [{ ...seen, resets_at: "2026-10-18T09:00:00.000Z" }] })).toHaveLength(1);
  });

  it("parses its move answer", () => {
    expect(parseAgentMoveAnswer("move a-1 to work")).toEqual({ agent: "a-1", to: "work" });
    expect(parseAgentMoveAnswer("not now")).toBeNull();
    expect(parseAgentMoveAnswer("move wave w1 to work")).toBeNull();
  });
});

describe("remote hosts", () => {
  const profileOf = (dir: string) => (dir === "/p/spare" ? "spare" : null);

  it("a remote host's agent folds into <acct>@<host>, never the local account of that name", () => {
    const p = sample("primary", 95, "2026-10-18T14:00:00.000Z");
    expect(sampleAccount(p, "local", profileOf)).toBe("primary");
    expect(sampleAccount(p, "gpu-box", profileOf)).toBe("primary@gpu-box");
    // A config_dir is a directory on the agent's own host: only a local one maps to a profile.
    const dirOnly = { ...p, account: null, config_dir: "/p/spare" };
    expect(sampleAccount(dirOnly, "local", profileOf)).toBe("spare");
    expect(sampleAccount(dirOnly, "gpu-box", profileOf)).toBeNull();
  });

  it("a remote host's record opens no account_limit (a wave move cannot reach its agents)", () => {
    const b = fold(
      emptyBook(),
      "w1-t1-implementer-1",
      "w1",
      sample("primary@gpu-box", 95, NOW_ISO),
    );
    expect(
      limitDecisions({
        accounts: accountRecords(b),
        warnAtPct: 90,
        candidates: ["primary"],
        existing: [],
        now: NOW,
      }),
    ).toEqual([]);
  });
});

describe("persistence", () => {
  it("restores the accounts' windows from bookState, without agents", () => {
    let b = fold(emptyBook(), "a1", "w1", sample("spare", 12, "2026-10-18T14:00:00.000Z"));
    b = fold(b, "a2", null, sample("primary@gpu-box", 50, "2026-10-18T14:01:00.000Z", null));
    const back = restoreBook(bookState(b));
    expect(back).toEqual({ agents: {}, accounts: b.accounts });
    expect(accountRecords(back).spare).toMatchObject({ five_hour: { pct: 12 }, agents: [] });
  });

  it("leaves out an unreadable file or entry", () => {
    expect(restoreBook("not json")).toEqual(emptyBook());
    const ok = restoreBook(bookState(fold(emptyBook(), "a", null, sample("spare", 1, NOW_ISO))));
    const text = JSON.stringify({
      version: 1,
      accounts: {
        ...ok.accounts,
        "bad/id": ok.accounts.spare,
        broken: { five_hour: { pct: 300 }, weekly: null, sampled_at: NOW_ISO, sampled_by: "a" },
      },
    });
    expect(Object.keys(restoreBook(text).accounts)).toEqual(["spare"]);
  });
});

describe("wave moves", () => {
  it("parses a move answer", () => {
    expect(parseMoveAnswer("move wave w1 to spare")).toEqual({ wave: "w1", to: "spare" });
    expect(parseMoveAnswer("  Move wave w1 to spare ")).toEqual({ wave: "w1", to: "spare" });
    expect(parseMoveAnswer("not now")).toBeNull();
  });

  it("replays wave_account_moved and maps an account through every move in order", () => {
    const ev = (seq: number, from: string, to: string): JournalEvent => ({
      seq,
      at: "2026-10-18T14:00:00.000Z",
      type: "wave_account_moved",
      data: { from, to, by: "o", decision_id: "d-1" },
    });
    const moves = waveAccountMoves([ev(1, "work", "spare"), ev(2, "spare", "primary")]);
    expect(moves).toEqual([
      { from: "work", to: "spare" },
      { from: "spare", to: "primary" },
    ]);
    expect(waveAccount("work", moves)).toBe("primary");
    expect(waveAccount("other", moves)).toBe("other");
  });

  it("chains only the moves that answered an account_limit, never a wave_account_set", () => {
    const set: JournalEvent = {
      seq: 1,
      at: "2026-10-18T14:00:00.000Z",
      type: "wave_account_moved",
      data: { from: "primary", to: "team", by: "o" },
    };
    expect(waveAccountMoves([set])).toEqual([]);
  });
});

describe("the usage probe (foldProbe)", () => {
  const T = (min: number) => new Date(NOW + min * 60_000).toISOString();
  const w = (pct: number) => ({ pct, resets_at: RESETS });
  const login = (
    min: number,
    reading: { five_hour?: number; weekly?: number; fable?: number } | null,
    state: ProbeState = "ok",
  ): ProbeLogin => ({
    profile: "work",
    state,
    attempted_at: T(min),
    ...(reading !== null
      ? {
          reading: {
            read_at: T(min),
            ...(reading.five_hour !== undefined ? { five_hour: w(reading.five_hour) } : {}),
            ...(reading.weekly !== undefined ? { weekly: w(reading.weekly) } : {}),
            ...(reading.fable !== undefined ? { model_weekly: { fable: w(reading.fable) } } : {}),
          },
        }
      : {}),
  });
  const probe = (book: UsageBook, l: ProbeLogin) =>
    foldProbe(book, { account: "work@peer-a", machine: "peer-a", login: l });
  const sampleAt = (book: UsageBook, pct: number, min: number) =>
    fold(book, "a1", "w1", sample("work@peer-a", pct, T(min)));

  it("the freshest 5-hour window wins between a statusLine sample and a reading, both ways", () => {
    const older = probe(sampleAt(emptyBook(), 10, 0), login(1, { five_hour: 30 }));
    expect(accountRecords(older)["work@peer-a"]?.five_hour?.pct).toBe(30);
    const newer = probe(sampleAt(emptyBook(), 10, 2), login(1, { five_hour: 30 }));
    expect(accountRecords(newer)["work@peer-a"]?.five_hour?.pct).toBe(10);
    const then = sampleAt(probe(emptyBook(), login(1, { five_hour: 30 })), 10, 2);
    expect(accountRecords(then)["work@peer-a"]).toMatchObject({
      five_hour: { pct: 10 },
      sampled_at: T(2),
      sampled_by: "a1",
    });
  });

  it("fills model_weekly.fable and keeps it when a later reading lacks it", () => {
    let b = probe(emptyBook(), login(0, { five_hour: 5, fable: 12 }));
    expect(accountRecords(b)["work@peer-a"]?.model_weekly).toEqual({ fable: w(12) });
    b = probe(b, login(6, { five_hour: 6 }));
    expect(accountRecords(b)["work@peer-a"]).toMatchObject({
      five_hour: { pct: 6 },
      model_weekly: { fable: { pct: 12 } },
      sampled_at: T(6),
    });
  });

  it("probe is the newest attempt, even a failed one; the reading's age stays", () => {
    let b = probe(emptyBook(), login(0, { five_hour: 5, fable: 12 }));
    const { reading } = login(0, { five_hour: 5 });
    b = probe(b, {
      ...login(10, null, "rate_limited"),
      ...(reading !== undefined ? { reading } : {}),
    });
    expect(accountRecords(b)["work@peer-a"]?.probe).toEqual({
      machine: "peer-a",
      state: "rate_limited",
      attempted_at: T(10),
      read_at: T(0),
    });
    // An older attempt arriving late never replaces it.
    b = probe(b, login(5, null, "error"));
    expect(accountRecords(b)["work@peer-a"]?.probe?.state).toBe("rate_limited");
    // A login that never read: probe without read_at, and no windows.
    const never = accountRecords(probe(emptyBook(), login(0, null, "expired")))["work@peer-a"];
    expect(never).toMatchObject({ five_hour: null, weekly: null, sampled_at: T(0) });
    expect(never?.probe).toEqual({ machine: "peer-a", state: "expired", attempted_at: T(0) });
    expect(never).not.toHaveProperty("model_weekly");
    expect(never).not.toHaveProperty("sampled_by");
  });

  it("accountRecords emits model_weekly and probe only when known", () => {
    const r = accountRecords(sampleAt(emptyBook(), 10, 0))["work@peer-a"];
    expect(r).not.toHaveProperty("model_weekly");
    expect(r).not.toHaveProperty("probe");
  });

  it("bookState / restoreBook round-trip model_weekly, probe and an absent sampled_by", () => {
    let b = probe(emptyBook(), login(0, { five_hour: 5, weekly: 7, fable: 12 }));
    b = sampleAt(b, 3, 1);
    b = foldProbe(b, { account: "primary", machine: "box", login: login(2, null, "expired") });
    const back = restoreBook(bookState(b));
    expect(accountRecords(back)).toEqual(
      Object.fromEntries(
        Object.entries(accountRecords(b)).map(([k, v]) => [k, { ...v, agents: [], waves: [] }]),
      ),
    );
    expect(accountRecords(back).primary).not.toHaveProperty("sampled_by");
  });

  it("a record from a reading alone (no sampled_by) validates", () => {
    const rec = accountRecords(probe(emptyBook(), login(0, { five_hour: 5, fable: 12 })))[
      "work@peer-a"
    ];
    const env = envelope("_system/claude-accounts", "claude_account", rec);
    expect(schemaErrors("claude-account.schema.json", env)).toEqual([]);
    expect(
      schemaErrors("claude-account.schema.json", {
        ...env,
        payload: { ...rec, model_weekly: { gpt: w(1) } },
      }),
    ).not.toEqual([]);
  });
});

describe("pruneBook", () => {
  const win = (pct: number) => ({ pct, resets_at: null, at: "2026-10-24T12:00:00.000Z" });
  const acct = (pct: number) => ({
    five_hour: win(pct),
    weekly: null,
    sampled_at: "2026-10-24T12:00:00.000Z",
  });
  const book: UsageBook = {
    agents: {
      a1: { account: "team", wave: "w" },
      a2: { account: "old", wave: "w" },
      a3: { account: "primary@box-a", wave: null },
    },
    accounts: {
      primary: acct(1),
      "primary@box-a": acct(2),
      team: acct(3),
      "team@box-a": acct(4),
      old: acct(5),
      "old@box-b": acct(6),
    },
  };

  it("drops the accounts the registry lacks; keeps primary and primary@<name>; keeps their agents", () => {
    const next = pruneBook(book, new Set(["team", "team@box-a"]));
    expect(Object.keys(next.accounts)).toEqual(["primary", "primary@box-a", "team", "team@box-a"]);
    expect(Object.keys(next.agents)).toEqual(["a1", "a3"]);
    expect(next.accounts.team).toEqual(book.accounts.team);
  });

  it("is the same book when nothing is pruned", () => {
    const all = new Set(["team", "team@box-a", "old", "old@box-b"]);
    expect(pruneBook(book, all)).toBe(book);
  });
});
