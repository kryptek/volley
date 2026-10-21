import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** The work-log lines: `activity` ticks carrying a `msg` (a boundary alone carries none). */
const activities = (envs: Envelope[]) =>
  envs.filter((e) => e.type === "activity" && "msg" in (e.payload as object));
const boundaries = (envs: Envelope[]) =>
  envs.filter((e) => e.type === "activity").map((e) => e.payload as Record<string, unknown>);
/** The session the other fixtures (post-tool-use, stop, user-prompt-submit) were recorded in. */
const SESSION = "7c984d76-0e0e-40d5-b9f1-777e9c0e6caa";
const workLogFile = () => JSON.parse(readFileSync(join(dir, ".volley", "work-log.json"), "utf-8"));
/** `SESSION`'s entry in the work log. */
const workLog = () => workLogFile().sessions[SESSION];
const preToolUse = (overrides: Record<string, unknown> = {}) =>
  runHook(
    "pre-tool-use",
    fixture("pre-tool-use-bash.json", dir, { session_id: SESSION, ...overrides }),
    { cwd: dir },
  );
const postToolUse = () =>
  runHook("post-tool-use", fixture("post-tool-use.json", dir), { cwd: dir });
/** Move the work log's window back, as if `ms` had passed since its last publish. */
function ageWindow(ms: number): void {
  const file = workLogFile();
  file.sessions[SESSION].last_published_at -= ms;
  writeFileSync(join(dir, ".volley", "work-log.json"), JSON.stringify(file));
}
/** Hold `<stateDir>/<name>` as a live hook would (fresh mtime), so `withLock` times out. */
function holdLock(name: string): void {
  mkdirSync(join(dir, ".volley"), { recursive: true });
  writeFileSync(join(dir, ".volley", name), "4242.held-by-a-dead-hook");
}

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
      tool_use_id: "toolu_01ABCDEF",
      tool: "Bash",
    });
    await progress.stop();
  });

  it("every call publishes its tool boundary, even inside the 5 s window; PostToolUse ends it", async () => {
    const progress = await collect(client, buildTopic(NS, AGENT, "progress"));
    await preToolUse({ tool_use_id: "toolu_A", tool_input: { command: "first" } });
    await tick(1000);
    await preToolUse({ tool_use_id: "toolu_B", tool_input: { command: "bun run test" } });
    await runHook(
      "post-tool-use",
      fixture("post-tool-use.json", dir, { tool_use_id: "toolu_B", tool_name: "Bash" }),
      { cwd: dir },
    );
    await tick(150);
    expect(boundaries(progress.envelopes)).toEqual([
      expect.objectContaining({ hook_event: "PreToolUse", tool_use_id: "toolu_A", tool: "Bash" }),
      expect.objectContaining({ hook_event: "PreToolUse", tool_use_id: "toolu_B", tool: "Bash" }),
    ]);
    // The second is inside the window: the boundary alone, its line held back.
    expect(boundaries(progress.envelopes)[1]).not.toHaveProperty("msg");
    expect(progress.envelopes.find((e) => e.type === "heartbeat")?.payload).toMatchObject({
      hook_event: "PostToolUse",
      tool_use_id: "toolu_B",
      tool: "Bash",
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

  it("a tick inside the 5 s window publishes no line and is kept as pending", async () => {
    const progress = await collect(client, buildTopic(NS, AGENT, "progress"));
    await preToolUse({ tool_input: { command: "first" } });
    await preToolUse({ tool_input: { command: "second" } });
    await preToolUse({ tool_input: { command: "third" } });
    await tick(150);
    expect(activities(progress.envelopes)).toHaveLength(1);
    expect(boundaries(progress.envelopes)).toHaveLength(3);
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

describe("tool_calls is per Claude Code session", () => {
  it("a new session_id in the same state dir starts its own count", async () => {
    for (const c of ["a1", "a2", "a3"]) {
      await preToolUse({ session_id: "session-a", tool_input: { command: c } });
    }
    expect(workLogFile().sessions["session-a"]).toMatchObject({ tool_calls: 3 });
    const progress = await collect(client, buildTopic(NS, AGENT, "progress"));
    await preToolUse({ session_id: "session-b", tool_input: { command: "b1" } });
    await tick(150);
    // Session B's first tick publishes (its own window) and counts only its own call.
    expect(activities(progress.envelopes).map((e) => e.payload)).toEqual([
      expect.objectContaining({ msg: "Bash: b1", tool_calls: 1 }),
    ]);
    // A's count is untouched: both sessions may still be running.
    expect(workLogFile().sessions["session-a"]).toMatchObject({ tool_calls: 3 });
    await progress.stop();
  });

  it("the same session keeps counting (compact / resume keep the session_id)", async () => {
    await preToolUse({ tool_input: { command: "one" } });
    await preToolUse({ tool_input: { command: "two" } });
    ageWindow(10_000);
    const progress = await collect(client, buildTopic(NS, AGENT, "progress"));
    await preToolUse({ tool_input: { command: "three" } });
    await tick(150);
    expect(activities(progress.envelopes)[0]?.payload).toMatchObject({
      msg: "Bash: three",
      tool_calls: 3,
    });
    await progress.stop();
  });
});

describe("a coalesced tick is published at the next slot", () => {
  it("PostToolUse after the window publishes the burst's newest line with the current count", async () => {
    const progress = await collect(client, buildTopic(NS, AGENT, "progress"));
    await preToolUse({ tool_input: { command: "first" } });
    await preToolUse({ tool_input: { command: "second" } });
    await preToolUse({ tool_input: { command: "third" } });
    expect(workLog()).toMatchObject({ pending: "Bash: third" });
    ageWindow(10_000);
    const run = await postToolUse();
    expect(run.exitCode).toBe(0);
    await tick(150);
    expect(activities(progress.envelopes).map((e) => e.payload)).toEqual([
      expect.objectContaining({ msg: "Bash: first", tool_calls: 1, hook_event: "PreToolUse" }),
      expect.objectContaining({ msg: "Bash: third", tool_calls: 3, hook_event: "PostToolUse" }),
    ]);
    expect(workLog()).not.toHaveProperty("pending");
    await progress.stop();
  });

  it("PostToolUse inside the window publishes nothing and keeps the pending line", async () => {
    const progress = await collect(client, buildTopic(NS, AGENT, "progress"));
    await preToolUse({ tool_input: { command: "first" } });
    await preToolUse({ tool_input: { command: "second" } });
    await postToolUse();
    await tick(150);
    expect(activities(progress.envelopes)).toHaveLength(1);
    expect(workLog()).toMatchObject({ pending: "Bash: second" });
    await progress.stop();
  });
});

describe("a work-log failure is cosmetic: it never changes a hook's other output", () => {
  it("pre-tool-use with work-log.lock held: exit 0, empty output, the boundary but no line", async () => {
    holdLock("work-log.lock");
    const progress = await collect(client, buildTopic(NS, AGENT, "progress"));
    const run = await preToolUse();
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe("");
    await tick(100);
    expect(activities(progress.envelopes)).toHaveLength(0);
    expect(boundaries(progress.envelopes)).toEqual([
      expect.objectContaining({ tool_use_id: "toolu_01ABCDEF" }),
    ]);
    await progress.stop();
  });

  it("post-tool-use with work-log.lock held still heartbeats", async () => {
    await preToolUse({ tool_input: { command: "one" } });
    await preToolUse({ tool_input: { command: "two" } });
    ageWindow(10_000);
    holdLock("work-log.lock");
    const progress = await collect(client, buildTopic(NS, AGENT, "progress"));
    const run = await postToolUse();
    expect(run.exitCode).toBe(0);
    await tick(150);
    expect(progress.envelopes.map((e) => e.type)).toContain("heartbeat");
    await progress.stop();
  });

  it("stop with work-log.lock held still publishes idle with the count", async () => {
    await preToolUse({ tool_input: { command: "one" } });
    holdLock("work-log.lock");
    const progress = await collect(client, buildTopic(NS, AGENT, "progress"));
    const run = await runHook("stop", fixture("stop.json", dir), { cwd: dir });
    expect(run.exitCode).toBe(0);
    await tick(150);
    expect(progress.envelopes.find((e) => e.type === "idle")?.payload).toMatchObject({
      tool_calls: 1,
    });
    await progress.stop();
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
