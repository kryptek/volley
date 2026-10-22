import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildEnvelope } from "volley-mcp/envelope";
import { buildTopic } from "volley-mcp/topics";
import { claudeRoot } from "../../src/claude/profiles";
import { ControlClient } from "../../src/control";
import { NS } from "../helpers/daemon-env";
import { AGENT, type SupervisedEnv, makeSupervisedEnv } from "../helpers/supervised-env";
import { tempDir } from "../helpers/tmp";
import { stubEnv, withEnv } from "../helpers/with-env";

/** agent_move_account through a real daemon: cancel, stop, retire, respawn under the profile. */

let s: SupervisedEnv;
afterEach(async () => {
  await s?.cleanup();
});

/**
 * Move the supervised agent to profile `work` under `root`; `customRoot` undefined runs the daemon with
 * its default root (`claudeRoot()`, `~/.volley/claude` under a temporary HOME).
 */
async function moveToWork(customRoot: string | undefined, base: string): Promise<void> {
  const primary = join(base, ".claude");
  mkdirSync(primary, { recursive: true });
  s = await makeSupervisedEnv({
    daemon: {
      claude: { ...(customRoot !== undefined ? { root: customRoot } : {}), primaryDir: primary },
    },
  });
  const root = customRoot ?? claudeRoot();
  const dir = join(root, "work");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(root, "accounts.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        {
          id: "work",
          label: "work",
          machine: "local",
          created: "2026-10-18T12:00:00.000Z",
          signed_in_at: "2026-10-18T12:00:00.000Z",
        },
      ],
    }),
  );
  writeFileSync(
    join(dir, ".claude.json"),
    JSON.stringify({ projects: { [s.repo]: { hasTrustDialogAccepted: true } } }),
  );
  // The respawn is checked by what it wrote; no simulated session for it.
  s.host.onLaunch = () => {};
  const client = await ControlClient.connect(s.env.broker.url, NS);
  try {
    const reply = client.request("agent_move_account", { agent: AGENT, acct: "work", by: "o" });
    await s.until(() => s.journal().some((e) => e.type === "agent_account_moved"));
    await s.status("blocked", { reason: "moving" });
    const r = await reply;
    expect(r).toMatchObject({
      ok: true,
      agent_id: "w1-t1-implementer-2",
      from: "primary",
      to: "work",
    });
    const j = s.journal();
    expect(j.find((e) => e.type === "agent_retired")?.data).toMatchObject({
      agent_id: AGENT,
      status: "moved",
    });
    const spawned = j.filter((e) => e.type === "agent_spawned");
    expect(spawned.map((e) => e.data.claude_account)).toEqual(["primary", "work"]);
    // the account is replayed from the journal, not passed in by the move
    const wt = join(s.env.home, "wt", "w1", "T1-implementer");
    expect(readFileSync(join(wt, ".volley", "launch.sh"), "utf-8")).toContain(
      `export CLAUDE_CONFIG_DIR='${dir}'`,
    );
    expect(readFileSync(join(wt, ".volley", "brief.md"), "utf-8")).toMatch(
      /## Resume after an account move/,
    );
    // the profile was prepared for its first agent: no onboarding screen
    expect(JSON.parse(readFileSync(join(dir, ".claude.json"), "utf-8"))).toMatchObject({
      hasCompletedOnboarding: true,
    });
    // the stop is the move's, not a blocked task: no decision for it
    expect(j.some((e) => e.type === "decision_opened")).toBe(false);
  } finally {
    await client.close();
  }
}

describe("agent_move_account (daemon)", () => {
  it("retires the agent as moved and respawns it with the target profile's CLAUDE_CONFIG_DIR", async () => {
    // A custom root (the daemon's `claude.root`) is the one $VOLLEY_CLAUDE_DIR names: the fence's.
    const base = tempDir("volleyd-move-");
    const root = join(base, "claude");
    await withEnv({ VOLLEY_CLAUDE_DIR: root }, () => moveToWork(root, base));
  }, 20_000);

  it("moves to a profile in the DEFAULT root (~/.volley/claude/<acct>) through the real fence", async () => {
    // The owner's smoke: the respawn under a profile there was FENCE_DENIED (launch.sh).
    const base = realpathSync(tempDir("volleyd-move-"));
    await withEnv(
      { HOME: base, VOLLEY_CLAUDE_DIR: undefined, VOLLEYD_HOME: undefined },
      async () => {
        expect(claudeRoot()).toBe(join(base, ".volley", "claude"));
        await moveToWork(undefined, base);
      },
    );
  }, 20_000);
});

describe("agent_account_limit (D2): autopilot moves a running agent off a hot account", () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
  });
  const RESETS = new Date(Date.now() + 3_600_000).toISOString();
  let n = 0;
  const sample = (account: string, pct: number, resets = RESETS) => ({
    account,
    model: "claude-opus-5-5",
    context_window: { used_percentage: 20, used: 200_000, size: 1_000_000 },
    rate_limits: {
      five_hour: { pct, resets_at: resets },
      weekly: { pct: 30, resets_at: RESETS },
    },
    captured_at: new Date(Date.now() + ++n * 1000).toISOString(),
  });
  const publishUsage = (agent: string, payload: unknown) =>
    s.agent.publish(
      buildTopic(NS, agent, "usage"),
      JSON.stringify(
        buildEnvelope({ agentId: agent, parentId: null, channel: "usage", type: "usage", payload }),
      ),
      { qos: 1, retain: true },
    );
  const limits = () =>
    s
      .journal()
      .filter((e) => e.type === "decision_opened" && e.data.kind === "agent_account_limit");

  /** A balanced wave whose agent runs on the primary; `work` signed in after its spawn. */
  async function balancedOnPrimary(): Promise<string> {
    const base = tempDir("volleyd-agent-limit-");
    const root = join(base, "claude");
    restore = stubEnv({ VOLLEY_CLAUDE_DIR: root });
    const primary = join(base, ".claude");
    mkdirSync(primary, { recursive: true });
    s = await makeSupervisedEnv({ daemon: { claude: { root, primaryDir: primary } } });
    const dir = join(root, "work");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(root, "accounts.json"),
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: "work",
            label: "work",
            machine: "local",
            created: "2026-10-18T12:00:00.000Z",
            signed_in_at: "2026-10-18T12:00:00.000Z",
          },
        ],
      }),
    );
    writeFileSync(
      join(dir, ".claude.json"),
      JSON.stringify({ projects: { [s.repo]: { hasTrustDialogAccepted: true } } }),
    );
    return dir;
  }

  it("opens once for the hot window; answered by autopilot it moves the agent, journaled with why", async () => {
    const dir = await balancedOnPrimary();
    await publishUsage("other-agent", sample("work", 12));
    await publishUsage(AGENT, sample("primary", 93));
    const opened = await s.event(
      (e) => e.type === "decision_opened" && e.data.kind === "agent_account_limit",
    );
    expect(opened.task).toBe("T1");
    expect(opened.data).toMatchObject({
      agent_id: AGENT,
      role: "implementer",
      acct: "primary",
      window: "five_hour",
      pct: 93,
      resets_at: RESETS,
      suggested: "work",
      options: [`move ${AGENT} to work`, "not now"],
    });
    // the wave balances: no wave-level move decision for the hot account
    expect(s.journal().some((e) => e.data.kind === "account_limit")).toBe(false);
    // a second sample in the same window: no second decision
    await publishUsage(AGENT, sample("primary", 95));
    await s.consumed();
    expect(limits()).toHaveLength(1);

    s.host.onLaunch = () => {};
    const id = opened.data.decision_id as string;
    // an account the agent's machine cannot take is refused before anything moves
    await expect(
      s.daemon.resolveDecision("w1", id, { answer: `move ${AGENT} to nope`, by: "o" }),
    ).rejects.toThrow(/unknown Claude account 'nope'/);
    await s.daemon.resolveDecision("w1", id, { answer: `move ${AGENT} to work`, by: "autopilot" });
    await s.until(() => s.journal().some((e) => e.type === "agent_account_moved"));
    await s.status("blocked", { reason: "moving" });
    await s.event("agent_spawned", 2);
    const why = "moved off primary (5h 93%) by autopilot";
    expect(s.journal().find((e) => e.type === "agent_account_moved")?.data).toEqual({
      agent_id: AGENT,
      role: "implementer",
      from: "primary",
      to: "work",
      by: "autopilot",
      decision_id: id,
      why,
    });
    const chosen = s.journal().filter((e) => e.type === "account_chosen");
    expect(chosen.map((e) => e.data.source)).toEqual(["default", "move"]);
    expect(chosen[1]?.data).toMatchObject({ account: "work", attempt: 2, why });
    const spawned = s.journal().filter((e) => e.type === "agent_spawned");
    expect(spawned[1]?.data).toMatchObject({ claude_account: "work", account_why: why });
    const wt = join(s.env.home, "wt", "w1", "T1-implementer");
    expect(readFileSync(join(wt, ".volley", "launch.sh"), "utf-8")).toContain(
      `export CLAUDE_CONFIG_DIR='${dir}'`,
    );
  }, 30_000);

  it("not now leaves the agent; the next decision waits for the window's reset", async () => {
    await balancedOnPrimary();
    await publishUsage("other-agent", sample("work", 12));
    await publishUsage(AGENT, sample("primary", 93));
    const opened = await s.event(
      (e) => e.type === "decision_opened" && e.data.kind === "agent_account_limit",
    );
    await s.daemon.resolveDecision("w1", opened.data.decision_id as string, {
      answer: "not now",
      by: "autopilot",
    });
    await publishUsage(AGENT, sample("primary", 96));
    await s.consumed();
    expect(limits()).toHaveLength(1);
    expect(s.journal().some((e) => e.type === "agent_account_moved")).toBe(false);
    // the window reset and filled again: asked again
    const later = new Date(Date.now() + 7_200_000).toISOString();
    await publishUsage(AGENT, sample("primary", 92, later));
    await s.event((e) => e.type === "decision_opened" && e.data.kind === "agent_account_limit", 2);
    expect(limits()[1]?.data.resets_at).toBe(later);
  }, 30_000);
});
