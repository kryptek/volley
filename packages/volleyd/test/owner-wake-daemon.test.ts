import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { registryTopic } from "volley-mcp/topics";
import { formatWave } from "../src/commands/status";
import { ControlClient, waveStateTopic } from "../src/control";
import { ownerAsleepNoticeId } from "../src/coordinator/notices";
import type { Daemon } from "../src/daemon";
import { readJournalFile } from "../src/journal";
import { eventually, until } from "./helpers/broker-wait";
import { type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { type FakeClock, fakeClock } from "./helpers/fake-clock";
import { schemaErrors } from "./helpers/schema";

/**
 * Owner wake (SPEC §4.6.16): the owner's `background_wait` envelopes make its `coordinator` read
 * `working` with `wait`, `volleyd status` says it waits on wave events, an owner idle with nothing
 * to wake it opens `n-owner-asleep-<wave>` after `autopilot.owner_wake_grace_s`, and `run` warns
 * when the owner's session has no hooks.
 */

const WAVE = "w-ow";
const NAME = "coord-ow";
const AGENT = "coordinator-ow01";
const SESSION = "https://claude.ai/code/session_01FAKEFAKEFAKEFAKEFAKE0042";
const NOTICE = ownerAsleepNoticeId(WAVE);
const yaml = `wave: ${WAVE}
repo: /path/to/example-repo
release_branch: release/${WAVE}
model: claude-opus-5-5
pipeline: [implement, merge_ready]
tasks:
  A: { issue: 1 }
`;

let t: DaemonEnv;
let clock: FakeClock;
let daemon: Daemon;
let client: ControlClient;
let pub: VolleyBroker;

async function registry(hooks: boolean) {
  const env = buildEnvelope({
    now: () => new Date(clock.now()),
    agentId: AGENT,
    parentId: null,
    channel: "_system/registry",
    type: "registered",
    payload: {
      capabilities: [],
      cwd: "/repo",
      coordinator: NAME,
      started_at: new Date(clock.now()).toISOString(),
      ...(hooks ? { model: "claude-opus-5-5", model_source: "harness-hook" } : {}),
    },
  });
  await pub.publish(registryTopic(AGENT), JSON.stringify({ ...env, namespace: NS }), {
    qos: 1,
    retain: true,
  });
}

async function status(type: string) {
  const env = buildEnvelope({
    now: () => new Date(clock.now()),
    agentId: AGENT,
    parentId: null,
    channel: "status",
    type,
    payload: {},
  });
  await pub.publish(`volley/${NS}/${AGENT}/status`, JSON.stringify(env), { qos: 1, retain: true });
}

async function progress(type: string, payload: Record<string, unknown>) {
  const env = buildEnvelope({
    now: () => new Date(clock.now()),
    agentId: AGENT,
    parentId: null,
    channel: "progress",
    type,
    payload: { source: "harness-hook", ...payload },
  });
  await pub.publish(`volley/${NS}/${AGENT}/progress`, JSON.stringify(env), {
    qos: 1,
    retain: false,
  });
}

const coordinator = () => daemon.snapshot(WAVE)?.coordinator;
// biome-ignore lint/complexity/useLiteralKeys: dot access to a private field does not compile
const bindings = () => daemon["bindings"];
// biome-ignore lint/complexity/useLiteralKeys: dot access to a private field does not compile
const registered = () => daemon["registeredAgents"];
const system = () => readJournalFile(join(t.home, "waves", "_system", "journal.jsonl"));
const opened = () =>
  system().filter(
    (e) => e.type === "inbox_opened" && (e.data.item as { id?: string } | undefined)?.id === NOTICE,
  );
const answered = () => system().filter((e) => e.type === "inbox_answered" && e.data.id === NOTICE);

async function start(hooks: boolean): Promise<string[]> {
  await registry(hooks);
  await status("working");
  await until(() => expect(registered().has(AGENT)).toBe(true));
  await until(() => expect(bindings().get(NAME)?.agent_id).toBe(AGENT));
  const res = await client.request("run", { wave_yaml: yaml, owner: NAME });
  expect(res.error).toBeUndefined();
  return (res.warnings ?? []) as string[];
}

beforeEach(async () => {
  t = await makeDaemonEnv();
  clock = fakeClock(Date.now());
  daemon = await t.start({ clock });
  client = await ControlClient.connect(t.broker.url, NS);
  pub = new VolleyBroker();
  await pub.connect({ url: t.broker.url, agentId: "test-pub" });
});
afterEach(async () => {
  await pub.disconnect();
  await client.close();
  await t.cleanup();
});

describe("volleyd run: the owner-wake warning", () => {
  it("warns when the owner's registry entry was never re-published by the hooks", async () => {
    const warnings = await start(false);
    expect(warnings).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^owner ${NAME} \\(${AGENT}\\) has no Volley hooks in this session: nothing will wake it when ${WAVE} ends \\(the Desk and phone still get the digest\\); install `,
        ),
      ),
    );
  });

  it("says nothing when the hooks re-published it (model_source)", async () => {
    const warnings = await start(true);
    expect(warnings.filter((w) => w.includes("no Volley hooks"))).toEqual([]);
  });
});

describe("the owner's wait on the wave state and in volleyd status", () => {
  beforeEach(async () => {
    await start(true);
  });

  it("idle and idle_prompt with background_wait: working, wait owner_wake; status says waiting on wave events", async () => {
    await progress("idle", { background_wait: true, wait: "owner_wake", hook_event: "Stop" });
    await until(() =>
      expect(coordinator()).toMatchObject({ state: "working", wait: "owner_wake" }),
    );
    await progress("awaiting_input", {
      notification_type: "idle_prompt",
      background_wait: true,
      wait: "owner_wake",
      session_url: SESSION,
      hook_event: "Notification",
    });
    await progress("heartbeat", {});
    expect((await client.request("status", {})).ok).toBe(true);
    expect(coordinator()).toMatchObject({
      presence: "online",
      state: "working",
      wait: "owner_wake",
    });
    const retained = (await t.retained(waveStateTopic(WAVE))) as {
      payload: { coordinator?: Record<string, unknown> };
    };
    expect(retained.payload.coordinator).toMatchObject({ state: "working", wait: "owner_wake" });
    expect(schemaErrors("wave-state.schema.json", retained)).toEqual([]);
    const state = daemon.snapshot(WAVE);
    if (state === null) throw new Error("no state");
    expect(formatWave(state)).toContain(
      `owner: ${NAME} (via ${AGENT}) · online · waiting on wave events`,
    );

    // Working again: the wait is gone.
    await progress("resumed", { hook_event: "UserPromptSubmit" });
    await until(() => expect(coordinator()?.wait).toBeUndefined());
    expect(formatWave(daemon.snapshot(WAVE) ?? state)).toContain(`(via ${AGENT}) · online  `);
  });

  it("a background_wait without wait (older hooks) is a background_task wait", async () => {
    await progress("idle", { background_wait: true, hook_event: "Stop" });
    await until(() =>
      expect(coordinator()).toMatchObject({ state: "working", wait: "background_task" }),
    );
  });
});

describe("n-owner-asleep-<wave>", () => {
  beforeEach(async () => {
    await start(true);
  });

  const idlePrompt = () =>
    progress("awaiting_input", {
      notification_type: "idle_prompt",
      session_url: SESSION,
      hook_event: "Notification",
    });

  it("opens past owner_wake_grace_s with the command and the session link; background_wait supersedes it", async () => {
    await idlePrompt();
    await until(() => expect(coordinator()?.state).toBe("awaiting_input"));
    clock.sleepHost(60_000);
    await daemon.tick();
    expect(opened()).toHaveLength(0);
    clock.sleepHost(61_000);
    await eventually(async () => {
      await daemon.tick();
      return opened().length === 1;
    });
    const item = (await t.retained(`volley/_inbox/${NOTICE}`)) as {
      payload: {
        owner_only: boolean;
        title: string;
        question: string;
        pointers: { link?: string };
      };
    } | null;
    expect(item?.payload).toMatchObject({
      owner_only: true,
      title: `${WAVE}: your session will not be woken`,
      pointers: { link: SESSION },
    });
    expect(item?.payload.question).toContain(
      `volley sub --pattern "volley/_waves/${WAVE}/digest" --max-messages 1 --timeout 14400`,
    );
    // Further ticks open nothing more.
    clock.sleepHost(300_000);
    await daemon.tick();
    expect(opened()).toHaveLength(1);

    await progress("idle", { background_wait: true, wait: "background_task", hook_event: "Stop" });
    await eventually(async () => {
      await daemon.tick();
      return answered().length === 1;
    });
    expect(answered()[0]?.data).toMatchObject({ answer: "superseded" });
  });

  it("the owner going offline supersedes it", async () => {
    await idlePrompt();
    await until(() => expect(coordinator()?.state).toBe("awaiting_input"));
    clock.sleepHost(121_000);
    await eventually(async () => {
      await daemon.tick();
      return opened().length === 1;
    });
    await status("done");
    await eventually(async () => {
      await daemon.tick();
      return answered().length === 1;
    });
    expect(answered()[0]?.data).toMatchObject({ answer: "superseded" });
  });

  it("an idle prompt that is a question never opens it", async () => {
    await progress("awaiting_input", {
      notification_type: "idle_prompt",
      question: "Merge PR 12 now?",
      hook_event: "Notification",
    });
    await until(() => expect(coordinator()?.question).toBe("Merge PR 12 now?"));
    clock.sleepHost(600_000);
    await daemon.tick();
    expect(opened()).toHaveLength(0);
  });
});
