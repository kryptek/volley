import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import { usageAccountTopic } from "../../src/claude/usage";
import { ControlClient } from "../../src/control";
import type { JournalEvent } from "../../src/types";
import { AUTOPILOT_ON, NS } from "../helpers/daemon-env";
import { type FakeClock, fakeClock } from "../helpers/fake-clock";
import { FIXTURES } from "../helpers/fake-host";
import {
  AGENT,
  ARTIFACTS_OK,
  type SupervisedEnv,
  type SupervisedEnvOptions,
  makeSupervisedEnv,
} from "../helpers/supervised-env";
import { tempDir } from "../helpers/tmp";
import { stubEnv } from "../helpers/with-env";

/**
 * B4: an agent that hits its usage limit (`credit_exhausted`) moves to an account with room on
 * its machine, unattended; the exhausted account is marked at 100% until its window resets.
 */

const MIN = 60_000;
let s: SupervisedEnv;
let clock: FakeClock;
let restore: (() => void) | undefined;
afterEach(async () => {
  await s?.cleanup();
  restore?.();
  restore = undefined;
});

const RESETS = new Date(Date.now() + 3_600_000).toISOString();
let n = 0;
// Captured before the daemon's (fake) now, as a running agent's last sample is.
const sample = (account: string, pct: number, weekly = 30) => ({
  account,
  model: "claude-opus-5-5",
  context_window: { used_percentage: 20, used: 200_000, size: 1_000_000 },
  rate_limits: {
    five_hour: { pct, resets_at: RESETS },
    weekly: { pct: weekly, resets_at: RESETS },
  },
  captured_at: new Date(Date.now() - 5 * MIN + ++n * 1000).toISOString(),
});
const publishUsage = (agent: string, payload: unknown) =>
  s.agent.publish(
    buildTopic(NS, agent, "usage"),
    JSON.stringify(
      buildEnvelope({ agentId: agent, parentId: null, channel: "usage", type: "usage", payload }),
    ),
    { qos: 1, retain: true },
  );
const opened = (kind: string) =>
  s.journal().filter((e) => e.type === "decision_opened" && e.data.kind === kind);
const isLimitHit = (e: JournalEvent) =>
  e.type === "decision_opened" &&
  e.data.kind === "agent_account_limit" &&
  e.data.class === "credit_exhausted";

async function record(acct: string): Promise<Record<string, unknown> | null> {
  const raw = await s.agent.queryRetained(usageAccountTopic(acct), 300);
  return raw === null || raw === ""
    ? null
    : (parseEnvelope(raw)?.payload as Record<string, unknown>);
}

/** A balanced wave (autopilot on) whose agent runs on the primary; `work` signed in after. */
async function onPrimary(
  o: {
    config?: string;
    waveExtra?: string;
    tasks?: string[];
    spawned?: number;
    exec?: SupervisedEnvOptions["exec"];
  } = {},
) {
  const base = tempDir("volleyd-limit-hit-");
  const root = join(base, "claude");
  restore = stubEnv({ VOLLEY_CLAUDE_DIR: root });
  const primary = join(base, ".claude");
  mkdirSync(primary, { recursive: true });
  clock = fakeClock(Date.now());
  s = await makeSupervisedEnv({
    daemon: { claude: { root, primaryDir: primary }, clock, ...AUTOPILOT_ON },
    ...(o.config !== undefined ? { config: o.config } : {}),
    ...(o.waveExtra !== undefined ? { waveExtra: o.waveExtra } : {}),
    ...(o.tasks !== undefined ? { tasks: o.tasks } : {}),
    ...(o.spawned !== undefined ? { spawned: o.spawned } : {}),
    ...(o.exec !== undefined ? { exec: o.exec } : {}),
  });
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

/** Seed the two accounts' records: `work` at `workPct`, the agent's primary at 88%. */
async function seed(workPct = 12): Promise<void> {
  await publishUsage("other-agent", sample("work", workPct));
  await publishUsage(AGENT, sample("primary", 88));
  await s.until(() => true);
  await s.consumed();
}

/** The hit is answered by autopilot: the move runs (the agent stops), the role respawns. */
async function expectMoved(): Promise<JournalEvent> {
  const d = await s.event(isLimitHit);
  await s.event(
    (e) => e.type === "decision_auto_resolved" && e.data.decision_id === d.data.decision_id,
  );
  await s.until(() => s.journal().some((e) => e.type === "agent_account_moved"));
  await s.status("blocked", { reason: "moving" });
  await s.event("agent_spawned", 2);
  return d;
}

describe("credit_exhausted with another account with room: autopilot moves the agent", () => {
  it("hook-detected: agent_account_limit (credit_exhausted), auto-moved, no model_switch", async () => {
    await onPrimary({ config: "fallback_model: claude-sonnet-5-5" });
    await seed();
    s.host.onLaunch = () => {};
    await s.hook("awaiting-credit.json");
    const d = await expectMoved();
    expect(d.task).toBe("T1");
    expect(d.data).toMatchObject({
      agent_id: AGENT,
      role: "implementer",
      acct: "primary",
      window: "five_hour",
      pct: 100,
      resets_at: RESETS,
      suggested: "work",
      class: "credit_exhausted",
      source: "hook",
      options: [`move ${AGENT} to work`, "not now"],
    });
    const auto = s.journal().find((e) => e.type === "decision_auto_resolved");
    expect(auto?.data).toMatchObject({ policy: "agent_account_limit/move-exhausted" });
    expect(
      s.journal().find((e) => e.type === "alarm_raised" && e.data.alarm === "account_limit_hit")
        ?.data,
    ).toMatchObject({
      alarm: "account_limit_hit",
      agent_id: AGENT,
      acct: "primary",
      resets_at: RESETS,
      source: "hook",
    });
    const moved = s.journal().find((e) => e.type === "agent_account_moved");
    expect(moved?.data).toMatchObject({
      agent_id: AGENT,
      from: "primary",
      to: "work",
      by: "volleyd",
      decision_id: d.data.decision_id,
      why: "hit the usage limit of primary by volleyd",
    });
    const chosen = s.journal().filter((e) => e.type === "account_chosen");
    expect(chosen.at(-1)?.data).toMatchObject({ account: "work", source: "move" });
    expect(opened("model_switch")).toEqual([]);
    // the agent itself gets no warn-level decision for the mark
    expect(opened("agent_account_limit")).toHaveLength(1);
    expect(s.host.texts).toEqual([]);
  }, 30_000);

  it("screen-detected: the same decision, with source screen and the capture pointer", async () => {
    await onPrimary();
    await seed();
    s.host.onLaunch = () => {};
    s.host.screens = [readFileSync(join(FIXTURES, "screens", "credit-exhausted.txt"), "utf-8")];
    await clock.advance(11 * MIN);
    await s.daemon.tick();
    const d = await expectMoved();
    expect(d.data).toMatchObject({ class: "credit_exhausted", source: "screen", pct: 100 });
    expect((d.data.pointers as { screen?: string }).screen).toMatch(/\.txt$/);
    expect(opened("model_switch")).toEqual([]);
  }, 30_000);

  it("account_move_max spent: escalated budget_exhausted, left open with both options", async () => {
    await onPrimary({ config: "autopilot: { account_move_max: 0 }" });
    await seed();
    await s.hook("awaiting-credit.json");
    const d = await s.event(isLimitHit);
    const esc = await s.event("decision_escalated");
    expect(esc.data).toMatchObject({ decision_id: d.data.decision_id, why: "budget_exhausted" });
    await s.consumed();
    expect(d.data.options).toEqual([`move ${AGENT} to work`, "not now"]);
    expect(d.data.question).toContain("resumes by itself when the window resets");
    expect(s.journal().some((e) => e.type === "decision_resolved")).toBe(false);
    expect(s.journal().some((e) => e.type === "agent_account_moved")).toBe(false);
    expect(opened("model_switch")).toEqual([]);
    expect(s.host.texts).toEqual([]);
  }, 30_000);

  it("a pinned task still moves; the question and the why say the pin cannot be honoured", async () => {
    await onPrimary({ waveExtra: "account: primary" });
    await seed();
    s.host.onLaunch = () => {};
    await s.hook("awaiting-credit.json");
    const d = await expectMoved();
    expect(d.data.question).toContain("pinned to primary, which is at its limit");
    const moved = s.journal().find((e) => e.type === "agent_account_moved");
    expect(moved?.data.why).toBe(
      "hit the usage limit of primary by volleyd; pinned to primary, which is at its limit",
    );
    const spawned = s.journal().filter((e) => e.type === "agent_spawned");
    expect(spawned[1]?.data).toMatchObject({ claude_account: "work" });
  }, 30_000);
});

describe("credit_exhausted with no account with room", () => {
  it("opens model_switch exactly as before (owner-only), no agent_account_limit", async () => {
    await onPrimary({ config: "fallback_model: claude-sonnet-5-5" });
    await seed(95);
    await s.hook("awaiting-credit.json");
    const d = await s.event((e) => e.type === "decision_opened" && e.data.kind === "model_switch");
    expect(d.data).toMatchObject({
      class: "credit_exhausted",
      agent_id: AGENT,
      options: ["switch to claude-sonnet-5-5", "wait", "stop task"],
    });
    const esc = await s.event("decision_escalated");
    expect(esc.data).toMatchObject({ decision_id: d.data.decision_id, why: "owner_only" });
    await s.consumed();
    expect(opened("agent_account_limit")).toEqual([]);
  }, 30_000);
});

describe("the exhausted account is marked at its limit", () => {
  it("its record shows 100% until the reset; the balance ranks it last; it survives a restart", async () => {
    await onPrimary({ config: "autopilot: { account_move_max: 0 }" });
    await seed();
    await s.hook("awaiting-credit.json");
    await s.event(isLimitHit);
    await s.consumed();
    await s.until(() => true);
    expect((await record("primary"))?.five_hour).toEqual({ pct: 100, resets_at: RESETS });
    const client = await ControlClient.connect(s.env.broker.url, NS);
    try {
      const picks = async () => {
        const r = await client.request("claude_balance", { model: "claude-opus-5-5" });
        const m = (r.result as { machines: { candidates: { account: string }[] }[] }).machines[0];
        return m?.candidates ?? [];
      };
      expect((await picks()).map((c) => c.account)).toEqual(["work", "primary"]);

      await s.daemon.stop();
      await s.restart();
      expect((await record("primary"))?.five_hour).toEqual({ pct: 100, resets_at: RESETS });

      // past the reset: the account counts as empty again
      await clock.advanceTo(Date.parse(RESETS) + MIN);
      const after = (await picks()).find((c) => c.account === "primary") as
        | { five_hour_pct: number | null }
        | undefined;
      expect(after?.five_hour_pct).toBe(0);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("a task spawned after the hit gets the account with room", async () => {
    await onPrimary({
      config: "hard_ceiling: 1, autopilot: { account_move_max: 0 }",
      tasks: ["T2: { issue: 42 }"],
      spawned: 1,
      exec: ARTIFACTS_OK,
    });
    // work fuller than the primary's last sample: only the mark puts the primary behind it
    await seed(89);
    await s.hook("awaiting-credit.json");
    await s.event(isLimitHit);
    // T1's verified done frees the ceiling: T2 spawns after the mark
    await s.status("done", { summary: "ok" });
    await s.event("agent_retired");
    await s.daemon.tick();
    const t2 = await s.event((e) => e.type === "agent_spawned" && e.task === "T2");
    expect(t2.data.claude_account).toBe("work");
    const chosen = s
      .journal()
      .find((e) => e.type === "account_chosen" && e.task === "T2" && e.data.account === "work");
    expect(chosen?.data.source).not.toBe("move");
  }, 30_000);

  it("another agent on the account gets its own warn-level move", async () => {
    await onPrimary({ tasks: ["T2: { issue: 42 }"] });
    const other = "w1-t2-implementer-1";
    const pub = (topic: string, type: string, channel: string, payload: unknown, retain = true) =>
      s.agent.publish(
        topic,
        JSON.stringify({
          ...buildEnvelope({ agentId: other, parentId: "volleyd", channel, type, payload }),
          ...(channel === "_system/registry" ? { namespace: NS } : {}),
        }),
        { qos: 1, retain },
      );
    // its session, as the harness simulates the implementer's: MCP status, registry, SessionStart
    await pub(buildTopic(NS, other, "status"), "spawning", "status", {});
    await pub(registryTopic(other), "registered", "_system/registry", {
      capabilities: [],
      cwd: "/wt",
      started_at: new Date().toISOString(),
      model: "claude-opus-5-5",
      model_source: "harness-hook",
    });
    await pub(buildTopic(NS, other, "status"), "working", "status", { source: "harness-hook" });
    await pub(
      buildTopic(NS, other, "progress"),
      "heartbeat",
      "progress",
      { source: "harness-hook", seq: 1, hook_event: "SessionStart" },
      false,
    );
    await s.event((e) => e.type === "agent_registered" && e.data.agent_id === other);
    await publishUsage(other, sample("primary", 80));
    await seed();
    s.host.onLaunch = () => {};
    await s.hook("awaiting-credit.json");
    const sib = await s.event(
      (e) =>
        e.type === "decision_opened" &&
        e.data.kind === "agent_account_limit" &&
        e.data.agent_id === other,
    );
    expect(sib.task).toBe("T2");
    expect(sib.data).toMatchObject({ acct: "primary", pct: 100, suggested: "work" });
    expect(sib.data).not.toHaveProperty("class");
    const auto = await s.event(
      (e) => e.type === "decision_auto_resolved" && e.data.decision_id === sib.data.decision_id,
    );
    expect(auto.data).toMatchObject({ policy: "agent_account_limit/move" });
  }, 30_000);
});
