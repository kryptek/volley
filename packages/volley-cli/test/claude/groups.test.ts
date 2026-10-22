import { describe, expect, it } from "vitest";
import {
  type ListResult,
  type UsageRecord,
  groupAccounts,
  renderGroups,
} from "../../src/claude/groups";

const EMAIL = "owner@example.com";

// The Desk's fixtures (its claude-groups test): the same login as `work` here and as peer-a's
// default login, their 5-hour readings differing and the peer's six minutes older.
const work: UsageRecord = {
  account: "work",
  label: "Work",
  plan: "max",
  email: EMAIL,
  org: "Example Org",
  five_hour: { pct: 37, resets_at: "2026-10-18T18:10:00.000Z" },
  weekly: { pct: 56, resets_at: "2026-10-21T09:00:00.000Z" },
  agents: ["w1-t1-implementer-1"],
  waves: ["w1"],
  sampled_at: "2026-10-18T14:06:00.000Z",
};

const peer: UsageRecord = {
  account: "primary@peer-a",
  five_hour: { pct: 41, resets_at: null },
  weekly: { pct: 56, resets_at: "2026-10-21T09:00:00.000Z" },
  agents: ["w2-t1-implementer-1"],
  waves: ["w2"],
  sampled_at: "2026-10-18T14:00:00.000Z",
};

const result = (over: Partial<ListResult> = {}): ListResult => ({
  root: "/srv/claude",
  accounts: [
    {
      id: "work",
      label: "Work",
      machine: "local",
      plan: "max",
      email: EMAIL,
      org: "Example Org",
      dir: "/srv/claude/work",
      signin: { state: "signed_in" },
    },
  ],
  primary: {},
  machines: [
    { name: "hub", kind: "supervisor", claude: "signed_in", email: "other@example.com" },
    { name: "peer-a", kind: "peer", claude: "signed_in", email: "Owner@Example.com" },
  ],
  sharing: { "settings.json": "copy", mcp: "copy" },
  ...over,
});

describe("groupAccounts", () => {
  it("one e-mail on two machines is one group; the freshest reading wins, the other is stale", () => {
    const [g, ...rest] = groupAccounts(result(), [work, peer]);
    expect(rest).toEqual([]);
    expect(g?.key).toBe(EMAIL);
    expect(g?.email).toBe(EMAIL);
    expect(g?.label).toBe("Work");
    expect(g?.plan).toBe("max");
    expect(g?.org).toBe("Example Org");
    expect(g?.fiveHour).toEqual({
      account: "work",
      machine: "local",
      window: "five_hour",
      pct: 37,
      resets_at: work.five_hour?.resets_at,
      sampledAt: work.sampled_at,
    });
    expect(g?.weekly?.machine).toBe("local");
    // The weekly readings agree (same pct, same reset): only the 5-hour is stale.
    expect(g?.stale).toEqual([
      {
        account: "primary@peer-a",
        machine: "peer-a",
        window: "five_hour",
        pct: 41,
        resets_at: null,
        sampledAt: peer.sampled_at,
      },
    ]);
    expect(g?.members.map((m) => [m.machine, m.label, m.state, m.waves])).toEqual([
      ["local", "work", "signed_in", ["w1"]],
      ["peer-a", "default login", "signed_in", ["w2"]],
    ]);
  });

  it("the newer sample wins even when it is a peer's", () => {
    const newer = { ...peer, sampled_at: "2026-10-18T14:10:00.000Z" };
    const [g] = groupAccounts(result(), [work, newer]);
    expect(g?.fiveHour?.machine).toBe("peer-a");
    expect(g?.stale.map((s) => [s.machine, s.window])).toEqual([["local", "five_hour"]]);
  });

  it("a same-time tie goes to the reading with a known reset", () => {
    const tie = { ...peer, sampled_at: work.sampled_at, five_hour: { pct: 37, resets_at: null } };
    const [g] = groupAccounts(result(), [tie, work]);
    expect(g?.fiveHour?.machine).toBe("local");
  });

  it("a row without an e-mail is a group of its own, keyed by its id", () => {
    const r = result({
      accounts: [
        ...result().accounts,
        { id: "spare", label: "Spare", machine: "local", signin: { state: "signed_out" } },
      ],
    });
    const out = groupAccounts(r, [work, peer]);
    expect(out.map((g) => [g.key, g.email])).toEqual([
      [EMAIL, EMAIL],
      ["spare", null],
    ]);
    expect(out[1]?.members.map((m) => m.state)).toEqual(["signed_out"]);
  });

  it("a machine signed in with an e-mail but no usage record joins as a member with no usage", () => {
    const [g, ...rest] = groupAccounts(result(), [work]);
    expect(rest).toEqual([]);
    expect(g?.members.map((m) => m.account)).toEqual(["work", "primary@peer-a"]);
    expect(g?.stale).toEqual([]);
    expect(g?.fiveHour?.machine).toBe("local");
  });

  it("the supervisor's own machine record is never a peer member", () => {
    const out = groupAccounts(result(), [work]);
    expect(out.flatMap((g) => g.members.map((m) => m.machine))).not.toContain("hub");
  });

  it("this machine's default login joins by the primary's e-mail", () => {
    const primary: UsageRecord = { ...peer, account: "primary", sampled_at: work.sampled_at };
    const [g] = groupAccounts(result({ primary: { plan: "max", email: EMAIL } }), [work, primary]);
    expect(g?.members.map((m) => [m.account, m.machine, m.label])).toEqual([
      ["work", "local", "work"],
      ["primary", "local", "default login"],
      ["primary@peer-a", "peer-a", "default login"],
    ]);
  });

  it("a profile on a paired machine matches its record as <id>@<machine>", () => {
    const r = result({
      accounts: [
        {
          id: "work",
          label: "Work",
          machine: "peer-b",
          email: EMAIL,
          signin: { state: "signed_in" },
        },
      ],
      machines: [],
    });
    const rec = { ...work, account: "work@peer-b" };
    const [g, ...rest] = groupAccounts(r, [rec]);
    expect(rest).toEqual([]);
    expect(g?.members.map((m) => [m.account, m.machine])).toEqual([["work@peer-b", "peer-b"]]);
    expect(g?.fiveHour?.machine).toBe("peer-b");
  });
});

describe("groupAccounts › the machines missing an account", () => {
  const peerB = { name: "peer-b", kind: "peer", claude: "signed_out" };

  it("names each configured machine with no login on the group, this machine first", () => {
    const [g] = groupAccounts(result({ machines: [...(result().machines ?? []), peerB] }), [work]);
    expect(g?.missing).toEqual(["peer-b"]);
    const r = result({
      accounts: [],
      machines: [{ name: "peer-a", kind: "peer", claude: "signed_in", email: EMAIL }, peerB],
    });
    expect(groupAccounts(r, [])[0]?.missing).toEqual(["local", "peer-b"]);
  });

  it("a group on every machine misses none; the supervisor's own record is not a peer", () => {
    expect(groupAccounts(result(), [work])[0]?.missing).toEqual([]);
  });
});

describe("renderGroups", () => {
  const NOW = Date.parse("2026-10-18T14:08:00.000Z");

  it("prints `not on:` under a group missing a configured machine, nothing when complete", () => {
    const peerB = { name: "peer-b", kind: "peer", claude: "signed_out" };
    const gap = renderGroups(
      groupAccounts(result({ machines: [...(result().machines ?? []), peerB] }), [work, peer]),
      { now: NOW, showEmail: false },
    );
    expect(gap).toMatch(/peer-a +default login[^\n]*\n {2}not on: peer-b\n/);
    const full = renderGroups(groupAccounts(result(), [work, peer]), {
      now: NOW,
      showEmail: false,
    });
    expect(full).not.toContain("not on:");
  });

  it("a group missing this machine says so by name", () => {
    const r = result({
      accounts: [],
      machines: [{ name: "peer-a", kind: "peer", claude: "signed_in", email: EMAIL }],
    });
    expect(renderGroups(groupAccounts(r, []), { now: NOW, showEmail: false })).toContain(
      "  not on: this machine\n",
    );
  });

  it("masks the e-mail unless asked, and prints machines, usage and stale readings", () => {
    const text = renderGroups(groupAccounts(result(), [work, peer]), {
      now: NOW,
      showEmail: false,
    });
    expect(text).toContain("Work · max · Example Org · o•••@example.com");
    expect(text).not.toContain(EMAIL);
    expect(text).toContain(
      "  5-hour 37% (resets in 4h 2m) · 7-day 56% (resets in 2d 18h) · Fable — (not read yet)\n  freshest: this machine, 2 min ago\n",
    );
    expect(text).toMatch(/this machine +work +signed in +waves: w1\n/);
    expect(text).toMatch(
      /peer-a +default login +signed in +waves: w2 +5-hour 41% 8 min old \(stale\)/,
    );
  });

  it("shows the e-mail with showEmail", () => {
    const text = renderGroups(groupAccounts(result(), [work]), { now: NOW, showEmail: true });
    expect(text).toContain(`Work · max · Example Org · ${EMAIL}`);
  });

  it("an account with no usage and one with no e-mail", () => {
    const r = result({
      accounts: [
        {
          id: "personal",
          label: "Personal",
          machine: "local",
          plan: "pro",
          email: "p@example.com",
          signin: { state: "signed_out" },
        },
        {
          id: "spare",
          label: "Spare",
          machine: "local",
          signin: { state: "pending", url: "https://x" },
        },
      ],
      machines: [],
    });
    const text = renderGroups(groupAccounts(r, []), { now: NOW, showEmail: false });
    expect(text).toContain(
      "Personal · pro · p•••@example.com\n  5-hour — · 7-day — · Fable — (not read yet)\n",
    );
    expect(text).toMatch(/this machine +personal +signed out/);
    expect(text).toContain("spare (e-mail not reported yet)");
    expect(text).toContain("    sign in: https://x");
  });

  it("a group of default logins only is headed `default login`, its e-mail still masked", () => {
    const r = result({
      accounts: [],
      primary: { email: "Owner@Example.com", plan: "max" },
      machines: [{ name: "peer-a", kind: "peer", claude: "signed_in", email: EMAIL }],
    });
    const text = renderGroups(groupAccounts(r, []), { now: NOW, showEmail: false });
    expect(text.toLowerCase()).not.toContain(EMAIL);
    expect(text).toContain("default login · max · O•••@Example.com\n");
  });

  it("a reading whose sampled_at does not parse prints `? ago`, never NaN", () => {
    const bad = { ...work, sampled_at: "not a time" };
    const text = renderGroups(groupAccounts(result({ machines: [] }), [bad]), {
      now: NOW,
      showEmail: false,
    });
    expect(text).not.toContain("NaN");
    expect(text).toContain("freshest: this machine, ? ago");
  });

  describe("the Fable window", () => {
    const at = (min: number) => new Date(NOW - min * 60_000).toISOString();
    const fable = {
      pct: 12,
      resets_at: new Date(NOW + (4 * 24 + 2) * 3_600_000 + 30_000).toISOString(),
    };
    const line = (records: UsageRecord[]) =>
      renderGroups(groupAccounts(result(), records), { now: NOW, showEmail: false });

    it("prints the probe's Fable reading with its reset and age", () => {
      const probed: UsageRecord = {
        ...work,
        model_weekly: { fable },
        probe: { machine: "hub", state: "ok", attempted_at: at(4), read_at: at(4) },
      };
      expect(line([probed, peer])).toContain(
        "  5-hour 37% (resets in 4h 2m) · 7-day 56% (resets in 2d 18h) · Fable 12% (resets in 4d 2h, read 4 min ago)\n",
      );
    });

    it("an ok read beats a newer failed attempt on another machine", () => {
      const ok: UsageRecord = {
        ...work,
        model_weekly: { fable },
        probe: { machine: "hub", state: "ok", attempted_at: at(2), read_at: at(2) },
      };
      const failed: UsageRecord = {
        ...peer,
        probe: { machine: "peer-a", state: "error", attempted_at: at(1) },
      };
      const [g] = groupAccounts(result(), [ok, failed]);
      expect(g?.probe).toEqual({
        machine: "local",
        state: "ok",
        attemptedAt: at(2),
        readAt: at(2),
      });
      expect(g?.fable).toEqual(fable);
    });

    it("takes the figure from the login whose probe it reports, not another's", () => {
      // peer-a carries a Fable window but no probe; the hub's probe read, with no window.
      const unprobed: UsageRecord = { ...peer, sampled_at: at(1), model_weekly: { fable } };
      const probed: UsageRecord = {
        ...work,
        probe: { machine: "hub", state: "ok", attempted_at: at(4), read_at: at(4) },
      };
      const [g] = groupAccounts(result(), [probed, unprobed]);
      expect(g?.probe).toMatchObject({ machine: "local", state: "ok" });
      expect(g?.fable).toBeNull();
    });

    it("a failed probe prints why, and the last read's age", () => {
      const expired: UsageRecord = {
        ...work,
        model_weekly: { fable },
        probe: { machine: "hub", state: "expired", attempted_at: at(1), read_at: at(25) },
      };
      expect(line([expired])).toContain("Fable — (login expired, last read 25 min ago)");
      const noCred: UsageRecord = {
        ...peer,
        email: EMAIL,
        probe: { machine: "peer-a", state: "no_credential", attempted_at: at(1) },
      };
      expect(line([noCred])).toContain("Fable — (no credential on peer-a)");
    });

    it("a window whose reset passed prints 0 %", () => {
      const passed: UsageRecord = { ...work, five_hour: { pct: 37, resets_at: at(1) } };
      expect(line([passed])).toContain("  5-hour 0% · 7-day 56%");
    });
  });
});
