import { describe, expect, it } from "vitest";
import {
  type BalanceAnswer,
  LOCAL_MACHINE,
  accountChoices,
  accountGroups,
  accountLine,
  accountList,
  accountMatrix,
  accountWhy,
  agentLimitFor,
  choicesFor,
  configuredMachines,
  fableHint,
  lastUpdated,
  machineRows,
  moveTargetOf,
  nextPicks,
  openLimitDecisions,
  pendingProfiles,
  picksLine,
  usageTriple,
} from "../src/store/claude";
import type { RegistryAccount } from "../src/store/claude";
import type {
  ClaudeAccountPayload,
  DecisionPayload,
  Envelope,
  FeedEntry,
  MachinePayload,
  WaveView,
} from "../src/store/types";

const EMAIL = "owner@example.com";

const work: ClaudeAccountPayload = {
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

// A peer's default login: no e-mail on the usage record, only on the machine record.
const peer: ClaudeAccountPayload = {
  account: "primary@peer-a",
  five_hour: { pct: 41, resets_at: null },
  weekly: { pct: 56, resets_at: "2026-10-21T09:00:00.000Z" },
  agents: ["w2-t1-implementer-1"],
  waves: ["w2"],
  sampled_at: "2026-10-18T14:00:00.000Z",
};

const machine = (name: string, auth: Partial<NonNullable<MachinePayload["auth"]>> = {}) =>
  ({
    name,
    kind: "peer",
    os: "linux",
    cores: 8,
    tunnel: "up",
    load: [0, 0, 0],
    agents: 0,
    last_seen: "2026-10-18T14:06:00.000Z",
    auth: { gh: "ok", claude: "signed_in", trust: "ok", ...auth },
  }) as MachinePayload;

const machines: Record<string, MachinePayload> = {
  "peer-a": machine("peer-a", { claude_email: "Owner@Example.com" }),
};

const groups = (records: Record<string, ClaudeAccountPayload>, m = machines) =>
  accountGroups(accountList(records), m, "hub");

describe("accountGroups", () => {
  it("merges two logins on one e-mail into one group; the freshest reading wins", () => {
    const [g, ...rest] = groups({ work, "primary@peer-a": peer });
    expect(rest).toEqual([]);
    expect(g?.key).toBe(EMAIL);
    expect(g?.email).toBe(EMAIL);
    expect(g?.org).toBe("Example Org");
    expect(g?.label).toBe("Work");
    expect(g?.plan).toBe("max");
    expect(g?.fiveHour).toEqual(work.five_hour);
    expect(g?.weekly).toEqual(work.weekly);
    expect(g?.freshest).toEqual({ machine: "local", sampledAt: work.sampled_at });
    expect(g?.members).toEqual([
      {
        account: "work",
        machine: "local",
        label: "Work",
        signedIn: true,
        agents: work.agents,
        waves: ["w1"],
        isPrimary: false,
        sampledAt: work.sampled_at,
      },
      {
        account: "primary@peer-a",
        machine: "peer-a",
        label: "default login",
        signedIn: true,
        agents: peer.agents,
        waves: ["w2"],
        isPrimary: true,
        sampledAt: peer.sampled_at,
      },
    ]);
    expect(g?.agents).toEqual([...work.agents, ...peer.agents]);
    expect(g?.waves).toEqual(["w1", "w2"]);
  });

  it("with the peer's sample newer, its reading wins; no reading is called stale", () => {
    const newer = { ...peer, sampled_at: "2026-10-18T14:10:00.000Z" };
    const [g] = groups({ work, "primary@peer-a": newer });
    expect(g?.fiveHour).toEqual(newer.five_hour);
    expect(g?.freshest).toEqual({ machine: "peer-a", sampledAt: newer.sampled_at });
    expect(g).not.toHaveProperty("stale");
  });

  it("a same-time tie goes to the reading with a known reset", () => {
    const tie = { ...peer, sampled_at: work.sampled_at, five_hour: { pct: 37, resets_at: null } };
    const [g] = groups({ "primary@peer-a": tie, work });
    expect(g?.fiveHour).toEqual(work.five_hour);
  });

  it("a record without an e-mail keeps its own card", () => {
    const out = groups({ work, "primary@peer-a": peer }, {});
    expect(out.map((g) => g.key)).toEqual([EMAIL, "primary@peer-a"]);
    expect(out[1]?.email).toBeNull();
    expect(out[1]?.label).toBe("primary@peer-a");
  });

  it("two different e-mails stay apart", () => {
    const other = { ...work, account: "personal", label: "Personal", email: "me@example.org" };
    const out = groups({ work, personal: other });
    expect(out.map((g) => g.label)).toEqual(["Work", "Personal"]);
  });

  it("a signed-in peer with no e-mail and no usage yet is its own card", () => {
    const out = groups({ work }, { "peer-b": machine("peer-b") });
    expect(out.map((g) => g.key)).toEqual([EMAIL, "primary@peer-b"]);
    expect(out[1]?.members.map((m) => [m.machine, m.signedIn])).toEqual([["peer-b", true]]);
  });

  it("a signed-in peer whose machine reports the e-mail joins the group with no usage", () => {
    const [g, ...rest] = groups({ work });
    expect(rest).toEqual([]);
    expect(g?.members.map((m) => m.account)).toEqual(["work", "primary@peer-a"]);
  });

  it("a peer signed out on its machine record shows signed out", () => {
    const out = groups(
      { work, "primary@peer-a": { ...peer, email: EMAIL } },
      { "peer-a": machine("peer-a", { claude: "not_signed_in" }) },
    );
    expect(out[0]?.members.find((m) => m.machine === "peer-a")?.signedIn).toBe(false);
  });

  it("the supervisor's own machine record never becomes a peer card", () => {
    const own = { ...machine("hub", { claude_email: EMAIL }), kind: "supervisor" as const };
    const out = groups({ work }, { hub: own });
    expect(out).toHaveLength(1);
    expect(out[0]?.members.map((m) => m.machine)).toEqual(["local"]);
  });

  it("the label falls back to the masked e-mail when no member has a profile label", () => {
    const [g] = groups({ "primary@peer-a": peer });
    expect(g?.label).toBe("O•••@Example.com");
  });

  it("a member with no reading between two sampled ones never counts as the freshest", () => {
    const a = { ...work, account: "a", label: "A", sampled_at: "2026-10-18T10:00:00.000Z" };
    const b = {
      ...work,
      account: "b",
      label: "B",
      five_hour: { pct: 50, resets_at: work.five_hour?.resets_at ?? null },
      sampled_at: "2026-10-18T11:00:00.000Z",
    };
    // A registry profile with no usage record yet, listed between the two sampled logins.
    const [ra, rb, rn] = accountList({ a, b }, [
      { id: "n", label: "N", machine: "local", email: EMAIL, signed_in_at: work.sampled_at },
    ]);
    const [g] = accountGroups(
      [ra, rn, rb].filter((x) => x !== undefined),
      machines,
      "hub",
    );
    expect(g?.fiveHour?.pct).toBe(50);
    expect(g?.freshest).toEqual({ machine: "local", sampledAt: b.sampled_at });
    // The registry's own profile names the group.
    expect(g?.label).toBe("N");
  });

  it("the e-mail keeps its reported spelling; the key is normalised", () => {
    const [g] = groups({ work: { ...work, email: " Owner@Example.com " } });
    expect(g?.key).toBe(EMAIL);
    expect(g?.email).toBe("Owner@Example.com");
  });

  it("Use for is the group's local member; a remote-only group has none", () => {
    const [g] = groups({ work, "primary@peer-a": peer });
    expect(g && moveTargetOf(g)).toBe("work");
    const [r] = groups({ "primary@peer-a": peer });
    expect(r && moveTargetOf(r)).toBeNull();
  });

  it("pickers keep listing every account id once", () => {
    const list = accountList({ work, "primary@peer-a": peer });
    expect(accountChoices(list).map((c) => c.id)).toEqual(["work", "primary@peer-a"]);
  });
});

describe("one clean card per account (#496)", () => {
  const TEAM = "team@example.com";
  const SIGNED = "2026-10-18T12:00:00.000Z";
  const teamRec = (account: string, sampled_at: string): ClaudeAccountPayload => ({
    account,
    five_hour: { pct: 8, resets_at: null },
    weekly: null,
    agents: [],
    waves: [],
    sampled_at,
  });
  const row = (id: string, label: string, machine: string, extra: Partial<RegistryAccount> = {}) =>
    ({ id, label, machine, email: TEAM, signed_in_at: SIGNED, ...extra }) as RegistryAccount;
  /** The row with no finished sign-in. */
  const unsigned = ({ signed_in_at: _, ...r }: RegistryAccount): RegistryAccount => r;

  it("keys a paired machine's registry row <id>@<machine>: one account, not two", () => {
    const rec = teamRec("team@box-a", "2026-10-18T14:05:30.000Z");
    const list = accountList({ "team@box-a": rec }, [row("team", "Team account (box-a)", "box-a")]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: "team@box-a",
      machine: "box-a",
      sampledAt: rec.sampled_at,
      signedIn: true,
      email: TEAM,
    });
  });

  it("with a local team record too, the group holds exactly the two logins", () => {
    const records = {
      team: teamRec("team", "2026-10-18T14:04:00.000Z"),
      "team@box-a": teamRec("team@box-a", "2026-10-18T14:05:30.000Z"),
    };
    const registry = [
      row("team", "Team account", "local"),
      row("team", "Team account (box-a)", "box-a"),
    ];
    const gs = accountGroups(accountList(records, registry), {}, "hub");
    expect(gs).toHaveLength(1);
    expect(gs[0]?.members.map((m) => [m.account, m.machine])).toEqual([
      ["team", "local"],
      ["team@box-a", "box-a"],
    ]);
    expect(gs[0]?.label).toBe("Team account");
  });

  it("the label: the registry label, less a machine suffix; Add's Claude login is no name", () => {
    const primary = { ...teamRec("primary", SIGNED), email: TEAM };
    const login = row("claude-login", "Claude login (box-a)", "box-a");
    expect(accountGroups(accountList({ primary }, [login]), {}, "hub")[0]?.label).toBe(
      "t•••@example.com",
    );
    const solo = accountList({}, [row("work", "Work (box-a)", "box-a")]);
    expect(accountGroups(solo, {}, "hub")[0]?.label).toBe("Work");
    // A suffix naming no machine of the group is part of the name.
    const odd = accountList({}, [row("work", "Work (2024)", "box-a")]);
    expect(accountGroups(odd, {}, "hub")[0]?.label).toBe("Work (2024)");
  });

  it("the label: this machine's profile first, else the earliest in registry order", () => {
    const rows = [row("t-b", "Team B (box-b)", "box-b"), row("t-a", "Team A (box-a)", "box-a")];
    expect(accountGroups(accountList({}, rows), {}, "hub")[0]?.label).toBe("Team B");
    const local = [...rows, row("t", "Team here", "local")];
    expect(accountGroups(accountList({}, local), {}, "hub")[0]?.label).toBe("Team here");
  });

  it("machineRows: one row per configured machine; two profiles on box-a are one row", () => {
    const registry = [
      row("team", "Team account", "box-a"),
      row("team-2", "Team account (box-a)", "box-a"),
      unsigned(row("old", "Team account (gone)", "gone")),
    ];
    const records = { "old@gone": teamRec("old@gone", SIGNED) };
    const [g] = accountGroups(accountList(records, registry), {}, "hub");
    const configured = configuredMachines(["box-a", "box-b"], {}, "hub");
    expect(g && machineRows(g, configured)).toEqual([
      { name: "this machine", op: "local", up: true, state: "missing", labels: [] },
      {
        name: "box-a",
        op: "box-a",
        up: true,
        state: "signed_in",
        labels: ["Team account", "Team account (box-a)"],
      },
      { name: "box-b", op: "box-b", up: true, state: "missing", labels: [] },
      // A member on a machine no longer configured comes last.
      { name: "gone", op: "gone", up: true, state: "signed_out", labels: ["Team account (gone)"] },
    ]);
  });

  it("lastUpdated: the freshest reading's age; just now under a minute; null with none", () => {
    const now = Date.parse("2026-10-18T14:10:00.000Z");
    const at = (sampled: string) =>
      accountGroups(accountList({ team: teamRec("team", sampled) }), {}, "hub")[0] as never;
    expect(lastUpdated(at("2026-10-18T14:06:00.000Z"), now)).toBe("4 min ago");
    expect(lastUpdated(at("2026-10-18T14:09:30.000Z"), now)).toBe("just now");
    const [none] = accountGroups(accountList({}, [row("team", "Team", "local")]), {}, "hub");
    expect(none && lastUpdated(none, now)).toBeNull();
  });

  it("pendingProfiles: no finished sign-in and no record; accountList leaves them out", () => {
    const pending = unsigned(
      row("pending-work", "Work (box-a)", "box-a", {
        signin: { state: "pending", url: "https://claude.com/cai/oauth/authorize?state=x" },
      }),
    );
    const done = row("team", "Team", "local");
    // A row with a record is in use, whatever its registry entry says.
    const used = unsigned(row("used", "Used", "box-a"));
    const records = { "used@box-a": teamRec("used@box-a", SIGNED) };
    const registry = [pending, done, used];
    expect(pendingProfiles(registry, records)).toEqual([pending]);
    expect(accountList(records, registry).map((a) => a.id)).toEqual(["used@box-a", "team"]);
  });
});

describe("accountMatrix: which configured machines hold each account", () => {
  const fleet = {
    "peer-a": machine("peer-a", { claude_email: "Owner@Example.com" }),
    "peer-b": {
      ...machine("peer-b", { claude: "not_signed_in" }),
      tunnel: "down",
    } as MachinePayload,
  };
  const configured = configuredMachines(["peer-a", "peer-b"], fleet, "hub");
  const personal: ClaudeAccountPayload = {
    ...work,
    account: "personal",
    label: "Personal",
    email: "p@example.com",
  };

  it("lists the configured machines, this machine first, a peer whose tunnel is down not up", () => {
    expect(configured).toEqual([
      { name: "this machine", host: "hub", op: LOCAL_MACHINE, up: true },
      { name: "peer-a", op: "peer-a", up: true },
      { name: "peer-b", op: "peer-b", up: false },
    ]);
    // A paired host with no record yet is offered (its state unknown), never the supervisor's own.
    expect(configuredMachines(["hub", "peer-c"], {}, "hub")).toEqual([
      { name: "this machine", host: "hub", op: LOCAL_MACHINE, up: true },
      { name: "peer-c", op: "peer-c", up: true, unknown: true },
    ]);
  });

  it("a group held on this machine and peer-a misses peer-b: 2 of 3", () => {
    const [row] = accountMatrix(groups({ work, "primary@peer-a": peer }, fleet), configured);
    expect(row?.present.map((m) => m.machine)).toEqual([LOCAL_MACHINE, "peer-a"]);
    expect(row?.missing.map((m) => m.name)).toEqual(["peer-b"]);
    expect(row?.missing[0]?.up).toBe(false);
    expect(row?.coverage).toEqual({ held: 2, total: 3 });
    // One row per configured machine, in the configured order.
    expect(row?.rows.map((r) => [r.name, r.member?.label ?? null])).toEqual([
      ["this machine", "Work"],
      ["peer-a", "default login"],
      ["peer-b", null],
    ]);
  });

  it("a group held everywhere misses none", () => {
    const everywhere = { ...fleet, "peer-b": machine("peer-b", { claude_email: EMAIL }) };
    const [row] = accountMatrix(
      groups({ work, "primary@peer-a": peer }, everywhere),
      configuredMachines(["peer-a", "peer-b"], everywhere, "hub"),
    );
    expect(row?.missing).toEqual([]);
    expect(row?.coverage).toEqual({ held: 3, total: 3 });
  });

  it("a signed-out login still holds the account there: it counts and offers no Sign in", () => {
    const out = {
      ...fleet,
      "peer-b": machine("peer-b", { claude: "not_signed_in", claude_email: EMAIL }),
    };
    // peer-b's default login has a usage record, but its machine reports it signed out.
    const peerB = { ...peer, account: "primary@peer-b" };
    const [row] = accountMatrix(
      groups({ work, "primary@peer-a": peer, "primary@peer-b": peerB }, out),
      configuredMachines(["peer-a", "peer-b"], out, "hub"),
    );
    const b = row?.present.find((m) => m.machine === "peer-b");
    expect(b?.signedIn).toBe(false);
    expect(row?.missing).toEqual([]);
    expect(row?.coverage).toEqual({ held: 3, total: 3 });
  });

  it("keeps the order of the configured list, and a member on an unconfigured machine last", () => {
    const rows = accountMatrix(
      groups({ personal, "primary@peer-a": peer }, fleet),
      [...configured].reverse(),
    );
    const p = rows.find((r) => r.group.label === "Personal");
    expect(p?.rows.map((r) => r.name)).toEqual(["peer-b", "peer-a", "this machine"]);
    const solo = accountMatrix(
      groups({ "primary@box": { ...peer, account: "primary@box" } }, {}),
      configured,
    )[0];
    expect(solo?.rows.map((r) => [r.name, r.member !== null])).toEqual([
      ["this machine", false],
      ["peer-a", false],
      ["peer-b", false],
      ["box", true],
    ]);
    expect(solo?.coverage).toEqual({ held: 0, total: 3 });
  });
});

describe("the Fable window and the usage probe", () => {
  const NOW = Date.parse("2026-10-18T14:10:00.000Z");
  const min = (n: number) => new Date(NOW - n * 60_000).toISOString();
  const fable = { pct: 12, resets_at: "2026-10-22T16:00:00.000Z" };
  const probed = (
    r: ClaudeAccountPayload,
    probe: NonNullable<ClaudeAccountPayload["probe"]>,
    w: typeof fable | null = fable,
  ): ClaudeAccountPayload => ({ ...r, ...(w ? { model_weekly: { fable: w } } : {}), probe });

  it("takes the Fable window from the freshest member carrying one", () => {
    const older = { pct: 30, resets_at: fable.resets_at };
    const [g] = groups({
      work: probed(
        work,
        { machine: "hub", state: "ok", attempted_at: min(9), read_at: min(9) },
        older,
      ),
      "primary@peer-a": probed(peer, {
        machine: "peer-a",
        state: "ok",
        attempted_at: min(4),
        read_at: min(4),
      }),
    });
    expect(g?.fable).toEqual(fable);
    expect(g?.probe).toEqual({
      machine: "peer-a",
      state: "ok",
      attemptedAt: min(4),
      readAt: min(4),
    });
  });

  it("is null, with no probe, before any probe reported", () => {
    const [g] = groups({ work });
    expect(g?.fable).toBeNull();
    expect(g?.probe).toBeNull();
  });

  it("an ok read 2 min ago beats an error attempted 1 min ago", () => {
    const [g] = groups({
      work: probed(work, { machine: "hub", state: "ok", attempted_at: min(2), read_at: min(2) }),
      "primary@peer-a": probed(
        peer,
        { machine: "peer-a", state: "error", attempted_at: min(1) },
        null,
      ),
    });
    expect(g?.probe).toMatchObject({ machine: "local", state: "ok" });
    expect(g?.fable).toEqual(fable);
  });

  it("takes the figure from the member whose probe it reports, not another's", () => {
    // peer-a carries a Fable window but no probe; this machine's probe read, with no window.
    const [g] = groups({
      work: probed(
        work,
        { machine: "hub", state: "ok", attempted_at: min(4), read_at: min(4) },
        null,
      ),
      "primary@peer-a": { ...peer, sampled_at: min(1), model_weekly: { fable } },
    });
    expect(g?.probe).toMatchObject({ machine: "local", state: "ok" });
    expect(g?.fable).toBeNull();
  });

  it("with no read anywhere, the newest attempt reports", () => {
    const [g] = groups({
      work: { ...work, probe: { machine: "hub", state: "expired", attempted_at: min(9) } },
      "primary@peer-a": {
        ...peer,
        probe: { machine: "peer-a", state: "no_credential", attempted_at: min(3) },
      },
    });
    expect(g?.probe).toEqual({
      machine: "peer-a",
      state: "no_credential",
      attemptedAt: min(3),
      readAt: null,
    });
  });

  it("fableHint names each state, and the last read when there is one", () => {
    const p = (state: string, readAt: string | null = null) =>
      ({ machine: "peer-a", state, attemptedAt: min(1), readAt }) as never;
    expect(fableHint(null, NOW)).toBe("not read yet");
    expect(fableHint(p("ok", min(4)), NOW)).toBe("read 4 min ago on peer-a");
    expect(fableHint({ ...(p("ok", min(4)) as object), machine: "local" } as never, NOW)).toBe(
      "read 4 min ago on this machine",
    );
    expect(fableHint(p("expired", min(25)), NOW)).toBe(
      "login expired — Claude Code renews it on its next request; last read 25 min ago",
    );
    expect(fableHint(p("no_credential"), NOW)).toBe("no credential on peer-a");
    expect(fableHint(p("rate_limited"), NOW)).toBe("rate limited, retrying");
    expect(fableHint(p("rejected"), NOW)).toBe("probe failed");
    expect(fableHint(p("error", min(180)), NOW)).toBe("probe failed; last read 3 h ago");
  });

  it("usageTriple: the three figures, and a member's own age when it is older", () => {
    const [g] = groups({
      work: probed(work, { machine: "hub", state: "ok", attempted_at: min(4), read_at: min(4) }),
      "primary@peer-a": { ...peer, sampled_at: min(180) },
    });
    if (!g) throw new Error("no group");
    const [local, peerA] = g.members;
    const at = Date.parse(work.sampled_at) + 60_000;
    expect(usageTriple(g, local as never, at)).toEqual({
      text: "5h 37% · 7d 56% · Fable 12%",
      sampled: null,
    });
    expect(usageTriple(g, peerA as never, NOW).sampled).toBe("sampled 3 h ago");
    // A window whose reset passed counts as 0 %.
    expect(usageTriple(g, local as never, Date.parse("2026-10-19T00:00:00.000Z")).text).toBe(
      "5h 0% · 7d 56% · Fable 12%",
    );
  });

  it("usageTriple shows Fable — while the probe's last attempt failed", () => {
    const [g] = groups({
      work: probed(work, {
        machine: "hub",
        state: "expired",
        attempted_at: min(1),
        read_at: min(25),
      }),
    });
    if (!g) throw new Error("no group");
    expect(usageTriple(g, g.members[0] as never, NOW).text).toBe("5h 37% · 7d 56% · Fable —");
  });
});

describe("the balance, per machine (T8)", () => {
  const rec = (account: string, label: string, five: number | null): ClaudeAccountPayload => ({
    account,
    label,
    five_hour: five === null ? null : { pct: five, resets_at: null },
    weekly: { pct: 40, resets_at: null },
    agents: [],
    waves: [],
    sampled_at: "2026-10-18T14:00:00.000Z",
  });
  const list = accountList(
    {
      primary: rec("primary", "primary", 60),
      work: rec("work", "Work", 12),
      "primary@peer-a": rec("primary@peer-a", "primary@peer-a", 88),
      "team@peer-a": rec("team@peer-a", "Team", 12),
    },
    // A registry row for the peer's profile: the same login as its usage record, never twice.
    [{ id: "team", label: "Team", machine: "peer-a" }],
  );

  it("accountChoices carries each account's machine; choicesFor keeps one machine's", () => {
    const choices = accountChoices(list);
    expect(choices.find((c) => c.id === "team@peer-a")?.machine).toBe("peer-a");
    expect(choicesFor(choices, "peer-a").map((c) => c.id)).toEqual([
      "primary@peer-a",
      "team@peer-a",
    ]);
    expect(choicesFor(choices, LOCAL_MACHINE).map((c) => c.id)).toEqual(["primary", "work"]);
  });

  const answer: BalanceAnswer = {
    machines: [
      {
        name: LOCAL_MACHINE,
        candidates: [],
        picks: { fable: "work", opus: "work", sonnet: "primary", haiku: "primary" },
      },
      {
        name: "peer-a",
        candidates: [],
        picks: { fable: "work@peer-a", opus: "primary@peer-a" },
      },
    ],
  };

  it("nextPicks: the families whose next spawn the answer puts on an account", () => {
    expect(nextPicks(answer, "work")).toEqual(["fable", "opus"]);
    expect(nextPicks(answer, "primary")).toEqual(["sonnet", "haiku"]);
    expect(nextPicks(answer, "personal")).toEqual([]);
    expect(nextPicks(null, "work")).toEqual([]);
  });

  it("picksLine: Fable, others / others / nothing", () => {
    expect(picksLine(["fable", "opus"])).toBe("Fable, others");
    expect(picksLine(["fable"])).toBe("Fable");
    expect(picksLine(["sonnet", "haiku"])).toBe("others");
    expect(picksLine([])).toBeNull();
  });
});

describe("agent-level account decisions and events (T8)", () => {
  const waveLimit: DecisionPayload = {
    decision_id: "w1-limit-1",
    wave: "w1",
    task: null,
    kind: "account_limit",
    question: "Claude account work is at 91%",
    options: ["move wave w1 to personal", "not now"],
    opened_at: "2026-10-18T14:06:01.000Z",
    acct: "work",
    pct: 91,
    resets_at: null,
    suggested: "personal",
  };
  const agentLimit: DecisionPayload = {
    decision_id: "w1-t1-agent_account_limit-1",
    wave: "w1",
    task: "T1",
    kind: "agent_account_limit",
    question: "a-1 runs under primary, at 91% of its 5-hour window",
    options: ["move a-1 to work", "not now"],
    opened_at: "2026-10-18T14:07:00.000Z",
    agent_id: "a-1",
    role: "implementer",
    window: "five_hour",
    acct: "primary",
    pct: 91,
    resets_at: null,
    suggested: "work",
  };
  const waves: Record<string, WaveView> = {
    w1: {
      id: "w1",
      state: null,
      receivedAt: 0,
      decisions: { [waveLimit.decision_id]: waveLimit, [agentLimit.decision_id]: agentLimit },
    },
  };

  it("openLimitDecisions returns both kinds, oldest first", () => {
    expect(openLimitDecisions(waves).map((d) => d.kind)).toEqual([
      "account_limit",
      "agent_account_limit",
    ]);
  });

  it("agentLimitFor finds the agent's open decision, never a resolved one", () => {
    expect(agentLimitFor(waves, "a-1")?.decision_id).toBe(agentLimit.decision_id);
    expect(agentLimitFor(waves, "a-2")).toBeNull();
    const done = {
      w1: {
        ...(waves.w1 as WaveView),
        decisions: {
          x: { ...agentLimit, resolved: { answer: "not now", by: "lead", at: "2026-10-18" } },
        },
      },
    };
    expect(agentLimitFor(done, "a-1")).toBeNull();
  });

  const ev = (type: string, seq: number, data: Record<string, unknown>): FeedEntry => {
    const envelope: Envelope = {
      schema_version: "0.1",
      agent_id: "volleyd",
      channel: "_waves/events",
      type,
      wall_time: new Date(Date.UTC(2026, 9, 18, 14, 0, seq)).toISOString(),
      payload: { wave: "w1", seq, task: "T1", data },
    };
    return { topic: "volley/_waves/w1/events", envelope, receivedAt: seq };
  };
  const chosen = ev("account_chosen", 1, {
    task: "T1",
    role: "implementer",
    account: "primary",
    source: "balance",
    why: "primary: most headroom on this machine (5h 20%)",
  });
  const moved = ev("agent_account_moved", 2, {
    agent_id: "a-1",
    role: "implementer",
    from: "primary",
    to: "work",
    by: "autopilot",
    decision_id: "w1-t1-agent_account_limit-1",
    why: "primary at 91% of its 5-hour window",
  });
  const reviewer = ev("account_chosen", 3, {
    task: "T1",
    role: "spec_reviewer",
    account: "work",
    why: "work: most headroom",
  });

  it("accountLine: the feed's Account rows", () => {
    expect(accountLine(chosen.envelope)).toBe(
      "Account · primary: most headroom on this machine (5h 20%)",
    );
    expect(accountLine(moved.envelope)).toBe(
      "Account · moved off primary to work by autopilot: primary at 91% of its 5-hour window",
    );
    expect(accountLine({ ...chosen.envelope, type: "stage_entered" })).toBeNull();
  });

  it("accountWhy: the latest account_chosen of the task role, or the move after it", () => {
    expect(accountWhy([chosen, reviewer], "T1", "implementer")).toBe(
      "primary: most headroom on this machine (5h 20%)",
    );
    expect(accountWhy([chosen, moved, reviewer], "T1", "implementer")).toBe(
      "moved off primary by autopilot: primary at 91% of its 5-hour window",
    );
    const byPerson = ev("agent_account_moved", 4, {
      agent_id: "a-1",
      role: "implementer",
      from: "primary",
      to: "work",
      by: "lead",
      why: "moved off primary by lead",
    });
    expect(accountWhy([chosen, byPerson], "T1", "implementer")).toBe("moved by lead");
    // The respawn's own account_chosen (source move) keeps the move's line.
    const after = ev("account_chosen", 5, {
      task: "T1",
      role: "implementer",
      account: "work",
      source: "move",
      why: "moved off primary (5h 91%) by autopilot",
    });
    expect(accountWhy([chosen, moved, after], "T1", "implementer")).toBe(
      "moved off primary by autopilot: primary at 91% of its 5-hour window",
    );
    expect(accountWhy([chosen], "T2", "implementer")).toBeNull();
    // An account_chosen without a why still names its account.
    const bare = ev("account_chosen", 6, { task: "T1", role: "implementer", account: "work" });
    expect(accountWhy([bare], "T1", "implementer")).toBe("work");
  });
});
