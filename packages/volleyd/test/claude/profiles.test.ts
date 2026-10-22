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

  it("null (and most_headroom) balances across the signed-in accounts by rank", () => {
    const rank = (c: readonly string[]): Ranked[] =>
      [...c].reverse().map((account, i) => ({
        account,
        headroom: 60 - i * 30,
        five_hour_pct: 12 + i * 70,
        weekly_pct: 40,
        agents: 0,
      }));
    for (const configDefault of [null, "most_headroom"]) {
      const sel = selectAccount(r, reg, { configDefault }, rank);
      expect(sel).toMatchObject({
        id: "work",
        dir: profileDir(r, "work"),
        source: "balance",
        machine: "local",
        why: "work: most headroom on local (5h 12%, 7d 40%; primary 5h 82%)",
      });
      expect(sel.candidates?.map((x) => x.account)).toEqual(["work", "primary"]);
    }
    // without usage data a signed-in profile is offered before the primary
    expect(selectAccount(r, reg, {}).id).toBe("work");
    expect(selectAccount(r, reg, { wave: "most_headroom" }).source).toBe("balance");
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
    const sel = selectAccount(r2, reg2, { machine: "peer-a" }, (c) =>
      c
        .map((account) => ({
          account,
          headroom: account === "far@peer-a" ? 60 : 10,
          five_hour_pct: account === "far@peer-a" ? 12 : 90,
          weekly_pct: null,
          agents: 0,
        }))
        .sort((a, b) => (b.headroom ?? 0) - (a.headroom ?? 0)),
    );
    expect(sel).toMatchObject({ id: "far", dir: "/path/to/home/.volley/claude/far", source: "balance" });
    expect(sel.why).toBe("far: most headroom on peer-a (5h 12%; primary@peer-a 5h 90%)");
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
        .map((account) => ({
          account,
          headroom: account === "far@peer-a" ? 90 : 10,
          five_hour_pct: account === "far@peer-a" ? 10 : 90,
          weekly_pct: null,
          agents: 0,
        }))
        .sort((a, b) => (b.headroom ?? 0) - (a.headroom ?? 0));
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
