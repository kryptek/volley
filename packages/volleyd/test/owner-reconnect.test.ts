import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { registryTopic } from "volley-mcp/topics";
import { decisionItemId } from "../src/autopilot/inbox";
import { formatWave } from "../src/commands/status";
import { ControlClient, waveStateTopic } from "../src/control";
import type { Daemon } from "../src/daemon";
import type { WaveState } from "../src/types";
import { eventually, until } from "./helpers/broker-wait";
import { type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { type FakeClock, fakeClock } from "./helpers/fake-clock";

/**
 * A wave owned by a coordinator NAME (VOLLEY_COORDINATOR, SPEC §6.2): the daemon binds the name
 * to the newest live registry entry carrying it, so a coordinator whose MCP server restarted
 * under a new agent id keeps its waves (`owner_reconnected`), and the wave state says
 * `reconnecting` (not `gone`) while it is away for less than `autopilot.reconnect_grace_s`.
 */

const WAVE = "w-named";
const NAME = "coord-main";
const yaml = `wave: ${WAVE}
repo: /path/to/example-repo
release_branch: release/${WAVE}
model: claude-opus-5-5
pipeline: [implement, merge_ready]
tasks:
  A: { issue: 1 }
  B: { issue: 2, after: [A] }
`;

let t: DaemonEnv;
let clock: FakeClock;
let daemon: Daemon;
let client: ControlClient;
let pub: VolleyBroker;

async function registry(agentId: string, coordinator: string = NAME, startedAt = clock.now()) {
  const env = buildEnvelope({
    now: () => new Date(clock.now()),
    agentId,
    parentId: null,
    channel: "_system/registry",
    type: "registered",
    payload: {
      capabilities: [],
      cwd: "/repo",
      coordinator,
      started_at: new Date(startedAt).toISOString(),
    },
  });
  await pub.publish(registryTopic(agentId), JSON.stringify({ ...env, namespace: NS }), {
    qos: 1,
    retain: true,
  });
}
async function status(agentId: string, type: string) {
  const env = buildEnvelope({
    now: () => new Date(clock.now()),
    agentId,
    parentId: null,
    channel: "status",
    type,
    payload: {},
  });
  await pub.publish(`volley/${NS}/${agentId}/status`, JSON.stringify(env), {
    qos: 1,
    retain: true,
  });
}
async function heartbeat(agentId: string) {
  const env = buildEnvelope({
    now: () => new Date(clock.now()),
    agentId,
    parentId: null,
    channel: "progress",
    type: "heartbeat",
    payload: { source: "volley-mcp" },
  });
  await pub.publish(`volley/${NS}/${agentId}/progress`, JSON.stringify(env), {
    qos: 1,
    retain: false,
  });
}
/** The retained wave state's `coordinator` (what a Desk opened cold reads). */
const retainedCoordinator = async () =>
  (
    (await t.retained(waveStateTopic(WAVE))) as {
      payload?: { coordinator?: { presence?: string; state?: string; last_seen?: string } };
    } | null
  )?.payload?.coordinator;
const coordinator = () => daemon.snapshot(WAVE)?.coordinator;
// Private reads, for ordering only: a replay was handled once its later sentinel is seen.
// Bracket access keeps them type-checked: renaming either field fails typecheck, not silently.
// biome-ignore lint/complexity/useLiteralKeys: dot access to a private field does not compile
const statusOf = () => daemon["statusOf"];
// biome-ignore lint/complexity/useLiteralKeys: dot access to a private field does not compile
const namedEntries = () => daemon["namedEntries"];
const reconnects = () => daemon.journalEvents(WAVE).filter((e) => e.type === "owner_reconnected");

beforeEach(async () => {
  t = await makeDaemonEnv();
  clock = fakeClock(Date.now());
  daemon = await t.start({ clock });
  client = await ControlClient.connect(t.broker.url, NS);
  pub = new VolleyBroker();
  await pub.connect({ url: t.broker.url, agentId: "test-pub" });
  const res = await client.request("run", { wave_yaml: yaml, owner: NAME });
  expect(res.error).toBeUndefined();
});
afterEach(async () => {
  await pub.disconnect();
  await client.close();
  await t.cleanup();
});

describe("a wave owned by a coordinator name", () => {
  it("binds the name, survives a reconnect under a new agent id, and journals it", async () => {
    expect(daemon.snapshot(WAVE)?.owner).toBe(NAME);
    await registry("coordinator-a1");
    await status("coordinator-a1", "working");
    await until(() =>
      expect(coordinator()).toMatchObject({ agent_id: "coordinator-a1", state: "working" }),
    );

    // The bound agent acts for the name.
    const d = await daemon.openDecision(WAVE, {
      kind: "plan_change",
      task: "A",
      question: "Split A?",
      pointers: {},
    });
    const resolved = await client.request("resolve", {
      wave: WAVE,
      decision_id: d.decision_id,
      answer: "no",
      by: "coordinator-a1",
    });
    expect(resolved.error).toBeUndefined();

    // Its MCP server goes away: reconnecting, not gone.
    await status("coordinator-a1", "reaped");
    await until(() =>
      expect(coordinator()).toMatchObject({ agent_id: "coordinator-a1", state: "reconnecting" }),
    );

    // The same session comes back under a new agent id: the name follows it.
    clock.sleepHost(60_000);
    await registry("coordinator-b2");
    await status("coordinator-b2", "registered");
    await until(() => expect(reconnects()).toHaveLength(1));
    expect(reconnects()[0]?.data).toEqual({
      owner: NAME,
      agent_id: "coordinator-b2",
      previous_agent_id: "coordinator-a1",
    });
    await until(() =>
      expect(coordinator()).toMatchObject({ agent_id: "coordinator-b2", state: "working" }),
    );
    expect(daemon.snapshot(WAVE)?.owner).toBe(NAME);
    expect(daemon.journalEvents(WAVE).some((e) => e.type === "owner_claimed")).toBe(false);

    const stale = await client.request("pause", { wave: WAVE, by: "coordinator-a1" });
    expect(stale.ok).toBe(false);
    expect(stale.error).toContain(`owned by ${NAME}`);
    expect((await client.request("pause", { wave: WAVE, by: "coordinator-b2" })).ok).toBe(true);

    // Nobody may claim it while the name is bound to a live agent.
    const claim = await client.request("claim", { wave: WAVE, by: "someone-else" });
    expect(claim.ok).toBe(false);
    expect(claim.error).toContain("coordinator-b2");

    // The bound agent "claiming" its own wave changes nothing: the name keeps it.
    const own = await client.request("claim", { wave: WAVE, by: "coordinator-b2" });
    expect(own.result).toMatchObject({ owner: NAME });
    expect(daemon.snapshot(WAVE)?.owner).toBe(NAME);
    expect(daemon.journalEvents(WAVE).some((e) => e.type === "owner_claimed")).toBe(false);

    // A daemon restart replays the retained registry: the binding comes back, nothing re-journaled.
    await daemon.stop();
    daemon = await t.start({ clock });
    await until(() => expect(coordinator()).toMatchObject({ agent_id: "coordinator-b2" }));
    expect(reconnects()).toHaveLength(1);
  });

  it("a quiet connected owner stays online and nothing re-publishes the state", async () => {
    await registry("coordinator-a1");
    await status("coordinator-a1", "working");
    await until(() =>
      expect(coordinator()).toMatchObject({ presence: "online", state: "working" }),
    );
    expect((await client.request("status", {})).ok).toBe(true);
    let published = 0;
    const stop = await pub.subscribeStream(waveStateTopic(WAVE), () => {
      published++;
    });
    // The retained state arrives on subscribe.
    await until(() => expect(published).toBeGreaterThan(0));
    published = 0;
    // 2 h in 10-minute steps, the owner silent (its MCP server's heartbeat included).
    for (let i = 0; i < 12; i++) {
      await clock.advance(600_000);
      expect((await client.request("status", {})).ok).toBe(true);
    }
    await stop();
    expect(published).toBe(0);
    expect(coordinator()).toMatchObject({ presence: "online", state: "working" });
    expect(await retainedCoordinator()).toMatchObject({ presence: "online", state: "working" });
  });

  it("a heartbeat keeps an awaiting_input coordinator awaiting, and advances its last_seen", async () => {
    await registry("coordinator-a1");
    await status("coordinator-a1", "working");
    const env = buildEnvelope({
      now: () => new Date(clock.now()),
      agentId: "coordinator-a1",
      parentId: null,
      channel: "progress",
      type: "awaiting_input",
      payload: { question: "Merge now?" },
    });
    await pub.publish(`volley/${NS}/coordinator-a1/progress`, JSON.stringify(env), {
      qos: 1,
      retain: false,
    });
    await until(() => expect(coordinator()?.state).toBe("awaiting_input"));
    // volley-mcp beats every VOLLEY_HEARTBEAT_S while the coordinator waits on the owner.
    clock.sleepHost(600_000);
    await heartbeat("coordinator-a1");
    expect((await client.request("status", {})).ok).toBe(true);
    const lastBeat = new Date(clock.now()).toISOString();
    expect(coordinator()).toMatchObject({
      state: "awaiting_input",
      question: "Merge now?",
      last_seen: lastBeat,
    });
    expect(await retainedCoordinator()).toMatchObject({ state: "awaiting_input" });
  });

  it("the bound agent answers the name's decision through inbox_answer, as through resolve", async () => {
    await registry("coordinator-a1");
    await status("coordinator-a1", "working");
    await until(() => expect(coordinator()).toMatchObject({ agent_id: "coordinator-a1" }));
    const d = await daemon.openDecision(WAVE, {
      kind: "plan_change",
      task: "A",
      question: "Split A?",
      pointers: {},
    });
    const id = decisionItemId(WAVE, d.decision_id);
    const stranger = await client.request("inbox_answer", {
      id,
      version: 1,
      answer: "no",
      where: { kind: "desk", device: "phone" },
      by: "someone-else",
    });
    expect(stranger.error).toContain(`is owned by ${NAME}`);
    const answered = await client.request("inbox_answer", {
      id,
      version: 1,
      answer: "no",
      where: { kind: "desk", device: "phone" },
      by: "coordinator-a1",
    });
    expect(answered.error).toBeUndefined();
    expect(daemon.record(WAVE)?.decisions[d.decision_id]?.resolved?.answer).toBe("no");
  });

  it("a restart replaying a stale entry before the live one journals no reconnect", async () => {
    // The name was only ever bound to b2 (no reconnect journaled); a1 is an older, reaped entry
    // still retained. On restart the registry replays before the statuses, so a1 may bind first.
    await daemon.stop();
    await registry("coordinator-a1");
    await status("coordinator-a1", "reaped");
    clock.sleepHost(60_000);
    await registry("coordinator-b2");
    await status("coordinator-b2", "working");
    daemon = await t.start({ clock });
    await until(() =>
      expect(coordinator()).toMatchObject({ agent_id: "coordinator-b2", state: "working" }),
    );
    expect(reconnects()).toHaveLength(0);
  });

  it("turns away once the bound agent stays away past reconnect_grace_s", async () => {
    await registry("coordinator-a1");
    await status("coordinator-a1", "working");
    await until(() => expect(coordinator()?.state).toBe("working"));
    await status("coordinator-a1", "reaped");
    await until(() => expect(coordinator()?.state).toBe("reconnecting"));
    await clock.advance(899_000);
    expect(coordinator()?.state).toBe("reconnecting");
    await clock.advance(2_000);
    await until(() =>
      expect(coordinator()).toMatchObject({
        agent_id: "coordinator-a1",
        presence: "offline",
        state: "away",
      }),
    );
    expect(reconnects()).toHaveLength(0);
  });

  it("the will fires: reconnecting, away, gone while a decision waits, away, then online again", async () => {
    // The coordinator's MCP server, its will its retained `reaped` (SPEC §7.5).
    const mcp = new VolleyBroker();
    const reaped = buildEnvelope({
      now: () => new Date(clock.now()),
      agentId: "coordinator-a1",
      parentId: null,
      channel: "status",
      type: "reaped",
      payload: {},
    });
    await mcp.connect({
      url: t.broker.url,
      agentId: "coordinator-a1",
      willTopic: `volley/${NS}/coordinator-a1/status`,
      willPayload: JSON.stringify(reaped),
    });
    await registry("coordinator-a1");
    await status("coordinator-a1", "working");
    await until(() =>
      expect(coordinator()).toMatchObject({ presence: "online", state: "working" }),
    );
    const published: { presence: string; state: string }[] = [];
    const stop = await pub.subscribeStream(waveStateTopic(WAVE), (m) => {
      const c = (
        JSON.parse(m.payload) as { payload?: { coordinator?: { presence: string; state: string } } }
      ).payload?.coordinator;
      if (c !== undefined) published.push({ presence: c.presence, state: c.state });
    });
    try {
      mcp.simulateCrash();
      await until(() =>
        expect(published.at(-1)).toEqual({ presence: "offline", state: "reconnecting" }),
      );
      await clock.advance(901_000);
      await until(() => expect(published.at(-1)).toEqual({ presence: "offline", state: "away" }));

      // Something only the owner answers opens: gone on that publish.
      const d = await daemon.openDecision(WAVE, {
        kind: "plan_change",
        task: "A",
        question: "Split A?",
        pointers: {},
      });
      await until(() => expect(published.at(-1)).toEqual({ presence: "offline", state: "gone" }));
      const decisions = Object.values(daemon.record(WAVE)?.decisions ?? {});
      const line = formatWave(daemon.snapshot(WAVE) as WaveState, { decisions }).split("\n")[0];
      expect(line).toContain("owner: coord-main (via coordinator-a1) · gone · 1 decision waits");

      // The owner answers from another screen (the CLI, as the name).
      const resolved = await client.request("resolve", {
        wave: WAVE,
        decision_id: d.decision_id,
        answer: "no",
        by: NAME,
      });
      expect(resolved.error).toBeUndefined();
      await until(() => expect(published.at(-1)).toEqual({ presence: "offline", state: "away" }));

      // The same coordinator, a new session under the name.
      await registry("coordinator-b2");
      await status("coordinator-b2", "working");
      await until(() => expect(published.at(-1)).toEqual({ presence: "online", state: "working" }));
      await until(() => expect(reconnects()).toHaveLength(1));
    } finally {
      await stop();
    }
    // Never gone while autopilot alone answered nothing and nothing waited.
    expect(published.slice(0, 2).map((p) => p.state)).not.toContain("gone");
  });

  it("the CLI's coordinator name owns the wave; a re-submission by the bound agent is accepted", async () => {
    await registry("coordinator-a1");
    await status("coordinator-a1", "working");
    await until(() => expect(coordinator()?.agent_id).toBe("coordinator-a1"));
    const again = await client.request("run", {
      wave_yaml: `${yaml}  C: { issue: 3 }\n`,
      owner: "coordinator-a1",
    });
    expect(again.error).toBeUndefined();
    expect(daemon.snapshot(WAVE)?.owner).toBe(NAME);
  });
});

describe("a coordinator name across a daemon restart", () => {
  it("a bound agent that ended long before the restart reads offline and away at once", async () => {
    await registry("coordinator-a1");
    await status("coordinator-a1", "working");
    await until(() => expect(coordinator()?.state).toBe("working"));
    await daemon.stop();
    await status("coordinator-a1", "done");
    clock.sleepHost(3_600_000);
    daemon = await t.start({ clock });
    await until(() =>
      expect(coordinator()).toMatchObject({
        agent_id: "coordinator-a1",
        presence: "offline",
        state: "away",
      }),
    );
  });

  it("a restart with the retained reaped in place publishes offline from the replay", async () => {
    await registry("coordinator-a1");
    await status("coordinator-a1", "working");
    await until(() => expect(coordinator()?.presence).toBe("online"));
    await daemon.stop();
    await status("coordinator-a1", "reaped");
    daemon = await t.start({ clock });
    await until(() => expect(coordinator()?.agent_id).toBe("coordinator-a1"));
    expect(coordinator()?.presence).toBe("offline");
    await eventually(
      async () =>
        ((await retainedCoordinator()) as { presence?: string } | undefined)?.presence ===
        "offline",
    );
  });

  it("a terminal status replayed before its registry entry still reads gone", async () => {
    // The two replays arrive on two subscriptions, in either order: force the status first.
    const startedAt = clock.now();
    await registry("coordinator-a1");
    await status("coordinator-a1", "working");
    await until(() => expect(coordinator()?.state).toBe("working"));
    await daemon.stop();
    await status("coordinator-a1", "done");
    await pub.publish(registryTopic("coordinator-a1"), "", { qos: 1, retain: true });
    clock.sleepHost(3_600_000);
    daemon = await t.start({ clock });
    // Delivered after the replayed `done` on the same subscription: once seen, `done` was handled.
    await status("sentinel-1", "working");
    await until(() => expect(statusOf().has("sentinel-1")).toBe(true));
    // The same session's entry, replayed late: it started before its `done`.
    await registry("coordinator-a1", NAME, startedAt);
    await until(() =>
      expect(coordinator()).toMatchObject({ agent_id: "coordinator-a1", state: "away" }),
    );
  });

  it("an id registering anew after its set-aside terminal status does not take that status back", async () => {
    await daemon.stop();
    await status("coordinator-a1", "done");
    clock.sleepHost(3_600_000);
    daemon = await t.start({ clock });
    await status("sentinel-1", "working");
    await until(() => expect(statusOf().has("sentinel-1")).toBe(true));
    // A session started after the `done`: that status is not its own.
    await registry("coordinator-a1");
    await until(() => expect(namedEntries().has("coordinator-a1")).toBe(true));
    expect(statusOf().has("coordinator-a1")).toBe(false);
    expect(coordinator()?.agent_id).toBe("coordinator-a1");
    expect(coordinator()?.state).not.toMatch(/^(gone|away)$/);
  });

  it("a reconnect journals nothing in a stopped wave", async () => {
    await registry("coordinator-a1");
    await status("coordinator-a1", "working");
    await until(() => expect(coordinator()?.agent_id).toBe("coordinator-a1"));
    expect((await client.request("stop", { wave: WAVE, by: "coordinator-a1" })).ok).toBe(true);
    await until(() => expect(daemon.snapshot(WAVE)?.status).toBe("stopped"));
    await status("coordinator-a1", "reaped");
    clock.sleepHost(60_000);
    await registry("coordinator-b2");
    await until(() => expect(coordinator()?.agent_id).toBe("coordinator-b2"));
    expect(reconnects()).toHaveLength(0);
  });
});

describe("a wave owned by a plain agent id", () => {
  it("its will fired: away at once (no grace), gone while a decision waits", async () => {
    const PLAIN = "w-plain";
    const res = await client.request("run", {
      wave_yaml: yaml.replaceAll(WAVE, PLAIN),
      owner: "coordinator-p1",
    });
    expect(res.error).toBeUndefined();
    const plain = () => daemon.snapshot(PLAIN)?.coordinator;
    await status("coordinator-p1", "working");
    await until(() => expect(plain()).toMatchObject({ presence: "online", state: "working" }));
    await status("coordinator-p1", "reaped");
    await until(() => expect(plain()).toMatchObject({ presence: "offline", state: "away" }));
    await daemon.openDecision(PLAIN, {
      kind: "plan_change",
      task: "A",
      question: "Split A?",
      pointers: {},
    });
    await until(() => expect(plain()).toMatchObject({ presence: "offline", state: "gone" }));
  });
});

describe("claiming a wave by its owner's presence", () => {
  it("a coordinator name's offline binding is refused inside the grace, with when, and allowed after", async () => {
    await registry("coordinator-a1");
    await status("coordinator-a1", "working");
    await until(() => expect(coordinator()?.presence).toBe("online"));
    await status("coordinator-a1", "reaped");
    const goneAt = clock.now();
    await until(() => expect(coordinator()?.state).toBe("reconnecting"));
    await clock.advance(180_000);
    const early = await client.request("claim", { wave: WAVE, by: "someone-else" });
    expect(early.ok).toBe(false);
    expect(early.error).toBe(
      `wave '${WAVE}': wave is owned by ${NAME} (via coordinator-a1), reconnecting (gone 3m ago, grace 15m); claim allowed at ${new Date(goneAt + 900_000).toISOString()} unless it reconnects`,
    );
    await clock.advance(720_000);
    await until(() => expect(coordinator()?.state).toBe("away"));
    const later = await client.request("claim", { wave: WAVE, by: "someone-else" });
    expect(later.error).toBeUndefined();
    expect(later.result).toMatchObject({ owner: "someone-else", previous: NAME });
    expect((later.result as { why: string }).why).toBe(
      `owner ${NAME} (via coordinator-a1) offline since ${new Date(goneAt).toISOString()}`,
    );
  });

  it("a name whose new session bound meanwhile is refused as online", async () => {
    await registry("coordinator-a1");
    await status("coordinator-a1", "working");
    await until(() => expect(coordinator()?.presence).toBe("online"));
    await status("coordinator-a1", "reaped");
    await until(() => expect(coordinator()?.state).toBe("reconnecting"));
    await registry("coordinator-b2");
    await status("coordinator-b2", "registered");
    await until(() => expect(coordinator()).toMatchObject({ agent_id: "coordinator-b2" }));
    await clock.advance(3_600_000);
    const res = await client.request("claim", { wave: WAVE, by: "someone-else" });
    expect(res.error).toContain(`owned by ${NAME} (via coordinator-b2), online`);
  });

  it("a quiet connected owner is refused after 2 h", async () => {
    await registry("coordinator-a1");
    await status("coordinator-a1", "working");
    await until(() => expect(coordinator()?.presence).toBe("online"));
    await clock.advance(2 * 3_600_000);
    const res = await client.request("claim", { wave: WAVE, by: "someone-else" });
    expect(res.error).toContain(`owned by ${NAME} (via coordinator-a1), online`);
  });

  it("a plain agent-id owner whose will fired is claimable at once", async () => {
    const PLAIN = "w-plain-claim";
    const run = await client.request("run", {
      wave_yaml: yaml.replaceAll(WAVE, PLAIN),
      owner: "coordinator-p1",
    });
    expect(run.error).toBeUndefined();
    await status("coordinator-p1", "working");
    await until(() => expect(daemon.snapshot(PLAIN)?.coordinator?.presence).toBe("online"));
    await status("coordinator-p1", "reaped");
    await until(() => expect(daemon.snapshot(PLAIN)?.coordinator?.presence).toBe("offline"));
    const res = await client.request("claim", { wave: PLAIN, by: "someone-else" });
    expect(res.error).toBeUndefined();
    expect(daemon.snapshot(PLAIN)?.owner).toBe("someone-else");
  });
});
