import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readRegistry } from "../../src/claude/profiles";
import { ClaudeService } from "../../src/claude/service";
import { SshTmuxHost } from "../../src/hosts/ssh-tmux";
import type { NewEvent } from "../../src/types";
import { flushMicrotasks } from "../helpers/fake-clock";
import { fakeExec } from "../helpers/fake-exec";
import { fakeSigninBox } from "../helpers/fake-host";
import { tempDir } from "../helpers/tmp";

/**
 * A finished sign-in is primed (`prime`): the login's identity and plan from `claude auth status`
 * under its config dir (its `.claude.json` when the status has no e-mail), then its machine's
 * usage probe for that login. `claude_prime { acct }` asks again, at most once per 5 min.
 */

const NOW = "2026-10-24T12:00:00.000Z";
const HOME = "/path/to/home";
const EMAIL = "team@example.com";
const SPEC = {
  name: "box-a",
  target: "dev@box-a",
  repo: "/srv/repo",
  worktree_root: "/srv/wt",
  volley_dir: "/opt/volley",
  tunnel: { remote_port: 18830, supervise: true },
};
const STATUS = {
  loggedIn: true,
  authMethod: "claude.ai",
  email: EMAIL,
  orgName: "Example Org",
  subscriptionType: "team",
};

function world(
  o: {
    status?: Record<string, unknown>;
    claudeJson?: Record<string, unknown>;
    /** Runs at the n-th local `claude auth status`, before it answers. */
    onStatus?: (n: number, root: string) => void;
  } = {},
) {
  const base = tempDir("volleyd-prime-");
  const root = join(base, "claude");
  mkdirSync(join(root, "team"), { recursive: true });
  // A fresh profile's .claude.json: seeded, no oauthAccount until a session ran in it.
  writeFileSync(
    join(root, "team", ".claude.json"),
    JSON.stringify(o.claudeJson ?? { hasCompletedOnboarding: true }),
  );
  writeFileSync(
    join(root, "accounts.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        { id: "team", label: "Team", machine: "local", created: NOW },
        { id: "far", label: "Far", machine: "box-a", created: NOW },
      ],
    }),
  );
  const status = o.status ?? STATUS;
  const box = fakeSigninBox({ home: HOME, signInAfter: 2, status });
  const host = new SshTmuxHost(SPEC, box.exec);
  let polls = 0;
  const fx = fakeExec()
    .on(["tmux", "has-session"], {})
    .on(["claude", "auth", "status"], () => {
      polls++;
      o.onStatus?.(polls, root);
      return polls >= 2
        ? { stdout: JSON.stringify(status) }
        : { code: 1, stdout: JSON.stringify({ loggedIn: false }) };
    });
  const journal: NewEvent[] = [];
  const probes: string[] = [];
  const logs: string[] = [];
  let probed: () => void = () => {};
  const nextProbe = () =>
    new Promise<void>((r) => {
      probed = r;
    });
  let t = Date.parse(NOW);
  const service = new ClaudeService({
    root,
    primaryJson: join(base, ".claude.json"),
    exec: (argv, opts) => (argv[0] === "ssh" ? box.exec(argv, opts) : fx.exec(argv, opts)),
    publish: async () => {},
    journal: async (ev) => {
      journal.push(ev);
    },
    log: (m) => {
      logs.push(m);
    },
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      await flushMicrotasks(1);
    },
    signinPollMs: 2,
    signinTimeoutMs: 60_000,
    remote: (name) => (name === "box-a" ? host : `machine '${name}' is not reachable`),
    probe: async (machine, profile) => {
      probes.push(`${profile}@${machine}`);
      probed();
    },
  });
  const entry = (id: string) => readRegistry(root).accounts.find((a) => a.id === id);
  return {
    root,
    service,
    journal,
    probes,
    logs,
    nextProbe,
    fx,
    box,
    entry,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("ClaudeService.prime on claude_signin_done", () => {
  it("a local profile: auth status under its config dir, { plan, email, org } stored, the local probe", async () => {
    const w = world();
    const probed = w.nextProbe();
    const r = await w.service.signin({ acct: "team" }, "owner-1");
    expect(r.ok).toBe(true);
    await probed;
    const statuses = w.fx.calls.filter((c) => c.argv.join(" ") === "claude auth status");
    // the refusal check, the polls, then the prime's own read
    expect(statuses.length).toBeGreaterThanOrEqual(3);
    for (const c of statuses) expect(c.opts.env?.CLAUDE_CONFIG_DIR).toBe(join(w.root, "team"));
    expect(w.entry("team")).toMatchObject({ plan: "team", email: EMAIL, org: "Example Org" });
    expect(w.probes).toEqual(["team@local"]);
  });

  it("the profile's .claude.json when the status has no e-mail", async () => {
    const w = world({
      status: { loggedIn: true, subscriptionType: "max" },
      claudeJson: { oauthAccount: { emailAddress: "Solo@Example.com", organizationName: "Solo" } },
    });
    const probed = w.nextProbe();
    await w.service.signin({ acct: "team" }, "owner-1");
    await probed;
    expect(w.entry("team")).toMatchObject({ plan: "max", email: "solo@example.com", org: "Solo" });
  });

  it("a paired machine's profile: auth status through host.run with CLAUDE_CONFIG_DIR, its machine's probe", async () => {
    const w = world();
    const probed = w.nextProbe();
    const r = await w.service.signin({ acct: "far@box-a" }, "owner-1");
    expect(r.ok).toBe(true);
    await probed;
    const steps = w.box.remoteSteps().filter((s) => s.argv[0] === "claude");
    expect(steps.at(-1)).toMatchObject({
      argv: ["claude", "auth", "status"],
      env: { CLAUDE_CONFIG_DIR: `${HOME}/.volley/claude/far` },
    });
    expect(w.entry("far")).toMatchObject({ plan: "team", email: EMAIL, org: "Example Org" });
    expect(w.probes).toEqual(["far@box-a"]);
  });

  it("a profile removed while its login is read: the prime gives up, the daemon goes on", async () => {
    // the refusal check, the poll that finds it signed in, then the prime's read (3rd)
    const w = world({
      onStatus: (n, root) => {
        if (n !== 3) return;
        const reg = readRegistry(root);
        writeFileSync(
          join(root, "accounts.json"),
          JSON.stringify({ ...reg, accounts: reg.accounts.filter((a) => a.id !== "team") }),
        );
      },
    });
    const r = await w.service.signin({ acct: "team" }, "owner-1");
    expect(r.ok).toBe(true);
    await flushMicrotasks(50);
    expect(w.entry("team")).toBeUndefined();
    expect(w.probes).toEqual([]);
    expect(w.logs.some((m) => m.includes("prime team: unknown Claude account 'team'"))).toBe(true);
  });

  it("the journal never carries the e-mail", async () => {
    const w = world();
    const probed = w.nextProbe();
    await w.service.signin({ acct: "team" }, "owner-1");
    await probed;
    await w.service.prime({ acct: "team" }, "owner-1");
    expect(w.journal.some((e) => e.type === "claude_signin_done")).toBe(true);
    expect(JSON.stringify(w.journal)).not.toContain(EMAIL);
  });
});

describe("claude_prime { acct }", () => {
  it("reads and probes a signed-in login; again inside 5 min is refused with when", async () => {
    const w = world({ status: STATUS });
    // signed in already (by hand): the status answers loggedIn from the 2nd call on
    await w.fx.exec(["claude", "auth", "status"], {});
    const first = await w.service.prime({ acct: "team" }, "owner-1");
    expect(first).toMatchObject({ ok: true, result: { acct: "team" } });
    expect(w.entry("team")).toMatchObject({ email: EMAIL, plan: "team" });
    expect(w.probes).toEqual(["team@local"]);
    w.advance(2 * 60_000);
    expect(await w.service.prime({ acct: "team" }, "owner-1")).toEqual({
      ok: false,
      error: "primed 2 min ago; next in 3 min",
    });
    expect(w.probes).toEqual(["team@local"]);
    w.advance(3 * 60_000);
    expect((await w.service.prime({ acct: "team" }, "owner-1")).ok).toBe(true);
    expect(w.probes).toEqual(["team@local", "team@local"]);
  });

  it("the machine's own login (primary, primary@<name>): only the probe of its default profile", async () => {
    const w = world();
    expect((await w.service.prime({ acct: "primary@box-a" }, "owner-1")).ok).toBe(true);
    expect(w.probes).toEqual(["default@box-a"]);
  });

  it("an unknown account is refused", async () => {
    const w = world();
    expect(await w.service.prime({ acct: "nope" }, "owner-1")).toEqual({
      ok: false,
      error: "unknown Claude account 'nope'",
    });
    expect(await w.service.prime({}, "owner-1")).toEqual({
      ok: false,
      error: "claude_prime needs an acct",
    });
  });
});
