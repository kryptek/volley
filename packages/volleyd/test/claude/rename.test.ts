import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readRegistry } from "../../src/claude/profiles";
import { ClaudeService } from "../../src/claude/service";
import type { NewEvent } from "../../src/types";
import { fakeExec } from "../helpers/fake-exec";
import { tempDir } from "../helpers/tmp";

/** `claude_account_rename`: the service over a real registry file. */

const NOW = "2026-10-24T12:00:00.000Z";

/** `team` on box-a and `team-here` on this machine: one login (the same e-mail); `solo` here. */
function world() {
  const base = tempDir("volleyd-rename-");
  const root = join(base, "claude");
  mkdirSync(root, { recursive: true });
  const signed = { signed_in_at: NOW, email: "team@example.com", plan: "max" };
  writeFileSync(
    join(root, "accounts.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        { id: "team-here", label: "Team", machine: "local", created: NOW, ...signed },
        {
          id: "team",
          label: "Team",
          machine: "box-a",
          created: NOW,
          ...signed,
          dir: "/path/to/home/.volley/claude/team",
        },
        { id: "solo", label: "Solo", machine: "local", created: NOW },
      ],
    }),
  );
  const journal: NewEvent[] = [];
  const changed: number[] = [];
  const service = new ClaudeService({
    root,
    primaryJson: join(base, ".claude.json"),
    exec: fakeExec().exec,
    publish: async () => {},
    journal: async (ev) => {
      journal.push(ev);
    },
    log: () => {},
    onChanged: (rev) => {
      changed.push(rev);
    },
  });
  return { root, service, journal, changed };
}

describe("ClaudeService.rename", () => {
  it("relabels every profile of the login, journals the rename, bumps rev and fires onChanged", async () => {
    const w = world();
    expect(w.service.rev).toBe(0);
    const r = await w.service.rename({ acct: "team@box-a", label: " Team account " }, "owner-1");
    expect(r).toEqual({
      ok: true,
      result: { acct: "team@box-a", label: "Team account", renamed: ["team-here", "team@box-a"] },
    });
    expect(w.journal).toEqual([
      {
        type: "claude_account_renamed",
        data: { acct: "team@box-a", from: "Team", to: "Team account", by: "owner-1" },
      },
    ]);
    expect(w.service.rev).toBe(1);
    expect(w.changed).toEqual([1]);
    expect(readRegistry(w.root).accounts.map((a) => a.label)).toEqual([
      "Team account",
      "Team account",
      "Solo",
    ]);
  });

  it("the usage records' label follows at the next pass (describe reads the registry)", async () => {
    const w = world();
    expect(w.service.describe("team@box-a").label).toBe("Team");
    await w.service.rename({ acct: "team@box-a", label: "Team account" }, "owner-1");
    expect(w.service.describe("team@box-a").label).toBe("Team account");
    expect(w.service.describe("team-here").label).toBe("Team account");
    expect(w.service.describe("solo").label).toBe("Solo");
  });

  it("a bare id names the profile wherever it lives", async () => {
    const w = world();
    const r = await w.service.rename({ acct: "solo", label: "Solo 2" }, "owner-1");
    expect(r).toMatchObject({ ok: true, result: { acct: "solo", renamed: ["solo"] } });
  });

  it.each([
    [{ acct: "team@box-b", label: "x" }, /unknown Claude account 'team@box-b'/],
    [{ acct: "team@box-a", label: "  " }, /cannot be empty/],
    [{ acct: "team@box-a", label: "Primary" }, /reserved/],
    [{ acct: "primary", label: "Mine" }, /cannot be renamed/],
    [{ label: "x" }, /needs an acct/],
  ])("refuses %j: no journal, no rev", async (p, error) => {
    const w = world();
    const r = await w.service.rename(p, "owner-1");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(error);
    expect(w.journal).toEqual([]);
    expect(w.service.rev).toBe(0);
    expect(w.changed).toEqual([]);
  });
});
