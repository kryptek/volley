import { describe, expect, it } from "vitest";
import type { InboxItem } from "../src/store/types";
import { groupInboxItems } from "../src/windows/inbox/inboxGroups";

const T0 = Date.parse("2026-10-21T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** One `repo_untrusted` decision of the burst: task `i<n>`, opened `n` seconds after T0. */
function trust(n: number, over: Partial<InboxItem> = {}): InboxItem {
  return {
    id: `d-wave-d-${n}`,
    kind: "decision",
    version: 1,
    owner_only: false,
    wave: "wave",
    task: `i${n}`,
    agent_id: `wave-i${n}-implementer-1`,
    title: "Trust this folder?",
    question: "Trust /path/to/repo for the work account?",
    options: [{ label: "trust" }, { label: "cancel" }],
    allow_other: true,
    pointers: {},
    opened_at: iso(T0 + n * 1000),
    source: { decision_id: `d-${n}`, decision_kind: "repo_untrusted" },
    ...over,
  };
}

const ids = (g: { lead: InboxItem; members: InboxItem[] }) => g.members.map((m) => m.id);

describe("groupInboxItems", () => {
  it("groups 11 identical decisions into one group, oldest first", () => {
    const items = [5, 3, 9, 1, 2, 4, 6, 8, 7, 11, 10].map((n) => trust(n));
    const groups = groupInboxItems(items);
    expect(groups).toHaveLength(1);
    const [g] = groups;
    expect(g?.members).toHaveLength(11);
    expect(g?.lead.id).toBe("d-wave-d-1");
    expect(g && ids(g)).toEqual(Array.from({ length: 11 }, (_, i) => `d-wave-d-${i + 1}`));
  });

  it("keeps a different question, wave, option set, allow_other, owner_only or kind apart", () => {
    const items = [
      trust(1),
      trust(2),
      trust(3, { question: "Trust /path/to/other for the work account?" }),
      trust(4, { wave: "other" }),
      trust(5, { options: [{ label: "trust" }, { label: "never" }] }),
      trust(6, { allow_other: false }),
      trust(7, { owner_only: true }),
      trust(8, { source: { decision_id: "d-8", decision_kind: "ci_failed" } }),
    ];
    const groups = groupInboxItems(items);
    expect(groups.map((g) => g.members.length)).toEqual([2, 1, 1, 1, 1, 1, 1]);
  });

  it("never groups an answered or held decision", () => {
    const items = [
      trust(1),
      trust(2, {
        answered: { answer: "trust", by: "desk", where: { kind: "desk" }, at: iso(T0) },
      }),
      trust(3, { held: { on: { task: "i1" }, by: "owner", at: iso(T0) } }),
      trust(4),
    ];
    const groups = groupInboxItems(items);
    expect(groups.map(ids)).toEqual([["d-wave-d-1", "d-wave-d-4"], ["d-wave-d-2"], ["d-wave-d-3"]]);
  });

  it("never groups pickers, handoffs or release items", () => {
    const items: InboxItem[] = (["picker", "handoff", "release"] as const).flatMap((kind) => [
      trust(1, { id: `${kind}-a`, kind }),
      trust(2, { id: `${kind}-b`, kind }),
    ]);
    expect(groupInboxItems(items)).toHaveLength(6);
  });

  it("orders groups by their lead's opened_at", () => {
    const items = [trust(5, { wave: "b" }), trust(2), trust(3, { wave: "b" }), trust(4)];
    expect(groupInboxItems(items).map((g) => g.lead.id)).toEqual(["d-wave-d-2", "d-wave-d-3"]);
  });
});

describe("groupInboxItems with pinned groups (a fan-out in flight or done)", () => {
  const answered = {
    answered: {
      answer: "trust",
      by: "owner",
      where: { kind: "desk" as const, device: "phone" },
      at: iso(T0),
    },
  };
  const held = { held: { on: { task: "i99" }, by: "owner", at: iso(T0) } };

  it("keeps a pinned group whole while its members are answered or held one by one", () => {
    const pin = [1, 2, 3, 4].map((n) => `d-wave-d-${n}`);
    const items = [trust(1, answered), trust(2, held), trust(3), trust(4)];
    const groups = groupInboxItems(items, [pin]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.lead.id).toBe("d-wave-d-1");
    expect(groups[0] && ids(groups[0])).toEqual(pin);
  });

  it("a pinned group keeps its members only: a newcomer asking the same forms its own group", () => {
    const items = [trust(1, answered), trust(2), trust(3)];
    const groups = groupInboxItems(items, [["d-wave-d-1", "d-wave-d-2"]]);
    expect(groups.map(ids)).toEqual([["d-wave-d-1", "d-wave-d-2"], ["d-wave-d-3"]]);
  });

  it("a pin whose members have all gone is ignored", () => {
    const groups = groupInboxItems([trust(3), trust(4)], [["d-wave-d-1", "d-wave-d-2"]]);
    expect(groups.map(ids)).toEqual([["d-wave-d-3", "d-wave-d-4"]]);
  });
});
