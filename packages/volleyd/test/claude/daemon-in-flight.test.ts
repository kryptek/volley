import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildEnvelope } from "volley-mcp/envelope";
import { buildTopic } from "volley-mcp/topics";
import { ControlClient, type ControlOp, type ControlResponse } from "../../src/control";
import { NS } from "../helpers/daemon-env";
import { fakeClock } from "../helpers/fake-clock";
import { type SupervisedEnv, makeSupervisedEnv } from "../helpers/supervised-env";
import { tempDir } from "../helpers/tmp";
import { stubEnv } from "../helpers/with-env";

/**
 * The balance's reservations through a real daemon (#557): a pick counts against its account
 * before its agent reports usage, so the next pick sees it; the agent's first sample, or a
 * failed spawn, releases it.
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

/** T1 runs under the primary (supervised); T2..T4 wait on it and spawn when the test asks. */
async function env() {
  const base = tempDir("volleyd-in-flight-");
  const root = join(base, "claude");
  restoreEnv = stubEnv({ VOLLEY_CLAUDE_DIR: root });
  const primary = join(base, ".claude");
  mkdirSync(join(root, "team"), { recursive: true });
  mkdirSync(primary, { recursive: true });
  const registry = (signedIn: boolean) =>
    writeFileSync(
      join(root, "accounts.json"),
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: "team",
            label: "Team",
            machine: "local",
            created: AT,
            ...(signedIn ? { signed_in_at: AT } : {}),
          },
        ],
      }),
    );
  registry(false);
  s = await makeSupervisedEnv({
    tasks: [
      "T2: { issue: 42, after: [T1] }",
      "T3: { issue: 42, after: [T1] }",
      "T4: { issue: 42, after: [T1] }",
    ],
    spawned: 1,
    daemon: { claude: { root, primaryDir: primary }, clock: fakeClock(T0) },
  });
  writeFileSync(
    join(root, "team", ".claude.json"),
    JSON.stringify({ projects: { [s.repo]: { hasTrustDialogAccepted: true } } }),
  );
  registry(true);
  control = await ControlClient.connect(s.env.broker.url, NS);
}

const op = (name: ControlOp, fields: Record<string, unknown>) =>
  (control as ControlClient).request(name, fields) as Promise<ControlResponse>;

type Row = { account: string; in_flight?: number };

async function spawn(task: string): Promise<Row[]> {
  const r = await op("spawn", { wave: "w1", task });
  expect(r.ok, r.error).toBe(true);
  const chosen = await s.event((e) => e.type === "account_chosen" && e.task === task);
  await s.event((e) => e.type === "agent_spawned" && e.task === task);
  return chosen.data.candidates as Row[];
}

/** Each local candidate's agents in flight, as `claude_balance` ranks them now. */
async function inFlight(): Promise<Record<string, number | undefined>> {
  const r = await op("claude_balance", { machine: "local" });
  expect(r.ok, r.error).toBe(true);
  const [m] = (r.result as { machines: { candidates: Row[] }[] }).machines;
  return Object.fromEntries((m?.candidates ?? []).map((c) => [c.account, c.in_flight]));
}

const usage = (agent: string, payload: unknown | null) =>
  s.agent.publish(
    buildTopic(NS, agent, "usage"),
    payload === null
      ? ""
      : JSON.stringify(
          buildEnvelope({
            agentId: agent,
            parentId: null,
            channel: "usage",
            type: "usage",
            payload,
          }),
        ),
    { qos: 1, retain: true },
  );

describe("the balance's reservations (daemon)", () => {
  it("a pick counts against its account until its agent's first sample; a failed spawn reserves nothing", async () => {
    await env();
    expect(await inFlight()).toEqual({ primary: 1, team: 0 });

    // two picks with no sample between them: the second sees the first
    const first = await spawn("T2");
    expect(first.find((c) => c.account === "team")?.in_flight).toBe(0);
    expect(
      s.journal().find((e) => e.type === "account_chosen" && e.task === "T2")?.data.account,
    ).toBe("team");
    const second = await spawn("T3");
    expect(second.find((c) => c.account === "team")?.in_flight).toBe(1);
    expect(await inFlight()).toEqual({ primary: 1, team: 2 });

    // T2's agent reports usage on team: counted once (by its sample now), not twice
    await usage("w1-t2-implementer-1", {
      account: "team",
      model: "claude-opus-5-5",
      context_window: { used_percentage: 5, used: 50_000, size: 1_000_000 },
      rate_limits: { five_hour: { pct: 20, resets_at: "2026-10-18T15:00:00.000Z" } },
      captured_at: "2026-10-18T12:00:30.000Z",
    });
    await s.consumed();
    expect(await inFlight()).toEqual({ primary: 1, team: 2 });
    // its usage topic cleared: the reservation was spent by the sample, so only T3's is left
    await usage("w1-t2-implementer-1", null);
    await s.consumed();
    expect(await inFlight()).toEqual({ primary: 1, team: 1 });

    // a refused launch leaves no reservation
    s.host.launchOutcome = "refused";
    const r = await op("spawn", { wave: "w1", task: "T4" });
    expect(r.ok).toBe(false);
    await s.event((e) => e.type === "spawn_failed" && e.task === "T4");
    await s.settled();
    expect(await inFlight()).toEqual({ primary: 1, team: 1 });
  }, 30_000);
});
