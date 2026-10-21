import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { buildEnvelope } from "volley-mcp/envelope";
import { buildTopic, registryTopic } from "volley-mcp/topics";
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

  it("Other: a slash command or second line refuses in plain words before any key", async () => {
    s = await makeSupervisedEnv();
    const item = await opened("toolu_01Fruit", [FRUIT]);
    s.host.screens = [screen("picker-single")];
    expect(await answer(item.id, "/clear")).toMatchObject({
      ok: false,
      error: "an Other answer must be one line of plain text, not a slash command or shell line",
    });
    expect(s.host.keys).toEqual([]);
    expect(s.host.texts).toEqual([]);
    expect(s.daemon.inboxItem(item.id)?.answered).toBeUndefined();
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

  it("multi-select: no review screen after Submit refuses the answer; the hook then closes it in the terminal", async () => {
    s = await makeSupervisedEnv();
    const item = await opened("toolu_01Top", [TOPPINGS]);
    s.host.screens = [screen("picker-multi"), screen("picker-gone")];
    const r = await answer(item.id, "Cheese");
    expect(r).toMatchObject({
      ok: false,
      error:
        "could not carry out the answer: the picker's review screen did not appear after Submit; the toggles and Submit were pressed, so finish it in its terminal",
    });
    // Submit was pressed: nothing is recorded from the Desk, the item stays open for the hook.
    expect(s.host.keys.at(-1)?.key).toBe("Enter");
    expect(s.daemon.inboxItem(item.id)?.answered).toBeUndefined();
    await hook("picker_answered", {
      tool_use_id: "toolu_01Top",
      answers: { "Which toppings do you want?": "Cheese" },
    });
    await s.event((e) => e.type === "inbox_answered");
    expect(s.daemon.inboxItem(item.id)?.answered).toMatchObject({
      by: AGENT,
      where: { kind: "terminal" },
    });
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

  it("a Notification's idle (agent_completed: a background subagent finished) leaves the picker open", async () => {
    s = await makeSupervisedEnv();
    const item = await opened("toolu_01Fruit", [FRUIT]);
    await s.pub(
      buildTopic(NS, AGENT, "progress"),
      "idle",
      "progress",
      { completed: true, source: "harness-hook", seq: ++seq, hook_event: "Notification" },
      false,
    );
    await s.consumed();
    expect(s.daemon.inboxItem(item.id)?.answered).toBeUndefined();
  });

  it("picker_answered arriving while a Desk answer is being carried: one inbox_answered, on the Desk", async () => {
    s = await makeSupervisedEnv();
    const item = await opened("toolu_01Fruit", [FRUIT]);
    s.host.screens = [screen("picker-single")];
    const send = s.host.sendKeys.bind(s.host);
    let raced = false;
    s.host.sendKeys = async (workspace, key, tokens) => {
      if (!raced) {
        raced = true;
        // The PostToolUse hook fires as soon as the pick lands, before the carry returns.
        await hook("picker_answered", {
          tool_use_id: "toolu_01Fruit",
          answers: { "Which fruit do you want?": "Banana" },
        });
        // broker round-trip: the hook's delivery reaches the daemon while the carry is in flight.
        await new Promise((r) => setTimeout(r, 50));
      }
      return send(workspace, key, tokens);
    };
    const r = await answer(item.id, "Banana");
    expect(r.error).toBeUndefined();
    await s.consumed();
    expect(s.daemon.inboxItem(item.id)?.answered).toMatchObject({ by: "owner", where: phone });
    expect(s.journal().filter((e) => e.type === "inbox_answered")).toHaveLength(1);
  });

  it("a terminal pick that differs from the inbox answer it confirms is logged", async () => {
    const logs: string[] = [];
    s = await makeSupervisedEnv({ daemon: { log: (m: string) => logs.push(m) } });
    const item = await opened("toolu_01Fruit", [FRUIT]);
    s.host.screens = [screen("picker-single")];
    expect((await answer(item.id, "Banana")).error).toBeUndefined();
    await hook("picker_answered", {
      tool_use_id: "toolu_01Fruit",
      answers: { "Which fruit do you want?": "Cherry" },
    });
    await s.until(() => logs.some((l) => l.includes("its terminal reports 'Cherry'")));
    expect(s.daemon.inboxItem(item.id)?.answered).toMatchObject({ answer: "Banana", where: phone });
  });

  it("a wave agent's picker is not owner_only, but only the wave's owner (or its bound session) steers it", async () => {
    s = await makeSupervisedEnv({ owner: "boss" });
    const item = await opened("toolu_01Fruit", [FRUIT]);
    expect(item.owner_only).toBe(false);
    s.host.screens = [screen("picker-single")];
    client ??= await ControlClient.connect(s.env.broker.url, NS);
    const as = (by: string) =>
      client?.request("inbox_answer", {
        id: item.id,
        version: 1,
        answer: "Banana",
        where: phone,
        by,
      });
    const r = await as("a-teammate");
    expect(r?.ok).toBe(false);
    expect(r?.error).toContain(
      "wave 'w1' is owned by boss; 'inbox_answer' as a-teammate is refused",
    );
    expect(s.host.keys).toEqual([]);
    // The session bound to the owner's coordinator name acts as the owner.
    await s.agent.publish(
      registryTopic("boss-session"),
      JSON.stringify({
        ...buildEnvelope({
          agentId: "boss-session",
          parentId: null,
          channel: "_system/registry",
          type: "registered",
          payload: { cwd: "/repo", started_at: new Date().toISOString(), coordinator: "boss" },
        }),
        namespace: NS,
      }),
      { qos: 1, retain: true },
    );
    await s.until(() => s.daemon.bindingOf("boss") === "boss-session");
    const bound = await as("boss-session");
    expect(bound?.error).toBeUndefined();
  });

  it("the wave's owner by name answers its agent's picker", async () => {
    s = await makeSupervisedEnv({ owner: "boss" });
    const item = await opened("toolu_01Fruit", [FRUIT]);
    s.host.screens = [screen("picker-single")];
    client ??= await ControlClient.connect(s.env.broker.url, NS);
    const r = await client.request("inbox_answer", {
      id: item.id,
      version: 1,
      answer: "Banana",
      where: phone,
      by: "boss",
    });
    expect(r.error).toBeUndefined();
  });
});
