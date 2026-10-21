import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { buildTopic } from "volley-mcp/topics";
import { addAccount } from "../../src/claude/profiles";
import { signinDir } from "../../src/claude/signin";
import { usageAccountTopic } from "../../src/claude/usage";
import { ControlClient } from "../../src/control";
import { readJournalFile } from "../../src/journal";
import { MACHINE_CHANNEL, machineTopic } from "../../src/machines";
import { eventually } from "../helpers/broker-wait";
import { type DaemonEnv, NS, makeDaemonEnv } from "../helpers/daemon-env";
import { fakeClock } from "../helpers/fake-clock";
import { fakeExec } from "../helpers/fake-exec";
import { SIGNIN_CALLBACK, type SigninBoxOptions, fakeSigninBox } from "../helpers/fake-host";
import { journalWait } from "../helpers/journal-wait";
import { schemaErrors } from "../helpers/schema";
import { tempDir } from "../helpers/tmp";

/** The claude_* control ops end to end: a real daemon on Aedes, a fake tmux / claude. */

const CALLBACK = readFileSync(
  new URL("../fixtures/claude/browser-url.txt", import.meta.url),
  "utf-8",
).trim();

let env: DaemonEnv;
afterEach(() => env.cleanup());

/** What `claude auth status` says for Claude Code's default profile (no CLAUDE_CONFIG_DIR). */
const PRIMARY_STATUS = { loggedIn: true, subscriptionType: "pro" };

/** Claude Code signing a profile in: it records the login in the profile's `.claude.json`. */
function signedInAs(dir: string) {
  writeFileSync(
    join(dir, ".claude.json"),
    JSON.stringify({
      userID: "c0ffee",
      oauthAccount: {
        accountUuid: "11111111-2222-3333-4444-555555555555",
        emailAddress: "owner@example.com",
        organizationName: "Example Org",
      },
    }),
  );
  return { stdout: JSON.stringify({ loggedIn: true, subscriptionType: "max" }) };
}

async function setup(opts: { signInAfter?: number; primary?: Record<string, unknown> } = {}) {
  env = await makeDaemonEnv();
  const base = tempDir("volleyd-claude-");
  const root = join(base, "claude");
  const primary = join(base, ".claude");
  const primaryJson = join(base, ".claude.json");
  mkdirSync(join(primary, "agents"), { recursive: true });
  writeFileSync(join(primary, "CLAUDE.md"), "# rules\n");
  writeFileSync(
    primaryJson,
    JSON.stringify({
      oauthAccount: { emailAddress: "me@example.com", organizationName: "Home" },
      mcpServers: { volley: { env: { K: "secret" } } },
    }),
  );
  let polls = 0;
  const fx = fakeExec()
    .on(["tmux", "new-session"], (argv) => {
      writeFileSync(join(argv[6] as string, "url"), CALLBACK);
      return {};
    })
    .on(["claude", "auth", "status"], (_argv, o) =>
      o.env?.CLAUDE_CONFIG_DIR === undefined
        ? { stdout: JSON.stringify(opts.primary ?? PRIMARY_STATUS) }
        : ++polls >= (opts.signInAfter ?? 3)
          ? signedInAs(o.env.CLAUDE_CONFIG_DIR as string)
          : { code: 1, stdout: JSON.stringify({ loggedIn: false }) },
    );
  // The sign-in's poll interval and timeout run on the daemon's clock: polls happen as it moves.
  const clock = fakeClock();
  const daemon = await env.start({
    clock,
    claude: { root, primaryDir: primary, exec: fx.exec, signinPollMs: 20, signinTimeoutMs: 5000 },
    spawner: { claudeJsonPath: primaryJson },
  });
  const waits = journalWait(env.home, () => daemon);
  const client = await ControlClient.connect(env.broker.url, NS);
  const watcher = new VolleyBroker();
  await watcher.connect({ url: env.broker.url, agentId: "signin-watcher" });
  const seen: { type: string; payload: Record<string, unknown> }[] = [];
  await watcher.subscribeStream("volley/_system/claude/+/signin", ({ payload }) => {
    const e = parseEnvelope(payload);
    if (e !== null) seen.push({ type: e.type, payload: e.payload as Record<string, unknown> });
  });
  const system = () => readJournalFile(join(env.home, "waves", "_system", "journal.jsonl"));
  /** Poll after poll (each one waits on the clock) until the sign-in is journaled done. */
  const signedIn = async () => {
    let finished = false;
    const done = waits.event("_system", "claude_signin_done").then(() => {
      finished = true;
    });
    while (!finished) {
      await Promise.race([clock.armed(20), done]);
      if (!finished) await clock.advance(20);
    }
  };
  const reader = (acct: string) => env.retained(usageAccountTopic(acct));
  return { root, primary, fx, client, watcher, seen, system, signedIn, reader };
}

describe("claude_* control ops", () => {
  it("claude_account_add answers with the sign-in URL; done flips the registry; nothing secret is journaled", async () => {
    const t = await setup();
    try {
      const r = await t.client.request("claude_account_add", { label: "Work", by: "owner-1" });
      expect(r.ok).toBe(true);
      expect(r.result).toMatchObject({
        account: { id: "work", label: "Work", machine: "local" },
        acct: "work",
        url: CALLBACK,
        flow: "browser_callback",
        topic: "volley/_system/claude/work/signin",
      });
      await t.signedIn();
      // The sign-in events reach the watcher over MQTT; the done one is published after its
      // journal entry, so wait for it there.
      await eventually(() => t.seen.some((e) => e.type === "claude_signin_done"));
      expect(t.seen.map((e) => e.type)).toEqual(["claude_signin_url", "claude_signin_done"]);
      expect(t.seen.at(-1)?.payload).toEqual({
        type: "claude_signin_done",
        acct: "work",
        plan: "max",
        email: "owner@example.com",
        org: "Example Org",
      });
      // non-retained: nothing left on the topic
      expect(await env.retained("volley/_system/claude/work/signin")).toBeNull();

      const list = await t.client.request("claude_accounts", {});
      const accounts = (list.result as { accounts: Record<string, unknown>[] }).accounts;
      expect(accounts[0]).toMatchObject({
        id: "work",
        plan: "max",
        email: "owner@example.com",
        org: "Example Org",
        signin: { state: "signed_in" },
      });

      const types = t.system().map((e) => e.type);
      expect(types).toEqual(
        expect.arrayContaining([
          "claude_account_added",
          "claude_signin_started",
          "claude_signin_done",
        ]),
      );
      const journal = readFileSync(join(env.home, "waves", "_system", "journal.jsonl"), "utf-8");
      expect(journal).not.toContain("oauth/authorize");
      expect(journal).not.toContain("secret");
      // The login's identity lives in the registry and the retained records, never the journal.
      expect(journal).not.toContain("@example.com");
      expect(journal).not.toContain("Example Org");
    } finally {
      await t.client.close();
      await t.watcher.disconnect();
    }
  });

  it("while a sign-in waits for the browser, claude_accounts shows its URL to a late client", async () => {
    const t = await setup({ signInAfter: 10_000 });
    try {
      await t.client.request("claude_account_add", { label: "slow" });
      const list = await t.client.request("claude_accounts", {});
      const a = (list.result as { accounts: Record<string, unknown>[] }).accounts[0];
      expect(a?.signin).toEqual({
        state: "pending",
        url: CALLBACK,
        flow: "browser_callback",
        attach: "tmux attach -t volley-signin-slow",
      });
      expect(signinDir(t.root, "slow")).toContain(t.root);
    } finally {
      await t.client.close();
      await t.watcher.disconnect();
    }
  });

  it("claude_account_add refuses a machine that is not paired, and a duplicate", async () => {
    const t = await setup();
    try {
      const far = await t.client.request("claude_account_add", { label: "x", machine: "studio" });
      expect(far).toMatchObject({ ok: false, error: expect.stringMatching(/studio/) });
      expect(
        (await t.client.request("claude_accounts", {})).result as { accounts: unknown[] },
      ).toMatchObject({ accounts: [] });
      await t.client.request("claude_account_add", { label: "dup" });
      const again = await t.client.request("claude_account_add", { label: "dup" });
      expect(again).toMatchObject({ ok: false, error: expect.stringMatching(/already exists/) });
    } finally {
      await t.client.close();
      await t.watcher.disconnect();
    }
  });

  it("claude_sync applies sharing and syncs the MCP servers, journaling counts only", async () => {
    const t = await setup({ signInAfter: 1 });
    try {
      await t.client.request("claude_account_add", { label: "work" });
      const r = await t.client.request("claude_sync", { acct: "work" });
      expect(r.ok).toBe(true);
      const dir = join(t.root, "work");
      expect(lstatSync(join(dir, "CLAUDE.md")).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(dir, "agents")).isSymbolicLink()).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, ".claude.json"), "utf-8")).mcpServers).toEqual({
        volley: { env: { K: "secret" } },
      });
      const synced = t.system().find((e) => e.type === "claude_profile_synced");
      expect(synced?.data).toMatchObject({ acct: "work", mcp_servers: 1 });
      expect(JSON.stringify(synced)).not.toContain("secret");
      expect(await t.client.request("claude_sync", { acct: "nope" })).toMatchObject({ ok: false });
    } finally {
      await t.client.close();
      await t.watcher.disconnect();
    }
  });

  it("claude_signin refuses a profile that is already signed in, with the logout remedy", async () => {
    const t = await setup({ signInAfter: 1 });
    try {
      await t.client.request("claude_account_add", { label: "work" });
      await t.signedIn();
      const r = await t.client.request("claude_signin", { acct: "work" });
      // Rule under bun:test: never re-read a field you matched with an asymmetric matcher
      // (toMatchObject + expect.stringMatching). bun writes the matcher into the received object,
      // so a later read of r.error sees the matcher, not the string. Assert on the string instead.
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/already signed in/);
      expect(r.error).toContain("claude auth logout");
    } finally {
      await t.client.close();
      await t.watcher.disconnect();
    }
  });

  it("a corrupt accounts.json: claude_accounts answers with the error, not a crash", async () => {
    const t = await setup();
    try {
      mkdirSync(t.root, { recursive: true });
      writeFileSync(join(t.root, "accounts.json"), "{ not json");
      const r = await t.client.request("claude_accounts", {});
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/not valid JSON/) });
    } finally {
      await t.client.close();
      await t.watcher.disconnect();
    }
  });

  it("claude_accounts reports the primary's plan from `claude auth status`; its usage record carries it", async () => {
    const t = await setup();
    try {
      const list = await t.client.request("claude_accounts", {});
      expect(list.ok).toBe(true);
      expect((list.result as { primary?: unknown }).primary).toEqual({
        plan: "pro",
        email: "me@example.com",
        org: "Home",
      });
      // Asked of Claude Code's default profile: no CLAUDE_CONFIG_DIR.
      const asked = t.fx.calls.filter((c) => c.argv.join(" ") === "claude auth status");
      expect(asked.map((c) => c.opts.env?.CLAUDE_CONFIG_DIR)).toEqual([undefined]);
      // The primary's usage record: the plan beside its windows.
      const agent = "signin-watcher";
      await t.watcher.publish(
        buildTopic(NS, agent, "usage"),
        JSON.stringify(
          buildEnvelope({
            agentId: agent,
            parentId: null,
            channel: "usage",
            type: "usage",
            payload: {
              account: "primary",
              model: "claude-opus-5-5",
              context_window: { used_percentage: 20, used: 200_000, size: 1_000_000 },
              rate_limits: { five_hour: { pct: 12, resets_at: null } },
              captured_at: new Date().toISOString(),
            },
          }),
        ),
        { qos: 1, retain: true },
      );
      let record: Record<string, unknown> | null = null;
      await eventually(async () => {
        const env = (await t.reader("primary")) as { payload?: Record<string, unknown> } | null;
        record = env?.payload ?? null;
        return record !== null;
      });
      expect(record).toMatchObject({
        account: "primary",
        plan: "pro",
        email: "me@example.com",
        org: "Home",
        five_hour: { pct: 12 },
      });
      expect(schemaErrors("claude-account.schema.json", await t.reader("primary"))).toEqual([]);
    } finally {
      await t.client.close();
      await t.watcher.disconnect();
    }
  });

  it.each([
    ["not logged in", { loggedIn: false, subscriptionType: "max" }, {}],
    ["logged in without a plan", { loggedIn: true }, { email: "me@example.com", org: "Home" }],
  ])("a primary %s: claude_accounts claims no plan", async (_, primary, identity) => {
    const t = await setup({ primary });
    try {
      const list = await t.client.request("claude_accounts", {});
      expect(list.ok).toBe(true);
      // A signed-out primary has no identity either, whatever its .claude.json still says.
      expect((list.result as { primary?: unknown }).primary).toEqual(identity);
    } finally {
      await t.client.close();
      await t.watcher.disconnect();
    }
  });

  it("agent_move_account refuses an agent volleyd does not supervise", async () => {
    const t = await setup();
    try {
      const r = await t.client.request("agent_move_account", { agent: "nobody-1", acct: "work" });
      expect(r).toMatchObject({ ok: false, error: "no supervised agent 'nobody-1'" });
    } finally {
      await t.client.close();
      await t.watcher.disconnect();
    }
  });
});

describe("claude_signin for a paired machine (primary@<name>)", () => {
  const HOSTS =
    "hosts:\n  box-a:\n    target: dev@box-a\n    repo: /srv/repo\n    volley_dir: /opt/volley\n    tunnel: { remote_port: 21883, supervise: false }\n";

  async function remoteSetup(o: SigninBoxOptions = {}) {
    env = await makeDaemonEnv();
    writeFileSync(join(env.home, "config.yaml"), HOSTS);
    const b = fakeSigninBox(o);
    const root = join(tempDir("volleyd-claude-"), "claude");
    const daemon = await env.start({
      claude: { root, exec: b.exec, signinPollMs: 20, signinTimeoutMs: 5000, forwardSettleMs: 20 },
      spawner: { remoteExec: b.exec },
    });
    const waits = journalWait(env.home, () => daemon);
    const client = await ControlClient.connect(env.broker.url, NS);
    const watcher = new VolleyBroker();
    await watcher.connect({ url: env.broker.url, agentId: "signin-watcher" });
    const seen: { topic: string; type: string; payload: Record<string, unknown> }[] = [];
    await watcher.subscribeStream("volley/_system/claude/+/signin", ({ topic, payload }) => {
      const e = parseEnvelope(payload);
      if (e !== null)
        seen.push({ topic, type: e.type, payload: e.payload as Record<string, unknown> });
    });
    const close = async () => {
      await client.close();
      await watcher.disconnect();
    };
    return { b, daemon, waits, client, seen, close };
  }

  it("answers with the forwarded URL, the phone's manual_url and the ssh attach; done carries the box's plan", async () => {
    const t = await remoteSetup({ signInAfter: 4 });
    try {
      const done = t.waits.event("_system", "claude_signin_done");
      const r = await t.client.request("claude_signin", { acct: "primary@box-a", by: "owner-1" });
      expect(r.ok).toBe(true);
      expect(r.result).toMatchObject({
        acct: "primary@box-a",
        topic: "volley/_system/claude/primary@box-a/signin",
        url: SIGNIN_CALLBACK,
        flow: "browser_callback",
        attach: "ssh dev@box-a -t tmux attach -t volley-signin-primary",
        manual_url: expect.stringContaining("platform.claude.com"),
      });
      expect(t.b.forwards.map((f) => f.argv[3])).toEqual(["127.0.0.1:51051:127.0.0.1:51051"]);
      await done;
      await eventually(() => t.seen.some((e) => e.type === "claude_signin_done"));
      expect(t.seen.map((e) => [e.topic, e.type])).toEqual([
        ["volley/_system/claude/primary@box-a/signin", "claude_signin_url"],
        ["volley/_system/claude/primary@box-a/signin", "claude_signin_done"],
      ]);
      expect(t.seen.at(-1)?.payload).toMatchObject({ acct: "primary@box-a", plan: "max" });
      await eventually(() => t.b.forwards.every((f) => f.stopped));
      expect(t.b.box.session).toBe(false);
      const journal = readFileSync(join(env.home, "waves", "_system", "journal.jsonl"), "utf-8");
      expect(journal).toContain('"claude_signin_started"');
      expect(journal).not.toContain("oauth/authorize");
    } finally {
      await t.close();
    }
  });

  it("claude_accounts lists every machine record's Claude login, with its identity", async () => {
    const t = await remoteSetup();
    const box = new VolleyBroker();
    await box.connect({ url: env.broker.url, agentId: "box-a" });
    try {
      await box.publish(
        machineTopic("box-a"),
        JSON.stringify(
          buildEnvelope({
            agentId: "box-a",
            parentId: null,
            channel: MACHINE_CHANNEL,
            type: "machine",
            payload: {
              name: "box-a",
              os: "linux",
              cores: 8,
              tunnel: "up",
              load: [0.1, 0.1, 0.1],
              agents: 0,
              auth: {
                gh: "ok",
                claude: "signed_in",
                trust: "ok",
                claude_plan: "max",
                claude_email: "owner@example.com",
                claude_org: "Example Org",
              },
              last_seen: new Date().toISOString(),
            },
          }),
        ),
        { qos: 1, retain: true },
      );
      let machines: Record<string, unknown>[] = [];
      await eventually(async () => {
        const list = await t.client.request("claude_accounts", {});
        machines = (list.result as { machines: Record<string, unknown>[] }).machines;
        return machines.some((m) => m.name === "box-a");
      });
      expect(machines.find((m) => m.name === "box-a")).toEqual({
        name: "box-a",
        claude: "signed_in",
        plan: "max",
        email: "owner@example.com",
        org: "Example Org",
        tunnel: "up",
      });
    } finally {
      await box.disconnect();
      await t.close();
    }
  });

  it("claude_accounts shows a waiting paired-machine sign-in to a late client", async () => {
    const t = await remoteSetup();
    try {
      await t.client.request("claude_signin", { acct: "primary@box-a" });
      const list = await t.client.request("claude_accounts", {});
      expect((list.result as { remote_signins: unknown[] }).remote_signins).toEqual([
        {
          acct: "primary@box-a",
          state: "pending",
          url: SIGNIN_CALLBACK,
          flow: "browser_callback",
          attach: "ssh dev@box-a -t tmux attach -t volley-signin-primary",
          manual_url: expect.stringContaining("platform.claude.com"),
        },
      ]);
    } finally {
      await t.close();
    }
  });

  it("refuses a machine that is not configured, and one already signed in", async () => {
    const t = await remoteSetup({ signInAfter: 1 });
    try {
      const unknown = await t.client.request("claude_signin", { acct: "primary@box-z" });
      expect(unknown.ok).toBe(false);
      expect(unknown.error).toContain("box-z");
      const signed = await t.client.request("claude_signin", { acct: "primary@box-a" });
      expect(signed.ok).toBe(false);
      expect(signed.error).toMatch(/already signed in/);
      expect(signed.error).toContain("ssh dev@box-a claude auth logout");
      expect(t.b.forwards).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("the daemon stopping ends the sign-in: the session and the forward go", async () => {
    const t = await remoteSetup();
    try {
      await t.client.request("claude_signin", { acct: "primary@box-a" });
      expect(t.b.forwards).toHaveLength(1);
      await t.daemon.stop();
      expect(t.b.forwards[0]?.stopped).toBe(true);
      expect(t.b.box.session).toBe(false);
    } finally {
      await t.close();
    }
  });
});

describe("claude_account_add on a paired machine (<acct>@<name>)", () => {
  const HOSTS =
    "hosts:\n  peer-a:\n    target: dev@peer-a\n    repo: /srv/repo\n    volley_dir: /opt/volley\n    tunnel: { remote_port: 21883, supervise: false }\n";
  const PROFILE = "/home/dev/.volley/claude/work";
  const CLAUDE_JSON = JSON.stringify({
    userID: "c0ffee",
    oauthAccount: {
      accountUuid: "11111111-2222-3333-4444-555555555555",
      emailAddress: "owner@example.com",
      organizationName: "Example Org",
    },
  });

  async function peerSetup(o: SigninBoxOptions = {}) {
    env = await makeDaemonEnv();
    writeFileSync(join(env.home, "config.yaml"), HOSTS);
    const b = fakeSigninBox({ files: { [`${PROFILE}/.claude.json`]: CLAUDE_JSON }, ...o });
    const root = join(tempDir("volleyd-claude-"), "claude");
    const daemon = await env.start({
      claude: { root, exec: b.exec, signinPollMs: 20, signinTimeoutMs: 5000, forwardSettleMs: 20 },
      spawner: { remoteExec: b.exec },
    });
    const waits = journalWait(env.home, () => daemon);
    const client = await ControlClient.connect(env.broker.url, NS);
    const watcher = new VolleyBroker();
    await watcher.connect({ url: env.broker.url, agentId: "signin-watcher" });
    const seen: { topic: string; type: string; payload: Record<string, unknown> }[] = [];
    await watcher.subscribeStream("volley/_system/claude/+/signin", ({ topic, payload }) => {
      const e = parseEnvelope(payload);
      if (e !== null)
        seen.push({ topic, type: e.type, payload: e.payload as Record<string, unknown> });
    });
    const accounts = async () =>
      ((await client.request("claude_accounts", {})).result as {
        accounts: Record<string, unknown>[];
        remote_signins: Record<string, unknown>[];
      }) ?? { accounts: [], remote_signins: [] };
    const close = async () => {
      await client.close();
      await watcher.disconnect();
    };
    return { b, root, daemon, waits, client, seen, accounts, close };
  }

  it("creates the profile there and answers with its forwarded sign-in under work@peer-a", async () => {
    const t = await peerSetup();
    try {
      const r = await t.client.request("claude_account_add", {
        label: "Work",
        machine: "peer-a",
        by: "owner-1",
      });
      expect(r.ok).toBe(true);
      expect(r.result).toMatchObject({
        account: { id: "work", label: "Work", machine: "peer-a" },
        acct: "work@peer-a",
        url: SIGNIN_CALLBACK,
        flow: "browser_callback",
        attach: "ssh dev@peer-a -t tmux attach -t volley-signin-work",
        topic: "volley/_system/claude/work@peer-a/signin",
      });
      // The profile lives on the box, not here.
      expect(t.b.ran("mkdir")).toEqual([["mkdir", "-p", "/home/dev/.volley/signin/work", PROFILE]]);
      expect(t.b.ran("tmux", "new-session")[0]?.[4]).toBe("volley-signin-work");
      const { accounts, remote_signins } = await t.accounts();
      expect(accounts).toEqual([
        expect.objectContaining({
          id: "work",
          machine: "peer-a",
          dir: PROFILE,
          signin: expect.objectContaining({ state: "pending", url: SIGNIN_CALLBACK }),
        }),
      ]);
      expect(remote_signins).toEqual([
        expect.objectContaining({ acct: "work@peer-a", state: "pending" }),
      ]);
      expect(existsSync(join(t.root, "work"))).toBe(false);
    } finally {
      await t.close();
    }
  });

  it("done flips the row to signed_in with plan, email and org; the journal never holds the URL or the e-mail", async () => {
    const t = await peerSetup({ signInAfter: 3 });
    try {
      const done = t.waits.event("_system", "claude_signin_done");
      await t.client.request("claude_account_add", { label: "Work", machine: "peer-a" });
      await done;
      await eventually(() => t.seen.some((e) => e.type === "claude_signin_done"));
      expect(t.seen.map((e) => [e.topic, e.type])).toEqual([
        ["volley/_system/claude/work@peer-a/signin", "claude_signin_url"],
        ["volley/_system/claude/work@peer-a/signin", "claude_signin_done"],
      ]);
      expect(t.seen.at(-1)?.payload).toEqual({
        type: "claude_signin_done",
        acct: "work@peer-a",
        plan: "max",
        email: "owner@example.com",
        org: "Example Org",
      });
      const { accounts } = await t.accounts();
      expect(accounts[0]).toMatchObject({
        id: "work",
        machine: "peer-a",
        plan: "max",
        email: "owner@example.com",
        org: "Example Org",
        signin: { state: "signed_in" },
      });
      // Every poll ran under the profile.
      const polls = t.b.remoteSteps().filter((s) => s.argv[0] === "claude");
      expect(polls.every((s) => s.env?.CLAUDE_CONFIG_DIR === PROFILE)).toBe(true);
      const system = readJournalFile(join(env.home, "waves", "_system", "journal.jsonl"));
      expect(system.find((e) => e.type === "claude_account_added")?.data).toMatchObject({
        acct: "work",
        machine: "peer-a",
      });
      const journal = readFileSync(join(env.home, "waves", "_system", "journal.jsonl"), "utf-8");
      expect(journal).not.toContain("oauth/authorize");
      expect(journal).not.toContain("@example.com");
      expect(journal).not.toContain("Example Org");
    } finally {
      await t.close();
    }
  });

  it("claude_signin of work@peer-a signs the same profile in again; an unknown one is refused", async () => {
    const t = await peerSetup({ signInAfter: 10_000 });
    try {
      await t.client.request("claude_account_add", { label: "Work", machine: "peer-a" });
      const again = await t.client.request("claude_signin", { acct: "work@peer-a" });
      expect(again).toMatchObject({
        ok: true,
        result: {
          acct: "work@peer-a",
          attach: "ssh dev@peer-a -t tmux attach -t volley-signin-work",
        },
      });
      const other = await t.client.request("claude_signin", { acct: "home@peer-a" });
      expect(other).toMatchObject({ ok: false, error: expect.stringMatching(/home/) });
      const wrongBox = await t.client.request("claude_signin", { acct: "work@peer-b" });
      expect(wrongBox.ok).toBe(false);
    } finally {
      await t.close();
    }
  });

  it("claude_signin of a signed-in work@peer-a is refused with the remote logout remedy", async () => {
    const t = await peerSetup({ signInAfter: 3 });
    try {
      const done = t.waits.event("_system", "claude_signin_done");
      await t.client.request("claude_account_add", { label: "Work", machine: "peer-a" });
      await done;
      const before = t.b.box.starts;
      const again = await t.client.request("claude_signin", { acct: "work@peer-a" });
      expect(again.ok).toBe(false);
      expect(again.error).toMatch(/already signed in/);
      expect(again.error).toContain(
        `ssh dev@peer-a CLAUDE_CONFIG_DIR=${PROFILE} claude auth logout`,
      );
      expect(t.b.box.starts).toBe(before);
      const status = t.b.remoteSteps().filter((s) => s.argv[0] === "claude");
      expect(status.at(-1)).toMatchObject({ env: { CLAUDE_CONFIG_DIR: PROFILE } });
    } finally {
      await t.close();
    }
  });

  it("a remote profile's row omits dir until the peer's HOME is known", async () => {
    const t = await peerSetup();
    try {
      // A profile recorded before this daemon learned the peer's HOME (a restart).
      addAccount(t.root, { label: "Work", machine: "peer-a" }, "2026-10-21T00:00:00.000Z");
      const row = (await t.accounts()).accounts.find((a) => a.id === "work");
      expect(row).toMatchObject({ id: "work", machine: "peer-a" });
      expect(row).not.toHaveProperty("dir");
      expect(t.b.steps()).toEqual([]);
    } finally {
      await t.close();
    }
  });

  it("an unknown machine is refused with the host error and no registry entry", async () => {
    const t = await peerSetup();
    try {
      const r = await t.client.request("claude_account_add", { label: "Work", machine: "peer-z" });
      expect(r).toMatchObject({ ok: false, error: expect.stringContaining("peer-z") });
      expect((await t.accounts()).accounts).toEqual([]);
      expect(t.b.steps()).toEqual([]);
    } finally {
      await t.close();
    }
  });
});
