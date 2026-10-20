import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VolleyBroker } from "volley-mcp/broker";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import { appendBlock, markDelivered, markSuperseded } from "../src/lib/steering-file";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import {
  collect,
  connectClient,
  contextOf,
  fixture,
  makeWorkdir,
  publishEnvelope,
  publishRegistry,
  retainedEnvelope,
  runHook,
  tick,
} from "./helpers/hooks";

const AGENT = "w1-t1-implementer-1";
const NS = "ns";

let broker: TestBroker;
let client: VolleyBroker;
let dir: string;

beforeEach(async () => {
  broker = await startTestBroker();
  client = await connectClient(broker.url);
  dir = makeWorkdir({
    agent_id: AGENT,
    namespace: NS,
    parent_id: "coordinator-ab12",
    broker_url: broker.url,
  });
});

afterEach(async () => {
  await client.disconnect();
  await broker.close();
});

const sessionStart = (name: string) => runHook("session-start", fixture(name, dir), { cwd: dir });

describe("session-start", () => {
  it("publishes the harness-reported model on the retained registry entry", async () => {
    const run = await sessionStart("session-start-startup.json");
    expect(run.exitCode).toBe(0);
    const reg = await retainedEnvelope(client, registryTopic(AGENT));
    expect(reg.type).toBe("registered");
    expect(reg.channel).toBe("_system/registry");
    expect(reg.namespace).toBe(NS);
    expect(reg.parent_id).toBe("coordinator-ab12");
    expect(reg.payload).toMatchObject({
      model: "claude-opus-5-5",
      model_source: "harness-hook",
      capabilities: [],
      cwd: dir,
    });
  });

  it("keeps the last known model and marks it unknown when the input has none", async () => {
    await publishRegistry(client, AGENT, NS, {
      capabilities: ["implements-issue"],
      cwd: dir,
      model: "claude-sonnet-5-5",
      started_at: "2026-10-18T10:00:00.000Z",
    });
    await sessionStart("session-start-no-model.json");
    const reg = await retainedEnvelope(client, registryTopic(AGENT));
    expect(reg.payload).toEqual({
      capabilities: ["implements-issue"],
      cwd: dir,
      model: "claude-sonnet-5-5",
      model_source: "unknown",
      started_at: "2026-10-18T10:00:00.000Z",
    });
  });

  it("flips a spawning/registered status to working, and leaves other states alone", async () => {
    const statusTopic = buildTopic(NS, AGENT, "status");
    const setStatus = (type: string) =>
      publishEnvelope(
        client,
        statusTopic,
        { agentId: AGENT, parentId: null, channel: "status", type },
        { qos: 1, retain: true },
      );
    await setStatus("registered");
    await sessionStart("session-start-startup.json");
    expect((await retainedEnvelope(client, statusTopic)).type).toBe("working");

    await setStatus("done");
    await sessionStart("session-start-startup.json");
    expect((await retainedEnvelope(client, statusTopic)).type).toBe("done");
  });

  it("publishes working when no status is retained (a hook-only registration is never unknown)", async () => {
    const statusTopic = buildTopic(NS, AGENT, "status");
    await sessionStart("session-start-startup.json");
    const status = await retainedEnvelope(client, statusTopic);
    expect(status.type).toBe("working");
    expect(status.payload).toEqual({ source: "harness-hook" });
  });

  it("publishes a heartbeat", async () => {
    const progress = await collect(client, buildTopic(NS, AGENT, "progress"));
    await sessionStart("session-start-startup.json");
    await tick(150);
    const hb = progress.envelopes.find((e) => e.type === "heartbeat");
    expect(hb?.payload).toMatchObject({ source: "harness-hook", hook_event: "SessionStart" });
    expect(typeof (hb?.payload as { seq: unknown }).seq).toBe("number");
    await progress.stop();
  });

  it("emits no context on a plain startup", async () => {
    const run = await sessionStart("session-start-startup.json");
    expect(run.stdout).toBe("");
  });

  it.each(["session-start-compact.json", "session-start-resume.json"])(
    "%s re-injects every live, already-delivered steering directive for context only",
    async (name) => {
      const path = join(dir, ".volley", "STEERING.md");
      const base = { type: "steering", from: "coordinator-ab12", at: "2026-10-18T10:00:00.000Z" };
      appendBlock(path, { ...base, seq: 1, id: "id-1", text: "use approach A" });
      appendBlock(path, { ...base, seq: 2, id: "id-2", text: "use approach B" });
      appendBlock(path, { ...base, seq: 3, id: "id-3", text: "keep the PR small" });
      markSuperseded(path, "id-1", "id-2", "coordinator-ab12");
      markDelivered(path, ["id-1", "id-2", "id-3"]);
      const run = await sessionStart(name);
      const parsed = JSON.parse(run.stdout) as { hookSpecificOutput: { hookEventName: string } };
      expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
      const ctx = contextOf(run.stdout);
      expect(ctx).toContain("use approach B");
      expect(ctx).toContain("keep the PR small");
      expect(ctx).not.toContain("use approach A");
      expect(ctx).toContain("already delivered");
      // Already acted on: no request for a new acknowledgement.
      expect(ctx).not.toContain("steering_acked");
    },
  );

  it("never re-injects an already-delivered cancel, nudge or query", async () => {
    const path = join(dir, ".volley", "STEERING.md");
    const base = { from: "coordinator-ab12", at: "2026-10-18T10:00:00.000Z" };
    appendBlock(path, { ...base, seq: 1, type: "cancel", id: "id-1", text: "stop task one" });
    appendBlock(path, { ...base, seq: 2, type: "nudge", id: "id-2", text: "still there?" });
    appendBlock(path, { ...base, seq: 3, type: "query", id: "id-3", text: "which branch?" });
    appendBlock(path, { ...base, seq: 4, type: "steering", id: "id-4", text: "use bun" });
    markDelivered(path, ["id-1", "id-2", "id-3", "id-4"]);
    const ctx = contextOf((await sessionStart("session-start-compact.json")).stdout);
    expect(ctx).toContain("use bun");
    expect(ctx).not.toContain("stop task one");
    expect(ctx).not.toContain("CANCEL");
    expect(ctx).not.toContain("still there?");
    expect(ctx).not.toContain("which branch?");
  });

  it("a directive stored but never delivered is injected as new mail, listed once", async () => {
    const path = join(dir, ".volley", "STEERING.md");
    appendBlock(path, {
      seq: 1,
      type: "steering",
      id: "id-1",
      from: "coordinator-ab12",
      at: "2026-10-18T10:00:00.000Z",
      text: "never reached the model",
    });
    const ctx = contextOf((await sessionStart("session-start-compact.json")).stdout);
    expect(ctx?.split("never reached the model")).toHaveLength(2);
    expect(ctx).toContain("steering_acked");
  });

  it("a done directive is not re-injected", async () => {
    const path = join(dir, ".volley", "STEERING.md");
    appendBlock(path, {
      seq: 1,
      type: "steering",
      id: "id-1",
      from: "coordinator-ab12",
      at: "2026-10-18T10:00:00.000Z",
      text: "already handled",
    });
    const { readFileSync } = await import("node:fs");
    writeFileSync(path, readFileSync(path, "utf-8").replace("state=live", "state=done"));
    const run = await sessionStart("session-start-compact.json");
    expect(run.stdout).toBe("");
  });

  it("bootstraps the persistent drain session so later mail is queued", async () => {
    await sessionStart("session-start-startup.json");
    await publishEnvelope(client, `volley/${NS}/${AGENT}/mailbox`, {
      agentId: "coordinator-ab12",
      parentId: null,
      channel: "mailbox",
      type: "steering",
      payload: { text: "queued while idle", seq: 1 },
      correlationId: "5f8b8a52-3f7e-4b8e-9d0c-1a2b3c4d5e6f",
    });
    await tick(50);
    const run = await runHook("post-tool-use", fixture("post-tool-use.json", dir), { cwd: dir });
    expect(contextOf(run.stdout)).toContain("queued while idle");
  });
});

describe("post-model-switch", () => {
  it("re-publishes the registry entry with to_model", async () => {
    await publishRegistry(client, AGENT, NS, {
      capabilities: [],
      cwd: dir,
      model: "claude-haiku-5-5",
      started_at: "2026-10-18T10:00:00.000Z",
    });
    const run = await runHook("post-model-switch", fixture("post-model-switch.json", dir), {
      cwd: dir,
    });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    const reg = await retainedEnvelope(client, registryTopic(AGENT));
    expect(reg.payload).toMatchObject({
      model: "claude-sonnet-5-5",
      model_source: "harness-hook",
      started_at: "2026-10-18T10:00:00.000Z",
    });
  });
});

describe("session-start workspace_title (coordinator registry only)", () => {
  const COORD = "coordinator-ab12";
  let cdir: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    cdir = makeWorkdir();
    env = {
      VOLLEY_HOOKS_COORDINATOR: "1",
      VOLLEY_BROKER_URL: broker.url,
      VOLLEY_HOOKS_STATE_DIR: mkdtempSync(join(tmpdir(), "volley-hooks-state-")),
    };
    await publishRegistry(client, COORD, "default", {
      capabilities: [],
      cwd: cdir,
      started_at: new Date().toISOString(),
    });
  });

  const start = (extra: Record<string, string>) =>
    runHook("session-start", fixture("session-start-startup.json", cdir), {
      cwd: cdir,
      env: { ...env, ...extra },
    });

  it("takes VOLLEY_WORKSPACE_TITLE when set", async () => {
    const run = await start({ VOLLEY_WORKSPACE_TITLE: "  #169 C14 desk purpose  " });
    expect(run.exitCode).toBe(0);
    const reg = await retainedEnvelope(client, registryTopic(COORD));
    expect(reg.payload).toMatchObject({
      workspace_title: "#169 C14 desk purpose",
      model_source: "harness-hook",
    });
  });

  it("else asks cmux list-workspaces for the session's workspace title", async () => {
    const bin = join(mkdtempSync(join(tmpdir(), "volley-hooks-cmux-")), "cmux");
    const list = JSON.stringify({
      workspaces: [
        { ref: "workspace:1", id: "aaaa-1", index: 0, title: "other", selected: false },
        { ref: "workspace:2", id: "bbbb-2", index: 1, title: "issue 169 work", selected: true },
      ],
    });
    writeFileSync(
      bin,
      `#!/bin/sh
case "$1" in
  identify) echo '{"caller":{"workspace_ref":"workspace:2"}}' ;;
  list-workspaces) echo '${list}' ;;
esac
`,
    );
    chmodSync(bin, 0o755);
    await start({ CMUX_WORKSPACE_ID: "bbbb-2", CMUX_BUNDLED_CLI_PATH: bin });
    const reg = await retainedEnvelope(client, registryTopic(COORD));
    expect(reg.payload).toMatchObject({
      workspace: "workspace:2",
      workspace_title: "issue 169 work",
    });
  });

  it("with the real cmux shape, the prompt fields never reach any published message", async () => {
    const bin = join(mkdtempSync(join(tmpdir(), "volley-hooks-cmux-")), "cmux");
    const list = join(__dirname, "fixtures", "cmux-list-workspaces.json");
    writeFileSync(
      bin,
      `#!/bin/sh
case "$1" in
  identify) echo '{"caller":{"workspace_ref":"workspace:1515"}}' ;;
  list-workspaces) cat '${list}' ;;
esac
`,
    );
    chmodSync(bin, 0o755);
    const raw: string[] = [];
    const stop = await client.subscribeStream("#", (m) => {
      raw.push(String(m.payload));
    });
    const run = await start({
      CMUX_WORKSPACE_ID: "6f1c2a10-0000-4000-8000-000000000002",
      CMUX_BUNDLED_CLI_PATH: bin,
    });
    expect(run.exitCode).toBe(0);
    await tick(200);
    await stop();
    const reg = await retainedEnvelope(client, registryTopic(COORD));
    expect(reg.payload).toMatchObject({
      workspace: "workspace:1515",
      workspace_title: "Release triage",
    });
    expect(raw.length).toBeGreaterThan(0);
    for (const text of [...raw, run.stdout, JSON.stringify(reg)]) {
      expect(text).not.toMatch(/PROMPT-MARKER|CONVO-MARKER/);
      expect(text).not.toMatch(/latest_submitted|latest_conversation/);
    }
  });

  it("no title source: no workspace_title", async () => {
    await start({ VOLLEY_WORKSPACE_TITLE: "" });
    const reg = await retainedEnvelope(client, registryTopic(COORD));
    expect(reg.payload).not.toHaveProperty("workspace_title");
  });

  it("agent mode never carries workspace_title", async () => {
    await runHook("session-start", fixture("session-start-startup.json", dir), {
      cwd: dir,
      env: { VOLLEY_WORKSPACE_TITLE: "should not appear" },
    });
    const reg = await retainedEnvelope(client, registryTopic(AGENT));
    expect(reg.payload).not.toHaveProperty("workspace_title");
  });
});
