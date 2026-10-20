import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHARING,
  SHARE_ITEMS,
  SharingError,
  applySharing,
  parseSharing,
  planSharing,
  readSharing,
  seedOnboarding,
  sharingPath,
  syncMcp,
} from "../../src/claude/sharing";
import { tempDir } from "../helpers/tmp";

/** A primary profile (`~/.claude` + `~/.claude.json`) and an empty account profile. */
function setup() {
  const base = tempDir("volley-share-");
  const primary = join(base, "home", ".claude");
  const primaryJson = join(base, "home", ".claude.json");
  const profile = join(base, "claude", "work");
  mkdirSync(primary, { recursive: true });
  mkdirSync(profile, { recursive: true });
  for (const d of ["skills", "agents", "commands", "plugins"]) mkdirSync(join(primary, d));
  writeFileSync(join(primary, "CLAUDE.md"), "# rules\n");
  writeFileSync(join(primary, "settings.json"), '{"model":"opus"}\n');
  writeFileSync(join(primary, ".credentials.json"), "{}");
  writeFileSync(
    primaryJson,
    JSON.stringify({
      oauthAccount: { emailAddress: "owner@example.com" },
      userID: "u-primary",
      mcpServers: { volley: { command: "bun", args: ["run", "x"], env: { SECRET: "s" } } },
      projects: { "/repo": { hasTrustDialogAccepted: true } },
    }),
  );
  return { base, primary, primaryJson, profile, root: join(base, "claude") };
}

describe("sharing.yaml", () => {
  it("covers exactly the shareable items, with safe defaults", () => {
    expect([...SHARE_ITEMS].sort()).toEqual(
      ["CLAUDE.md", "agents", "commands", "mcp", "plugins", "settings.json", "skills"].sort(),
    );
    // settings.json is written through by /model in any profile: never linked by default.
    expect(DEFAULT_SHARING["settings.json"]).toBe("copy");
    expect(DEFAULT_SHARING["CLAUDE.md"]).toBe("linked");
    expect(DEFAULT_SHARING.mcp).toBe("copy");
  });

  it("parses per-item modes over the defaults; rejects unknown items and modes", () => {
    expect(parseSharing("settings.json: own\nskills: copy\n")).toEqual({
      ...DEFAULT_SHARING,
      "settings.json": "own",
      skills: "copy",
    });
    expect(() => parseSharing(".claude.json: linked\n")).toThrow(/\.claude\.json/);
    expect(() => parseSharing(".credentials.json: copy\n")).toThrow(SharingError);
    expect(() => parseSharing("skills: symlink\n")).toThrow(/linked \| copy \| own/);
    expect(() => parseSharing("mcp: linked\n")).toThrow(/mcp.*never linked/);
  });

  it("an absent file is the defaults", () => {
    const s = setup();
    expect(readSharing(s.root)).toEqual(DEFAULT_SHARING);
    writeFileSync(sharingPath(s.root), "agents: own\n");
    expect(readSharing(s.root).agents).toBe("own");
  });
});

describe("applySharing", () => {
  it("linked creates symlinks to ~/.claude/<item> for the allowed items only", () => {
    const s = setup();
    const out = applySharing(
      planSharing({ ...DEFAULT_SHARING, "settings.json": "linked" }, s.primary, s.profile),
    );
    for (const item of ["CLAUDE.md", "skills", "agents", "commands", "plugins", "settings.json"]) {
      expect(lstatSync(join(s.profile, item)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(s.profile, item))).toBe(join(s.primary, item));
    }
    // Never touched: the credentials fallback, the account file.
    expect(existsSync(join(s.profile, ".credentials.json"))).toBe(false);
    expect(existsSync(join(s.profile, ".claude.json"))).toBe(false);
    expect(out.map((r) => r.item as string)).not.toContain(".claude.json");
  });

  it("copy is a one-time copy; an existing file is the profile's own from then on", () => {
    const s = setup();
    applySharing(planSharing(DEFAULT_SHARING, s.primary, s.profile));
    const settings = join(s.profile, "settings.json");
    expect(lstatSync(settings).isSymbolicLink()).toBe(false);
    expect(readFileSync(settings, "utf-8")).toBe('{"model":"opus"}\n');
    writeFileSync(settings, '{"model":"sonnet"}\n');
    const again = applySharing(planSharing(DEFAULT_SHARING, s.primary, s.profile));
    expect(readFileSync(settings, "utf-8")).toBe('{"model":"sonnet"}\n');
    expect(again.find((r) => r.item === "settings.json")?.result).toBe("kept");
  });

  it("linked never replaces a real file or directory of the profile's own", () => {
    const s = setup();
    writeFileSync(join(s.profile, "CLAUDE.md"), "# mine\n");
    const out = applySharing(planSharing(DEFAULT_SHARING, s.primary, s.profile));
    expect(readFileSync(join(s.profile, "CLAUDE.md"), "utf-8")).toBe("# mine\n");
    expect(out.find((r) => r.item === "CLAUDE.md")?.result).toMatch(/conflict/);
  });

  it("own removes only a link volleyd made to the primary", () => {
    const s = setup();
    applySharing(planSharing(DEFAULT_SHARING, s.primary, s.profile));
    applySharing(planSharing({ ...DEFAULT_SHARING, agents: "own" }, s.primary, s.profile));
    expect(existsSync(join(s.profile, "agents"))).toBe(false);
    symlinkSync(join(s.base, "elsewhere"), join(s.profile, "agents"));
    applySharing(planSharing({ ...DEFAULT_SHARING, agents: "own" }, s.primary, s.profile));
    expect(lstatSync(join(s.profile, "agents")).isSymbolicLink()).toBe(true);
  });

  it("a missing primary item is skipped, never linked dangling", () => {
    const s = setup();
    const out = applySharing(
      planSharing(DEFAULT_SHARING, join(s.base, "no-such-claude"), s.profile),
    );
    expect(existsSync(join(s.profile, "skills"))).toBe(false);
    expect(out.find((r) => r.item === "skills")?.result).toBe("skipped: not in the primary");
  });
});

describe("syncMcp: .claude.json is copied per section, never linked", () => {
  it("creates the profile's .claude.json with only the primary's MCP servers", () => {
    const s = setup();
    const r = syncMcp(s.primaryJson, join(s.profile, ".claude.json"));
    const out = JSON.parse(readFileSync(join(s.profile, ".claude.json"), "utf-8"));
    expect(out).toEqual({
      mcpServers: { volley: { command: "bun", args: ["run", "x"], env: { SECRET: "s" } } },
    });
    expect(lstatSync(join(s.profile, ".claude.json")).isSymbolicLink()).toBe(false);
    expect(statSync(join(s.profile, ".claude.json")).mode & 0o777).toBe(0o600);
    // The result names servers, never their contents (env, headers can hold secrets).
    expect(r).toEqual({ servers: ["volley"], changed: true });
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });

  it("updates only mcpServers and keeps the profile's own account and projects", () => {
    const s = setup();
    const dst = join(s.profile, ".claude.json");
    writeFileSync(
      dst,
      JSON.stringify({
        oauthAccount: { emailAddress: "work@example.com" },
        userID: "u-work",
        projects: { "/w": { hasTrustDialogAccepted: true } },
        mcpServers: { stale: { command: "x" } },
      }),
    );
    syncMcp(s.primaryJson, dst);
    const out = JSON.parse(readFileSync(dst, "utf-8"));
    expect(out.oauthAccount).toEqual({ emailAddress: "work@example.com" });
    expect(out.userID).toBe("u-work");
    expect(out.projects).toEqual({ "/w": { hasTrustDialogAccepted: true } });
    expect(Object.keys(out.mcpServers)).toEqual(["volley"]);
    expect(syncMcp(s.primaryJson, dst).changed).toBe(false);
  });

  it("refuses to write through a symlinked .claude.json", () => {
    const s = setup();
    const dst = join(s.profile, ".claude.json");
    symlinkSync(s.primaryJson, dst);
    expect(() => syncMcp(s.primaryJson, dst)).toThrow(/symlink/);
  });

  it("waits out Claude Code's own lock, then gives up", () => {
    const s = setup();
    const dst = join(s.profile, ".claude.json");
    mkdirSync(`${dst}.lock`);
    expect(() => syncMcp(s.primaryJson, dst, { lockAttempts: 2, lockWaitMs: 1 })).toThrow(/lock/);
  });

  it("takes over a stale lock a crashed process left behind", () => {
    const s = setup();
    const dst = join(s.profile, ".claude.json");
    mkdirSync(`${dst}.lock`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${dst}.lock`, old, old);
    expect(syncMcp(s.primaryJson, dst, { lockAttempts: 2, lockWaitMs: 1 }).changed).toBe(true);
    expect(existsSync(`${dst}.lock`)).toBe(false);
  });
});

describe("seedOnboarding", () => {
  it("marks a fresh profile's onboarding done, keeping its own keys; once", () => {
    const s = setup();
    const dst = join(s.profile, ".claude.json");
    writeFileSync(dst, JSON.stringify({ userID: "u-work" }));
    expect(seedOnboarding(dst)).toBe(true);
    expect(JSON.parse(readFileSync(dst, "utf-8"))).toEqual({
      userID: "u-work",
      hasCompletedOnboarding: true,
    });
    expect(seedOnboarding(dst)).toBe(false);
  });

  it("refuses a symlinked .claude.json too", () => {
    const s = setup();
    const dst = join(s.profile, ".claude.json");
    symlinkSync(s.primaryJson, dst);
    expect(() => seedOnboarding(dst)).toThrow(/symlink/);
  });
});
