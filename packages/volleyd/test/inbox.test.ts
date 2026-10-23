import { describe, expect, it } from "vitest";
import {
  INBOX_CHANNEL,
  type InboxItem,
  answerEvent,
  foldInbox,
  inboxEnvelopeType,
  inboxTopic,
  itemForDecision,
  openedEvent,
  ttlExpired,
  whereLabel,
} from "../src/autopilot/inbox";
import { CONFIG_DEFAULTS } from "../src/config-defaults";
import { type DecisionPayload, ITS_RUNNING, ITS_RUNNING_HELP } from "../src/decisions";
import type { JournalEvent } from "../src/types";
import { envelope, schemaErrors } from "./helpers/schema";

const cfg = CONFIG_DEFAULTS.autopilot;
const NOW = new Date("2026-10-20T12:00:00.000Z");

const disagree: DecisionPayload = {
  decision_id: "d-abc",
  wave: "w1",
  task: "T1",
  kind: "reviewers_disagree",
  question: "Reviewers disagree on a P1 — is it a blocker?",
  options: ["blocker", "fine"],
  pointers: { pr: "https://github.com/example-org/example-repo/pull/8" },
  opened_at: "2026-10-20T11:58:00.000Z",
};

const desk = { kind: "desk" as const, device: "phone" };

describe("inbox records (SPEC §4.6.18)", () => {
  it("inboxTopic is volley/_inbox/<id>", () => {
    expect(inboxTopic("d-w1-d-abc")).toBe("volley/_inbox/d-w1-d-abc");
  });

  it("itemForDecision: id d-<wave>-<decision_id>, options as { label }, owner_only from the config", () => {
    const item = itemForDecision(disagree, cfg);
    expect(item).toEqual({
      id: "d-w1-d-abc",
      kind: "decision",
      version: 1,
      owner_only: false,
      wave: "w1",
      task: "T1",
      agent_id: "volleyd",
      title: "Reviewers disagree · w1/T1",
      question: disagree.question,
      options: [{ label: "blocker" }, { label: "fine" }],
      allow_other: true,
      pointers: disagree.pointers,
      opened_at: disagree.opened_at,
      source: { decision_id: "d-abc", decision_kind: "reviewers_disagree" },
    });
    const go = itemForDecision(
      { ...disagree, decision_id: "d-go", task: null, kind: "release_go" as never },
      cfg,
    );
    expect(go.owner_only).toBe(true);
    expect(go.title).toBe("Release go · w1");
    expect(go).not.toHaveProperty("task");
  });

  it("itemForDecision: an option's hover text (option_help) is its description (#402)", () => {
    const item = itemForDecision(
      {
        ...disagree,
        kind: "unknown_screen",
        options: ["relaunch", "cancel", ITS_RUNNING],
        option_help: { [ITS_RUNNING]: ITS_RUNNING_HELP },
      },
      cfg,
    );
    expect(item.options).toEqual([
      { label: "relaunch" },
      { label: "cancel" },
      { label: "it's running", description: ITS_RUNNING_HELP },
    ]);
    expect(
      schemaErrors(
        "inbox-item.schema.json",
        envelope(INBOX_CHANNEL, inboxEnvelopeType(item), item),
      ),
    ).toEqual([]);
  });

  it("itemForDecision keeps the agent the decision is about", () => {
    const item = itemForDecision({ ...disagree, agent_id: "w1-t1-implementer-1" } as never, cfg);
    expect(item.agent_id).toBe("w1-t1-implementer-1");
  });

  it("a decision with no options has none on its item", () => {
    const { options: _o, ...bare } = disagree;
    expect(itemForDecision(bare, cfg)).not.toHaveProperty("options");
  });
});

describe("the referee: compare-and-set on the item version", () => {
  const item = itemForDecision(disagree, cfg);

  it("the first answer at the current version is accepted: event + item at version 2", () => {
    const r = answerEvent(item, { version: 1, answer: "blocker", by: "desk", where: desk }, NOW);
    if ("refused" in r) throw new Error(r.refused);
    expect(r.event).toEqual({
      type: "inbox_answered",
      data: {
        id: item.id,
        kind: "decision",
        answer: "blocker",
        by: "desk",
        where: desk,
        version: 2,
      },
    });
    expect(r.item.version).toBe(2);
    expect(r.item.answered).toEqual({
      answer: "blocker",
      by: "desk",
      where: desk,
      at: NOW.toISOString(),
    });
  });

  it("a later answer at the old version is refused with where the winner answered", () => {
    const first = answerEvent(item, { version: 1, answer: "blocker", by: "x", where: desk }, NOW);
    if ("refused" in first) throw new Error(first.refused);
    const late = answerEvent(
      first.item,
      { version: 1, answer: "fine", by: "y", where: { kind: "cli" } },
      NOW,
    );
    expect(late).toEqual({ refused: "already answered on desk·phone" });
    // Even at the new version: an answered item takes no second answer.
    const again = answerEvent(
      first.item,
      { version: 2, answer: "fine", by: "y", where: { kind: "cli" } },
      NOW,
    );
    expect(again).toEqual({ refused: "already answered on desk·phone" });
  });

  it("a stale version of an open item is refused", () => {
    const r = answerEvent(
      { ...item, version: 3 },
      { version: 2, answer: "fine", by: "y", where: { kind: "cli" } },
      NOW,
    );
    expect(r).toEqual({ refused: "stale version 2 (the item is at version 3)" });
  });

  it("an empty answer and a bad where are refused", () => {
    expect(answerEvent(item, { version: 1, answer: " ", by: "y", where: desk }, NOW)).toEqual({
      refused: "an answer is required",
    });
    expect(
      answerEvent(
        item,
        { version: 1, answer: "fine", by: "y", where: { kind: "pager" } as never },
        NOW,
      ),
    ).toEqual({ refused: "where.kind must be desk, terminal, cli or autopilot" });
  });
});

describe("whereLabel", () => {
  it("renders the four forms", () => {
    expect(whereLabel({ kind: "desk", device: "phone" })).toBe("desk·phone");
    expect(whereLabel({ kind: "desk" })).toBe("desk");
    expect(whereLabel({ kind: "terminal", machine: "mbp" })).toBe("mbp·terminal");
    expect(whereLabel({ kind: "terminal" })).toBe("terminal");
    expect(whereLabel({ kind: "cli" })).toBe("cli");
    expect(whereLabel({ kind: "autopilot" })).toBe("autopilot");
  });
});

describe("ttlExpired", () => {
  const item = itemForDecision(disagree, cfg);
  it("is false while open and inside the ttl, true once the ttl passed after the answer", () => {
    expect(ttlExpired(item, NOW.getTime() + 10_000_000, 600)).toBe(false);
    const r = answerEvent(item, { version: 1, answer: "fine", by: "y", where: desk }, NOW);
    if ("refused" in r) throw new Error(r.refused);
    expect(ttlExpired(r.item, NOW.getTime() + 599_000, 600)).toBe(false);
    expect(ttlExpired(r.item, NOW.getTime() + 600_000, 600)).toBe(true);
  });
});

describe("foldInbox: the map rebuilt from the journal", () => {
  it("inbox_opened then inbox_answered → the answered item at its version", () => {
    const item = itemForDecision(disagree, cfg);
    const r = answerEvent(item, { version: 1, answer: "fine", by: "y", where: desk }, NOW);
    if ("refused" in r) throw new Error(r.refused);
    const events: JournalEvent[] = [
      { seq: 1, at: "2026-10-20T11:58:00.000Z", ...openedEvent(item) } as JournalEvent,
      { seq: 2, at: NOW.toISOString(), ...r.event } as JournalEvent,
      { seq: 3, at: NOW.toISOString(), type: "task_queued", task: "T1", data: {} },
    ];
    const map = foldInbox(new Map(), events);
    expect([...map.keys()]).toEqual([item.id]);
    expect(map.get(item.id)).toEqual(r.item);
  });
});

describe("inbox-item.schema.json", () => {
  const item = itemForDecision(disagree, cfg);
  it("an open item and an answered one validate", () => {
    expect(
      schemaErrors(
        "inbox-item.schema.json",
        envelope(INBOX_CHANNEL, inboxEnvelopeType(item), item),
      ),
    ).toEqual([]);
    const r = answerEvent(item, { version: 1, answer: "fine", by: "y", where: desk }, NOW);
    if ("refused" in r) throw new Error(r.refused);
    const answered: InboxItem = r.item;
    expect(inboxEnvelopeType(answered)).toBe("inbox_answered");
    expect(
      schemaErrors("inbox-item.schema.json", envelope(INBOX_CHANNEL, "inbox_answered", answered)),
    ).toEqual([]);
    // inbox_answered without `answered` is invalid.
    expect(
      schemaErrors("inbox-item.schema.json", envelope(INBOX_CHANNEL, "inbox_answered", item)),
    ).not.toEqual([]);
  });
});
