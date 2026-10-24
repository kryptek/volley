import { describe, expect, it } from "vitest";
import {
  AGENT_SAMPLE_TTL_MS,
  type AccountUsage,
  type AgentOnAccount,
  LIMIT_HIT_ALARM,
  type ProbeLogin,
  type ProbeState,
  type UsageBook,
  type UsagePayload,
  type UsageWindow,
  accountRecords,
  agentLimitDecisions,
  bookState,
  emptyBook,
  expireAgents,
  foldProbe,
  foldUsage,
  forgetAgent,
  limitDecisions,
  limitHitDecision,
  limitHitResetsAt,
  markLimitHit,
  mostHeadroom,
  parseAgentMoveAnswer,
  parseMoveAnswer,
  parseUsage,
  pruneBook,
  publishedRecord,
  rankAccounts,
  restoreBook,
  roomLeft,
  sampleAccount,
  suggestedMove,
  untilLabel,
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

/** #556's rank options: nothing in flight (the projection is the identity). */
const none = { in_flight: () => 0 };

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
  // #556's rule: nothing in flight, so the projection is the identity
  const o = { now: NOW, cap_pct: 97, tie_band_pct: 10, in_flight: () => 0 };
  const iso = (hours: number) => new Date(NOW + hours * 3.6e6).toISOString();
  /** A window `pct` used whose reset is `resetsInHours` from NOW (`null`: unknown). */
  const win = (pct: number, resetsInHours: number | null): UsageWindow => ({
    pct,
    resets_at: resetsInHours === null ? null : iso(resetsInHours),
  });
  /** Account records with explicit windows and `agents` sampled agents each. */
  const recs = (
    spec: Record<
      string,
      {
        five?: UsageWindow | null;
        weekly?: UsageWindow | null;
        model_weekly?: AccountUsage["model_weekly"];
        agents?: number;
      }
    >,
  ): Record<string, AccountUsage> =>
    Object.fromEntries(
      Object.entries(spec).map(([account, s]) => [
        account,
        {
          account,
          five_hour: s.five ?? null,
          weekly: s.weekly ?? null,
          ...(s.model_weekly !== undefined ? { model_weekly: s.model_weekly } : {}),
          agents: Array.from({ length: s.agents ?? 0 }, (_, i) => `${account}-agent-${i}`),
          waves: [],
          sampled_at: at,
        },
      ]),
    );
  const order = (r: readonly { account: string }[]) => r.map((x) => x.account);
  /** As many agents in flight as each record lists, at no cost (the projection stays the identity). */
  const flying = (accounts: Record<string, AccountUsage>) => ({
    ...o,
    agent_cost_pct_h: 0,
    agent_cost_weekly_pct_h: 0,
    in_flight: (a: string) => accounts[a]?.agents.length ?? 0,
  });

  it("the owner's three accounts: the two whose weekly room expires in an hour go first, split by agents", () => {
    const accounts = recs({
      a: { weekly: win(80, 1), five: win(50, 3), agents: 1 },
      b: { weekly: win(80, 1), five: win(50, 3) },
      c: { weekly: win(80, 144), five: win(10, 3) },
    });
    const ranked = rankAccounts(accounts, ["a", "b", "c"], flying(accounts));
    expect(order(ranked)).toEqual(["b", "a", "c"]);
    const [b, a, c] = ranked;
    expect(c?.binding).toBe("weekly");
    expect(c?.score).toBeLessThan(a?.score as number);
    expect(a?.binding).toBe("five_hour");
    expect(b?.eligible).toBe(true);
  });

  it("a nearly full 5-hour window binds an account whose weekly room is expiring", () => {
    const accounts = recs({
      x: { weekly: win(10, 2), five: win(95, 4) },
      y: { weekly: win(50, 72), five: win(30, 3) },
    });
    const ranked = rankAccounts(accounts, ["x", "y"], o);
    expect(order(ranked)).toEqual(["y", "x"]);
    const x = ranked[1];
    expect(x?.binding).toBe("five_hour");
    expect(x?.eligible).toBe(true);
    expect(x?.score).toBeCloseTo(0.0625, 2);
    expect(ranked[0]?.score).toBeCloseTo(1.17, 1);
  });

  it("within one window kind pace orders as raw headroom per hour (20% left in 1 h beats 80% in 144 h)", () => {
    const weekly = recs({ slow: { weekly: win(20, 144) }, soon: { weekly: win(80, 1) } });
    expect(order(rankAccounts(weekly, ["slow", "soon"], o))).toEqual(["soon", "slow"]);
    const five = recs({ slow: { five: win(20, 4.5) }, soon: { five: win(80, 1) } });
    expect(order(rankAccounts(five, ["slow", "soon"], o))).toEqual(["soon", "slow"]);
  });

  it("the cap: 96.9% is eligible, 97.0% is not, and cap_pct moves the boundary", () => {
    const accounts = recs({
      p: { five: win(96.9, 1) },
      q: { five: win(97, 1) },
      r: { five: win(20, 4) },
    });
    const ranked = rankAccounts(accounts, ["p", "q", "r"], o);
    expect(ranked.at(-1)?.account).toBe("q");
    expect(ranked.find((x) => x.account === "q")?.eligible).toBe(false);
    expect(ranked.find((x) => x.account === "p")?.eligible).toBe(true);
    const at90 = rankAccounts(accounts, ["p", "q", "r"], { ...o, cap_pct: 90 });
    expect(at90[0]?.account).toBe("r");
    expect(
      at90
        .filter((x) => !x.eligible)
        .map((x) => x.account)
        .sort(),
    ).toEqual(["p", "q"]);
  });

  it("any window at the cap makes an account ineligible", () => {
    const accounts = recs({
      hot: { five: win(10, 4), weekly: win(97, 1) },
      cool: { five: win(60, 4), weekly: win(60, 100) },
    });
    const ranked = rankAccounts(accounts, ["hot", "cool"], o);
    expect(order(ranked)).toEqual(["cool", "hot"]);
    expect(ranked[1]?.eligible).toBe(false);
  });

  it("over-cap accounts go by pace too, not by how far over they are", () => {
    // b is further over, but its window resets in 10 minutes; a's must last 4.5 hours
    const accounts = recs({ a: { five: win(97.5, 4.5) }, b: { five: win(99, 10 / 60) } });
    const ranked = rankAccounts(accounts, ["a", "b"], o);
    expect(order(ranked)).toEqual(["b", "a"]);
    expect(ranked.every((x) => !x.eligible)).toBe(true);
  });

  it("every candidate over the cap still ranks by pace, none dropped", () => {
    const accounts = recs({
      a: { five: win(98, 1) },
      b: { five: win(99, 1) },
      c: { five: win(97.5, 1) },
    });
    const ranked = rankAccounts(accounts, ["a", "b", "c"], o);
    expect(order(ranked)).toEqual(["c", "a", "b"]);
    expect(ranked.every((x) => !x.eligible)).toBe(true);
    expect(mostHeadroom(accounts, ["a", "b", "c"], NOW)).toBe("c");
  });

  it("counts a window whose reset has passed as empty and a full window away from its reset", () => {
    let b = fold(emptyBook(), "a1", null, sample("work", 99, at, null));
    b = fold(b, "a2", null, sample("spare", 10, at, null));
    const after = Date.parse(RESETS) + 1;
    const passed = rankAccounts(accountRecords(b), ["spare", "work"], { ...o, now: after });
    expect(passed.find((x) => x.account === "work")).toMatchObject({
      headroom: 100,
      five_hour_pct: 0,
    });
    const fresh = recs({
      ref: { five: { pct: 0, resets_at: new Date(after + 5 * 3.6e6).toISOString() } },
    });
    const ref = rankAccounts(fresh, ["ref"], { ...o, now: after })[0];
    expect(passed.find((x) => x.account === "work")?.score).toBe(ref?.score);
    expect(rankAccounts(accountRecords(b), ["spare", "work"], o)[0]?.account).toBe("spare");
  });

  it("a null resets_at scores as a reset one full window away", () => {
    const score = (r: Record<string, AccountUsage>) => rankAccounts(r, ["n"], o)[0]?.score;
    expect(score(recs({ n: { five: win(40, null) } }))).toBe(
      score(recs({ n: { five: win(40, 5) } })),
    );
    expect(score(recs({ n: { weekly: win(40, null) } }))).toBe(
      score(recs({ n: { weekly: win(40, 168) } })),
    );
  });

  it("a reset in the last seconds has a finite score (the one-minute floor) and ranks first", () => {
    const accounts = recs({
      later: { five: { pct: 95, resets_at: iso(1) } },
      now: { five: { pct: 95, resets_at: new Date(NOW + 10_000).toISOString() } },
    });
    const ranked = rankAccounts(accounts, ["later", "now"], o);
    expect(ranked[0]?.account).toBe("now");
    expect(Number.isFinite(ranked[0]?.score)).toBe(true);
  });

  it("scores within the tie band go to fewer agents; the band is anchored on its leader", () => {
    // 5-hour windows a full window from reset: the score is the room left
    const band = (s: Record<string, [number, number]>) =>
      recs(
        Object.fromEntries(
          Object.entries(s).map(([k, [pct, agents]]) => [k, { five: win(pct, 5), agents }]),
        ),
      );
    const rank = (accounts: Record<string, AccountUsage>, cands: string[]) =>
      order(rankAccounts(accounts, cands, flying(accounts)));
    expect(rank(band({ one: [0, 2], near: [5, 0] }), ["one", "near"])).toEqual(["near", "one"]);
    expect(rank(band({ one: [0, 2], far: [15, 0] }), ["one", "far"])).toEqual(["one", "far"]);
    const three = band({ s100: [0, 2], s92: [8, 1], s85: [15, 0] });
    expect(rank(three, ["s100", "s92", "s85"])).toEqual(["s92", "s100", "s85"]);
  });

  it("an account with no usage data is on pace: after one ahead of pace, before one behind", () => {
    const accounts = recs({ slow: { five: win(50, 5) }, fast: { five: win(60, 1) } });
    const ranked = rankAccounts(accounts, ["slow", "fresh", "fast"], o);
    expect(order(ranked)).toEqual(["fast", "fresh", "slow"]);
    expect(ranked[1]).toMatchObject({ score: null, binding: null, eligible: true, headroom: null });
    expect(order(rankAccounts(accounts, ["primary", "fresh"], o))).toEqual(["fresh", "primary"]);
  });

  it("the model family's weekly window binds for that model only", () => {
    const accounts = three();
    const work = accounts.work as AccountUsage;
    work.model_weekly = { fable: { pct: 95, resets_at: iso(100) } };
    const fable = rankAccounts(accounts, ["primary", "work"], { ...o, model: "claude-fable-1" });
    expect(order(fable)).toEqual(["primary", "work"]);
    expect(fable[1]).toMatchObject({ headroom: 5, model_weekly_pct: 95, binding: "model_weekly" });
    const opus = rankAccounts(accounts, ["primary", "work"], { ...o, model: "claude-opus-5-5" });
    expect(order(opus)).toEqual(["work", "primary"]);
    expect(opus[0]?.model_weekly_pct).toBeUndefined();
    expect(opus[0]?.binding).toBe("five_hour");
  });

  it("returns the full Ranked row; its agents are the ones in flight, not the sampled list", () => {
    const accounts = recs({ c: { weekly: win(80, 144), five: win(10, 3), agents: 2 } });
    expect(rankAccounts(accounts, ["c"], o)[0]).toEqual({
      account: "c",
      headroom: 20,
      five_hour_pct: 10,
      weekly_pct: 80,
      agents: 0,
      score: expect.closeTo((20 * 168) / (100 * 144), 10),
      binding: "weekly",
      eligible: true,
      binding_left: 20,
      binding_resets_at: iso(144),
      in_flight: 0,
      projected_pct: 80,
    });
    expect(rankAccounts(accounts, ["fresh"], o)[0]).toEqual({
      account: "fresh",
      headroom: null,
      five_hour_pct: null,
      weekly_pct: null,
      agents: 0,
      score: null,
      binding: null,
      eligible: true,
      binding_left: null,
      binding_resets_at: null,
      in_flight: 0,
      projected_pct: null,
    });
    expect(mostHeadroom(three(), [], NOW)).toBeNull();
  });

  it("breaks a tie on fewer agents, then candidate order; fresh before primary", () => {
    let b = fold(emptyBook(), "a1", null, sample("work", 20, at, 10));
    b = fold(b, "a2", null, sample("work", 20, at, 10));
    b = fold(b, "a3", null, sample("spare", 20, at, 10));
    b = fold(b, "a4", null, sample("other", 20, at, 10));
    const accounts = accountRecords(b);
    expect(order(rankAccounts(accounts, ["work", "spare", "other"], flying(accounts)))).toEqual([
      "spare",
      "other",
      "work",
    ]);
    expect(order(rankAccounts(accounts, ["primary", "fresh"], o))).toEqual(["fresh", "primary"]);
  });
});

describe("rankAccounts: agents in flight (#557)", () => {
  const at = NOW_ISO;
  const o = {
    now: NOW,
    cap_pct: 97,
    tie_band_pct: 10,
    reserve_h: 1,
    agent_cost_pct_h: 10,
    agent_cost_weekly_pct_h: 1.25,
  };
  const iso = (hours: number) => new Date(NOW + hours * 3.6e6).toISOString();
  const win = (pct: number, hours: number): UsageWindow => ({ pct, resets_at: iso(hours) });
  const recs = (
    spec: Record<string, { five?: UsageWindow; weekly?: UsageWindow }>,
  ): Record<string, AccountUsage> =>
    Object.fromEntries(
      Object.entries(spec).map(([account, s]) => [
        account,
        {
          account,
          five_hour: s.five ?? null,
          weekly: s.weekly ?? null,
          agents: [],
          waves: [],
          sampled_at: at,
        },
      ]),
    );

  /** One spawn pass: `picks` picks, each seeing the ones before it as in flight. */
  const pass = (accounts: Record<string, AccountUsage>, cands: string[], picks: number) => {
    const reserved: Record<string, number> = Object.fromEntries(cands.map((c) => [c, 0]));
    const rows: ReturnType<typeof rankAccounts>[] = [];
    for (let i = 0; i < picks; i++) {
      const ranked = rankAccounts(accounts, cands, {
        ...o,
        in_flight: (a) => reserved[a] ?? 0,
      });
      rows.push(ranked);
      const r = ranked[0];
      if (r === undefined) throw new Error("no pick");
      reserved[r.account] = (reserved[r.account] ?? 0) + 1;
    }
    return { reserved, rows };
  };

  it("twelve spawns in one pass spread over the accounts that fit; the 95% one takes none", () => {
    const accounts = recs({
      hot: { five: win(95, 3), weekly: win(20, 100) },
      mid: { five: win(40, 3), weekly: win(20, 100) },
      cool: { five: win(10, 3), weekly: win(20, 100) },
    });
    const { reserved, rows } = pass(accounts, ["hot", "mid", "cool"], 12);
    expect(reserved.hot).toBe(0);
    expect((reserved.mid ?? 0) + (reserved.cool ?? 0)).toBe(12);
    expect(reserved.mid).toBeLessThanOrEqual(5);
    // after each pick its account's projected 5-hour usage stays under the cap
    const after: Record<string, number> = { hot: 0, mid: 0, cool: 0 };
    for (const ranked of rows) {
      const pick = ranked[0] as (typeof ranked)[number];
      after[pick.account] = (after[pick.account] ?? 0) + 1;
      expect(pick.eligible).toBe(true);
      const sampled = pick.five_hour_pct as number;
      expect(sampled + (after[pick.account] as number) * 10).toBeLessThan(97);
    }
    // the 95% account ranks last from the first pick (its window must last 3 more hours)
    expect(rows[0]?.at(-1)).toMatchObject({ account: "hot", projected_pct: 95, in_flight: 0 });
    // with one agent in flight it projects over the cap: ineligible
    const one = rankAccounts(accounts, ["hot"], { ...o, in_flight: () => 1 })[0];
    expect(one).toMatchObject({ eligible: false, projected_pct: 100, in_flight: 1 });
  });

  it("when nothing fits, every pick is still made and the picks spread", () => {
    const accounts = recs({
      a: { five: win(95, 3) },
      b: { five: win(96, 3) },
      c: { five: win(96, 3) },
    });
    const { reserved, rows } = pass(accounts, ["a", "b", "c"], 12);
    expect(Object.values(reserved).reduce((x, y) => x + y, 0)).toBe(12);
    for (const n of Object.values(reserved)) expect(n).toBeLessThanOrEqual(5);
    // each fits one agent under the cap; from then on every row is over it
    for (const ranked of rows.slice(3)) expect(ranked.every((r) => !r.eligible)).toBe(true);
  });

  it("running agents reduce the projected headroom the score and the cap use", () => {
    const accounts = recs({ work: { five: win(60, 2) } });
    const three = rankAccounts(accounts, ["work"], { ...o, in_flight: () => 3 })[0];
    expect(three).toMatchObject({ projected_pct: 90, in_flight: 3, five_hour_pct: 60 });
    expect(three?.score).toBeCloseTo((10 * 5) / (100 * 2), 10);
    expect(three?.binding_left).toBe(40);
    const none = rankAccounts(accounts, ["work"], { ...o, in_flight: () => 0 })[0];
    expect(none?.score).toBeCloseTo((40 * 5) / (100 * 2), 10);
    expect(none).toMatchObject({ projected_pct: 60, in_flight: 0 });
  });

  it("in flight defaults to the record's sampled agents", () => {
    const accounts = recs({ work: { five: win(60, 2) } });
    (accounts.work as AccountUsage).agents = ["a1", "a2"];
    expect(rankAccounts(accounts, ["work"], o)[0]).toMatchObject({
      agents: 2,
      in_flight: 2,
      projected_pct: 80,
    });
  });

  it("a candidate's agents are its agents in flight, not the sessions its record lists (#562)", () => {
    const accounts = recs({ primary: { five: win(5, 3) } });
    (accounts.primary as AccountUsage).agents = Array.from({ length: 33 }, (_, i) => `c-${i}`);
    expect(rankAccounts(accounts, ["primary"], { ...o, in_flight: () => 0 })[0]).toMatchObject({
      agents: 0,
      in_flight: 0,
      projected_pct: 5,
    });
  });

  it("the tie-break counts agents in flight: 33 sampled and none in flight goes before 1 in flight (#562)", () => {
    const accounts = recs({ a: { five: win(10, 5) }, b: { five: win(10, 5) } });
    (accounts.a as AccountUsage).agents = Array.from({ length: 33 }, (_, i) => `c-${i}`);
    const flight: Record<string, number> = { a: 0, b: 1 };
    const ranked = rankAccounts(accounts, ["b", "a"], {
      ...o,
      agent_cost_pct_h: 0,
      agent_cost_weekly_pct_h: 0,
      in_flight: (x) => flight[x] ?? 0,
    });
    expect(ranked.map((r) => [r.account, r.agents])).toEqual([
      ["a", 0],
      ["b", 1],
    ]);
  });

  it("a window whose reset has passed projects from 0 on a fresh window", () => {
    const accounts = recs({ work: { five: win(90, -1) } });
    const r = rankAccounts(accounts, ["work"], { ...o, in_flight: () => 2 })[0];
    expect(r).toMatchObject({ projected_pct: 20, eligible: true });
  });

  it("the look-ahead is capped by the time to reset", () => {
    const accounts = recs({ work: { five: win(50, 0.5) } });
    expect(rankAccounts(accounts, ["work"], { ...o, in_flight: () => 1 })[0]?.projected_pct).toBe(
      55,
    );
  });

  it("weekly windows reserve the weekly default cost", () => {
    const accounts = recs({ work: { five: win(10, 4), weekly: win(96, 100) } });
    const one = { ...o, in_flight: () => 1 };
    const hot = rankAccounts(accounts, ["work"], one)[0];
    expect(hot).toMatchObject({ eligible: false, binding: "weekly", projected_pct: 97.25 });
    const cheap = rankAccounts(accounts, ["work"], { ...one, agent_cost_weekly_pct_h: 0.5 })[0];
    expect(cheap).toMatchObject({ eligible: true, projected_pct: 96.5 });
  });

  it("an account with no usage data projects nothing", () => {
    expect(rankAccounts({}, ["fresh"], { ...o, in_flight: () => 4 })[0]).toMatchObject({
      in_flight: 4,
      projected_pct: null,
      eligible: true,
      score: null,
    });
  });
});

describe("rate learning (#557)", () => {
  const T = (min: number) => new Date(NOW + min * 60_000).toISOString();
  const five = (pct: number, min: number, resets = RESETS): UsagePayload => ({
    ...sample("work", pct, T(min), null),
    rate_limits: { five_hour: { pct, resets_at: resets } },
  });
  const learn = (book: UsageBook, p: UsagePayload, agents: number) =>
    foldUsage(book, { agent: "a1", wave: "w1", account: "work", payload: p }, agents);
  const rateOf = (b: UsageBook) => accountRecords(b).work?.rates?.five_hour;
  const o = {
    now: NOW + 120 * 60_000,
    cap_pct: 97,
    tie_band_pct: 10,
    reserve_h: 1,
    agent_cost_pct_h: 10,
    agent_cost_weekly_pct_h: 1.25,
    in_flight: () => 1,
  };

  it("two samples an hour apart with two agents teach 10 %/agent-hour; a third blends by EMA", () => {
    let b = learn(emptyBook(), five(30, -60), 2);
    expect(rateOf(b)).toBeUndefined();
    b = learn(b, five(50, 0), 2);
    expect(rateOf(b)).toMatchObject({ pct_per_agent_h: 10, samples: 1, at: T(0) });
    // one observation: the default still applies (10, at a 1-hour look-ahead → 60)
    const once = rankAccounts(accountRecords(b), ["work"], { ...o, now: NOW });
    expect(once[0]?.projected_pct).toBe(60);
    b = learn(b, five(60, 60), 2);
    expect(rateOf(b)?.pct_per_agent_h).toBeCloseTo(10 * 0.7 + 5 * 0.3, 10);
    expect(rateOf(b)?.samples).toBe(2);
    const learned = rankAccounts(accountRecords(b), ["work"], { ...o, now: NOW + 60 * 60_000 });
    expect(learned[0]?.projected_pct).toBeCloseTo(68.5, 10);
  });

  it("does not teach on a short gap, a falling percentage, a new window or no agents", () => {
    const base = learn(learn(emptyBook(), five(30, -60), 2), five(50, 0), 2);
    const seen = rateOf(base);
    // a short gap: no observation, and the comparison point stays (a later sample still teaches)
    const short = learn(base, five(52, 2), 2);
    expect(rateOf(short)).toEqual(seen);
    expect(accountRecords(short).work?.five_hour?.pct).toBe(52);
    expect(rateOf(learn(short, five(60, 60), 2))?.samples).toBe(2);
    for (const next of [
      learn(base, five(40, 60), 2),
      learn(base, five(70, 60, "2026-10-18T23:00:00.000Z"), 2),
      learn(base, five(70, 60), 0),
    ]) {
      expect(rateOf(next)).toEqual(seen);
      // the comparison point moved to the newer sample: an hour later teaches from it
      const kept = next.accounts.work?.five_hour;
      const then = learn(next, five((kept?.pct ?? 0) + 10, 120, kept?.resets_at ?? RESETS), 1);
      expect(rateOf(then)?.samples).toBe(2);
    }
  });

  it("a learned rate is kept across a reset; the projection starts from the fresh window", () => {
    let b = learn(learn(emptyBook(), five(30, -120), 1), five(40, -60), 1);
    b = learn(b, five(50, 0), 1);
    expect(rateOf(b)).toMatchObject({ pct_per_agent_h: 10, samples: 2 });
    const after = Date.parse(RESETS) + 60_000;
    const r = rankAccounts(accountRecords(b), ["work"], { ...o, now: after })[0];
    expect(r?.projected_pct).toBe(10);
    b = learn(b, five(5, 260, "2026-10-18T23:10:00.000Z"), 1);
    expect(rateOf(b)).toMatchObject({ pct_per_agent_h: 10, samples: 2 });
  });

  it("caps an observation at 100 %/agent-hour", () => {
    const b = learn(learn(emptyBook(), five(0, -5), 1), five(100, 0), 1);
    expect(rateOf(b)?.pct_per_agent_h).toBe(100);
  });

  it("probe readings teach the 5-hour and model-family rates", () => {
    const login = (min: number, pct: number): ProbeLogin => ({
      profile: "work",
      state: "ok",
      attempted_at: T(min),
      reading: {
        read_at: T(min),
        five_hour: { pct, resets_at: RESETS },
        model_weekly: { fable: { pct: pct / 2, resets_at: "2026-10-21T09:00:00.000Z" } },
      },
    });
    const probe = (b: UsageBook, l: ProbeLogin) =>
      foldProbe(b, { account: "work", machine: "local", login: l }, 1);
    const b = probe(probe(emptyBook(), login(-60, 20)), login(0, 40));
    const rates = accountRecords(b).work?.rates;
    expect(rates?.five_hour).toMatchObject({ pct_per_agent_h: 20, samples: 1 });
    expect(rates?.["model_weekly.fable"]).toMatchObject({ pct_per_agent_h: 10, samples: 1 });
  });

  it("learned rates survive a restart; an older book restores without them", () => {
    const b = learn(learn(emptyBook(), five(30, -60), 2), five(50, 0), 2);
    const back = restoreBook(bookState(b));
    expect(accountRecords(back).work?.rates).toEqual(accountRecords(b).work?.rates);
    // the comparison point is kept too: the next sample an hour on teaches
    expect(rateOf(learn(back, five(60, 60), 2))?.samples).toBe(2);
    // a book written before #557: no rates, no comparison points
    const old = JSON.parse(bookState(b), (k, v) =>
      k === "rates" || k === "rate_base" ? undefined : v,
    ) as { accounts: Record<string, Record<string, unknown>> };
    expect(old.accounts.work).not.toHaveProperty("rates");
    const restored = restoreBook(JSON.stringify(old));
    expect(restored.accounts.work).toBeDefined();
    expect(accountRecords(restored).work).not.toHaveProperty("rates");
    const corrupt = JSON.parse(bookState(b)) as typeof old;
    (corrupt.accounts.work as Record<string, unknown>).rates = {
      five_hour: { pct_per_agent_h: "fast", samples: 1, at: T(0) },
      weekly: { pct_per_agent_h: 1, samples: 2, at: T(0) },
    };
    const kept = restoreBook(JSON.stringify(corrupt));
    expect(kept.accounts.work?.five_hour?.pct).toBe(50);
    expect(accountRecords(kept).work?.rates).toEqual({
      weekly: { pct_per_agent_h: 1, samples: 2, at: T(0) },
    });
  });

  it("the published claude_account record leaves the rates out and validates", () => {
    const b = learn(learn(emptyBook(), five(30, -60), 2), five(50, 0), 2);
    const rec = accountRecords(b).work as AccountUsage;
    expect(rec.rates).toBeDefined();
    const pub = publishedRecord(rec);
    expect(pub).not.toHaveProperty("rates");
    const env = envelope("_system/claude-accounts", "claude_account", pub);
    expect(schemaErrors("claude-account.schema.json", env)).toEqual([]);
  });
});

describe("untilLabel", () => {
  it("prints the two largest units, dropping a zero second one", () => {
    const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
    expect(untilLabel(at(52), NOW)).toBe("52m");
    expect(untilLabel(at(250), NOW)).toBe("4h 10m");
    expect(untilLabel(at(240), NOW)).toBe("4h");
    expect(untilLabel(at(52 * 60), NOW)).toBe("2d 4h");
    expect(untilLabel(at(3 * 1440), NOW)).toBe("3d");
  });

  it("is null when no future reset is known: never `now` or `unknown` (#562)", () => {
    expect(untilLabel(new Date(NOW - 60_000).toISOString(), NOW)).toBeNull();
    expect(untilLabel(new Date(NOW).toISOString(), NOW)).toBeNull();
    expect(untilLabel(null, NOW)).toBeNull();
    expect(untilLabel("garbage", NOW)).toBeNull();
  });
});

describe("roomLeft (#562)", () => {
  const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
  it("prints the room without a time when no future reset is known", () => {
    expect(roomLeft("5h", 100, null, NOW)).toBe("5h unused");
    expect(roomLeft("5h", 100, at(-5), NOW)).toBe("5h unused");
    expect(roomLeft("7d", 68, null, NOW)).toBe("7d 68% left");
    expect(roomLeft("5h", 99.8, null, NOW)).toBe("5h unused");
  });

  it("keeps the countdown for a future reset", () => {
    expect(roomLeft("5h", 18, at(52), NOW)).toBe("5h 18% left in 52m");
    expect(roomLeft("5h", 100, at(52), NOW)).toBe("5h 100% left in 52m");
  });
});

describe("agent expiry (#562)", () => {
  const T = (min: number) => new Date(NOW + min * 60_000).toISOString();
  const book = () => {
    let b = fold(emptyBook(), "coordinator-ab12", null, sample("primary", 5, T(-61)));
    b = fold(b, "edge", null, sample("primary", 5, T(-60)));
    b = fold(b, "young", null, sample("primary", 5, T(-10)));
    b = fold(b, "w1-t1-implementer-1", "w1", sample("work", 30, T(-120)));
    return b;
  };

  it("foldUsage records the sample time on the agent's entry; a later sample replaces it, an older one does not", () => {
    let b = fold(emptyBook(), "a1", null, sample("work", 5, T(-30)));
    expect(b.agents.a1?.sampled_at).toBe(T(-30));
    b = fold(b, "a1", null, sample("work", 6, T(-5)));
    expect(b.agents.a1?.sampled_at).toBe(T(-5));
    b = fold(b, "a1", null, sample("work", 4, T(-20)));
    expect(b.agents.a1?.sampled_at).toBe(T(-5));
  });

  it("records the topic's namespace when the sample gives one", () => {
    const p = sample("work", 5, T(-30));
    const b = foldUsage(emptyBook(), {
      agent: "a1",
      wave: null,
      account: "work",
      payload: p,
      ns: "lab",
    });
    expect(b.agents.a1?.ns).toBe("lab");
  });

  it("drops an agent whose sample is older than the bound, unless keep names it; the accounts stay", () => {
    const b = book();
    const next = expireAgents(b, NOW, (id) => id === "w1-t1-implementer-1");
    expect(Object.keys(next.agents).sort()).toEqual(["edge", "w1-t1-implementer-1", "young"]);
    expect(next.accounts).toBe(b.accounts);
    expect(accountRecords(next).primary?.agents).toEqual(["edge", "young"]);
    expect(accountRecords(next).work).toMatchObject({
      agents: ["w1-t1-implementer-1"],
      waves: ["w1"],
    });
    const all = expireAgents(b, NOW, () => false);
    expect(Object.keys(all.agents).sort()).toEqual(["edge", "young"]);
    expect(accountRecords(all).work).toMatchObject({
      agents: [],
      waves: [],
      five_hour: { pct: 30 },
    });
  });

  it("is the same book when nothing goes; the bound is an hour", () => {
    expect(AGENT_SAMPLE_TTL_MS).toBe(60 * 60_000);
    const b = fold(emptyBook(), "young", null, sample("primary", 5, T(-10)));
    expect(expireAgents(b, NOW, () => false)).toBe(b);
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
    // 5% used with 4 h to go: well ahead of pace, so it outranks an account with no usage yet
    b = fold(b, "x", null, sample("spare", 5, "2026-10-18T14:00:00.000Z"));
    return b;
  };

  it("opens one account_limit decision per wave on an account at or over the threshold", () => {
    const out = limitDecisions({
      accounts: accountRecords(book()),
      warnAtPct: 90,
      candidates: ["primary", "work", "spare"],
      existing: [],
      now: NOW,
      balance: none,
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

  it("prefers an account ahead of pace over one with no usage yet (on pace), not one behind it", () => {
    const at = "2026-10-18T14:00:00.000Z";
    let b = fold(emptyBook(), "a1", "w1", sample("work", 93, at));
    b = fold(b, "x", null, sample("behind", 30, at));
    const behind = limitDecisions({
      accounts: accountRecords(b),
      warnAtPct: 90,
      candidates: ["primary", "work", "behind"],
      existing: [],
      now: NOW,
      balance: none,
    })[0];
    expect(behind?.extra.suggested).toBe("primary");
    b = fold(b, "y", null, sample("spare", 5, at));
    const [d] = limitDecisions({
      accounts: accountRecords(b),
      warnAtPct: 90,
      candidates: ["primary", "work", "spare"],
      existing: [],
      now: NOW,
      balance: none,
    });
    expect(d?.extra.suggested).toBe("spare");
    expect(d?.input.question).toContain("Move wave w1 to spare (5%)?");
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
    expect(out[0]?.input.question).toContain(
      "new agents start on the one the balance puts first (work, 93%)",
    );
    // answered for this window: quiet
    expect(
      limitDecisions({
        ...base,
        existing: [{ wave: "w1", acct: "work", resets_at: RESETS, open: false }],
      }),
    ).toEqual([]);
  });

  it("names the account the spawns' own claude.balance puts first, not the defaults'", () => {
    // primary's weekly window is at 97.5%: over the default cap, under a 99% one
    let b = fold(emptyBook(), "a1", "w1", sample("work", 96, at));
    b = fold(b, "a2", "w1", sample("primary", 91, at, 97.5));
    const base = {
      accounts: accountRecords(b),
      warnAtPct: 90,
      candidates: ["primary", "work"],
      existing: [],
      now: NOW,
      balanced: () => true,
      balance: none,
    };
    expect(limitDecisions(base)[0]?.extra.acct).toBe("work");
    const out = limitDecisions({ ...base, balance: { ...none, cap_pct: 99, tie_band_pct: 10 } });
    expect(out[0]?.extra.acct).toBe("primary");
    expect(out[0]?.input.question).toContain("the one the balance puts first (primary, 91%)");
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

describe("suggestedMove", () => {
  const at = "2026-10-18T14:00:00.000Z";
  const records = (work: [number, number], spare: [number, number] = [50, 50]) => {
    let b = fold(emptyBook(), "a-1", "w1", sample("primary", 100, at, 20));
    b = fold(b, "x", null, sample("work", work[0], at, work[1]));
    b = fold(b, "y", null, sample("spare", spare[0], at, spare[1]));
    return accountRecords(b);
  };
  const run = (accounts = records([12, 40]), candidates = ["primary", "work", "spare"]) =>
    suggestedMove({
      accounts,
      acct: "primary",
      candidates,
      model: "claude-opus-5-5",
      warnAtPct: 90,
      now: NOW,
    });

  it("is the ranker's first pick among the other candidates under the level, never the account itself", () => {
    const accounts = records([12, 40]);
    const best = run(accounts);
    expect(best?.account).toBe("work");
    expect(best).toEqual(
      rankAccounts(accounts, ["work", "spare"], { model: "claude-opus-5-5", now: NOW })[0],
    );
    expect(run(accounts, ["primary"])).toBeUndefined();
  });

  it("leaves out a candidate at the level in a window that counts", () => {
    expect(run(records([12, 95]))?.account).toBe("spare");
    expect(run(records([12, 95], [91, 10]))).toBeUndefined();
  });
});

describe("markLimitHit", () => {
  const at = "2026-10-18T14:00:00.000Z";
  const later = "2026-10-18T14:05:00.000Z";

  it("sets the 5-hour window to 100 with the book's future reset", () => {
    const b = fold(emptyBook(), "a-1", "w1", sample("primary", 88, at));
    const m = markLimitHit(b, { account: "primary", at: later });
    expect(m.accounts.primary?.five_hour).toEqual({ pct: 100, resets_at: RESETS, at: later });
    // the other windows and the agents stay
    expect(m.accounts.primary?.weekly).toEqual(b.accounts.primary?.weekly);
    expect(m.agents).toEqual(b.agents);
    expect(LIMIT_HIT_ALARM).toBe("account_limit_hit");
  });

  it("falls back to at + 5 h when the book has no reset or a passed one", () => {
    const fiveH = new Date(Date.parse(later) + 5 * 3_600_000).toISOString();
    expect(markLimitHit(emptyBook(), { account: "work", at: later }).accounts.work).toMatchObject({
      five_hour: { pct: 100, resets_at: fiveH, at: later },
      weekly: null,
      sampled_at: later,
    });
    const past = fold(emptyBook(), "a-1", "w1", {
      ...sample("primary", 88, at),
      rate_limits: { five_hour: { pct: 88, resets_at: "2026-10-18T13:00:00.000Z" } },
    });
    expect(
      markLimitHit(past, { account: "primary", at: later }).accounts.primary?.five_hour,
    ).toEqual({ pct: 100, resets_at: fiveH, at: later });
  });

  it("a newer real sample replaces it, an older one does not; it survives bookState", () => {
    const b = fold(emptyBook(), "a-1", "w1", sample("primary", 88, at));
    const m = markLimitHit(b, { account: "primary", at: later });
    expect(fold(m, "a-1", "w1", sample("primary", 90, at)).accounts.primary?.five_hour?.pct).toBe(
      100,
    );
    expect(
      fold(m, "a-1", "w1", sample("primary", 3, "2026-10-18T14:10:00.000Z")).accounts.primary
        ?.five_hour?.pct,
    ).toBe(3);
    expect(restoreBook(bookState(m)).accounts).toEqual(m.accounts);
  });

  it("is applied even when the window it replaces is stamped after `at` (a clock running ahead)", () => {
    const ahead = "2026-10-18T14:20:00.000Z";
    const b = fold(emptyBook(), "a-1", "w1", sample("primary", 88, ahead));
    const m = markLimitHit(b, { account: "primary", at: later });
    expect(m.accounts.primary?.five_hour).toEqual({ pct: 100, resets_at: RESETS, at: ahead });
    expect(limitHitResetsAt(b, { account: "primary", at: later })).toBe(RESETS);
    expect(
      fold(m, "a-1", "w1", sample("primary", 3, "2026-10-18T14:30:00.000Z")).accounts.primary
        ?.five_hour?.pct,
    ).toBe(3);
  });

  it("counts as empty once its reset has passed", () => {
    const m = markLimitHit(emptyBook(), { account: "primary", at: later });
    const rec = accountRecords(m);
    const after = Date.parse(later) + 5 * 3_600_000 + 1;
    expect(rankAccounts(rec, ["primary"], { now: Date.parse(later) })[0]?.five_hour_pct).toBe(100);
    expect(rankAccounts(rec, ["primary"], { now: after })[0]?.five_hour_pct).toBe(0);
  });
});

describe("limitHitDecision", () => {
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
  const records = (work: [number, number] = [12, 40]) => {
    let b = fold(emptyBook(), "a-1", "w1", sample("primary", 88, at, 20));
    b = markLimitHit(b, { account: "primary", at });
    b = fold(b, "x", null, sample("work", work[0], at, work[1]));
    return accountRecords(b);
  };
  const run = (o: Partial<Parameters<typeof limitHitDecision>[0]> = {}) =>
    limitHitDecision({
      accounts: records(),
      agent: agent(),
      candidates: ["primary", "work"],
      warnAtPct: 90,
      resets_at: RESETS,
      source: "hook",
      text: "You've hit your limit",
      now: NOW,
      ...o,
    });

  it("offers the move to the ranker's pick, with the limit-hit extras", () => {
    const d = run();
    expect(d?.input).toEqual({
      kind: "agent_account_limit",
      task: "T1",
      question: `Needs you: a-1 (T1/implementer) hit the usage limit of Claude account primary (the hooks reported a usage-limit prompt). Move it to work (5h 12%, 7d 40%)? The session restarts with a resume note. not now: it waits at the prompt and resumes by itself when the window resets at ${RESETS}.`,
      options: ["move a-1 to work", "not now"],
      park: false,
      pointers: {},
    });
    expect(d?.extra).toEqual({
      agent_id: "a-1",
      role: "implementer",
      acct: "primary",
      window: "five_hour",
      pct: 100,
      resets_at: RESETS,
      suggested: "work",
      class: "credit_exhausted",
      source: "hook",
      text: "You've hit your limit",
    });
    const { park: _park, ...input } = d?.input ?? {};
    expect(
      schemaErrors(
        "decision.schema.json",
        envelope("_waves/decisions", "decision_opened", {
          decision_id: "agent_account_limit-0123456789ab",
          wave: "w1",
          opened_at: at,
          ...input,
          ...d?.extra,
        }),
      ),
    ).toEqual([]);
  });

  it("keeps the screen capture pointer of a screen detection", () => {
    const d = run({ source: "screen", text: null, screen: "/path/to/capture.txt" });
    expect(d?.input.pointers).toEqual({ screen: "/path/to/capture.txt" });
    expect(d?.input.question).toContain("(a usage-limit prompt is on its screen)");
    expect(d?.extra).toMatchObject({ source: "screen" });
    expect(d?.extra).not.toHaveProperty("text");
  });

  it("names a pin it cannot honour", () => {
    const d = run({ agent: agent({ pinned: true }) });
    expect(d?.input.question).toContain(
      "Its task is pinned to primary, which is at its limit: the pin cannot be honoured.",
    );
  });

  it("is null with no other account with room (the caller opens model_switch)", () => {
    expect(run({ accounts: records([95, 40]) })).toBeNull();
    expect(run({ candidates: ["primary"] })).toBeNull();
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
      a1: { account: "team", wave: "w", sampled_at: "2026-10-24T12:00:00.000Z" },
      a2: { account: "old", wave: "w", sampled_at: "2026-10-24T12:00:00.000Z" },
      a3: { account: "primary@box-a", wave: null, sampled_at: "2026-10-24T12:00:00.000Z" },
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
