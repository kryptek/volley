import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { buildEnvelope } from "volley-mcp/envelope";
import { buildTopic } from "volley-mcp/topics";
import { type InboxItem, handoffItemId, inboxTopic } from "../src/autopilot/inbox";
import { ControlClient } from "../src/control";
import { NS } from "./helpers/daemon-env";
import { schemaErrors } from "./helpers/schema";
import { type SupervisedEnv, makeSupervisedEnv } from "./helpers/supervised-env";

let s: SupervisedEnv;
let client: ControlClient | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
  await s.cleanup();
});

const SCREENS = new URL("./fixtures/screens/", import.meta.url).pathname;
const screen = (name: string) => readFileSync(`${SCREENS}${name}.txt`, "utf-8");

/** An interactive coordinator session (not supervised by volleyd) beside the wave. */
const COORD = "coord-1";
const QUESTION = "T1 is merged. Shall I dispatch T2 now, or hold until CI on main is green?";
const phone = { kind: "desk", device: "phone" };

/** What the coordinator session's hooks publish on its progress channel. */
const coord = (type: string, seq: number, hookEvent: string, payload: Record<string, unknown>) =>
  s.agent.publish(
    buildTopic(NS, COORD, "progress"),
    JSON.stringify(
      buildEnvelope({
        agentId: COORD,
        parentId: null,
        channel: "progress",
        type,
        payload: { ...payload, source: "harness-hook", seq, hook_event: hookEvent },
      }),
    ),
    { qos: 1, retain: false },
  );

/** The Stop hook: a turn that ended on a question. */
async function handoff(seq = 12, workspace: string | null = "workspace:7"): Promise<InboxItem> {
  await coord("awaiting_input", seq, "Stop", {
    question: QUESTION,
    ...(workspace !== null ? { workspace } : {}),
  });
  const id = handoffItemId(COORD, seq);
  await s.until(() => s.daemon.inboxItem(id) !== undefined);
  return s.daemon.inboxItem(id) as InboxItem;
}

/** The UserPromptSubmit hook's `prompt received` activity tick. */
const promptReceived = (seq = 13) =>
  coord("activity", seq, "UserPromptSubmit", { msg: "prompt received", tool_calls: 4 });

async function answer(id: string, text: string) {
  client ??= await ControlClient.connect(s.env.broker.url, NS);
  return client.request("inbox_answer", {
    id,
    version: 1,
    answer: text,
    where: phone,
    by: "owner",
  });
}

describe("needs-you inbox: coordinator handoffs (SPEC §4.6.18)", () => {
  it("a coordinator turn ending on a question opens h-<agent_id>-<seq>", async () => {
    s = await makeSupervisedEnv();
    const item = await handoff();
    expect(item).toMatchObject({
      id: "h-coord-1-12",
      kind: "handoff",
      version: 1,
      owner_only: true,
      agent_id: COORD,
      title: "Handoff · coord-1",
      question: QUESTION,
      allow_other: true,
      source: { seq: 12, workspace: "workspace:7" },
    });
    const env = await s.env.retained(inboxTopic(item.id));
    expect(schemaErrors("inbox-item.schema.json", env)).toEqual([]);
  });

  it("an answer is typed into the idle prompt with the item's token, then submitted", async () => {
    s = await makeSupervisedEnv();
    const item = await handoff();
    s.host.screens = [screen("picker-gone")];
    const r = await answer(item.id, "dispatch T2 now");
    expect(r.error).toBeUndefined();
    expect(s.host.texts).toEqual([{ workspace: "workspace:7", text: "dispatch T2 now" }]);
    expect(s.host.keys).toEqual([{ workspace: "workspace:7", key: "Enter" }]);
    expect(s.daemon.inboxItem(item.id)?.answered).toMatchObject({
      answer: "dispatch T2 now",
      where: phone,
    });
    // The prompt it submitted confirms the inbox answer: nothing is answered twice.
    await promptReceived();
    await s.consumed();
    expect(s.daemon.inboxItem(item.id)?.answered?.where).toEqual(phone);
  });

  it("refuses `prompt not idle` while the session works; the item stays open", async () => {
    s = await makeSupervisedEnv();
    const item = await handoff();
    s.host.screens = [screen("claude-session")];
    expect(await answer(item.id, "go")).toMatchObject({ ok: false, error: "prompt not idle" });
    expect(s.host.texts).toEqual([]);
    expect(s.daemon.inboxItem(item.id)?.answered).toBeUndefined();
  });

  it("refuses a reply that would be a command in the prompt", async () => {
    s = await makeSupervisedEnv();
    const item = await handoff();
    s.host.screens = [screen("picker-gone")];
    const r = await answer(item.id, "!git push");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/slash command or shell line/);
    expect(s.host.texts).toEqual([]);
  });

  it("the next prompt typed in the terminal closes it with where: terminal", async () => {
    s = await makeSupervisedEnv();
    const item = await handoff();
    await promptReceived();
    await s.until(() => s.daemon.inboxItem(item.id)?.answered !== undefined);
    expect(s.daemon.inboxItem(item.id)?.answered).toMatchObject({
      answer: "answered in its terminal",
      by: COORD,
      where: { kind: "terminal" },
    });
  });

  it("without a workspace volleyd cannot type the reply: answered in its terminal", async () => {
    s = await makeSupervisedEnv();
    const item = await handoff(20, null);
    expect(await answer(item.id, "go")).toMatchObject({
      ok: false,
      error: "volleyd cannot see this session's screen: answer it in its terminal",
    });
  });
});
