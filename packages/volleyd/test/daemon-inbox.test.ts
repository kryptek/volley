import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { type InboxItem, decisionItemId, inboxTopic } from "../src/autopilot/inbox";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import { ControlClient } from "../src/control";
import { AUTOPILOT_ON, NS } from "./helpers/daemon-env";
import { deskAccounts, deskAnswer } from "./helpers/desk-answer";
import { fakeExec } from "./helpers/fake-exec";
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

  it("a restart closes the item of a decision resolved just before a crash", async () => {
    s = await makeSupervisedEnv();
    const d = await s.daemon.openDecision("w1", disagree);
    const id = decisionItemId("w1", d.decision_id);
    await runCli(["resolve", d.decision_id, "fine", "--by", "owner"], s.env.env);
    await s.daemon.stop();
    // The crash came between journaling decision_resolved and inbox_answered.
    const file = join(s.env.home, "waves", "w1", "journal.jsonl");
    const lines = readFileSync(file, "utf8").split("\n");
    writeFileSync(file, lines.filter((l) => !l.includes('"inbox_answered"')).join("\n"));
    expect(s.journal().filter((e) => e.type === "inbox_answered")).toHaveLength(0);
    const d2 = await s.restart();
    expect(d2.inboxItem(id)?.answered).toMatchObject({ answer: "fine", where: { kind: "cli" } });
    expect((await retainedItem(id))?.type).toBe("inbox_answered");
    const r = await runCli(["inbox", "--json"], s.env.env);
    expect(JSON.parse(r.stdout).items).toEqual([]);
  });

  it("an inbox_answer on a decision in a wave owned by someone else is refused", async () => {
    s = await makeSupervisedEnv();
    const d = await s.daemon.openDecision("w1", disagree);
    const id = decisionItemId("w1", d.decision_id);
    const c = await control();
    expect((await c.request("claim", { wave: "w1", by: "coord-a" })).ok).toBe(true);
    const r = await c.request("inbox_answer", {
      id,
      version: 1,
      answer: "fine",
      where: phone,
      by: "someone-else",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("is owned by coord-a");
    expect(s.daemon.record("w1")?.decisions[d.decision_id]?.resolved).toBeUndefined();
    expect(s.daemon.inboxItem(id)?.answered).toBeUndefined();
    const ok = await c.request("inbox_answer", {
      id,
      version: 1,
      answer: "fine",
      where: phone,
      by: "coord-a",
    });
    expect(ok.ok).toBe(true);
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
    const seen: { answer: string; by: string; open: boolean }[] = [];
    let refuse: string | null = "not ready yet";
    s.daemon.inboxHandlers.set("release", async (item, req) => {
      seen.push({ answer: req.answer, by: req.by, open: item.answered === undefined });
      return refuse;
    });
    const item = await s.daemon.openInboxItem({
      id: "r-w9-go",
      kind: "release",
      owner_only: true,
      agent_id: "coord-1",
      title: "Release go/no-go",
      question: "Ship w9?",
      options: [{ label: "go" }, { label: "hold" }],
      pointers: {},
      source: { stage: "go" },
    });
    expect(item.version).toBe(1);
    expect((await retainedItem(item.id))?.type).toBe("inbox_item");
    const answer = () =>
      control().then((c) =>
        c.request("inbox_answer", {
          id: item.id,
          version: 1,
          answer: "go",
          where: phone,
          by: "owner-desk",
        }),
      );
    // The handler runs before the answer is recorded: a reason it returns refuses it.
    expect(await answer()).toMatchObject({ ok: false, error: "not ready yet" });
    expect(s.daemon.inboxItem(item.id)?.answered).toBeUndefined();
    refuse = null;
    const res = await answer();
    expect(res.error).toBeUndefined();
    expect(s.daemon.inboxItem(item.id)?.answered?.answer).toBe("go");
    expect(seen).toEqual([
      { answer: "go", by: "owner-desk", open: true },
      { answer: "go", by: "owner-desk", open: true },
    ]);
    const sys = systemJournal(s.env).map((e) => e.type);
    expect(sys).toContain("inbox_opened");
    expect(sys.filter((t) => t === "inbox_answered")).toHaveLength(1);
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

describe("a Desk login answers on its own account-op topic (the owner on any screen)", () => {
  const owned = async () => {
    s = await makeSupervisedEnv({ daemon: { authExec: deskAccounts().exec } });
    const c = await control();
    expect((await c.request("claim", { wave: "w1", by: "coord-main" })).ok).toBe(true);
  };
  const answerFrom = (user: string, id: string, op = "inbox_answer") =>
    deskAnswer(s.env.broker.url, user, { id, version: 1, answer: "fine", where: phone }, op);

  it("a steer login answers the decision of a wave coord-main owns, as itself", async () => {
    await owned();
    const d = await s.daemon.openDecision("w1", disagree);
    const id = decisionItemId("w1", d.decision_id);
    const r = await answerFrom("steer-1", id);
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ ok: true, op: "inbox_answer" });
    expect(s.daemon.record("w1")?.decisions[d.decision_id]?.resolved).toMatchObject({
      answer: "fine",
      by: "steer-1",
    });
    const answered = s.journal().filter((e) => e.type === "inbox_answered");
    expect(answered).toHaveLength(1);
    expect(answered[0]?.data).toMatchObject({ by: "steer-1", where: phone });
    expect((await retainedItem(id))?.type).toBe("inbox_answered");
    // The referee's compare-and-set is unchanged: a second Desk answer is late.
    const late = await answerFrom("admin-1", id);
    expect(late).toMatchObject({ ok: false, error: "already answered on desk·phone" });
  });

  it("the fixed desk identity and an admin login answer too", async () => {
    await owned();
    const a = await s.daemon.openDecision("w1", disagree);
    const b = await s.daemon.openDecision("w1", { ...disagree, task: null });
    expect(await answerFrom("desk", decisionItemId("w1", a.decision_id))).toMatchObject({
      ok: true,
    });
    expect(await answerFrom("admin-1", decisionItemId("w1", b.decision_id))).toMatchObject({
      ok: true,
    });
  });

  it("the fixed desk identity needs no account lookup (a failing account tool does not refuse it)", async () => {
    const accounts = fakeExec().on(["volley", "auth", "list"], { code: 1, stderr: "boom" });
    s = await makeSupervisedEnv({ daemon: { authExec: accounts.exec } });
    const c = await control();
    expect((await c.request("claim", { wave: "w1", by: "coord-main" })).ok).toBe(true);
    const d = await s.daemon.openDecision("w1", disagree);
    const r = await answerFrom("desk", decisionItemId("w1", d.decision_id));
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ ok: true });
    expect(accounts.calls.filter((x) => x.argv[2] === "list")).toHaveLength(0);
  });

  it("a watch login or a name with no account is refused by role, with no claim hint", async () => {
    await owned();
    const d = await s.daemon.openDecision("w1", disagree);
    const id = decisionItemId("w1", d.decision_id);
    const watch = await answerFrom("watch-1", id);
    expect(watch.ok).toBe(false);
    expect(watch.error).toMatch(/Desk ops need the steer or admin role/);
    expect(watch.error).not.toMatch(/claim it/);
    const agent = await answerFrom("agent-a1", id);
    expect(agent.ok).toBe(false);
    expect(agent.error).toContain("has no account");
    expect(s.daemon.record("w1")?.decisions[d.decision_id]?.resolved).toBeUndefined();
    expect(s.daemon.inboxItem(id)?.answered).toBeUndefined();
  });

  it("an owner_only decision kind is answered by a Desk login (a human is the owner)", async () => {
    await owned();
    const d = await s.daemon.openDecision("w1", {
      kind: "plan_change",
      task: null,
      question: "Add a task T2?",
      options: ["apply", "cancel"],
    });
    const r = await deskAnswer(s.env.broker.url, "steer-1", {
      id: decisionItemId("w1", d.decision_id),
      version: 1,
      answer: "cancel",
      where: phone,
    });
    expect(r.error).toBeUndefined();
    expect(s.daemon.record("w1")?.decisions[d.decision_id]?.resolved?.by).toBe("steer-1");
  });

  it("resolve on the topic resolves a decision as the Desk login", async () => {
    await owned();
    const d = await s.daemon.openDecision("w1", disagree);
    const r = await deskAnswer(
      s.env.broker.url,
      "steer-1",
      { decision_id: d.decision_id, answer: "fine" },
      "resolve",
    );
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ ok: true, op: "resolve", result: { wave: "w1" } });
    expect(s.daemon.record("w1")?.decisions[d.decision_id]?.resolved?.by).toBe("steer-1");
    const watch = await deskAnswer(
      s.env.broker.url,
      "watch-1",
      { decision_id: d.decision_id, answer: "fine" },
      "resolve",
    );
    expect(watch.error).toMatch(/Desk ops need the steer or admin role/);
  });

  it("the mailbox is unchanged: a self-reported Desk login (or a smuggled flag) is refused", async () => {
    await owned();
    const d = await s.daemon.openDecision("w1", disagree);
    const id = decisionItemId("w1", d.decision_id);
    const c = await control();
    const fields = { id, version: 1, answer: "fine", where: phone, by: "steer-1" };
    const r = await c.request("inbox_answer", fields);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("is owned by coord-main");
    const smuggled = await c.request("inbox_answer", { ...fields, desk_login: true });
    expect(smuggled.ok).toBe(false);
    expect(smuggled.error).toContain("is owned by coord-main");
    const resolve = await c.request("resolve", {
      decision_id: d.decision_id,
      answer: "fine",
      by: "steer-1",
      desk_login: true,
    });
    expect(resolve.error).toContain("is owned by coord-main");
    expect(s.daemon.inboxItem(id)?.answered).toBeUndefined();
  });
});

describe("held decisions (#335): waiting on a task, PR or issue", () => {
  const withT2 = (o: Parameters<typeof makeSupervisedEnv>[0] = {}) =>
    makeSupervisedEnv({ tasks: ["T2: { issue: 42 }"], ...o });

  it("volleyd hold --on T2: decision_held journaled, item and decision carry `held`; T2 cancelled releases it", async () => {
    s = await withT2();
    const d = await s.daemon.openDecision("w1", disagree);
    const id = decisionItemId("w1", d.decision_id);
    const r = await runCli(
      ["hold", d.decision_id, "--on", "T2", "--note", "flake fix", "--by", "owner"],
      s.env.env,
    );
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain(`held ${d.decision_id} (w1) on T2`);
    const held = s.journal().find((e) => e.type === "decision_held");
    expect(held?.data).toMatchObject({
      decision_id: d.decision_id,
      on: { task: "T2" },
      note: "flake fix",
      by: "owner",
    });
    const env = await retainedItem(id);
    expect(env?.payload.held).toMatchObject({ on: { task: "T2" }, note: "flake fix" });
    expect(env?.payload.version).toBe(1);
    expect(schemaErrors("inbox-item.schema.json", env)).toEqual([]);
    const dec = await s.env.retained(`volley/_waves/w1/decisions/${d.decision_id}`);
    expect((dec as { payload: { held?: unknown } }).payload.held).toMatchObject({
      on: { task: "T2" },
    });
    expect(schemaErrors("decision.schema.json", dec)).toEqual([]);
    const list = await runCli(["decisions", "w1"], s.env.env);
    expect(list.stdout).toContain("held on T2 by owner");

    await s.daemon.recordEvent("w1", { type: "task_cancelled", task: "T2", data: {} });
    await s.daemon.tick();
    const released = await s.event((e) => e.type === "decision_released");
    expect(released.data).toMatchObject({ decision_id: d.decision_id, why: "T2 cancelled" });
    await s.settled();
    expect(s.daemon.inboxItem(id)?.held).toBeUndefined();
    expect((await retainedItem(id))?.payload.held).toBeUndefined();
    // Still open, in its normal tier: released is not answered.
    expect(s.daemon.record("w1")?.decisions[d.decision_id]?.resolved).toBeUndefined();
  });

  it("a hold on T2 is released when T2 reaches done", async () => {
    s = await withT2();
    const d = await s.daemon.openDecision("w1", disagree);
    const c = await control();
    const h = await c.request("hold", {
      decision_id: d.decision_id,
      on: { task: "T2" },
      by: "owner",
    });
    expect(h.error).toBeUndefined();
    await s.daemon.recordEvent("w1", {
      type: "stage_entered",
      task: "T2",
      data: { stage: "done" },
    });
    await s.daemon.tick();
    const released = await s.event((e) => e.type === "decision_released");
    expect(released.data).toMatchObject({ decision_id: d.decision_id, why: "T2 done" });
    expect(s.daemon.record("w1")?.decisions[d.decision_id]?.held).toBeUndefined();
  });

  it("--on '#12' is released when gh pr view says MERGED, read once per ci_poll_ms", async () => {
    let state = "OPEN";
    let now = Date.parse("2026-10-21T09:00:00Z");
    s = await withT2({
      exec: [[["gh", "pr", "view", "12"], () => ({ stdout: JSON.stringify({ state }) })]],
      daemon: { now: () => now },
    });
    const d = await s.daemon.openDecision("w1", disagree);
    const c = await control();
    const r = await c.request("hold", { decision_id: d.decision_id, on: { pr: 12 }, by: "owner" });
    expect(r.error).toBeUndefined();
    await s.daemon.tick();
    await s.settled();
    expect(s.daemon.record("w1")?.decisions[d.decision_id]?.held?.on).toEqual({ pr: 12 });
    const reads = () => s?.host.fake.argvs(["gh", "pr", "view", "12"]).length ?? 0;
    const first = reads();
    expect(first).toBeGreaterThan(0);
    // Ticks inside ci_poll_ms do not read it again.
    state = "MERGED";
    await s.daemon.tick();
    await s.daemon.tick();
    await s.settled();
    expect(reads()).toBe(first);
    expect(s.journal().some((e) => e.type === "decision_released")).toBe(false);
    now += DAEMON_DEFAULTS.ci_poll_ms;
    await s.daemon.tick();
    const released = await s.event((e) => e.type === "decision_released");
    expect(released.data).toMatchObject({ decision_id: d.decision_id, why: "PR #12 merged" });
    expect(s.host.fake.argvs(["gh", "pr", "view", "12"]).at(-1)).toEqual([
      "gh",
      "pr",
      "view",
      "12",
      "--json",
      "state",
    ]);
  });

  it("volleyd release lifts a hold by hand; inbox hold holds by item id", async () => {
    s = await withT2();
    const d = await s.daemon.openDecision("w1", disagree);
    const id = decisionItemId("w1", d.decision_id);
    const h = await runCli(["inbox", "hold", id, "--on", "issue#7", "--by", "owner"], s.env.env);
    expect(h.stderr).toBe("");
    expect(s.daemon.inboxItem(id)?.held?.on).toEqual({ issue: 7 });
    const r = await runCli(["release", d.decision_id, "--by", "owner"], s.env.env);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain(`released ${d.decision_id}`);
    const ev = s.journal().find((e) => e.type === "decision_released");
    expect(ev?.data).toMatchObject({ why: "released by owner", by: "owner" });
    expect(s.daemon.inboxItem(id)?.held).toBeUndefined();
  });

  /** A ci_failed on T2's PR #12 (red head RED), as the pipeline opens it. */
  const RED = `badc0de${"0".repeat(33)}`;
  const GREEN = `600d${"0".repeat(36)}`;
  const ciFailedOnT2 = (env: SupervisedEnv) =>
    env.daemon.recordEvent("w1", {
      type: "decision_opened",
      task: "T2",
      data: {
        decision_id: "ci-t2",
        kind: "ci_failed",
        question: "CI failed on badc0de: a flake.",
        options: ["fix flake", "fixup", "re-verify", "cancel"],
        pointers: {},
        pr: { number: 12, url: "https://example.test/pr/12" },
        pipeline: { on: "ci_failed", role: "implementer", head: RED },
      },
    });
  const prHead = (head: string, conclusion: string): [string[], { stdout: string }][] => [
    [["gh", "pr", "view", "12"], { stdout: JSON.stringify({ state: "OPEN", headRefOid: head }) }],
    [
      ["gh", "run", "list"],
      {
        stdout: JSON.stringify([
          {
            databaseId: 3,
            name: "CI",
            status: "completed",
            conclusion,
            headSha: head,
            url: "https://example.test/runs/3",
          },
        ]),
      },
    ],
  ];

  it("a released ci_failed re-verifies its head first: green now, it is answered re-verify", async () => {
    s = await withT2({ exec: prHead(GREEN, "success") });
    await ciFailedOnT2(s);
    const c = await control();
    const h = await c.request("hold", { decision_id: "ci-t2", on: { issue: 7 }, by: "owner" });
    expect(h.error).toBeUndefined();
    const r = await c.request("release", { decision_id: "ci-t2", by: "owner" });
    expect(r.error).toBeUndefined();
    const resolved = await s.event(
      (e) => e.type === "decision_resolved" && e.data.decision_id === "ci-t2",
    );
    expect(resolved.data).toMatchObject({ answer: "re-verify", by: "volleyd" });
    expect(String(resolved.data.rationale)).toContain("green");
    expect(s.host.fake.argvs(["gh", "run", "list"]).at(-1)).toContain(GREEN);
  });

  it("a released ci_failed whose head is still red stays open for autopilot's rule", async () => {
    s = await withT2({ exec: prHead(RED, "failure") });
    await ciFailedOnT2(s);
    const c = await control();
    await c.request("hold", { decision_id: "ci-t2", on: { issue: 7 }, by: "owner" });
    await c.request("release", { decision_id: "ci-t2", by: "owner" });
    await s.until(() => (s?.host.fake.argvs(["gh", "run", "list"]).length ?? 0) > 0);
    await s.settled();
    const d = s.daemon.record("w1")?.decisions["ci-t2"];
    expect(d?.resolved).toBeUndefined();
    expect(d?.held).toBeUndefined();
  });

  it("a released decision autopilot already escalated is not escalated a second time", async () => {
    s = await withT2({
      daemon: AUTOPILOT_ON,
      config: "autopilot: { owner_only: [reviewers_disagree] }",
    });
    const d = await s.daemon.openDecision("w1", disagree);
    await s.settled();
    const escalations = () =>
      s
        ?.journal()
        .filter((e) => e.type === "decision_escalated" && e.data.decision_id === d.decision_id) ??
      [];
    expect(escalations()).toHaveLength(1);
    const c = await control();
    const h = await c.request("hold", {
      decision_id: d.decision_id,
      on: { issue: 7 },
      by: "owner",
    });
    expect(h.error).toBeUndefined();
    const r = await c.request("release", { decision_id: d.decision_id, by: "owner" });
    expect(r.error).toBeUndefined();
    await s.settled();
    const after = s.daemon.record("w1")?.decisions[d.decision_id];
    expect(after?.held).toBeUndefined();
    expect(after?.resolved).toBeUndefined();
    expect(after?.escalated).toBeDefined();
    expect(escalations()).toHaveLength(1);
  });

  it("a released decision autopilot escalates anew rings the notify bridge", async () => {
    s = await withT2({ daemon: AUTOPILOT_ON });
    const c = await control();
    const set = (patch: unknown) => c.request("config_set", { patch, by: "owner" });
    expect((await set({ autopilot: { enabled: false } })).error).toBeUndefined();
    const d = await s.daemon.openDecision("w1", disagree);
    await s.settled();
    expect(s.daemon.record("w1")?.decisions[d.decision_id]?.escalated).toBeUndefined();
    await c.request("hold", { decision_id: d.decision_id, on: { issue: 7 }, by: "owner" });
    const patch = { autopilot: { enabled: true, owner_only: ["reviewers_disagree"] } };
    expect((await set(patch)).error).toBeUndefined();

    const sub = new VolleyBroker();
    await sub.connect({ url: s.env.broker.url, agentId: "test-notify" });
    const rung: string[] = [];
    await sub.subscribeStream(`volley/${NS}/volleyd/progress`, (m) => {
      const env = JSON.parse(m.payload);
      if (env.type === "blocked" && env.payload?.attention === "decision_opened")
        rung.push(env.payload.decision_id as string);
    });
    try {
      const r = await c.request("release", { decision_id: d.decision_id, by: "owner" });
      expect(r.error).toBeUndefined();
      await s.event((e) => e.type === "decision_escalated");
      await s.until(() => rung.includes(d.decision_id));
    } finally {
      await sub.disconnect();
    }
  });

  it("hold is owner-guarded like resolve; a Desk login holds on its account-op topic", async () => {
    s = await withT2({ daemon: { authExec: deskAccounts().exec } });
    const c = await control();
    expect((await c.request("claim", { wave: "w1", by: "coord-main" })).ok).toBe(true);
    const d = await s.daemon.openDecision("w1", disagree);
    const refused = await c.request("hold", {
      decision_id: d.decision_id,
      on: { task: "T2" },
      by: "someone-else",
    });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("owned by coord-main");
    const r = await deskAnswer(
      s.env.broker.url,
      "steer-1",
      { decision_id: d.decision_id, on: { task: "T2" } },
      "hold",
    );
    expect(r.error).toBeUndefined();
    expect(s.daemon.record("w1")?.decisions[d.decision_id]?.held).toMatchObject({
      on: { task: "T2" },
      by: "steer-1",
    });
  });
});
