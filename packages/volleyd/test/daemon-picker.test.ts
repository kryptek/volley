import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { buildTopic } from "volley-mcp/topics";
import { type InboxItem, inboxTopic, pickerItemId } from "../src/autopilot/inbox";
import { ControlClient } from "../src/control";
import { NS } from "./helpers/daemon-env";
import { schemaErrors } from "./helpers/schema";
import { AGENT, type SupervisedEnv, makeSupervisedEnv } from "./helpers/supervised-env";

let s: SupervisedEnv;
let client: ControlClient | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
  await s.cleanup();
});

const SCREENS = new URL("./fixtures/screens/", import.meta.url).pathname;
const screen = (name: string) => readFileSync(`${SCREENS}${name}.txt`, "utf-8");

const FRUIT = {
  question: "Which fruit do you want?",
  header: "Fruit",
  options: [
    { label: "Apple", description: "red" },
    { label: "Banana", description: "yellow" },
    { label: "Cherry", description: "small" },
  ],
  multiSelect: false,
};
const TOPPINGS = {
  question: "Which toppings do you want?",
  header: "Toppings",
  options: [
    { label: "Cheese", description: "melty" },
    { label: "Olives", description: "salty" },
    { label: "Peppers", description: "hot" },
  ],
  multiSelect: true,
};

const phone = { kind: "desk", device: "phone" };
let seq = 100;

/** The PreToolUse / PostToolUse picker hooks, as the agent's session publishes them. */
const hook = (type: string, payload: Record<string, unknown>) =>
  s.pub(
    buildTopic(NS, AGENT, "progress"),
    type,
    "progress",
    { ...payload, source: "harness-hook", seq: ++seq, hook_event: "PreToolUse" },
    false,
  );

const retained = async (id: string) =>
  (await s.env.retained(inboxTopic(id))) as { type: string; payload: InboxItem } | null;

async function opened(toolUseId: string, questions: unknown[]): Promise<InboxItem> {
  await hook("picker_opened", { tool_use_id: toolUseId, questions });
  const id = pickerItemId(AGENT, toolUseId);
  await s.event((e) => e.type === "inbox_opened" && (e.data.item as InboxItem).id === id);
  return s.daemon.inboxItem(id) as InboxItem;
}

async function answer(id: string, text: string, version = 1) {
  client ??= await ControlClient.connect(s.env.broker.url, NS);
  return client.request("inbox_answer", { id, version, answer: text, where: phone, by: "owner" });
}

describe("needs-you inbox: Claude pickers (SPEC §4.6.18)", () => {
  it("picker_opened from a supervised agent opens p-<agent_id>-<tool_use_id> with the exact question and options", async () => {
    s = await makeSupervisedEnv();
    const item = await opened("toolu_01Fruit", [FRUIT]);
    expect(item).toMatchObject({
      id: `p-${AGENT}-toolu_01Fruit`,
      kind: "picker",
      version: 1,
      owner_only: false,
      wave: "w1",
      task: "T1",
      agent_id: AGENT,
      title: "Fruit · w1/T1",
      question: "Which fruit do you want?",
      options: FRUIT.options,
      allow_other: true,
      multi: false,
      source: { tool_use_id: "toolu_01Fruit", questions: [FRUIT], workspace: "workspace:1" },
    });
    const env = await retained(item.id);
    expect(env?.type).toBe("inbox_item");
    expect(schemaErrors("inbox-item.schema.json", env)).toEqual([]);
  });

  it("a Desk answer reads the screen, confirms the picker, and selects by keystroke", async () => {
    s = await makeSupervisedEnv();
    const item = await opened("toolu_01Fruit", [FRUIT]);
    s.host.screens = [screen("picker-single")];
    const r = await answer(item.id, "Banana");
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(s.host.keys).toEqual([
      { workspace: "workspace:1", key: "Down" },
      { workspace: "workspace:1", key: "Enter" },
    ]);
    expect(s.daemon.inboxItem(item.id)?.answered).toMatchObject({
      answer: "Banana",
      by: "owner",
      where: phone,
    });
    // The PostToolUse hook then reports the pick: it confirms, it does not answer again.
    await hook("picker_answered", {
      tool_use_id: "toolu_01Fruit",
      answers: { "Which fruit do you want?": "Banana" },
    });
    await s.consumed();
    expect(s.daemon.inboxItem(item.id)?.answered?.where).toEqual(phone);
    expect(s.journal().filter((e) => e.type === "inbox_answered")).toHaveLength(1);
  });

  it("Other: the free-text row, the text typed with the item's token, Enter", async () => {
    s = await makeSupervisedEnv();
    const item = await opened("toolu_01Fruit", [FRUIT]);
    s.host.screens = [screen("picker-single")];
    expect((await answer(item.id, "durian")).ok).toBe(true);
    expect(s.host.keys.map((k) => k.key)).toEqual(["Down", "Down", "Down", "Enter"]);
    expect(s.host.texts).toEqual([{ workspace: "workspace:1", text: "durian" }]);
  });

  it("multi-select: Space per label, Submit, then Enter on the review screen", async () => {
    s = await makeSupervisedEnv();
    const item = await opened("toolu_01Top", [TOPPINGS]);
    expect(item.multi).toBe(true);
    s.host.screens = [screen("picker-multi"), screen("picker-review")];
    const r = await answer(item.id, "Cheese, Peppers");
    expect(r.error).toBeUndefined();
    expect(s.host.keys.map((k) => k.key)).toEqual([
      "Space",
      "Down",
      "Down",
      "Space",
      "Down",
      "Down",
      "Enter",
      "Enter",
    ]);
  });

  it("a screen without that picker refuses `picker not on screen`; the item stays open; the hook closes it", async () => {
    s = await makeSupervisedEnv();
    const item = await opened("toolu_01Fruit", [FRUIT]);
    s.host.screens = [screen("picker-gone")];
    const r = await answer(item.id, "Banana");
    expect(r).toMatchObject({ ok: false, error: "picker not on screen" });
    expect(s.host.keys).toEqual([]);
    expect(s.daemon.inboxItem(item.id)).toMatchObject({ version: 1 });
    expect(s.daemon.inboxItem(item.id)?.answered).toBeUndefined();

    await hook("picker_answered", {
      tool_use_id: "toolu_01Fruit",
      answers: { "Which fruit do you want?": "Cherry" },
    });
    await s.event((e) => e.type === "inbox_answered");
    await s.consumed();
    const closed = s.daemon.inboxItem(item.id);
    expect(closed?.answered).toMatchObject({ answer: "Cherry", by: AGENT });
    expect(closed?.answered?.where.kind).toBe("terminal");
    expect(closed?.answered?.where.machine).toEqual(expect.any(String));
    const env = await retained(item.id);
    expect(env?.type).toBe("inbox_answered");
    expect(schemaErrors("inbox-item.schema.json", env)).toEqual([]);
  });

  it("another picker on screen (a different question) is not this one", async () => {
    s = await makeSupervisedEnv();
    const item = await opened("toolu_01Top", [TOPPINGS]);
    s.host.screens = [screen("picker-single")];
    expect(await answer(item.id, "Cheese")).toMatchObject({
      ok: false,
      error: "picker not on screen",
    });
  });

  it("a picker with several questions opens one item, answered in its terminal", async () => {
    s = await makeSupervisedEnv();
    const item = await opened("toolu_01Two", [FRUIT, TOPPINGS]);
    expect(item.title).toBe("2 questions · w1/T1");
    expect(item.options).toBeUndefined();
    expect(item.question).toBe("Which fruit do you want?\nWhich toppings do you want?");
    expect(await answer(item.id, "Banana")).toMatchObject({
      ok: false,
      error: "a picker with 2 questions: answer it in its terminal",
    });
    await hook("picker_answered", {
      tool_use_id: "toolu_01Two",
      answers: { "Which fruit do you want?": "Apple", "Which toppings do you want?": "Olives" },
    });
    await s.event((e) => e.type === "inbox_answered");
    expect(s.daemon.inboxItem(item.id)?.answered?.answer).toBe(
      "Which fruit do you want? → Apple\nWhich toppings do you want? → Olives",
    );
  });

  it("a turn that ends with the picker still open (dismissed with Esc) closes it", async () => {
    s = await makeSupervisedEnv();
    const item = await opened("toolu_01Fruit", [FRUIT]);
    await s.hook("idle-stop.json");
    await s.event((e) => e.type === "inbox_answered");
    expect(s.daemon.inboxItem(item.id)?.answered).toMatchObject({
      answer: "dismissed in its terminal",
      where: { kind: "terminal" },
    });
  });
});
