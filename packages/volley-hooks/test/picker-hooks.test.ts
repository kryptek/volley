import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { VolleyBroker } from "volley-mcp/broker";
import { buildTopic } from "volley-mcp/topics";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import {
  PACKAGE_ROOT,
  collect,
  connectClient,
  fixture,
  makeWorkdir,
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
  dir = makeWorkdir({ agent_id: AGENT, namespace: NS, broker_url: broker.url });
});

afterEach(async () => {
  await client.disconnect();
  await broker.close();
});

const TOPPINGS = [
  {
    question: "Which toppings do you want?",
    header: "Toppings",
    options: [
      { label: "Cheese", description: "melty" },
      { label: "Olives", description: "salty" },
      { label: "Peppers", description: "hot" },
    ],
    multiSelect: true,
  },
];

async function run(name: "picker-pre" | "picker-post", fixtureName: string, over = {}) {
  const progress = await collect(client, buildTopic(NS, AGENT, "progress"));
  const r = await runHook(name, fixture(fixtureName, dir, over), { cwd: dir });
  expect(r.exitCode).toBe(0);
  // Never blocks or changes the tool call: no output at all.
  expect(r.stdout).toBe("");
  await tick(150);
  await progress.stop();
  return progress.envelopes;
}

describe("AskUserQuestion picker hooks (SPEC §4.3, §4.6.18)", () => {
  it("PreToolUse publishes picker_opened with the tool_use_id and the questions verbatim", async () => {
    const envs = await run("picker-pre", "pre-tool-use-ask.json");
    expect(envs.map((e) => e.type)).toEqual(["picker_opened"]);
    expect(envs[0]?.payload).toEqual({
      tool_use_id: "toolu_01LV3L22tMmNCxfPc68am4Sn",
      questions: TOPPINGS,
      source: "harness-hook",
      seq: expect.any(Number),
      hook_event: "PreToolUse",
    });
  });

  it("PostToolUse publishes picker_answered with the answers from tool_response", async () => {
    const envs = await run("picker-post", "post-tool-use-ask.json");
    expect(envs.map((e) => e.type)).toEqual(["picker_answered"]);
    expect(envs[0]?.payload).toMatchObject({
      tool_use_id: "toolu_01LV3L22tMmNCxfPc68am4Sn",
      answers: { "Which toppings do you want?": "Cheese, Peppers" },
      hook_event: "PostToolUse",
    });
  });

  it("publishes nothing for another tool, or input without questions / answers", async () => {
    expect(await run("picker-pre", "pre-tool-use-bash.json")).toEqual([]);
    expect(await run("picker-pre", "pre-tool-use-ask.json", { tool_input: {} })).toEqual([]);
    expect(await run("picker-post", "post-tool-use-ask.json", { tool_response: {} })).toEqual([]);
  });

  it("the settings template runs them for AskUserQuestion only", () => {
    const settings = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "settings.volley-hooks.json"), "utf-8"),
    );
    const entry = (event: string, script: string) =>
      (settings.hooks[event] as { matcher?: string; hooks: { command: string }[] }[]).find((g) =>
        g.hooks.some((h) => h.command.includes(`src/hooks/${script}.ts`)),
      );
    expect(entry("PreToolUse", "picker-pre")?.matcher).toBe("AskUserQuestion");
    expect(entry("PostToolUse", "picker-post")?.matcher).toBe("AskUserQuestion");
  });
});
