import { afterEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { type InboxItem, decisionItemId, inboxTopic } from "../src/autopilot/inbox";
import { ControlClient } from "../src/control";
import { AUTOPILOT_ON, NS } from "./helpers/daemon-env";
import { runCli } from "./helpers/run-cli";
import { schemaErrors } from "./helpers/schema";
import { type SupervisedEnv, makeSupervisedEnv, systemJournal } from "./helpers/supervised-env";

let s: SupervisedEnv;
let client: ControlClient | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
  await s.cleanup();
});

const disagree = {
  kind: "reviewers_disagree" as const,
  task: "T1",
  question: "Reviewers disagree on a P1 — is it a blocker?",
  options: ["blocker", "fine"],
};

const phone = { kind: "desk", device: "phone" };

async function control(): Promise<ControlClient> {
  client ??= await ControlClient.connect(s.env.broker.url, NS);
  return client;
}

const retainedItem = async (id: string) =>
  (await s.env.retained(inboxTopic(id))) as { type: string; payload: InboxItem } | null;

describe("the needs-you inbox in the daemon (SPEC §4.6.18)", () => {
  it("a decision opens a retained inbox item; inbox_opened is journaled", async () => {
    s = await makeSupervisedEnv();
    const d = await s.daemon.openDecision("w1", disagree);
    const id = decisionItemId("w1", d.decision_id);
    const env = await retainedItem(id);
    expect(env?.type).toBe("inbox_item");
    expect(env?.payload).toMatchObject({
      id,
      kind: "decision",
      version: 1,
      owner_only: false,
      wave: "w1",
      task: "T1",
      options: [{ label: "blocker" }, { label: "fine" }],
    });
    expect(schemaErrors("inbox-item.schema.json", env)).toEqual([]);
    const types = s.journal().map((e) => e.type);
    expect(types.indexOf("inbox_opened")).toBeGreaterThan(types.indexOf("decision_opened"));
    expect(s.daemon.inboxItem(id)?.version).toBe(1);
  });

  it("an owner_only decision kind opens an owner_only item", async () => {
    s = await makeSupervisedEnv();
    const d = await s.daemon.openDecision("w1", {
      kind: "plan_change",
      task: null,
      question: "Add a task T2?",
      options: ["apply", "cancel"],
    });
    expect((await retainedItem(decisionItemId("w1", d.decision_id)))?.payload.owner_only).toBe(
      true,
    );
  });

  it("inbox_answer resolves the decision; a late answer is refused with the winner's where", async () => {
    s = await makeSupervisedEnv();
    const d = await s.daemon.openDecision("w1", disagree);
    const id = decisionItemId("w1", d.decision_id);
    const c = await control();
    const first = await c.request("inbox_answer", {
      id,
      version: 1,
      answer: "fine",
      where: phone,
      by: "owner-desk",
    });
    expect(first.error).toBeUndefined();
    expect(first.ok).toBe(true);
    expect(first.result).toMatchObject({ id, version: 2, answered: { answer: "fine" } });
    expect(s.daemon.record("w1")?.decisions[d.decision_id]?.resolved).toMatchObject({
      answer: "fine",
      by: "owner-desk",
    });
    const env = await retainedItem(id);
    expect(env?.type).toBe("inbox_answered");
    expect(env?.payload.answered).toMatchObject({ answer: "fine", by: "owner-desk", where: phone });
    expect(schemaErrors("inbox-item.schema.json", env)).toEqual([]);

    const late = await c.request("inbox_answer", {
      id,
      version: 1,
      answer: "blocker",
      where: { kind: "terminal", machine: "mbp" },
    });
    expect(late.ok).toBe(false);
    expect(late.error).toBe("already answered on desk·phone");
    expect(s.daemon.record("w1")?.decisions[d.decision_id]?.resolved?.answer).toBe("fine");

    const answered = s.journal().filter((e) => e.type === "inbox_answered");
    expect(answered).toHaveLength(1);
    expect(answered[0]?.data).toEqual({
      id,
      kind: "decision",
      answer: "fine",
      by: "owner-desk",
      where: phone,
      version: 2,
    });
  });

  it("a CLI resolve after a Desk answer prints already answered on desk·phone", async () => {
    s = await makeSupervisedEnv();
    const d = await s.daemon.openDecision("w1", disagree);
    const id = decisionItemId("w1", d.decision_id);
    await (await control()).request("inbox_answer", {
      id,
      version: 1,
      answer: "fine",
      where: phone,
    });
    const r = await runCli(["resolve", d.decision_id, "blocker", "--by", "owner"], s.env.env);
    expect(r.stdout).toContain("already answered on desk·phone");
    expect(s.journal().filter((e) => e.type === "inbox_answered")).toHaveLength(1);
  });

  it("volleyd resolve journals inbox_answered where cli; --where names another place", async () => {
    s = await makeSupervisedEnv();
    const a = await s.daemon.openDecision("w1", disagree);
    const b = await s.daemon.openDecision("w1", { ...disagree, task: null });
    const r1 = await runCli(["resolve", a.decision_id, "blocker", "--by", "owner"], s.env.env);
    expect(r1.stderr).toBe("");
    const r2 = await runCli(
      ["resolve", b.decision_id, "fine", "--by", "owner", "--where", "mbp·terminal"],
      s.env.env,
    );
    expect(r2.stderr).toBe("");
    const ev = s.journal();
    const opened = ev.findIndex(
      (e) =>
        e.type === "inbox_opened" &&
        (e.data.item as InboxItem).source.decision_id === a.decision_id,
    );
    const answered = ev.filter((e) => e.type === "inbox_answered");
    expect(opened).toBeGreaterThan(-1);
    expect(answered.map((e) => e.data.where)).toEqual([
      { kind: "cli" },
      { kind: "terminal", machine: "mbp" },
    ]);
    expect(answered[0]?.seq).toBeGreaterThan(ev[opened]?.seq ?? 0);
  });

  it("an autopilot answer closes the item with where autopilot", async () => {
    s = await makeSupervisedEnv({ daemon: AUTOPILOT_ON });
    const d = await s.daemon.openDecision("w1", disagree);
    const id = decisionItemId("w1", d.decision_id);
    const answered = s.journal().filter((e) => e.type === "inbox_answered");
    expect(answered.map((e) => e.data)).toEqual([
      {
        id,
        kind: "decision",
        answer: "blocker",
        by: "volleyd",
        where: { kind: "autopilot" },
        version: 2,
      },
    ]);
    expect((await retainedItem(id))?.payload.answered?.where).toEqual({ kind: "autopilot" });
  });

  it("inbox lists open items; answered ones are not listed", async () => {
    s = await makeSupervisedEnv();
    const a = await s.daemon.openDecision("w1", disagree);
    const b = await s.daemon.openDecision("w1", { ...disagree, task: null });
    await runCli(["resolve", b.decision_id, "fine", "--by", "owner"], s.env.env);
    const res = await (await control()).request("inbox", {});
    expect(res.ok).toBe(true);
    const items = (res.result as { items: InboxItem[] }).items;
    expect(items.map((i) => i.id)).toEqual([decisionItemId("w1", a.decision_id)]);
  });

  it("a restart re-publishes open items and keeps answered ones within the ttl", async () => {
    s = await makeSupervisedEnv();
    const a = await s.daemon.openDecision("w1", disagree);
    const b = await s.daemon.openDecision("w1", { ...disagree, task: null });
    const ia = decisionItemId("w1", a.decision_id);
    const ib = decisionItemId("w1", b.decision_id);
    await runCli(["resolve", b.decision_id, "fine", "--by", "owner"], s.env.env);
    await s.daemon.stop();
    // Lost retained records (a broker restart without persistence): the journal is the record.
    const pub = new VolleyBroker();
    await pub.connect({ url: s.env.broker.url, agentId: "test-pub" });
    await pub.publish(inboxTopic(ia), "", { qos: 1, retain: true });
    await pub.publish(inboxTopic(ib), "", { qos: 1, retain: true });
    await pub.disconnect();
    const d2 = await s.restart();
    expect((await retainedItem(ia))?.type).toBe("inbox_item");
    expect((await retainedItem(ib))?.payload.answered?.where).toEqual({ kind: "cli" });
    expect(d2.inboxItem(ib)?.version).toBe(2);
  });

  it("an answered item is cleared once inbox_answered_ttl_s has passed", async () => {
    s = await makeSupervisedEnv({ config: "autopilot: { inbox_answered_ttl_s: 0 }" });
    const d = await s.daemon.openDecision("w1", disagree);
    const id = decisionItemId("w1", d.decision_id);
    const open = await s.daemon.openDecision("w1", { ...disagree, task: null });
    await runCli(["resolve", d.decision_id, "fine", "--by", "owner"], s.env.env);
    await s.daemon.tick();
    expect(await retainedItem(id)).toBeNull();
    expect(s.daemon.inboxItem(id)).toBeUndefined();
    // An open item is never cleared by the sweep.
    expect(await retainedItem(decisionItemId("w1", open.decision_id))).not.toBeNull();
  });

  it("other kinds: openInboxItem + a registered handler; journaled in _system without a wave", async () => {
    s = await makeSupervisedEnv();
    const seen: { answer: string; by: string }[] = [];
    s.daemon.inboxHandlers.set("picker", async (item) => {
      seen.push({ answer: item.answered?.answer ?? "", by: item.answered?.by ?? "" });
    });
    const item = await s.daemon.openInboxItem({
      id: "p-coord-1-toolu_01Ab",
      kind: "picker",
      owner_only: false,
      agent_id: "coord-1",
      title: "Pick a backend",
      question: "Which backend?",
      options: [{ label: "SQLite" }, { label: "Redis" }],
      pointers: {},
      source: { tool_use_id: "toolu_01Ab" },
    });
    expect(item.version).toBe(1);
    expect((await retainedItem(item.id))?.type).toBe("inbox_item");
    const res = await (await control()).request("inbox_answer", {
      id: item.id,
      version: 1,
      answer: "Redis",
      where: phone,
      by: "owner-desk",
    });
    expect(res.error).toBeUndefined();
    expect(seen).toEqual([{ answer: "Redis", by: "owner-desk" }]);
    const sys = systemJournal(s.env).map((e) => e.type);
    expect(sys).toContain("inbox_opened");
    expect(sys).toContain("inbox_answered");
  });

  it("refuses an unknown item and a bad where", async () => {
    s = await makeSupervisedEnv();
    const d = await s.daemon.openDecision("w1", disagree);
    const c = await control();
    const unknown = await c.request("inbox_answer", {
      id: "d-w1-nope",
      version: 1,
      answer: "x",
      where: phone,
    });
    expect(unknown).toMatchObject({ ok: false, error: "unknown inbox item 'd-w1-nope'" });
    const bad = await c.request("inbox_answer", {
      id: decisionItemId("w1", d.decision_id),
      version: 1,
      answer: "fine",
      where: { kind: "pager" },
    });
    expect(bad).toMatchObject({
      ok: false,
      error: "where.kind must be desk, terminal, cli or autopilot",
    });
    expect(s.daemon.record("w1")?.decisions[d.decision_id]?.resolved).toBeUndefined();
  });
});
