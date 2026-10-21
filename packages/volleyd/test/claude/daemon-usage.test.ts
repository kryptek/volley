import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { buildTopic } from "volley-mcp/topics";
import { usageAccountTopic } from "../../src/claude/usage";
import { Journal } from "../../src/journal";
import { MACHINE_CHANNEL, machineTopic } from "../../src/machines";
import type { ReconcileProbes } from "../../src/reconcile";
import { eventually } from "../helpers/broker-wait";
import { NS } from "../helpers/daemon-env";
import { type FakeClock, fakeClock } from "../helpers/fake-clock";
import { schemaErrors } from "../helpers/schema";
import { AGENT, type SupervisedEnv, makeSupervisedEnv } from "../helpers/supervised-env";
import { tempDir } from "../helpers/tmp";
import { stubEnv } from "../helpers/with-env";

/**
 * Usage metering through a real daemon: fold, publish, threshold decision, wave move. The daemon
 * runs on a fake clock: its reap grace fires only when the test moves time, and the samples carry
 * stamps on that clock (each one newer than the last, so the newest-sample-wins fold takes it).
 */

let s: SupervisedEnv;
let restoreEnv: (() => void) | undefined;
afterEach(async () => {
  restoreEnv?.();
  restoreEnv = undefined;
  await s?.cleanup();
});

const T0 = Date.parse("2026-10-18T12:00:00.000Z");
const RESETS = new Date(T0 + 3_600_000).toISOString();
let samples = 0;

function usage(account: string, pct: number) {
  return {
    account,
    model: "claude-opus-5-5",
    context_window: { used_percentage: 20, used: 200_000, size: 1_000_000 },
    rate_limits: {
      five_hour: { pct, resets_at: RESETS },
      weekly: { pct: 30, resets_at: RESETS },
    },
    captured_at: new Date(T0 + ++samples * 1000).toISOString(),
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

async function accountEnvelope(acct: string): Promise<unknown> {
  const raw = await s.agent.queryRetained(usageAccountTopic(acct), 300);
  return raw === null || raw === "" ? null : JSON.parse(raw);
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
  // The record is the daemon's retained publish: no journal event marks it.
  await eventually(async () => {
    r = await accountRecord(acct);
    return r !== null && pred(r);
  });
  return r;
}

/** A registry with one signed-in local profile, `spare`; returns its profile dir. */
/** Profile `spare` in `<base>/claude`, the profiles root the launch fence reads ($VOLLEY_CLAUDE_DIR). */
function spareProfile(base: string): { root: string; primary: string; spare: string } {
  const root = join(base, "claude");
  restoreEnv = stubEnv({ VOLLEY_CLAUDE_DIR: root });
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
          email: "spare@example.com",
          org: "Example Org",
          signed_in_at: "2026-10-18T12:00:00.000Z",
        },
      ],
    }),
  );
  return { root, primary, spare: join(root, "spare") };
}

/** Cross the threshold on the primary with the wave's agent; the account_limit decision id. */
async function limitOnPrimary(): Promise<string> {
  await publishUsage(AGENT, usage("primary", 93));
  const opened = await s.event(
    (e) => e.type === "decision_opened" && e.data.kind === "account_limit",
  );
  return opened.data.decision_id as string;
}

describe("usage metering (daemon)", () => {
  it("folds samples per account, opens one account_limit decision, and moves the wave only on an answer", async () => {
    const { root, primary } = spareProfile(tempDir("volleyd-usage-"));
    s = await makeSupervisedEnv({
      daemon: { claude: { root, primaryDir: primary }, clock: fakeClock(T0) },
    });

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
    await limitOnPrimary();
    const limit = () =>
      s.journal().filter((e) => e.type === "decision_opened" && e.data.kind === "account_limit");
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
    await s.consumed();
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

  it("after a wave move, the wave's next agent spawns under the target profile", async () => {
    const { root, primary, spare } = spareProfile(tempDir("volleyd-usage-"));
    const clock: FakeClock = fakeClock(T0);
    s = await makeSupervisedEnv({
      daemon: { claude: { root, primaryDir: primary }, clock },
      reapGraceMs: 60_000,
    });
    writeFileSync(
      join(spare, ".claude.json"),
      JSON.stringify({ projects: { [s.repo]: { hasTrustDialogAccepted: true } } }),
    );
    const id = await limitOnPrimary();
    await s.daemon.resolveDecision("w1", id, { answer: "move wave w1 to spare", by: "o" });

    // The running agent is reaped; its respawn is a new agent of the wave.
    s.host.onLaunch = () => {};
    await s.status("reaped", { reason: "lwt" });
    // The LWT is held for the reap grace; past it, with no heartbeat, the reap is accepted.
    await s.consumed();
    await clock.advance(60_000);
    await s.daemon.tick();
    const blocked = await s.event(
      (e) => e.type === "decision_opened" && e.data.kind === "agent_blocked",
    );
    await s.daemon.resolveDecision("w1", blocked.data.decision_id as string, {
      answer: "respawn",
      by: "o",
    });
    await s.event("agent_spawned", 2);
    const spawned = s.journal().filter((e) => e.type === "agent_spawned");
    expect(spawned.map((e) => e.data.claude_account)).toEqual(["primary", "spare"]);
    const wt = join(s.env.home, "wt", "w1", "T1-implementer");
    expect(readFileSync(join(wt, ".volley", "launch.sh"), "utf-8")).toContain(
      `export CLAUDE_CONFIG_DIR='${spare}'`,
    );
  }, 20_000);
});

describe("usage metering across a restart and across hosts (daemon)", () => {
  const limitOpened = (e: { type: string; data: Record<string, unknown> }) =>
    e.type === "decision_opened" && e.data.kind === "account_limit";
  const probes: ReconcileProbes = {
    branch: async (_repo, branch) => ({ name: branch, exists: true, head: "abc123" }),
    pr: async () => null,
  };

  it("an account's windows outlive a restart with nothing running on it", async () => {
    const { root, primary } = spareProfile(tempDir("volleyd-usage-"));
    s = await makeSupervisedEnv({
      daemon: { claude: { root, primaryDir: primary }, clock: fakeClock(T0) },
    });
    await publishUsage("other-agent", {
      ...usage("spare", 10),
      account: null,
      config_dir: join(root, "spare"),
    });
    await recordWhen("spare", () => true);
    // Its agent is gone (a retire clears the topic): the account keeps its windows.
    await s.agent.publish(buildTopic(NS, "other-agent", "usage"), "", { qos: 1, retain: true });
    await recordWhen("spare", (r) => (r.agents as unknown[]).length === 0);
    await s.daemon.stop();
    // Not read back from the broker: its retained record is gone too.
    await s.agent.publish(usageAccountTopic("spare"), "", { qos: 1, retain: true });

    const second = await s.restart({ reconcile: probes });
    await second.reconciled();
    expect(await recordWhen("spare", () => true)).toMatchObject({
      five_hour: { pct: 10 },
      agents: [],
    });
    // most_headroom still knows spare: the primary's limit suggests it.
    await publishUsage(AGENT, usage("primary", 93));
    expect((await s.event(limitOpened)).data).toMatchObject({
      acct: "primary",
      suggested: "spare",
    });
  }, 20_000);

  it("a registry account's record carries its login's email and org; it validates", async () => {
    const { root, primary } = spareProfile(tempDir("volleyd-usage-"));
    s = await makeSupervisedEnv({
      daemon: { claude: { root, primaryDir: primary }, clock: fakeClock(T0) },
    });
    await publishUsage("other-agent", {
      ...usage("spare", 10),
      account: null,
      config_dir: join(root, "spare"),
    });
    expect(await recordWhen("spare", () => true)).toMatchObject({
      account: "spare",
      label: "Spare",
      plan: "max",
      email: "spare@example.com",
      org: "Example Org",
    });
    expect(schemaErrors("claude-account.schema.json", await accountEnvelope("spare"))).toEqual([]);
  }, 20_000);

  it("a sample retained while the daemon was down opens account_limit on restart, with no new sample", async () => {
    const { root, primary } = spareProfile(tempDir("volleyd-usage-"));
    s = await makeSupervisedEnv({
      daemon: { claude: { root, primaryDir: primary }, clock: fakeClock(T0) },
    });
    await s.daemon.stop();
    await publishUsage(AGENT, usage("primary", 93));

    const second = await s.restart({ reconcile: probes });
    await second.reconciled();
    await s.consumed();
    expect(
      s
        .journal()
        .filter(limitOpened)
        .map((e) => e.data),
    ).toMatchObject([{ acct: "primary", pct: 93 }]);
    expect(await accountRecord("primary")).toMatchObject({ agents: [AGENT], waves: ["w1"] });
  }, 20_000);

  it("a remote host's agent is metered on that host's account, never the local primary", async () => {
    const { root, primary } = spareProfile(tempDir("volleyd-usage-"));
    s = await makeSupervisedEnv({
      daemon: { claude: { root, primaryDir: primary }, clock: fakeClock(T0) },
    });
    await s.daemon.stop();
    // The wave's reviewer ran on a remote host, under that host's own default login.
    const remote = "w1-t1-spec-reviewer-1";
    Journal.open(join(s.env.home, "waves", "w1")).append(
      {
        type: "agent_spawned",
        task: "T1",
        data: { agent_id: remote, role: "spec_reviewer", attempt: 1, host: "gpu-box" },
      },
      new Date(T0),
    );
    // gpu-box is a paired machine whose record names its default profile's login.
    writeFileSync(
      join(s.env.home, "config.yaml"),
      "hosts:\n  gpu-box:\n    target: dev@gpu-box\n    repo: /srv/repo\n    volley_dir: /opt/volley\n    tunnel: { remote_port: 21883, supervise: false }\n",
    );
    await s.agent.publish(
      machineTopic("gpu-box"),
      JSON.stringify({
        ...buildEnvelope({
          agentId: "gpu-box",
          parentId: null,
          channel: MACHINE_CHANNEL,
          type: "machine",
          payload: {
            name: "gpu-box",
            os: "linux",
            cores: 8,
            tunnel: "up",
            load: [0.1, 0.1, 0.1],
            agents: 1,
            auth: {
              gh: "ok",
              claude: "signed_in",
              trust: "ok",
              claude_email: "gpu@example.com",
              claude_org: "Example Org",
            },
            last_seen: new Date(T0).toISOString(),
          },
        }),
      }),
      { qos: 1, retain: true },
    );
    const second = await s.restart({ reconcile: probes });
    await second.reconciled();

    await publishUsage(remote, usage("primary", 95));
    await publishUsage(AGENT, usage("primary", 20));
    expect(
      await recordWhen("primary@gpu-box", (r) => (r.five_hour as { pct: number }).pct === 95),
    ).toMatchObject({
      account: "primary@gpu-box",
      email: "gpu@example.com",
      org: "Example Org",
      agents: [remote],
      waves: ["w1"],
    });
    expect(
      schemaErrors("claude-account.schema.json", await accountEnvelope("primary@gpu-box")),
    ).toEqual([]);
    expect(
      await recordWhen("primary", (r) => (r.five_hour as { pct: number }).pct === 20),
    ).toMatchObject({ agents: [AGENT], five_hour: { pct: 20 } });
    // A wave move cannot reach a remote host's agents: its window opens no decision.
    await s.consumed();
    expect(s.journal().filter(limitOpened)).toEqual([]);
  }, 20_000);
});
