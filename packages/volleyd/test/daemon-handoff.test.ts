import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { buildEnvelope } from "volley-mcp/envelope";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import { type InboxItem, handoffItemId, inboxTopic, pickerItemId } from "../src/autopilot/inbox";
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
/** coord-1's idle prompt, its turn's last message the question it asked. */
const asked = () => screen("picker-gone").replace("● You picked Banana.", `● ${QUESTION}`);

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

/** An answer from the Desk; a coordinator's own handoff is the owner's: `by` the session. */
async function answer(id: string, text: string, by = COORD) {
  client ??= await ControlClient.connect(s.env.broker.url, NS);
  return client.request("inbox_answer", { id, version: 1, answer: text, where: phone, by });
}

/** coord-1's registry entry, carrying the coordinator name `name` (VOLLEY_COORDINATOR). */
const registered = (name: string) =>
  s.agent.publish(
    registryTopic(COORD),
    JSON.stringify({
      ...buildEnvelope({
        agentId: COORD,
        parentId: null,
        channel: "_system/registry",
        type: "registered",
        payload: { cwd: "/repo", started_at: new Date().toISOString(), coordinator: name },
      }),
      namespace: NS,
    }),
    { qos: 1, retain: true },
  );

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
    s.host.screens = [asked()];
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

  it("refuses an idle prompt that does not show the question: another session's screen", async () => {
    s = await makeSupervisedEnv();
    const item = await handoff();
    s.host.screens = [screen("picker-gone")];
    expect(await answer(item.id, "go")).toMatchObject({
      ok: false,
      error: "the question is not on screen",
    });
    expect(s.host.texts).toEqual([]);
    expect(s.host.keys).toEqual([]);
    expect(s.daemon.inboxItem(item.id)?.answered).toBeUndefined();
  });

  it("refuses a reply that would be a command in the prompt", async () => {
    s = await makeSupervisedEnv();
    const item = await handoff();
    s.host.screens = [asked()];
    const r = await answer(item.id, "!git push");
    expect(r.ok).toBe(false);
    expect(r.error).toBe(
      "a reply must be one line of plain text, not a slash command or shell line",
    );
    expect(s.host.texts).toEqual([]);
  });

  it("refuses a multi-line reply in plain words, before reading the screen", async () => {
    s = await makeSupervisedEnv();
    const item = await handoff();
    s.host.screens = [asked()];
    const r = await answer(item.id, "go\nthen stop");
    expect(r).toMatchObject({
      ok: false,
      error: "a reply must be one line of plain text, not a control character or a second line",
    });
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

  it("owner_only: an answer from anyone but the session (or its coordinator name) is refused", async () => {
    s = await makeSupervisedEnv();
    const item = await handoff();
    s.host.screens = [asked()];
    const r = await answer(item.id, "dispatch T2 now", "someone-else");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("only its owner answers");
    expect(s.host.texts).toEqual([]);
    expect(s.daemon.inboxItem(item.id)?.answered).toBeUndefined();
    // The coordinator name bound to the session is its owner too.
    await registered("owner");
    await s.until(() => s.daemon.bindingOf("owner") === COORD);
    const ok = await answer(item.id, "dispatch T2 now", "owner");
    expect(ok.error).toBeUndefined();
    expect(s.daemon.inboxItem(item.id)?.answered?.by).toBe("owner");
  });

  it("only the Stop hook's question opens a handoff, not a Notification's awaiting_input", async () => {
    s = await makeSupervisedEnv();
    await coord("awaiting_input", 30, "Notification", {
      question: QUESTION,
      notification_type: "idle_prompt",
      workspace: "workspace:7",
    });
    await coord("awaiting_input", 31, "Notification", {
      question: "Claude needs your permission to use Bash",
      notification_type: "permission_prompt",
      workspace: "workspace:7",
    });
    const item = await handoff(32);
    await s.consumed();
    expect(s.daemon.inboxItem(handoffItemId(COORD, 30))).toBeUndefined();
    expect(s.daemon.inboxItem(handoffItemId(COORD, 31))).toBeUndefined();
    expect(item.id).toBe(handoffItemId(COORD, 32));
  });

  it("a coordinator's picker is carried on this machine's host into the hook's workspace", async () => {
    s = await makeSupervisedEnv();
    await coord("picker_opened", 40, "PreToolUse", {
      tool_use_id: "toolu_01Coord",
      questions: [
        {
          question: "Which fruit do you want?",
          header: "Fruit",
          options: [
            { label: "Apple", description: "red" },
            { label: "Banana", description: "yellow" },
            { label: "Cherry", description: "small" },
          ],
          multiSelect: false,
        },
      ],
      workspace: "workspace:7",
    });
    const id = pickerItemId(COORD, "toolu_01Coord");
    await s.until(() => s.daemon.inboxItem(id) !== undefined);
    expect(s.daemon.inboxItem(id)).toMatchObject({ owner_only: true, agent_id: COORD });
    s.host.screens = [screen("picker-single")];
    expect((await answer(id, "Banana", "someone-else")).ok).toBe(false);
    const r = await answer(id, "Banana");
    expect(r.error).toBeUndefined();
    expect(s.host.keys).toEqual([
      { workspace: "workspace:7", key: "Down" },
      { workspace: "workspace:7", key: "Enter" },
    ]);
    expect(s.daemon.inboxItem(id)?.answered).toMatchObject({ by: COORD, where: phone });
  });

  it("refuses a workspace that is a supervised agent's screen: nothing is typed there", async () => {
    s = await makeSupervisedEnv();
    // The supervised wave agent is in workspace:1; this session names it as its own.
    const item = await handoff(30, "workspace:1");
    s.host.screens = [asked()];
    const r = await answer(item.id, "go");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("workspace:1 is w1-t1-implementer-1's screen");
    expect(s.host.keys).toEqual([]);
    expect(s.host.texts).toEqual([]);
    expect(s.daemon.inboxItem(item.id)?.answered).toBeUndefined();
  });

  it("refuses a workspace another registered session's entry names", async () => {
    s = await makeSupervisedEnv();
    await s.agent.publish(
      registryTopic("coord-other"),
      JSON.stringify({
        ...buildEnvelope({
          agentId: "coord-other",
          parentId: null,
          channel: "_system/registry",
          type: "registered",
          payload: { cwd: "/repo", started_at: new Date().toISOString(), workspace: "workspace:7" },
        }),
        namespace: NS,
      }),
      { qos: 1, retain: true },
    );
    const item = await handoff(31, "workspace:7");
    s.host.screens = [asked()];
    const r = await answer(item.id, "go");
    expect(r.error).toContain("workspace:7 is coord-other's screen");
    expect(s.host.keys).toEqual([]);
    expect(s.host.texts).toEqual([]);
  });

  it("the next prompt, or the session ending, closes an open picker too", async () => {
    s = await makeSupervisedEnv();
    const picker = (t: string, seq: number) =>
      coord("picker_opened", seq, "PreToolUse", {
        tool_use_id: t,
        questions: [{ question: "Q?", options: [{ label: "a" }, { label: "b" }] }],
        workspace: "workspace:7",
      });
    await picker("toolu_01A", 50);
    const a = pickerItemId(COORD, "toolu_01A");
    await s.until(() => s.daemon.inboxItem(a) !== undefined);
    await promptReceived(51);
    await s.until(() => s.daemon.inboxItem(a)?.answered !== undefined);
    expect(s.daemon.inboxItem(a)?.answered).toMatchObject({
      answer: "dismissed in its terminal",
      where: { kind: "terminal" },
    });

    await picker("toolu_01B", 52);
    const b = pickerItemId(COORD, "toolu_01B");
    await s.until(() => s.daemon.inboxItem(b) !== undefined);
    await s.agent.publish(
      buildTopic(NS, COORD, "status"),
      JSON.stringify(
        buildEnvelope({
          agentId: COORD,
          parentId: null,
          channel: "status",
          type: "done",
          payload: { summary: "bye" },
        }),
      ),
      { qos: 1, retain: true },
    );
    await s.until(() => s.daemon.inboxItem(b)?.answered !== undefined);
    expect(s.daemon.inboxItem(b)?.answered).toMatchObject({
      answer: "session ended",
      where: { kind: "terminal" },
    });
  });
});
