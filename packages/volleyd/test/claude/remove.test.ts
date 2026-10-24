import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readRegistry } from "../../src/claude/profiles";
import { ClaudeService } from "../../src/claude/service";
import { SshTmuxHost } from "../../src/hosts/ssh-tmux";
import type { NewEvent } from "../../src/types";
import { fakeExec } from "../helpers/fake-exec";
import { fakeSigninBox } from "../helpers/fake-host";
import { tempDir } from "../helpers/tmp";

/** `claude_account_remove`: the guards, the pending sign-in, the profile dir on its machine. */

const NOW = "2026-10-24T12:00:00.000Z";
const HOME = "/path/to/home";
const CALLBACK = readFileSync(
  new URL("../fixtures/claude/browser-url.txt", import.meta.url),
  "utf-8",
).trim();
const SPEC = {
  name: "box-a",
  target: "dev@box-a",
  repo: "/srv/repo",
  worktree_root: "/srv/wt",
  volley_dir: "/opt/volley",
  tunnel: { remote_port: 18830, supervise: true },
};

interface Uses {
  agents?: Record<string, string[]>;
  waves?: Record<string, string[]>;
  configDefault?: string | null;
}

/**
 * `team-here` and `solo` (not signed in) on this machine; `team` on box-a (its dir recorded
 * under the box's home) and `odd` there (a dir recorded elsewhere).
 */
function world(uses: Uses = {}, o: { boxDown?: boolean } = {}) {
  const base = tempDir("volleyd-remove-");
  const root = join(base, "claude");
  for (const id of ["team-here", "solo"]) mkdirSync(join(root, id), { recursive: true });
  writeFileSync(join(root, "team-here", "settings.json"), "{}\n");
  const signed = { signed_in_at: NOW, email: "team@example.com", plan: "max" };
  writeFileSync(
    join(root, "accounts.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        { id: "team-here", label: "Team", machine: "local", created: NOW, ...signed },
        { id: "solo", label: "Solo", machine: "local", created: NOW },
        {
          id: "team",
          label: "Team",
          machine: "box-a",
          created: NOW,
          ...signed,
          dir: `${HOME}/.volley/claude/team`,
        },
        { id: "odd", label: "Odd", machine: "box-a", created: NOW, ...signed, dir: "/srv/odd" },
      ],
    }),
  );
  const box = fakeSigninBox({ home: HOME });
  const host = new SshTmuxHost(SPEC, box.exec);
  // The local sign-in: tmux starts it, Claude Code's $BROWSER call writes the URL; never signed in.
  const fx = fakeExec()
    .on(["tmux", "new-session"], (argv) => {
      writeFileSync(join(argv[6] as string, "url"), CALLBACK);
      return {};
    })
    .on(["claude", "auth", "status"], { code: 1, stdout: JSON.stringify({ loggedIn: false }) });
  const journal: NewEvent[] = [];
  const changed: number[] = [];
  const service = new ClaudeService({
    root,
    primaryJson: join(base, ".claude.json"),
    exec: fx.exec,
    publish: async () => {},
    journal: async (ev) => {
      journal.push(ev);
    },
    log: () => {},
    sleep: () => new Promise((r) => setTimeout(r, 2)),
    signinPollMs: 2,
    signinTimeoutMs: 60_000,
    remote: (name) =>
      name === "box-a" && o.boxDown !== true ? host : `machine '${name}' is not reachable`,
    agentsOn: (key) => uses.agents?.[key] ?? [],
    wavesOn: (id) => uses.waves?.[id] ?? [],
    defaultAccount: () => uses.configDefault ?? null,
    onChanged: (rev) => {
      changed.push(rev);
    },
  });
  const ids = () => readRegistry(root).accounts.map((a) => `${a.id}@${a.machine}`);
  const removed = () => journal.filter((e) => e.type === "claude_account_removed");
  const rmSteps = () => box.ran("rm");
  return { base, root, service, journal, changed, ids, removed, rmSteps, fx };
}

const ALL = ["team-here@local", "solo@local", "team@box-a", "odd@box-a"];

describe("ClaudeService.remove: refused while the profile is in use", () => {
  it("a supervised agent on it: refused, naming the agent", async () => {
    const w = world({ agents: { "team@box-a": ["w1-t1-implementer-1"] } });
    const r = await w.service.remove({ acct: "team@box-a" }, "owner-1");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/w1-t1-implementer-1/);
    expect(w.ids()).toEqual(ALL);
    expect(w.removed()).toEqual([]);
    expect(w.service.rev).toBe(0);
  });

  it("a running wave pinned to it (wave or task account): refused, naming the wave", async () => {
    const w = world({ waves: { "team-here": ["2026-10-24-desk"] } });
    const r = await w.service.remove({ acct: "team-here" }, "owner-1");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/2026-10-24-desk/);
    expect(w.ids()).toEqual(ALL);
  });

  it("claude.default_account names it: refused (change Defaults first)", async () => {
    const w = world({ configDefault: "team-here" });
    const r = await w.service.remove({ acct: "team-here" }, "owner-1");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/change Defaults first/);
    expect(w.ids()).toEqual(ALL);
  });

  it("an unknown account and the primary are refused", async () => {
    const w = world();
    expect((await w.service.remove({ acct: "nope" }, "owner-1")).error).toMatch(/unknown/);
    expect((await w.service.remove({ acct: "team@box-b" }, "owner-1")).error).toMatch(/unknown/);
    expect((await w.service.remove({ acct: "primary" }, "owner-1")).ok).toBe(false);
    expect(w.ids()).toEqual(ALL);
  });
});

describe("ClaudeService.remove: a local profile", () => {
  it("removes the entry and the profile dir under the root; journals; bumps rev", async () => {
    const w = world();
    const r = await w.service.remove({ acct: "team-here" }, "owner-1");
    expect(r).toEqual({
      ok: true,
      result: { acct: "team-here", machine: "local", dir_removed: true },
    });
    expect(existsSync(join(w.root, "team-here"))).toBe(false);
    expect(existsSync(join(w.root, "solo"))).toBe(true);
    expect(w.ids()).toEqual(["solo@local", "team@box-a", "odd@box-a"]);
    expect(w.removed()).toEqual([
      {
        type: "claude_account_removed",
        data: { acct: "team-here", machine: "local", by: "owner-1", dir_removed: true },
      },
    ]);
    expect(w.service.rev).toBe(1);
    expect(w.changed).toEqual([1]);
  });

  it("a profile dir that leads outside the root is never touched", async () => {
    const w = world();
    const outside = join(w.base, "elsewhere");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "mine\n");
    const dir = join(w.root, "team-here");
    // the profile dir replaced by a link out of the root
    rmSync(dir, { recursive: true });
    symlinkSync(outside, dir);
    const r = await w.service.remove({ acct: "team-here" }, "owner-1");
    expect(r).toMatchObject({ ok: true, result: { dir_removed: false } });
    expect((r.result as { dir_left: string }).dir_left).toMatch(/outside/);
    expect(readFileSync(join(outside, "keep.txt"), "utf-8")).toBe("mine\n");
    expect(w.ids()).not.toContain("team-here@local");
  });

  it("a pending sign-in is aborted first", async () => {
    const w = world();
    const started = await w.service.signin({ acct: "solo" }, "owner-1");
    expect(started).toMatchObject({ ok: true, result: { acct: "solo" } });
    const r = await w.service.remove({ acct: "solo" }, "owner-1");
    expect(r.ok).toBe(true);
    const types = w.journal.map((e) => e.type);
    expect(types.indexOf("claude_signin_failed")).toBeGreaterThan(-1);
    expect(types.indexOf("claude_signin_failed")).toBeLessThan(
      types.indexOf("claude_account_removed"),
    );
    expect(w.journal.find((e) => e.type === "claude_signin_failed")?.data).toMatchObject({
      acct: "solo",
      reason: "the profile was removed",
    });
    expect(w.fx.argvs(["tmux", "kill-session"]).length).toBeGreaterThan(0);
    expect((await w.service.list()).result).toMatchObject({
      accounts: expect.not.arrayContaining([expect.objectContaining({ id: "solo" })]),
    });
  });
});

describe("ClaudeService.remove: a profile on a paired machine", () => {
  it("rm -rf <home>/.volley/claude/<acct> through the host (the fence admits it)", async () => {
    const w = world();
    const r = await w.service.remove({ acct: "team@box-a" }, "owner-1");
    expect(r).toEqual({
      ok: true,
      result: { acct: "team@box-a", machine: "box-a", dir_removed: true },
    });
    expect(w.rmSteps()).toEqual([["rm", "-rf", `${HOME}/.volley/claude/team`]]);
    expect(w.removed()[0]?.data).toEqual({
      acct: "team",
      machine: "box-a",
      by: "owner-1",
      dir_removed: true,
    });
    expect(w.ids()).toEqual(["team-here@local", "solo@local", "odd@box-a"]);
  });

  it("a recorded dir outside <home>/.volley/claude/ is left in place, and says why", async () => {
    const w = world();
    const r = await w.service.remove({ acct: "odd@box-a" }, "owner-1");
    expect(r).toMatchObject({ ok: true, result: { acct: "odd@box-a", dir_removed: false } });
    expect((r.result as { dir_left: string }).dir_left).toMatch(
      /\/srv\/odd is not under \/path\/to\/home\/\.volley\/claude\//,
    );
    expect(w.rmSteps()).toEqual([]);
    expect(w.ids()).not.toContain("odd@box-a");
  });

  it("an unreachable machine: the entry goes, the dir is left in place with the reason", async () => {
    const w = world({}, { boxDown: true });
    const r = await w.service.remove({ acct: "team@box-a" }, "owner-1");
    expect(r).toMatchObject({ ok: true, result: { dir_removed: false } });
    expect((r.result as { dir_left: string }).dir_left).toMatch(/not reachable/);
    expect(w.rmSteps()).toEqual([]);
  });
});
