import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { buildTopic } from "volley-mcp/topics";
import { ControlClient, type ControlResponse, waveStateTopic } from "../../src/control";
import { NS } from "../helpers/daemon-env";
import { fakeClock } from "../helpers/fake-clock";
import { schemaErrors } from "../helpers/schema";
import { AGENT, type SupervisedEnv, makeSupervisedEnv } from "../helpers/supervised-env";
import { tempDir } from "../helpers/tmp";
import { stubEnv } from "../helpers/with-env";

/**
 * `wave_account_set` through a real daemon: the move is journaled, the wave's next spawn starts
 * under it, an open account_limit offering it is answered by it, and the wave state says it.
 */

let s: SupervisedEnv;
let control: ControlClient | undefined;
let restoreEnv: (() => void) | undefined;
afterEach(async () => {
  await control?.close();
  control = undefined;
  restoreEnv?.();
  restoreEnv = undefined;
  await s?.cleanup();
});

const T0 = Date.parse("2026-10-18T12:00:00.000Z");

const AT = "2026-10-18T12:00:00.000Z";

/** The registry: `team` (signed in once `signedIn`) and `fresh` (never signed in). */
function registry(root: string, signedIn: boolean) {
  writeFileSync(
    join(root, "accounts.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        {
          id: "team",
          label: "Team account",
          machine: "local",
          created: AT,
          ...(signedIn ? { signed_in_at: AT } : {}),
        },
        { id: "fresh", label: "Fresh", machine: "local", created: AT },
      ],
    }),
  );
}

/**
 * A wave whose T2 waits on T1: it spawns only when the test asks (`spawn`). T1 starts under the
 * primary (`team` signs in, trusting the repo, only once it runs), so its window is the primary's.
 */
async function env(waveExtra?: string, t2 = "T2: { issue: 42, after: [T1] }") {
  const base = tempDir("volleyd-wave-acct-");
  const root = join(base, "claude");
  restoreEnv = stubEnv({ VOLLEY_CLAUDE_DIR: root });
  const primary = join(base, ".claude");
  mkdirSync(join(root, "team"), { recursive: true });
  mkdirSync(primary, { recursive: true });
  registry(root, false);
  s = await makeSupervisedEnv({
    tasks: [t2],
    spawned: 1,
    ...(waveExtra !== undefined ? { waveExtra } : {}),
    daemon: { claude: { root, primaryDir: primary }, clock: fakeClock(T0) },
  });
  writeFileSync(
    join(root, "team", ".claude.json"),
    JSON.stringify({ projects: { [s.repo]: { hasTrustDialogAccepted: true } } }),
  );
  registry(root, true);
  control = await ControlClient.connect(s.env.broker.url, NS);
}

const op = (name: "wave_account_set" | "spawn", fields: Record<string, unknown>) =>
  (control as ControlClient).request(name, fields) as Promise<ControlResponse>;

const moves = () =>
  s
    .journal()
    .filter((e) => e.type === "wave_account_moved")
    .map((e) => e.data);

/** The wave's next agent: T2's implementer, spawned now; the account it started under. */
async function nextSpawnAccount(): Promise<unknown> {
  const r = await op("spawn", { wave: "w1", task: "T2" });
  expect(r.ok, r.error).toBe(true);
  const spawned = await s.event((e) => e.type === "agent_spawned" && e.task === "T2");
  return spawned.data.claude_account;
}

async function publishedAccount(): Promise<unknown> {
  const raw = await s.agent.queryRetained(waveStateTopic("w1"), 500);
  return raw === null ? undefined : (parseEnvelope(raw)?.payload as { account?: unknown }).account;
}

describe("wave_account_set (daemon)", () => {
  it("a balanced wave set to team: journaled, the next spawn runs under team, the state says so", async () => {
    await env();
    expect(await publishedAccount()).toEqual({ pinned: null, source: "balanced" });

    const r = await op("wave_account_set", { wave: "w1", acct: "team", by: "o" });
    expect(r.ok, r.error).toBe(true);
    expect(r.result).toMatchObject({ wave: "w1", account: { pinned: "team", source: "wave" } });
    expect(moves()).toEqual([{ from: null, to: "team", by: "o" }]);
    // The running agent finishes where it is.
    expect(s.journal().some((e) => e.type === "agent_retired")).toBe(false);

    expect(await nextSpawnAccount()).toBe("team");
    const state = await publishedAccount();
    expect(state).toEqual({ pinned: "team", source: "wave" });

    const event = s.journal().find((e) => e.type === "wave_account_moved");
    expect(
      schemaErrors(
        "wave-event.schema.json",
        buildEnvelope({
          agentId: "volleyd",
          parentId: null,
          channel: "_waves/events",
          type: "wave_account_moved",
          payload: { wave: "w1", seq: event?.seq, at: event?.at, data: event?.data },
        }),
      ),
    ).toEqual([]);
  }, 20_000);

  it("acct null on a pinned wave: journaled from team to null, the next spawn balances", async () => {
    await env();
    expect((await op("wave_account_set", { wave: "w1", acct: "team", by: "o" })).ok).toBe(true);
    expect(await publishedAccount()).toEqual({ pinned: "team", source: "wave" });

    const r = await op("wave_account_set", { wave: "w1", acct: null, by: "o" });
    expect(r.ok, r.error).toBe(true);
    expect(moves()).toEqual([
      { from: null, to: "team", by: "o" },
      { from: "team", to: null, by: "o" },
    ]);
    const chosen = async () => {
      const acct = await nextSpawnAccount();
      return {
        acct,
        source: s.journal().find((e) => e.type === "account_chosen" && e.task === "T2")?.data
          .source,
      };
    };
    expect((await chosen()).source).toBe("balance");
    expect(await publishedAccount()).toEqual({
      pinned: null,
      source: "balanced",
      moved_from: "team",
    });
  }, 20_000);

  it("an unknown or not signed-in account is refused and nothing is journaled", async () => {
    await env();
    const unknown = await op("wave_account_set", { wave: "w1", acct: "nope", by: "o" });
    expect(unknown).toMatchObject({ ok: false });
    expect(unknown.error).toMatch(/unknown Claude account 'nope'/);
    const fresh = await op("wave_account_set", { wave: "w1", acct: "fresh", by: "o" });
    expect(fresh).toMatchObject({ ok: false });
    expect(fresh.error).toMatch(/not signed in/);
    expect(await op("wave_account_set", { wave: "nowave", acct: "team" })).toMatchObject({
      ok: false,
      error: "unknown wave 'nowave'",
    });
    expect(moves()).toEqual([]);
  }, 20_000);

  it("a task naming its own account keeps it under the wave's pin", async () => {
    await env(undefined, "T2: { issue: 42, after: [T1], account: primary }");
    expect((await op("wave_account_set", { wave: "w1", acct: "team", by: "o" })).ok).toBe(true);
    expect(await nextSpawnAccount()).toBe("primary");
  }, 20_000);

  it("picking the wave's current account is a no-op; a non-string acct is refused", async () => {
    await env();
    expect((await op("wave_account_set", { wave: "w1", acct: "team", by: "o" })).ok).toBe(true);
    const again = await op("wave_account_set", { wave: "w1", acct: "team", by: "o" });
    expect(again).toMatchObject({ ok: true, result: { unchanged: true } });
    const bad = await op("wave_account_set", { wave: "w1", acct: 7, by: "o" });
    expect(bad).toMatchObject({ ok: false });
    expect(bad.error).toMatch(/requires payload\.acct/);
    expect(moves()).toEqual([{ from: null, to: "team", by: "o" }]);
  }, 20_000);

  it("a pick an open account_limit offers answers it: the decision id is in the event", async () => {
    await env("account: primary");
    // The wave's agent crosses the 5-hour threshold on the primary: `move wave w1 to team`.
    await s.agent.publish(
      buildTopic(NS, AGENT, "usage"),
      JSON.stringify(
        buildEnvelope({
          agentId: AGENT,
          parentId: null,
          channel: "usage",
          type: "usage",
          payload: {
            account: "primary",
            model: "claude-opus-5-5",
            context_window: { used_percentage: 20, used: 200_000, size: 1_000_000 },
            rate_limits: {
              five_hour: { pct: 93, resets_at: new Date(T0 + 3_600_000).toISOString() },
              weekly: { pct: 30, resets_at: new Date(T0 + 3_600_000).toISOString() },
            },
            captured_at: new Date(T0 + 1000).toISOString(),
          },
        }),
      ),
      { qos: 1, retain: true },
    );
    const opened = await s.event(
      (e) => e.type === "decision_opened" && e.data.kind === "account_limit",
    );
    expect(opened.data.options).toEqual(["move wave w1 to team", "not now"]);
    const id = opened.data.decision_id as string;

    const r = await op("wave_account_set", { wave: "w1", acct: "team", by: "o" });
    expect(r.ok, r.error).toBe(true);
    expect(r.result).toMatchObject({ decision_id: id, account: { pinned: "team" } });
    expect(moves()).toEqual([{ from: "primary", to: "team", by: "o", decision_id: id }]);
    const resolved = s.journal().find((e) => e.type === "decision_resolved");
    expect(resolved?.data).toMatchObject({ decision_id: id, answer: "move wave w1 to team" });
    expect(await publishedAccount()).toEqual({
      pinned: "team",
      source: "wave",
      moved_from: "primary",
    });
    expect(await nextSpawnAccount()).toBe("team");
  }, 20_000);
});
