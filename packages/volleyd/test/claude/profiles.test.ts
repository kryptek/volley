import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ClaudeAccountError,
  PRIMARY_ACCOUNT,
  accountIdFor,
  addAccount,
  markSignedIn,
  profileDir,
  readRegistry,
  registryPath,
  removeAccount,
  renameAccount,
  selectAccount,
} from "../../src/claude/profiles";
import type { Ranked } from "../../src/claude/usage";
import { tempDir, tempDirForAll } from "../helpers/tmp";

const root = () => tempDir("volley-claude-");
const NOW = "2026-10-18T12:00:00.000Z";

describe("profiles: the accounts.json registry", () => {
  it("add creates the profile dir (0700) and a registry entry", () => {
    const r = root();
    const acct = addAccount(r, { label: "Work Max" }, NOW);
    expect(acct).toEqual({ id: "work-max", label: "Work Max", machine: "local", created: NOW });
    const dir = profileDir(r, "work-max");
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const reg = JSON.parse(readFileSync(registryPath(r), "utf-8"));
    expect(reg).toEqual({ version: 1, accounts: [acct] });
    expect(statSync(registryPath(r)).mode & 0o777).toBe(0o600);
  });

  it("records the machine and refuses a duplicate id", () => {
    const r = root();
    addAccount(r, { label: "personal", machine: "studio" }, NOW);
    expect(readRegistry(r).accounts[0]?.machine).toBe("studio");
    expect(() => addAccount(r, { label: "Personal" }, NOW)).toThrow(ClaudeAccountError);
  });

  it("refuses a label with no usable id, and the reserved primary", () => {
    const r = root();
    expect(() => addAccount(r, { label: "!!!" }, NOW)).toThrow(/label/);
    expect(() => addAccount(r, { label: "primary" }, NOW)).toThrow(/reserved/);
  });

  it("derives ids in the topic-segment grammar", () => {
    expect(accountIdFor("  Work / Max 5x ")).toBe("work-max-5x");
    expect(accountIdFor("x".repeat(80))).toHaveLength(63);
  });

  it("profile dirs are one canonical absolute path with no trailing slash", () => {
    expect(profileDir("/srv/claude/", "a")).toBe("/srv/claude/a");
    expect(() => profileDir("relative", "a")).toThrow(/absolute/);
    expect(() => profileDir("/srv/claude", "../x")).toThrow(ClaudeAccountError);
  });

  it("markSignedIn stamps the entry with the plan label only", () => {
    const r = root();
    addAccount(r, { label: "work" }, NOW);
    markSignedIn(r, "work", { plan: "max" }, "2026-10-18T12:05:00.000Z");
    expect(readRegistry(r).accounts[0]).toMatchObject({
      id: "work",
      plan: "max",
      signed_in_at: "2026-10-18T12:05:00.000Z",
    });
  });

  it("markSignedIn stores the login's email and org beside the plan", () => {
    const r = root();
    addAccount(r, { label: "work" }, NOW);
    markSignedIn(
      r,
      "work",
      { plan: "max", email: "owner@example.com", org: "Example Org" },
      "2026-10-18T12:05:00.000Z",
    );
    expect(readRegistry(r).accounts[0]).toEqual({
      id: "work",
      label: "work",
      machine: "local",
      created: NOW,
      plan: "max",
      email: "owner@example.com",
      org: "Example Org",
      signed_in_at: "2026-10-18T12:05:00.000Z",
    });
  });

  it("an entry without email or org round-trips unchanged", () => {
    const r = root();
    const acct = addAccount(r, { label: "work" }, NOW);
    markSignedIn(r, "work", {}, NOW);
    expect(readRegistry(r).accounts[0]).toEqual({ ...acct, signed_in_at: NOW });
  });

  it("an absent registry is empty", () => {
    expect(readRegistry(root())).toEqual({ version: 1, accounts: [] });
  });
});

describe("profiles: rename and remove", () => {
  /** `team` here and `team-box-a` on box-a, one login; `solo` on box-a, not signed in yet. */
  function three(): string {
    const r = root();
    addAccount(r, { label: "team" }, NOW);
    addAccount(r, { label: "team box-a", machine: "box-a" }, NOW);
    addAccount(r, { label: "solo", machine: "box-a" }, NOW);
    markSignedIn(r, "team", { email: "team@example.com" }, NOW);
    markSignedIn(
      r,
      "team-box-a",
      { email: "team@example.com", dir: "/h/.volley/claude/team-box-a" },
      NOW,
    );
    return r;
  }

  it("rename relabels every profile of the login on every machine and returns them", () => {
    const r = three();
    const renamed = renameAccount(r, "team", "  Team account ");
    expect(renamed.map((a) => [a.id, a.machine, a.label])).toEqual([
      ["team", "local", "Team account"],
      ["team-box-a", "box-a", "Team account"],
    ]);
    expect(readRegistry(r).accounts.map((a) => a.label)).toEqual([
      "Team account",
      "Team account",
      "solo",
    ]);
  });

  it("rename of a profile with no e-mail yet relabels that profile alone", () => {
    const r = three();
    expect(renameAccount(r, "solo", "Solo").map((a) => a.id)).toEqual(["solo"]);
    expect(readRegistry(r).accounts.map((a) => a.label)).toEqual(["team", "team box-a", "Solo"]);
  });

  it("rename refuses an empty label, a reserved one, an unknown id and the primary", () => {
    const r = three();
    expect(() => renameAccount(r, "team", "  ")).toThrow(ClaudeAccountError);
    expect(() => renameAccount(r, "team", "Primary")).toThrow(/reserved/);
    expect(() => renameAccount(r, "team", "most_headroom")).toThrow(/reserved/);
    expect(() => renameAccount(r, "nope", "x")).toThrow(/unknown Claude account 'nope'/);
    expect(() => renameAccount(r, PRIMARY_ACCOUNT, "x")).toThrow(ClaudeAccountError);
    expect(readRegistry(r).accounts.map((a) => a.label)).toEqual(["team", "team box-a", "solo"]);
  });

  it("remove drops the entry and returns it; unknown and primary are refused", () => {
    const r = three();
    expect(removeAccount(r, "team-box-a")).toMatchObject({ id: "team-box-a", machine: "box-a" });
    expect(readRegistry(r).accounts.map((a) => a.id)).toEqual(["team", "solo"]);
    expect(() => removeAccount(r, "team-box-a")).toThrow(/unknown Claude account/);
    expect(() => removeAccount(r, PRIMARY_ACCOUNT)).toThrow(ClaudeAccountError);
  });
});

describe("selectAccount: task > wave > config default > primary", () => {
  // One registry shared by every case here.
  const shared = tempDirForAll("volley-claude-");
  let r: string;
  let reg: ReturnType<typeof readRegistry>;
  beforeAll(() => {
    r = shared();
    addAccount(r, { label: "work" }, NOW);
    markSignedIn(r, "work", { plan: "max" }, NOW);
    addAccount(r, { label: "fresh" }, NOW);
    reg = readRegistry(r);
  });

  it("nothing set and no profile signed in → the primary alone (source default)", () => {
    const r1 = root();
    expect(selectAccount(r1, readRegistry(r1), {})).toEqual({
      id: PRIMARY_ACCOUNT,
      dir: null,
      source: "default",
      machine: "local",
      why: "primary: the only signed-in account on local",
    });
  });

  it("the config default, then the wave, then the task pin", () => {
    expect(selectAccount(r, reg, { configDefault: "work" })).toEqual({
      id: "work",
      dir: profileDir(r, "work"),
      source: "config",
      machine: "local",
      why: "claude.default_account names work",
    });
    expect(selectAccount(r, reg, { configDefault: "work", wave: "primary" }).id).toBe("primary");
    expect(
      selectAccount(r, reg, { configDefault: "primary", wave: "primary", task: "work" }),
    ).toMatchObject({ id: "work", source: "task", why: "task names work" });
    expect(selectAccount(r, reg, { configDefault: "primary" })).toMatchObject({
      id: "primary",
      source: "config",
    });
  });

  const T = Date.parse(NOW);
  const at = (minutes: number) => new Date(T + minutes * 60_000).toISOString();
  /** A ranked row with the new fields; `over` makes it ineligible at its 5-hour figure. */
  const row = (account: string, r: Partial<Ranked>): Ranked => ({
    account,
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
    ...r,
  });

  it("the why line shows the projection with agents in flight, and #556's line with none", () => {
    const work = row("work", {
      headroom: 18,
      five_hour_pct: 82,
      weekly_pct: 40,
      score: 1.2,
      binding: "five_hour",
      binding_left: 18,
      binding_resets_at: at(52),
      in_flight: 1,
      projected_pct: 92,
    });
    const primary = row("primary", {
      headroom: 72,
      five_hour_pct: 10,
      weekly_pct: 28,
      score: 0.9,
      binding: "weekly",
      binding_left: 72,
      binding_resets_at: at(2 * 1440 + 4 * 60),
      in_flight: 2,
      projected_pct: 30.5,
    });
    const spare = row("spare", {
      headroom: 5,
      five_hour_pct: 95,
      weekly_pct: 30,
      score: 0,
      binding: "five_hour",
      eligible: false,
      binding_left: 5,
      binding_resets_at: at(180),
      in_flight: 1,
      projected_pct: 100,
    });
    const sel = selectAccount(r, reg, { now: T, capPct: 97 }, () => [work, primary, spare]);
    expect(sel.why).toBe(
      "work: 18% left (8% after 1 in flight), resets in 52m (use it or lose it) on local; primary 7d 72% left (70% after 2 in flight), resets in 2d 4h; spare over the 97% cap (5h 95%, 100% after 1 in flight)",
    );
    const idle = selectAccount(r, reg, { now: T, capPct: 97 }, () => [
      { ...work, in_flight: 0, projected_pct: 82 },
    ]);
    expect(idle.why).toBe("work: 18% left, resets in 52m (use it or lose it) on local");
  });

  it("null (and most_headroom) balances across the signed-in accounts by rank", () => {
    const rank = (c: readonly string[]): Ranked[] => {
      expect([...c].sort()).toEqual(["primary", "work"]);
      return [
        row("work", {
          headroom: 18,
          five_hour_pct: 82,
          weekly_pct: 40,
          score: 1.7,
          binding: "five_hour",
          binding_left: 18,
          binding_resets_at: at(52),
        }),
        row("primary", {
          headroom: 72,
          five_hour_pct: 10,
          weekly_pct: 28,
          score: 0.9,
          binding: "weekly",
          binding_left: 72,
          binding_resets_at: at(2 * 1440 + 4 * 60),
        }),
      ];
    };
    for (const configDefault of [null, "most_headroom"]) {
      const sel = selectAccount(r, reg, { configDefault, now: T }, rank);
      expect(sel).toMatchObject({
        id: "work",
        dir: profileDir(r, "work"),
        source: "balance",
        machine: "local",
        why: "work: 18% left, resets in 52m (use it or lose it) on local; primary 7d 72% left, resets in 2d 4h",
      });
      expect(sel.candidates?.map((x) => x.account)).toEqual(["work", "primary"]);
    }
    // without usage data a signed-in profile is offered before the primary
    expect(selectAccount(r, reg, {}).id).toBe("work");
    expect(selectAccount(r, reg, {}).why).toBe(
      "work: no usage yet (balanced) on local; primary no usage yet",
    );
    expect(selectAccount(r, reg, { wave: "most_headroom" }).source).toBe("balance");
  });

  it("the why line names an over-cap candidate, an all-over-cap pick, and never an e-mail", () => {
    const over = row("spare", {
      headroom: 2,
      five_hour_pct: 98,
      weekly_pct: 30,
      score: 0.1,
      binding: "five_hour",
      eligible: false,
      binding_left: 2,
      binding_resets_at: at(62),
    });
    const pick = row("work", {
      headroom: 60,
      five_hour_pct: 12,
      weekly_pct: 40,
      score: 1.1,
      binding: "weekly",
      binding_left: 60,
      binding_resets_at: at(3 * 1440),
    });
    const one = selectAccount(r, reg, { now: T, capPct: 97 }, () => [pick, over]);
    expect(one.why).toBe(
      "work: 7d 60% left, resets in 3d (use it or lose it) on local; spare over the 97% cap (5h 98%)",
    );
    const primary = row("primary", {
      headroom: 1,
      five_hour_pct: 99,
      score: 0.05,
      binding: "five_hour",
      eligible: false,
      binding_left: 1,
      binding_resets_at: at(30),
    });
    const all = selectAccount(r, reg, { now: T, capPct: 97 }, () => [
      { ...over, account: "work" },
      primary,
    ]);
    expect(all.why).toBe(
      "work: over the 97% cap, least over on local (5h 98%, resets in 1h 2m); primary over the 97% cap (5h 99%)",
    );
    // the head names the window over the cap, not the binding one when they differ
    const weeklyBinds = row("work", {
      headroom: 2,
      five_hour_pct: 98,
      weekly_pct: 50,
      score: 0.58,
      binding: "weekly",
      eligible: false,
      binding_left: 50,
      binding_resets_at: at(6 * 1440),
    });
    expect(selectAccount(r, reg, { now: T, capPct: 97 }, () => [weeklyBinds, primary]).why).toBe(
      "work: over the 97% cap, least over on local (5h 98%); primary over the 97% cap (5h 99%)",
    );
    // the cap figure is the option's
    expect(selectAccount(r, reg, { now: T, capPct: 90 }, () => [pick, over]).why).toContain(
      "spare over the 90% cap (5h 98%)",
    );
    for (const why of [one.why, all.why]) expect(why).not.toMatch(/@[a-z0-9-]+\.[a-z]/);
  });

  it("a pinned pick never ranks and keeps its why", () => {
    let calls = 0;
    const rank = (c: readonly string[]) => {
      calls++;
      return c.map((account) => row(account, {}));
    };
    expect(selectAccount(r, reg, { task: "work" }, rank).why).toBe("task names work");
    expect(selectAccount(r, reg, { wave: "work" }, rank).why).toBe("wave names work");
    expect(selectAccount(r, reg, { configDefault: "primary" }, rank).why).toBe(
      "claude.default_account names primary",
    );
    expect(calls).toBe(0);
  });

  it("a profile on a paired machine is selectable there, refused here", () => {
    const r2 = root();
    addAccount(r2, { label: "far", machine: "peer-a" }, NOW);
    markSignedIn(r2, "far", { dir: "/path/to/home/.volley/claude/far" }, NOW);
    const reg2 = readRegistry(r2);
    expect(reg2.accounts[0]?.dir).toBe("/path/to/home/.volley/claude/far");
    expect(selectAccount(r2, reg2, { task: "far", machine: "peer-a" })).toMatchObject({
      id: "far",
      dir: "/path/to/home/.volley/claude/far",
      machine: "peer-a",
      source: "task",
    });
    expect(() => selectAccount(r2, reg2, { task: "far" })).toThrow(/peer-a/);
    const sel = selectAccount(r2, reg2, { machine: "peer-a", now: T }, (c) =>
      c
        .map((account) =>
          row(account, {
            headroom: account === "far@peer-a" ? 88 : 10,
            five_hour_pct: account === "far@peer-a" ? 12 : 90,
            score: account === "far@peer-a" ? 1.2 : 0.2,
            binding: "five_hour",
            binding_left: account === "far@peer-a" ? 88 : 10,
            binding_resets_at: at(250),
          }),
        )
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0)),
    );
    expect(sel).toMatchObject({
      id: "far",
      dir: "/path/to/home/.volley/claude/far",
      source: "balance",
    });
    expect(sel.why).toBe(
      "far: 88% left, resets in 4h 10m (use it or lose it) on peer-a; primary@peer-a 10% left, resets in 4h 10m",
    );
    // a local profile is not a candidate there, nor pinnable
    addAccount(r2, { label: "home" }, NOW);
    markSignedIn(r2, "home", {}, NOW);
    expect(() => selectAccount(r2, readRegistry(r2), { task: "home", machine: "peer-a" })).toThrow(
      /supervisor's machine/,
    );
  });

  it("a paired machine's profile signed out (or with no recorded dir) falls back to primary@<name>", () => {
    const r2 = root();
    addAccount(r2, { label: "far", machine: "peer-a" }, NOW);
    // ranked first if it were a candidate: it must not be one
    const rank = (c: readonly string[]) =>
      [...c]
        .map((account) =>
          row(account, {
            headroom: account === "far@peer-a" ? 90 : 10,
            five_hour_pct: account === "far@peer-a" ? 10 : 90,
            score: account === "far@peer-a" ? 1.2 : 0.2,
          }),
        )
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const signedOut = selectAccount(r2, readRegistry(r2), { machine: "peer-a" }, rank);
    expect(signedOut).toMatchObject({ id: PRIMARY_ACCOUNT, dir: null, machine: "peer-a" });
    markSignedIn(r2, "far", {}, NOW);
    const noDir = selectAccount(r2, readRegistry(r2), { machine: "peer-a" }, rank);
    expect(noDir).toMatchObject({ id: PRIMARY_ACCOUNT, dir: null, machine: "peer-a" });
  });

  it("refuses an unknown account and one that never finished signing in", () => {
    expect(() => selectAccount(r, reg, { wave: "nope" })).toThrow(/unknown Claude account 'nope'/);
    expect(() => selectAccount(r, reg, { task: "fresh" })).toThrow(/not signed in/);
  });

  it("a corrupt registry: the primary is still selectable; a profile pick is a ClaudeAccountError", () => {
    const r3 = root();
    mkdirSync(r3, { recursive: true });
    writeFileSync(join(r3, "accounts.json"), "{ not json");
    const read = () => readRegistry(r3);
    expect(selectAccount(r3, read, {}).id).toBe(PRIMARY_ACCOUNT);
    expect(() => selectAccount(r3, read, { task: "work" })).toThrow(ClaudeAccountError);
  });

  it("refuses a profile kept on another machine", () => {
    const r2 = root();
    addAccount(r2, { label: "far", machine: "studio" }, NOW);
    markSignedIn(r2, "far", {}, NOW);
    expect(() => selectAccount(r2, readRegistry(r2), { task: "far" })).toThrow(/studio/);
  });
});
