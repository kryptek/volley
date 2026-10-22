import { describe, expect, it } from "vitest";
import {
  LOCAL_MACHINE,
  accountChoices,
  accountGroups,
  accountList,
  accountMatrix,
  configuredMachines,
  moveTargetOf,
} from "../src/store/claude";
import type { ClaudeAccountPayload, MachinePayload } from "../src/store/types";

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
    // peer-a's 5-hour reading differs; its weekly agrees (same pct, same reset).
    expect(g?.stale).toEqual([
      { machine: "peer-a", window: "five_hour", pct: 41, sampledAt: peer.sampled_at },
    ]);
    expect(g?.members).toEqual([
      {
        account: "work",
        machine: "local",
        label: "Work",
        signedIn: true,
        agents: work.agents,
        waves: ["w1"],
        isPrimary: false,
      },
      {
        account: "primary@peer-a",
        machine: "peer-a",
        label: "default login",
        signedIn: true,
        agents: peer.agents,
        waves: ["w2"],
        isPrimary: true,
      },
    ]);
    expect(g?.agents).toEqual([...work.agents, ...peer.agents]);
    expect(g?.waves).toEqual(["w1", "w2"]);
  });

  it("with the peer's sample newer, its reading wins and this machine's is flagged", () => {
    const newer = { ...peer, sampled_at: "2026-10-18T14:10:00.000Z" };
    const [g] = groups({ work, "primary@peer-a": newer });
    expect(g?.fiveHour).toEqual(newer.five_hour);
    expect(g?.freshest).toEqual({ machine: "peer-a", sampledAt: newer.sampled_at });
    expect(g?.stale).toEqual([
      { machine: "local", window: "five_hour", pct: 37, sampledAt: work.sampled_at },
    ]);
  });

  it("a same-time tie goes to the reading with a known reset", () => {
    const tie = { ...peer, sampled_at: work.sampled_at, five_hour: { pct: 37, resets_at: null } };
    const [g] = groups({ "primary@peer-a": tie, work });
    expect(g?.fiveHour).toEqual(work.five_hour);
    expect(g?.stale).toEqual([
      { machine: "peer-a", window: "five_hour", pct: 37, sampledAt: work.sampled_at },
    ]);
  });

  it("a reading within a point with the same reset is not stale", () => {
    const close = {
      ...peer,
      five_hour: { pct: 37.8, resets_at: work.five_hour?.resets_at ?? null },
    };
    expect(groups({ work, "primary@peer-a": close })[0]?.stale).toEqual([]);
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
    expect(g?.stale).toEqual([]);
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
      { id: "n", label: "N", machine: "local", email: EMAIL },
    ]);
    const [g] = accountGroups(
      [ra, rn, rb].filter((x) => x !== undefined),
      machines,
      "hub",
    );
    expect(g?.fiveHour?.pct).toBe(50);
    expect(g?.freshest).toEqual({ machine: "local", sampledAt: b.sampled_at });
    expect(g?.label).toBe("B");
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
