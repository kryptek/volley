import { describe, expect, it } from "vitest";
import {
  type UsageBook,
  type UsagePayload,
  accountRecords,
  bookState,
  emptyBook,
  foldUsage,
  forgetAgent,
  limitDecisions,
  mostHeadroom,
  parseMoveAnswer,
  parseUsage,
  restoreBook,
  sampleAccount,
  waveAccount,
  waveAccountMoves,
} from "../../src/claude/usage";
import type { JournalEvent } from "../../src/types";

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

describe("mostHeadroom", () => {
  it("picks the candidate with the lowest 5-hour percentage", () => {
    let book = fold(emptyBook(), "a1", "w1", sample("work", 80, "2026-10-18T14:00:00.000Z"));
    book = fold(book, "a2", null, sample("spare", 12, "2026-10-18T14:00:00.000Z"));
    book = fold(book, "a3", null, sample("primary", 30, "2026-10-18T14:00:00.000Z"));
    const recs = accountRecords(book);
    expect(mostHeadroom(recs, ["primary", "work", "spare"], NOW)).toBe("spare");
    expect(mostHeadroom(recs, ["primary", "work"], NOW)).toBe("primary");
    // a candidate without usage data is not ranked; no data at all: no answer
    expect(mostHeadroom(recs, ["other"], NOW)).toBeNull();
  });

  it("counts a window whose reset has passed as empty", () => {
    const book = fold(emptyBook(), "a1", null, sample("work", 99, "2026-10-18T14:00:00.000Z"));
    const book2 = fold(book, "a2", null, sample("spare", 10, "2026-10-18T14:00:00.000Z"));
    const after = Date.parse(RESETS) + 1;
    expect(mostHeadroom(accountRecords(book2), ["work", "spare"], after)).toBe("work");
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
    // the first candidate without a sample: never moved automatically, only offered
    expect(d?.extra.suggested).toBe("primary");
    expect(d?.input.options).toEqual(["move wave w1 to primary", "not now"]);
    expect(d?.input.question).toContain("Move wave w1 to primary (no usage yet)?");
    expect(d?.input.question).not.toContain("No other account");
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

  it("an account whose sample carried no 5-hour window counts as no usage yet", () => {
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
    expect(d?.input.question).toContain("(no usage yet)");
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
});
