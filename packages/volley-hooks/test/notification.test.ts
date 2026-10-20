import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VolleyBroker } from "volley-mcp/broker";
import type { Envelope } from "volley-mcp/envelope";
import { buildTopic } from "volley-mcp/topics";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import {
  collect,
  connectClient,
  fixture,
  makeWorkdir,
  publishRegistry,
  runHook,
  tick,
} from "./helpers/hooks";
import { tempDir } from "./helpers/tmp";

const AGENT = "w1-t1-implementer-1";
const NS = "ns";

let broker: TestBroker;
let client: VolleyBroker;
let dir: string;

beforeEach(async () => {
  broker = await startTestBroker();
  client = await connectClient(broker.url);
  dir = makeWorkdir({ agent_id: AGENT, namespace: NS, broker_url: broker.url });
});

afterEach(async () => {
  await client.disconnect();
  await broker.close();
});

async function notify(name: string, cwd = dir, env: Record<string, string> = {}, agent = AGENT) {
  const ns = env.VOLLEY_HOOKS_COORDINATOR === "1" ? "default" : NS;
  const progress = await collect(client, buildTopic(ns, agent, "progress"));
  const run = await runHook("notification", fixture(name, cwd), { cwd, env });
  expect(run.exitCode).toBe(0);
  expect(run.stdout).toBe("");
  await tick(150);
  await progress.stop();
  return progress.envelopes;
}

const first = (envs: Envelope[]) => envs[0] as Envelope;

describe("notification", () => {
  it("agent_needs_input → awaiting_input with notification_type and text", async () => {
    const envs = await notify("notification-agent-needs-input.json");
    expect(envs.map((e) => e.type)).toEqual(["awaiting_input", "heartbeat"]);
    expect(first(envs).payload).toMatchObject({
      source: "harness-hook",
      hook_event: "Notification",
      notification_type: "agent_needs_input",
      text: "Claude needs your input: Which database should I use?",
    });
  });

  it.each([
    ["notification-idle-prompt.json", "idle_prompt"],
    ["notification-permission-prompt.json", "permission_prompt"],
  ])("%s → awaiting_input", async (name, type) => {
    const envs = await notify(name);
    expect(first(envs).type).toBe("awaiting_input");
    expect(first(envs).payload).toMatchObject({ notification_type: type });
  });

  it("agent_completed → idle with completed: true", async () => {
    const envs = await notify("notification-agent-completed.json");
    expect(first(envs).type).toBe("idle");
    expect(first(envs).payload).toMatchObject({
      completed: true,
      notification_type: "agent_completed",
    });
  });

  it("quota_auto_resume_* → awaiting_input with class credit", async () => {
    const envs = await notify("notification-quota-auto-resume-fired.json");
    expect(first(envs).type).toBe("awaiting_input");
    expect(first(envs).payload).toMatchObject({
      class: "credit",
      notification_type: "quota_auto_resume_fired",
    });
  });

  it("an unknown notification type is a heartbeat only", async () => {
    const progress = await collect(client, buildTopic(NS, AGENT, "progress"));
    await runHook(
      "notification",
      fixture("notification-idle-prompt.json", dir, { notification_type: "auth_success" }),
      { cwd: dir },
    );
    await tick(150);
    expect(progress.envelopes.map((e) => e.type)).toEqual(["heartbeat"]);
    await progress.stop();
  });

  it("a following PostToolUse publishes resumed", async () => {
    await notify("notification-agent-needs-input.json");
    const progress = await collect(client, buildTopic(NS, AGENT, "progress"));
    await runHook("post-tool-use", fixture("post-tool-use.json", dir), { cwd: dir });
    await tick(150);
    expect(progress.envelopes.map((e) => e.type)).toEqual(["resumed", "heartbeat"]);
    await progress.stop();
  });

  it("coordinator: idle_prompt after a questioning Stop carries that question", async () => {
    const coordDir = makeWorkdir();
    const env = {
      VOLLEY_HOOKS_COORDINATOR: "1",
      VOLLEY_BROKER_URL: broker.url,
      VOLLEY_HOOKS_STATE_DIR: tempDir("volley-hooks-state-"),
      VOLLEY_SESSION_URL: "https://claude.ai/code/session_0123",
      VOLLEY_WORKSPACE: "workspace:7",
    };
    await publishRegistry(client, "coordinator-ab12", "default", {
      capabilities: [],
      cwd: coordDir,
      started_at: "2026-10-18T10:00:00.000Z",
    });
    await runHook("stop", fixture("stop-question.json", coordDir), { cwd: coordDir, env });
    const envs = await notify("notification-idle-prompt.json", coordDir, env, "coordinator-ab12");
    expect(first(envs).type).toBe("awaiting_input");
    expect(first(envs).payload).toMatchObject({
      notification_type: "idle_prompt",
      text: "Claude is waiting for your input",
      question: "Should I merge PR 12 now?\nIt has two approvals.\nOr should I wait for CI?",
      session_url: "https://claude.ai/code/session_0123",
      workspace: "workspace:7",
    });
  });

  describe("coordinator after a Stop with a background wait armed", () => {
    let coordDir: string;
    let env: Record<string, string>;
    beforeEach(async () => {
      coordDir = makeWorkdir();
      env = {
        VOLLEY_HOOKS_COORDINATOR: "1",
        VOLLEY_BROKER_URL: broker.url,
        VOLLEY_HOOKS_STATE_DIR: tempDir("volley-hooks-state-"),
      };
      await publishRegistry(client, "coordinator-ab12", "default", {
        capabilities: [],
        cwd: coordDir,
        started_at: "2026-10-18T10:00:00.000Z",
      });
      await runHook("stop", fixture("stop-background-tasks.json", coordDir), {
        cwd: coordDir,
        env,
      });
    });

    it("idle_prompt → awaiting_input with background_wait: true", async () => {
      const envs = await notify("notification-idle-prompt.json", coordDir, env, "coordinator-ab12");
      expect(first(envs).type).toBe("awaiting_input");
      expect(first(envs).payload).toMatchObject({
        notification_type: "idle_prompt",
        background_wait: true,
      });
    });

    it("a permission_prompt never carries it", async () => {
      const envs = await notify(
        "notification-permission-prompt.json",
        coordDir,
        env,
        "coordinator-ab12",
      );
      expect(first(envs).type).toBe("awaiting_input");
      expect(first(envs).payload).not.toHaveProperty("background_wait");
    });

    it("after a Stop that ended in a question the idle_prompt is that question, without background_wait", async () => {
      await runHook(
        "stop",
        fixture("stop-background-tasks.json", coordDir, {
          last_assistant_message: "Both reviewers passed.\n\nShould I merge PR 12?",
        }),
        { cwd: coordDir, env },
      );
      const envs = await notify("notification-idle-prompt.json", coordDir, env, "coordinator-ab12");
      expect(first(envs).payload).toMatchObject({ question: "Should I merge PR 12?" });
      expect(first(envs).payload).not.toHaveProperty("background_wait");
    });

    it("once the session works again the wait is gone", async () => {
      await runHook("post-tool-use", fixture("post-tool-use.json", coordDir), {
        cwd: coordDir,
        env,
      });
      const envs = await notify("notification-idle-prompt.json", coordDir, env, "coordinator-ab12");
      expect(first(envs).payload).not.toHaveProperty("background_wait");
    });
  });

  it("coordinator: agent_needs_input without a prior question uses the message", async () => {
    const coordDir = makeWorkdir();
    const env = {
      VOLLEY_HOOKS_COORDINATOR: "1",
      VOLLEY_BROKER_URL: broker.url,
      VOLLEY_HOOKS_STATE_DIR: tempDir("volley-hooks-state-"),
    };
    await publishRegistry(client, "coordinator-ab12", "default", {
      capabilities: [],
      cwd: coordDir,
      started_at: "2026-10-18T10:00:00.000Z",
    });
    const envs = await notify(
      "notification-agent-needs-input.json",
      coordDir,
      env,
      "coordinator-ab12",
    );
    expect(first(envs).payload).toMatchObject({
      question: "Claude needs your input: Which database should I use?",
    });
    expect(first(envs).payload).not.toHaveProperty("session_url");
  });
});
