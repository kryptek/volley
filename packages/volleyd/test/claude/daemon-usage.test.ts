import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { buildTopic } from "volley-mcp/topics";
import { usageAccountTopic } from "../../src/claude/usage";
import { NS } from "../helpers/daemon-env";
import { AGENT, type SupervisedEnv, makeSupervisedEnv } from "../helpers/supervised-env";

/** Usage metering through a real daemon: fold, publish, threshold decision, wave move. */

let s: SupervisedEnv;
afterEach(async () => {
  await s?.cleanup();
});

const RESETS = new Date(Date.now() + 3_600_000).toISOString();

function usage(account: string, pct: number) {
  return {
    account,
    model: "claude-opus-5-5",
    context_window: { used_percentage: 20, used: 200_000, size: 1_000_000 },
    rate_limits: {
      five_hour: { pct, resets_at: RESETS },
      weekly: { pct: 30, resets_at: RESETS },
    },
    captured_at: new Date().toISOString(),
  };
}

/** Publish a retained usage sample as `agent` on its own topic. */
async function publishUsage(agent: string, payload: unknown): Promise<void> {
  await s.agent.publish(
    buildTopic(NS, agent, "usage"),
    JSON.stringify(
      buildEnvelope({ agentId: agent, parentId: null, channel: "usage", type: "usage", payload }),
    ),
    { qos: 1, retain: true },
  );
}

async function accountRecord(acct: string): Promise<Record<string, unknown> | null> {
  const raw = await s.agent.queryRetained(usageAccountTopic(acct), 300);
  return raw === null || raw === ""
    ? null
    : (parseEnvelope(raw)?.payload as Record<string, unknown>);
}

/** The retained record of `acct` once `pred` holds for it (or the last one read). */
async function recordWhen(
  acct: string,
  pred: (r: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown> | null> {
  let r: Record<string, unknown> | null = null;
  for (let i = 0; i < 100; i++) {
    r = await accountRecord(acct);
    if (r !== null && pred(r)) return r;
    await new Promise((res) => setTimeout(res, 25));
  }
  return r;
}

describe("usage metering (daemon)", () => {
  it("folds samples per account, opens one account_limit decision, and moves the wave only on an answer", async () => {
    const base = mkdtempSync(join(tmpdir(), "volleyd-usage-"));
    const root = join(base, "claude");
    const primary = join(base, ".claude");
    mkdirSync(join(root, "spare"), { recursive: true });
    mkdirSync(primary, { recursive: true });
    writeFileSync(
      join(root, "accounts.json"),
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: "spare",
            label: "Spare",
            machine: "local",
            created: "2026-10-18T12:00:00.000Z",
            plan: "max",
            signed_in_at: "2026-10-18T12:00:00.000Z",
          },
        ],
      }),
    );
    s = await makeSupervisedEnv({ daemon: { claude: { root, primaryDir: primary } } });

    // An agent of another wave (not supervised here) reports the spare account, by profile dir.
    await publishUsage("other-agent", {
      ...usage("spare", 10),
      account: null,
      config_dir: join(root, "spare"),
    });
    const spare = await recordWhen("spare", () => true);
    expect(spare).toMatchObject({
      account: "spare",
      label: "Spare",
      plan: "max",
      five_hour: { pct: 10 },
      agents: ["other-agent"],
      waves: [],
    });

    // The wave's agent crosses the 5-hour threshold on the primary.
    await publishUsage(AGENT, usage("primary", 93));
    const limit = () =>
      s.journal().filter((e) => e.type === "decision_opened" && e.data.kind === "account_limit");
    await s.until(() => limit().length === 1);
    expect(limit()[0]?.data).toMatchObject({
      acct: "primary",
      pct: 93,
      resets_at: RESETS,
      suggested: "spare",
      options: ["move wave w1 to spare", "not now"],
    });
    expect(await accountRecord("primary")).toMatchObject({
      agents: [AGENT],
      waves: ["w1"],
      five_hour: { pct: 93 },
    });

    // Another sample while the decision is open: no second decision, and nothing moved.
    await publishUsage(AGENT, usage("primary", 95));
    await recordWhen("primary", (r) => (r.five_hour as { pct: number }).pct === 95);
    await new Promise((r) => setTimeout(r, 200));
    expect(limit()).toHaveLength(1);
    expect(s.journal().some((e) => e.type === "wave_account_moved")).toBe(false);

    // An unknown target is refused and leaves the decision open.
    const id = limit()[0]?.data.decision_id as string;
    await expect(
      s.daemon.resolveDecision("w1", id, { answer: "move wave w1 to nope", by: "o" }),
    ).rejects.toThrow(/unknown Claude account 'nope'/);

    await s.daemon.resolveDecision("w1", id, { answer: "move wave w1 to spare", by: "o" });
    const moved = s.journal().filter((e) => e.type === "wave_account_moved");
    expect(moved.map((e) => e.data)).toEqual([
      { from: "primary", to: "spare", by: "o", decision_id: id },
    ]);
    // The running agent is left where it is.
    expect(s.journal().some((e) => e.type === "agent_retired")).toBe(false);

    // A cleared usage topic (a retire clears it) drops the agent from its account's record.
    await s.agent.publish(buildTopic(NS, AGENT, "usage"), "", { qos: 1, retain: true });
    expect(await recordWhen("primary", (r) => (r.agents as unknown[]).length === 0)).toMatchObject({
      agents: [],
      waves: [],
    });
  }, 20_000);
});
