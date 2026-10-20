import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VolleyBroker } from "volley-mcp/broker";
import type { Envelope } from "volley-mcp/envelope";
import { buildTopic } from "volley-mcp/topics";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { collect, connectClient, fixture, makeWorkdir, runHook, tick } from "./helpers/hooks";

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

const activities = (envs: Envelope[]) => envs.filter((e) => e.type === "activity");
const workLog = () => JSON.parse(readFileSync(join(dir, ".volley", "work-log.json"), "utf-8"));
const preToolUse = (overrides: Record<string, unknown> = {}) =>
  runHook("pre-tool-use", fixture("pre-tool-use-bash.json", dir, overrides), { cwd: dir });

describe("pre-tool-use activity ticks", () => {
  it("publishes an activity tick with a one-line tool summary and the tool-call count", async () => {
    const progress = await collect(client, buildTopic(NS, AGENT, "progress"));
    const run = await preToolUse({ tool_input: { command: "gh pr checks 153\necho more" } });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    await tick(150);
    expect(progress.envelopes.map((e) => e.type)).toEqual(["activity"]);
    const [a] = progress.envelopes as [Envelope];
    expect(a.channel).toBe("progress");
    expect(a.payload).toEqual({
      msg: "Bash: gh pr checks 153",
      tool_calls: 1,
      source: "harness-hook",
      seq: expect.any(Number),
      hook_event: "PreToolUse",
    });
    await progress.stop();
  });

  it("relativises file paths inside the project dir and redacts secrets", async () => {
    const progress = await collect(client, buildTopic(NS, AGENT, "progress"));
    await runHook(
      "pre-tool-use",
      fixture("pre-tool-use-bash.json", dir, {
        tool_name: "Edit",
        tool_input: { file_path: join(dir, "src", "x.ts") },
      }),
      { cwd: dir },
    );
    // A fresh window, so the next tick is not rate-limited.
    writeFileSync(join(dir, ".volley", "work-log.json"), JSON.stringify({ tool_calls: 1 }));
    await preToolUse({ tool_input: { command: "GH_TOKEN=ghp_secret123 gh pr list" } });
    await tick(150);
    const msgs = activities(progress.envelopes).map((e) => (e.payload as { msg: string }).msg);
    expect(msgs).toEqual(["Edit: src/x.ts", "Bash: GH_TOKEN=*** gh pr list"]);
    expect(JSON.stringify(progress.envelopes)).not.toContain("ghp_secret123");
    await progress.stop();
  });

  it("a tick inside the 5 s window opens no connection and is kept as pending", async () => {
    const progress = await collect(client, buildTopic(NS, AGENT, "progress"));
    await preToolUse({ tool_input: { command: "first" } });
    await tick(100);
    const before = broker.connections();
    await preToolUse({ tool_input: { command: "second" } });
    await preToolUse({ tool_input: { command: "third" } });
    await tick(150);
    expect(broker.connections()).toBe(before);
    expect(activities(progress.envelopes)).toHaveLength(1);
    expect(workLog()).toMatchObject({ tool_calls: 3, pending: "Bash: third" });
    await progress.stop();
  });

  it("counts every call made by parallel hooks", async () => {
    const runs = Array.from({ length: 8 }, (_, i) =>
      preToolUse({ tool_input: { command: `echo ${i}` } }),
    );
    for (const r of await Promise.all(runs)) expect(r.exitCode).toBe(0);
    expect(workLog().tool_calls).toBe(8);
  });
});

describe("user-prompt-submit activity tick", () => {
  it("publishes `prompt received` and never the prompt text, on any topic", async () => {
    const MARKER = "zebra-marker-7f3a";
    const all = await collect(client, "#");
    const run = await runHook(
      "user-prompt-submit",
      fixture("user-prompt-submit.json", dir, { prompt: `please ${MARKER} now` }),
      { cwd: dir },
    );
    expect(run.exitCode).toBe(0);
    await tick(200);
    const tick1 = activities(all.envelopes);
    expect(tick1).toHaveLength(1);
    expect(tick1[0]?.payload).toMatchObject({
      msg: "prompt received",
      tool_calls: 0,
      hook_event: "UserPromptSubmit",
    });
    expect(JSON.stringify(all.envelopes)).not.toContain(MARKER);
    expect(readFileSync(join(dir, ".volley", "work-log.json"), "utf-8")).not.toContain(MARKER);
    await all.stop();
  });
});

describe("stop carries tool_calls on idle", () => {
  it("adds the tool-call count to idle and clears pending", async () => {
    await preToolUse({ tool_input: { command: "one" } });
    await preToolUse({ tool_input: { command: "two" } });
    expect(workLog().pending).toBe("Bash: two");
    const progress = await collect(client, buildTopic(NS, AGENT, "progress"));
    await runHook("stop", fixture("stop.json", dir), { cwd: dir });
    await tick(150);
    const idle = progress.envelopes.find((e) => e.type === "idle");
    expect(idle?.payload).toMatchObject({ tool_calls: 2 });
    expect(workLog()).not.toHaveProperty("pending");
    await progress.stop();
  });

  it("a session with no tool calls reports tool_calls 0", async () => {
    const progress = await collect(client, buildTopic(NS, AGENT, "progress"));
    await runHook("stop", fixture("stop.json", dir), { cwd: dir });
    await tick(150);
    expect(progress.envelopes.find((e) => e.type === "idle")?.payload).toMatchObject({
      tool_calls: 0,
    });
    await progress.stop();
  });
});
