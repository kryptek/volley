import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { signinPrompt } from "../../src/commands/claude";
import { EXIT } from "../../src/exit-codes";
import { type TestBroker, startTestBroker } from "../helpers/aedes-broker";
import { runCli } from "../helpers/run-cli";

const URL_CB =
  "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcallback&state=x";
const URL_CODE =
  "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=x";
const URL_CODE_2 = URL_CODE.replace("state=x", "state=y");

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
    const a = answer(p.op as string, p);
    // `null`: a volleyd that never answers the op.
    if (a === null) return;
    void b.publish(
      `volley/test/${q.agent_id}/mailbox`,
      env("mailbox", "ack", { text: "ACKED", op: p.op, ...(a as object) }, q.correlation_id),
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
  it("add sends claude_account_add and prints the code-page link first, the callback link second", async () => {
    const v = await fakeVolleyd(tb.url, () => ({
      ok: true,
      result: {
        account: { id: "work", label: "Work" },
        acct: "work",
        url: URL_CODE,
        flow: "manual_code",
        manual_url: URL_CODE,
        callback_url: URL_CB,
        attach: "tmux attach -t volley-signin-work",
      },
    }));
    const r = await run(["add", "Work", "--machine", "local"]);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(v.seen[0]).toMatchObject({ op: "claude_account_add", label: "Work", machine: "local" });
    expect(r.stdout).toContain("Claude account work added.");
    const any = r.stdout.indexOf(`Open on any device: ${URL_CODE}`);
    const here = r.stdout.indexOf(`Or on this machine: ${URL_CB}`);
    expect(any).toBeGreaterThan(-1);
    expect(here).toBeGreaterThan(any);
    expect(r.stdout).toContain("volley claude code work <code>");
    await v.b.disconnect();
  });

  it("a sign-in with only the callback URL names the supervisor's machine", async () => {
    const v = await fakeVolleyd(tb.url, () => ({
      ok: true,
      result: { acct: "work@peer-a", url: URL_CB, flow: "browser_callback" },
    }));
    const r = await run(["signin", "work@peer-a"]);
    expect(v.seen[0]).toMatchObject({ op: "claude_signin", acct: "work@peer-a" });
    expect(r.stdout).toContain(`Open on the supervisor's machine: ${URL_CB}`);
    expect(r.stdout).not.toContain("Open on any device");
    await v.b.disconnect();
  });

  /** A volleyd whose sign-in finishes when the entry arrives (or refuses it, with `refuse`). */
  async function entryVolleyd(refuse?: { error: string; fresh?: true }) {
    const v: Awaited<ReturnType<typeof fakeVolleyd>> = await fakeVolleyd(tb.url, (op, p) => {
      if (op === "claude_signin_entry") {
        if (refuse === undefined)
          return {
            ok: true,
            result: { acct: p.acct, signed_in: true, email: "owner@example.com" },
          };
        if (refuse.fresh === true)
          setTimeout(() => {
            void v.b.publish(
              `volley/_system/claude/${p.acct as string}/signin`,
              v.env("_system/claude", "claude_signin_url", {
                type: "claude_signin_url",
                acct: p.acct,
                url: URL_CODE_2,
                flow: "manual_code",
                manual_url: URL_CODE_2,
              }),
              { qos: 1, retain: false },
            );
          }, 0);
        return { ok: false, ...refuse };
      }
      return {
        ok: true,
        result: {
          acct: (p.acct as string | undefined) ?? "work",
          url: URL_CODE,
          flow: "manual_code",
          manual_url: URL_CODE,
          callback_url: URL_CB,
        },
      };
    });
    return v;
  }
  const SECRETS = ["abcSECRET42", "xyzSTATE42"];
  const neverPrinted = (r: { stdout: string; stderr: string }) => {
    for (const secret of SECRETS) {
      expect(r.stdout).not.toContain(secret);
      expect(r.stderr).not.toContain(secret);
    }
  };

  it("signin --code finishes the waiting sign-in: claude_signin_entry only, masked e-mail on done", async () => {
    // A fresh claude_signin would supersede the sign-in the code belongs to (new PKCE + state).
    const v = await entryVolleyd();
    const r = await run(["signin", "team", "--code", "abcSECRET42"]);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(v.seen.map((q) => q.op)).toEqual(["claude_signin_entry"]);
    expect(v.seen[0]).toMatchObject({ acct: "team", entry: "abcSECRET42" });
    expect(r.stdout).toContain("signed in as o•••@example.com");
    expect(r.stdout).not.toContain("owner@example.com");
    neverPrinted(r);
    await v.b.disconnect();
  });

  it("--code with a redirect address sends the address exactly as given", async () => {
    const v = await entryVolleyd();
    const address = "http://localhost:51051/callback?code=abcSECRET42&state=xyzSTATE42";
    const r = await run(["signin", "team", "--code", address]);
    expect(r.exitCode).toBe(0);
    expect(v.seen).toEqual([
      expect.objectContaining({ op: "claude_signin_entry", acct: "team", entry: address }),
    ]);
    neverPrinted(r);
    await v.b.disconnect();
  });

  it("volley claude code <acct> <entry> is the stand-alone form", async () => {
    const v = await entryVolleyd();
    const r = await run(["code", "team@box-a", "abcSECRET42"]);
    expect(r.exitCode).toBe(0);
    expect(v.seen).toEqual([
      expect.objectContaining({
        op: "claude_signin_entry",
        acct: "team@box-a",
        entry: "abcSECRET42",
      }),
    ]);
    expect(r.stdout).toContain("signed in as o•••@example.com");
    neverPrinted(r);
    await v.b.disconnect();
  });

  it("a rejected code says so and prints the fresh link volleyd started", async () => {
    const v = await entryVolleyd({ error: "code rejected: Invalid code", fresh: true });
    const r = await run(["code", "team", "abcSECRET42"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("code rejected: Invalid code");
    expect(r.stdout).toContain(`Open on any device: ${URL_CODE_2}`);
    neverPrinted(r);
    await v.b.disconnect();
  });

  it("--code is refused on a verb that does not sign in", async () => {
    const r = await run(["list", "--code", "abc"]);
    expect(r.exitCode).toBe(EXIT.USAGE);
    expect(r.stderr).toMatch(/--code is for signin only/);
    expect(r.stderr).not.toContain("abc\n");
  });

  it("add --code is refused: no code exists before add prints its link", async () => {
    const r = await run(["add", "Work", "--code", "abcSECRET42"]);
    expect(r.exitCode).toBe(EXIT.USAGE);
    expect(r.stderr).toMatch(/--code is for signin only/);
    neverPrinted(r);
  });

  it("add --wait on a terminal prints both links, then asks for the code with echo off", async () => {
    const v = await entryVolleyd();
    const asked: string[] = [];
    const saved = { ...signinPrompt };
    signinPrompt.tty = () => true;
    signinPrompt.ask = async (prompt) => {
      asked.push(prompt);
      return "abcSECRET42";
    };
    try {
      const r = await run(["add", "Work", "--wait"]);
      expect(r.exitCode).toBe(0);
      expect(asked).toEqual(["Paste the code, or the address your browser ended up on: "]);
      const any = r.stdout.indexOf(`Open on any device: ${URL_CODE}`);
      expect(any).toBeGreaterThan(-1);
      expect(r.stdout.indexOf(`Or on this machine: ${URL_CB}`)).toBeGreaterThan(any);
      expect(v.seen.at(-1)).toMatchObject({ op: "claude_signin_entry", entry: "abcSECRET42" });
      expect(r.stdout).toContain("signed in as o•••@example.com");
      neverPrinted(r);
    } finally {
      Object.assign(signinPrompt, saved);
      await v.b.disconnect();
    }
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
        signed_in_at: "2026-10-18T12:00:00.000Z",
        signin: { state: "signed_in" },
      },
      {
        id: "pending-work",
        label: "Work (peer-a)",
        machine: "peer-a",
        signin: { state: "pending", url: "https://claude.com/cai/oauth/authorize?state=p" },
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

  it("list groups the accounts by e-mail, masked, with machines, usage, the waiting profiles and the sharing modes", async () => {
    const v = await listVolleyd();
    const r = await run(["list"]);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Work · max · Example Org · o•••@example.com");
    expect(r.stdout).not.toContain("owner@example.com");
    expect(r.stdout).toMatch(
      /5-hour 37% \(resets in 1h 59m\) · 7-day 56% · Fable 12% \(resets in 4d 2h, read 4 min ago\)\n {2}last updated: 2 min ago\n/,
    );
    expect(r.stdout).toMatch(/this machine +work +signed in +waves: w1/);
    expect(r.stdout).toMatch(/peer-a +default login +signed in +waves: w2\n/);
    expect(r.stdout).not.toMatch(/stale|freshest:/);
    // The profile that never finished its sign-in is no group, only a line.
    expect(r.stdout).toContain(
      "waiting for sign-in:\n  pending-work · Work (peer-a) · on peer-a\n    sign in: https://claude.com/cai/oauth/authorize?state=p\n",
    );
    expect(r.stdout.match(/^Work/gm)).toHaveLength(1);
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

  /** volleyd's `claude_balance` answer: two machines, each ranked, the pick per family. */
  const BALANCE = {
    machines: [
      {
        name: "local",
        candidates: [
          {
            account: "work",
            headroom: 60,
            five_hour_pct: 12,
            weekly_pct: 40,
            agents: 2,
            score: 1.7,
            binding: "five_hour",
            eligible: true,
            binding_left: 88,
            binding_resets_at: iso(-52.5 * 60_000),
            in_flight: 3,
            projected_pct: 38,
          },
          {
            account: "primary",
            headroom: 40,
            five_hour_pct: 60,
            weekly_pct: 20,
            agents: 1,
            score: 0.9,
            binding: "weekly",
            eligible: true,
            binding_left: 80,
            binding_resets_at: iso(-(2 * 1440 + 4 * 60 + 0.5) * 60_000),
            in_flight: 0,
            projected_pct: 20,
          },
        ],
        picks: { fable: "work", opus: "work", sonnet: "primary", haiku: "primary" },
      },
      {
        name: "peer-a",
        candidates: [
          {
            account: "primary@peer-a",
            headroom: 2,
            five_hour_pct: 98,
            weekly_pct: 30,
            agents: 3,
            score: 0.1,
            binding: "five_hour",
            eligible: false,
            binding_left: 2,
            binding_resets_at: iso(-60 * 60_000),
            in_flight: 1,
            projected_pct: 100,
          },
          {
            account: "work@peer-a",
            headroom: null,
            five_hour_pct: null,
            weekly_pct: null,
            agents: 2,
          },
        ],
        picks: { fable: "work@peer-a", opus: "work@peer-a", sonnet: null, haiku: null },
      },
    ],
  };
  const BALANCE_RECORDS = [
    {
      account: "work",
      label: "Work",
      email: "owner@example.com",
      five_hour: { pct: 12, resets_at: null },
      weekly: { pct: 40, resets_at: null },
      model_weekly: { fable: { pct: 30, resets_at: null } },
      agents: ["a-1", "a-2"],
      waves: ["w1"],
      sampled_at: iso(60_000),
    },
  ];

  async function balanceVolleyd(
    answer: (op: string, p: Record<string, unknown>) => unknown = (op, p) => {
      if (op !== "claude_balance") return { ok: true, result: LIST_RESULT };
      if (typeof p.model !== "string") return { ok: true, result: BALANCE };
      const machines = BALANCE.machines.map((m) => ({
        ...m,
        picks: { model: m.candidates[0]?.account ?? null },
      }));
      return { ok: true, result: { model: p.model, machines } };
    },
  ) {
    const v = await fakeVolleyd(tb.url, answer);
    for (const rec of BALANCE_RECORDS)
      await v.b.publish(
        `volley/_system/claude-accounts/${rec.account}`,
        v.env("_system/claude-accounts", "claude_account", rec),
        { qos: 1, retain: true },
      );
    return v;
  }

  it("balance prints each machine's ranked candidates, figures, the binding window's expiry and picks, e-mails masked", async () => {
    const v = await balanceVolleyd();
    const r = await run(["balance"]);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(v.seen[0]).toMatchObject({ op: "claude_balance" });
    const lines = r.stdout.split("\n");
    expect(lines[0]).toBe("this machine");
    expect(lines[1]).toMatch(
      /^ {2}work +o•••@example\.com +5h 12% +7d 40% +Fable 30% +5h 88% left in 5[23]m \(62% after 3 in flight\) +2 agents +← fable, opus$/,
    );
    expect(lines[2]).toMatch(
      /^ {2}primary +5h 60% +7d 20% +Fable — +7d 80% left in 2d 4h +1 agent +← sonnet, haiku$/,
    );
    expect(lines[3]).toBe("peer-a");
    expect(lines[4]).toMatch(
      /^ {2}primary@peer-a +5h 98% +7d 30% +Fable — +over cap \(100% after 1 in flight\) +3 agents$/,
    );
    expect(lines[5]).toMatch(/^ {2}work@peer-a +no usage yet +2 agents +← fable, opus$/);
    expect(r.stdout).not.toContain("owner@example.com");
    await v.b.disconnect();
  });

  it("balance --show-email shows the address", async () => {
    const v = await balanceVolleyd();
    const r = await run(["balance", "--show-email"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/ {2}work +owner@example\.com +5h 12%/);
    await v.b.disconnect();
  });

  it("balance --model and --machine pass through; one arrow per machine", async () => {
    const v = await balanceVolleyd();
    const r = await run(["balance", "--model", "claude-fable-1"]);
    expect(r.exitCode).toBe(0);
    expect(v.seen[0]).toMatchObject({ op: "claude_balance", model: "claude-fable-1" });
    expect(r.stdout.match(/← claude-fable-1/g)).toHaveLength(2);
    await run(["balance", "--machine", "peer-a"]);
    expect(v.seen.at(-1)).toMatchObject({ op: "claude_balance", machine: "peer-a" });
    await v.b.disconnect();
  });

  it("balance --json prints volleyd's raw answer", async () => {
    const v = await balanceVolleyd();
    const r = await run(["balance", "--json"]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(BALANCE);
    await v.b.disconnect();
  });

  it("balance takes no arguments; --model is for balance only", async () => {
    const extra = await run(["balance", "extra"]);
    expect(extra.exitCode).toBe(EXIT.USAGE);
    expect(extra.stderr).toContain("takes no arguments");
    const model = await run(["list", "--model", "claude-fable-1"]);
    expect(model.exitCode).toBe(EXIT.USAGE);
    expect(model.stderr).toContain("--model");
  });

  it("list marks the member rows volleyd's next spawn would pick", async () => {
    const v = await balanceVolleyd();
    const r = await run(["list"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/this machine +work +signed in +waves: w1 +next pick/);
    expect(r.stdout).toMatch(/peer-a +default login +signed in(?! +next pick)/);
    await v.b.disconnect();
  });

  it("list does not wait the full --timeout on a volleyd that never answers claude_balance", async () => {
    const v = await balanceVolleyd((op) =>
      op === "claude_balance" ? null : { ok: true, result: LIST_RESULT },
    );
    const t0 = Date.now();
    const r = await run(["list", "--timeout", "30"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/this machine +work +signed in/);
    expect(r.stdout).not.toContain("next pick");
    expect(Date.now() - t0).toBeLessThan(10_000);
    await v.b.disconnect();
  }, 20_000);

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

  it("rename sends claude_account_rename { acct, label } and prints the profiles renamed", async () => {
    const v = await fakeVolleyd(tb.url, (_op, p) =>
      p.acct === "team"
        ? {
            ok: true,
            result: { acct: "team", label: "Team account", renamed: ["team", "team@box-a"] },
          }
        : { ok: false, error: "unknown Claude account 'zz'" },
    );
    const ok = await run(["rename", "team", "Team account"]);
    expect(ok.stderr).toBe("");
    expect(v.seen[0]).toMatchObject({
      op: "claude_account_rename",
      acct: "team",
      label: "Team account",
    });
    expect(ok.stdout).toBe("renamed team → Team account (2 profiles)\n");
    const bad = await run(["rename", "zz", "x"]);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("unknown Claude account 'zz'");
    await v.b.disconnect();
  });

  it("remove sends claude_account_remove { acct } and says what happened to the directory", async () => {
    const v = await fakeVolleyd(tb.url, (_op, p) =>
      p.acct === "team"
        ? { ok: true, result: { acct: "team@box-a", machine: "box-a", dir_removed: true } }
        : p.acct === "odd"
          ? {
              ok: true,
              result: {
                acct: "odd@box-a",
                machine: "box-a",
                dir_removed: false,
                dir_left: "/srv/odd is not under /path/to/home/.volley/claude/",
              },
            }
          : { ok: false, error: "claude.default_account names 'work'; change Defaults first" },
    );
    const ok = await run(["remove", "team"]);
    expect(ok.stderr).toBe("");
    expect(v.seen[0]).toMatchObject({ op: "claude_account_remove", acct: "team" });
    expect(ok.stdout).toBe("removed team (box-a); profile directory removed\n");
    const left = await run(["remove", "odd"]);
    expect(left.stdout).toBe(
      "removed odd (box-a); profile directory left in place: /srv/odd is not under /path/to/home/.volley/claude/\n",
    );
    const bad = await run(["remove", "work"]);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("change Defaults first");
    await v.b.disconnect();
  });

  it("rename and remove usage; the HELP lines", async () => {
    expect((await run(["rename", "team"])).exitCode).toBe(EXIT.USAGE);
    expect((await run(["rename"])).exitCode).toBe(EXIT.USAGE);
    expect((await run(["remove"])).exitCode).toBe(EXIT.USAGE);
    expect((await run(["remove", "a", "b"])).exitCode).toBe(EXIT.USAGE);
    const help = (await run(["--help"])).stdout;
    expect(help).toMatch(/volley claude rename <acct> <label>\s+\S/);
    expect(help).toMatch(/volley claude remove <acct>\s+\S/);
  });

  it("usage errors and a missing volleyd", async () => {
    expect((await run(["add"])).exitCode).toBe(2);
    expect((await run(["frob"])).exitCode).toBe(2);
    const r = await run(["list"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("volleyd is not running");
  });
});
