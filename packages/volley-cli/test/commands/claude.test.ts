import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
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

  it("list prints each profile's sign-in state and the sharing modes", async () => {
    const v = await fakeVolleyd(tb.url, () => ({
      ok: true,
      result: {
        root: "/srv/claude",
        accounts: [
          {
            id: "work",
            label: "Work",
            machine: "local",
            plan: "max",
            dir: "/srv/claude/work",
            signin: { state: "signed_in" },
          },
        ],
        sharing: { "settings.json": "copy", mcp: "copy" },
      },
    }));
    const r = await run(["list"]);
    expect(r.stdout).toContain("work\tsigned_in max\tlocal\tWork\t/srv/claude/work");
    expect(r.stdout).toContain("sharing: settings.json=copy mcp=copy");
    await v.b.disconnect();
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
