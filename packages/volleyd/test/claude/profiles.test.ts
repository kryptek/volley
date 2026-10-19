import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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

const root = () => mkdtempSync(join(tmpdir(), "volley-claude-"));
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

  it("an absent registry is empty", () => {
    expect(readRegistry(root())).toEqual({ version: 1, accounts: [] });
  });
});

describe("selectAccount: task > wave > config default > primary", () => {
  const r = root();
  addAccount(r, { label: "work" }, NOW);
  markSignedIn(r, "work", { plan: "max" }, NOW);
  addAccount(r, { label: "fresh" }, NOW);
  const reg = readRegistry(r);

  it("nothing set → the primary profile (no CLAUDE_CONFIG_DIR)", () => {
    expect(selectAccount(r, reg, {})).toEqual({
      id: PRIMARY_ACCOUNT,
      dir: null,
      source: "default",
    });
  });

  it("the config default, then the wave, then the task", () => {
    expect(selectAccount(r, reg, { configDefault: "work" })).toEqual({
      id: "work",
      dir: profileDir(r, "work"),
      source: "config",
    });
    expect(selectAccount(r, reg, { configDefault: "work", wave: "primary" }).id).toBe("primary");
    expect(
      selectAccount(r, reg, { configDefault: "primary", wave: "primary", task: "work" }),
    ).toMatchObject({ id: "work", source: "task" });
  });

  it("most_headroom falls back to the primary without usage data", () => {
    expect(selectAccount(r, reg, { configDefault: "most_headroom" })).toEqual({
      id: PRIMARY_ACCOUNT,
      dir: null,
      source: "config",
      fallback: "most_headroom",
    });
    expect(selectAccount(r, reg, { configDefault: "most_headroom" }, () => null)).toMatchObject({
      id: PRIMARY_ACCOUNT,
      fallback: "most_headroom",
    });
  });

  it("most_headroom resolves to the account usage metering ranks first", () => {
    expect(selectAccount(r, reg, { wave: "most_headroom" }, () => "work")).toEqual({
      id: "work",
      dir: profileDir(r, "work"),
      source: "wave",
    });
    expect(selectAccount(r, reg, { wave: "most_headroom" }, () => PRIMARY_ACCOUNT)).toEqual({
      id: PRIMARY_ACCOUNT,
      dir: null,
      source: "wave",
    });
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
