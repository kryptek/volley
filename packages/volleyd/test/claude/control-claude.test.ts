import { lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { parseEnvelope } from "volley-mcp/envelope";
import { signinDir } from "../../src/claude/signin";
import { ControlClient } from "../../src/control";
import { readJournalFile } from "../../src/journal";
import { eventually } from "../helpers/broker-wait";
import { type DaemonEnv, NS, makeDaemonEnv } from "../helpers/daemon-env";
import { fakeClock } from "../helpers/fake-clock";
import { fakeExec } from "../helpers/fake-exec";
import { journalWait } from "../helpers/journal-wait";

/** The claude_* control ops end to end: a real daemon on Aedes, a fake tmux / claude. */

const CALLBACK = readFileSync(
  new URL("../fixtures/claude/browser-url.txt", import.meta.url),
  "utf-8",
).trim();

let env: DaemonEnv;
afterEach(() => env.cleanup());

async function setup(opts: { signInAfter?: number } = {}) {
  env = await makeDaemonEnv();
  const base = mkdtempSync(join(tmpdir(), "volleyd-claude-"));
  const root = join(base, "claude");
  const primary = join(base, ".claude");
  const primaryJson = join(base, ".claude.json");
  mkdirSync(join(primary, "agents"), { recursive: true });
  writeFileSync(join(primary, "CLAUDE.md"), "# rules\n");
  writeFileSync(primaryJson, JSON.stringify({ mcpServers: { volley: { env: { K: "secret" } } } }));
  let polls = 0;
  const fx = fakeExec()
    .on(["tmux", "new-session"], (argv) => {
      writeFileSync(join(argv[6] as string, "url"), CALLBACK);
      return {};
    })
    .on(["claude", "auth", "status"], () =>
      ++polls >= (opts.signInAfter ?? 3)
        ? { stdout: JSON.stringify({ loggedIn: true, subscriptionType: "max" }) }
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
  return { root, primary, fx, client, watcher, seen, system, signedIn };
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
      // non-retained: nothing left on the topic
      expect(await env.retained("volley/_system/claude/work/signin")).toBeNull();

      const list = await t.client.request("claude_accounts", {});
      const accounts = (list.result as { accounts: Record<string, unknown>[] }).accounts;
      expect(accounts[0]).toMatchObject({
        id: "work",
        plan: "max",
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

  it("claude_account_add refuses another machine and a duplicate", async () => {
    const t = await setup();
    try {
      const far = await t.client.request("claude_account_add", { label: "x", machine: "studio" });
      expect(far).toMatchObject({ ok: false, error: expect.stringMatching(/studio/) });
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
      expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/already signed in/) });
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
