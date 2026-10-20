import { afterEach, describe, expect, it } from "vitest";
import { type InboxItem, decisionItemId } from "../src/autopilot/inbox";
import { formatInboxItem } from "../src/commands/inbox";
import { runCli } from "./helpers/run-cli";
import { type SupervisedEnv, makeSupervisedEnv } from "./helpers/supervised-env";

let s: SupervisedEnv | undefined;
afterEach(async () => {
  await s?.cleanup();
  s = undefined;
});

const disagree = {
  kind: "reviewers_disagree" as const,
  task: "T1",
  question: "Reviewers disagree on a P1 — is it a blocker?",
  options: ["blocker", "fine"],
};

describe("formatInboxItem", () => {
  const item: InboxItem = {
    id: "d-w1-d-abc",
    kind: "decision",
    version: 1,
    owner_only: false,
    wave: "w1",
    task: "T1",
    agent_id: "volleyd",
    title: "Reviewers disagree · w1/T1",
    question: "Is it a blocker?",
    options: [{ label: "blocker" }, { label: "fine" }],
    pointers: {},
    opened_at: "2026-10-20T12:00:00.000Z",
    source: {},
  };
  it("one line: id, kind, age, owner-only, title, options; then the question", () => {
    expect(formatInboxItem(item, Date.parse("2026-10-20T12:02:10.000Z"))).toBe(
      "d-w1-d-abc  decision  2m  owner-only? no  Reviewers disagree · w1/T1  [blocker | fine]\n  Is it a blocker?\n",
    );
    expect(
      formatInboxItem(
        { ...item, owner_only: true, options: [] },
        Date.parse("2026-10-20T15:00:00.000Z"),
      ),
    ).toBe(
      "d-w1-d-abc  decision  3h  owner-only? yes  Reviewers disagree · w1/T1\n  Is it a blocker?\n",
    );
    expect(formatInboxItem(item, Date.parse("2026-10-20T12:00:05.000Z"))).toContain("  5s  ");
  });
});

describe("volleyd inbox", () => {
  it("lists open items; answer answers one (cli); a second answer is refused, exit 1", async () => {
    s = await makeSupervisedEnv();
    const empty = await runCli(["inbox"], s.env.env);
    expect(empty.stdout).toBe("nothing needs you\n");

    const d = await s.daemon.openDecision("w1", disagree);
    const id = decisionItemId("w1", d.decision_id);
    const list = await runCli(["inbox"], s.env.env);
    expect(list.stderr).toBe("");
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toMatch(
      new RegExp(
        `^${id}  decision  \\d+s  owner-only\\? no  Reviewers disagree · w1/T1  \\[blocker \\| fine\\]$`,
        "m",
      ),
    );
    const json = await runCli(["inbox", "--json"], s.env.env);
    expect((JSON.parse(json.stdout) as { items: InboxItem[] }).items.map((i) => i.id)).toEqual([
      id,
    ]);

    const ans = await runCli(["inbox", "answer", id, "blocker", "--by", "owner"], s.env.env);
    expect(ans.stderr).toBe("");
    expect(ans.exitCode).toBe(0);
    expect(ans.stdout).toBe(`answered ${id} (cli): blocker\n`);
    expect(s.daemon.record("w1")?.decisions[d.decision_id]?.resolved?.answer).toBe("blocker");

    const again = await runCli(["inbox", "answer", id, "fine"], s.env.env);
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain("already answered on cli");
    expect((await runCli(["inbox"], s.env.env)).stdout).toBe("nothing needs you\n");
  });

  it("a stale --version is refused; --where names where it was answered", async () => {
    s = await makeSupervisedEnv();
    const d = await s.daemon.openDecision("w1", disagree);
    const id = decisionItemId("w1", d.decision_id);
    const stale = await runCli(["inbox", "answer", id, "fine", "--version", "4"], s.env.env);
    expect(stale.exitCode).toBe(1);
    expect(stale.stderr).toContain("stale version 4 (the item is at version 1)");
    const ok = await runCli(
      ["inbox", "answer", id, "fine", "--where", "mbp·terminal", "--version", "1"],
      s.env.env,
    );
    expect(ok.stdout).toBe(`answered ${id} (mbp·terminal): fine\n`);
  });

  it("answer with a missing id or answer is a usage error", async () => {
    const r = await runCli(["inbox", "answer", "d-w1-x"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("expected an item id and an answer");
  });
});
