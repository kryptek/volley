import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { EXIT } from "../../src/exit-codes";
import { type TestBroker, startTestBroker } from "../helpers/aedes-broker";
import { runCli } from "../helpers/run-cli";

const URL_CB =
  "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcallback&state=x";

/**
 * A minimal volleyd: a live retained status, and a mailbox that answers each control query with
 * a scripted reply (an `ack` with the query's correlation_id, from agent `volleyd`).
 */
async function fakeVolleyd(
  url: string,
  answer: (op: string, p: Record<string, unknown>) => unknown,
) {
  const b = new VolleyBroker();
  await b.connect({ url, agentId: "volleyd" });
  const env = (channel: string, type: string, payload: unknown, correlationId?: string) =>
    JSON.stringify(
      buildEnvelope({
        agentId: "volleyd",
        parentId: null,
        channel,
        type,
        payload,
        ...(correlationId !== undefined ? { correlationId } : {}),
      }),
    );
  await b.publish("volley/test/volleyd/status", env("status", "working", {}), {
    qos: 1,
    retain: true,
  });
  const seen: Record<string, unknown>[] = [];
  await b.subscribeStream("volley/test/volleyd/mailbox", ({ payload }) => {
    const q = parseEnvelope(payload);
    if (q?.type !== "query" || q.correlation_id === null) return;
    const p = q.payload as Record<string, unknown>;
    seen.push(p);
    void b.publish(
      `volley/test/${q.agent_id}/mailbox`,
      env(
        "mailbox",
        "ack",
        { text: "ACKED", op: p.op, ...(answer(p.op as string, p) as object) },
        q.correlation_id,
      ),
      { qos: 1, retain: false },
    );
  });
  return { b, seen, env };
}

let tb: TestBroker;
beforeEach(async () => {
  tb = await startTestBroker();
});
afterEach(async () => {
  await tb.close();
});

const run = (argv: string[]) =>
  runCli({
    argv: ["claude", ...argv],
    env: { VOLLEY_BROKER_URL: tb.url, VOLLEY_NAMESPACE: "test" },
  });

describe("volley claude", () => {
  it("add sends claude_account_add and prints the sign-in URL", async () => {
    const v = await fakeVolleyd(tb.url, () => ({
      ok: true,
      result: {
        account: { id: "work", label: "Work" },
        acct: "work",
        url: URL_CB,
        flow: "browser_callback",
        attach: "tmux attach -t volley-signin-work",
      },
    }));
    const r = await run(["add", "Work", "--machine", "local"]);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(v.seen[0]).toMatchObject({ op: "claude_account_add", label: "Work", machine: "local" });
    expect(r.stdout).toContain("Claude account work added.");
    expect(r.stdout).toContain(URL_CB);
    expect(r.stdout).toMatch(/browser on the supervisor's machine/);
    await v.b.disconnect();
  });

  it("add --machine <peer> sends the machine; the forwarded URL is opened on this computer", async () => {
    const v = await fakeVolleyd(tb.url, () => ({
      ok: true,
      result: {
        account: { id: "work", label: "Work", machine: "peer-a" },
        acct: "work@peer-a",
        url: URL_CB,
        flow: "browser_callback",
        attach: "ssh dev@peer-a -t tmux attach -t volley-signin-work",
      },
    }));
    const r = await run(["add", "Work", "--machine", "peer-a"]);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(v.seen[0]).toMatchObject({ op: "claude_account_add", label: "Work", machine: "peer-a" });
    expect(r.stdout).toContain("Claude account work added.");
    expect(r.stdout).toContain("Sign in to Claude for work@peer-a");
    expect(r.stdout).toMatch(/open this URL in a browser on this computer/);
    expect(r.stdout).toContain(URL_CB);
    await v.b.disconnect();
  });

  it("a paired machine's manual-code URL names the ssh attach to its sign-in terminal", async () => {
    const v = await fakeVolleyd(tb.url, () => ({
      ok: true,
      result: {
        acct: "work@peer-a",
        url: URL_CB,
        flow: "manual_code",
        attach: "ssh dev@peer-a -t tmux attach -t volley-signin-work",
      },
    }));
    const r = await run(["signin", "work@peer-a"]);
    expect(r.stdout).toContain(
      "paste the code it shows into the sign-in terminal on peer-a (ssh dev@peer-a -t tmux attach -t volley-signin-work)",
    );
    await v.b.disconnect();
  });

  it("a manual-code URL names the terminal to paste the code into", async () => {
    const v = await fakeVolleyd(tb.url, () => ({
      ok: true,
      result: {
        acct: "work",
        url: URL_CB,
        flow: "manual_code",
        attach: "tmux attach -t volley-signin-work",
      },
    }));
    const r = await run(["signin", "work"]);
    expect(v.seen[0]).toMatchObject({ op: "claude_signin", acct: "work" });
    expect(r.stdout).toContain(
      "paste the code it shows into the sign-in terminal (tmux attach -t volley-signin-work)",
    );
    await v.b.disconnect();
  });

  it("add --wait waits for claude_signin_done on the sign-in topic", async () => {
    // The end arrives right after the answer: --wait must already be listening.
    const v: Awaited<ReturnType<typeof fakeVolleyd>> = await fakeVolleyd(tb.url, () => {
      setTimeout(() => {
        void v.b.publish(
          "volley/_system/claude/work/signin",
          v.env("_system/claude", "claude_signin_done", {
            type: "claude_signin_done",
            acct: "work",
            plan: "max",
          }),
          { qos: 1, retain: false },
        );
      }, 0);
      return { ok: true, result: { acct: "work", url: URL_CB, flow: "browser_callback" } };
    });
    const r = await run(["add", "work", "--wait"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("work is signed in (max).");
    await v.b.disconnect();
  });

  it("add --wait is bounded by --timeout when the sign-in never ends", async () => {
    const v = await fakeVolleyd(tb.url, () => ({
      ok: true,
      result: { acct: "work", url: URL_CB, flow: "browser_callback" },
    }));
    const r = await run(["add", "work", "--wait", "--timeout", "1"]);
    expect(r.exitCode).toBe(124);
    expect(r.stderr).toMatch(/sign-in of work did not finish within 1 s/);
    await v.b.disconnect();
  });

  /** T0's answer: a profile on this machine, a paired machine signed in with the same e-mail. */
  const LIST_RESULT = {
    root: "/srv/claude",
    accounts: [
      {
        id: "work",
        label: "Work",
        machine: "local",
        plan: "max",
        email: "owner@example.com",
        org: "Example Org",
        dir: "/srv/claude/work",
        signin: { state: "signed_in" },
      },
    ],
    primary: {},
    machines: [{ name: "peer-a", kind: "peer", claude: "signed_in", email: "owner@example.com" }],
    sharing: { "settings.json": "copy", mcp: "copy" },
  };

  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const RECORDS = [
    {
      account: "work",
      label: "Work",
      email: "owner@example.com",
      five_hour: { pct: 37, resets_at: new Date(now + 2 * 3_600_000).toISOString() },
      weekly: { pct: 56, resets_at: null },
      model_weekly: {
        fable: {
          pct: 12,
          resets_at: new Date(now + (4 * 24 + 2) * 3_600_000 + 60_000).toISOString(),
        },
      },
      probe: {
        machine: "hub",
        state: "ok",
        attempted_at: iso(4 * 60_000),
        read_at: iso(4 * 60_000),
      },
      agents: ["w1-t1-implementer-1"],
      waves: ["w1"],
      sampled_at: iso(2 * 60_000),
    },
    {
      account: "primary@peer-a",
      five_hour: { pct: 41, resets_at: null },
      weekly: { pct: 56, resets_at: null },
      agents: [],
      waves: ["w2"],
      sampled_at: iso(3 * 3_600_000),
    },
  ];

  /** A fake volleyd answering T0's shape, with the account records already retained. */
  async function listVolleyd() {
    const v = await fakeVolleyd(tb.url, () => ({ ok: true, result: LIST_RESULT }));
    for (const rec of RECORDS)
      await v.b.publish(
        `volley/_system/claude-accounts/${rec.account}`,
        v.env("_system/claude-accounts", "claude_account", rec),
        { qos: 1, retain: true },
      );
    return v;
  }

  it("list groups the accounts by e-mail, masked, with machines, usage and the sharing modes", async () => {
    const v = await listVolleyd();
    const r = await run(["list"]);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Work · max · Example Org · o•••@example.com");
    expect(r.stdout).not.toContain("owner@example.com");
    expect(r.stdout).toMatch(
      /5-hour 37% \(resets in 1h 59m\) · 7-day 56% · Fable 12% \(resets in 4d 2h, read 4 min ago\)\n {2}freshest: this machine, 2 min ago\n/,
    );
    expect(r.stdout).toMatch(/this machine +work +signed in +waves: w1/);
    expect(r.stdout).toMatch(
      /peer-a +default login +signed in +waves: w2 +5-hour 41% 3 h old \(stale\)/,
    );
    expect(r.stdout).toContain("sharing: settings.json=copy mcp=copy");
    await v.b.disconnect();
  });

  it("list prints `not on:` under a group that misses a configured machine", async () => {
    const v = await fakeVolleyd(tb.url, () => ({
      ok: true,
      result: {
        ...LIST_RESULT,
        machines: [...LIST_RESULT.machines, { name: "peer-b", kind: "peer", claude: "signed_out" }],
      },
    }));
    const r = await run(["list"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/peer-a +default login[^\n]*\n {2}not on: peer-b\n/);
    await v.b.disconnect();
  });

  it("list prints no `not on:` line when every machine holds the account", async () => {
    const v = await listVolleyd();
    const r = await run(["list"]);
    expect(r.stdout).not.toContain("not on:");
    await v.b.disconnect();
  });

  it("list --show-email shows the address", async () => {
    const v = await listVolleyd();
    const r = await run(["list", "--show-email"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Work · max · Example Org · owner@example.com");
    await v.b.disconnect();
  });

  it("list --json prints the raw answer with the records", async () => {
    const v = await listVolleyd();
    const r = await run(["list", "--json"]);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { records: { account: string }[] };
    expect({ ...out, records: undefined }).toEqual({ ...LIST_RESULT, records: undefined });
    expect(out.records.map((x) => x.account).sort()).toEqual(["primary@peer-a", "work"]);
    await v.b.disconnect();
  });

  it("an empty registry still prints the sharing line", async () => {
    const v = await fakeVolleyd(tb.url, () => ({
      ok: true,
      result: { root: "/srv/claude", accounts: [], sharing: { mcp: "copy" } },
    }));
    const r = await run(["list"]);
    expect(r.stdout).toContain("no Claude account profiles under /srv/claude");
    expect(r.stdout).toContain("sharing: mcp=copy");
    await v.b.disconnect();
  });

  it("--show-email with any other verb is a usage error", async () => {
    const r = await run(["sync", "--show-email"]);
    expect(r.exitCode).toBe(EXIT.USAGE);
    expect(r.stderr).toContain("--show-email");
  });

  it("move sends agent_move_account; a refusal is exit 1 with volleyd's reason", async () => {
    const v = await fakeVolleyd(tb.url, (_op, p) =>
      p.agent === "a-1"
        ? { ok: true, result: { agent_id: "a-2", from: "primary", to: "work" } }
        : { ok: false, error: "no supervised agent 'zz'" },
    );
    const ok = await run(["move", "a-1", "work"]);
    expect(v.seen[0]).toMatchObject({ op: "agent_move_account", agent: "a-1", acct: "work" });
    expect(ok.stdout).toBe("moved: a-1 → a-2 under Claude account work\n");
    const bad = await run(["move", "zz", "work"]);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("no supervised agent 'zz'");
    await v.b.disconnect();
  });

  it("usage errors and a missing volleyd", async () => {
    expect((await run(["add"])).exitCode).toBe(2);
    expect((await run(["frob"])).exitCode).toBe(2);
    const r = await run(["list"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("volleyd is not running");
  });
});
