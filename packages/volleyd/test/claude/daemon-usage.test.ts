import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope, parseEnvelope } from "volley-mcp/envelope";
import { buildTopic } from "volley-mcp/topics";
import { AGENT_SAMPLE_TTL_MS, usageAccountTopic } from "../../src/claude/usage";
import { ControlClient } from "../../src/control";
import { Journal } from "../../src/journal";
import { MACHINE_CHANNEL, machineTopic } from "../../src/machines";
import type { ReconcileProbes } from "../../src/reconcile";
import { eventually } from "../helpers/broker-wait";
import { type DaemonEnv, NS, makeDaemonEnv } from "../helpers/daemon-env";
import { type FakeClock, fakeClock } from "../helpers/fake-clock";
import { fakeExec } from "../helpers/fake-exec";
import {
  type FakeHost,
  type FakeRemoteHost,
  GREEN_DOCTOR,
  adoptSpec,
  fakeRemoteHost,
} from "../helpers/fake-host";
import { journalWait } from "../helpers/journal-wait";
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
  // Once: a later test may not start one (the registry tests run a plain daemon).
  const env = s as SupervisedEnv | undefined;
  s = undefined as unknown as SupervisedEnv;
  await env?.cleanup();
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
      // Pinned to the primary: the wave-level account_limit and move (no D3 balancing).
      waveExtra: "account: primary",
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
      // Pinned to the primary: the wave-level account_limit and move (no D3 balancing).
      waveExtra: "account: primary",
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
      // Pinned to the primary: the wave-level account_limit and move (no D3 balancing).
      waveExtra: "account: primary",
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

  it("an account's learned rates stay in the book, off its retained record (#557)", async () => {
    const { root, primary } = spareProfile(tempDir("volleyd-usage-"));
    s = await makeSupervisedEnv({
      waveExtra: "account: primary",
      daemon: { claude: { root, primaryDir: primary }, clock: fakeClock(T0) },
    });
    await publishUsage("other-agent", {
      ...usage("spare", 10),
      account: null,
      config_dir: join(root, "spare"),
    });
    await recordWhen("spare", () => true);
    await s.daemon.stop();
    await s.agent.publish(usageAccountTopic("spare"), "", { qos: 1, retain: true });
    // The book kept a learned rate for spare.
    const file = join(s.env.home, "claude-usage.json");
    const book = JSON.parse(readFileSync(file, "utf8"));
    book.accounts.spare.rates = {
      five_hour: { pct_per_agent_h: 12, samples: 3, at: new Date(T0).toISOString() },
    };
    writeFileSync(file, JSON.stringify(book));

    const second = await s.restart({ reconcile: probes });
    await second.reconciled();
    const rec = await recordWhen("spare", () => true);
    expect(rec).toMatchObject({ five_hour: { pct: 10 } });
    expect(rec).not.toHaveProperty("rates");
    expect(JSON.parse(readFileSync(file, "utf8")).accounts.spare.rates).toMatchObject({
      five_hour: { pct_per_agent_h: 12 },
    });
  }, 20_000);

  it("a registry account's record carries its login's email and org; it validates", async () => {
    const { root, primary } = spareProfile(tempDir("volleyd-usage-"));
    s = await makeSupervisedEnv({
      // Pinned to the primary: the wave-level account_limit and move (no D3 balancing).
      waveExtra: "account: primary",
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
      // Pinned to the primary: the wave-level account_limit and move (no D3 balancing).
      waveExtra: "account: primary",
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
      // Pinned to the primary: the wave-level account_limit and move (no D3 balancing).
      waveExtra: "account: primary",
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

describe("interactive and stale sessions on an account (#562)", () => {
  const COORD = "coordinator-ab12";
  const probes: ReconcileProbes = {
    branch: async (_repo, branch) => ({ name: branch, exists: true, head: "abc123" }),
    pr: async () => null,
  };
  let control: ControlClient | undefined;
  afterEach(async () => {
    await control?.close();
    control = undefined;
  });

  /** The local primary's `claude_balance` candidate. */
  async function primaryCandidate(): Promise<Record<string, unknown> | undefined> {
    control ??= await ControlClient.connect(s.env.broker.url, NS);
    const r = await control.request("claude_balance", { machine: "local" });
    expect(r.ok, r.error).toBe(true);
    const [m] = (r.result as { machines: { candidates: Record<string, unknown>[] }[] }).machines;
    return m?.candidates.find((c) => c.account === "primary");
  }

  const retained = async (agent: string) =>
    (await s.agent.queryRetained(buildTopic(NS, agent, "usage"), 300)) ?? "";

  it("a coordinator session moves the windows, never counts as an agent, and leaves the record an hour after its last sample", async () => {
    const { root, primary } = spareProfile(tempDir("volleyd-usage-"));
    const clock = fakeClock(T0);
    s = await makeSupervisedEnv({
      waveExtra: "account: primary",
      daemon: { claude: { root, primaryDir: primary }, clock },
    });
    // two interactive sessions on the primary: on its record, not counted by the balance
    await publishUsage(COORD, usage("primary", 19));
    await publishUsage("coordinator-cd34", usage("primary", 20));
    const rec = await recordWhen("primary", (r) => (r.agents as string[]).length === 2);
    expect(rec).toMatchObject({
      five_hour: { pct: 20 },
      agents: [COORD, "coordinator-cd34"],
      waves: [],
    });
    const idle = await primaryCandidate();
    expect(idle?.agents).toBe(idle?.in_flight);
    expect(idle?.in_flight).toBeLessThanOrEqual(1);

    // the supervised agent samples: it counts, the session does not
    await publishUsage(AGENT, usage("primary", 22));
    await recordWhen("primary", (r) => (r.agents as string[]).includes(AGENT));
    expect(await primaryCandidate()).toMatchObject({ agents: 1, in_flight: 1 });

    // an hour and a minute later, a pass: the session goes, the supervised agent (as old) stays
    clock.sleepHost(AGENT_SAMPLE_TTL_MS + 60_000);
    await publishUsage(AGENT, usage("primary", 25));
    const after = await recordWhen(
      "primary",
      (r) => !(r.agents as string[]).includes(COORD) && (r.five_hour as { pct: number }).pct === 25,
    );
    expect(after).toMatchObject({ agents: [AGENT], waves: ["w1"] });
    await eventually(async () => (await retained(COORD)) === "");
    expect(await retained("coordinator-cd34")).toBe("");
    expect(await retained(AGENT)).not.toBe("");
  }, 20_000);

  it("a stale coordinator sample retained across a restart is not listed and its topic is cleared", async () => {
    const { root, primary } = spareProfile(tempDir("volleyd-usage-"));
    const clock = fakeClock(T0);
    s = await makeSupervisedEnv({
      waveExtra: "account: primary",
      daemon: { claude: { root, primaryDir: primary }, clock },
    });
    await s.daemon.stop();
    await publishUsage(COORD, usage("primary", 40));
    await publishUsage(AGENT, usage("primary", 41));
    clock.sleepHost(AGENT_SAMPLE_TTL_MS + 60_000);

    const second = await s.restart({ reconcile: probes });
    await second.reconciled();
    await eventually(async () => (await retained(COORD)) === "");
    const rec = await recordWhen("primary", (r) => !(r.agents as string[]).includes(COORD));
    // the windows still folded (the session's spend is the account's); the supervised one stays
    expect(rec).toMatchObject({ agents: [AGENT], five_hour: { pct: 41 } });
    expect(await primaryCandidate()).toMatchObject({ agents: 1, in_flight: 1 });
  }, 20_000);
});

describe("usage probe readings in machine records (daemon)", () => {
  const probes: ReconcileProbes = {
    branch: async (_repo, branch) => ({ name: branch, exists: true, head: "abc123" }),
    pr: async () => null,
  };
  const READ = new Date(T0).toISOString();
  const login = (profile: string, fable: number, fiveHour = 37) => ({
    profile,
    state: "ok" as const,
    attempted_at: READ,
    reading: {
      read_at: READ,
      five_hour: { pct: fiveHour, resets_at: RESETS },
      weekly: { pct: 56, resets_at: RESETS },
      model_weekly: { fable: { pct: fable, resets_at: RESETS } },
    },
  });

  it("a paired machine's logins meter as primary@<name> and <id>@<name>; one the registry lacks is skipped", async () => {
    const { root, primary } = spareProfile(tempDir("volleyd-usage-"));
    // `work` is a profile the registry has on peer-a; `stray` is unknown there.
    const reg = JSON.parse(readFileSync(join(root, "accounts.json"), "utf-8"));
    reg.accounts.push({
      id: "work",
      label: "Work",
      machine: "peer-a",
      created: "2026-10-18T12:00:00.000Z",
      signed_in_at: "2026-10-18T12:00:00.000Z",
    });
    writeFileSync(join(root, "accounts.json"), JSON.stringify(reg));
    s = await makeSupervisedEnv({
      // Pinned to the primary: the wave-level account_limit and move (no D3 balancing).
      waveExtra: "account: primary",
      daemon: { claude: { root, primaryDir: primary }, clock: fakeClock(T0) },
    });
    await s.daemon.stop();
    writeFileSync(
      join(s.env.home, "config.yaml"),
      "hosts:\n  peer-a:\n    target: dev@peer-a\n    repo: /srv/repo\n    volley_dir: /opt/volley\n    tunnel: { remote_port: 21883, supervise: false }\n",
    );
    await s.agent.publish(
      machineTopic("peer-a"),
      JSON.stringify(
        buildEnvelope({
          agentId: "peer-a",
          parentId: null,
          channel: MACHINE_CHANNEL,
          type: "machine",
          payload: {
            name: "peer-a",
            os: "linux",
            cores: 8,
            tunnel: "up",
            load: [0.1, 0.1, 0.1],
            agents: 0,
            claude_logins: [login("default", 20), login("work", 70), login("stray", 5)],
            last_seen: READ,
          },
        }),
      ),
      { qos: 1, retain: true },
    );
    const second = await s.restart({ reconcile: probes });
    await second.reconciled();

    const probe = { machine: "peer-a", state: "ok", attempted_at: READ, read_at: READ };
    expect(await recordWhen("primary@peer-a", (r) => r.probe !== undefined)).toMatchObject({
      account: "primary@peer-a",
      five_hour: { pct: 37 },
      weekly: { pct: 56 },
      model_weekly: { fable: { pct: 20 } },
      probe,
    });
    expect(await recordWhen("work@peer-a", (r) => r.probe !== undefined)).toMatchObject({
      account: "work@peer-a",
      label: "Work",
      model_weekly: { fable: { pct: 70 } },
      probe,
    });
    for (const acct of ["primary@peer-a", "work@peer-a"]) {
      const env = await accountEnvelope(acct);
      expect(schemaErrors("claude-account.schema.json", env)).toEqual([]);
      expect((env as { payload: object }).payload).not.toHaveProperty("sampled_by");
    }
    await s.consumed();
    for (const acct of ["stray@peer-a", "stray", "work", "primary"]) {
      expect(await accountRecord(acct)).toBeNull();
    }
  }, 20_000);

  it("the supervisor's own record: its default login is primary", async () => {
    const { root, primary } = spareProfile(tempDir("volleyd-usage-"));
    s = await makeSupervisedEnv({
      // Pinned to the primary: the wave-level account_limit and move (no D3 balancing).
      waveExtra: "account: primary",
      daemon: {
        claude: { root, primaryDir: primary },
        clock: fakeClock(T0),
        fleet: {
          version: "0.5.0",
          localDoctor: async () => ({
            checks: [],
            claude_logins: [login("default", 33), login("spare", 44)],
            doctor_at: READ,
          }),
          localPath: () => ({ claude: true, bun: true }),
        },
      },
    });
    expect(await recordWhen("primary", (r) => r.probe !== undefined)).toMatchObject({
      account: "primary",
      model_weekly: { fable: { pct: 33 } },
      probe: { state: "ok", read_at: READ },
    });
    expect(await recordWhen("spare", (r) => r.probe !== undefined)).toMatchObject({
      account: "spare",
      model_weekly: { fable: { pct: 44 } },
    });
    expect(schemaErrors("claude-account.schema.json", await accountEnvelope("primary"))).toEqual(
      [],
    );
  }, 20_000);

  it("claude_prime: the login's identity, then the own machine's one-login probe, folded into its record (#498)", async () => {
    const { root, primary } = spareProfile(tempDir("volleyd-usage-"));
    const probed: string[] = [];
    const fx = fakeExec().on(["claude", "auth", "status"], {
      stdout: JSON.stringify({
        loggedIn: true,
        email: "spare@example.com",
        orgName: "Example Org",
        subscriptionType: "team",
      }),
    });
    s = await makeSupervisedEnv({
      waveExtra: "account: primary",
      daemon: {
        claude: { root, primaryDir: primary, exec: fx.exec },
        clock: fakeClock(T0),
        fleet: {
          version: "0.5.0",
          localProbe: async (profile) => {
            probed.push(profile);
            return [login(profile, 61)];
          },
          localPath: () => ({ claude: true, bun: true }),
        },
      },
    });
    const client = await ControlClient.connect(s.env.broker.url, NS);
    try {
      const r = await client.request("claude_prime", { acct: "spare", by: "owner-1" });
      expect(r).toMatchObject({
        ok: true,
        result: { acct: "spare", machine: "local", plan: "team" },
      });
      expect(probed).toEqual(["spare"]);
      expect(await recordWhen("spare", (x) => x.probe !== undefined)).toMatchObject({
        account: "spare",
        plan: "team",
        email: "spare@example.com",
        model_weekly: { fable: { pct: 61 } },
        probe: { state: "ok", read_at: READ },
      });
      const again = await client.request("claude_prime", { acct: "spare", by: "owner-1" });
      expect(again).toMatchObject({ ok: false, error: "primed just now; next in 5 min" });
      // the e-mail never reaches the journal (a prime journals nothing of its own)
      const sys = join(s.env.home, "waves", "_system", "journal.jsonl");
      if (existsSync(sys)) expect(readFileSync(sys, "utf-8")).not.toContain("spare@example.com");
    } finally {
      await client.close();
    }
  }, 20_000);

  it.each([
    { how: "its one-login probe", probeLogin: true },
    { how: "its doctor when its volley has no --probe-login", probeLogin: false },
  ])(
    "claude_prime of a paired machine's login: $how, folded into its record (#498)",
    async ({ probeLogin }) => {
      const { root, primary } = spareProfile(tempDir("volleyd-usage-"));
      const reg = JSON.parse(readFileSync(join(root, "accounts.json"), "utf-8"));
      reg.accounts.push({
        id: "work",
        label: "Work",
        machine: "peer-a",
        created: "2026-10-18T12:00:00.000Z",
        plan: "team",
        email: "work@example.com",
        signed_in_at: "2026-10-18T12:00:00.000Z",
      });
      writeFileSync(join(root, "accounts.json"), JSON.stringify(reg));
      s = await makeSupervisedEnv({
        waveExtra: "account: primary",
        daemon: { claude: { root, primaryDir: primary }, clock: fakeClock(T0) },
      });
      await s.daemon.stop();
      writeFileSync(
        join(s.env.home, "config.yaml"),
        "hosts:\n  peer-a:\n    target: dev@peer-a\n    repo: /srv/repo\n    volley_dir: /opt/volley\n    tunnel: { remote_port: 21883, supervise: false }\n",
      );
      // peer-a's record, up and with no readings yet (a doctor run folds into it)
      await s.agent.publish(
        machineTopic("peer-a"),
        JSON.stringify(
          buildEnvelope({
            agentId: "peer-a",
            parentId: null,
            channel: MACHINE_CHANNEL,
            type: "machine",
            payload: {
              name: "peer-a",
              os: "linux",
              cores: 8,
              tunnel: "up",
              load: [0.1, 0.1, 0.1],
              agents: 0,
              last_seen: READ,
            },
          }),
        ),
        { qos: 1, retain: true },
      );
      const asked: string[] = [];
      let box: FakeRemoteHost | undefined;
      const spawner = s.daemonOptions.spawner;
      if (spawner === undefined) throw new Error("no spawner");
      await s.restart({
        reconcile: probes,
        spawner: {
          ...spawner,
          remoteHost: (spec) => {
            if (box === undefined) {
              box = fakeRemoteHost(spec, spawner.host as FakeHost, {
                doctor: {
                  ...GREEN_DOCTOR,
                  claude_logins: [login("default", 9), login("work", 64)],
                },
              });
              box.probeLogin = async (profile) => {
                asked.push(profile);
                return probeLogin ? [login(profile, 64)] : null;
              };
            }
            return adoptSpec(box, spec);
          },
        },
      });
      const client = await ControlClient.connect(s.env.broker.url, NS);
      try {
        const r = await client.request("claude_prime", { acct: "work@peer-a", by: "owner-1" });
        expect(r).toMatchObject({ ok: true, result: { acct: "work@peer-a", machine: "peer-a" } });
        expect(asked).toEqual(["work"]);
        expect(box?.doctorRuns).toEqual(probeLogin ? [] : [{ fix: false }]);
        expect(await recordWhen("work@peer-a", (x) => x.probe !== undefined)).toMatchObject({
          account: "work@peer-a",
          model_weekly: { fable: { pct: 64 } },
          probe: { machine: "peer-a", state: "ok", read_at: READ },
        });
      } finally {
        await client.close();
      }
    },
    20_000,
  );

  it("a Fable agent's trigger reads the probe's model_weekly.fable: an agent_account_limit on that window", async () => {
    const { root, primary } = spareProfile(tempDir("volleyd-usage-"));
    restoreEnv = stubEnv({ VOLLEY_CLAUDE_DIR: root });
    s = await makeSupervisedEnv({
      // Balanced (no pin): a hot account opens an agent-level decision.
      daemon: {
        claude: { root, primaryDir: primary },
        clock: fakeClock(T0),
        fleet: {
          version: "0.5.0",
          localDoctor: async () => ({
            checks: [],
            // spare's fuller 5-hour window puts primary first on pace, so the agent spawns there
            claude_logins: [login("default", 95), login("spare", 10, 80)],
            doctor_at: READ,
          }),
          localPath: () => ({ claude: true, bun: true }),
        },
      },
    });
    await recordWhen("primary", (r) => r.probe !== undefined);
    // The agent's statusLine says Fable, and its 5-hour and 7-day windows have room.
    await publishUsage(AGENT, { ...usage("primary", 20), model: "claude-fable-5-1" });
    const opened = await s.event(
      (e) => e.type === "decision_opened" && e.data.kind === "agent_account_limit",
    );
    expect(opened.data).toMatchObject({
      agent_id: AGENT,
      acct: "primary",
      window: "model_weekly:fable",
      pct: 95,
      suggested: "spare",
    });
  }, 20_000);
});

describe("the registry-changed signal and usage-book pruning (daemon)", () => {
  const REGISTRY = "volley/_system/claude/registry";
  const CALLBACK = readFileSync(
    new URL("../fixtures/claude/browser-url.txt", import.meta.url),
    "utf-8",
  ).trim();
  let env: DaemonEnv | undefined;
  afterEach(async () => {
    await env?.cleanup();
    env = undefined;
  });

  const window = { pct: 10, resets_at: null, at: "2026-10-24T12:00:00.000Z" };
  const seen = { five_hour: window, weekly: null, sampled_at: "2026-10-24T12:00:00.000Z" };

  /**
   * A daemon whose registry holds `spare` (signed in, here), whose usage book (kept from before)
   * also holds `old`, which the registry no longer has, and whose broker still holds a retained
   * record for `stray`, an account nothing knows.
   */
  async function world() {
    env = await makeDaemonEnv();
    const base = tempDir("volleyd-registry-");
    const { root, primary } = spareProfile(base);
    writeFileSync(
      join(env.home, "claude-usage.json"),
      JSON.stringify({ version: 1, accounts: { spare: seen, old: seen, primary: seen } }),
    );
    const record = (account: string) =>
      JSON.stringify(
        buildEnvelope({
          agentId: "volleyd",
          parentId: null,
          channel: "_system/claude-accounts",
          type: "claude_account",
          payload: { account, five_hour: null, weekly: null, agents: [], waves: [] },
        }),
      );
    const pub = new VolleyBroker();
    await pub.connect({ url: env.broker.url, agentId: "old-records" });
    for (const a of ["old", "stray"])
      await pub.publish(usageAccountTopic(a), record(a), { qos: 1, retain: true });
    await pub.disconnect();
    let polls = 0;
    let signInAfter = Number.POSITIVE_INFINITY;
    const fx = fakeExec()
      .on(["claude", "--version"], { stdout: "2.0.14 (Claude Code)\n" })
      .on(["tmux", "new-session"], (argv) => {
        writeFileSync(join(argv[6] as string, "url"), CALLBACK);
        return {};
      })
      .on(["claude", "auth", "status"], (_argv, o) =>
        o.env?.CLAUDE_CONFIG_DIR === undefined
          ? { stdout: JSON.stringify({ loggedIn: true, subscriptionType: "pro" }) }
          : ++polls >= signInAfter
            ? { stdout: JSON.stringify({ loggedIn: true, subscriptionType: "max" }) }
            : { code: 1, stdout: JSON.stringify({ loggedIn: false }) },
      );
    const clock = fakeClock();
    const daemon = await env.start({
      clock,
      claude: { root, primaryDir: primary, exec: fx.exec, signinPollMs: 20, signinTimeoutMs: 5000 },
    });
    const waits = journalWait(env.home, () => daemon);
    const client = await ControlClient.connect(env.broker.url, NS);
    const e = env;
    const signal = async () =>
      (((await e.retained(REGISTRY)) as { payload?: unknown } | null)?.payload ?? null) as {
        rev: number;
        at: string;
      } | null;
    const book = () =>
      Object.keys(
        (
          JSON.parse(readFileSync(join(e.home, "claude-usage.json"), "utf-8")) as {
            accounts: Record<string, unknown>;
          }
        ).accounts,
      ).sort();
    /** Poll after poll (each one waits on the clock) until a sign-in is journaled done. */
    const signedIn = async () => {
      signInAfter = polls + 2;
      let finished = false;
      const done = waits.event("_system", "claude_signin_done").then(() => {
        finished = true;
      });
      while (!finished) {
        await Promise.race([clock.armed(20), done]);
        if (!finished) await clock.advance(20);
      }
    };
    /** The retained record of `acct` once `pred` holds for it. */
    const recordWhen = async (acct: string, pred: (r: Record<string, unknown>) => boolean) => {
      let r: Record<string, unknown> | null = null;
      await eventually(async () => {
        const raw = await e.retained(usageAccountTopic(acct));
        r = raw === null ? null : (raw as { payload: Record<string, unknown> }).payload;
        return r !== null && pred(r);
      });
      return r;
    };
    return { env: e, daemon, client, signal, book, signedIn, root, recordWhen };
  }

  it("at start: the book drops `old` and its record is cleared, a stray record is cleared, the signal carries rev 0", async () => {
    const w = await world();
    await eventually(async () => (await w.signal()) !== null);
    const at = await w.signal();
    expect(at?.rev).toBe(0);
    expect(schemaErrors("claude-registry.schema.json", await w.env.retained(REGISTRY))).toEqual([]);
    await eventually(
      async () =>
        (await w.env.stillRetained([usageAccountTopic("old"), usageAccountTopic("stray")]))
          .length === 0,
    );
    expect(await w.recordWhen("spare", () => true)).toMatchObject({ account: "spare" });
    expect(w.book()).toEqual(["primary", "spare"]);
    await w.daemon.settled();
    expect(await w.env.retained(usageAccountTopic("old"))).toBeNull();
  }, 20_000);

  it("add, sign-in done, rename, sync and remove each raise the rev; remove changes the book, the record and the signal in one call", async () => {
    const w = await world();
    await eventually(async () => (await w.signal())?.rev === 0);
    const revIs = (n: number) => eventually(async () => (await w.signal())?.rev === n);

    const added = await w.client.request("claude_account_add", { label: "Work", by: "owner-1" });
    expect(added.ok).toBe(true);
    await revIs(1);
    await w.signedIn();
    await revIs(2);

    const renamed = await w.client.request("claude_account_rename", {
      acct: "spare",
      label: "Spare account",
      by: "owner-1",
    });
    expect(renamed).toMatchObject({ ok: true, result: { acct: "spare", label: "Spare account" } });
    expect((await w.signal())?.rev).toBe(3);
    expect(await w.recordWhen("spare", (r) => r.label === "Spare account")).toMatchObject({
      label: "Spare account",
    });

    expect((await w.client.request("claude_sync", { by: "owner-1" })).ok).toBe(true);
    await revIs(4);

    const removed = await w.client.request("claude_account_remove", {
      acct: "spare",
      by: "owner-1",
    });
    expect(removed).toMatchObject({ ok: true, result: { acct: "spare", dir_removed: true } });
    // all three by the time the answer came
    expect((await w.signal())?.rev).toBe(5);
    expect(w.book()).toEqual(["primary"]);
    expect(await w.env.retained(usageAccountTopic("spare"))).toBeNull();
    expect(existsSync(join(w.root, "spare"))).toBe(false);
    // and it stays gone
    await w.daemon.settled();
    expect(await w.env.retained(usageAccountTopic("spare"))).toBeNull();
  }, 20_000);

  it("a refused remove changes nothing", async () => {
    const w = await world();
    await eventually(async () => (await w.signal())?.rev === 0);
    const r = await w.client.request("claude_account_remove", { acct: "nope", by: "owner-1" });
    expect(r).toMatchObject({ ok: false, error: "unknown Claude account 'nope'" });
    expect((await w.signal())?.rev).toBe(0);
  }, 20_000);
});
